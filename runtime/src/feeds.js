/**
 * feeds.js — the one place tensors are turned into ORT feeds and a graph run is read back.
 *
 * WHY THIS FILE EXISTS. DM3's session.js and datamonkey-js-server's session.js each carried an
 * identical `runSites()`; the only difference between them was the transport (fetch vs
 * readFile, Web Crypto vs node:crypto, onnxruntime-web vs onnxruntime-node). The feed
 * construction and the output read-back are not transport, so they live here once and both
 * session modules re-export them. Ported from
 * datamonkey3/src/lib/services/axomeme/session.js (main@fac1330) `runSites`.
 *
 * DTYPES ARE PART OF THE CONTRACT. The token streams are int64 — onnxruntime wants a
 * BigInt64Array for them, and passing a Float32Array of the same values is a type error at
 * session.run, not a silent coercion. dist_matrix and mds_coords are float32.
 *
 * OUTPUTS ARE READ BY NAME AGAINST THE MANIFEST'S LIST. The v1 viral graph returns `lrt` alone;
 * the new export adds `mean_root_attns` [batch, N] and `root_repr` [batch, embed_dim]. Anything
 * the graph returns beyond the manifest's list is ignored rather than passed through, so a graph
 * with extra heads cannot leak columns into a result nobody has verified (`dropped_heads_policy:
 * "omit"`). A missing optional head is simply absent from the returned object — never zero-filled.
 */

import { DEFAULT_OUTPUT_NAMES } from './manifest.js';

/**
 * Build the feed dictionary for one batch.
 *
 * @param {Record<string, {data: any, dims: number[]}>} bundle tensors from the library's
 *   assembly layer (`prepareAlignment(...).batch(start, count)`)
 * @param {any} ort the onnxruntime module (web or node), for its Tensor constructor
 */
export function buildFeeds(bundle, ort) {
	return {
		msa_codons: new ort.Tensor('int64', bundle.msa_codons.data, bundle.msa_codons.dims),
		msa_aas: new ort.Tensor('int64', bundle.msa_aas.data, bundle.msa_aas.dims),
		dist_matrix: new ort.Tensor('float32', bundle.dist_matrix.data, bundle.dist_matrix.dims),
		mds_coords: new ort.Tensor('float32', bundle.mds_coords.data, bundle.mds_coords.dims)
	};
}

/**
 * Run a batch of sites through the graph.
 *
 * Every site of the batch goes through in ONE run: dist_matrix and mds_coords are per-alignment,
 * so the reference computes them once and `expand`s them across sites, and the assembly layer
 * materialises them that way. The reference driver instead loops one forward pass per site.
 *
 * @param {any} session an ONNX InferenceSession
 * @param {object} bundle tensors shaped per the model contract
 * @param {any} ort the onnxruntime module (passed in so this stays a pure function)
 * @param {readonly string[]} [outputNames] outputs to read back; default the manifest's three
 * @returns {Promise<{lrt: Float32Array, mean_root_attns?: Float32Array, root_repr?: Float32Array}>}
 *   flat typed arrays; the caller knows the batch size and N from the bundle it passed
 */
export async function runSites(session, bundle, ort, outputNames = DEFAULT_OUTPUT_NAMES) {
	const out = await session.run(buildFeeds(bundle, ort));
	if (!out.lrt) {
		throw new Error('graph run returned no `lrt` output');
	}
	const result = { lrt: out.lrt.data };
	for (const name of outputNames) {
		if (name === 'lrt' || !out[name]) continue;
		result[name] = out[name].data;
	}
	return result;
}
