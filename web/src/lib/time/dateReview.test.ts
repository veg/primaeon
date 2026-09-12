import { describe, expect, it } from 'vitest';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import {
	calendarOf,
	countSentence,
	diagnosis,
	filterReviewRows,
	formatValue,
	pageState,
	readsAs,
	readyGate,
	reviewRows,
	sortReviewRows,
	spanSentence,
	unmatchedMetadataLine,
	type DateIngestLike
} from './dateReview';
import { alignmentHeaders } from './sources';
import { available, example } from './fixtures';

/** The one call the page makes, in the shape the page makes it. */
function ingestOf(alignment: string, metadata?: { text: string; name: string }, options: Record<string, unknown> = {}) {
	const { headerOf } = alignmentHeaders(alignment);
	return ingestDates({
		taxa: taxaForDates(alignment),
		headerOf,
		source: metadata?.text ?? null,
		sourceName: metadata?.name,
		...options
	}) as unknown as DateIngestLike;
}

const SMALL = '>A|2021-05-15\nATGATG\n>B|2021-04\nATGATG\n>C|2019\nATGATG\n>D\nATGATG\n';

describe('the value rendered the way a person reads it', () => {
	// The inverse of the library's own `year + (date - Jan 1).days / daysInYear(year)`.
	it('turns a decimal year back into the date it was read from', () => {
		expect(calendarOf(2021.3671232876711)).toBe('2021-05-15');
		expect(calendarOf(2021.0)).toBe('2021-01-01');
		// A leap year: 366 days, and the library's day clamp (Q3, `min(day, 28)` in February) means
		// 29 February is unreachable — 2020.15846… is 28 February, not the 29th. The rendering must
		// agree with the parser rather than with the calendar.
		expect(calendarOf(2020.1584699453552)).toBe('2020-02-28');
	});

	it('says gen and day off the calendar axis, and never invents a date there', () => {
		expect(readsAs(5000, 'generations')).toBe('gen 5,000');
		expect(readsAs(120, 'days')).toBe('day 120');
		expect(readsAs(42, 'arbitrary')).toBe('42');
		expect(readsAs(null, 'years')).toBe('—');
	});

	it('prints four decimals, or an em dash for an undated sequence', () => {
		expect(formatValue(2021.3671232876711)).toBe('2021.3671');
		expect(formatValue(null)).toBe('—');
	});
});

describe('the rows, and the ranks that order them', () => {
	const ingest = ingestOf(SMALL);
	const rows = reviewRows(ingest, false);

	it('is one row per sequence, in alignment order, undated included', () => {
		expect(rows.length).toBe(4);
		expect(rows.map((r) => r.taxon)).toEqual(['A|2021-05-15', 'B|2021-04', 'C|2019', 'D']);
	});

	it('carries the provenance on every row, not only the number', () => {
		const a = rows[0];
		expect(a.rule).toBe('header_iso');
		expect(a.ruleText).toBe('ISO date in the name');
		expect(a.source).toBe('header');
		expect(a.matched).toBe('2021-05-15');
		expect(a.imputed).toBe(false);
	});

	it('flags the imputed day on a year-and-month header, and says which day', () => {
		const b = rows[1];
		expect(b.rule).toBe('header_year_month');
		expect(b.imputed).toBe(true);
		expect(b.imputations.day).toBe(true);
		expect(b.imputedText).toBe('day');
		expect(b.readsAs).toBe('2021-04-15');
	});

	// Library Q2: a bare four-digit year is 1 January, and `imputed` is FALSE, because the library
	// reports what the reference does. The docstring's promise of mid-year is wrong, and the page
	// must not quietly "fix" it.
	it('reads a bare trailing year as 1 January and reports no imputation', () => {
		const c = rows[2];
		expect(c.rule).toBe('header_trailing_year');
		expect(c.value).toBe(2019);
		expect(c.readsAs).toBe('2019-01-01');
		expect(c.imputed).toBe(false);
	});

	it('keeps an undated sequence as a full row and says which kind of failure it was', () => {
		const d = rows[3];
		// The runtime reports an undated row as NaN in memory (it becomes null only across a JSON
		// round trip), so every consumer guards with Number.isFinite rather than with `== null`.
		expect(Number.isFinite(d.value as number)).toBe(false);
		expect(d.rank).toBe(0);
		expect(d.ruleText).toBe('no pattern matched');
		expect(d.readsAs).toBe('—');
	});

	it('sorts problems first by default, stably within a rank', () => {
		const sorted = sortReviewRows(rows, 'review', true);
		expect(sorted[0].taxon).toBe('D'); // undated
		expect(sorted[1].taxon).toBe('B|2021-04'); // imputed
		expect(sorted.map((r) => r.rank)).toEqual([0, 2, 3, 3]);
	});

	it('sorts the two date columns on the number, never on the rendering', () => {
		const byValue = sortReviewRows(rows, 'value', true).map((r) => r.taxon);
		const byReads = sortReviewRows(rows, 'readsAs', true).map((r) => r.taxon);
		expect(byValue).toEqual(byReads);
		expect(byValue[0]).toBe('C|2019');
		expect(byValue.at(-1)).toBe('D'); // undated last, whichever direction
	});

	it('filters to undated only and to imputed only', () => {
		expect(filterReviewRows(rows, '', 'undated').map((r) => r.taxon)).toEqual(['D']);
		expect(filterReviewRows(rows, '', 'imputed').map((r) => r.taxon)).toEqual(['B|2021-04']);
	});

	it('searches the name, the rendering, the rule and the substring that was read', () => {
		expect(filterReviewRows(rows, '2021-05', 'all').length).toBe(1);
		expect(filterReviewRows(rows, 'trailing', 'all').map((r) => r.taxon)).toEqual(['C|2019']);
		expect(filterReviewRows(rows, 'nothing here', 'all').length).toBe(0);
	});

	it('counts SEQUENCES, never sites', () => {
		expect(countSentence(4, 4)).toBe('4 of 4 sequences');
		expect(countSentence(1, 4)).not.toMatch(/site/);
	});
});

describe('the gate, stated exactly', () => {
	it('is not ready while a sequence is undated and the reader has not said to drop it', () => {
		const ingest = ingestOf(SMALL);
		expect(readyGate(ingest, false).ready).toBe(false);
		expect(readyGate(ingest, false).reasons[0]).toMatch(/carries no date/);
		expect(readyGate(ingest, true).ready).toBe(true);
	});

	it('refuses fewer than three dated sequences in its own words', () => {
		const ingest = ingestOf('>A|2021-05-15\nATG\n>B\nATG\n>C\nATG\n');
		expect(readyGate(ingest, true).reasons[0]).toMatch(/at least 3 are needed/);
	});

	it('refuses when every dated sequence carries the same date', () => {
		const ingest = ingestOf('>A|2021-05-15\nATG\n>B|2021-05-15\nATG\n>C|2021-05-15\nATG\n');
		const gate = readyGate(ingest, true);
		expect(gate.ready).toBe(false);
		expect(gate.reasons.join(' ')).toMatch(/no time axis/);
	});

	it('drives the page state through empty, undated, review and ready', () => {
		expect(pageState(null, null, false)).toBe('empty');
		expect(pageState(ingestOf('>A\nATG\n>B\nATG\n>C\nATG\n'), null, false)).toBe('undated');
		expect(pageState(ingestOf(SMALL), null, false)).toBe('review');
		expect(pageState(ingestOf(SMALL), null, true)).toBe('ready');
		expect(pageState(ingestOf(SMALL), 'could not read that file', false)).toBe('failed');
	});
});

describe('the sentences the page prints', () => {
	it('says how many were dated, from where, over what span, in one sentence', () => {
		const d = diagnosis(ingestOf(SMALL));
		expect(d.sentence).toMatch(/4 sequences, 3 dated/);
		expect(d.sentence).toMatch(/from the sequence headers/);
		expect(d.sentence).toMatch(/read as years/);
		expect(d.warn).toBe(true); // one sequence is undated
	});

	it('spells the span with its unit word', () => {
		expect(spanSentence({ min: 2019, max: 2021.5, span: 2.5 }, 'years')).toBe('2019.00 to 2021.50, 2.50 years');
		expect(spanSentence(null, 'years')).toBe('no span');
	});
});

describe.skipIf(!available())('against the shipped examples', () => {
	// The flagship: 143 LANL names that `temporal.extract_date_from_string` reads NONE of and
	// `dating.parse_header_timestamp` reads 142 of. The page takes the union, which is the whole
	// point of D31.
	it('dates 142 of 143 korber names, the one miss being CONSENSUS', () => {
		const ingest = ingestOf(example('korber_env_gp160.fasta'));
		expect(ingest.coverage.taxa_total).toBe(143);
		expect(ingest.coverage.dated).toBe(142);
		const rows = reviewRows(ingest, false);
		const undated = rows.filter((r) => r.rank === 0);
		expect(undated.map((r) => r.taxon)).toEqual(['CONSENSUS']);
	});

	it('names the LANL two-digit-year rule on those 142, and says the half-year was invented', () => {
		const rows = reviewRows(ingestOf(example('korber_env_gp160.fasta')), false);
		const korber = rows.filter((r) => r.rule === 'korber_isolate');
		expect(korber.length).toBe(142);
		expect(korber[0].ruleText).toBe('LANL two-digit year');
	});

	// MEASURED: the archival anchor changes nothing on this file, because the Korber rule reads
	// Z59ZR.ZHU as 1959.5 anyway. That is what makes shipping it OFF safe, and it is a test rather
	// than a claim.
	it('gives Z59ZR.ZHU 1959.5 with the 1959 anchor off, and the anchor changes no row', () => {
		const off = reviewRows(ingestOf(example('korber_env_gp160.fasta')), false);
		const on = reviewRows(ingestOf(example('korber_env_gp160.fasta'), undefined, { archival1959: true }), false);
		expect(off.find((r) => r.taxon === 'Z59ZR.ZHU')?.value).toBeCloseTo(1959.5, 10);
		// Object.is, not !==: an undated row is NaN on both sides and NaN !== NaN.
		const moved = off.filter((r, i) => !Object.is(r.value, on[i].value)).map((r) => r.taxon);
		expect(moved).toEqual([]);
	});

	it('opens the span at 1959.5', () => {
		const ingest = ingestOf(example('korber_env_gp160.fasta'));
		expect(ingest.span?.min).toBeCloseTo(1959.5, 10);
	});

	// The control: the H5N1 table and the H5N1 headers agree, name for name.
	it('matches 98 of 98 H5N1 names exactly and agrees with the headers', () => {
		const alignment = example('H5N1_HA_geo.fasta');
		const fromHeaders = ingestOf(alignment);
		const fromTable = ingestOf(alignment, { text: example('H5N1_HA_metadata.csv'), name: 'H5N1_HA_metadata.csv' });
		expect(fromTable.coverage.taxa_total).toBe(98);
		expect(fromTable.coverage.dated).toBe(98);
		expect(fromTable.match_tier).toBe('exact');
		const a = reviewRows(fromHeaders, false).map((r) => r.value);
		const b = reviewRows(fromTable, true).map((r) => r.value);
		expect(b).toEqual(a);
	});

	it('names the two columns it discovered on the H5N1 table', () => {
		const ingest = ingestOf(example('H5N1_HA_geo.fasta'), {
			text: example('H5N1_HA_metadata.csv'),
			name: 'H5N1_HA_metadata.csv'
		});
		const table = ingest.table as { strain_col: string; date_col: string };
		expect(table.strain_col).toBe('taxon');
		expect(table.date_col).toBe('date');
	});

	// THE TRAP, and the reason this page exists: a table keyed on accessions matches nothing, and the
	// reference reports that by reporting nothing at all.
	it('shows both name sets when a table matches no sequence, and falls back per taxon', () => {
		const alignment = example('H5N1_HA_geo.fasta');
		const rewritten = example('H5N1_HA_metadata.csv')
			.split('\n')
			.map((line, i) => (i === 0 ? line : line.replace(/^[^,]+/, `EPI_ISL_${400000 + i}`)))
			.join('\n');
		const ingest = ingestOf(alignment, { text: rewritten, name: 'accessions.csv' });
		expect(ingest.coverage.from_table).toBe(0);
		expect(ingest.unmatched_metadata.count).toBeGreaterThan(90);

		const line = unmatchedMetadataLine(ingest, 'accessions.csv');
		expect(line).not.toBeNull();
		expect(line!.lead).toMatch(/rows in accessions\.csv name no sequence in this alignment/);
		expect(line!.names.length).toBe(5);
		expect(line!.names[0]).toMatch(/^EPI_ISL_/);

		// The per-taxon header fallback is what rescues them, and it says so on every row.
		expect(ingest.coverage.from_header).toBe(98);
		const rows = reviewRows(ingest, true);
		expect(rows.every((r) => r.sourceText === 'header (fallback)')).toBe(true);
	});

	it('leaves those 98 undated when the fallback is turned off, as temporal.py:323 would', () => {
		const alignment = example('H5N1_HA_geo.fasta');
		const rewritten = example('H5N1_HA_metadata.csv')
			.split('\n')
			.map((line, i) => (i === 0 ? line : line.replace(/^[^,]+/, `EPI_ISL_${400000 + i}`)))
			.join('\n');
		const ingest = ingestOf(alignment, { text: rewritten, name: 'accessions.csv' }, { headerFallback: false });
		expect(ingest.coverage.dated).toBe(0);
		expect(pageState(ingest, null, false)).toBe('undated');
	});
});
