/**
 * Minimal RFC 4180 CSV reader for the library exchange format
 * (docs/import-format.md). Handles quoted fields, escaped quotes (""),
 * commas and newlines inside quotes, CRLF, and a UTF-8 BOM — and nothing
 * more, on purpose: the exchange format is ours, so we control the dialect.
 * No dependency needed for ~60 lines with tests.
 */

export class CsvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CsvError';
	}
}

export function parseCsv(text: string): string[][] {
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;

	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};

	while (i < input.length) {
		const ch = input[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i += 1;
				continue;
			}
			field += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			if (field.length > 0) {
				throw new CsvError(`unexpected quote inside unquoted field (row ${rows.length + 1})`);
			}
			inQuotes = true;
			i += 1;
			continue;
		}
		if (ch === ',') {
			endField();
			i += 1;
			continue;
		}
		if (ch === '\r' && input[i + 1] === '\n') {
			endRow();
			i += 2;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			endRow();
			i += 1;
			continue;
		}
		field += ch;
		i += 1;
	}
	if (inQuotes) {
		throw new CsvError('unterminated quoted field at end of input');
	}
	if (field.length > 0 || row.length > 0) {
		endRow();
	}
	return rows;
}

export interface CsvTable {
	/** Lowercased, trimmed header names in file order. */
	header: string[];
	/** One record per data row; missing trailing cells become ''. 1-based line numbers. */
	records: { line: number; values: Record<string, string> }[];
}

/** First row is the header — the exchange format has no preamble. */
export function readCsvTable(text: string): CsvTable {
	const rows = parseCsv(text);
	if (rows.length === 0) {
		throw new CsvError('file is empty');
	}
	const header = rows[0]!.map((name) => name.trim().toLowerCase());
	if (header.every((name) => name === '')) {
		throw new CsvError('header row is empty');
	}
	const records: CsvTable['records'] = [];
	for (let r = 1; r < rows.length; r++) {
		const cells = rows[r]!;
		if (cells.every((cell) => cell.trim() === '')) continue; // blank line
		const values: Record<string, string> = {};
		header.forEach((name, c) => {
			if (name !== '') values[name] = (cells[c] ?? '').trim();
		});
		records.push({ line: r + 1, values });
	}
	return { header, records };
}
