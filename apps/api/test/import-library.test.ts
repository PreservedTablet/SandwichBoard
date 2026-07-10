import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgDb, type OrgDb } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { ImportValidationError, importLibrary } from '../src/cli/import-library.js';

/**
 * Exchange-format import against a real Postgres (fixtures are synthetic —
 * CLAUDE.md forbids real operator content in the tree). Skips without
 * TEST_DATABASE_URL, like the other integration suites.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Distinct org so this suite never collides with library.test.ts fixtures
// (vitest runs test files in parallel against the same database).
const ORG = '00000000-0000-0000-0000-000000000042';

const ASSETS_CSV = [
	'import_ref,kind,title,production_status,angle,aspect_ratio,duration_s,tags,source,notes',
	'FX-01,image,Sample porch still,planned,cost,4:5,,"porch, spring","gen-tool-a","Hook: Borrow it instead."',
	'FX-02,video,Sample split screen,planned,cost,9:16,35,"evergreen","gen-tool-b","Brief: old way vs new way"',
	'FX-03,image,"Sample ref frame, with comma",ready,,9:16,,"b-roll",,"Says ""hello"" in quotes"',
	',image,Sample untracked still,ready,,,,,,'
].join('\n');

const COPY_CSV = [
	'import_ref,kind,body,angle,tone,tags',
	'FX-01:hook,tagline,Borrow it instead.,cost,warm,"spring"',
	',cta,Start something,,,'
].join('\n');

describe.skipIf(!TEST_DATABASE_URL)('import:library (integration)', () => {
	let db: OrgDb;

	beforeAll(async () => {
		await runMigrations(TEST_DATABASE_URL!);
		db = createOrgDb(TEST_DATABASE_URL!, ORG);
		// Org-scoped cleanup only — the sibling suite owns a different org.
		await db.query('delete from copy_variants where org_id = $1', [ORG]);
		await db.query('delete from assets where org_id = $1', [ORG]);
		await db.query('delete from audit_log where org_id = $1', [ORG]);
	});

	afterAll(async () => {
		await db?.end();
	});

	it('dry-run reports what it would do and writes nothing', async () => {
		const summary = await importLibrary({
			db,
			files: [
				{ name: 'assets.csv', text: ASSETS_CSV },
				{ name: 'copy.csv', text: COPY_CSV }
			],
			dryRun: true
		});
		expect(summary).toMatchObject({ createdAssets: 4, createdCopy: 2, dryRun: true });
		const count = await db.query('select count(*)::int as n from assets where org_id = $1', [ORG]);
		expect(count.rows[0]).toEqual({ n: 0 });
	});

	it('imports assets and copy in one transaction with an audit row', async () => {
		const summary = await importLibrary({
			db,
			files: [
				{ name: 'assets.csv', text: ASSETS_CSV },
				{ name: 'copy.csv', text: COPY_CSV }
			]
		});
		expect(summary).toMatchObject({ createdAssets: 4, createdCopy: 2, skipped: [] });

		const planned = await db.query(
			`select title, production_status, angle, aspect_ratio, duration_s::float8 as duration_s, tags, notes
			 from assets where org_id = $1 and import_ref = 'FX-02'`,
			[ORG]
		);
		expect(planned.rows[0]).toMatchObject({
			title: 'Sample split screen',
			production_status: 'planned',
			angle: 'cost',
			aspect_ratio: '9:16',
			duration_s: 35,
			tags: ['evergreen']
		});

		const quoted = await db.query(
			`select title, notes from assets where org_id = $1 and import_ref = 'FX-03'`,
			[ORG]
		);
		expect(quoted.rows[0]).toEqual({
			title: 'Sample ref frame, with comma',
			notes: 'Says "hello" in quotes'
		});

		const audit = await db.query(
			`select payload from audit_log where org_id = $1 and action = 'library_imported' order by at desc limit 1`,
			[ORG]
		);
		expect(audit.rows[0]?.payload).toMatchObject({ created_assets: 4, created_copy: 2 });
	});

	it('re-running is idempotent: everything skips, nothing duplicates', async () => {
		const summary = await importLibrary({
			db,
			files: [
				{ name: 'assets.csv', text: ASSETS_CSV },
				{ name: 'copy.csv', text: COPY_CSV }
			]
		});
		expect(summary.createdAssets).toBe(0);
		expect(summary.createdCopy).toBe(0);
		expect(summary.skipped).toHaveLength(6);
		expect(summary.skipped.map((s) => s.reason)).toContain('import_ref already imported');
		expect(summary.skipped.map((s) => s.reason)).toContain('same kind + title already exists');

		const count = await db.query('select count(*)::int as n from assets where org_id = $1', [ORG]);
		expect(count.rows[0]).toEqual({ n: 4 });
	});

	it('aborts the whole run on any invalid row, naming file and line', async () => {
		const bad = [
			'kind,title,production_status',
			'image,Valid row,ready',
			'gif,Bad kind,ready',
			'image,Bad status,someday'
		].join('\n');
		await expect(
			importLibrary({ db, files: [{ name: 'bad.csv', text: bad }] })
		).rejects.toThrowError(ImportValidationError);
		await expect(
			importLibrary({ db, files: [{ name: 'bad.csv', text: bad }] })
		).rejects.toThrowError(/bad.csv:3 kind/);

		const valid = await db.query(
			`select count(*)::int as n from assets where org_id = $1 and title = 'Valid row'`,
			[ORG]
		);
		expect(valid.rows[0]).toEqual({ n: 0 });
	});

	it('rejects files it cannot classify', async () => {
		await expect(
			importLibrary({ db, files: [{ name: 'mystery.csv', text: 'a,b\n1,2' }] })
		).rejects.toThrowError(/cannot classify/);
	});
});

describe.skipIf(TEST_DATABASE_URL)('import:library', () => {
	it('is skipped because TEST_DATABASE_URL is unset', () => {
		expect(TEST_DATABASE_URL).toBeUndefined();
	});
});
