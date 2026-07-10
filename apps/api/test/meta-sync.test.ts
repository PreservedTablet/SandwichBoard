import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildAdName,
	type MetaAd,
	type MetaAdAccount,
	type MetaCampaign,
	type MetaInsightsRow
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MetaCliError, type MetaConnector } from '../src/connectors/meta-cli.js';
import { createOrgDb, type OrgDb } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { runMetaSync } from '../src/ingest/meta-sync.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

/**
 * The Phase 2 Session 2a acceptance mechanics, end to end against a real
 * Postgres with a fake connector standing in for Meta's CLI (the real
 * connector's subprocess behavior is covered in meta-cli.test.ts):
 *
 *   - first run backfills from the 90-day floor
 *   - a second run on a later day starts at the watermark and heals a
 *     deliberately skipped day; re-running is idempotent
 *   - malformed ad names land in v_unmatched_ads with machine-readable codes
 *   - unusable rows deadletter without sinking the run
 *   - every run leaves an audit_log summary; /api/sync/status reports reality
 *   - the leaderboard views apply the settings-driven evidence gate
 *
 * Uses its own org id: suites share the database and clean org-scoped.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORG = '00000000-0000-0000-0000-000000000002';
const INTERNAL_TOKEN = 'test-internal-token';

class FakeMetaConnector implements MetaConnector {
	account: MetaAdAccount = {
		id: 'act_1',
		name: 'FWT Main',
		currency: 'USD',
		timezone_name: 'America/Denver',
		account_status: 1
	};
	campaigns: MetaCampaign[] = [];
	ads: MetaAd[] = [];
	insights = new Map<string, MetaInsightsRow[]>();
	failInsightsFor = new Map<string, MetaCliError>();
	failAccountInfo: MetaCliError | null = null;

	async getAccountInfo(): Promise<MetaAdAccount> {
		if (this.failAccountInfo) throw this.failAccountInfo;
		return this.account;
	}
	async listCampaigns(): Promise<MetaCampaign[]> {
		return this.campaigns;
	}
	async listAds(): Promise<MetaAd[]> {
		return this.ads;
	}
	async getAdInsightsDaily(adId: string, since: string, until: string): Promise<MetaInsightsRow[]> {
		const fail = this.failInsightsFor.get(adId);
		if (fail) throw fail;
		// Meta clamps to time_range; the fake does the same, which is what
		// makes watermark catch-up observable.
		return (this.insights.get(adId) ?? []).filter(
			(row) => row.date_start >= since && row.date_start <= until
		);
	}
}

function day(
	date: string,
	spend: string,
	impressions: string,
	clicks: string,
	extras: Partial<MetaInsightsRow> = {}
): MetaInsightsRow {
	return { date_start: date, date_stop: date, spend, impressions, clicks, ...extras };
}

describe.skipIf(!TEST_DATABASE_URL)('meta sync (integration)', () => {
	let app: FastifyInstance;
	let db: OrgDb;
	let storageDir: string;
	const fake = new FakeMetaConnector();
	// The service takes the clock as a seam; "today" moves between runs.
	let currentNow = new Date('2026-07-10T18:00:00Z'); // noon in Denver

	let shortCode: string;
	let adNameA: string;

	const inject = (token?: string) =>
		app.inject({
			method: 'POST',
			url: '/internal/ingest/meta',
			headers: token ? { authorization: `Bearer ${token}` } : {}
		});

	beforeAll(async () => {
		await runMigrations(TEST_DATABASE_URL!);
		db = createOrgDb(TEST_DATABASE_URL!, ORG);
		// FK-safe, org-scoped cleanup (suites share the database).
		await db.query('delete from metric_snapshots where org_id = $1', [ORG]);
		await db.query('delete from ingest_deadletter where org_id = $1', [ORG]);
		await db.query('delete from ad_entities where org_id = $1', [ORG]);
		await db.query('delete from campaigns where org_id = $1', [ORG]);
		await db.query('delete from platform_accounts where org_id = $1', [ORG]);
		await db.query(`update creatives set status = 'draft' where org_id = $1`, [ORG]);
		await db.query('delete from creatives where org_id = $1', [ORG]);
		await db.query('delete from copy_variants where org_id = $1', [ORG]);
		await db.query('delete from assets where org_id = $1', [ORG]);
		await db.query('delete from settings where org_id = $1', [ORG]);
		await db.query('delete from audit_log where org_id = $1', [ORG]);

		storageDir = await mkdtemp(join(tmpdir(), 'sb-sync-'));
		app = buildApp({
			logLevel: 'silent',
			deps: {
				db,
				storage: new LocalFsStorage(storageDir),
				internalToken: INTERNAL_TOKEN,
				runMetaSync: () =>
					runMetaSync({
						db,
						connector: fake,
						actor: 'ingest-job',
						trigger: 'api',
						now: () => currentNow
					})
			}
		});

		// Library fixtures: prefix + one combo whose short_code goes live.
		await app.inject({
			method: 'PUT',
			url: '/api/settings/naming_prefix',
			payload: { value: 'fwt' }
		});
		await app.inject({
			method: 'PUT',
			url: '/api/settings/meta_conversion_action_types',
			payload: { value: ['offsite_conversion.fb_pixel_lead'] }
		});
		const headline = await app.inject({
			method: 'POST',
			url: '/api/copy-variants',
			payload: { kind: 'headline', body: 'Borrow the drill. Meet the neighbors.' }
		});
		const combo = await app.inject({
			method: 'POST',
			url: '/api/creatives',
			payload: { headline_id: headline.json().id }
		});
		shortCode = combo.json().short_code;
		adNameA = buildAdName({
			prefix: 'fwt',
			campaignSlug: 'start-your-circle',
			shortCode,
			version: 1
		});

		fake.campaigns = [
			{
				id: '901',
				name: 'Start Your Circle',
				objective: 'OUTCOME_LEADS',
				status: 'ACTIVE',
				daily_budget: '1500'
			}
		];
		fake.ads = [
			{
				id: '1201',
				name: adNameA,
				adset_id: '801',
				campaign_id: '901',
				effective_status: 'ACTIVE'
			},
			// Meta's classic duplicate-suffix mangle — must land unmatched.
			{ id: '1202', name: `${adNameA} - Copy`, adset_id: '801', campaign_id: '901' },
			// Well-formed name, but nobody's short code.
			{ id: '1203', name: 'fwt|start-your-circle|zzzzz|v1', adset_id: '802', campaign_id: '901' }
		];
		fake.insights.set('1201', [
			day('2026-07-07', '12.34', '1500', '37', {
				ad_id: '1201',
				ad_name: adNameA,
				actions: [
					{ action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
					{ action_type: 'link_click', value: '37' }
				],
				action_values: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4.20' }]
			}),
			day('2026-07-08', '8.00', '400', '12')
		]);
		fake.insights.set('1202', [day('2026-07-08', '3.00', '100', '2')]);
	});

	afterAll(async () => {
		await app?.close();
		await db?.end();
		if (storageDir) await rm(storageDir, { recursive: true, force: true });
	});

	describe('endpoint guardrails', () => {
		it('401s without or with a wrong bearer token', async () => {
			expect((await inject()).statusCode).toBe(401);
			expect((await inject('wrong-token')).statusCode).toBe(401);
		});

		it('503s when INTERNAL_API_TOKEN is not configured — disabled, never open', async () => {
			const bare = buildApp({
				logLevel: 'silent',
				deps: { db, storage: new LocalFsStorage(storageDir) }
			});
			const res = await bare.inject({ method: 'POST', url: '/internal/ingest/meta' });
			expect(res.statusCode).toBe(503);
			expect(res.json().error).toBe('internal_token_not_configured');
			await bare.close();
		});

		it('503s with setup guidance when Meta ingestion is not configured', async () => {
			const noMeta = buildApp({
				logLevel: 'silent',
				deps: { db, storage: new LocalFsStorage(storageDir), internalToken: INTERNAL_TOKEN }
			});
			const res = await noMeta.inject({
				method: 'POST',
				url: '/internal/ingest/meta',
				headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }
			});
			expect(res.statusCode).toBe(503);
			expect(res.json().error).toBe('meta_not_configured');
			await noMeta.close();
		});

		it('409s when the naming prefix is unset — ingestion refuses to guess', async () => {
			await db.query(`delete from settings where org_id = $1 and key = 'naming_prefix'`, [ORG]);
			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(409);
			expect(res.json().error).toBe('naming_prefix_not_set');
			await app.inject({
				method: 'PUT',
				url: '/api/settings/naming_prefix',
				payload: { value: 'fwt' }
			});
		});
	});

	describe('run 1 — first sync backfills from the 90-day floor', () => {
		it('syncs, matches names, and reports the range in the summary', async () => {
			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(200);
			const summary = res.json();
			expect(summary).toMatchObject({
				platform: 'meta',
				trigger: 'api',
				watermark: null,
				range: { since: '2026-04-11', until: '2026-07-09' }, // yesterday in Denver
				campaigns_synced: 1,
				ads_synced: 3,
				ads_matched: 1,
				ads_unmatched: 2,
				snapshot_rows_upserted: 3,
				deadletters: 0
			});
			expect(summary.account).toMatchObject({
				external_account_id: 'act_1',
				label: 'FWT Main',
				currency: 'USD',
				timezone: 'America/Denver'
			});
		});

		it('recorded the account, campaign, and per-ad match verdicts', async () => {
			const account = await db.query(
				`select external_account_id, label, currency, timezone from platform_accounts
				 where org_id = $1 and platform = 'meta'`,
				[ORG]
			);
			expect(account.rows[0]).toEqual({
				external_account_id: 'act_1',
				label: 'FWT Main',
				currency: 'USD',
				timezone: 'America/Denver'
			});

			const campaign = await db.query(
				`select name, status, budget_daily_cents, external_id from campaigns where org_id = $1`,
				[ORG]
			);
			expect(campaign.rows[0]).toMatchObject({
				name: 'Start Your Circle',
				status: 'active',
				budget_daily_cents: 1500,
				external_id: '901'
			});

			const ads = await db.query(
				`select external_ad_id, creative_id is not null as matched, match_failure_code
				 from ad_entities where org_id = $1 order by external_ad_id`,
				[ORG]
			);
			expect(ads.rows).toEqual([
				{ external_ad_id: '1201', matched: true, match_failure_code: null },
				{ external_ad_id: '1202', matched: false, match_failure_code: 'version' },
				{ external_ad_id: '1203', matched: false, match_failure_code: 'code-not-found' }
			]);
		});

		it('normalized snapshots exactly (money as decimal-string math)', async () => {
			const rows = await db.query(
				`select to_char(s.date, 'YYYY-MM-DD') as date, s.spend_cents, s.impressions, s.clicks,
				        s.conversions::float8 as conversions, s.conversion_value_cents, s.raw
				 from metric_snapshots s join ad_entities e on e.id = s.ad_entity_id
				 where s.org_id = $1 and e.external_ad_id = '1201' order by s.date`,
				[ORG]
			);
			expect(rows.rows).toHaveLength(2);
			expect(rows.rows[0]).toMatchObject({
				date: '2026-07-07',
				spend_cents: 1234,
				impressions: 1500,
				clicks: 37,
				conversions: 2,
				conversion_value_cents: 420
			});
			// the full platform row is kept for re-parsing, always
			expect(rows.rows[0]!.raw.actions).toHaveLength(2);
			expect(rows.rows[1]).toMatchObject({ date: '2026-07-08', spend_cents: 800 });
		});

		it('surfaces the mangled and unmatched names in v_unmatched_ads', async () => {
			const unmatched = await db.query(
				`select external_ad_id, match_failure_code, campaign_name from v_unmatched_ads
				 where org_id = $1 order by external_ad_id`,
				[ORG]
			);
			expect(unmatched.rows).toEqual([
				{
					external_ad_id: '1202',
					match_failure_code: 'version',
					campaign_name: 'Start Your Circle'
				},
				{
					external_ad_id: '1203',
					match_failure_code: 'code-not-found',
					campaign_name: 'Start Your Circle'
				}
			]);
		});

		it('wrote the audit summary row', async () => {
			const audit = await db.query(
				`select actor, payload from audit_log
				 where org_id = $1 and action = 'meta_sync_completed' order by at desc limit 1`,
				[ORG]
			);
			expect(audit.rows[0]!.actor).toBe('ingest-job');
			expect(audit.rows[0]!.payload).toMatchObject({
				range: { since: '2026-04-11', until: '2026-07-09' },
				snapshot_rows_upserted: 3
			});
		});
	});

	describe('run 2 — two days later: watermark catch-up heals the skipped day', () => {
		it('starts at the watermark (re-pulling it) and ingests the gap', async () => {
			currentNow = new Date('2026-07-12T18:00:00Z'); // "today" moved on
			// Platform restated 07-08 upward and delivered three more days.
			fake.insights.set('1201', [
				day('2026-07-07', '12.34', '1500', '37'), // outside range now
				day('2026-07-08', '9.00', '450', '13'),
				day('2026-07-09', '5.00', '400', '10'),
				day('2026-07-10', '6.00', '400', '9'),
				day('2026-07-11', '7.00', '400', '8')
			]);

			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				watermark: '2026-07-08',
				range: { since: '2026-07-08', until: '2026-07-11' },
				snapshot_rows_upserted: 5 // 4 × ad 1201 + re-upserted 1202/07-08
			});
		});

		it('healed the restated day in place and filled the gap — no duplicates', async () => {
			const rows = await db.query(
				`select to_char(s.date, 'YYYY-MM-DD') as date, s.spend_cents
				 from metric_snapshots s join ad_entities e on e.id = s.ad_entity_id
				 where s.org_id = $1 and e.external_ad_id = '1201' order by s.date`,
				[ORG]
			);
			expect(rows.rows).toEqual([
				{ date: '2026-07-07', spend_cents: 1234 },
				{ date: '2026-07-08', spend_cents: 900 }, // restatement healed by re-pull
				{ date: '2026-07-09', spend_cents: 500 }, // the skipped day, caught up
				{ date: '2026-07-10', spend_cents: 600 },
				{ date: '2026-07-11', spend_cents: 700 }
			]);
		});

		it('a same-day re-run is a no-op on the data (idempotent snapshots)', async () => {
			const before = await db.query(
				`select count(*)::int as n, sum(spend_cents)::int as total
				 from metric_snapshots where org_id = $1`,
				[ORG]
			);
			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(200);
			expect(res.json().range).toEqual({ since: '2026-07-11', until: '2026-07-11' });
			const after = await db.query(
				`select count(*)::int as n, sum(spend_cents)::int as total
				 from metric_snapshots where org_id = $1`,
				[ORG]
			);
			expect(after.rows[0]).toEqual(before.rows[0]);
		});

		it('/api/sync/status reflects reality for the staleness banner', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/sync/status' });
			expect(res.statusCode).toBe(200);
			const status = res.json();
			expect(status.data_through).toBe('2026-07-11');
			expect(status.unmatched_ads).toBe(2);
			expect(status.open_deadletters).toBe(0);
			expect(status.platforms[0]).toMatchObject({ platform: 'meta', configured: true });
			expect(status.platforms[0].last_success_at).toBeTruthy();
			expect(status.platforms[0].last_success_summary.range.until).toBe('2026-07-11');
		});
	});

	describe('leaderboard views — settings-driven evidence gate', () => {
		it('v_combo_daily rolls snapshots up per combo per day', async () => {
			const rows = await db.query(
				`select to_char(date, 'YYYY-MM-DD') as date, spend_cents::int as spend_cents, platform
				 from v_combo_daily where org_id = $1 and short_code = $2 order by date`,
				[ORG, shortCode]
			);
			expect(rows.rows).toEqual([
				{ date: '2026-07-07', spend_cents: 1234, platform: 'meta' },
				{ date: '2026-07-08', spend_cents: 900, platform: 'meta' },
				{ date: '2026-07-09', spend_cents: 500, platform: 'meta' },
				{ date: '2026-07-10', spend_cents: 600, platform: 'meta' },
				{ date: '2026-07-11', spend_cents: 700, platform: 'meta' }
			]);
		});

		it('gates on the defaults, exposes a per-platform row plus the rollup', async () => {
			const rows = await db.query(
				`select platform, spend_cents::int as spend_cents, impressions::int as impressions,
				        clicks::int as clicks, ad_count::int as ad_count
				 from v_combo_leaderboard where org_id = $1 order by platform`,
				[ORG]
			);
			// 1234+900+500+600+700 = 3934¢ ≥ 2500 and 3150 imps ≥ 1000 → passes
			expect(rows.rows).toEqual([
				{ platform: 'all', spend_cents: 3934, impressions: 3150, clicks: 77, ad_count: 1 },
				{ platform: 'meta', spend_cents: 3934, impressions: 3150, clicks: 77, ad_count: 1 }
			]);
		});

		it('raising the settings thresholds hides the combo; resetting restores it', async () => {
			const put = await app.inject({
				method: 'PUT',
				url: '/api/settings/evidence_gate_min_spend_cents',
				payload: { value: 5000 }
			});
			expect(put.statusCode).toBe(200);
			const gated = await db.query('select 1 from v_combo_leaderboard where org_id = $1', [ORG]);
			expect(gated.rows).toHaveLength(0);

			await app.inject({
				method: 'PUT',
				url: '/api/settings/evidence_gate_min_spend_cents',
				payload: { value: 2500 }
			});
			const restored = await db.query('select 1 from v_combo_leaderboard where org_id = $1', [ORG]);
			expect(restored.rows).toHaveLength(2);
		});

		it('validates the new settings keys', async () => {
			const badGate = await app.inject({
				method: 'PUT',
				url: '/api/settings/evidence_gate_min_impressions',
				payload: { value: 'lots' }
			});
			expect(badGate.statusCode).toBe(400);
			const badTypes = await app.inject({
				method: 'PUT',
				url: '/api/settings/meta_conversion_action_types',
				payload: { value: 'lead' }
			});
			expect(badTypes.statusCode).toBe(400);
		});
	});

	describe('failure paths', () => {
		it('deadletters unusable rows and failed per-ad fetches without sinking the run', async () => {
			currentNow = new Date('2026-07-13T18:00:00Z');
			fake.insights.set('1201', [
				day('2026-07-11', '7.00', '400', '8'),
				day('2026-07-12', 'not-a-number', '100', '1') // normalizer must refuse
			]);
			fake.failInsightsFor.set(
				'1202',
				new MetaCliError('meta ads insights get failed (exit 1)', 'invocation')
			);

			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				range: { since: '2026-07-11', until: '2026-07-12' },
				snapshot_rows_upserted: 1,
				deadletters: 2
			});

			const letters = await db.query(
				`select platform, payload, error, resolved from ingest_deadletter
				 where org_id = $1 order by created_at`,
				[ORG]
			);
			expect(letters.rows).toHaveLength(2);
			expect(letters.rows.map((r) => r.payload.phase).sort()).toEqual(['insights', 'snapshot']);
			expect(letters.rows.find((r) => r.payload.phase === 'snapshot')!.error).toContain(
				'not-a-number'
			);
			// the bad row's original platform data is preserved whole
			expect(letters.rows.find((r) => r.payload.phase === 'snapshot')!.payload.row.date_start).toBe(
				'2026-07-12'
			);

			const status = await app.inject({ method: 'GET', url: '/api/sync/status' });
			expect(status.json().open_deadletters).toBe(2);
			fake.failInsightsFor.clear();
		});

		it('aborts on auth failure and records meta_sync_failed', async () => {
			fake.failAccountInfo = new MetaCliError('Meta rejected the credentials', 'auth');
			const res = await inject(INTERNAL_TOKEN);
			expect(res.statusCode).toBe(502);
			expect(res.json().error).toBe('meta_cli_auth');

			const audit = await db.query(
				`select payload from audit_log
				 where org_id = $1 and action = 'meta_sync_failed' order by at desc limit 1`,
				[ORG]
			);
			expect(audit.rows[0]!.payload.error).toContain('rejected the credentials');
			fake.failAccountInfo = null;
		});

		it('409s when another sync holds the write lock', async () => {
			const rival = new pg.Client({ connectionString: TEST_DATABASE_URL });
			await rival.connect();
			try {
				await rival.query(
					`select pg_advisory_lock(hashtextextended('sandwichboard.sync.' || $1::text, 0))`,
					[ORG]
				);
				const res = await inject(INTERNAL_TOKEN);
				expect(res.statusCode).toBe(409);
				expect(res.json().error).toBe('sync_already_running');
			} finally {
				await rival.end(); // releases the session lock
			}
		});
	});
});

describe.skipIf(TEST_DATABASE_URL)('meta sync', () => {
	it('is skipped because TEST_DATABASE_URL is unset', () => {
		expect(TEST_DATABASE_URL).toBeUndefined();
	});
});
