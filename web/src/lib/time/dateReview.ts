/**
 * dateReview.ts — the review table's view model: the eight columns, the sort that puts problems
 * first, the search, the paging, and the sentences the page prints above and below the table.
 *
 * WHY THIS FILE EXISTS. `web/` has no component-test harness (vitest runs `src/**\/*.test.ts` under
 * `environment: 'node'`), so every decision the `/time` page makes lives in a pure module with a
 * sibling test and the Svelte components stay thin — the idiom of `lib/diagnostics/panel.ts` and
 * `lib/report/phenotype.ts`.
 *
 * THE COLUMNS ARE `DateParse`'s FIELDS, ONE PER FIELD, PLUS THE NAME-MATCHING TIER. Nothing is
 * invented and nothing the library reports is discarded: `rule` is D31's "which rule matched each
 * sequence", `imputations` is the silent-imputation trap made visible, `matched` is the substring a
 * reader needs in order to trust the number, and `match_tier` is the commonest silent failure of
 * the three reference pillars — a metadata name that corresponds to no sequence.
 *
 * THE DEFAULT SORT IS PROBLEMS FIRST, AND THAT IS A PRODUCT DECISION, NOT A CONVENIENCE. The
 * reader's question is *what did you fail to date*; a page that hides twelve failures on page 6 of
 * 6 has reproduced the upstream silence in a nicer font. The head cell therefore says "Review
 * order", so nobody mistakes it for a data column, and the four ranks are:
 *
 *     0  no date        rule ∈ {none, unparsed, out_of_range}
 *     1  matched wrong  the tier is not `exact`, or the row is not in a loaded table
 *     2  imputed        month, day or the day clamp
 *     3  clean
 *
 * ties inside a rank broken by the sequence's position in the file, so the order is stable.
 *
 * A SEQUENCE IS NEVER OMITTED FROM THE TABLE. Undated rows are the evidence a reader needs in
 * order to write a pattern, and the list of names that failed is the only thing that makes a
 * failure actionable. A metadata row that names NO sequence is not a table row at all — the table
 * is one row per alignment sequence — and is counted on its own line under the table instead.
 */

import type { DateEntry, TimeUnits } from './types';
import { imputationLabel, matchTierLabel, ruleLabel, sourceLabel } from './ruleLabel';

/** The runtime's ingest object, narrowed to what this module reads. */
export interface DateIngestLike {
	ok: boolean;
	time_units: TimeUnits;
	time_units_source: 'supplied' | 'inferred';
	time_units_evidence?: Record<string, unknown>;
	source: string;
	sources_used: string[];
	coverage: {
		taxa_total: number;
		dated: number;
		undated: number;
		coverage: number;
		from_map: number;
		from_auspice: number;
		from_table: number;
		from_regex: number;
		from_header: number;
		imputed: number;
		day_clamped: number;
		out_of_range: number;
		archival_1959: number;
	};
	by_rule: Record<string, number>;
	rows: DateEntry[];
	unmatched_metadata: { count: number; names: string[]; sample: string[] };
	unmatched_taxa: { count: number; names: string[]; sample: string[] };
	match_tier: string | null;
	match_tiers: Record<string, number>;
	span: { min: number; max: number; span: number; unique: number; tied: number; finite: number } | null;
	table: Record<string, unknown> | null;
	auspice: Record<string, unknown> | null;
	regex: Record<string, unknown> | null;
	headers: Record<string, unknown> | null;
	warnings: Array<{ code: string; severity: string; message: string; data?: unknown }>;
}

export interface ReviewRow extends DateEntry {
	/** Position in the alignment; the stable tiebreak inside a rank. */
	index: number;
	rank: 0 | 1 | 2 | 3;
	/** Column 3: the value rendered the way a person reads it. */
	readsAs: string;
	ruleText: string;
	sourceText: string;
	imputedText: string;
	matchText: string;
}

export type SortKey = 'review' | 'taxon' | 'value' | 'readsAs' | 'rule' | 'source' | 'raw' | 'imputed' | 'match';
export type RowFilter = 'all' | 'undated' | 'imputed' | 'unmatched';

const UNDATED_RULES = new Set(['none', 'unparsed', 'out_of_range']);

/** The reference's own leap rule, and the one the decimal year was built with. */
function daysInYear(year: number): number {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/**
 * A decimal year back to a calendar date, the inverse of the library's own
 * `year + (date - Jan 1).days / daysInYear(year)`. Rounded to the nearest day, because that is the
 * resolution the forward conversion has.
 */
export function calendarOf(value: number): string {
	if (!Number.isFinite(value)) return '—';
	const year = Math.floor(value);
	const day = Math.round((value - year) * daysInYear(year));
	const date = new Date(Date.UTC(year, 0, 1));
	date.setUTCDate(date.getUTCDate() + day);
	const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(date.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/** Column 3, on whichever axis the run is using. */
export function readsAs(value: number | null, units: TimeUnits): string {
	if (value == null || !Number.isFinite(value)) return '—';
	if (units === 'years') return calendarOf(value);
	const n = value.toLocaleString('en-US', { maximumFractionDigits: 4 });
	if (units === 'generations') return `gen ${n}`;
	if (units === 'days') return `day ${n}`;
	return n;
}

function rankOf(entry: DateEntry, tableLoaded: boolean): 0 | 1 | 2 | 3 {
	if (entry.value == null || !Number.isFinite(entry.value) || UNDATED_RULES.has(entry.rule)) return 0;
	if (tableLoaded && entry.source === 'table' && entry.match_tier !== 'exact') return 1;
	if (tableLoaded && entry.source !== 'table') return 1;
	if (entry.imputed) return 2;
	return 3;
}

/** One row per alignment sequence, in alignment order, with the column text resolved. */
export function reviewRows(ingest: DateIngestLike, tableLoaded: boolean): ReviewRow[] {
	const units = ingest.time_units;
	return ingest.rows.map((entry, index) => ({
		...entry,
		index,
		rank: rankOf(entry, tableLoaded),
		readsAs: readsAs(entry.value, units),
		ruleText: ruleLabel(entry.rule),
		sourceText: sourceLabel(entry.source, tableLoaded),
		imputedText: imputationLabel(entry),
		matchText: entry.source === 'table' || tableLoaded ? matchTierLabel(entry.match_tier, tableLoaded) : '—'
	}));
}

export function sortReviewRows(rows: ReviewRow[], key: SortKey, ascending: boolean): ReviewRow[] {
	const out = [...rows];
	if (key === 'review') {
		out.sort((a, b) => a.rank - b.rank || a.index - b.index);
		return ascending ? out : out;
	}
	const value = (r: ReviewRow): string | number => {
		switch (key) {
			case 'taxon':
				return r.taxon;
			case 'value':
			case 'readsAs':
				// Both columns are the same quantity, so both sort on the number rather than on the
				// rendering — "2019-12-30" sorting after "2021-05-15" as a string would be a lie.
				return r.value == null || !Number.isFinite(r.value) ? Number.POSITIVE_INFINITY : r.value;
			case 'rule':
				return r.ruleText;
			case 'source':
				return r.sourceText;
			case 'raw':
				return r.matched ?? r.raw ?? '';
			case 'imputed':
				return r.imputedText;
			case 'match':
				return r.matchText;
		}
	};
	out.sort((a, b) => {
		const av = value(a);
		const bv = value(b);
		let cmp: number;
		if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
		else cmp = String(av).localeCompare(String(bv));
		if (cmp === 0) return a.index - b.index;
		return ascending ? cmp : -cmp;
	});
	return out;
}

export function filterReviewRows(rows: ReviewRow[], query: string, only: RowFilter): ReviewRow[] {
	const q = query.trim().toLowerCase();
	return rows.filter((r) => {
		if (only === 'undated' && r.rank !== 0) return false;
		if (only === 'imputed' && !r.imputed) return false;
		if (only === 'unmatched' && r.matchText === 'exact') return false;
		if (only === 'unmatched' && r.matchText === '—') return false;
		if (!q) return true;
		return (
			r.taxon.toLowerCase().includes(q) ||
			r.readsAs.toLowerCase().includes(q) ||
			r.sourceText.toLowerCase().includes(q) ||
			r.ruleText.toLowerCase().includes(q) ||
			(r.raw ?? '').toLowerCase().includes(q) ||
			(r.matched ?? '').toLowerCase().includes(q)
		);
	});
}

/**
 * `.table .count`'s text. The word is SEQUENCES, never "sites" — and this stays the only
 * `.table .count` on the page, because `gallery.spec.ts` matches that selector unscoped.
 */
export function countSentence(shown: number, total: number): string {
	return `${shown} of ${total} sequences`;
}

/** The four-decimal decimal-year column, or an em dash. */
export function formatValue(value: number | null): string {
	return value == null || !Number.isFinite(value) ? '—' : value.toFixed(4);
}

/** The span, spelled the way the diagnosis sentence prints it. */
export function spanSentence(
	span: { min: number; max: number; span: number } | null,
	units: TimeUnits
): string {
	if (!span || !Number.isFinite(span.span)) return 'no span';
	const unitWord = units === 'years' ? 'years' : units === 'generations' ? 'generations' : units === 'days' ? 'days' : 'units';
	return `${span.min.toFixed(2)} to ${span.max.toFixed(2)}, ${span.span.toFixed(2)} ${unitWord}`;
}

export interface Diagnosis {
	/** The one sentence in `details.strip`'s summary, after the bold opening. */
	sentence: string;
	/** Whether anything in it deserves the warning treatment. */
	warn: boolean;
}

/** `DataStrip`'s idiom, not its string: one sentence saying what was read, from where. */
export function diagnosis(ingest: DateIngestLike): Diagnosis {
	const c = ingest.coverage;
	const parts: string[] = [];
	parts.push(`${c.taxa_total} sequence${c.taxa_total === 1 ? '' : 's'}, ${c.dated} dated`);
	const from: string[] = [];
	if (c.from_table) from.push(`${c.from_table} from the metadata table`);
	if (c.from_auspice) from.push(`${c.from_auspice} from the Auspice build`);
	if (c.from_map) from.push(`${c.from_map} from the name-to-date JSON`);
	if (c.from_regex) from.push(`${c.from_regex} from your pattern`);
	if (c.from_header) from.push(`${c.from_header} from the sequence headers`);
	if (from.length) parts.push(from.join(', '));
	if (ingest.span) parts.push(spanSentence(ingest.span, ingest.time_units));
	if (c.imputed) parts.push(`${c.imputed} with an imputed month or day`);
	if (c.out_of_range) parts.push(`${c.out_of_range} rejected by the 1800–2100 gate`);
	if (ingest.unmatched_metadata.count) parts.push(`${ingest.unmatched_metadata.count} metadata rows matched no sequence`);
	parts.push(
		ingest.time_units_source === 'inferred'
			? `read as ${ingest.time_units}, inferred from the data`
			: `read as ${ingest.time_units}, as you chose`
	);
	return {
		sentence: `${parts.join('; ')}.`,
		warn: ingest.warnings.some((w) => w.severity === 'warn' || w.severity === 'refuse')
	};
}

export interface ReadyGate {
	ready: boolean;
	/** What is missing, in the words the line under the table uses. */
	reasons: string[];
}

/**
 * A date read by the bare-number rule is the weakest claim this page can make.
 *
 * Under any non-calendar unit the last header pattern (temporal.py:209) takes the first
 * delimiter-bound number in a name, whatever that number means. On a surveillance file it will
 * happily read an accession, an isolate index or a patient code as a generation. Measured on the
 * shipped H1N1 set, whose names carry a decimal year in their last pipe field: choosing
 * "Generations" dates 95 of 100 sequences by this rule alone, and every one of those numbers is
 * nonsense. So when it accounts for most of the dates, the reader has to say out loud that the
 * numbers are what they think they are, exactly as they must for dropped sequences.
 */
export const BARE_NUMBER_RULE = 'header_bare_number';
const BARE_NUMBER_MAJORITY = 0.5;

export function bareNumberDates(ingest: DateIngestLike | null): number {
	return ingest?.by_rule?.[BARE_NUMBER_RULE] ?? 0;
}

/** Does the bare-number rule account for most of what was dated? */
export function bareNumbersDominate(ingest: DateIngestLike | null): boolean {
	if (!ingest) return false;
	const bare = bareNumberDates(ingest);
	return bare > 0 && bare >= ingest.coverage.dated * BARE_NUMBER_MAJORITY;
}

/**
 * The gate, stated exactly. `ready` unlocks the two downloads and sets the record's `ready` flag;
 * it STARTS NOTHING, because neither time-aware analysis is ported yet.
 */
export function readyGate(
	ingest: DateIngestLike | null,
	dropUndated: boolean,
	acceptBareNumbers = false
): ReadyGate {
	if (!ingest) return { ready: false, reasons: ['No alignment is loaded.'] };
	const reasons: string[] = [];
	const c = ingest.coverage;
	if (c.dated < 3) {
		reasons.push(`Only ${c.dated} sequence${c.dated === 1 ? '' : 's'} could be dated; at least 3 are needed.`);
	}
	if (ingest.span && ingest.span.span === 0) {
		reasons.push(`Every dated sequence carries the same date (${ingest.span.min.toFixed(4)}), so there is no time axis.`);
	}
	if (bareNumbersDominate(ingest) && !acceptBareNumbers) {
		const bare = bareNumberDates(ingest);
		reasons.push(
			`${bare} of the ${c.dated} dates were read as a bare number in the sequence name, a rule that ` +
				`claims any number it finds. Confirm below that those numbers are ${ingest.time_units}, or ` +
				`supply a metadata table.`
		);
	}
	if (c.undated > 0 && !dropUndated) {
		reasons.push(
			`${c.undated} sequence${c.undated === 1 ? ' carries' : 's carry'} no date. Tick the box below to continue without ${c.undated === 1 ? 'it' : 'them'}.`
		);
	}
	return { ready: reasons.length === 0, reasons };
}

export type PageState = 'empty' | 'undated' | 'review' | 'ready' | 'failed';

export function pageState(
	ingest: DateIngestLike | null,
	failure: string | null,
	dropUndated: boolean,
	acceptBareNumbers = false
): PageState {
	if (failure) return 'failed';
	if (!ingest) return 'empty';
	if (ingest.coverage.dated === 0) return 'undated';
	return readyGate(ingest, dropUndated, acceptBareNumbers).ready ? 'ready' : 'review';
}

/** The line under the table about metadata rows that named no sequence — the most important one. */
export function unmatchedMetadataLine(
	ingest: DateIngestLike,
	metadataName: string | null
): { lead: string; rest: string; names: string[]; more: string[] } | null {
	const u = ingest.unmatched_metadata;
	const table = ingest.table as { rows_read?: number } | null;
	if (!u || u.count === 0) return null;
	const total = table?.rows_read ?? u.count;
	return {
		lead: `${u.count} of ${total} rows in ${metadataName ?? 'the metadata file'} name no sequence in this alignment`,
		rest: 'so they contributed nothing:',
		names: u.names.slice(0, 5),
		more: u.names.slice(5)
	};
}
