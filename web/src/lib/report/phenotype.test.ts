/**
 * phenotype.test.ts — the pure decisions the phenotype section rests on.
 *
 * WHY THIS FILE EXISTS. The pillar itself is the library's and the runtime's, and both have their
 * own suites; what is app-side is where a run's inputs come from when a report has been through
 * IndexedDB or was prebaked (phenotype.svelte.ts), whether permulations may be offered at all,
 * which tree the report draws and what it is allowed to be called (displayTree.ts), and the two
 * files the section hands the reader (downloads.ts). Those are the things that would silently do
 * the wrong thing on a gallery record, which is exactly the record a visitor sees first.
 */

import { describe, expect, it } from 'vitest';
import type { ReportRecord } from '$lib/api';
import { traitToPhenotypeOptions } from '$lib/api';
import { emptySections, type PhenotypeSection } from './types';
import { displayTree } from './displayTree';
import { phenotypeCsvText, phenotypeJsonText, PHENOTYPE_CSV_COLUMNS } from './downloads';
import {
	fastaFromBlock,
	looksLikeGlob,
	permulationsAvailable,
	phenotypeBlockedReason,
	phenotypeInputs
} from './phenotype.svelte';

const TREE = '((a:0.1,b:0.2):0.3,c:0.4);';
const NJ = '((a:0.11,b:0.21):0.31,c:0.41);';

function report(over: Partial<ReportRecord> = {}, sitesOver: Record<string, unknown> = {}): ReportRecord {
	const sections = emptySections();
	sections.sites = {
		schema_version: 2,
		method: 'meme',
		is_surrogate: true,
		surrogate_for: 'MEME',
		sites: [],
		summary: { totalSites: 3, variableSites: 3, speciesUsed: 3, speciesInAlignment: 3 },
		provenance: { preprocessing: { tree_source: 'user' } },
		tree: TREE,
		alignment: { names: ['a', 'b', 'c'], sequences: ['ATGAAA', 'ATGAAC', 'ATGAAG'] },
		...sitesOver
	} as unknown as NonNullable<ReportRecord['sections']['sites']>;
	return {
		schema_version: 2,
		kind: 'report',
		id: 'r1',
		createdAt: 0,
		createdAtIso: '',
		name: 'x',
		inputs: {
			alignment: { name: 'x.fasta', size: 1, sha256: null },
			tree: null,
			treeSource: 'user',
			alignmentName: 'x.fasta',
			treeName: 'x.nwk'
		},
		options: {
			variant: 'general',
			maxSpecies: 256,
			referenceSequence: null,
			callMode: 'percentile',
			seed: 42,
			dms: { enabled: false, workBudget: 1 },
			permutations: 1000
		},
		diagnostics: null,
		sections,
		provenance: null,
		timings: {},
		status: { state: 'done', phase: null, done: 1, total: 1, message: null, completed: ['sites'] },
		...over
	};
}

describe('phenotypeInputs', () => {
	it('prefers the original texts a browser run kept for the re-run', () => {
		const r = report({
			inputs: { ...report().inputs, alignmentText: '>a\nATG\n>b\nATC\n', treeText: TREE }
		});
		const inputs = phenotypeInputs(r)!;
		expect(inputs.from).toBe('inputs');
		expect(inputs.alignmentText).toContain('>a');
		expect(inputs.treeText).toBe(TREE);
		expect(inputs.taxa).toEqual(['a', 'b', 'c']);
	});

	it('rebuilds the FASTA the model saw when the texts were stripped (a gallery record)', () => {
		const inputs = phenotypeInputs(report())!;
		expect(inputs.from).toBe('sites');
		expect(inputs.alignmentText).toBe('>a\nATGAAA\n>b\nATGAAC\n>c\nATGAAG\n');
		expect(inputs.treeText).toBe(TREE);
		expect(fastaFromBlock({ names: ['x'], sequences: ['ATG'] })).toBe('>x\nATG\n');
	});

	it('never hands the runtime a display tree as if the model had used it', () => {
		// A tree-free record stores the NJ display tree in the same place a tree-based one stores
		// the model's tree; passing it on would silently turn permulations back on over a topology
		// inferred from the association's own distances.
		const r = report({ inputs: { ...report().inputs, treeSource: 'tn93' } }, { tree: NJ });
		const inputs = phenotypeInputs(r)!;
		expect(inputs.treeText).toBe('');
		expect(permulationsAvailable(r)).toBe(false);
	});

	it('offers permulations only for a tree with branch lengths', () => {
		expect(permulationsAvailable(report())).toBe(true);
		expect(permulationsAvailable(report({}, { tree: null, display_tree: null }))).toBe(false);
	});

	it('says why a record cannot run the pillar', () => {
		const noSites = report();
		noSites.sections.sites = null;
		expect(phenotypeBlockedReason(noSites)).toMatch(/site-selection section/);
		expect(phenotypeBlockedReason(report({}, { alignment: null }))).toMatch(/neither the alignment/);
		expect(phenotypeBlockedReason(report())).toBeNull();
	});
});

describe('displayTree', () => {
	it('reports a supplied tree as the one the model was given', () => {
		const d = displayTree(report({}, { display_tree: { newick: TREE, source: 'user', from: 'tree-text', taxa: 3 } }));
		expect(d.newick).toBe(TREE);
		expect(d.source).toBe('user');
		expect(d.modelSawIt).toBe(true);
		expect(d.label).toMatch(/the one the model was given/);
	});

	it('labels a tree-free run’s tree as display only, whichever field carries it', () => {
		const r = report(
			{
				inputs: { ...report().inputs, treeSource: 'tn93' },
				provenance: { preprocessing: { tree_source: 'tn93', display_tree_source: 'nj' } } as never
			},
			{ display_tree: { newick: NJ, source: 'nj', from: 'tn93', taxa: 3 } }
		);
		const d = displayTree(r);
		expect(d.newick).toBe(NJ);
		expect(d.source).toBe('nj');
		expect(d.modelSawIt).toBe(false);
		expect(d.label).toMatch(/Display only, built from the TN93 distances/);
	});

	it('says so when there is no tree to draw', () => {
		const d = displayTree(report({}, { tree: null, display_tree: null }));
		expect(d.newick).toBeNull();
		expect(d.label).toMatch(/No tree is stored/);
	});
});

describe('traitToPhenotypeOptions', () => {
	it('sets exactly one of the library’s three sources', () => {
		expect(traitToPhenotypeOptions({ kind: 'preset', preset: 'marine' })).toEqual({ preset: 'marine', continuous: false });
		expect(traitToPhenotypeOptions({ kind: 'list', foreground: 'a,b' })).toEqual({ foreground: 'a,b', continuous: false });
		const csv = traitToPhenotypeOptions({ kind: 'csv', phenotypeCsv: 's,t\na,1\n', phenotypeFile: 't.tsv' });
		expect(csv).toMatchObject({ phenotypeCsv: 's,t\na,1\n', phenotypeFile: 't.tsv', speciesCol: null, traitCol: null });
	});

	it('flags a glob, which the reference reads as a regular expression', () => {
		expect(looksLikeGlob('pan*')).toBe(true);
		expect(looksLikeGlob('turTru,balMus')).toBe(false);
	});
});

describe('phenotype downloads', () => {
	const section = {
		alignment: 'x.fasta',
		tree: null,
		taxa_count: 3,
		codon_count: 2,
		phenotype_meta: { mode: 'discrete', foreground_count: 1, background_count: 2, description: 'Preset: marine' },
		spectral_energy: 0.5,
		norm_spectral_ratio: 0.25,
		max_assoc: 0.9,
		p_evd_length_adjusted: 1e-8,
		score_track_a: 8,
		score_track_b: 0.25,
		dual_track_composite: 0.8,
		compact_pars_signature: '[ D1A ]',
		permulations_count: 0,
		gene_p_value_perm: null,
		significant_sites_count: 1,
		coselection_pairs_count: 0,
		trait_sectors_count: 0,
		coselection_pairs: [],
		trait_sectors: [],
		sites: [
			{
				site: 2,
				ref_aa: 'D',
				derived_aa: 'A',
				hyphaeon_lrt: 3.5,
				p_lrt: 0.01,
				attribution_norm: 1.2,
				fg_mean_attn: 0.3,
				bg_mean_attn: 0.1,
				association_rho: 0.9,
				p_value: 0.001,
				q_value: 0.002,
				p_assoc: 0.004,
				p_assoc_parametric: 0.004,
				p_assoc_perm: null,
				score: 1.77,
				foreground_freq_pct: 100,
				background_freq_pct: 0
			}
		]
	} as unknown as PhenotypeSection;

	it('writes the site columns in the record’s own order, with an empty cell for a null', () => {
		const csv = phenotypeCsvText(section);
		const [header, row] = csv.trim().split('\n');
		expect(header).toBe(PHENOTYPE_CSV_COLUMNS.join(','));
		expect(header.startsWith('site,ref_aa,derived_aa,hyphaeon_lrt')).toBe(true);
		expect(row.split(',')[0]).toBe('2');
		// p_assoc_perm is null when no permulations ran: an empty cell, never "null".
		expect(row.split(',')[PHENOTYPE_CSV_COLUMNS.indexOf('p_assoc_perm')]).toBe('');
	});

	it('writes the record as the CLI prints it', () => {
		const doc = JSON.parse(phenotypeJsonText(section));
		expect(Object.keys(doc).slice(0, 5)).toEqual(['alignment', 'tree', 'taxa_count', 'codon_count', 'phenotype_meta']);
		expect(doc.compact_pars_signature).toBe('[ D1A ]');
	});
});
