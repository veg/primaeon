/**
 * predict.test.js — the session-backed predict callback and the variable-site loop, over a fake
 * session: the reference's batch ladder (inference.py:59-100), tokens converted to int64 with
 * the phylo tensors repeated per element, `lrt` fetched alone, the clamp and float32 store of
 * inference.py:186, zero rows at unscored sites, and the fetch-list intersection with what the
 * graph declares.
 */
import { describe, it, expect } from 'vitest';
import { loadAlignmentAndTree } from '@veg/hyphaeon-js';

import { adaptiveBatchSize, resolveBatchSize, bundleFromTokens, predictFromSession, inferSites } from '../src/predict.js';
import { fetchesFor, runSites } from '../src/feeds.js';

const ort = {
	Tensor: class {
		constructor(type, data, dims) {
			this.type = type;
			this.data = data;
			this.dims = dims;
		}
	}
};

function fakeHandle(outputNames = ['lrt', 'mean_root_attns', 'root_repr'], lrtFor = () => -1.5) {
	const calls = [];
	const session = {
		outputNames,
		run: async (feeds, fetches) => {
			calls.push({ feeds, fetches });
			const b = feeds.msa_codons.dims[0];
			const n = feeds.msa_codons.dims[1];
			const out = { lrt: { data: Float32Array.from({ length: b }, (_, k) => lrtFor(k, feeds)) } };
			if (!fetches || fetches.includes('mean_root_attns')) out.mean_root_attns = { data: new Float32Array(b * n).fill(1) };
			if (!fetches || fetches.includes('root_repr')) out.root_repr = { data: new Float32Array(b * 384).fill(2) };
			return out;
		}
	};
	return { handle: { session, ort, outputNames }, calls };
}

const ALIGNMENT = '>a\nATGAAAATG\n>b\nATGTTTATG\n>c\nATGGGGATG\n>d\nATGCCCATG\n';
const TREE = '((a:0.1,b:0.2):0.05,(c:0.3,d:0.4):0.05);';

describe('batch sizing', () => {
	it('follows inference.py\'s ladder at the 1e9 budget', () => {
		expect(adaptiveBatchSize(18)).toBe(256);
		expect(adaptiveBatchSize(99)).toBe(256);
		expect(adaptiveBatchSize(100)).toBe(128);
		expect(adaptiveBatchSize(250)).toBe(76);
		expect(adaptiveBatchSize(400)).toBe(57);
		expect(adaptiveBatchSize(600)).toBe(38);
		// budget / (48 N^2) binds before the cap for very large N.
		expect(adaptiveBatchSize(1000)).toBe(20);
		expect(resolveBatchSize(18, { batchSize: 7 })).toBe(7);
		expect(resolveBatchSize(18, { batchBudgetBytes: 4 * 18 * 18 * 3 })).toBe(3);
		expect(resolveBatchSize(18)).toBe(256);
	});
});

describe('bundleFromTokens', () => {
	it('converts [b, N, 1] Int32 tokens to int64 and repeats d and z per element', () => {
		const c = Int32Array.from([1, 2, 3, 4, 5, 6]);
		const a = Int32Array.from([0, 1, 2, 3, 4, 5]);
		const d = Float32Array.from([0, 1, 2, 1, 0, 3, 2, 3, 0]);
		const z = Float32Array.from({ length: 12 }, (_, i) => i);
		const bundle = bundleFromTokens(c, a, { batch: 2, N: 3, d, z });
		expect(bundle.msa_codons.dims).toEqual([2, 3, 1]);
		expect(Array.from(bundle.msa_codons.data, Number)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(bundle.msa_codons.data).toBeInstanceOf(BigInt64Array);
		expect(bundle.dist_matrix.dims).toEqual([2, 3, 3]);
		expect(Array.from(bundle.dist_matrix.data.subarray(9, 18))).toEqual(Array.from(d));
		expect(bundle.mds_coords.dims).toEqual([2, 3, 4]);
		expect(bundle.mds_coords.data[12 + 5]).toBe(5);
	});
});

describe('fetchesFor / runSites', () => {
	it('intersects the request with what the graph declares, lrt first', () => {
		expect(fetchesFor({ outputNames: ['lrt'] }, ['lrt', 'root_repr'])).toEqual(['lrt']);
		expect(fetchesFor({ outputNames: ['lrt', 'mean_root_attns', 'root_repr'] }, ['root_repr', 'lrt'])).toEqual(['lrt', 'root_repr']);
		expect(fetchesFor({}, ['root_repr'])).toEqual(['lrt', 'root_repr']);
	});

	it('passes the fetch list to session.run and reads back only what was asked', async () => {
		const { handle, calls } = fakeHandle();
		const bundle = bundleFromTokens(new Int32Array(3), new Int32Array(3), { batch: 1, N: 3, d: new Float32Array(9), z: new Float32Array(12) });
		const out = await runSites(handle.session, bundle, ort, ['lrt']);
		expect(calls[0].fetches).toEqual(['lrt']);
		expect(Object.keys(out)).toEqual(['lrt']);
		const out2 = await runSites(handle.session, bundle, ort, ['lrt', 'root_repr']);
		expect(calls[1].fetches).toEqual(['lrt', 'root_repr']);
		expect(Object.keys(out2).sort()).toEqual(['lrt', 'root_repr']);
	});
});

describe('predictFromSession', () => {
	it('returns the raw graph lrt for the library to clamp, fetching lrt alone', async () => {
		const { handle, calls } = fakeHandle();
		const predict = predictFromSession(handle);
		const y = await predict(new Int32Array(8), new Int32Array(8), { batch: 2, N: 4, d: new Float32Array(16), z: new Float32Array(16) });
		expect(Array.from(y)).toEqual([-1.5, -1.5]);
		expect(calls[0].fetches).toEqual(['lrt']);
		expect(calls[0].feeds.msa_codons.type).toBe('int64');
		expect(calls[0].feeds.dist_matrix.dims).toEqual([2, 4, 4]);
	});

	it('refuses a handle that is not a loadSession result', () => {
		expect(() => predictFromSession({})).toThrow(/loadSession/);
	});
});

describe('inferSites', () => {
	it('scores the variable sites only, clamps at 0, stores float32, and zero-fills the rest', async () => {
		const loaded = loadAlignmentAndTree(ALIGNMENT, TREE, { maxSpecies: null });
		expect(Array.from(loaded.invariable)).toEqual([1, 0, 1]);
		const { handle, calls } = fakeHandle(['lrt', 'mean_root_attns', 'root_repr'], (k) => (k === 0 ? 2.000000001 : -3));
		const ticks = [];
		const out = await inferSites(loaded, handle, { outputs: ['lrt', 'root_repr'], onProgress: (d, t) => ticks.push([d, t]) });
		expect(Array.from(out.siteIndices)).toEqual([1]);
		expect(calls).toHaveLength(1);
		expect(calls[0].feeds.msa_codons.dims).toEqual([1, 4, 1]);
		expect(calls[0].fetches).toEqual(['lrt', 'root_repr']);
		expect(out.lrt).toBeInstanceOf(Float32Array);
		expect(Array.from(out.lrt)).toEqual([0, Math.fround(2.000000001), 0]);
		expect(out.mean_root_attns).toBeNull();
		expect(out.root_repr.dims).toEqual([3, 384]);
		expect(out.root_repr.data[0]).toBe(0);
		expect(out.root_repr.data[384]).toBe(2);
		expect(out.root_repr.data[2 * 384]).toBe(0);
		expect(ticks).toEqual([[0, 1], [1, 1]]);
	});

	it('clamps negatives to 0 and honours explicit site indices and an abort signal', async () => {
		const loaded = loadAlignmentAndTree(ALIGNMENT, TREE, { maxSpecies: null });
		const { handle } = fakeHandle(['lrt']);
		const out = await inferSites(loaded, handle, { siteIndices: [0, 2] });
		expect(Array.from(out.lrt)).toEqual([0, 0, 0]);
		expect(Array.from(out.siteIndices)).toEqual([0, 2]);
		const controller = new AbortController();
		controller.abort();
		await expect(inferSites(loaded, handle, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
	});
});
