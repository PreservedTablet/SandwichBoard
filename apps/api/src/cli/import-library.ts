import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	assetCreateSchema,
	copyVariantCreateSchema,
	loadConfig,
	type AssetCreate,
	type CopyVariantCreate
} from '@sandwichboard/core';
import { writeAudit } from '../lib/audit.js';
import { readCsvTable } from '../lib/csv.js';
import { createOrgDb, type OrgDb } from '../db/pool.js';

/**
 * `pnpm import:library <file.csv> [more.csv…] [--dry-run]`
 *
 * Bulk-loads the creative library from CSVs in SandwichBoard's own exchange
 * format (docs/import-format.md) — the portable on-ramp from whatever
 * spreadsheet an operator is leaving behind. Deliberately generic: this tool
 * knows SandwichBoard's vocabulary only; reshaping a legacy tracker into the
 * format is a one-time task done outside the repo, so no legacy system's
 * structure ever leaks into the codebase.
 *
 * Semantics: validate everything first (any invalid row aborts the whole
 * run), then insert-if-absent in ONE transaction — rows already present, by
 * `import_ref` or by identical content, are skipped and reported, so
 * re-running is always safe and never clobbers in-app edits. `--dry-run`
 * executes the full transaction and rolls it back.
 */

interface ImportFile {
	name: string;
	text: string;
}

interface SkippedRow {
	file: string;
	line: number;
	ref: string;
	reason: string;
}

export interface ImportSummary {
	createdAssets: number;
	createdCopy: number;
	skipped: SkippedRow[];
	dryRun: boolean;
}

export class ImportValidationError extends Error {
	constructor(readonly problems: string[]) {
		super(`import aborted, nothing written:\n  ${problems.join('\n  ')}`);
		this.name = 'ImportValidationError';
	}
}

class DryRunRollback extends Error {
	constructor(readonly summary: ImportSummary) {
		super('dry run — rolling back');
	}
}

const ASSET_ONLY = ['title', 'kind'];
const COPY_ONLY = ['body', 'kind'];

type ParsedFile =
	| { name: string; type: 'assets'; rows: { line: number; row: AssetCreate }[] }
	| { name: string; type: 'copy'; rows: { line: number; row: CopyVariantCreate }[] };

function classify(name: string, header: string[]): 'assets' | 'copy' {
	if (header.includes('body')) return 'copy';
	if (header.includes('title')) return 'assets';
	throw new ImportValidationError([
		`${name}: cannot classify — asset files need columns ${ASSET_ONLY.join('+')}, copy files ${COPY_ONLY.join('+')}; got: ${header.join(', ')}`
	]);
}

function toOptionalNumber(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === '') return undefined;
	return Number(raw);
}

function toTags(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw === '') return undefined;
	return raw
		.split(',')
		.map((tag) => tag.trim().toLowerCase())
		.filter(Boolean);
}

function opt(raw: string | undefined): string | undefined {
	return raw === undefined || raw === '' ? undefined : raw;
}

export function parseImportFiles(files: ImportFile[]): ParsedFile[] {
	const problems: string[] = [];
	const parsed: ParsedFile[] = [];
	for (const file of files) {
		const table = readCsvTable(file.text);
		const type = classify(file.name, table.header);
		if (type === 'assets') {
			const rows: { line: number; row: AssetCreate }[] = [];
			for (const { line, values } of table.records) {
				const candidate = {
					kind: opt(values.kind),
					title: opt(values.title),
					production_status: opt(values.production_status),
					external_url: opt(values.external_url),
					width: toOptionalNumber(values.width),
					height: toOptionalNumber(values.height),
					duration_s: toOptionalNumber(values.duration_s),
					aspect_ratio: opt(values.aspect_ratio),
					angle: opt(values.angle),
					tags: toTags(values.tags),
					source: opt(values.source),
					notes: opt(values.notes),
					import_ref: opt(values.import_ref)
				};
				const result = assetCreateSchema.safeParse(candidate);
				if (!result.success) {
					for (const issue of result.error.issues) {
						problems.push(`${file.name}:${line} ${issue.path.join('.')}: ${issue.message}`);
					}
					continue;
				}
				rows.push({ line, row: result.data });
			}
			parsed.push({ name: file.name, type, rows });
		} else {
			const rows: { line: number; row: CopyVariantCreate }[] = [];
			for (const { line, values } of table.records) {
				const candidate = {
					kind: opt(values.kind),
					body: opt(values.body),
					angle: opt(values.angle),
					tone: opt(values.tone),
					tags: toTags(values.tags),
					notes: opt(values.notes),
					import_ref: opt(values.import_ref)
				};
				const result = copyVariantCreateSchema.safeParse(candidate);
				if (!result.success) {
					for (const issue of result.error.issues) {
						problems.push(`${file.name}:${line} ${issue.path.join('.')}: ${issue.message}`);
					}
					continue;
				}
				rows.push({ line, row: result.data });
			}
			parsed.push({ name: file.name, type, rows });
		}
	}
	if (problems.length > 0) {
		throw new ImportValidationError(problems);
	}
	return parsed;
}

export async function importLibrary(opts: {
	db: OrgDb;
	files: ImportFile[];
	dryRun?: boolean;
	actor?: string;
}): Promise<ImportSummary> {
	const parsed = parseImportFiles(opts.files);
	const dryRun = opts.dryRun ?? false;

	try {
		return await opts.db.tx(async (client) => {
			const summary: ImportSummary = { createdAssets: 0, createdCopy: 0, skipped: [], dryRun };

			for (const file of parsed) {
				for (const { line, row } of file.rows) {
					const ref = row.import_ref ?? `${row.kind} @ line ${line}`;
					if (file.type === 'assets') {
						const asset = row as AssetCreate;
						const existing = asset.import_ref
							? await client.query('select 1 from assets where org_id = $1 and import_ref = $2', [
									opts.db.orgId,
									asset.import_ref
								])
							: await client.query(
									'select 1 from assets where org_id = $1 and kind = $2 and title = $3',
									[opts.db.orgId, asset.kind, asset.title]
								);
						if (existing.rows.length > 0) {
							summary.skipped.push({
								file: file.name,
								line,
								ref,
								reason: asset.import_ref
									? 'import_ref already imported'
									: 'same kind + title already exists'
							});
							continue;
						}
						await client.query(
							`insert into assets (org_id, kind, title, production_status, external_url, width, height,
							                     duration_s, aspect_ratio, angle, tags, source, notes, import_ref)
							 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
							[
								opts.db.orgId,
								asset.kind,
								asset.title,
								asset.production_status,
								asset.external_url ?? null,
								asset.width ?? null,
								asset.height ?? null,
								asset.duration_s ?? null,
								asset.aspect_ratio ?? null,
								asset.angle ?? null,
								asset.tags,
								asset.source ?? null,
								asset.notes ?? null,
								asset.import_ref ?? null
							]
						);
						summary.createdAssets += 1;
					} else {
						const copy = row as CopyVariantCreate;
						const existing = copy.import_ref
							? await client.query(
									'select 1 from copy_variants where org_id = $1 and import_ref = $2',
									[opts.db.orgId, copy.import_ref]
								)
							: await client.query(
									'select 1 from copy_variants where org_id = $1 and kind = $2 and lower(body) = lower($3)',
									[opts.db.orgId, copy.kind, copy.body]
								);
						if (existing.rows.length > 0) {
							summary.skipped.push({
								file: file.name,
								line,
								ref,
								reason: copy.import_ref
									? 'import_ref already imported'
									: 'same kind + body already exists'
							});
							continue;
						}
						await client.query(
							`insert into copy_variants (org_id, kind, body, angle, tone, tags, notes, import_ref)
							 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
							[
								opts.db.orgId,
								copy.kind,
								copy.body,
								copy.angle ?? null,
								copy.tone ?? null,
								copy.tags,
								copy.notes ?? null,
								copy.import_ref ?? null
							]
						);
						summary.createdCopy += 1;
					}
				}
			}

			await writeAudit(client, {
				orgId: opts.db.orgId,
				actor: opts.actor ?? 'operator',
				action: 'library_imported',
				payload: {
					files: parsed.map((file) => ({
						name: file.name,
						type: file.type,
						rows: file.rows.length
					})),
					created_assets: summary.createdAssets,
					created_copy: summary.createdCopy,
					skipped: summary.skipped.length,
					dry_run: dryRun
				}
			});

			if (dryRun) {
				throw new DryRunRollback(summary);
			}
			return summary;
		});
	} catch (err) {
		if (err instanceof DryRunRollback) {
			return err.summary;
		}
		throw err;
	}
}

async function findRepoRoot(startDir: string): Promise<string> {
	let dir = startDir;
	for (;;) {
		try {
			await stat(join(dir, 'pnpm-workspace.yaml'));
			return dir;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				throw new Error('could not locate repo root (pnpm-workspace.yaml) above ' + startDir);
			}
			dir = parent;
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const dryRun = args.includes('--dry-run');
	const paths = args.filter((arg) => !arg.startsWith('--'));
	if (paths.length === 0) {
		console.error(
			'usage: pnpm import:library <file.csv> [more.csv…] [--dry-run]\n' +
				'Relative paths resolve from the repo root. Format: docs/import-format.md'
		);
		process.exitCode = 1;
		return;
	}

	const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));
	const files: ImportFile[] = [];
	for (const path of paths) {
		const abs = isAbsolute(path) ? path : join(repoRoot, path);
		files.push({ name: basename(path), text: await readFile(abs, 'utf8') });
	}

	const config = loadConfig();
	const db = createOrgDb(config.DATABASE_URL, config.ORG_ID);
	try {
		const summary = await importLibrary({ db, files, dryRun });
		console.log(
			`created: ${summary.createdAssets} assets, ${summary.createdCopy} copy variants; skipped: ${summary.skipped.length}`
		);
		for (const skip of summary.skipped) {
			console.log(`  = ${skip.file}:${skip.line} [${skip.ref}] ${skip.reason}`);
		}
		if (summary.dryRun) {
			console.log('DRY RUN — transaction rolled back, nothing written');
		}
	} finally {
		await db.end();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
