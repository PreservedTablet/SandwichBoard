import {
	GOOGLE_PLATFORM,
	MetricParseError,
	SETTINGS_KEY_NAMING_PREFIX,
	mapGoogleCsvHeader,
	normalizeCustomerId,
	normalizeGoogleCsvRecord,
	parseAdName,
	type GoogleCsvRow
} from '@sandwichboard/core';
import type { OrgDb } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';
import { CsvError, readCsvTable } from '../lib/csv.js';
import { getSetting } from '../routes/shared.js';
import { IngestConfigError, SyncAlreadyRunningError } from './meta-sync.js';

/**
 * Google CSV ingestion — the universal fallback/backfill (docs/plan/06
 * Phase 2 Session 2b): no token, no API; export an ad-level daily report
 * and upload it. Column contract lives in packages/core/src/google.ts.
 *
 * Unlike the Meta sync (per-row deadletters for a heterogeneous API), an
 * uploaded file is validated whole and written in ONE transaction or not
 * at all, with file:line problems — one bad cell usually means a wrong
 * export, and a half-ingested file would be worse than a clear rejection
 * (same semantics as pnpm import:library). Unparseable ad NAMES are not
 * file problems: they are a normal data condition and land as unmatched
 * ad_entities rows for the dashboard.
 */

export class GoogleCsvValidationError extends Error {
	constructor(readonly problems: string[]) {
		super(`CSV rejected, nothing written:\n  ${problems.join('\n  ')}`);
		this.name = 'GoogleCsvValidationError';
	}
}

export interface GoogleCsvIngestDeps {
	db: OrgDb;
	actor: string;
	trigger: 'api' | 'cli';
}

export interface GoogleCsvIngestInput {
	csvText: string;
	/** Google customer id (123-456-7890 or digits). */
	externalAccountId: string;
	/** Display label for the platform_accounts row; defaults to the id. */
	accountLabel?: string;
	/** For the audit trail only. */
	filename?: string;
}

export interface GoogleCsvIngestSummary {
	platform: typeof GOOGLE_PLATFORM;
	trigger: 'api' | 'cli';
	account: { external_account_id: string; label: string };
	range: { since: string; until: string };
	rows: number;
	campaigns_synced: number;
	ads_synced: number;
	ads_matched: number;
	ads_unmatched: number;
	snapshot_rows_upserted: number;
	filename: string | null;
	duration_ms: number;
}

const MAX_PROBLEMS = 25;

export async function ingestGoogleCsv(
	deps: GoogleCsvIngestDeps,
	input: GoogleCsvIngestInput
): Promise<GoogleCsvIngestSummary> {
	const { db } = deps;
	const startedAt = Date.now();

	const prefix = await db.tx((client) =>
		getSetting<string>(client, db.orgId, SETTINGS_KEY_NAMING_PREFIX)
	);
	if (prefix === undefined) {
		throw new IngestConfigError(
			'naming_prefix_not_set',
			`set the "${SETTINGS_KEY_NAMING_PREFIX}" setting first (PUT /api/settings/${SETTINGS_KEY_NAMING_PREFIX}) — ingestion parses ad names against this org's prefix`
		);
	}

	// ---- validate everything before touching the database ----
	let externalAccountId: string;
	try {
		externalAccountId = normalizeCustomerId(input.externalAccountId);
	} catch (err) {
		throw new GoogleCsvValidationError([
			err instanceof Error ? err.message : 'invalid customer id'
		]);
	}

	let table;
	try {
		table = readCsvTable(input.csvText);
	} catch (err) {
		if (err instanceof CsvError) throw new GoogleCsvValidationError([err.message]);
		throw err;
	}

	const { map, problems } = mapGoogleCsvHeader(table.header);
	if (problems.length > 0) throw new GoogleCsvValidationError(problems);
	if (table.records.length === 0) {
		throw new GoogleCsvValidationError(['no data rows below the header']);
	}

	const rows: { line: number; row: GoogleCsvRow }[] = [];
	const rowProblems: string[] = [];
	const seen = new Map<string, number>(); // ad_id|date → first line
	for (const record of table.records) {
		if (rowProblems.length >= MAX_PROBLEMS) break;
		try {
			const row = normalizeGoogleCsvRecord(record.values, map);
			const key = `${row.externalAdId}|${row.date}`;
			const firstLine = seen.get(key);
			if (firstLine !== undefined) {
				rowProblems.push(
					`line ${record.line}: duplicate ad ${row.externalAdId} / ${row.date} (first at line ${firstLine}) — export one row per ad per day (segment by day only)`
				);
				continue;
			}
			seen.set(key, record.line);
			rows.push({ line: record.line, row });
		} catch (err) {
			if (!(err instanceof MetricParseError)) throw err;
			rowProblems.push(`line ${record.line}: ${err.message}`);
		}
	}
	if (rowProblems.length > 0) {
		if (rowProblems.length >= MAX_PROBLEMS) rowProblems.push('… (further problems truncated)');
		throw new GoogleCsvValidationError(rowProblems);
	}

	const since = rows.reduce((min, r) => (r.row.date < min ? r.row.date : min), rows[0]!.row.date);
	const until = rows.reduce((max, r) => (r.row.date > max ? r.row.date : max), rows[0]!.row.date);
	const label = input.accountLabel?.trim() || externalAccountId;

	// ---- one write transaction, same per-org lock as the Meta sync ----
	const summary = await db.tx(async (client) => {
		const lock = await client.query<{ locked: boolean }>(
			`select pg_try_advisory_xact_lock(hashtextextended('sandwichboard.sync.' || $1, 0)) as locked`,
			[db.orgId]
		);
		if (!lock.rows[0]!.locked) throw new SyncAlreadyRunningError();

		const account = await client.query<{ id: string }>(
			`insert into platform_accounts (org_id, platform, external_account_id, label)
			 values ($1, $2, $3, $4)
			 on conflict (platform, external_account_id) do update set label = excluded.label
			 returning id`,
			[db.orgId, GOOGLE_PLATFORM, externalAccountId, label]
		);
		const accountRowId = account.rows[0]!.id;

		// campaigns present in the file (id required, name best-effort)
		const campaignIdByExt = new Map<string, string>();
		const campaignNames = new Map<string, string>();
		for (const { row } of rows) {
			if (row.externalCampaignId) {
				const existing = campaignNames.get(row.externalCampaignId);
				if (!existing && row.campaignName) {
					campaignNames.set(row.externalCampaignId, row.campaignName);
				} else if (!existing) {
					campaignNames.set(row.externalCampaignId, `google campaign ${row.externalCampaignId}`);
				}
			}
		}
		for (const [extId, name] of campaignNames) {
			const { rows: upserted } = await client.query<{ id: string }>(
				`insert into campaigns (org_id, platform_account_id, external_id, name, status)
				 values ($1, $2, $3, $4, 'unknown')
				 on conflict (platform_account_id, external_id) where external_id is not null do update
				   set name = excluded.name
				 returning id`,
				[db.orgId, accountRowId, extId, name]
			);
			campaignIdByExt.set(extId, upserted[0]!.id);
		}

		// distinct ads: parse names through the one true parser, batch-match codes
		const adsByExt = new Map<string, GoogleCsvRow>();
		for (const { row } of rows) {
			if (!adsByExt.has(row.externalAdId)) adsByExt.set(row.externalAdId, row);
		}
		const parsedByAdId = new Map<string, ReturnType<typeof parseAdName>>();
		const candidateCodes = new Set<string>();
		for (const [extId, row] of adsByExt) {
			const parsed = parseAdName(row.adName, { expectedPrefix: prefix });
			parsedByAdId.set(extId, parsed);
			if (parsed.ok) candidateCodes.add(parsed.parts.shortCode);
		}
		const creativeIdByCode = new Map<string, string>();
		if (candidateCodes.size > 0) {
			const { rows: creatives } = await client.query<{ id: string; short_code: string }>(
				'select id, short_code from creatives where org_id = $1 and short_code = any($2)',
				[db.orgId, [...candidateCodes]]
			);
			for (const c of creatives) creativeIdByCode.set(c.short_code, c.id);
		}

		const adEntityIdByExt = new Map<string, string>();
		let matched = 0;
		for (const [extId, row] of adsByExt) {
			const parsed = parsedByAdId.get(extId)!;
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
			const { rows: upserted } = await client.query<{ id: string }>(
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
					(row.externalCampaignId && campaignIdByExt.get(row.externalCampaignId)) ?? null,
					creativeId,
					GOOGLE_PLATFORM,
					extId,
					row.externalAdGroupId,
					row.adName,
					failureCode,
					failureReason
				]
			);
			adEntityIdByExt.set(extId, upserted[0]!.id);
		}

		let snapshotRows = 0;
		for (const { row } of rows) {
			await client.query(
				`insert into metric_snapshots (org_id, ad_entity_id, date, spend_cents, impressions, clicks, conversions, raw)
				 values ($1, $2, $3, $4, $5, $6, $7, $8)
				 on conflict (ad_entity_id, date) do update
				   set spend_cents = excluded.spend_cents,
				       impressions = excluded.impressions,
				       clicks = excluded.clicks,
				       conversions = excluded.conversions,
				       raw = excluded.raw,
				       ingested_at = now()`,
				[
					db.orgId,
					adEntityIdByExt.get(row.externalAdId)!,
					row.date,
					row.spendCents,
					row.impressions,
					row.clicks,
					row.conversions,
					JSON.stringify(row)
				]
			);
			snapshotRows += 1;
		}

		const result: GoogleCsvIngestSummary = {
			platform: GOOGLE_PLATFORM,
			trigger: deps.trigger,
			account: { external_account_id: externalAccountId, label },
			range: { since, until },
			rows: rows.length,
			campaigns_synced: campaignIdByExt.size,
			ads_synced: adsByExt.size,
			ads_matched: matched,
			ads_unmatched: adsByExt.size - matched,
			snapshot_rows_upserted: snapshotRows,
			filename: input.filename ?? null,
			duration_ms: Date.now() - startedAt
		};

		await writeAudit(client, {
			orgId: db.orgId,
			actor: deps.actor,
			action: 'google_csv_ingested',
			subjectTable: 'platform_accounts',
			subjectId: accountRowId,
			payload: result as unknown as Record<string, unknown>
		});

		return result;
	});

	return summary;
}
