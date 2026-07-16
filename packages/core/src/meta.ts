import { z } from 'zod';
import { MetricParseError, parseCount, parseDecimal, parseMoneyToCents } from './metrics.js';

/**
 * Shapes of Meta's official Ads CLI JSON output (`meta-ads==1.1.0`,
 * `meta -o json ads …`), verified against the shipped CLI on 2026-07-10 —
 * contract and verification notes in docs/decisions/0005. packages/core is
 * the single definition of every platform metric shape (docs/plan/02); the
 * subprocess handling lives in apps/api's connector.
 *
 * Loose objects throughout: the Marketing API adds fields freely and the
 * full row is preserved in metric_snapshots.raw regardless — parsing must
 * never fail on an extra key.
 */

export const META_PLATFORM = 'meta';

/** `meta ads adaccount get` — array of one; the sync's auth preflight. */
export const metaAdAccountSchema = z.looseObject({
	id: z.string().min(1), // 'act_1234567890'
	name: z.string().optional(),
	currency: z.string().optional(), // 'USD'
	timezone_name: z.string().optional(), // IANA, e.g. 'America/Denver'
	account_status: z.number().optional()
});
export type MetaAdAccount = z.infer<typeof metaAdAccountSchema>;

/** `meta ads campaign list --fields id,name,objective,status,daily_budget`. */
export const metaCampaignSchema = z.looseObject({
	id: z.string().min(1),
	name: z.string().min(1),
	objective: z.string().optional(),
	status: z.string().optional(),
	daily_budget: z.string().optional() // minor units as a string ('1500')
});
export type MetaCampaign = z.infer<typeof metaCampaignSchema>;

/** `meta ads ad list --fields id,name,adset_id,campaign_id,effective_status`. */
export const metaAdSchema = z.looseObject({
	id: z.string().min(1),
	name: z.string().min(1),
	adset_id: z.string().optional(),
	campaign_id: z.string().optional(),
	effective_status: z.string().optional()
});
export type MetaAd = z.infer<typeof metaAdSchema>;

/** Insights `actions` / `action_values` entries. */
export const metaActionSchema = z.looseObject({
	action_type: z.string(),
	value: z.string()
});
export type MetaAction = z.infer<typeof metaActionSchema>;

/**
 * One `data[]` row of `meta ads insights get --ad-id … --time-increment
 * daily`. Numbers arrive as strings; absent metrics arrive as absent keys.
 */
export const metaInsightsRowSchema = z.looseObject({
	ad_id: z.string().optional(),
	ad_name: z.string().optional(),
	date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	date_stop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	spend: z.string().optional(),
	impressions: z.string().optional(),
	clicks: z.string().optional(),
	actions: z.array(metaActionSchema).optional(),
	action_values: z.array(metaActionSchema).optional(),
	video_thruplay_watched_actions: z.array(metaActionSchema).optional()
});
export type MetaInsightsRow = z.infer<typeof metaInsightsRowSchema>;

/** Insights prints the raw Marketing API envelope (lists print bare arrays). */
export const metaInsightsResponseSchema = z.looseObject({
	data: z.array(metaInsightsRowSchema),
	paging: z
		.looseObject({
			next: z.string().optional()
		})
		.optional()
});
export type MetaInsightsResponse = z.infer<typeof metaInsightsResponseSchema>;

/** The metric_snapshots columns a normalized daily row produces. */
export interface NormalizedDailyMetrics {
	date: string; // YYYY-MM-DD
	spendCents: number;
	impressions: number;
	clicks: number;
	conversions: number;
	conversionValueCents: number | null;
	videoThruplays: number | null;
}

function sumActionValues(
	entries: MetaAction[] | undefined,
	actionTypes: ReadonlySet<string>,
	parse: (value: string) => number
): number | null {
	if (!entries) return null;
	let matched = false;
	let total = 0;
	for (const entry of entries) {
		if (!actionTypes.has(entry.action_type)) continue;
		matched = true;
		total += parse(entry.value);
	}
	return matched ? total : null;
}

/**
 * Normalize a daily Insights row into snapshot columns. Which action types
 * count as conversions is per-org data (settings key in metrics.ts). Throws
 * `MetricParseError` with the exact offending value — callers deadletter the
 * original row, they never guess.
 */
export function normalizeMetaInsightsRow(
	row: MetaInsightsRow,
	opts: { conversionActionTypes?: readonly string[] } = {}
): NormalizedDailyMetrics {
	if (row.date_start !== row.date_stop) {
		throw new MetricParseError(
			`insights row spans ${row.date_start}..${row.date_stop} — expected a daily row (time_increment=1)`
		);
	}
	const conversionTypes = new Set(opts.conversionActionTypes ?? []);
	const thruplays = row.video_thruplay_watched_actions
		?.map((entry) => parseCount(entry.value))
		.reduce((a, b) => a + b, 0);

	return {
		date: row.date_start,
		spendCents: row.spend === undefined ? 0 : parseMoneyToCents(row.spend),
		impressions: row.impressions === undefined ? 0 : parseCount(row.impressions),
		clicks: row.clicks === undefined ? 0 : parseCount(row.clicks),
		conversions:
			sumActionValues(row.actions, conversionTypes, (value) => {
				try {
					return parseDecimal(value);
				} catch {
					throw new MetricParseError(`unparseable action value ${JSON.stringify(value)}`);
				}
			}) ?? 0,
		conversionValueCents: sumActionValues(row.action_values, conversionTypes, parseMoneyToCents),
		videoThruplays: thruplays ?? null
	};
}
