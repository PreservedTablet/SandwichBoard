/**
 * The naming convention — the load-bearing wall (docs/plan/03).
 *
 * Ad names on every platform: `{prefix}|{campaign_slug}|{short_code}|v{n}`,
 * e.g. `fwt|denver-circle|a3xk7|v2`. The `{prefix}` is per-org data from the
 * `settings` table (key below) — the parser treats it as data, not a
 * constant, so open-source adopters set their own. This module is the only
 * place ad names are built or parsed; nothing anywhere may hand-construct
 * one (CLAUDE.md convention).
 *
 * Building throws (a caller asking for an invalid name is a programming or
 * settings error). Parsing never throws — unparseable platform names are a
 * normal data condition in ingestion: the row lands with `creative_id null`
 * and surfaces on the `v_unmatched_ads` dashboard alert.
 */

export const AD_NAME_DELIMITER = '|';

/** `settings` key whose jsonb value is the org's ad-name prefix string. */
export const SETTINGS_KEY_NAMING_PREFIX = 'naming_prefix';

// Lowercase alphanumeric, hyphens allowed inside; deliberately narrow so a
// prefix survives every platform's name field untouched.
const PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])?$/;

// Lowercase alphanumeric groups joined by single hyphens.
const CAMPAIGN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAMPAIGN_SLUG_MAX = 64;

// The database generates exactly 5 lowercase base36 chars today (migration
// 0002). The parser tolerates 3–12 so a future length change does not turn
// every historical name unparseable; whether a code matches a creative row
// is ingestion's lookup, not the parser's syntax check.
const SHORT_CODE_PATTERN = /^[0-9a-z]{3,12}$/;

// v1, v2, … — no leading zeros, no v0.
const VERSION_SEGMENT_PATTERN = /^v([1-9][0-9]{0,5})$/;

export interface AdNameParts {
	/** Per-org value from `settings` (`naming_prefix`), e.g. `fwt`. */
	prefix: string;
	/** e.g. `denver-circle`. */
	campaignSlug: string;
	/** `creatives.short_code`, e.g. `a3xk7`. */
	shortCode: string;
	/** 1-based iteration of this combo inside the campaign. */
	version: number;
}

export class AdNameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdNameError';
	}
}

export function isValidPrefix(value: string): boolean {
	return PREFIX_PATTERN.test(value);
}

export function isValidCampaignSlug(value: string): boolean {
	return value.length <= CAMPAIGN_SLUG_MAX && CAMPAIGN_SLUG_PATTERN.test(value);
}

export function isValidShortCode(value: string): boolean {
	return SHORT_CODE_PATTERN.test(value);
}

/**
 * Normalize free text into a valid campaign slug: lowercase, diacritics
 * stripped, every non-alphanumeric run collapsed to a single hyphen.
 * Returns '' when nothing survives — callers must validate before building.
 */
export function slugifyCampaign(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, CAMPAIGN_SLUG_MAX)
		.replace(/-+$/, '');
}

function assertParts(parts: AdNameParts): void {
	if (!isValidPrefix(parts.prefix)) {
		throw new AdNameError(
			`invalid naming prefix ${JSON.stringify(parts.prefix)} — expected 1-16 lowercase alphanumeric/hyphen characters (settings key ${SETTINGS_KEY_NAMING_PREFIX})`
		);
	}
	if (!isValidCampaignSlug(parts.campaignSlug)) {
		throw new AdNameError(
			`invalid campaign slug ${JSON.stringify(parts.campaignSlug)} — expected lowercase alphanumerics joined by single hyphens (try slugifyCampaign)`
		);
	}
	if (!isValidShortCode(parts.shortCode)) {
		throw new AdNameError(
			`invalid short code ${JSON.stringify(parts.shortCode)} — expected 3-12 lowercase base36 characters from creatives.short_code`
		);
	}
	if (!Number.isInteger(parts.version) || parts.version < 1 || parts.version > 999999) {
		throw new AdNameError(
			`invalid version ${JSON.stringify(parts.version)} — expected an integer between 1 and 999999`
		);
	}
}

/** Compose the canonical ad name. Throws `AdNameError` on any invalid part. */
export function buildAdName(parts: AdNameParts): string {
	assertParts(parts);
	return [parts.prefix, parts.campaignSlug, parts.shortCode, `v${parts.version}`].join(
		AD_NAME_DELIMITER
	);
}

/** Machine-readable failure classes, stored alongside unmatched ads. */
export type AdNameParseFailureCode =
	| 'empty'
	| 'segment-count'
	| 'prefix'
	| 'prefix-mismatch'
	| 'campaign-slug'
	| 'short-code'
	| 'version';

export type AdNameParseResult =
	| {
			ok: true;
			parts: AdNameParts;
			/**
			 * The name as the builder would emit it. Equals the input except
			 * when the input carried stray whitespace around delimiters.
			 */
			canonical: string;
	  }
	| { ok: false; code: AdNameParseFailureCode; reason: string };

export interface ParseAdNameOptions {
	/**
	 * The org's own prefix (from `settings`). When given, a structurally
	 * valid name with a different prefix is a failure — ingestion treats
	 * someone else's convention the same as no convention.
	 */
	expectedPrefix?: string;
}

/**
 * Parse a platform ad name back into its parts. Whitespace around the
 * delimiters is tolerated (a hand-retyped name should still match); every
 * other deviation fails with a precise code + reason.
 */
export function parseAdName(raw: string, opts: ParseAdNameOptions = {}): AdNameParseResult {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, code: 'empty', reason: 'name is empty' };
	}

	const segments = trimmed.split(AD_NAME_DELIMITER).map((s) => s.trim());
	if (segments.length !== 4) {
		return {
			ok: false,
			code: 'segment-count',
			reason: `expected 4 pipe-delimited segments (prefix|campaign|code|vN), got ${segments.length}`
		};
	}

	const [prefix, campaignSlug, shortCode, versionSegment] = segments as [
		string,
		string,
		string,
		string
	];

	if (!isValidPrefix(prefix)) {
		return {
			ok: false,
			code: 'prefix',
			reason: `invalid prefix segment ${JSON.stringify(prefix)}`
		};
	}
	if (opts.expectedPrefix !== undefined && prefix !== opts.expectedPrefix) {
		return {
			ok: false,
			code: 'prefix-mismatch',
			reason: `prefix ${JSON.stringify(prefix)} does not match this org's configured prefix`
		};
	}
	if (!isValidCampaignSlug(campaignSlug)) {
		return {
			ok: false,
			code: 'campaign-slug',
			reason: `invalid campaign slug segment ${JSON.stringify(campaignSlug)}`
		};
	}
	if (!isValidShortCode(shortCode)) {
		return {
			ok: false,
			code: 'short-code',
			reason: `invalid short code segment ${JSON.stringify(shortCode)}`
		};
	}
	const versionMatch = VERSION_SEGMENT_PATTERN.exec(versionSegment);
	if (!versionMatch) {
		return {
			ok: false,
			code: 'version',
			reason: `invalid version segment ${JSON.stringify(versionSegment)} — expected v1, v2, …`
		};
	}

	const parts: AdNameParts = {
		prefix,
		campaignSlug,
		shortCode,
		version: Number(versionMatch[1])
	};
	return { ok: true, parts, canonical: buildAdName(parts) };
}
