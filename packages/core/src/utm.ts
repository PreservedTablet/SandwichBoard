import { isValidCampaignSlug, isValidShortCode } from './naming.js';

/**
 * The UTM scheme (docs/plan/03): every destination URL carries
 * `utm_source={platform}&utm_medium=paid|organic&utm_campaign={campaign_slug}&utm_content={short_code}`.
 * Landing-side attribution independent of platform reporting — and the
 * safety net when an ad name gets mangled, because `utm_content` still
 * carries the creative's short code.
 */

export const utmMediums = ['paid', 'organic'] as const;
export type UtmMedium = (typeof utmMediums)[number];

// Platform token is data, not an enum: adopters run platforms we have not
// met. Same narrow character set rationale as naming prefixes.
const UTM_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface UtmInput {
	/** e.g. `meta`, `google`, `reddit` — lowercase token. */
	platform: string;
	medium: UtmMedium;
	campaignSlug: string;
	/** `creatives.short_code`. */
	shortCode: string;
}

/** Ordered as the scheme reads; iteration order is the canonical order. */
export interface UtmParams {
	utm_source: string;
	utm_medium: UtmMedium;
	utm_campaign: string;
	utm_content: string;
}

export class UtmError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UtmError';
	}
}

export function buildUtmParams(input: UtmInput): UtmParams {
	if (!UTM_SOURCE_PATTERN.test(input.platform)) {
		throw new UtmError(
			`invalid utm platform ${JSON.stringify(input.platform)} — expected a lowercase token like "meta"`
		);
	}
	if (!utmMediums.includes(input.medium)) {
		throw new UtmError(
			`invalid utm medium ${JSON.stringify(input.medium)} — expected ${utmMediums.join(' | ')}`
		);
	}
	if (!isValidCampaignSlug(input.campaignSlug)) {
		throw new UtmError(`invalid campaign slug ${JSON.stringify(input.campaignSlug)}`);
	}
	if (!isValidShortCode(input.shortCode)) {
		throw new UtmError(`invalid short code ${JSON.stringify(input.shortCode)}`);
	}
	return {
		utm_source: input.platform,
		utm_medium: input.medium,
		utm_campaign: input.campaignSlug,
		utm_content: input.shortCode
	};
}

/** Canonical query-string rendering, in scheme order. */
export function utmQueryString(params: UtmParams): string {
	return (
		`utm_source=${encodeURIComponent(params.utm_source)}` +
		`&utm_medium=${encodeURIComponent(params.utm_medium)}` +
		`&utm_campaign=${encodeURIComponent(params.utm_campaign)}` +
		`&utm_content=${encodeURIComponent(params.utm_content)}`
	);
}

/**
 * Attach the UTM set to a destination URL. Existing non-UTM query params and
 * the fragment are preserved; any pre-existing utm_* of the four managed
 * keys is overwritten (stale tracking must never survive a rebuild).
 */
export function appendUtmToUrl(url: string, params: UtmParams): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UtmError(`invalid destination URL ${JSON.stringify(url)}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new UtmError(`destination URL must be http(s), got ${JSON.stringify(parsed.protocol)}`);
	}
	parsed.searchParams.set('utm_source', params.utm_source);
	parsed.searchParams.set('utm_medium', params.utm_medium);
	parsed.searchParams.set('utm_campaign', params.utm_campaign);
	parsed.searchParams.set('utm_content', params.utm_content);
	return parsed.toString();
}
