import { describe, expect, it } from 'vitest';
import {
	mapGoogleCsvHeader,
	microsToCents,
	normalizeCustomerId,
	normalizeGoogleCsvRecord
} from '../src/google.js';
import { MetricParseError } from '../src/metrics.js';

describe('mapGoogleCsvHeader', () => {
	it('accepts canonical GAQL field paths', () => {
		const { map, problems } = mapGoogleCsvHeader([
			'ad_group_ad.ad.id',
			'ad_group_ad.ad.name',
			'segments.date',
			'metrics.cost_micros',
			'metrics.impressions',
			'metrics.clicks',
			'metrics.conversions',
			'campaign.id',
			'campaign.name',
			'ad_group.id'
		]);
		expect(problems).toEqual([]);
		expect(map.ad_id).toBe('ad_group_ad.ad.id');
		expect(map.cost_micros).toBe('metrics.cost_micros');
	});

	it('accepts the English UI export aliases (lowercased by the reader)', () => {
		const { map, problems } = mapGoogleCsvHeader([
			'ad id',
			'day',
			'cost',
			'impr.',
			'clicks',
			'conversions',
			'campaign id',
			'campaign'
		]);
		expect(problems).toEqual([]);
		expect(map.ad_id).toBe('ad id');
		expect(map.date).toBe('day');
		expect(map.cost).toBe('cost');
		expect(map.impressions).toBe('impr.');
	});

	it('lists every missing requirement at once, with the accepted names', () => {
		const { problems } = mapGoogleCsvHeader(['something', 'else']);
		expect(problems).toHaveLength(5); // ad_id, date, impressions, clicks, cost
		expect(problems.join('\n')).toContain('ad_group_ad.ad.id');
		expect(problems.join('\n')).toContain('metrics.cost_micros');
	});
});

describe('microsToCents', () => {
	it('converts micros with half-up rounding (1 cent = 10,000 micros)', () => {
		expect(microsToCents(12_340_000)).toBe(1234);
		expect(microsToCents(0)).toBe(0);
		expect(microsToCents(4_999)).toBe(0);
		expect(microsToCents(5_000)).toBe(1);
		expect(microsToCents(12_345)).toBe(1);
		expect(microsToCents(15_000)).toBe(2);
	});
});

describe('normalizeGoogleCsvRecord', () => {
	const map = mapGoogleCsvHeader([
		'ad_group_ad.ad.id',
		'ad_group_ad.ad.name',
		'segments.date',
		'metrics.cost_micros',
		'metrics.impressions',
		'metrics.clicks',
		'metrics.conversions',
		'campaign.id',
		'campaign.name'
	]).map;

	const record = {
		'ad_group_ad.ad.id': '777001',
		'ad_group_ad.ad.name': 'fwt|search-denver|a3xk7|v1',
		'segments.date': '2026-07-01',
		'metrics.cost_micros': '12340000',
		'metrics.impressions': '1500',
		'metrics.clicks': '37',
		'metrics.conversions': '2.5',
		'campaign.id': '99001',
		'campaign.name': 'Search — Denver'
	};

	it('normalizes a full GAQL row', () => {
		expect(normalizeGoogleCsvRecord(record, map)).toEqual({
			externalAdId: '777001',
			adName: 'fwt|search-denver|a3xk7|v1',
			date: '2026-07-01',
			spendCents: 1234,
			impressions: 1500,
			clicks: 37,
			conversions: 2.5,
			externalCampaignId: '99001',
			campaignName: 'Search — Denver',
			externalAdGroupId: null
		});
	});

	it('takes a decimal cost column when micros are absent', () => {
		const decimalMap = mapGoogleCsvHeader(['ad id', 'day', 'cost', 'impr.', 'clicks']).map;
		const row = normalizeGoogleCsvRecord(
			{ 'ad id': '1', day: '2026-07-01', cost: '12.34', 'impr.': '10', clicks: '1' },
			decimalMap
		);
		expect(row.spendCents).toBe(1234);
	});

	it('keeps an unnamed RSA as an empty name (destined for v_unmatched_ads)', () => {
		const row = normalizeGoogleCsvRecord({ ...record, 'ad_group_ad.ad.name': '' }, map);
		expect(row.adName).toBe('');
	});

	it('treats empty metric cells as zero delivery', () => {
		const row = normalizeGoogleCsvRecord(
			{
				...record,
				'metrics.cost_micros': '',
				'metrics.impressions': '',
				'metrics.clicks': '',
				'metrics.conversions': ''
			},
			map
		);
		expect(row).toMatchObject({ spendCents: 0, impressions: 0, clicks: 0, conversions: 0 });
	});

	it('rejects bad cells naming the offending value', () => {
		expect(() =>
			normalizeGoogleCsvRecord({ ...record, 'segments.date': 'Jul 1, 2026' }, map)
		).toThrow(/Jul 1, 2026/);
		expect(() =>
			normalizeGoogleCsvRecord({ ...record, 'metrics.cost_micros': '1,234' }, map)
		).toThrow(MetricParseError);
		expect(() =>
			normalizeGoogleCsvRecord({ ...record, 'metrics.conversions': '1,5' }, map)
		).toThrow(MetricParseError);
		expect(() => normalizeGoogleCsvRecord({ ...record, 'ad_group_ad.ad.id': 'abc' }, map)).toThrow(
			MetricParseError
		);
	});
});

describe('normalizeCustomerId', () => {
	it('strips dashes and validates digits', () => {
		expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
		expect(normalizeCustomerId(' 1234567890 ')).toBe('1234567890');
		expect(() => normalizeCustomerId('acct-42')).toThrow(MetricParseError);
		expect(() => normalizeCustomerId('')).toThrow(MetricParseError);
	});
});
