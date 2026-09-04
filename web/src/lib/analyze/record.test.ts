/**
 * record.test.ts — the runtime-result → MemeRecord adapter, on both row shapes the runtime has
 * produced.
 *
 * WHY THIS FILE EXISTS. record.ts is the one place the runtime's result shape is read, and the
 * shape changed between Phase 0 (DM3 rows, no p/q) and Phase 1b (CLI rows merged with DM3's view
 * columns). These tests pin: DM3 rows get the CLI names and p/q from the library's `memeSitePq`
 * (the cmd_meme float32 cast order, so an LRT of 0 gives p = 2/3 as float32); CLI rows pass
 * through with the camelCase duplicates folded; the alignment block is reconstructed in tree
 * order minus dropped taxa when the runtime does not report it; an embedded tree is cut out of
 * the alignment text for the record's `tree`.
 */

import { describe, expect, it } from 'vitest';
import type { RuntimeMemeResult } from '@veg/hyphaeon-runtime';
import { alignmentBlock, toMemeRecord, toSiteRecords } from './record';
import { embeddedNewick } from './newick';

const ALIGNMENT = `>c
ATGAAACCC
>a
ATGAAACCT
>b
ATGAAGCCC
>d
ATGAAACCC
`;
const TREE = '((a:0.1,b:0.2):0.05,(c:0.1,d:0.1):0.05);';

function rawResult(sites: Array<Record<string, unknown>>, extra: Partial<RuntimeMemeResult> = {}): RuntimeMemeResult {
	return {
		schema_version: 1,
		method: 'meme',
		is_surrogate: true,
		surrogate_for: 'MEME',
		sites,
		summary: { totalSites: sites.length, variableSites: 2, speciesUsed: 4, speciesInAlignment: 4 },
		provenance: { surface: 'browser', preprocessing: { dropped_taxa: [] }, warnings: [] },
		...extra
	};
}

const CTX = {
	alignmentText: ALIGNMENT,
	treeText: TREE,
	treeSource: 'user' as const,
	options: { variant: 'general' as const, maxSpecies: 256, referenceSequence: 'a', callMode: 'percentile' as const, filter: false, attribute: false },
	name: 'test.fasta',
	createdAtIso: '2026-09-04T00:00:00.000Z'
};

describe('toSiteRecords', () => {
	it('renames DM3 rows and computes float32 p/q', () => {
		const rows = toSiteRecords([
			{ site: 1, refCodon: 'ATG', refAa: 'M', isVariable: false, lrt: 0, logLrt: 0, zScore: 0, percentile: 0, call: 'Neutral' },
			{ site: 2, refCodon: 'AAA', refAa: 'K', isVariable: true, lrt: 2.5, logLrt: Math.log1p(2.5), zScore: 1, percentile: 100, call: 'Top 2%' }
		]);
		expect(rows[0]).toMatchObject({ site: 1, hyphaeon_lrt: 0, is_invariable: true, ref_codon: 'ATG', ref_aa: 'M' });
		expect(rows[0].p_value).toBe(Math.fround(2 / 3));
		expect(rows[1].hyphaeon_lrt).toBe(Math.fround(2.5));
		expect(rows[1].p_value).toBeGreaterThan(0);
		expect(rows[1].p_value).toBeLessThan(2 / 3);
		expect(rows[1].q_value).toBeGreaterThanOrEqual(rows[1].p_value);
		expect(rows[1].call).toBe('Top 2%');
	});

	it('passes CLI rows through and folds the camelCase view columns', () => {
		const rows = toSiteRecords([
			{ site: 1, hyphaeon_lrt: 1.5, p_value: 0.2, q_value: 0.3, is_invariable: false, refCodon: 'AAA', refAa: 'K', lrt: 1.5, logLrt: 0.9, zScore: 0.4, percentile: 80, call: 'Neutral', isVariable: true }
		]);
		expect(rows[0]).toEqual({
			site: 1,
			hyphaeon_lrt: 1.5,
			p_value: 0.2,
			q_value: 0.3,
			is_invariable: false,
			ref_codon: 'AAA',
			ref_aa: 'K',
			log_lrt: 0.9,
			z_score: 0.4,
			percentile: 80,
			call: 'Neutral'
		});
		expect('refCodon' in rows[0]).toBe(false);
	});
});

describe('alignmentBlock', () => {
	it('reconstructs tree order minus dropped taxa', () => {
		const raw = rawResult([], { provenance: { surface: 'browser', preprocessing: { dropped_taxa: ['d'] }, warnings: [] } });
		const { block, reconstructed } = alignmentBlock(raw, ALIGNMENT, TREE);
		expect(reconstructed).toBe(true);
		expect(block?.names).toEqual(['a', 'b', 'c']);
		expect(block?.sequences[0]).toBe('ATGAAACCT');
	});

	it('uses the runtime block when reported', () => {
		const raw = rawResult([], { alignment: { names: ['b'], sequences: ['ATGAAGCCC'] } });
		expect(alignmentBlock(raw, ALIGNMENT, TREE)).toEqual({ block: { names: ['b'], sequences: ['ATGAAGCCC'] }, reconstructed: false });
	});
});

describe('toMemeRecord', () => {
	it('stamps the tree source, options and name', () => {
		const record = toMemeRecord(rawResult([{ site: 1, hyphaeon_lrt: 0, p_value: 2 / 3, q_value: 1, is_invariable: true }]), CTX);
		expect(record.method).toBe('meme');
		expect(record.name).toBe('test.fasta');
		expect(record.tree).toBe(TREE);
		expect(record.provenance.preprocessing.tree_source).toBe('user');
		expect(record.provenance.preprocessing.branch_lengths_estimated).toBe(false);
		expect(record.provenance.options).toMatchObject({ variant: 'general', callMode: 'percentile' });
		expect(record.alignment?.names).toEqual(['a', 'b', 'c', 'd']);
		expect(record.filter).toBeNull();
		expect(record.attributions).toBeNull();
	});

	it('marks an estimated tree and converts the attribution map', () => {
		const attributions = new Map([['2', { site_0indexed: 1, site_1indexed: 2 }]]);
		const record = toMemeRecord(rawResult([], { attributions }), { ...CTX, treeSource: 'nj' });
		expect(record.provenance.preprocessing.branch_lengths_estimated).toBe(true);
		expect(record.attributions).toEqual({ '2': { site_0indexed: 1, site_1indexed: 2 } });
	});

	it('cuts the embedded tree out of a NEXUS alignment', () => {
		const nexus = `#NEXUS
BEGIN DATA;
DIMENSIONS NTAX=3 NCHAR=3;
FORMAT DATATYPE=DNA;
MATRIX
a ATG
b ATG
c ATG
;
END;
BEGIN TREES;
	TREE t = ((a:0.1,b:0.1):0.1,c:0.2);
END;
`;
		expect(embeddedNewick(nexus)).toBe('((a:0.1,b:0.1):0.1,c:0.2);');
		const record = toMemeRecord(rawResult([]), { ...CTX, alignmentText: nexus, treeText: '', treeSource: 'embedded' });
		expect(record.tree).toBe('((a:0.1,b:0.1):0.1,c:0.2);');
	});
});
