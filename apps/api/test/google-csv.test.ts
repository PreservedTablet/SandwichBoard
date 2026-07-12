import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAdName } from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOrgDb, type OrgDb } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

/**
 * Session 2b end to end against a real Postgres: the Google CSV upload
 * (tokenless universal fallback), the metrics read endpoints, and the
 * cross-platform leaderboard with its per-platform evidence gate. Meta-side
 * rows are inserted directly — the sync path has its own suite.
 *
 * Uses its own org id: suites share the database and clean org-scoped.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORG = '00000000-0000-0000-0000-000000000003';
const INTERNAL_TOKEN = 'test-internal-token';

/** ISO date n days before today (DB current_date) — keeps 30d-window asserts fresh. */
function daysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}
const D1 = daysAgo(3);
const D2 = daysAgo(2);

describe.skipIf(!TEST_DATABASE_URL)(
	'google CSV ingestion + metrics endpoints (integration)',
	() => {
		let app: FastifyInstance;
		let db: OrgDb;
		let storageDir: string;
		let shortCode: string;
		let creativeId: string;
		let goodCsv: string;

		const upload = (
			csv: string,
			{ token = INTERNAL_TOKEN, account = '123-456-7890' } = {}
		): ReturnType<FastifyInstance['inject']> =>
			app.inject({
				method: 'POST',
				url: `/internal/ingest/google-csv?external_account_id=${encodeURIComponent(account)}&label=FWT%20Google&filename=report.csv`,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
				payload: csv
			});

		beforeAll(async () => {
			await runMigrations(TEST_DATABASE_URL!);
			db = createOrgDb(TEST_DATABASE_URL!, ORG);
			await db.query('delete from metric_snapshots where org_id = $1', [ORG]);
			await db.query('delete from ingest_deadletter where org_id = $1', [ORG]);
			await db.query('delete from ad_entities where org_id = $1', [ORG]);
			await db.query('delete from campaigns where org_id = $1', [ORG]);
			await db.query('delete from platform_accounts where org_id = $1', [ORG]);
			await db.query(`update creatives set status = 'draft' where org_id = $1`, [ORG]);
			await db.query('delete from creatives where org_id = $1', [ORG]);
			await db.query('delete from copy_variants where org_id = $1', [ORG]);
			await db.query('delete from settings where org_id = $1', [ORG]);
			await db.query('delete from audit_log where org_id = $1', [ORG]);

			storageDir = await mkdtemp(join(tmpdir(), 'sb-gcsv-'));
			app = buildApp({
				logLevel: 'silent',
				deps: { db, storage: new LocalFsStorage(storageDir), internalToken: INTERNAL_TOKEN }
			});

			await app.inject({
				method: 'PUT',
				url: '/api/settings/naming_prefix',
				payload: { value: 'fwt' }
			});
			const headline = await app.inject({
				method: 'POST',
				url: '/api/copy-variants',
				payload: { kind: 'headline', body: 'Rent a drill from three doors down.' }
			});
			const combo = await app.inject({
				method: 'POST',
				url: '/api/creatives',
				payload: { headline_id: headline.json().id }
			});
			creativeId = combo.json().id;
			shortCode = combo.json().short_code;

			// Meta-side rows so the leaderboard has a second platform to mix:
			// 3000¢ / 1500 impressions (passes the default gate on its own).
			const account = await db.query<{ id: string }>(
				`insert into platform_accounts (org_id, platform, external_account_id, label, currency, timezone)
			 values ($1, 'meta', 'act_31', 'FWT Meta', 'USD', 'America/Denver') returning id`,
				[ORG]
			);
			const adName = buildAdName({
				prefix: 'fwt',
				campaignSlug: 'start-your-circle',
				shortCode,
				version: 1
			});
			const entity = await db.query<{ id: string }>(
				`insert into ad_entities (org_id, platform_account_id, creative_id, platform, external_ad_id, ad_name)
			 values ($1, $2, $3, 'meta', '31001', $4) returning id`,
				[ORG, account.rows[0]!.id, creativeId, adName]
			);
			await db.query(
				`insert into metric_snapshots (org_id, ad_entity_id, date, spend_cents, impressions, clicks)
			 values ($1, $2, $3, 2000, 800, 20), ($1, $2, $4, 1000, 700, 15)`,
				[ORG, entity.rows[0]!.id, D1, D2]
			);

			const googleAdName = buildAdName({
				prefix: 'fwt',
				campaignSlug: 'search-denver',
				shortCode,
				version: 1
			});
			goodCsv = [
				'ad_group_ad.ad.id,ad_group_ad.ad.name,segments.date,metrics.cost_micros,metrics.impressions,metrics.clicks,metrics.conversions,campaign.id,campaign.name',
				`777001,${googleAdName},${D1},12340000,1500,37,2.5,99001,Search — Denver`,
				`777001,${googleAdName},${D2},8000000,900,12,0,99001,Search — Denver`,
				`777002,Responsive search ad,${D1},3000000,120,2,0,99001,Search — Denver`,
				`777003,,${D2},1000000,80,1,0,99001,Search — Denver`
			].join('\n');
		});

		afterAll(async () => {
			await app?.close();
			await db?.end();
			if (storageDir) await rm(storageDir, { recursive: true, force: true });
		});

		describe('endpoint guardrails', () => {
			it('401s without the bearer token', async () => {
				const res = await app.inject({
					method: 'POST',
					url: '/internal/ingest/google-csv?external_account_id=123',
					headers: { 'content-type': 'text/csv' },
					payload: 'x'
				});
				expect(res.statusCode).toBe(401);
			});

			it('409s when the naming prefix is unset', async () => {
				await db.query(`delete from settings where org_id = $1 and key = 'naming_prefix'`, [ORG]);
				const res = await upload(goodCsv);
				expect(res.statusCode).toBe(409);
				expect(res.json().error).toBe('naming_prefix_not_set');
				await app.inject({
					method: 'PUT',
					url: '/api/settings/naming_prefix',
					payload: { value: 'fwt' }
				});
			});

			it('rejects a bad customer id with a clear problem', async () => {
				const res = await upload(goodCsv, { account: 'not-an-id' });
				expect(res.statusCode).toBe(400);
				expect(res.json().problems.join(' ')).toContain('customer id');
			});
		});

		describe('all-or-nothing validation', () => {
			it('rejects missing columns listing every accepted header', async () => {
				const res = await upload('foo,bar\n1,2');
				expect(res.statusCode).toBe(400);
				const problems: string[] = res.json().problems;
				expect(problems.join('\n')).toContain('ad_group_ad.ad.id');
				expect(problems.join('\n')).toContain('metrics.cost_micros');
			});

			it('rejects bad cells and duplicates with file:line pointers, writing nothing', async () => {
				const before = await db.query(
					`select count(*)::int as n from metric_snapshots where org_id = $1`,
					[ORG]
				);
				const bad = [
					'ad_group_ad.ad.id,segments.date,metrics.cost_micros,metrics.impressions,metrics.clicks',
					`777001,${D1},1000000,100,1`,
					`777001,not-a-date,1000000,100,1`,
					`777001,${D1},1000000,100,1`
				].join('\n');
				const res = await upload(bad);
				expect(res.statusCode).toBe(400);
				const problems: string[] = res.json().problems;
				expect(problems.some((p) => p.startsWith('line 3:') && p.includes('not-a-date'))).toBe(
					true
				);
				expect(problems.some((p) => p.startsWith('line 4:') && p.includes('duplicate'))).toBe(true);

				const after = await db.query(
					`select count(*)::int as n from metric_snapshots where org_id = $1`,
					[ORG]
				);
				expect(after.rows[0]).toEqual(before.rows[0]); // nothing written
			});
		});

		describe('happy path — the tokenless backfill', () => {
			it('ingests the report: accounts, campaigns, ads, snapshots, audit', async () => {
				const res = await upload(goodCsv);
				expect(res.statusCode).toBe(200);
				expect(res.json()).toMatchObject({
					platform: 'google',
					account: { external_account_id: '1234567890', label: 'FWT Google' },
					range: { since: D1, until: D2 },
					rows: 4,
					campaigns_synced: 1,
					ads_synced: 3,
					ads_matched: 1,
					ads_unmatched: 2,
					snapshot_rows_upserted: 4,
					filename: 'report.csv'
				});

				const campaign = await db.query(
					`select name, status, external_id from campaigns c
				 join platform_accounts pa on pa.id = c.platform_account_id
				 where c.org_id = $1 and pa.platform = 'google'`,
					[ORG]
				);
				expect(campaign.rows[0]).toEqual({
					name: 'Search — Denver',
					status: 'unknown',
					external_id: '99001'
				});

				const ads = await db.query(
					`select external_ad_id, creative_id is not null as matched, match_failure_code
				 from ad_entities where org_id = $1 and platform = 'google' order by external_ad_id`,
					[ORG]
				);
				expect(ads.rows).toEqual([
					{ external_ad_id: '777001', matched: true, match_failure_code: null },
					{ external_ad_id: '777002', matched: false, match_failure_code: 'segment-count' },
					{ external_ad_id: '777003', matched: false, match_failure_code: 'empty' }
				]);

				const spend = await db.query(
					`select e.external_ad_id, to_char(s.date, 'YYYY-MM-DD') as date, s.spend_cents
				 from metric_snapshots s join ad_entities e on e.id = s.ad_entity_id
				 where s.org_id = $1 and e.platform = 'google' order by e.external_ad_id, s.date`,
					[ORG]
				);
				expect(spend.rows).toEqual([
					{ external_ad_id: '777001', date: D1, spend_cents: 1234 },
					{ external_ad_id: '777001', date: D2, spend_cents: 800 },
					{ external_ad_id: '777002', date: D1, spend_cents: 300 },
					{ external_ad_id: '777003', date: D2, spend_cents: 100 }
				]);

				const audit = await db.query(
					`select payload from audit_log where org_id = $1 and action = 'google_csv_ingested'
				 order by at desc limit 1`,
					[ORG]
				);
				expect(audit.rows[0]!.payload).toMatchObject({
					snapshot_rows_upserted: 4,
					filename: 'report.csv'
				});
			});

			it('re-uploading the same file is idempotent', async () => {
				const res = await upload(goodCsv);
				expect(res.statusCode).toBe(200);
				const counts = await db.query(
					`select count(*)::int as n, sum(spend_cents)::int as total
				 from metric_snapshots s join ad_entities e on e.id = s.ad_entity_id
				 where s.org_id = $1 and e.platform = 'google'`,
					[ORG]
				);
				expect(counts.rows[0]).toEqual({ n: 4, total: 2434 });
			});
		});

		describe('metrics endpoints', () => {
			it('leaderboard applies the gate per platform: google alone sits below it', async () => {
				// google matched spend = 2034¢ < 2500 default gate
				const google = await app.inject({
					method: 'GET',
					url: '/api/metrics/leaderboard?platform=google'
				});
				expect(google.json().items).toHaveLength(0);
				expect(google.json().combos_below_gate).toBe(1);

				// meta alone passes (3000¢ / 1500 impressions)
				const meta = await app.inject({
					method: 'GET',
					url: '/api/metrics/leaderboard?platform=meta'
				});
				expect(meta.json().items).toHaveLength(1);
				expect(meta.json().items[0]).toMatchObject({
					short_code: shortCode,
					spend_cents: 3000,
					impressions: 1500
				});

				// the 'all' rollup sums both platforms: 3000 + 2034
				const all = await app.inject({
					method: 'GET',
					url: '/api/metrics/leaderboard?platform=all'
				});
				expect(all.json().items).toHaveLength(1);
				expect(all.json().items[0]).toMatchObject({
					short_code: shortCode,
					platform: 'all',
					spend_cents: 5034,
					impressions: 3900,
					ad_count: 2
				});
			});

			it('daily series sums platforms for the sparkline window', async () => {
				const res = await app.inject({
					method: 'GET',
					url: '/api/metrics/daily?platform=all&days=30'
				});
				const items = res.json().items;
				expect(items).toEqual([
					{ creative_id: creativeId, date: D1, spend_cents: 3234, impressions: 2300, clicks: 57 },
					{ creative_id: creativeId, date: D2, spend_cents: 1800, impressions: 1600, clicks: 27 }
				]);
			});

			it('unmatched list carries both platforms with machine-readable codes', async () => {
				const res = await app.inject({ method: 'GET', url: '/api/metrics/unmatched' });
				const codes = res
					.json()
					.items.map((i: { external_ad_id: string; match_failure_code: string }) => [
						i.external_ad_id,
						i.match_failure_code
					]);
				expect(codes).toContainEqual(['777002', 'segment-count']);
				expect(codes).toContainEqual(['777003', 'empty']);
			});

			it('deadletters list + resolve, with an audit row', async () => {
				await db.query(
					`insert into ingest_deadletter (org_id, platform, payload, error)
				 values ($1, 'meta', '{"phase":"insights"}', 'boom')`,
					[ORG]
				);
				const open = await app.inject({ method: 'GET', url: '/api/metrics/deadletters' });
				expect(open.json().items).toHaveLength(1);
				const id = open.json().items[0].id;

				const patched = await app.inject({
					method: 'PATCH',
					url: `/api/metrics/deadletters/${id}`,
					payload: { resolved: true }
				});
				expect(patched.statusCode).toBe(200);

				const after = await app.inject({ method: 'GET', url: '/api/metrics/deadletters' });
				expect(after.json().items).toHaveLength(0);

				const audit = await db.query(
					`select 1 from audit_log where org_id = $1 and action = 'deadletter_resolved' and subject_id = $2`,
					[ORG, id]
				);
				expect(audit.rows).toHaveLength(1);
			});

			it('/api/sync/status reports the google upload alongside meta', async () => {
				const res = await app.inject({ method: 'GET', url: '/api/sync/status' });
				const status = res.json();
				const google = status.platforms.find((p: { platform: string }) => p.platform === 'google');
				expect(google).toMatchObject({ method: 'csv-upload', configured: true, data_through: D2 });
				expect(google.last_success_at).toBeTruthy();
				expect(google.last_success_summary.rows).toBe(4);
				const meta = status.platforms.find((p: { platform: string }) => p.platform === 'meta');
				expect(meta).toMatchObject({ configured: false, data_through: D2 });
			});
		});
	}
);

describe.skipIf(TEST_DATABASE_URL)('google CSV ingestion', () => {
	it('is skipped because TEST_DATABASE_URL is unset', () => {
		expect(TEST_DATABASE_URL).toBeUndefined();
	});
});
