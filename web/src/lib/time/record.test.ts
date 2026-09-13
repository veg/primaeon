import { describe, expect, it } from 'vitest';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import { buildRecord, fromStored, summarise } from './record';
import { alignmentHeaders } from './sources';
import type { DateIngestLike } from './dateReview';
import { TIME_SET_SCHEMA_VERSION, type TimeSetOptions } from './types';

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
	outgroup: null
};

function record(id = 'abc') {
	return buildRecord({
		id,
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
		ingest: ingestOf(SMALL),
		ready: true,
		now: 1_700_000_000_000
	});
}

describe('the record', () => {
	it('carries the schema version, the id and a stable timestamp pair', () => {
		const r = record();
		expect(r.schemaVersion).toBe(TIME_SET_SCHEMA_VERSION);
		expect(r.id).toBe('abc');
		expect(r.createdAt).toBe(1_700_000_000_000);
		expect(r.createdAtIso).toBe(new Date(1_700_000_000_000).toISOString());
		expect(r.name).toBe('small.fasta');
	});

	// The review has to survive a reload, and phase 3's run needs the sequences.
	it('keeps the alignment text and its digest', () => {
		const r = record();
		expect(r.inputs.alignmentText).toBe(SMALL);
		expect(r.inputs.alignmentDigest?.sha256).toBe('deadbeef');
	});

	it('is one entry per sequence, including the undated one', () => {
		const r = record();
		expect(r.dates.entries.length).toBe(4);
		expect(r.dates.entries.map((e) => e.taxon)).toEqual(['A|2021-05-15', 'B|2021-04', 'C|2019', 'D']);
	});

	it('keeps the provenance fields on every entry, not only the value', () => {
		const e = record().dates.entries[0];
		expect(e.rule).toBe('header_iso');
		expect(e.source).toBe('header');
		expect(e.matched).toBe('2021-05-15');
		expect(e.imputations).toEqual({ month: false, day: false, dayClamped: false });
	});

	// Plain objects only: the record crosses a structured clone into IndexedDB, and a live proxy or a
	// class instance would throw DataCloneError there rather than here.
	it('is structured-clonable', () => {
		expect(() => structuredClone(record())).not.toThrow();
	});

	it('summarises the counts the page prints above the table', () => {
		const s = summarise(ingestOf(SMALL));
		expect(s.total).toBe(4);
		expect(s.dated).toBe(3);
		expect(s.undated).toBe(1);
		expect(s.imputed).toBe(1);
		expect(s.bySource.header).toBe(3);
		expect(s.byRule.header_iso).toBe(1);
		expect(s.span?.min).toBe(2019);
	});
});

describe('reading a record back', () => {
	it('round-trips one written by this build', () => {
		const r = record();
		const back = fromStored(structuredClone(r));
		expect(back?.id).toBe(r.id);
		expect(back?.dates.entries.length).toBe(4);
		expect(back?.options.dropUndated).toBe(true);
	});

	// A record written before a field existed opens with the default, and a record written by a LATER
	// build keeps whatever it carries — the same non-destructive rule results.ts holds for the
	// database upgrade itself.
	it('fills in options a v1 record predates, without dropping fields it does not know', () => {
		const r = record() as unknown as Record<string, unknown>;
		delete (r.options as Record<string, unknown>).rootMode;
		(r as { futureField?: string }).futureField = 'from a later build';
		const back = fromStored(r);
		expect(back?.options.rootMode).toBe('midpoint');
		expect((back as unknown as { futureField: string }).futureField).toBe('from a later build');
	});

	it('fills in a missing warnings array and a missing unmatched list', () => {
		const r = record() as unknown as Record<string, unknown>;
		delete r.warnings;
		delete (r.dates as Record<string, unknown>).unmatchedMetadata;
		const back = fromStored(r);
		expect(back?.warnings).toEqual([]);
		expect(back?.dates.unmatchedMetadata).toEqual([]);
	});

	it('refuses anything that is not a record at all', () => {
		expect(fromStored(null)).toBeNull();
		expect(fromStored('a string')).toBeNull();
		expect(fromStored({ id: 'x' })).toBeNull();
	});
});
