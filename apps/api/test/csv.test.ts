import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, readCsvTable } from '../src/lib/csv.js';

describe('parseCsv', () => {
	it('parses plain rows', () => {
		expect(parseCsv('a,b,c\nd,e,f')).toEqual([
			['a', 'b', 'c'],
			['d', 'e', 'f']
		]);
	});

	it('handles quoted commas, escaped quotes, and newlines in quotes', () => {
		expect(parseCsv('"a,b","say ""hi""","line1\nline2"')).toEqual([
			['a,b', 'say "hi"', 'line1\nline2']
		]);
	});

	it('handles CRLF, BOM, and trailing newline', () => {
		expect(parseCsv('﻿a,b\r\nc,d\r\n')).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('rejects a stray quote mid-field and an unterminated quote', () => {
		expect(() => parseCsv('a"b,c')).toThrowError(CsvError);
		expect(() => parseCsv('"abc')).toThrowError(CsvError);
	});
});

describe('readCsvTable', () => {
	it('lowercases headers, trims cells, pads short rows, skips blank lines', () => {
		const table = readCsvTable('Kind, Title ,Tags\nimage, Porch still \n\nvideo,Clip,"a, b"');
		expect(table.header).toEqual(['kind', 'title', 'tags']);
		expect(table.records).toEqual([
			{ line: 2, values: { kind: 'image', title: 'Porch still', tags: '' } },
			{ line: 4, values: { kind: 'video', title: 'Clip', tags: 'a, b' } }
		]);
	});

	it('rejects empty input', () => {
		expect(() => readCsvTable('')).toThrowError(CsvError);
	});
});
