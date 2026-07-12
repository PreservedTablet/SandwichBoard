import { describe, expect, it } from 'vitest';
import {
	metaAdAccountSchema,
	metaAdSchema,
	metaCampaignSchema,
	metaInsightsResponseSchema,
	normalizeMetaInsightsRow
} from '../src/meta.js';
import { MetricParseError } from '../src/metrics.js';

/**
 * Fixtures mirror the exact JSON the official CLI (meta-ads==1.1.0) prints
 * — captured while verifying the contract for docs/decisions/0005. All
 * values synthetic.
 */

const INSIGHTS_ENVELOPE = {
	data: [
		{
			ad_id: '1201',
			ad_name: 'fwt|start-your-circle|a3xk7|v1',
			spend: '12.34',
			impressions: '1500',
			clicks: '37',
			actions: [
				{ action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
				{ action_type: 'link_click', value: '37' }
			],
			action_values: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4.20' }],
			date_start: '2026-06-01',
			date_stop: '2026-06-01'
		}
	],
	paging: { cursors: { before: 'MAZDZD', after: 'MQZDZD' } }
};

describe('meta CLI output schemas', () => {
	it('parses the adaccount get shape (array of one, extra keys kept)', () => {
		const parsed = metaAdAccountSchema.array().parse([
			{
				id: 'act_1',
				account_id: '1',
				name: 'FWT Main',
				currency: 'USD',
				timezone_name: 'America/Denver',
				account_status: 1,
				amount_spent: '10432'
			}
		]);
		expect(parsed[0]!.timezone_name).toBe('America/Denver');
		expect((parsed[0] as Record<string, unknown>).amount_spent).toBe('10432');
	});

	it('parses campaign and ad list shapes', () => {
		const campaign = metaCampaignSchema.parse({
			id: '901',
			name: 'Start Your Circle',
			objective: 'OUTCOME_LEADS',
			status: 'ACTIVE',
			daily_budget: '1500'
		});
		expect(campaign.daily_budget).toBe('1500');

		const ad = metaAdSchema.parse({
			id: '1201',
			name: 'fwt|start-your-circle|a3xk7|v1',
			adset_id: '801',
			campaign_id: '901',
			effective_status: 'ACTIVE'
		});
		expect(ad.campaign_id).toBe('901');
	});

	it('parses the raw insights envelope and keeps unknown metric keys', () => {
		const parsed = metaInsightsResponseSchema.parse(INSIGHTS_ENVELOPE);
		expect(parsed.data).toHaveLength(1);
		expect(parsed.paging?.next).toBeUndefined();
		expect(parsed.data[0]!.spend).toBe('12.34');
	});

	it('rejects rows without the date columns daily sync depends on', () => {
		expect(() =>
			metaInsightsResponseSchema.parse({ data: [{ spend: '1.00' }], paging: {} })
		).toThrow();
	});
});

describe('normalizeMetaInsightsRow', () => {
	const row = INSIGHTS_ENVELOPE.data[0]!;

	it('normalizes a daily row with the conversion mapping applied', () => {
		const normalized = normalizeMetaInsightsRow(
			metaInsightsResponseSchema.parse(INSIGHTS_ENVELOPE).data[0]!,
			{
				conversionActionTypes: ['offsite_conversion.fb_pixel_lead']
			}
		);
		expect(normalized).toEqual({
			date: '2026-06-01',
			spendCents: 1234,
			impressions: 1500,
			clicks: 37,
			conversions: 2,
			conversionValueCents: 420,
			videoThruplays: null
		});
	});

	it('ingests conversions as 0 when no mapping is configured (raw keeps everything)', () => {
		const normalized = normalizeMetaInsightsRow(row);
		expect(normalized.conversions).toBe(0);
		expect(normalized.conversionValueCents).toBeNull();
	});

	it('treats absent metrics as zero delivery and sums thruplays', () => {
		const normalized = normalizeMetaInsightsRow(
			{
				date_start: '2026-06-02',
				date_stop: '2026-06-02',
				video_thruplay_watched_actions: [
					{ action_type: 'video_view', value: '11' },
					{ action_type: 'video_view', value: '4' }
				]
			},
			{ conversionActionTypes: ['lead'] }
		);
		expect(normalized.spendCents).toBe(0);
		expect(normalized.impressions).toBe(0);
		expect(normalized.videoThruplays).toBe(15);
	});

	it('rejects non-daily rows — a misconfigured time_increment must not ingest', () => {
		expect(() => normalizeMetaInsightsRow({ ...row, date_stop: '2026-06-07' })).toThrow(
			MetricParseError
		);
	});

	it('rejects unparseable metric values with the offending value named', () => {
		expect(() => normalizeMetaInsightsRow({ ...row, spend: 'twelve' })).toThrow(/twelve/);
		expect(() =>
			normalizeMetaInsightsRow(
				{ ...row, actions: [{ action_type: 'lead', value: 'not-a-number' }] },
				{ conversionActionTypes: ['lead'] }
			)
		).toThrow(MetricParseError);
	});
});
