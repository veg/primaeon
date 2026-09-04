/**
 * feeds.js — the one place tensors are turned into ORT feeds and a graph run is read back.
 *
 * WHY THIS FILE EXISTS. DM3's session.js and datamonkey-js-server's session.js each carried an
 * identical `runSites()`; the only difference between them was the transport (fetch vs
 * readFile, Web Crypto vs node:crypto, onnxruntime-web vs onnxruntime-node). The feed
 * construction and the output read-back are not transport, so they live here once and both
 * session modules re-export them. Ported from
 * datamonkey3/src/lib/services/axomeme/session.js (main@fac1330) `runSites`; the busted-head
 * half added in Phase 1b from veg/HyphAeon js/src/omnibus.js (phase-1a) `runBusted`'s
 * `predictHead` contract and PHASE1A.md ("feed busted_head.onnx the all-false mask").
 *
 * DTYPES ARE PART OF THE CONTRACT. The token streams are int64 — onnxruntime wants a
 * BigInt64Array for them, and passing a Float32Array of the same values is a type error at
 * session.run, not a silent coercion. dist_matrix and mds_coords are float32. The busted head's
 * `mask` is a bool tensor, which onnxruntime takes as a Uint8Array of 0/1.
 *
 * OUTPUTS ARE REQUESTED BY NAME, AND ONLY THE ONES ASKED FOR ARE COMPUTED. `session.run(feeds,
 * fetches)` with an explicit fetch list lets ORT prune the graph to the requested outputs, so a
 * `meme` run that needs `lrt` alone does not pay for the attention pooling and the root
 * representation (`inference.py:162-192` requests neither: `forward_cached` returns `(y, _)`
 * there and `return_hidden=True` only in cmd_busted). The fetch list is intersected with what
 * the loaded graph declares, so a v1 single-output graph is asked for `lrt` alone; anything the
 * graph returns beyond the manifest's list is never passed through (`dropped_heads_policy:
 * "omit"`) and a missing optional head is absent from the returned object — never zero-filled.
 * A fake session in the tests may ignore the fetch argument and return everything; the read-back
 * still filters to the requested names.
 */

import { DEFAULT_OUTPUT_NAMES } from './manifest.js';

/**
 * Build the feed dictionary for one batch.
 *
 * @param {Record<string, {data: any, dims: number[]}>} bundle tensors from the library's
 *   assembly layer (`siteBatch` / `gatherSiteBatch`)
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
 * The fetch list for a run: the requested names the session declares, `lrt` always first. A
 * session without an `outputNames` list (a minimal fake) is asked for the request as given.
 *
 * @param {any} session
 * @param {readonly string[]} outputNames
 * @returns {string[]}
 */
export function fetchesFor(session, outputNames) {
	const declared = Array.isArray(session?.outputNames) ? session.outputNames : null;
	const wanted = ['lrt', ...outputNames.filter((n) => n !== 'lrt')];
	return declared ? wanted.filter((n) => declared.includes(n)) : wanted;
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
 * @param {readonly string[]} [outputNames] outputs to compute and read back; default the
 *   manifest's three. Pass `['lrt']` for a site-scoring run that needs nothing else.
 * @returns {Promise<{lrt: Float32Array, mean_root_attns?: Float32Array, root_repr?: Float32Array}>}
 *   flat typed arrays; the caller knows the batch size and N from the bundle it passed
 */
export async function runSites(session, bundle, ort, outputNames = DEFAULT_OUTPUT_NAMES) {
	const fetches = fetchesFor(session, outputNames);
	const out = await session.run(buildFeeds(bundle, ort), fetches);
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

/**
 * The feeds for `busted_head.onnx`: `root_repr` [1, L, embed_dim] float32 (zeros at invariable
 * sites, as cmd_busted's `hidden_all` is, cli.py:434/447) and `mask` [1, L] bool, ALL FALSE —
 * cmd_busted calls the head with `mask=None` (cli.py:458) and the export spells that None as a
 * zero key-padding mask (PHASE1A.md item 4). A caller who passes a non-zero mask is asking for
 * something the reference never computes, so the mask is validated to be all zero.
 *
 * @param {{root_repr: Float32Array, mask?: Uint8Array|null, dims: [number, number, number]}} input
 *   the object the library's `runBusted` hands to `predictHead`
 * @param {any} ort
 */
export function buildBustedHeadFeeds(input, ort) {
	const [batch, L, embedDim] = input.dims;
	if (input.root_repr.length !== batch * L * embedDim) {
		throw new Error(
			`busted head: root_repr has ${input.root_repr.length} values for dims [${input.dims}]`
		);
	}
	const mask = input.mask ?? new Uint8Array(batch * L);
	if (mask.length !== batch * L) {
		throw new Error(`busted head: mask has ${mask.length} entries for ${batch * L} sites`);
	}
	for (let i = 0; i < mask.length; i++) {
		if (mask[i]) {
			throw new Error(
				'busted head: the mask must be all false (cmd_busted calls the head with mask=None, cli.py:458)'
			);
		}
	}
	return {
		root_repr: new ort.Tensor('float32', input.root_repr, [batch, L, embedDim]),
		mask: new ort.Tensor('bool', mask, [batch, L])
	};
}

/**
 * Run the busted head on the pooled representation of a whole alignment. Returns every output
 * the graph declares (`cls_prob`, `pred_gene_lrt`, `omega_prop`, `syn_var`, `pred_omega3`,
 * `pred_logp`) as flat typed arrays, which is the `BustedHeadOutputs` shape the library's
 * `bustedHeadFields` decodes (`omega_prop` is the 3-vector, the rest 1-element arrays).
 *
 * @param {any} session the busted_head InferenceSession
 * @param {{root_repr: Float32Array, mask?: Uint8Array|null, dims: [number, number, number]}} input
 * @param {any} ort
 * @returns {Promise<Record<string, Float32Array>>}
 */
export async function runBustedHead(session, input, ort) {
	const out = await session.run(buildBustedHeadFeeds(input, ort));
	const result = {};
	for (const [name, tensor] of Object.entries(out)) {
		if (tensor && tensor.data !== undefined) result[name] = tensor.data;
	}
	if (!result.cls_prob) throw new Error('busted head run returned no `cls_prob` output');
	return result;
}
