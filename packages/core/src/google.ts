import { MetricParseError, parseCount, parseDecimal, parseMoneyToCents } from './metrics.js';

/**
 * Google Ads CSV ingestion contract (docs/plan/06 Phase 2 Session 2b, 04) —
 * the universal fallback/backfill that needs no API token: export an
 * ad-level daily report, upload it. Canonical headers are the GAQL field
 * paths (locale-free, and exactly what the API/MCP emits); a small alias
 * set accepts the English UI export names as a courtesy. Anything else
 * fails with the expected headers listed — renaming a header row once is
 * the documented escape hatch (docs/setup.md).
 *
 * The GAQL query whose CSV export produces the canonical format:
 *
 *   SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, segments.date,
 *          metrics.cost_micros, metrics.impressions, metrics.clicks,
 *          metrics.conversions, campaign.id, campaign.name, ad_group.id
 *   FROM ad_group_ad WHERE segments.date BETWEEN '…' AND '…'
 */

export const GOOGLE_PLATFORM = 'google';

export type GoogleCsvColumn =
	| 'ad_id'
	| 'ad_name'
	| 'date'
	| 'cost_micros'
	| 'cost'
	| 'impressions'
	| 'clicks'
	| 'conversions'
	| 'campaign_id'
	| 'campaign_name'
	| 'ad_group_id';

// Keys are matched against lowercased, trimmed header cells.
const HEADER_ALIASES: Record<GoogleCsvColumn, readonly string[]> = {
	ad_id: ['ad_group_ad.ad.id', 'ad.id', 'ad id'],
	ad_name: ['ad_group_ad.ad.name', 'ad.name', 'ad name'],
	date: ['segments.date', 'day', 'date'],
	cost_micros: ['metrics.cost_micros', 'cost micros'],
	cost: ['metrics.cost', 'cost'],
	impressions: ['metrics.impressions', 'impressions', 'impr.', 'impr'],
	clicks: ['metrics.clicks', 'clicks'],
	conversions: ['metrics.conversions', 'conversions', 'conv.', 'conv'],
	campaign_id: ['campaign.id', 'campaign id'],
	campaign_name: ['campaign.name', 'campaign'],
	ad_group_id: ['ad_group.id', 'ad group id']
};

const REQUIRED: readonly GoogleCsvColumn[] = ['ad_id', 'date', 'impressions', 'clicks'];

/** header cell (lowercased) → canonical column, or absent. */
export type GoogleCsvHeaderMap = Partial<Record<GoogleCsvColumn, string>>;

export interface GoogleCsvHeaderResult {
	map: GoogleCsvHeaderMap;
	problems: string[];
}

/**
 * Resolve a CSV header row (lowercased cells) to canonical columns.
 * Problems are complete — every missing requirement is listed at once so
 * one round-trip fixes the file.
 */
export function mapGoogleCsvHeader(header: readonly string[]): GoogleCsvHeaderResult {
	const map: GoogleCsvHeaderMap = {};
	const problems: string[] = [];
	for (const column of Object.keys(HEADER_ALIASES) as GoogleCsvColumn[]) {
		const match = header.find((cell) => HEADER_ALIASES[column].includes(cell));
		if (match !== undefined) map[column] = match;
	}
	for (const column of REQUIRED) {
		if (!map[column]) {
			problems.push(
				`missing required column ${column} (accepted headers: ${HEADER_ALIASES[column].join(', ')})`
			);
		}
	}
	if (!map.cost_micros && !map.cost) {
		problems.push(
			`missing a cost column: either metrics.cost_micros (${HEADER_ALIASES.cost_micros.join(', ')}) or a decimal cost (${HEADER_ALIASES.cost.join(', ')})`
		);
	}
	return { map, problems };
}

/** One validated, normalized data row of the upload. */
export interface GoogleCsvRow {
	externalAdId: string;
	/** '' when the export has no name (unnamed RSAs) — lands unmatched. */
	adName: string;
	date: string; // YYYY-MM-DD
	spendCents: number;
	impressions: number;
	clicks: number;
	conversions: number;
	externalCampaignId: string | null;
	campaignName: string | null;
	externalAdGroupId: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Integer micros → cents, half-up: 1 cent = 10,000 micros. */
export function microsToCents(micros: number): number {
	return Math.floor((micros + 5_000) / 10_000);
}

/**
 * Normalize one record (header-cell → raw value) against a resolved header
 * map. Throws `MetricParseError` naming the offending column and value —
 * the caller prefixes file:line and rejects the whole upload (all-or-
 * nothing, like the library importer: a machine export with one bad cell
 * is a wrong export, not a row to skip).
 */
export function normalizeGoogleCsvRecord(
	values: Record<string, string>,
	map: GoogleCsvHeaderMap
): GoogleCsvRow {
	const cell = (column: GoogleCsvColumn): string => {
		const header = map[column];
		return header === undefined ? '' : (values[header] ?? '');
	};

	const externalAdId = cell('ad_id');
	if (!/^\d+$/.test(externalAdId)) {
		throw new MetricParseError(`ad id ${JSON.stringify(externalAdId)} — expected digits`);
	}
	const date = cell('date');
	if (!ISO_DAY.test(date)) {
		throw new MetricParseError(
			`date ${JSON.stringify(date)} — expected YYYY-MM-DD (re-export unformatted, or fix the column)`
		);
	}

	let spendCents: number;
	if (map.cost_micros && cell('cost_micros') !== '') {
		spendCents = microsToCents(parseCount(cell('cost_micros')));
	} else if (map.cost && cell('cost') !== '') {
		spendCents = parseMoneyToCents(cell('cost'));
	} else {
		spendCents = 0; // a cost column exists (header check) but the cell is empty
	}

	const conversionsRaw = cell('conversions');
	let conversions = 0;
	if (conversionsRaw !== '') {
		try {
			conversions = parseDecimal(conversionsRaw);
		} catch {
			throw new MetricParseError(
				`conversions ${JSON.stringify(conversionsRaw)} — expected a plain non-negative decimal`
			);
		}
	}

	const campaignId = cell('campaign_id');
	const campaignName = cell('campaign_name');
	const adGroupId = cell('ad_group_id');
	if (campaignId !== '' && !/^\d+$/.test(campaignId)) {
		throw new MetricParseError(`campaign id ${JSON.stringify(campaignId)} — expected digits`);
	}

	return {
		externalAdId,
		adName: cell('ad_name'),
		date,
		spendCents,
		impressions: cell('impressions') === '' ? 0 : parseCount(cell('impressions')),
		clicks: cell('clicks') === '' ? 0 : parseCount(cell('clicks')),
		conversions,
		externalCampaignId: campaignId === '' ? null : campaignId,
		campaignName: campaignName === '' ? null : campaignName,
		externalAdGroupId: adGroupId === '' ? null : adGroupId
	};
}

/** Google customer ids arrive as 123-456-7890 or 1234567890; store digits. */
export function normalizeCustomerId(input: string): string {
	const digits = input.replace(/-/g, '').trim();
	if (!/^\d{4,12}$/.test(digits)) {
		throw new MetricParseError(
			`customer id ${JSON.stringify(input)} — expected digits like 1234567890 (dashes ok)`
		);
	}
	return digits;
}
