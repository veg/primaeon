import { describe, expect, it } from 'vitest';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import { DATES_CSV_COLUMNS, datesCsv, datesJson } from './downloads';
import { reviewRows, type DateIngestLike } from './dateReview';
import { buildRecord } from './record';
import { alignmentHeaders } from './sources';
import type { TimeSetOptions } from './types';

const SMALL = '>A|2021-05-15\nATGATG\n>B|2021-04\nATGATG\n>C|2019\nATGATG\n>D\nATGATG\n';

function ingestOf(text: string): DateIngestLike {
	const { headerOf } = alignmentHeaders(text);
	return ingestDates({ taxa: taxaForDates(text), headerOf }) as unknown as DateIngestLike;
}

const OPTIONS: TimeSetOptions = {
	units: 'years',
	unitsInferred: true,
	headerFallback: true,
	archival1959: false,
	customPattern: null,
	idColumn: null,
	dateColumn: null,
	delimiter: null,
	dropUndated: true,
	rootMode: 'midpoint',
	outgroup: null,
	datingRoot: 'consensus',
	rootTaxon: null,
	clockModel: 'auto',
	ciMethod: 'fieller',
	excludedTaxa: []
};

const ingest = ingestOf(SMALL);
const rows = reviewRows(ingest, false);
const record = buildRecord({
	id: 'abc',
	inputs: {
		alignmentName: 'small.fasta',
		alignmentText: SMALL,
		alignmentDigest: { name: 'small.fasta', size: SMALL.length, sha256: 'deadbeef' },
		treeName: null,
		treeText: null,
		metadataName: null,
		metadataText: null,
		metadataDigest: null
	},
	options: OPTIONS,
	ingest,
	ready: true,
	now: 1_700_000_000_000
});

describe('the CSV', () => {
	const csv = datesCsv(rows);
	const lines = csv.trimEnd().split('\n');

	it('writes the column constant as its header', () => {
		expect(lines[0]).toBe(DATES_CSV_COLUMNS.join(','));
	});

	// The constant and the runtime's row shape cannot drift without a failure here: every column
	// beyond the two renderings names a field the ingest actually produces.
	it('names only fields the runtime row carries', () => {
		const row = ingest.rows[0] as unknown as Record<string, unknown>;
		const fromRow = ['date', 'reads_as'];
		for (const column of DATES_CSV_COLUMNS) {
			if (fromRow.includes(column)) continue;
			const field = column === 'sequence' ? 'taxon' : column === 'read_from' ? 'raw' : column === 'name_match' ? 'match_tier' : column;
			expect(Object.prototype.hasOwnProperty.call(row, field), `no runtime field behind CSV column ${column}`).toBe(true);
		}
	});

	it('is one row per sequence, undated included, in the order it was handed', () => {
		expect(lines.length).toBe(5);
		expect(lines[1].startsWith('A|2021-05-15,')).toBe(true);
		expect(lines[4].startsWith('D,')).toBe(true);
	});

	it('leaves an undated row blank rather than writing NaN at a reader', () => {
		expect(lines[4]).toBe('D,,,none,unparsed,,,');
		expect(csv).not.toMatch(/NaN/);
	});

	it('carries the provenance columns, not only the number', () => {
		expect(lines[1]).toContain('header_iso');
		expect(lines[1]).toContain('2021-05-15');
		expect(lines[2]).toContain('day'); // the imputed day on the year-and-month header
	});

	it('quotes a cell containing a comma or a quote', () => {
		const tricky = reviewRows(ingestOf('>A,with,commas|2021-05-15\nATG\n>B "quoted"|2020\nATG\n>C|2019\nATG\n'), false);
		const out = datesCsv(tricky).split('\n');
		expect(out[1]).toMatch(/^"A,with,commas\|2021-05-15"/);
		expect(datesCsv(tricky)).toContain('""quoted""');
	});
});

describe('the JSON', () => {
	const doc = JSON.parse(datesJson(record, '1.0.0'));

	it('is the {sequence: date} map every upstream parser builds internally', () => {
		expect(Object.keys(doc.entries).sort()).toEqual(['A|2021-05-15', 'B|2021-04', 'C|2019']);
		expect(doc.entries['C|2019']).toBe(2019);
	});

	it('lists the undated separately rather than dropping them silently', () => {
		expect(doc.undated).toEqual(['D']);
	});

	it('carries every option that produced it, so the review is reproducible from the file', () => {
		expect(doc.units).toBe('years');
		expect(doc.provenance.alignment).toBe('small.fasta');
		expect(doc.provenance.alignment_sha256).toBe('deadbeef');
		expect(doc.provenance.header_fallback).toBe(true);
		expect(doc.provenance.archival_1959).toBe(false);
		expect(doc.provenance.units_inferred).toBe(true);
		expect(doc.provenance.by_rule.header_iso).toBe(1);
		expect(doc.provenance.library).toBe('1.0.0');
		expect(doc.provenance.generated).toBe(new Date(1_700_000_000_000).toISOString());
	});

	// web/DESIGN.md §5: a claim the product has not verified is not copy this product writes.
	it('says it is PrimAeon’s own file and claims no command-line interchangeability', () => {
		expect(doc.generator).toMatch(/PrimAeon/);
		expect(doc.generator).toMatch(/not a hyphaeon CLI input format/);
	});
});
