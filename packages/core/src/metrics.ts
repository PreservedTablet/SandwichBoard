/**
 * Metrics-spine shared contracts (docs/plan/03, Phase 2).
 *
 * The evidence gate is data, not code: thresholds live in `settings` rows
 * under the keys below, and the leaderboard view (migration 0004) reads them
 * per org, falling back to the product brief's defaults. The defaults here
 * exist so the API, the view, and the docs state one number.
 */

/** `settings` key: minimum spend (integer cents) before a combo is rankable. */
export const SETTINGS_KEY_GATE_MIN_SPEND_CENTS = 'evidence_gate_min_spend_cents';

/** `settings` key: minimum impressions before a combo is rankable. */
export const SETTINGS_KEY_GATE_MIN_IMPRESSIONS = 'evidence_gate_min_impressions';

/**
 * `settings` key: which Meta Insights `action_type`s count as a conversion
 * (jsonb array of strings). Depends on the operator's Pixel setup, so it is
 * data; unset ⇒ conversions ingest as 0 while `raw` keeps everything
 * (docs/decisions/0005).
 */
export const SETTINGS_KEY_META_CONVERSION_ACTION_TYPES = 'meta_conversion_action_types';

/** Product-brief defaults (docs/plan/01: ≥ $25 spend and ≥ 1,000 impressions). */
export const EVIDENCE_GATE_DEFAULTS = {
	minSpendCents: 2500,
	minImpressions: 1000
} as const;

/**
 * When an account has no snapshots yet, the first sync backfills this many
 * days ending yesterday (docs/plan/06 Phase 2: "90-day backfill floor").
 */
export const INGEST_BACKFILL_DAYS = 90;

export class MetricParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MetricParseError';
	}
}

// Platforms report money as decimal strings in account currency ("12.34").
const MONEY_PATTERN = /^([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Parse a platform money string into integer cents using decimal string
 * math — never floats (a wrong number here becomes a wrong spending
 * decision). Rounds half-up beyond two decimals. Throws `MetricParseError`
 * on anything that is not a plain non-negative decimal.
 */
export function parseMoneyToCents(value: string): number {
	const match = MONEY_PATTERN.exec(value.trim());
	if (!match) {
		throw new MetricParseError(
			`unparseable money value ${JSON.stringify(value)} — expected a non-negative decimal like "12.34"`
		);
	}
	const whole = Number(match[1]);
	const frac = match[2] ?? '';
	const centsPart = Number((frac + '00').slice(0, 2));
	const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
	const cents = whole * 100 + centsPart + roundUp;
	if (!Number.isSafeInteger(cents)) {
		throw new MetricParseError(`money value ${JSON.stringify(value)} overflows integer cents`);
	}
	return cents;
}

/** Parse a platform count string ("1500") into a non-negative integer. */
export function parseCount(value: string): number {
	const trimmed = value.trim();
	if (!/^[0-9]+$/.test(trimmed)) {
		throw new MetricParseError(
			`unparseable count value ${JSON.stringify(value)} — expected a non-negative integer`
		);
	}
	const n = Number(trimmed);
	if (!Number.isSafeInteger(n)) {
		throw new MetricParseError(`count value ${JSON.stringify(value)} overflows a safe integer`);
	}
	return n;
}
