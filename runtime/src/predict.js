/**
 * predict.js — the graph, seen the way the library wants to see it.
 *
 * WHY THIS FILE EXISTS. `@veg/hyphaeon-js` is a library of pure functions: everything that needs
 * the network (`predictSiteLrts`, `runAlignmentFilter`, `attributeSelection`, `runBusted`) takes an
 * async `predict(c, a, meta)` callback and applies the reference's clamp and float32 storage to
 * what it returns (js/src/README.md, "Pure functions plus a predict callback"). This module is
 * the runtime's side of that contract: it turns a loaded onnxruntime session (session-web.js or
 * session-node.js) into that callback, and it carries the one inference loop `runMeme` and
 * `runBusted` share.
 *
 * WHAT IT MIRRORS. `hyphaeon/inference.py:162-192` `predict_site_lrts` (veg/HyphAeon phase-1a):
 *
 *     lrts = np.zeros(L, dtype=np.float32)
 *     var_idx = np.where(~inv)[0]                 # invariable sites are never sent to the model
 *     for s in range(0, num_variable, batch_size):
 *         idx = var_idx[s:end]
 *         y, _ = model.forward_cached(c[idx], a[idx], tree_cache)
 *         lrts[idx] = torch.clamp(y.squeeze(-1), min=0.0)
 *
 * `inferSites` is that loop with the site index list, the clamp and the float32 store, plus the
 * optional heads the three-output export adds (`mean_root_attns` [b, N], `root_repr` [b, 384];
 * PLAN.md §3.4), which cmd_busted (cli.py:439-447) gathers the same way for `root_repr`. Rows
 * for sites that were not scored stay zero, as `hidden_all` does at invariable sites.
 *
 * BATCH SIZE. The reference sizes batches by device memory (`compute_adaptive_safe_batch_size`,
 * inference.py:59-100: budget / (48 · N²) bytes, capped at 256/512 for N < 100, 128/256 for
 * N < 250, 76/152/256 for N < 400, 57/114/228 for N < 600, 38/76/152 above). Batch composition
 * changes nothing but float noise — every site is independent in the graph — so this takes the
 * SMALLEST of the reference's ladders (the ≤ 3 GB budget column, 1.0e9 bytes for the memory
 * term, which is what `get_device_memory_budget` returns on a CPU with < 10 GB) so that a
 * browser tab and a shared Node box stay inside their memory and progress ticks often enough to
 * be worth reporting. `batchSizeFor` (the library's 64 MB tensor budget) is applied on top,
 * because the materialised `dist_matrix` [b, N, N] is the runtime's own cost, not the model's.
 *
 * TOKENS. The library hands the callback Int32Array tokens in [batch, N, 1] layout and the
 * per-alignment `d` [N*N] / `z` [N*4]; the graph takes int64 tokens and the phylo tensors
 * repeated per batch element (the export materialises what torch broadcast). `bundleFromTokens`
 * does that conversion once, here, for every caller.
 */

import { batchSizeFor, gatherSiteBatch, MDS_COMPONENTS } from '@veg/hyphaeon-js';

import { runSites } from './feeds.js';

/**
 * inference.py:59-100 for the ≤ 3 GB budget column with a 1.0e9-byte memory term. See header.
 * @param {number} numTaxa
 * @returns {number}
 */
export function adaptiveBatchSize(numTaxa) {
	const budgetBytes = 1.0e9;
	const safeMax = Math.max(1, Math.floor(budgetBytes / (48.0 * Math.max(1, numTaxa) ** 2)));
	let cap;
	if (numTaxa >= 600) cap = 38;
	else if (numTaxa >= 400) cap = 57;
	else if (numTaxa >= 250) cap = 76;
	else if (numTaxa >= 100) cap = 128;
	else cap = 256;
	return Math.max(1, Math.min(cap, safeMax));
}

/**
 * What ONE SITE in a batch actually costs at inference, in bytes per taxon PAIR, measured on this
 * graph under onnxruntime-node — not what the reference predicts.
 *
 * WHY THIS CONSTANT EXISTS. `adaptiveBatchSize` mirrors inference.py, which models a site as
 * 48 bytes per pair (48 * N^2) against a 1.0e9-byte budget. That is torch's own accounting of the
 * tensors it allocates; it does not describe onnxruntime's arena, which holds the axial-attention
 * intermediates for the whole batch. Peak RSS of one `runMeme` pass over RHO (655 taxa, 349
 * codons, general.onnx, 4 intra-op threads, darwin/x64 Node 22), sampled every 100 ms:
 *
 *     batchSize 4    1.62 GB     11.2 s      -> 0.40 GB per site  ->  ~930 bytes per pair
 *     batchSize 16   5.75 GB     11.6 s      -> 0.36 GB per site  ->  ~840 bytes per pair
 *     default (38)  13.63 GB     12.5 s      -> 0.36 GB per site  ->  ~830 bytes per pair
 *
 * So the real cost is ~18x the reference's model, the batch buys almost no wall time (11.2 s vs
 * 12.5 s, 12 %), and the default batch alone needs more memory than a 16 GB CI runner has: the
 * first `ci` run on veg/primaeon lost BOTH jobs to the OOM killer ("the runner has received a
 * shutdown signal", exit 143) — the `app` job inside vitest, the `parity` job during RHO
 * epistasis, whose peak measured 22.9 GB here. Batching is pure chunking, so bounding it changes
 * no number: RHO at batch 4 vs the default is bit-identical on every site (max |dLRT| and max
 * |dp| both exactly 0 over 349 sites, measured the same day).
 *
 * The bound is deliberately generous (1.5 GB, ~2x a browser tab's comfortable working set) so it
 * binds ONLY where the reference's model is wrong by orders of magnitude: at 655 taxa it gives 4
 * sites per call, at 256 (the app's default taxon cap) 26, and below ~120 taxa it never binds at
 * all. `runDms` keeps its own floor of one site's 19 mutants per call, which is a smaller working
 * set than this bound allows at every N the DMS work budget admits.
 */
const ACTIVATION_BYTES_PER_PAIR_PER_SITE = 930;

/** Peak inference working set a single graph call may aim for, in bytes. See above. */
const DEFAULT_MEMORY_BUDGET_BYTES = 1.5e9;

/**
 * Sites per graph call: the caller's explicit `batchSize`, else the reference's adaptive size
 * bounded by the library's tensor budget (`batchBudgetBytes` → `batchSizeFor`) and by the
 * measured inference working set (`memoryBudgetBytes`, see above).
 *
 * @param {number} numTaxa
 * @param {{batchSize?: number, batchBudgetBytes?: number, memoryBudgetBytes?: number}} [options]
 * @returns {number}
 */
export function resolveBatchSize(numTaxa, options = {}) {
	if (Number.isFinite(options.batchSize) && options.batchSize >= 1) {
		return Math.floor(options.batchSize);
	}
	const budget =
		Number.isFinite(options.batchBudgetBytes) && options.batchBudgetBytes > 0
			? Math.floor(options.batchBudgetBytes)
			: undefined;
	const tensorBound = budget === undefined ? batchSizeFor(numTaxa) : batchSizeFor(numTaxa, budget);
	return Math.max(1, Math.min(adaptiveBatchSize(numTaxa), tensorBound, memoryBound(numTaxa, options)));
}

/**
 * Sites per graph call that keep the inference working set under the memory budget.
 *
 * @param {number} numTaxa
 * @param {{memoryBudgetBytes?: number}} [options]
 * @returns {number}
 */
export function memoryBound(numTaxa, options = {}) {
	const budget =
		Number.isFinite(options.memoryBudgetBytes) && options.memoryBudgetBytes > 0
			? options.memoryBudgetBytes
			: DEFAULT_MEMORY_BUDGET_BYTES;
	const perSite = ACTIVATION_BYTES_PER_PAIR_PER_SITE * Math.max(1, numTaxa) ** 2;
	return Math.max(1, Math.floor(budget / perSite));
}

/**
 * The graph bundle for token tensors the library built itself (counterfactuals, cleaned
 * re-scores): int64 tokens [b, N, 1] and the phylo tensors repeated per element.
 *
 * @param {Int32Array} c [b, N, 1] codon tokens
 * @param {Int32Array} a [b, N, 1] amino-acid tokens
 * @param {{batch: number, N: number, d: Float32Array, z: Float32Array}} meta
 */
export function bundleFromTokens(c, a, meta) {
	const { batch: b, N, d, z } = meta;
	const codons = new BigInt64Array(b * N);
	const aas = new BigInt64Array(b * N);
	for (let k = 0; k < b * N; k++) {
		codons[k] = BigInt(c[k]);
		aas[k] = BigInt(a[k]);
	}
	const distData = new Float32Array(b * N * N);
	const mdsData = new Float32Array(b * N * MDS_COMPONENTS);
	for (let k = 0; k < b; k++) {
		distData.set(d, k * N * N);
		mdsData.set(z, k * N * MDS_COMPONENTS);
	}
	return {
		msa_codons: { data: codons, dims: [b, N, 1] },
		msa_aas: { data: aas, dims: [b, N, 1] },
		dist_matrix: { data: distData, dims: [b, N, N] },
		mds_coords: { data: mdsData, dims: [b, N, MDS_COMPONENTS] }
	};
}

function assertHandle(handle, who) {
	if (!handle || !handle.session || !handle.ort) {
		throw new Error(`${who}: pass the handle returned by loadSession() as \`session\``);
	}
}

/**
 * The library's `predict(c, a, meta)` callback over a loaded session. Requests `lrt` alone, so
 * the graph is pruned to the site head; returns the raw graph output (the library clamps and
 * stores float32, as filter.py:165 / attribution.py:86 do).
 *
 * @param {{session: any, ort: any}} handle from loadSession()
 * @param {{signal?: AbortSignal, onBatch?: (meta: object) => void}} [options]
 * @returns {(c: Int32Array, a: Int32Array, meta: object) => Promise<Float32Array>}
 */
export function predictFromSession(handle, options = {}) {
	assertHandle(handle, 'predictFromSession');
	return async (c, a, meta) => {
		throwIfAborted(options.signal);
		const out = await runSites(handle.session, bundleFromTokens(c, a, meta), handle.ort, ['lrt']);
		if (options.onBatch) options.onBatch(meta);
		return out.lrt;
	};
}

/**
 * `predict_site_lrts` (inference.py:162-192) over a loaded session, with the optional heads.
 *
 * @param {import('@veg/hyphaeon-js').LoadedAlignment} loaded from `loadAlignmentAndTree`
 * @param {{session: any, ort: any}} handle from loadSession()
 * @param {{
 *   siteIndices?: ArrayLike<number>|null,   default: the variable sites, ascending
 *   outputs?: readonly string[],             default ['lrt']; add 'mean_root_attns' / 'root_repr'
 *   batchSize?: number, batchBudgetBytes?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   signal?: AbortSignal,
 *   yieldBetweenBatches?: boolean            default true: let the event loop turn per batch
 * }} [options]
 * @returns {Promise<{lrt: Float32Array, siteIndices: Int32Array, batchSize: number,
 *   mean_root_attns: {data: Float32Array, dims: [number, number]}|null,
 *   root_repr: {data: Float32Array, dims: [number, number]}|null}>}
 *   `lrt` has length L with zeros at every unscored site; the heads are [L, width] with zero rows
 *   at unscored sites, or null when not requested / not declared by the graph.
 */
export async function inferSites(loaded, handle, options = {}) {
	assertHandle(handle, 'inferSites');
	const { L, N } = loaded;
	const outputs = options.outputs ?? ['lrt'];
	const wantAttn = outputs.includes('mean_root_attns');
	const wantRepr = outputs.includes('root_repr');
	const declared = Array.isArray(handle.outputNames) ? handle.outputNames : outputs;

	let sites;
	if (options.siteIndices != null) {
		sites = Int32Array.from(options.siteIndices);
	} else {
		const v = [];
		for (let s = 0; s < L; s++) if (!loaded.invariable[s]) v.push(s);
		sites = Int32Array.from(v);
	}
	const total = sites.length;
	const batchSize = resolveBatchSize(N, options);

	const lrt = new Float32Array(L);
	let attn = null;
	let repr = null;
	const doYield = options.yieldBetweenBatches !== false;

	if (options.onProgress) options.onProgress(0, total);
	for (let start = 0; start < total; start += batchSize) {
		throwIfAborted(options.signal);
		const end = Math.min(start + batchSize, total);
		const idx = sites.subarray(start, end);
		const b = end - start;
		const bundle = gatherSiteBatch(loaded, idx);
		const out = await runSites(handle.session, bundle, handle.ort, outputs);
		if (out.lrt.length < b) {
			throw new Error(`graph returned ${out.lrt.length} LRTs for a batch of ${b} sites`);
		}
		for (let k = 0; k < b; k++) {
			const y = Math.fround(Number(out.lrt[k]));
			// torch.clamp(y, min=0): NaN propagates, as in torch.
			lrt[idx[k]] = Number.isNaN(y) ? NaN : y > 0 ? y : 0;
		}
		if (wantAttn && out.mean_root_attns && declared.includes('mean_root_attns')) {
			const width = out.mean_root_attns.length / b;
			if (!attn) attn = { data: new Float32Array(L * width), dims: [L, width] };
			for (let k = 0; k < b; k++) {
				attn.data.set(out.mean_root_attns.subarray(k * width, (k + 1) * width), idx[k] * width);
			}
		}
		if (wantRepr && out.root_repr && declared.includes('root_repr')) {
			const width = out.root_repr.length / b;
			if (!repr) repr = { data: new Float32Array(L * width), dims: [L, width] };
			for (let k = 0; k < b; k++) {
				repr.data.set(out.root_repr.subarray(k * width, (k + 1) * width), idx[k] * width);
			}
		}
		if (options.onProgress) options.onProgress(end, total);
		// Between batches is the only place this loop yields, so it is the only place a worker can
		// post progress and a cancel can land.
		if (doYield) await yieldToLoop();
	}
	return { lrt, siteIndices: sites, batchSize, mean_root_attns: attn, root_repr: repr };
}

/** Let the event loop turn between batches so a worker can post progress and a cancel can land. */
export const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

export function abortError() {
	const err = new Error('HyphAeon run cancelled');
	err.name = 'AbortError';
	return err;
}

export function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}
