import {
	INGEST_BACKFILL_DAYS,
	META_PLATFORM,
	MetricParseError,
	SETTINGS_KEY_META_CONVERSION_ACTION_TYPES,
	SETTINGS_KEY_NAMING_PREFIX,
	normalizeMetaInsightsRow,
	parseAdName,
	parseCount,
	type MetaAd,
	type MetaInsightsRow
} from '@sandwichboard/core';
import { MetaCliError, type MetaConnector } from '../connectors/meta-cli.js';
import type { OrgDb } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';
import { getSetting } from '../routes/shared.js';
import { addDays, yesterdayInTimeZone } from './dates.js';

/**
 * The manual range sync (docs/plan/06 Phase 2, Session 2a): compute the
 * per-account watermark, fetch per-ad daily insights watermark→yesterday,
 * upsert ad_entities (names parsed through packages/core), upsert
 * snapshots, deadletter what can't be used, and leave an audit_log summary.
 *
 * Deliberately deterministic — no LLM anywhere in this path — and
 * idempotent: any cadence (daily, weekly, erratic, twice in a row)
 * converges on the same rows, so nothing ever needs to be scheduled.
 *
 * Shape: fetch everything first (subprocess calls, no locks), then write in
 * ONE transaction guarded by a per-org advisory lock; the audit row commits
 * with the data it describes. Failures after fetching begins are recorded
 * as a meta_sync_failed audit row in a separate transaction.
 */

export class IngestConfigError extends Error {
	constructor(
		readonly code: 'naming_prefix_not_set',
		message: string
	) {
		super(message);
		this.name = 'IngestConfigError';
	}
}

export class SyncAlreadyRunningError extends Error {
	constructor() {
		super('a sync for this org is already writing — try again when it finishes');
		this.name = 'SyncAlreadyRunningError';
	}
}

export interface MetaSyncDeps {
	db: OrgDb;
	connector: MetaConnector;
	/** Audit actor; the sync is a job even when a human pressed the button. */
	actor: string;
	/** What invoked this run — recorded in the audit payload. */
	trigger: 'api' | 'cli';
	/** Test seam; production uses the real clock. */
	now?: () => Date;
}

export interface MetaSyncSummary {
	platform: typeof META_PLATFORM;
	trigger: 'api' | 'cli';
	account: {
		external_account_id: string;
		label: string;
		currency: string | null;
		timezone: string | null;
	};
	range: { since: string; until: string };
	watermark: string | null;
	campaigns_synced: number;
	ads_synced: number;
	ads_matched: number;
	ads_unmatched: number;
	snapshot_rows_upserted: number;
	deadletters: number;
	duration_ms: number;
}

interface FetchFailure {
	ad: MetaAd;
	/** The range start this ad's failed fetch used (its own watermark). */
	since: string;
	error: string;
}

export async function runMetaSync(deps: MetaSyncDeps): Promise<MetaSyncSummary> {
	const { db } = deps;
	const startedAt = Date.now();
	const now = deps.now ?? (() => new Date());

	// Pre-flight: the naming prefix is the join key to creatives; without it
	// every ad would land unmatched for a config reason. Refuse before any
	// external call — nothing happened yet, so nothing is audited.
	const prefix = await db.tx((client) =>
		getSetting<string>(client, db.orgId, SETTINGS_KEY_NAMING_PREFIX)
	);
	if (prefix === undefined) {
		throw new IngestConfigError(
			'naming_prefix_not_set',
			`set the "${SETTINGS_KEY_NAMING_PREFIX}" setting first (PUT /api/settings/${SETTINGS_KEY_NAMING_PREFIX}) — ingestion parses ad names against this org's prefix`
		);
	}

	try {
		return await fetchAndWrite(deps, prefix, now, startedAt);
	} catch (err) {
		// The run began talking to the platform; leave a trace whatever
		// happened (docs/plan/05 T6) — in its own transaction, because the
		// write transaction (if any) has rolled back.
		await db
			.tx((client) =>
				writeAudit(client, {
					orgId: db.orgId,
					actor: deps.actor,
					action: 'meta_sync_failed',
					subjectTable: 'platform_accounts',
					payload: {
						platform: META_PLATFORM,
						trigger: deps.trigger,
						error: err instanceof Error ? err.message : String(err),
						duration_ms: Date.now() - startedAt
					}
				})
			)
			.catch(() => undefined); // reporting the original failure wins
		throw err;
	}
}

async function fetchAndWrite(
	deps: MetaSyncDeps,
	prefix: string,
	now: () => Date,
	startedAt: number
): Promise<MetaSyncSummary> {
	const { db, connector } = deps;

	// ---- fetch phase: no database locks while subprocesses run ----
	const account = await connector.getAccountInfo(); // auth preflight
	const { date: until, timezoneUsed } = yesterdayInTimeZone(now(), account.timezone_name);

	const { accountRowId, watermark, watermarkByAd } = await db.tx(async (client) => {
		const { rows } = await client.query<{ id: string }>(
			`insert into platform_accounts (org_id, platform, external_account_id, label, currency, timezone)
			 values ($1, $2, $3, $4, $5, $6)
			 on conflict (platform, external_account_id) do update
			   set label = excluded.label, currency = excluded.currency, timezone = excluded.timezone
			 returning id`,
			[
				db.orgId,
				META_PLATFORM,
				account.id,
				account.name ?? account.id,
				account.currency ?? null,
				account.timezone_name ?? null
			]
		);
		const accountId = rows[0]!.id;
		const wm = await client.query<{ external_ad_id: string; watermark: string }>(
			`select e.external_ad_id, to_char(max(s.date), 'YYYY-MM-DD') as watermark
			 from metric_snapshots s
			 join ad_entities e on e.id = s.ad_entity_id
			 where e.platform_account_id = $1
			 group by e.external_ad_id`,
			[accountId]
		);
		const byAd = new Map(wm.rows.map((row) => [row.external_ad_id, row.watermark]));
		const accountWide =
			wm.rows.length === 0
				? null
				: wm.rows.map((row) => row.watermark).reduce((a, b) => (a > b ? a : b));
		return { accountRowId: accountId, watermark: accountWide, watermarkByAd: byAd };
	});

	// Range: watermark→yesterday inclusive — the newest synced day is pulled
	// again on purpose (heals partial boundary days and late attribution);
	// no watermark ⇒ the 90-day backfill floor. A watermark past `until`
	// (timezone drift) clamps to one day, still idempotent.
	//
	// The watermark is PER AD, not per account: with an account-wide mark,
	// one ad's transient fetch failure would be skipped past by the ads that
	// succeeded — the next run's `since` would sit beyond the failed ad's
	// gap, silently and permanently under-counting that combo. Each ad
	// resumes from its own last snapshot instead.
	const backfillSince = addDays(until, -(INGEST_BACKFILL_DAYS - 1));
	const sinceForAd = (externalAdId: string): string => {
		const mark = watermarkByAd.get(externalAdId);
		if (mark === undefined) return backfillSince;
		return mark > until ? until : mark;
	};

	const campaigns = await connector.listCampaigns();
	const ads = await connector.listAds();

	const insightsByAd = new Map<string, MetaInsightsRow[]>();
	const fetchFailures: FetchFailure[] = [];
	let earliestSince = until;
	for (const ad of ads) {
		const since = sinceForAd(ad.id);
		if (since < earliestSince) earliestSince = since;
		try {
			insightsByAd.set(ad.id, await connector.getAdInsightsDaily(ad.id, since, until));
		} catch (err) {
			// A dead token fails every remaining call identically — abort.
			if (err instanceof MetaCliError && err.kind === 'auth') throw err;
			fetchFailures.push({ ad, since, error: err instanceof Error ? err.message : String(err) });
		}
	}
	const since = ads.length > 0 ? earliestSince : (watermark ?? backfillSince);

	// ---- write phase: one transaction, one writer per org at a time ----
	const summary = await db.tx(async (client) => {
		const lock = await client.query<{ locked: boolean }>(
			`select pg_try_advisory_xact_lock(hashtextextended('sandwichboard.sync.' || $1, 0)) as locked`,
			[db.orgId]
		);
		if (!lock.rows[0]!.locked) throw new SyncAlreadyRunningError();

		const conversionActionTypes =
			(await getSetting<string[]>(client, db.orgId, SETTINGS_KEY_META_CONVERSION_ACTION_TYPES)) ??
			[];

		// campaigns: upsert by (account, external id)
		const campaignIdByExt = new Map<string, string>();
		for (const campaign of campaigns) {
			const { rows } = await client.query<{ id: string }>(
				`insert into campaigns (org_id, platform_account_id, external_id, name, objective, status, budget_daily_cents)
				 values ($1, $2, $3, $4, $5, $6, $7)
				 on conflict (platform_account_id, external_id) where external_id is not null do update
				   set name = excluded.name, objective = excluded.objective,
				       status = excluded.status, budget_daily_cents = excluded.budget_daily_cents
				 returning id`,
				[
					db.orgId,
					accountRowId,
					campaign.id,
					campaign.name,
					campaign.objective ?? null,
					(campaign.status ?? 'unknown').toLowerCase(),
					campaign.daily_budget === undefined ? null : parseCount(campaign.daily_budget)
				]
			);
			campaignIdByExt.set(campaign.id, rows[0]!.id);
		}

		// ad names: parse everything through the one true parser, then match
		// short codes against creatives in a single lookup.
		const parsedByAdId = new Map<string, ReturnType<typeof parseAdName>>();
		const candidateCodes = new Set<string>();
		for (const ad of ads) {
			const parsed = parseAdName(ad.name, { expectedPrefix: prefix });
			parsedByAdId.set(ad.id, parsed);
			if (parsed.ok) candidateCodes.add(parsed.parts.shortCode);
		}
		const creativeIdByCode = new Map<string, string>();
		if (candidateCodes.size > 0) {
			const { rows } = await client.query<{ id: string; short_code: string }>(
				'select id, short_code from creatives where org_id = $1 and short_code = any($2)',
				[db.orgId, [...candidateCodes]]
			);
			for (const row of rows) creativeIdByCode.set(row.short_code, row.id);
		}

		const adEntityIdByExt = new Map<string, string>();
		let matched = 0;
		for (const ad of ads) {
			const parsed = parsedByAdId.get(ad.id)!;
			let creativeId: string | null = null;
			let failureCode: string | null = null;
			let failureReason: string | null = null;
			if (!parsed.ok) {
				failureCode = parsed.code;
				failureReason = parsed.reason;
			} else {
				creativeId = creativeIdByCode.get(parsed.parts.shortCode) ?? null;
				if (creativeId === null) {
					failureCode = 'code-not-found';
					failureReason = `short code ${JSON.stringify(parsed.parts.shortCode)} has no creative row in this org`;
				} else {
					matched += 1;
				}
			}
			const { rows } = await client.query<{ id: string }>(
				`insert into ad_entities (org_id, platform_account_id, campaign_id, creative_id, platform,
				                          external_ad_id, external_adset_id, ad_name, match_failure_code, match_failure_reason)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 on conflict (platform, external_ad_id) do update
				   set platform_account_id = excluded.platform_account_id,
				       campaign_id = excluded.campaign_id,
				       creative_id = excluded.creative_id,
				       external_adset_id = excluded.external_adset_id,
				       ad_name = excluded.ad_name,
				       match_failure_code = excluded.match_failure_code,
				       match_failure_reason = excluded.match_failure_reason
				 returning id`,
				[
					db.orgId,
					accountRowId,
					(ad.campaign_id && campaignIdByExt.get(ad.campaign_id)) ?? null,
					creativeId,
					META_PLATFORM,
					ad.id,
					ad.adset_id ?? null,
					ad.name,
					failureCode,
					failureReason
				]
			);
			adEntityIdByExt.set(ad.id, rows[0]!.id);
		}

		// snapshots: idempotent upserts on (ad_entity_id, date); rows the
		// normalizer rejects are deadlettered whole and the run continues.
		let snapshotRows = 0;
		let deadletters = 0;
		const deadletter = async (payload: Record<string, unknown>, error: string) => {
			await client.query(
				'insert into ingest_deadletter (org_id, platform, payload, error) values ($1, $2, $3, $4)',
				[db.orgId, META_PLATFORM, JSON.stringify(payload), error]
			);
			deadletters += 1;
		};

		for (const [adExtId, rows] of insightsByAd) {
			const adEntityId = adEntityIdByExt.get(adExtId)!;
			for (const row of rows) {
				let normalized;
				try {
					normalized = normalizeMetaInsightsRow(row, { conversionActionTypes });
				} catch (err) {
					if (!(err instanceof MetricParseError)) throw err;
					await deadletter(
						{ phase: 'snapshot', external_ad_id: adExtId, row },
						`${err.message} (ad ${adExtId}, ${row.date_start})`
					);
					continue;
				}
				await client.query(
					`insert into metric_snapshots (org_id, ad_entity_id, date, spend_cents, impressions, clicks,
					                               conversions, conversion_value_cents, video_thruplays, raw)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
					 on conflict (ad_entity_id, date) do update
					   set spend_cents = excluded.spend_cents,
					       impressions = excluded.impressions,
					       clicks = excluded.clicks,
					       conversions = excluded.conversions,
					       conversion_value_cents = excluded.conversion_value_cents,
					       video_thruplays = excluded.video_thruplays,
					       raw = excluded.raw,
					       ingested_at = now()`,
					[
						db.orgId,
						adEntityId,
						normalized.date,
						normalized.spendCents,
						normalized.impressions,
						normalized.clicks,
						normalized.conversions,
						normalized.conversionValueCents,
						normalized.videoThruplays,
						JSON.stringify(row)
					]
				);
				snapshotRows += 1;
			}
		}

		for (const failure of fetchFailures) {
			await deadletter(
				{
					phase: 'insights',
					external_ad_id: failure.ad.id,
					ad_name: failure.ad.name,
					range: { since: failure.since, until }
				},
				failure.error
			);
		}

		const result: MetaSyncSummary = {
			platform: META_PLATFORM,
			trigger: deps.trigger,
			account: {
				external_account_id: account.id,
				label: account.name ?? account.id,
				currency: account.currency ?? null,
				timezone: timezoneUsed
			},
			range: { since, until },
			watermark,
			campaigns_synced: campaigns.length,
			ads_synced: ads.length,
			ads_matched: matched,
			ads_unmatched: ads.length - matched,
			snapshot_rows_upserted: snapshotRows,
			deadletters,
			duration_ms: Date.now() - startedAt
		};

		await writeAudit(client, {
			orgId: db.orgId,
			actor: deps.actor,
			action: 'meta_sync_completed',
			subjectTable: 'platform_accounts',
			subjectId: accountRowId,
			payload: result as unknown as Record<string, unknown>
		});

		return result;
	});

	return summary;
}
