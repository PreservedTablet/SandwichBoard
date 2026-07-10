import { describe, expect, it } from 'vitest';
import { UtmError, appendUtmToUrl, buildUtmParams, utmQueryString } from '../src/utm.js';

const PARAMS = buildUtmParams({
	platform: 'meta',
	medium: 'paid',
	campaignSlug: 'denver-circle',
	shortCode: 'a3xk7'
});

describe('buildUtmParams', () => {
	it('maps the scheme fields exactly', () => {
		expect(PARAMS).toEqual({
			utm_source: 'meta',
			utm_medium: 'paid',
			utm_campaign: 'denver-circle',
			utm_content: 'a3xk7'
		});
	});

	it.each([
		['uppercase platform', { platform: 'Meta', medium: 'paid' as const }],
		['platform with space', { platform: 'meta ads', medium: 'paid' as const }],
		['empty platform', { platform: '', medium: 'paid' as const }],
		['bogus medium', { platform: 'meta', medium: 'cpc' as never }]
	])('rejects %s', (_label, partial) => {
		expect(() =>
			buildUtmParams({ campaignSlug: 'denver-circle', shortCode: 'a3xk7', ...partial })
		).toThrowError(UtmError);
	});

	it('rejects invalid slug and code with the shared validators', () => {
		expect(() =>
			buildUtmParams({
				platform: 'meta',
				medium: 'paid',
				campaignSlug: 'Bad Slug',
				shortCode: 'a3xk7'
			})
		).toThrowError(UtmError);
		expect(() =>
			buildUtmParams({
				platform: 'meta',
				medium: 'paid',
				campaignSlug: 'denver-circle',
				shortCode: 'A3'
			})
		).toThrowError(UtmError);
	});
});

describe('utmQueryString', () => {
	it('renders in canonical scheme order', () => {
		expect(utmQueryString(PARAMS)).toBe(
			'utm_source=meta&utm_medium=paid&utm_campaign=denver-circle&utm_content=a3xk7'
		);
	});
});

describe('appendUtmToUrl', () => {
	it('appends to a bare URL', () => {
		expect(appendUtmToUrl('https://friendswithtools.example/invite', PARAMS)).toBe(
			'https://friendswithtools.example/invite?utm_source=meta&utm_medium=paid&utm_campaign=denver-circle&utm_content=a3xk7'
		);
	});

	it('preserves existing non-utm params and the fragment', () => {
		const out = appendUtmToUrl('https://x.example/p?ref=abc#faq', PARAMS);
		const url = new URL(out);
		expect(url.searchParams.get('ref')).toBe('abc');
		expect(url.hash).toBe('#faq');
		expect(url.searchParams.get('utm_content')).toBe('a3xk7');
	});

	it('overwrites stale utm_* values instead of duplicating them', () => {
		const out = appendUtmToUrl(
			'https://x.example/p?utm_source=old&utm_content=zzzzz&keep=1',
			PARAMS
		);
		const url = new URL(out);
		expect(url.searchParams.getAll('utm_source')).toEqual(['meta']);
		expect(url.searchParams.getAll('utm_content')).toEqual(['a3xk7']);
		expect(url.searchParams.get('keep')).toBe('1');
	});

	it('rejects non-URLs and non-http schemes', () => {
		expect(() => appendUtmToUrl('not a url', PARAMS)).toThrowError(UtmError);
		expect(() => appendUtmToUrl('ftp://x.example/file', PARAMS)).toThrowError(UtmError);
		expect(() => appendUtmToUrl('javascript:alert(1)', PARAMS)).toThrowError(UtmError);
	});
});
