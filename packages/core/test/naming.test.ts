import { describe, expect, it } from 'vitest';
import {
	AdNameError,
	buildAdName,
	isValidCampaignSlug,
	isValidPrefix,
	isValidShortCode,
	parseAdName,
	slugifyCampaign,
	type AdNameParts
} from '../src/naming.js';

const GOOD: AdNameParts = {
	prefix: 'fwt',
	campaignSlug: 'denver-circle',
	shortCode: 'a3xk7',
	version: 2
};

describe('buildAdName', () => {
	it('composes the canonical example from the plan', () => {
		expect(buildAdName(GOOD)).toBe('fwt|denver-circle|a3xk7|v2');
	});

	it('treats the prefix as data — any valid per-org prefix works', () => {
		expect(buildAdName({ ...GOOD, prefix: 'acme-co' })).toBe('acme-co|denver-circle|a3xk7|v2');
		expect(buildAdName({ ...GOOD, prefix: '9lives' })).toBe('9lives|denver-circle|a3xk7|v2');
	});

	it('accepts single-segment slugs and long versions', () => {
		expect(buildAdName({ ...GOOD, campaignSlug: 'brand', version: 999999 })).toBe(
			'fwt|brand|a3xk7|v999999'
		);
	});

	it.each([
		['empty prefix', { ...GOOD, prefix: '' }],
		['uppercase prefix', { ...GOOD, prefix: 'FWT' }],
		['prefix with spaces', { ...GOOD, prefix: 'f wt' }],
		['prefix with pipe', { ...GOOD, prefix: 'f|wt' }],
		['prefix leading hyphen', { ...GOOD, prefix: '-fwt' }],
		['prefix trailing hyphen', { ...GOOD, prefix: 'fwt-' }],
		['prefix too long', { ...GOOD, prefix: 'a'.repeat(17) }],
		['empty slug', { ...GOOD, campaignSlug: '' }],
		['uppercase slug', { ...GOOD, campaignSlug: 'Denver-Circle' }],
		['slug with spaces', { ...GOOD, campaignSlug: 'denver circle' }],
		['slug double hyphen', { ...GOOD, campaignSlug: 'denver--circle' }],
		['slug leading hyphen', { ...GOOD, campaignSlug: '-denver' }],
		['slug trailing hyphen', { ...GOOD, campaignSlug: 'denver-' }],
		['slug with underscore', { ...GOOD, campaignSlug: 'denver_circle' }],
		['slug over 64 chars', { ...GOOD, campaignSlug: 'a-'.repeat(33) + 'a' }],
		['empty code', { ...GOOD, shortCode: '' }],
		['code too short', { ...GOOD, shortCode: 'ab' }],
		['code too long', { ...GOOD, shortCode: 'a'.repeat(13) }],
		['uppercase code', { ...GOOD, shortCode: 'A3XK7' }],
		['code with hyphen', { ...GOOD, shortCode: 'a3-k7' }],
		['version zero', { ...GOOD, version: 0 }],
		['negative version', { ...GOOD, version: -1 }],
		['fractional version', { ...GOOD, version: 2.5 }],
		['version over cap', { ...GOOD, version: 1000000 }],
		['NaN version', { ...GOOD, version: Number.NaN }]
	])('throws AdNameError on %s', (_label, parts) => {
		expect(() => buildAdName(parts)).toThrowError(AdNameError);
	});
});

describe('parseAdName — happy path', () => {
	it('round-trips the canonical example', () => {
		const result = parseAdName('fwt|denver-circle|a3xk7|v2');
		expect(result).toEqual({
			ok: true,
			parts: GOOD,
			canonical: 'fwt|denver-circle|a3xk7|v2'
		});
	});

	it('build → parse → build is the identity for varied valid parts', () => {
		const samples: AdNameParts[] = [
			GOOD,
			{ prefix: 'a', campaignSlug: 'x', shortCode: '000', version: 1 },
			{
				prefix: 'acme-co',
				campaignSlug: 'q3-porch-push-2026',
				shortCode: 'zzzzzzzzzzzz',
				version: 314
			},
			{ prefix: '0-0', campaignSlug: '0', shortCode: '0a1b2', version: 999999 }
		];
		for (const parts of samples) {
			const name = buildAdName(parts);
			const parsed = parseAdName(name);
			expect(parsed.ok, name).toBe(true);
			if (parsed.ok) {
				expect(parsed.parts).toEqual(parts);
				expect(buildAdName(parsed.parts)).toBe(name);
				expect(parsed.canonical).toBe(name);
			}
		}
	});

	it('tolerates stray whitespace around delimiters, reporting the canonical form', () => {
		const parsed = parseAdName('  fwt | denver-circle |a3xk7| v2  ');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.parts).toEqual(GOOD);
			expect(parsed.canonical).toBe('fwt|denver-circle|a3xk7|v2');
		}
	});

	it('enforces expectedPrefix as this org’s own convention', () => {
		expect(parseAdName('fwt|denver-circle|a3xk7|v2', { expectedPrefix: 'fwt' }).ok).toBe(true);
		const foreign = parseAdName('acme|denver-circle|a3xk7|v2', { expectedPrefix: 'fwt' });
		expect(foreign).toMatchObject({ ok: false, code: 'prefix-mismatch' });
	});
});

describe('parseAdName — mangled platform names', () => {
	it.each([
		['empty string', '', 'empty'],
		['whitespace only', '   ', 'empty'],
		['free-text name', 'Summer Sale Ad Final v2', 'segment-count'],
		['three segments (dropped code)', 'fwt|denver-circle|v2', 'segment-count'],
		['five segments (extra pipe)', 'fwt|denver-circle|a3xk7|v2|extra', 'segment-count'],
		['trailing pipe', 'fwt|denver-circle|a3xk7|v2|', 'segment-count'],
		['leading pipe', '|fwt|denver-circle|a3xk7|v2', 'segment-count'],
		['Meta duplicate suffix on the name', 'fwt|denver-circle|a3xk7|v2 - Copy', 'version'],
		['Meta duplicate suffix numbered', 'fwt|denver-circle|a3xk7|v2 - Copy 3', 'version'],
		['“Copy of” prepended', 'Copy of fwt|denver-circle|a3xk7|v2', 'prefix'],
		['uppercased by hand', 'FWT|DENVER-CIRCLE|A3XK7|V2', 'prefix'],
		['empty prefix segment', '|denver-circle|a3xk7|v2', 'prefix'],
		['empty middle segment', 'fwt||a3xk7|v2', 'campaign-slug'],
		['slug mangled with spaces', 'fwt|denver circle|a3xk7|v2', 'campaign-slug'],
		['code truncated by edit', 'fwt|denver-circle|a3|v2', 'short-code'],
		['code uppercased', 'fwt|denver-circle|A3XK7|v2', 'short-code'],
		['version missing v', 'fwt|denver-circle|a3xk7|2', 'version'],
		['version v0', 'fwt|denver-circle|a3xk7|v0', 'version'],
		['version leading zero', 'fwt|denver-circle|a3xk7|v02', 'version'],
		['version decimal', 'fwt|denver-circle|a3xk7|v2.1', 'version'],
		['version uppercase V', 'fwt|denver-circle|a3xk7|V2', 'version'],
		['version with suffix', 'fwt|denver-circle|a3xk7|v2final', 'version'],
		['emoji in slug', 'fwt|denver-🏠|a3xk7|v2', 'campaign-slug'],
		['newline glues two names', 'fwt|denver-circle|a3xk7|v2\nfwt|x|00000|v1', 'segment-count'],
		['newline inside version segment', 'fwt|denver-circle|a3xk7|v2\nx', 'version'],
		['different convention entirely', 'US_Prospecting_Broad_2026-06', 'segment-count']
	])('%s → ok:false (%s)', (_label, raw, code) => {
		const parsed = parseAdName(raw);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.code).toBe(code);
			expect(parsed.reason.length).toBeGreaterThan(0);
		}
	});
});

describe('validators', () => {
	it('isValidPrefix', () => {
		expect(isValidPrefix('fwt')).toBe(true);
		expect(isValidPrefix('a')).toBe(true);
		expect(isValidPrefix('acme-co')).toBe(true);
		expect(isValidPrefix('a'.repeat(16))).toBe(true);
		expect(isValidPrefix('')).toBe(false);
		expect(isValidPrefix('FWT')).toBe(false);
		expect(isValidPrefix('a'.repeat(17))).toBe(false);
		expect(isValidPrefix('-a')).toBe(false);
	});

	it('isValidCampaignSlug', () => {
		expect(isValidCampaignSlug('denver-circle')).toBe(true);
		expect(isValidCampaignSlug('x')).toBe(true);
		expect(isValidCampaignSlug('a'.repeat(64))).toBe(true);
		expect(isValidCampaignSlug('a'.repeat(65))).toBe(false);
		expect(isValidCampaignSlug('UPPER')).toBe(false);
		expect(isValidCampaignSlug('two--hyphens')).toBe(false);
	});

	it('isValidShortCode', () => {
		expect(isValidShortCode('a3xk7')).toBe(true);
		expect(isValidShortCode('000')).toBe(true);
		expect(isValidShortCode('z'.repeat(12))).toBe(true);
		expect(isValidShortCode('zz')).toBe(false);
		expect(isValidShortCode('z'.repeat(13))).toBe(false);
		expect(isValidShortCode('A3XK7')).toBe(false);
	});
});

describe('slugifyCampaign', () => {
	it.each([
		['Denver Circle', 'denver-circle'],
		['  Q3 Porch Push!! 2026  ', 'q3-porch-push-2026'],
		['snake_case_input', 'snake-case-input'],
		['Café Münster', 'cafe-munster'],
		['---', ''],
		['already-a-slug', 'already-a-slug'],
		['Multiple   Spaces', 'multiple-spaces']
	])('%s → %s', (input, expected) => {
		expect(slugifyCampaign(input)).toBe(expected);
	});

	it('output is always a valid slug or empty', () => {
		const inputs = ['Denver Circle', 'x'.repeat(200), '🏠🏠🏠', 'MiXeD CaSe-Thing_42'];
		for (const input of inputs) {
			const slug = slugifyCampaign(input);
			expect(slug === '' || isValidCampaignSlug(slug), `${input} → ${slug}`).toBe(true);
		}
	});
});
