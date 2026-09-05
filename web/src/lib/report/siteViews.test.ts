/**
 * siteViews.test.ts — what the site-tree modal, the entropy overlays and the phenotype panel are
 * given for each kind of record: the alignment block derived from a browser run's stored text
 * (alignmentBlock.ts) and the display tree with its caption (displayTree.ts).
 *
 * WHY THIS FILE EXISTS. PHASE3.md gap 6: a report the reader just ran could not draw its site
 * tree because the block the modal reads was only ever written by the gallery prebake and the
 * server. The fix derives it from `inputs.alignmentText`, which every browser record keeps; these
 * cases pin that a live record, a prebaked record and a pre-Phase-2 record each resolve the way
 * the views expect, and that a topology-only upload is drawn as the reader's own topology
 * (`user-topology`, PLAN.md D6) with the caption the runtime writes, while a Phase 3 record that
 * drew NJ keeps saying NJ.
 */

import { describe, expect, it } from 'vitest';
import type { ReportRecord } from '$lib/api';
import { alignmentBlockFor, alignmentBlockFromText, sitesWithAlignment } from './alignmentBlock';
import { displayTree, USER_TOPOLOGY_LABEL } from './displayTree';
import { phenotypeInputs } from './phenotype.svelte';
import { emptySections } from './types';

const FASTA = '>a\nATGAAACCC\n>b\nATGAAGCCC\n>c\nATGAAACCT\n>d\nATGAGACCC\n';

function record(overrides: Partial<ReportRecord> = {}, pre: Record<string, unknown> = {}): ReportRecord {
	const sections = emptySections();
	sections.sites = {
		schema_version: 1,
		method: 'meme',
		is_surrogate: true,
		surrogate_for: 'MEME',
		sites: [1, 2, 3].map((site) => ({ site, hyphaeon_lrt: 0, p_value: 1, q_value: 1, is_invariable: false })),
		summary: { totalSites: 3, variableSites: 3, speciesUsed: 3, speciesInAlignment: 4 },
		provenance: {
			schema_version: 1,
			surface: 'browser',
			hyphaeon_js_version: null,
			reference_version: null,
			model_version: 'v1',
			model_variant: 'general',
			artifact_sha256: null,
			is_surrogate: true,
			surrogate_for: 'MEME',
			seed: null,
			elapsed_sec: 0,
			options: {},
			preprocessing: { taxa_in_alignment: 4, taxa_used: 3, dropped_taxa: ['d'], tree_source: 'tn93', ...pre } as never,
			warnings: []
		}
	};
	return {
		schema_version: 2,
		kind: 'report',
		id: 'r',
		createdAt: 0,
		createdAtIso: '',
		name: 'x',
		inputs: { alignment: { name: 'a.fasta', size: FASTA.length, sha256: null }, tree: null, treeSource: 'tn93', alignmentName: 'a.fasta', treeName: null, alignmentText: FASTA, treeText: null },
		options: { variant: 'general', maxSpecies: 256, referenceSequence: null, callMode: 'percentile', seed: 42, dms: { enabled: true, workBudget: 2.5e9 }, permutations: 1000 },
		diagnostics: null,
		sections,
		provenance: null,
		timings: {},
		status: { state: 'done', phase: null, done: 1, total: 1, message: null, completed: ['sites'] },
		...overrides
	};
}

describe('alignmentBlockFor', () => {
	it('derives the block from a browser run’s stored text, minus the taxa the runtime dropped, in alignment order', () => {
		const r = record();
		const block = alignmentBlockFor(r)!;
		expect(block.names).toEqual(['a', 'b', 'c']);
		expect(block.sequences).toEqual(['ATGAAACCC', 'ATGAAGCCC', 'ATGAAACCT']);
		// The same object the prebake would have written, so the views cannot tell the two apart.
		expect(sitesWithAlignment(r)!.alignment).toEqual(block);
		// The phenotype panel gets the same taxon list (it used to get [] on a live record).
		expect(phenotypeInputs(r)!.taxa).toEqual(['a', 'b', 'c']);
		expect(phenotypeInputs(r)!.from).toBe('inputs');
	});
	it('prefers a stored block (gallery, server) and keeps the section identity when one is there', () => {
		const r = record();
		r.sections.sites!.alignment = { names: ['b', 'c'], sequences: ['ATGAAGCCC', 'ATGAAACCT'] };
		expect(alignmentBlockFor(r)!.names).toEqual(['b', 'c']);
		expect(sitesWithAlignment(r)).toBe(r.sections.sites);
	});
	it('reads dropped_taxa from the record’s own provenance first', () => {
		const r = record();
		r.provenance = { ...r.sections.sites!.provenance, preprocessing: { ...r.sections.sites!.provenance.preprocessing, dropped_taxa: ['a', 'b'] } } as ReportRecord['provenance'];
		expect(alignmentBlockFor(r)!.names).toEqual(['c', 'd']);
	});
	it('is null for a record without text or block (pre-Phase-2, or a bare CLI document), and never throws', () => {
		const r = record({ inputs: { alignment: { name: 'a', size: 0, sha256: null }, tree: null, treeSource: 'user', alignmentName: 'a', treeName: null } });
		expect(alignmentBlockFor(r)).toBeNull();
		expect(sitesWithAlignment(r)).toBe(r.sections.sites);
		expect(alignmentBlockFromText('', [])).toBeNull();
		expect(alignmentBlockFromText('not fasta at all', [])).toBeNull();
		expect(alignmentBlockFromText(FASTA, ['a', 'b', 'c', 'd'])).toBeNull();
		expect(sitesWithAlignment(record({ sections: emptySections() }))).toBeNull();
	});
});

describe('displayTree', () => {
	const sitesWith = (r: ReportRecord, display_tree: unknown) => {
		(r.sections.sites as unknown as { display_tree: unknown }).display_tree = display_tree;
		return r;
	};
	it('draws the reader’s own topology when the runtime kept it, with the runtime’s caption', () => {
		const r = sitesWith(record({}, { display_tree_source: 'user-topology', tree_provided: 'user', tree_free: { reason: 'no_branch_lengths' } }), {
			newick: '((a:1,b:1):1,c:1);',
			source: 'user-topology',
			from: 'tree-text',
			taxa: 3,
			prunedTips: 1,
			label: USER_TOPOLOGY_LABEL
		});
		const t = displayTree(r);
		expect(t.source).toBe('user-topology');
		expect(t.newick).toBe('((a:1,b:1):1,c:1);');
		expect(t.modelSawIt).toBe(false);
		expect(t.label).toContain(USER_TOPOLOGY_LABEL);
		expect(t.label).toMatch(/^Display only/);
		expect(t.label).toMatch(/unit branch lengths .* convention, not a fit/);
	});
	it('falls back to its own copy of the caption for a runtime that wrote none', () => {
		const r = sitesWith(record({}, { display_tree_source: 'user-topology' }), { newick: '(a:1,b:1);', source: 'user-topology', from: 'alignment', taxa: 2 });
		expect(displayTree(r).label).toContain(USER_TOPOLOGY_LABEL);
	});
	it('keeps saying NJ for a Phase 3 record of a topology-only upload that drew NJ', () => {
		const r = sitesWith(record({}, { display_tree_source: 'nj', tree_provided: 'user' }), { newick: '((a:0.1,b:0.2):0.1,c:0.3);', source: 'nj', from: 'tn93', taxa: 3 });
		const t = displayTree(r);
		expect(t.source).toBe('nj');
		expect(t.modelSawIt).toBe(false);
		expect(t.label).toMatch(/built from the TN93 distances/);
	});
	it('reports the model’s own tree for a tree run and nothing for a record with no tree', () => {
		const r = record({ inputs: { alignment: { name: 'a', size: 0, sha256: null }, tree: null, treeSource: 'user', alignmentName: 'a', treeName: null, treeText: '((a:0.1,b:0.2):0.1,c:0.3);' } }, { tree_source: 'user' });
		const t = displayTree(r);
		expect(t.source).toBe('user');
		expect(t.modelSawIt).toBe(true);
		expect(t.label).toMatch(/the one the model was given/);
		const none = record({}, { tree_source: 'tn93' });
		expect(displayTree(none).newick).toBeNull();
		expect(displayTree(none).label).toMatch(/No tree is stored/);
	});
});
