/**
 * table.js — the delimiter sniff, the column discovery, and the per-row read of a CSV/TSV date
 * table.
 *
 * WHY THIS FILE EXISTS. `parse_temporal_metadata` (hyphaeon/temporal.py:248-330) and
 * `parse_sample_dates` (hyphaeon/dating.py:387-487) each open a delimited file, guess which column
 * holds the name and which holds the date, and read the rows. Opening, guessing and reporting the
 * guess are application work by CLAUDE.md's split rule — they know about a file name, a suffix and
 * a message to show — so they are here. The conversion of a cell into a number is NOT: every value
 * below goes through the library's `parseDate`, which mirrors `temporal.py:73-151`.
 *
 * NEITHER IS THE READER. `parsePhenotypeTable` (`js/src/phenotype.js:489`) is already a
 * pandas-faithful delimited reader — RFC 4180 quoting, doubled quotes, blank-line skipping,
 * per-column dtype inference and the `PANDAS_NA_VALUES` set — written to mirror `pd.read_csv`.
 * Writing a second CSV parser here would mean two answers to "what is in this cell", and the two
 * would drift. The separator is an ARGUMENT to it; sniffing that separator is the seam, and the
 * seam is what this file is.
 *
 * THE TWO REFERENCES DISAGREE ABOUT EVERY STEP, WHICH IS WHY EACH STEP IS REPORTED.
 *
 *   delimiter   temporal.py:274-277 passes `sep=None, engine='python'` to pandas for anything not
 *               ending `.tsv`, so pandas SNIFFS. dating.py:445 decides by suffix alone and reads
 *               `.txt` as TAB-separated. A comma-separated `.txt` is therefore read two different
 *               ways by the two reference pillars, on the same machine, in the same release.
 *               MEASURED: `pd.read_csv(sep=None, engine='python')` on a tab file named `.csv`
 *               sniffs the tab and yields the two columns; `dating`'s `sep=','` yields one column,
 *               whereupon its strain column and its date column are the SAME column and every row
 *               dates to garbage. We sniff, and we say we sniffed (`DATES_DELIMITER_GUESSED`), so
 *               a reader can override rather than discover it downstream.
 *   dtype       temporal.py:275 leaves pandas' type inference ON, so an identifier column of
 *               numeric accessions with one blank cell becomes float64 and `str(v).strip()` yields
 *               `'402124.0'` and `'nan'` — MEASURED, and it matches zero taxa. dating.py:446
 *               passes `dtype=str` and does not. We read with inference (the library's reader is
 *               pandas-faithful) and COUNT the cells it turned into numbers (`numericNames`), so
 *               `DATES_TABLE_NO_MATCH` can name the real cause instead of shrugging.
 *   candidates  two different lists, in two different orders, with two different case rules. Both
 *               are transcribed below, verbatim, and both are tried — temporal's first, because
 *               it is the pillar the date layer serves.
 *   last rung   temporal leaves the date column None and then produces NO DATES AT ALL
 *               (temporal.py:312 guards the loop); dating guesses `df.columns[1]`
 *               (dating.py:463-464). We attempt the guess, because a silent empty answer is the
 *               worse of the two, and raise `DATES_TABLE_COLUMN_GUESSED` at WARN naming the
 *               column — a wrong guess here dates a whole dataset from a column of country codes.
 *
 * WHAT IS DELIBERATELY NOT HERE: a year gate, a month table, a two-digit pivot, a date regular
 * expression. One parser, in `@veg/hyphaeon-js`.
 */

import {
	parseDate,
	parsePhenotypeTable,
	pyStrip,
	cellToString,
	CALENDAR_TIME_UNITS
} from './library.js';
import { DATE_THRESHOLDS, DATE_DELIMITER_CANDIDATES } from './codes.js';

// =================================================================================================
// The candidate lists, both of them, verbatim
// =================================================================================================

/**
 * `cand_strains`, temporal.py:282-285. Membership is CASE-SENSITIVE and tested in CANDIDATE order:
 * the reference loops over the candidates and asks `if c in df_meta.columns`, so a table carrying
 * both `id` and `strain` yields `strain`, whatever the column order is.
 */
export const STRAIN_COLUMNS_TEMPORAL = Object.freeze([
	'strain',
	'taxon',
	'taxa',
	'name',
	'id',
	'accession',
	'sequence_id',
	'isolate',
	'Isolate',
	'Strain',
	'Sequence ID'
]);

/**
 * `cand_dates`, temporal.py:296-301. Case-sensitive, candidate order — note that `generation` and
 * `gen` precede `date`, so a table carrying both is read on its GENERATION column even in calendar
 * mode. The list holding both `date` and `Date` is the tell that the comparison is case-sensitive.
 */
export const DATE_COLUMNS_TEMPORAL = Object.freeze([
	'generation',
	'generations',
	'gen',
	'timepoint',
	'time',
	'day',
	'days',
	'transfer',
	'date',
	'num_date',
	'collection_date',
	'Collection Date',
	'Date',
	'submission_date',
	'year',
	'Collection_Date'
]);

/**
 * `cand_strains`, dating.py:449. Compared LOWER-CASED and iterated in COLUMN order, not candidate
 * order: the reference loops over `df.columns` and asks `if c.lower() in cand_strains`, so the
 * leftmost matching column wins regardless of which candidate it is.
 */
export const STRAIN_COLUMNS_DATING = Object.freeze([
	'strain',
	'taxon',
	'taxa',
	'name',
	'id',
	'genome_id',
	'seq_id',
	'accession',
	'sequence'
]);

/** `cand_dates`, dating.py:458. Lower-cased comparison, column order. */
export const DATE_COLUMNS_DATING = Object.freeze([
	'date',
	'year',
	'time',
	'num_date',
	'decimal_date',
	'collection_date',
	'sampling_date'
]);

/**
 * The non-calendar half of `DATE_COLUMNS_TEMPORAL`: a column so named is evidence that the axis is
 * generations or days, which is the only evidence `inferTimeUnits` has short of the values.
 * `timepoint` and `transfer` are counted as generations because that is what an evolution
 * experiment means by them (temporal.py's own grouping, :296-298).
 */
export const NON_CALENDAR_DATE_COLUMNS = Object.freeze({
	generation: 'generations',
	generations: 'generations',
	gen: 'generations',
	timepoint: 'generations',
	transfer: 'generations',
	day: 'days',
	days: 'days'
});

/** Every name either reference would recognise as a date column, for the refusal message. */
export const ALL_DATE_COLUMN_CANDIDATES = Object.freeze(
	Array.from(new Set([...DATE_COLUMNS_TEMPORAL, ...DATE_COLUMNS_DATING]))
);

// =================================================================================================
// The delimiter sniff
// =================================================================================================

/**
 * Count `sep` in one line, OUTSIDE RFC 4180 quotes, by exactly the rule the library's reader
 * applies (`phenotype.js:494-513`): a `"` opens a quoted run only at the start of a field, a
 * doubled `""` inside one is a literal quote. Counting by any other rule would let the sniff
 * choose a delimiter the reader then splits differently, which is the one failure a sniff must
 * not have.
 *
 * @param {string} line
 * @param {string} sep
 * @returns {number} fields on that line
 */
function fieldsInLine(line, sep) {
	let fields = 1;
	let inQuotes = false;
	let atFieldStart = true;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') i++;
				else inQuotes = false;
			}
		} else if (ch === '"' && atFieldStart) {
			inQuotes = true;
			atFieldStart = false;
		} else if (ch === sep) {
			fields++;
			atFieldStart = true;
		} else {
			atFieldStart = false;
		}
	}
	return fields;
}

/** The delimiter a file name implies, by dating.py:445's rule. `null` when the suffix says nothing. */
export function delimiterFromExtension(fileName) {
	const name = String(fileName ?? '').toLowerCase();
	if (name.endsWith('.tsv') || name.endsWith('.tab') || name.endsWith('.txt')) return '\t';
	if (name.endsWith('.csv')) return ',';
	return null;
}

/**
 * @typedef {{delimiter: string, source: 'supplied'|'extension'|'sniffed'|'default',
 *   confidence: number, fields: number, counts: Record<string, number[]>,
 *   extensionHint: string|null, agrees: boolean}} DelimiterSniff
 */

/**
 * Choose the delimiter of a delimited file, from its CONTENT.
 *
 * The algorithm is deliberately dull, because a clever one is a delimiter that changes when a row
 * is added. Read the first `sniffLines` non-empty lines; for each candidate, count fields per line
 * outside quotes; take the candidate's modal count and the fraction of lines agreeing with it;
 * keep candidates whose modal count is >= 2; prefer the highest agreement, then the largest field
 * count, then candidate order. A file no candidate splits is single-column, and then — and ONLY
 * then — the extension is allowed to answer, because there is nothing to sniff.
 *
 * `confidence` is the agreement fraction; `DATES_DELIMITER_GUESSED` carries it so a reader can see
 * a 0.6 and look again.
 *
 * @param {string} text
 * @param {{fileName?: string, delimiter?: string|null, candidates?: readonly string[], lines?: number}} [options]
 * @returns {DelimiterSniff}
 */
export function sniffDelimiter(text, options = {}) {
	const candidates = options.candidates ?? DATE_DELIMITER_CANDIDATES;
	const limit = options.lines ?? DATE_THRESHOLDS.sniffLines;
	const hint = delimiterFromExtension(options.fileName);

	const lines = String(text ?? '')
		.split(/\r\n|\r|\n/)
		.filter((l) => l !== '')
		.slice(0, limit);

	/** @type {Record<string, number[]>} */
	const counts = {};
	for (const sep of candidates) counts[sep] = lines.map((l) => fieldsInLine(l, sep));

	if (options.delimiter) {
		const sep = options.delimiter;
		const seen = counts[sep] ?? lines.map((l) => fieldsInLine(l, sep));
		const modal = modeOf(seen);
		return {
			delimiter: sep,
			source: 'supplied',
			confidence: agreement(seen, modal),
			fields: modal,
			counts,
			extensionHint: hint,
			agrees: hint === null || hint === sep
		};
	}

	let best = null;
	for (const sep of candidates) {
		const seen = counts[sep];
		if (seen.length === 0) continue;
		const modal = modeOf(seen);
		if (modal < 2) continue;
		const conf = agreement(seen, modal);
		if (
			best === null ||
			conf > best.confidence ||
			(conf === best.confidence && modal > best.fields)
		) {
			best = { delimiter: sep, confidence: conf, fields: modal };
		}
	}

	if (best === null) {
		// Nothing splits this text. A single-column file is legal (one name per line is not a date
		// table, but a one-column table is a readable frame), so the extension may answer here and
		// only here: it is a hint about a file that carries no evidence of its own.
		const sep = hint ?? ',';
		return {
			delimiter: sep,
			source: hint ? 'extension' : 'default',
			confidence: 0,
			fields: 1,
			counts,
			extensionHint: hint,
			agrees: true
		};
	}

	return {
		delimiter: best.delimiter,
		source: 'sniffed',
		confidence: best.confidence,
		fields: best.fields,
		counts,
		extensionHint: hint,
		agrees: hint === null || hint === best.delimiter
	};
}

/** The most common value, ties to the first seen. */
function modeOf(values) {
	/** @type {Map<number, number>} */
	const tally = new Map();
	let best = 0;
	let bestN = 0;
	for (const v of values) {
		const n = (tally.get(v) ?? 0) + 1;
		tally.set(v, n);
		if (n > bestN) {
			bestN = n;
			best = v;
		}
	}
	return best;
}

/** Fraction of `values` equal to `target`. */
function agreement(values, target) {
	if (values.length === 0) return 0;
	let hit = 0;
	for (const v of values) if (v === target) hit++;
	return hit / values.length;
}

// =================================================================================================
// Column discovery
// =================================================================================================

/**
 * @typedef {{column: string|null, index: number,
 *   source: 'supplied'|'temporal'|'dating'|'contains_date'|'first_column'|'second_column'|'none',
 *   alternatives: string[], guessed: boolean}} ColumnChoice
 */

/**
 * The identifier column, by the union ladder:
 *
 *   'supplied'      the caller named it AND it exists
 *   'temporal'      first `STRAIN_COLUMNS_TEMPORAL` member present, CANDIDATE order, case-sensitive
 *   'dating'        first column whose lower case is in `STRAIN_COLUMNS_DATING`, COLUMN order
 *   'first_column'  `columns[0]`  (temporal.py:290-291 and dating.py:454-455 agree on this rung)
 *
 * A `requested` column that is not in `columns` falls THROUGH to discovery, exactly as
 * `temporal.py:280`'s `col_strain not in df_meta.columns` does — the reference ignores a bad
 * `--strain-col` in silence, which is the divergence `ingest.js` turns into a warning.
 *
 * @param {readonly string[]} columns
 * @param {string|null} [requested]
 * @returns {ColumnChoice}
 */
export function discoverStrainColumn(columns, requested = null) {
	const cols = Array.from(columns ?? []);
	const alternatives = cols.filter(
		(c) => STRAIN_COLUMNS_TEMPORAL.includes(c) || STRAIN_COLUMNS_DATING.includes(c.toLowerCase())
	);
	if (cols.length === 0) return { column: null, index: -1, source: 'none', alternatives, guessed: false };

	if (requested && cols.includes(requested)) {
		return { column: requested, index: cols.indexOf(requested), source: 'supplied', alternatives, guessed: false };
	}
	for (const c of STRAIN_COLUMNS_TEMPORAL) {
		if (cols.includes(c)) return { column: c, index: cols.indexOf(c), source: 'temporal', alternatives, guessed: false };
	}
	for (const c of cols) {
		if (STRAIN_COLUMNS_DATING.includes(c.toLowerCase())) {
			return { column: c, index: cols.indexOf(c), source: 'dating', alternatives, guessed: false };
		}
	}
	return { column: cols[0], index: 0, source: 'first_column', alternatives, guessed: true };
}

/**
 * The date column, by the same ladder plus the two rungs only one reference has:
 *
 *   'supplied' | 'temporal' | 'dating'
 *   'contains_date'   any column whose lower case CONTAINS 'date'   (temporal.py:307-310)
 *   'second_column'   `columns[1]`, or `columns[0]` when there is only one  (dating.py:463-464)
 *   null              temporal's real answer, which then dates nothing at all (temporal.py:312)
 *
 * The last two rungs set `guessed`, and `ingest.js` raises `DATES_TABLE_COLUMN_GUESSED` at warn on
 * them: `columns[1]` of a `taxon,location,date` table is the country, and a whole dataset dated
 * from country codes is exactly the silent wrong answer this layer exists to prevent.
 *
 * @param {readonly string[]} columns
 * @param {string|null} [requested]
 * @param {{excludeIndex?: number}} [options] the strain column, which must not also be the date
 * @returns {ColumnChoice}
 */
export function discoverDateColumn(columns, requested = null, options = {}) {
	const cols = Array.from(columns ?? []);
	const alternatives = cols.filter(
		(c) =>
			DATE_COLUMNS_TEMPORAL.includes(c) ||
			DATE_COLUMNS_DATING.includes(c.toLowerCase()) ||
			c.toLowerCase().includes('date')
	);
	if (cols.length === 0) return { column: null, index: -1, source: 'none', alternatives, guessed: false };

	if (requested && cols.includes(requested)) {
		return { column: requested, index: cols.indexOf(requested), source: 'supplied', alternatives, guessed: false };
	}
	for (const c of DATE_COLUMNS_TEMPORAL) {
		if (cols.includes(c)) return { column: c, index: cols.indexOf(c), source: 'temporal', alternatives, guessed: false };
	}
	for (const c of cols) {
		if (DATE_COLUMNS_DATING.includes(c.toLowerCase())) {
			return { column: c, index: cols.indexOf(c), source: 'dating', alternatives, guessed: false };
		}
	}
	for (const c of cols) {
		if (c.toLowerCase().includes('date')) {
			return { column: c, index: cols.indexOf(c), source: 'contains_date', alternatives, guessed: true };
		}
	}
	// dating.py:463-464. The reference does not check that it differs from the strain column; we do,
	// because a one-column frame read under the wrong delimiter would otherwise date every row from
	// its own name and report a confident 100 % coverage of nonsense.
	const exclude = options.excludeIndex ?? -1;
	const idx = cols.length > 1 ? 1 : 0;
	if (idx === exclude) return { column: null, index: -1, source: 'none', alternatives, guessed: false };
	return { column: cols[idx], index: idx, source: 'second_column', alternatives, guessed: true };
}

// =================================================================================================
// Reading the rows
// =================================================================================================

/**
 * @typedef {{
 *   delimiter: DelimiterSniff,
 *   columns: string[],
 *   strain: ColumnChoice,
 *   date: ColumnChoice,
 *   entries: Array<{name: string, raw: string, parse: any, row: number}>,
 *   rowsRead: number,
 *   rowsDated: number,
 *   duplicates: Array<{name: string, rows: number[], values: number[], conflicting: boolean}>,
 *   numericNames: number,
 *   rawValues: string[]
 * }} DateTableRead
 */

/**
 * Read a delimited date table: sniff, discover, then one `parseDate` per row.
 *
 * The name is `str(row[strain_col]).strip()` — `cellToString` then CPython `str.strip()`, the bare
 * `.strip()` of temporal.py:314 and dating.py:467 — and nothing else. No case folding and no
 * accession extraction happen here: `match.js` owns every comparison, so the tier a name matched at
 * is a reported fact rather than a normalisation buried in a reader.
 *
 * The VALUE is handed to `parseDate` as the reader produced it (a number when the column inferred
 * numeric, a string otherwise), because that is what `parse_date_to_decimal(row[col_date])`
 * receives and the two paths differ: `2021.25` the float takes temporal.py:104's gated-numeric
 * branch, `'2021.25'` the string takes :114's.
 *
 * @param {string} text
 * @param {{fileName?: string, delimiter?: string|null, strainCol?: string|null,
 *   dateCol?: string|null, timeUnits?: string}} [options]
 * @returns {DateTableRead}
 */
export function readDateTable(text, options = {}) {
	const timeUnits = options.timeUnits ?? CALENDAR_TIME_UNITS;
	const sniff = sniffDelimiter(text, { fileName: options.fileName, delimiter: options.delimiter });
	const frame = parsePhenotypeTable(text, sniff.delimiter);
	const columns = frame.columns;

	const strain = discoverStrainColumn(columns, options.strainCol ?? null);
	const date = discoverDateColumn(columns, options.dateCol ?? null, { excludeIndex: strain.index });

	/** @type {DateTableRead} */
	const out = {
		delimiter: sniff,
		columns,
		strain,
		date,
		entries: [],
		rowsRead: frame.rows.length,
		rowsDated: 0,
		duplicates: [],
		numericNames: 0,
		rawValues: []
	};
	if (strain.index < 0 || date.index < 0) return out;

	const nameIsFloatCol = Boolean(frame.floatColumns[strain.index]);
	const dateIsFloatCol = Boolean(frame.floatColumns[date.index]);

	/** @type {Map<string, {rows: number[], values: number[]}>} */
	const seen = new Map();

	for (let r = 0; r < frame.rows.length; r++) {
		const row = frame.rows[r];
		const nameCell = row[strain.index];
		const dateCell = row[date.index];
		const name = pyStrip(cellToString(nameCell, nameIsFloatCol));
		// The MEASURED trap: pandas' inference turned an identifier column into float64 (one blank
		// cell is enough), so '402124' reaches us as 402124 and prints '402124.0'. Count it; the
		// refusal message names it, because it is the single most confusing way a table matches
		// nothing at all.
		if (typeof nameCell === 'number') out.numericNames++;

		const raw = cellToString(dateCell, dateIsFloatCol);
		out.rawValues.push(raw);
		const parse = parseDate(dateCell, { timeUnits });
		out.entries.push({ name, raw, parse, row: r });
		if (Number.isFinite(parse.value)) {
			out.rowsDated++;
			const prev = seen.get(name);
			if (prev) {
				prev.rows.push(r);
				prev.values.push(parse.value);
			} else {
				seen.set(name, { rows: [r], values: [parse.value] });
			}
		}
	}

	for (const [name, hit] of seen) {
		if (hit.rows.length < 2) continue;
		// Both references write into a dict (`dates[s_name] = d_val`), so the LAST row wins. The map
		// this read feeds is built the same way; recording the fact is what the reference does not do.
		const conflicting = hit.values.some((v) => v !== hit.values[0]);
		out.duplicates.push({ name, rows: hit.rows, values: hit.values, conflicting });
	}

	return out;
}

/**
 * The `{name -> DateParse}` map a table read contributes, with the LAST row winning, plus the raw
 * cell each answer came from. Separated from `readDateTable` so the duplicate policy is one visible
 * line rather than a property of a loop.
 *
 * @param {DateTableRead} read
 * @returns {{dates: Map<string, any>, raws: Map<string, string>}}
 */
export function tableDateMap(read) {
	/** @type {Map<string, any>} */
	const dates = new Map();
	/** @type {Map<string, string>} */
	const raws = new Map();
	for (const e of read.entries) {
		if (!Number.isFinite(e.parse.value)) continue;
		dates.set(e.name, e.parse);
		raws.set(e.name, e.raw);
	}
	return { dates, raws };
}
