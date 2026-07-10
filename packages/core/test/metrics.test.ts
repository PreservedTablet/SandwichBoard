import { describe, expect, it } from 'vitest';
import { MetricParseError, parseCount, parseMoneyToCents } from '../src/metrics.js';

describe('parseMoneyToCents', () => {
	it('parses platform decimal strings into integer cents', () => {
		expect(parseMoneyToCents('12.34')).toBe(1234);
		expect(parseMoneyToCents('8.00')).toBe(800);
		expect(parseMoneyToCents('8')).toBe(800);
		expect(parseMoneyToCents('0')).toBe(0);
		expect(parseMoneyToCents('0.1')).toBe(10);
		expect(parseMoneyToCents(' 12.34 ')).toBe(1234);
		expect(parseMoneyToCents('107.5')).toBe(10750);
	});

	it('rounds half-up on the third decimal, without float drift', () => {
		expect(parseMoneyToCents('0.005')).toBe(1);
		expect(parseMoneyToCents('1.999')).toBe(200);
		expect(parseMoneyToCents('1.994')).toBe(199);
		// the classic float trap: 4.35 * 100 === 434.99999…
		expect(parseMoneyToCents('4.35')).toBe(435);
	});

	it('rejects anything that is not a plain non-negative decimal', () => {
		for (const bad of ['-3', '1,234.00', '', ' ', 'abc', '1.2.3', '1e3', 'NaN', '$5']) {
			expect(() => parseMoneyToCents(bad), bad).toThrow(MetricParseError);
		}
	});

	it('rejects values that overflow integer cents', () => {
		expect(() => parseMoneyToCents('99999999999999999')).toThrow(MetricParseError);
	});
});

describe('parseCount', () => {
	it('parses non-negative integer strings', () => {
		expect(parseCount('1500')).toBe(1500);
		expect(parseCount('0')).toBe(0);
		expect(parseCount(' 42 ')).toBe(42);
	});

	it('rejects decimals, negatives, and junk', () => {
		for (const bad of ['1.5', '-1', '', 'abc', '1e3']) {
			expect(() => parseCount(bad), bad).toThrow(MetricParseError);
		}
	});
});
