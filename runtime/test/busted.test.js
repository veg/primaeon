/**
 * busted.test.js — runBusted's orchestration over FAKE sessions: the backbone is asked for
 * `lrt` + `root_repr` on the variable sites only, `hidden_all` reaches the head as [1, L, 384]
 * with zero rows at invariable sites and an ALL-FALSE bool mask (PHASE1A.md item 4), the record
 * carries cmd_busted's keys in order, and the provenance flags the head as nondeterministic
 * upstream. The real graph + head against fixtures/e2e/busted_Smc6.json is in
 * parity-fixtures.test.js.
 */
import { describe, it, expect } from 'vitest';

import { runBusted } from '../src/busted.js';
import { buildBustedHeadFeeds } from '../src/feeds.js';

const CODONS = { a: 'ATG', b: 'TTT', c: 'GGG', d: 'CCC' };
const ALIGNMENT =
	Object.entries(CODONS)
		.map(([name, codon]) => `>${name}\n${codon.repeat(6)}ATG`)
		.join('\n') + '\n';
const TREE = '((a:0.1,b:0.2):0.05,(c:0.3,d:0.4):0.05);';

const ort = {
	Tensor: class {
		constructor(type, data, dims) {
			this.type = type;
			this.data = data;
			this.dims = dims;
		}
	}
};

function fakeBackbone(outputNames = ['lrt', 'mean_root_attns', 'root_repr']) {
	const calls = [];
	const session = {
		inputNames: ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'],
		outputNames,
		run: async (feeds, fetches) => {
			const b = feeds.msa_codons.dims[0];
			calls.push({ b, fetches });
			const lrt = new Float32Array(b);
			const repr = new Float32Array(b * 384);
			for (let k = 0; k < b; k++) {
				// Sites alternate above / below the 3.841 threshold: 5, 1, 5, 1, ...
				lrt[k] = (calls.length + k) % 2 === 0 ? 1 : 5;
				repr[k * 384] = 7;
			}
			const out = { lrt: { data: lrt } };
			if (outputNames.includes('root_repr') && (!fetches || fetches.includes('root_repr'))) out.root_repr = { data: repr };
			return out;
		}
	};
	return { handle: { session, ort, sha256: 'ab'.repeat(32), verified: true, outputNames, variant: 'fake', modelVersion: 'v0' }, calls };
}

function fakeHead() {
	const calls = [];
	const session = {
		inputNames: ['root_repr', 'mask'],
		outputNames: ['cls_prob', 'pred_gene_lrt', 'omega_prop', 'syn_var', 'pred_omega3', 'pred_logp'],
		run: async (feeds) => {
			calls.push(feeds);
			return {
				cls_prob: { data: new Float32Array([0.75]) },
				pred_gene_lrt: { data: new Float32Array([2.5]) },
				omega_prop: { data: new Float32Array([0.2, 0.5, 0.3]) },
				syn_var: { data: new Float32Array([0.1]) },
				pred_omega3: { data: new Float32Array([3.0]) },
				pred_logp: { data: new Float32Array([-1]) }
			};
		}
	};
	return { handle: { session, ort, sha256: 'ef'.repeat(32), verified: true, kind: 'busted_head', exportSeed: 0 }, calls };
}

describe('runBusted over fake sessions', () => {
	it('scores variable sites only with lrt + root_repr, feeds the head [1, L, 384] with an all-false mask', async () => {
		const backbone = fakeBackbone();
		const head = fakeHead();
		const phases = [];
		const result = await runBusted({
			alignmentText: ALIGNMENT,
			treeText: TREE,
			options: { batchSize: 4, alignmentName: 'toy.fasta' },
			session: backbone.handle,
			head: head.handle,
			surface: 'mcp-stdio',
			progress: (p) => phases.push(p)
		});
		expect([...new Set(phases)]).toEqual(['parse', 'prepare', 'infer', 'postprocess']);
		// Six variable sites in batches of 4 -> [4, 2]; both outputs fetched.
		expect(backbone.calls.map((c) => c.b)).toEqual([4, 2]);
		for (const c of backbone.calls) expect(c.fetches).toEqual(['lrt', 'root_repr']);

		// The head saw hidden_all [1, 7, 384]: row 7 (invariable) zero, others 7; mask all false.
		expect(head.calls).toHaveLength(1);
		const feeds = head.calls[0];
		expect(feeds.root_repr.type).toBe('float32');
		expect(feeds.root_repr.dims).toEqual([1, 7, 384]);
		expect(feeds.root_repr.data[6 * 384]).toBe(0);
		expect(feeds.root_repr.data[0]).toBe(7);
		expect(feeds.mask.type).toBe('bool');
		expect(feeds.mask.dims).toEqual([1, 7]);
		expect(Array.from(feeds.mask.data)).toEqual([0, 0, 0, 0, 0, 0, 0]);

		const r = result.record;
		expect(Object.keys(r)).toEqual([
			'alignment', 'gene', 'taxa', 'sites', 'p_value_acat', 'p_value_simes', 'omnibus_lrt',
			'predicted_gene_lrt', 'selection_probability', 'synonymous_rate_variation',
			'total_selection_energy', 'sig_sites_p05', 'sig_sites_p10', 'rate_distributions',
			'positive_selection_detected', 'elapsed_seconds'
		]);
		expect(r.alignment).toBe('toy.fasta');
		expect(r.gene).toBe('toy');
		expect(r.taxa).toBe(4);
		expect(r.sites).toBe(7);
		expect(r.selection_probability).toBeCloseTo(0.75, 6);
		expect(r.predicted_gene_lrt).toBeCloseTo(2.5, 6);
		expect(r.synonymous_rate_variation).toBeCloseTo(0.1, 6);
		expect(r.rate_distributions).toMatchObject({ omega_1: 0.1, omega_2: 1.0 });
		expect(r.rate_distributions.omega_3).toBeCloseTo(3.0, 6);
		expect(r.rate_distributions.proportion_2).toBeCloseTo(0.5, 6);
		expect(r.positive_selection_detected).toBe(true);
		expect(r.elapsed_seconds).toBeGreaterThan(0);
		// Three sites at 5, three at 1, one at 0: energy 18, omnibus 3 * (5 - 3.841).
		expect(r.total_selection_energy).toBeCloseTo(18, 5);
		expect(r.omnibus_lrt).toBeCloseTo(3 * (5 - 3.841), 5);
		expect(result.sites).toHaveLength(7);
		expect(result.sites[6]).toMatchObject({ site: 7, hyphaeon_lrt: 0, p_value: 1, is_invariable: true });
		expect(result.root_repr.dims).toEqual([7, 384]);

		expect(result.method).toBe('busted');
		expect(result.surrogate_for).toBe('BUSTED');
		expect(result.provenance).toMatchObject({
			surface: 'mcp-stdio',
			artifact_sha256: 'ab'.repeat(32),
			busted_head_sha256: 'ef'.repeat(32),
			surrogate_for: 'BUSTED',
			inputs: { alignment: 'toy.fasta', tree: null }
		});
		expect(result.provenance.neural_head).toMatchObject({ enabled: true, deterministic_upstream: false, export_seed: 0 });
		expect(result.provenance.preprocessing.taxon_cap).toBe(512);
	});

	it('runs statistics only without a head: neural fields null, verdict from ACAT alone, lrt fetched alone', async () => {
		const backbone = fakeBackbone();
		const result = await runBusted({ alignmentText: ALIGNMENT, treeText: TREE, session: backbone.handle });
		for (const c of backbone.calls) expect(c.fetches).toEqual(['lrt']);
		const r = result.record;
		expect(r.selection_probability).toBeNull();
		expect(r.predicted_gene_lrt).toBeNull();
		expect(r.synonymous_rate_variation).toBeNull();
		expect(r.rate_distributions.proportion_1).toBeNull();
		expect(r.rate_distributions.omega_3).toBeNull();
		expect([true, null]).toContain(r.positive_selection_detected);
		expect(result.provenance.neural_head.enabled).toBe(false);
		expect(result.provenance.busted_head_sha256).toBeUndefined();
	});

	it('skips the head with a warning when the backbone has no root_repr output', async () => {
		const backbone = fakeBackbone(['lrt']);
		const head = fakeHead();
		const result = await runBusted({ alignmentText: ALIGNMENT, treeText: TREE, session: backbone.handle, head: head.handle });
		expect(head.calls).toHaveLength(0);
		expect(result.provenance.warnings.map((w) => w.code)).toContain('BUSTED_HEAD_SKIPPED');
		expect(result.record.selection_probability).toBeNull();
	});

	it('refuses a non-zero mask at the feed boundary', () => {
		const input = { root_repr: new Float32Array(2 * 384), mask: new Uint8Array([0, 1]), dims: [1, 2, 384] };
		expect(() => buildBustedHeadFeeds(input, ort)).toThrow(/all false/);
		const ok = buildBustedHeadFeeds({ root_repr: new Float32Array(2 * 384), dims: [1, 2, 384] }, ort);
		expect(ok.mask.type).toBe('bool');
		expect(ok.mask.data).toBeInstanceOf(Uint8Array);
	});

	it('validates its arguments', async () => {
		const backbone = fakeBackbone();
		await expect(runBusted({ alignmentText: ALIGNMENT, treeText: TREE })).rejects.toThrow(/loadSession/);
		await expect(runBusted({ alignmentText: ALIGNMENT, treeText: TREE, session: backbone.handle, head: {} })).rejects.toThrow(/loadBustedHead/);
		await expect(runBusted({ alignmentText: ALIGNMENT, treeText: TREE, session: backbone.handle, options: { neuralHead: true } })).rejects.toThrow(/no `head`/);
		await expect(runBusted({ alignmentText: ALIGNMENT, treeText: TREE, session: backbone.handle, surface: 'x' })).rejects.toThrow(/unknown surface/);
	});
});
