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

interface CsvRow {
	cells: string[];
	/** Physical 1-based line the row STARTS on (quoted fields may span more). */
	line: number;
}

function parseCsvRows(text: string): CsvRow[] {
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: CsvRow[] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;
	// Physical line under the cursor vs. where the in-progress row began —
	// quoted fields may contain newlines, so "row index" and "file line"
	// diverge and error messages must cite the latter (docs/import-format.md
	// promises file:line problems).
	let line = 1;
	let rowStartLine = 1;

	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		endField();
		rows.push({ cells: row, line: rowStartLine });
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
			if (ch === '\n') line += 1;
			field += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			if (field.length > 0) {
				throw new CsvError(`unexpected quote inside unquoted field (line ${rowStartLine})`);
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
			line += 1;
			rowStartLine = line;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			endRow();
			i += 1;
			line += 1;
			rowStartLine = line;
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

export function parseCsv(text: string): string[][] {
	return parseCsvRows(text).map((row) => row.cells);
}

export interface CsvTable {
	/** Lowercased, trimmed header names in file order. */
	header: string[];
	/** One record per data row; missing trailing cells become ''. `line` is the physical file line the record starts on. */
	records: { line: number; values: Record<string, string> }[];
}

/** First row is the header — the exchange format has no preamble. */
export function readCsvTable(text: string): CsvTable {
	const rows = parseCsvRows(text);
	if (rows.length === 0) {
		throw new CsvError('file is empty');
	}
	const header = rows[0]!.cells.map((name) => name.trim().toLowerCase());
	if (header.every((name) => name === '')) {
		throw new CsvError('header row is empty');
	}
	const records: CsvTable['records'] = [];
	for (let r = 1; r < rows.length; r++) {
		const { cells, line } = rows[r]!;
		if (cells.every((cell) => cell.trim() === '')) continue; // blank line
		const values: Record<string, string> = {};
		header.forEach((name, c) => {
			if (name !== '') values[name] = (cells[c] ?? '').trim();
		});
		records.push({ line, values });
	}
	return { header, records };
}
