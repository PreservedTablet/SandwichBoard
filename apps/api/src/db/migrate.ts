import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '@sandwichboard/core';
import pg from 'pg';

/**
 * Plain-SQL migration runner (docs/plan/06 Phase 0): applies db/migrations/
 * NNNN_name.sql files in order, once each, inside a transaction, recording
 * filename + sha256 in schema_migrations. Works against any vanilla Postgres.
 *
 * Migration files must NOT contain their own BEGIN/COMMIT — the runner wraps
 * each file in a transaction.
 */

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_-]+\.sql$/;
// Arbitrary constant so concurrent `pnpm db:migrate` runs serialize.
const ADVISORY_LOCK_ID = 74_580_001;

export function orderMigrations(filenames: string[]): string[] {
	const migrations = filenames.filter((f) => f.endsWith('.sql'));
	const seen = new Map<string, string>();
	for (const file of migrations) {
		const match = MIGRATION_NAME.exec(file);
		if (!match) {
			throw new Error(
				`migration filename ${JSON.stringify(file)} does not match NNNN_lowercase_name.sql`
			);
		}
		const number = match[1]!;
		const existing = seen.get(number);
		if (existing) {
			throw new Error(`duplicate migration number ${number}: ${existing} and ${file}`);
		}
		seen.set(number, file);
	}
	return migrations.sort();
}

export function checksum(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
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

export async function runMigrations(databaseUrl?: string): Promise<void> {
	const connectionString = databaseUrl ?? loadConfig().DATABASE_URL;
	const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));
	const migrationsDir = join(repoRoot, 'db', 'migrations');
	const files = orderMigrations(await readdir(migrationsDir));

	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
		await client.query(`
			create table if not exists schema_migrations (
				filename text primary key,
				checksum text not null,
				applied_at timestamptz not null default now()
			)
		`);
		const { rows } = await client.query<{ filename: string; checksum: string }>(
			'select filename, checksum from schema_migrations'
		);
		const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

		let appliedCount = 0;
		for (const file of files) {
			const sql = await readFile(join(migrationsDir, file), 'utf8');
			const sum = checksum(sql);
			const prior = applied.get(file);
			if (prior !== undefined) {
				if (prior !== sum) {
					throw new Error(
						`migration ${file} was already applied with a different checksum — ` +
							'never edit an applied migration; add a new one'
					);
				}
				console.log(`= ${file} (already applied)`);
				continue;
			}
			await client.query('begin');
			try {
				await client.query(sql);
				await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
					file,
					sum
				]);
				await client.query('commit');
			} catch (err) {
				await client.query('rollback');
				throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
			}
			console.log(`+ ${file} applied`);
			appliedCount += 1;
		}
		console.log(
			`migrations complete: ${appliedCount} applied, ${files.length - appliedCount} already in place`
		);
	} finally {
		await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
		await client.end();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	runMigrations().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
