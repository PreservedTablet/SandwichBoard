import { describe, expect, it } from 'vitest';
import { addDays, dayInTimeZone, yesterdayInTimeZone } from '../src/ingest/dates.js';

describe('ingest date math', () => {
	// 05:30 UTC on July 10 is still July 9 in Denver (UTC-6 in DST).
	const instant = new Date('2026-07-10T05:30:00Z');

	it('computes the calendar day in the ad account timezone', () => {
		expect(dayInTimeZone(instant, 'America/Denver')).toBe('2026-07-09');
		expect(dayInTimeZone(instant, 'UTC')).toBe('2026-07-10');
	});

	it('yesterday differs across timezones for the same instant', () => {
		expect(yesterdayInTimeZone(instant, 'America/Denver')).toEqual({
			date: '2026-07-08',
			timezoneUsed: 'America/Denver'
		});
		expect(yesterdayInTimeZone(instant, 'UTC')).toEqual({
			date: '2026-07-09',
			timezoneUsed: 'UTC'
		});
	});

	it('falls back to UTC on unknown zones (and when the platform omits one)', () => {
		expect(yesterdayInTimeZone(instant, 'Not/AZone')).toEqual({
			date: '2026-07-09',
			timezoneUsed: 'UTC'
		});
		expect(yesterdayInTimeZone(instant, undefined).timezoneUsed).toBe('UTC');
	});

	it('addDays crosses month boundaries and covers the backfill floor', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-07-09', -89)).toBe('2026-04-11');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(() => addDays('7/9/2026', 1)).toThrow(/YYYY-MM-DD/);
	});
});
