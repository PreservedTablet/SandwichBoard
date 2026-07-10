import { describe, expect, it } from 'vitest';
import { checksum, orderMigrations } from '../src/db/migrate.js';

describe('orderMigrations', () => {
	it('sorts by number and ignores non-sql files', () => {
		expect(orderMigrations(['0002_b.sql', 'README.md', '0001_a.sql'])).toEqual([
			'0001_a.sql',
			'0002_b.sql'
		]);
	});

	it('rejects duplicate numbers', () => {
		expect(() => orderMigrations(['0001_a.sql', '0001_b.sql'])).toThrowError(/duplicate/);
	});

	it('rejects filenames outside the convention', () => {
		expect(() => orderMigrations(['1_a.sql'])).toThrowError(/NNNN_lowercase_name/);
		expect(() => orderMigrations(['0001_A.sql'])).toThrowError(/NNNN_lowercase_name/);
		expect(() => orderMigrations(['0001-a.sql'])).toThrowError(/NNNN_lowercase_name/);
	});
});

describe('checksum', () => {
	it('is stable for identical content and differs on change', () => {
		expect(checksum('select 1;')).toBe(checksum('select 1;'));
		expect(checksum('select 1;')).not.toBe(checksum('select 2;'));
	});
});
