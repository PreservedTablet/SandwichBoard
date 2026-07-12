import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOrgDb, type OrgDb } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

/**
 * Phase 3 acceptance mechanics: the analyst role is a database-enforced
 * fence (select-all; insert only recommendations/audit_log; RLS scopes to
 * the org), recommendations are immutable except the operator's verdict,
 * and the API records every verdict. Connects twice: as the privileged
 * app role (the API's view) and as a real analyst login (the /analyze
 * session's view).
 *
 * Uses its own org id: suites share the database and clean org-scoped.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORG = '00000000-0000-0000-0000-000000000004';
const ANALYST_USER = 'sandwichboard_test_analyst';
const ANALYST_PASSWORD = 'sandwichboard-test-analyst-pw';

function analystUrl(base: string): string {
	const url = new URL(base);
	url.username = ANALYST_USER;
	url.password = ANALYST_PASSWORD;
	return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('analysis harness (integration)', () => {
	let app: FastifyInstance;
	let db: OrgDb;
	let analyst: pg.Client;
	let storageDir: string;
	let creativeId: string;
	let shortCode: string;
	let recommendationId: string;

	beforeAll(async () => {
		await runMigrations(TEST_DATABASE_URL!);
		db = createOrgDb(TEST_DATABASE_URL!, ORG);
		await db.query('delete from recommendations where org_id = $1', [ORG]);
		await db.query('delete from metric_snapshots where org_id = $1', [ORG]);
		await db.query('delete from ad_entities where org_id = $1', [ORG]);
		await db.query('delete from campaigns where org_id = $1', [ORG]);
		await db.query('delete from platform_accounts where org_id = $1', [ORG]);
		await db.query(`update creatives set status = 'draft' where org_id = $1`, [ORG]);
		await db.query('delete from creatives where org_id = $1', [ORG]);
		await db.query('delete from copy_variants where org_id = $1', [ORG]);
		await db.query('delete from settings where org_id = $1', [ORG]);
		await db.query('delete from audit_log where org_id = $1', [ORG]);

		// The operator-side step from docs/setup.md §4.5: a login user
		// carrying the analyst grants. Idempotent for repeated runs.
		await db.query(`
			do $$
			begin
				if not exists (select 1 from pg_roles where rolname = '${ANALYST_USER}') then
					create role ${ANALYST_USER} login;
				end if;
			end;
			$$;
		`);
		await db.query(`alter role ${ANALYST_USER} password '${ANALYST_PASSWORD}'`);
		await db.query(`grant analyst to ${ANALYST_USER}`);

		storageDir = await mkdtemp(join(tmpdir(), 'sb-analysis-'));
		app = buildApp({
			logLevel: 'silent',
			deps: { db, storage: new LocalFsStorage(storageDir) }
		});

		// Library + warehouse fixtures: one combo with gated-level metrics.
		const headline = await app.inject({
			method: 'POST',
			url: '/api/copy-variants',
			payload: { kind: 'headline', body: 'Neighbors have the tools you need.' }
		});
		const combo = await app.inject({
			method: 'POST',
			url: '/api/creatives',
			payload: { headline_id: headline.json().id }
		});
		creativeId = combo.json().id;
		shortCode = combo.json().short_code;

		const account = await db.query<{ id: string }>(
			`insert into platform_accounts (org_id, platform, external_account_id, label)
			 values ($1, 'meta', 'act_41', 'FWT Meta') returning id`,
			[ORG]
		);
		const entity = await db.query<{ id: string }>(
			`insert into ad_entities (org_id, platform_account_id, creative_id, platform, external_ad_id, ad_name)
			 values ($1, $2, $3, 'meta', '41001', 'fwt|start-your-circle|' || $4 || '|v1') returning id`,
			[ORG, account.rows[0]!.id, creativeId, shortCode]
		);
		await db.query(
			`insert into metric_snapshots (org_id, ad_entity_id, date, spend_cents, impressions, clicks)
			 values ($1, $2, current_date - 2, 2000, 900, 20), ($1, $2, current_date - 1, 1000, 600, 12)`,
			[ORG, entity.rows[0]!.id]
		);

		analyst = new pg.Client({ connectionString: analystUrl(TEST_DATABASE_URL!) });
		await analyst.connect();
	});

	afterAll(async () => {
		await analyst?.end();
		await app?.close();
		await db?.end();
		if (storageDir) await rm(storageDir, { recursive: true, force: true });
	});

	describe('the analyst fence (database-enforced, not prompt-enforced)', () => {
		it('sees nothing until the org context is set — RLS bites for real', async () => {
			const before = await analyst.query('select count(*)::int as n from creatives');
			expect(before.rows[0]).toEqual({ n: 0 });

			await analyst.query(`select set_config('app.org_id', $1, false)`, [ORG]);
			const after = await analyst.query(
				'select count(*)::int as n from creatives where org_id = $1',
				[ORG]
			);
			expect(after.rows[0]).toEqual({ n: 1 });
		});

		it('reads the leaderboard views (the analysis inputs)', async () => {
			const { rows } = await analyst.query(
				`select platform, spend_cents::int as spend_cents, impressions::int as impressions
				 from v_combo_leaderboard where org_id = $1 order by platform`,
				[ORG]
			);
			expect(rows).toEqual([
				{ platform: 'all', spend_cents: 3000, impressions: 1500 },
				{ platform: 'meta', spend_cents: 3000, impressions: 1500 }
			]);
		});

		it('inserts a recommendation whose evidence SQL re-computes to the cited value', async () => {
			const claimSql = `select spend_cents::int as value from v_combo_leaderboard where org_id = '${ORG}' and short_code = '${shortCode}' and platform = 'all'`;
			const inserted = await analyst.query<{ id: string }>(
				`insert into recommendations (org_id, run_id, kind, subject_creative_id, rationale, evidence)
				 values ($1, gen_random_uuid(), 'scale', $2, 'Passes the gate on meta; scale within floor limits.', $3)
				 returning id`,
				[
					ORG,
					creativeId,
					JSON.stringify({
						window: { since: 'current_date-2', until: 'current_date-1' },
						gate: { min_spend_cents: 2500, min_impressions: 1000, met: true },
						claims: [{ label: 'spend_cents (all)', value: 3000, sql: claimSql }]
					})
				]
			);
			recommendationId = inserted.rows[0]!.id;

			// The acceptance loop: re-run the claim's SQL, compare to the value.
			const evidence = await analyst.query<{
				evidence: { claims: { value: number; sql: string }[] };
			}>('select evidence from recommendations where id = $1', [recommendationId]);
			const claim = evidence.rows[0]!.evidence.claims[0]!;
			const recomputed = await analyst.query<{ value: number }>(claim.sql);
			expect(recomputed.rows[0]!.value).toBe(claim.value);
		});

		it('inserts the run trace into audit_log', async () => {
			await analyst.query(
				`insert into audit_log (org_id, actor, action, subject_table, payload)
				 values ($1, 'claude-analyze', 'analyze_run_completed', 'recommendations',
				         '{"report": "reports/2026-07-12.md", "recommendations": 1}')`,
				[ORG]
			);
			const { rows } = await analyst.query(
				`select actor from audit_log where org_id = $1 and action = 'analyze_run_completed'`,
				[ORG]
			);
			expect(rows).toHaveLength(1);
		});

		it('is denied an UPDATE on creatives (the acceptance criterion)', async () => {
			await expect(
				analyst.query(`update creatives set status = 'live' where org_id = $1`, [ORG])
			).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
		});

		it('is denied every other write path', async () => {
			await expect(
				analyst.query(`insert into assets (org_id, kind, title) values ($1, 'image', 'x')`, [ORG])
			).rejects.toMatchObject({ code: '42501' });
			await expect(
				analyst.query(`update recommendations set status = 'accepted' where org_id = $1`, [ORG])
			).rejects.toMatchObject({ code: '42501' });
			await expect(
				analyst.query('delete from recommendations where org_id = $1', [ORG])
			).rejects.toMatchObject({ code: '42501' });
			await expect(
				analyst.query('update settings set value = \'"x"\' where org_id = $1', [ORG])
			).rejects.toMatchObject({ code: '42501' });
		});

		it('cannot escape via multi-statement injection either (docs/decisions/0007)', async () => {
			// The archived reference MCP server fell to exactly this shape:
			// terminate the wrapper transaction, then write. With the fence at
			// the ROLE, the write still dies — there is nothing to escape to.
			await expect(
				analyst.query(`commit; update creatives set status = 'live' where org_id = '${ORG}'; begin`)
			).rejects.toMatchObject({ code: '42501' });
		});
	});

	describe('the operator verdict loop (API)', () => {
		it('lists open recommendations with the subject combo joined', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/recommendations?status=open' });
			expect(res.statusCode).toBe(200);
			expect(res.json().items).toHaveLength(1);
			expect(res.json().items[0]).toMatchObject({
				id: recommendationId,
				kind: 'scale',
				subject_short_code: shortCode
			});
		});

		it('accept → done transitions are recorded and audited', async () => {
			const accepted = await app.inject({
				method: 'PATCH',
				url: `/api/recommendations/${recommendationId}`,
				payload: { status: 'accepted', outcome_note: 'raised budget within floors' }
			});
			expect(accepted.statusCode).toBe(200);
			expect(accepted.json().status).toBe('accepted');

			const done = await app.inject({
				method: 'PATCH',
				url: `/api/recommendations/${recommendationId}`,
				payload: { status: 'done' }
			});
			expect(done.statusCode).toBe(200);

			const audit = await db.query(
				`select payload from audit_log
				 where org_id = $1 and action = 'recommendation_status_changed' order by at`,
				[ORG]
			);
			expect(audit.rows.map((r) => r.payload)).toMatchObject([
				{ from: 'open', to: 'accepted', outcome_note: 'raised budget within floors' },
				{ from: 'accepted', to: 'done' }
			]);
		});

		it('refuses invalid transitions — history never reopens', async () => {
			const res = await app.inject({
				method: 'PATCH',
				url: `/api/recommendations/${recommendationId}`,
				payload: { status: 'accepted' }
			});
			expect(res.statusCode).toBe(409);
			expect(res.json().error).toBe('invalid_transition');
		});

		it('the record itself is immutable — only the verdict may change', async () => {
			// API surface simply has no such field…
			const viaApi = await app.inject({
				method: 'PATCH',
				url: `/api/recommendations/${recommendationId}`,
				payload: { rationale: 'rewritten history' }
			});
			expect(viaApi.statusCode).toBe(400);

			// …and even the privileged role is stopped by the trigger.
			await expect(
				db.query(`update recommendations set rationale = 'rewritten' where id = $1`, [
					recommendationId
				])
			).rejects.toMatchObject({ code: 'P0001' });
		});
	});
});

describe.skipIf(TEST_DATABASE_URL)('analysis harness', () => {
	it('is skipped because TEST_DATABASE_URL is unset', () => {
		expect(TEST_DATABASE_URL).toBeUndefined();
	});
});
