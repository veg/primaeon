import { describe, expect, it } from 'vitest';
import { callModeOptions, deriveRows, referenceCodons } from './derive';
import { normaliseRecord } from './load';
import { mcpToolArguments } from './mcpSnippet';
import { cliDocument, cliSite } from './downloads';
import type { MemeRecord } from './types';

/** A bare `hyphaeon meme` document, as the CLI writes it, with a chronogram tree name. */
function cliDoc() {
	return {
		alignment: 'toy.fasta',
		tree: 'toy.nwk',
		taxa_count: 3,
		codon_count: 4,
		runtime_sec: 0.5,
		filter_enabled: false,
		artifacts_masked: [],
		attribution_enabled: false,
		attributions: {},
		sites: [
			{ site: 1, hyphaeon_lrt: 0, p_value: 2 / 3, q_value: 2 / 3, is_invariable: true },
			{ site: 2, hyphaeon_lrt: 4.0, p_value: 0.03, q_value: 0.09, is_invariable: false },
			{ site: 3, hyphaeon_lrt: 1.0, p_value: 0.4, q_value: 0.6, is_invariable: false },
			{ site: 4, hyphaeon_lrt: 0.2, p_value: 0.6, q_value: 0.6, is_invariable: false }
		]
	};
}

describe('normaliseRecord', () => {
	it('gives a bare CLI document python-reference provenance and keeps the CLI names', () => {
		const r = normaliseRecord(cliDoc(), { id: 'gallery/toy', name: 'toy' });
		expect(r.provenance.surface).toBe('python-reference');
		expect(r.provenance.preprocessing.taxa_used).toBe(3);
		expect(r.summary.variableSites).toBe(3);
		expect(r.tree).toBeNull();
		expect(r.cli?.tree).toBe('toy.nwk');
		expect(r.filter).toBeNull();
		expect(cliDocument(r).tree).toBe('toy.nwk');
	});

	it('unwraps a stored envelope and keeps the Newick as the tree', () => {
		const inner = { ...cliDoc(), tree: '((a:1,b:1):1,c:1);', provenance: { surface: 'browser' } };
		const r = normaliseRecord(
			{ result: inner, name: 'x.fasta', createdAt: '2026-09-04T00:00:00Z' },
			{ id: 'abc', name: 'x.fasta' }
		);
		expect(r.name).toBe('x.fasta');
		expect(r.provenance.surface).toBe('browser');
		expect(r.cli?.tree).toBeUndefined();
	});
});

describe('deriveRows', () => {
	const record: MemeRecord = normaliseRecord(cliDoc(), {
		alignment: { names: ['a', 'b', 'c'], sequences: ['ATGAAAGGGTTT', 'ATGAAGGGGTTC', 'ATGCCCGGGTTT'] }
	});

	it('slices reference codons from the alignment when the sites carry none', () => {
		expect(referenceCodons(record)).toEqual(['ATG', 'AAA', 'GGG', 'TTT']);
	});

	it('marks invariable sites not scored and computes local statistics over variable sites', () => {
		const rows = deriveRows(record, 'percentile');
		expect(rows[0].isVariable).toBe(false);
		expect(rows[0].call).toBe('Neutral');
		expect(rows[1].refAa).toBe('K');
		expect(rows[1].percentile).toBe(100);
		expect(rows[1].tier).toBe(1);
		expect(rows[1].call).toBe('Top 2%');
		expect(rows[3].zScore).toBeLessThan(0);
	});

	it('calls by q in qvalue mode', () => {
		const rows = deriveRows(record, 'qvalue');
		expect(rows[1].call).toBe('q ≤ 0.10');
		expect(rows[1].tier).toBe(2);
		expect(rows[2].tier).toBe(0);
	});

	it('offers the three modes when the record declares none', () => {
		expect(callModeOptions(record).map((m) => m.id)).toEqual(['percentile', 'qvalue', 'zscore']);
	});
});

describe('mcpToolArguments', () => {
	it('maps browser option names to the tool schema and drops display-only ones', () => {
		const r = normaliseRecord(cliDoc(), {
			name: 'toy.fasta',
			provenance: {
				...normaliseRecord(cliDoc()).provenance,
				model_variant: 'viral',
				options: { maxSpecies: 128, callMode: 'percentile', alignmentName: 'toy.fasta', pruneDuplicates: false },
				preprocessing: { ...normaliseRecord(cliDoc()).provenance.preprocessing, tree_source: 'tn93' }
			}
		});
		const args = mcpToolArguments(r);
		expect(args).toMatchObject({ model_variant: 'viral', max_species: 128, no_prune_duplicates: true, use_tn93: true });
		expect(args).not.toHaveProperty('call_mode');
		expect(args).not.toHaveProperty('alignment_name');
		expect(args).not.toHaveProperty('tree');
	});
});

describe('cliSite', () => {
	it('drops the view columns', () => {
		expect(Object.keys(cliSite({ site: 1, hyphaeon_lrt: 1, p_value: 0.1, q_value: 0.2, is_invariable: false, refCodon: 'ATG', z_score: 1 }))).toEqual([
			'site',
			'hyphaeon_lrt',
			'p_value',
			'q_value',
			'is_invariable'
		]);
	});
});
