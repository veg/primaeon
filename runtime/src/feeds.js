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
 * OUTPUTS ARE REQUESTED BY NAME — AND THE FETCH LIST SELECTS WHAT IS RETURNED, NOT WHAT IS
 * COMPUTED. This header said the opposite until Phase 4 measured it, and three other files leaned
 * on that claim. MEASURED (onnxruntime, CPU, min of 7 reps after 2 warmups) on a prototype that
 * folded the dating pillar's two extra reductions into the backbone: fetching `['lrt']` alone cost
 * 189.0 ms against 188.2 ms for all five outputs at N=143/B=24, and 309.2 against 310.6 ms at
 * N=256/B=16 — the same, within noise. ORT does not prune.
 *
 * The existing three-output graph hides this because `mean_root_attns` and `root_repr` are near-free
 * reductions of tensors the `lrt` path already materialises: on `general.onnx` at N=143/B=24 one
 * thread, fetching `['lrt']` took 528 ms and fetching all three 511 ms. So the contract costs
 * nothing whichever way it is asked, and the fetch list is still worth passing — it avoids COPYING
 * large tensors out of WASM or native memory into JavaScript, and it is intersected with what the
 * loaded graph declares so a v1 single-output graph is asked for `lrt` alone. What it does NOT buy
 * is arithmetic, and that is why the dating pillar's `cross_attn_sum` / `taxa_repr_sum` live on a
 * separate artifact (`<variant>_taxa.onnx`) rather than as two more outputs here: the same folded
 * prototype cost every caller +2.5 % to +7.3 % at one thread and +15 % to +19 % at eight, on every
 * MEME, BUSTED, epistasis, DMS and phenotype site of every run, for outputs only dating reads.
 *
 * Anything the graph returns beyond the manifest's list is never passed through
 * (`dropped_heads_policy: "omit"`) and a missing optional head is absent from the returned object —
 * never zero-filled. A fake session in the tests may ignore the fetch argument and return
 * everything; the read-back still filters to the requested names. `runTaxaSites` is the one
 * exception to the omit policy and says why at its own definition.
 */

import { DEFAULT_OUTPUT_NAMES, TAXA_OUTPUT_NAMES } from './manifest.js';

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
 * Run a batch of sites through the DATING graph (`<variant>_taxa.onnx`).
 *
 * Same four inputs as the backbone, so `buildFeeds` is reused unchanged; two outputs, both already
 * reduced over the batch, so what comes back does not grow with the number of sites in the call:
 *
 *   `cross_attn_sum`  [N, N]          Σ over this call's sites of the head-mean of `attn[1:, 1:]`,
 *                                     accumulated over the graph's row layers (splits.py:131-132)
 *   `taxa_repr_sum`   [N, embed_dim]  Σ over this call's sites of `x_full[:, 1:, central, :]`
 *                                     (splits.py:147-149)
 *
 * THEY ARE SUMS AND THE NAMES SAY SO. `splits.py` receives the whole alignment in one call and
 * divides at :151-153; the runtime cannot make that call, so it accumulates across batches and
 * divides once — by `sites * taxa_row_layers` and by `sites`. A per-call mean would have to be
 * re-multiplied by the batch size to be accumulated, losing precision for nothing.
 *
 * THIS REFUSES WHERE `runSites` OMITS. `runSites` drops an absent optional head because
 * `dropped_heads_policy` is "omit" and a meme run is still a meme run without the attention. Here a
 * missing output is not a degraded answer, it is a covariance kernel built from nothing — the
 * plausible wrong number this pillar exists to avoid — so both outputs are required and their
 * absence throws.
 *
 * @param {any} session an ONNX InferenceSession for the taxa graph
 * @param {object} bundle the same tensors `runSites` takes
 * @param {any} ort
 * @param {readonly string[]} [outputNames] default the manifest's two
 * @returns {Promise<{cross_attn_sum: Float32Array, taxa_repr_sum: Float32Array}>} flat typed arrays
 */
export async function runTaxaSites(session, bundle, ort, outputNames = TAXA_OUTPUT_NAMES) {
	const out = await session.run(buildFeeds(bundle, ort), [...outputNames]);
	const result = {};
	for (const name of outputNames) {
		const tensor = out[name];
		if (!tensor || tensor.data === undefined) {
			throw new Error(
				`dating graph run returned no \`${name}\` output. The two taxa outputs are both required: ` +
					`a covariance kernel built from a missing matrix is a plausible wrong date, so this refuses ` +
					`rather than degrading. Check that the loaded graph is <variant>_taxa.onnx and not the backbone.`
			);
		}
		result[name] = tensor.data;
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
