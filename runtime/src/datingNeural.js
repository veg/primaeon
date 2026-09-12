/**
 * datingNeural.js — the forward pass the dating pillar's two model-based estimators are fed from.
 *
 * WHY THIS FILE EXISTS. `hyphaeon/splits.py:24-155`
 * `extract_cross_taxa_attentions_and_embeddings(model, msa_codons, msa_aas, tree_cache)` is one
 * call in the reference: the whole alignment goes in, a `[N, N]` attention matrix and an
 * `[N, embed_dim]` embedding matrix come out, and `:151-153` divides by `batch_size * num_layers`
 * and by `batch_size`. The runtime cannot make that call — korber's 981 codons at 143 taxa is
 * 18.6 GB of activations at `predict.js`'s own measured constant — so `<variant>_taxa.onnx` emits
 * SUMS over the sites in each call, this file accumulates them across calls, and the division
 * happens once at the end. That is the whole of the difference, and it is why the graph's output
 * names say `_sum`.
 *
 * WHY IT IS NOT IN `src/dating/`. `dating-port.test.js` scans every file in that directory and
 * fails if one imports `manifest.js`, `predict.js`, `feeds.js`, a session module or onnxruntime.
 * That test is the only mechanical proof that the `/time` route costs no model byte, and it is
 * worth more than the tidiness of one directory. This file is what that directory is not allowed
 * to be; `runtime/src/dating/neural.js` — pure, taking the matrices this produces — is the seam
 * between them.
 *
 * ===================== FOUR THINGS THE REFERENCE DOES THAT ARE EASY TO MISS =====================
 *
 * 1. EVERY SITE RUNS, INVARIABLE ONES INCLUDED. `dating.py:2554-2566` hands the extractor the full
 *    `[L, N, 1]` tensor `prepare_alignment` built; `inference.py:162-192` `predict_site_lrts`, which
 *    the report's pass mirrors, runs the VARIABLE sites only. Different site set, so the dating pass
 *    is a second forward pass and cannot ride the first. On korber that is 981 sites, not the 830
 *    variable ones.
 *
 * 2. NO TAXON IS PRUNED OR CAPPED. `prepare_alignment(..., max_species=None, prune_duplicates=False)`
 *    (dating.py:2553-2561, and `cli.py`'s dating default of `None`), where the report's pass prunes
 *    duplicates and caps at 256. A run that capped would build a covariance over a SUBSET of the
 *    reference's taxa and a convex hull spanned by a subset — a different estimate, not an
 *    approximation of the same one — so this file does neither and reports the taxon count it used.
 *
 * 3. THE MATRICES ARE OVER ALL ALIGNMENT TAXA, INCLUDING UNDATED ONES. `dating.py:2568` builds the
 *    kernel over everything the alignment holds and `:2576` then slices it to the dated set. On the
 *    acceptance example that means the root sequence `CONSENSUS`, which carries no date and is
 *    dropped from every fit, still contributes its row to the centring at `dating.py:95`/`:106`.
 *    Centre-then-subset is not subset-then-centre. This file returns the FULL matrices and its taxon
 *    list; the slicing is the caller's, one step later, in `dating/neural.js`.
 *
 * 4. `*` IS REWRITTEN TO `-` BEFORE THE DISTANCES ARE COMPUTED, AND IT MOVES THE MODEL.
 *    `dataset.py:747` writes `seq_dict[t].replace('*', '-')` into the FASTA it hands the `tn93`
 *    binary; the pure-Python fallback branch does not. MEASURED on korber (2,389 asterisks, a LANL
 *    MASE alignment): feeding the library's TN93 the unsubstituted sequences moves the site-averaged
 *    cross-taxa attention by 1.703e-3, which is 9.3 % of its largest entry, and the embeddings by
 *    4.067e-2; substituting first reproduces the reference to 1.22e-8 absolute / 6.7e-7 relative on
 *    the attention and 2.3e-7 / 1.1e-7 on the embeddings. The TN93 matrix is a model INPUT
 *    (`dist_matrix`), so this is not a cosmetic difference in a distance, it is a different forward
 *    pass. `starsToGaps` is applied here for the same reason the model-free path applies it, and
 *    `runDatingModelPass` refuses to guess: `sequences` arrives already substituted, or
 *    `alignmentText` is substituted here and the count is reported.
 *
 * COST, MEASURED on this machine (onnxruntime-node 1.23.2, darwin/x64, korber 143 taxa x 981
 * codons, general_taxa.onnx): 7.3 s at 4 threads, 13 calls of 78 sites. Against the BACKBONE over
 * the same 981 sites at the same batch and one thread, the dating graph costs almost exactly the
 * same — 1.52 GB peak RSS against 1.50 GB and 22.0 s against 21.6 s at batch 64 — because it drops
 * the ordinal head and adds two reductions of tensors the attention already materialised. So this
 * pass takes `resolveBatchSize` UNCHANGED rather than inventing a second budget: `predict.js`'s
 * measured 930 bytes per taxon pair per site still describes it, and at the app's 256-taxon default
 * cap that is 24 sites per call. The pass is nonetheless a SECOND full forward pass over the whole
 * alignment, invariable sites included, and a caller must say so before a reader waits for it.
 * Progress is reported per batch through the package's one `progress(phase, done, total, message)`
 * contract and cancellation is the same `AbortError` every worker in this app checks.
 *
 * ACCUMULATION IS FLOAT64. The graph's sums are float32 over one call's sites; adding ~40 of them
 * in float32 would reassociate a second time for no reason. Two Float64Arrays, N² + N·384 entries,
 * are 1.3 MB at the app's default cap of 256 taxa and 524 KB at korber's 143 — irrelevant against
 * the activations the pass is already paying for.
 */

import { gatherSiteBatch, loadAlignmentAndTree, parseAlignmentSequences } from '@veg/hyphaeon-js';

import { starsToGaps } from './dating/alignment.js';
import { runTaxaSites } from './feeds.js';
import { taxaGraphArch, taxaOutputNames } from './manifest.js';
import { abortError, resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';

/** `progress(phase, done, total, message)`, the package's one progress contract. */
function report(progress, done, total, message) {
	if (typeof progress === 'function') progress('dating-model', done, total, message);
}

/**
 * Run the dating graph over every site of an alignment and return the two matrices
 * `compute_neural_covariance_kernel` and `optimize_latent_convex_hull_root` are fed.
 *
 * @param {object} args
 * @param {string} [args.alignmentText] FASTA/NEXUS/PHYLIP text; `*` is rewritten to `-` here.
 * @param {Map<string,string>} [args.sequences] already parsed AND already star-substituted.
 * @param {{session: any, ort: any, outputNames?: string[]}} args.session the handle
 *   `loadTaxaGraph` / `createSession().loadTaxaGraph()` returned.
 * @param {object} [args.manifest] read for `onnx.taxa_row_layers`, `onnx.embed_dim` and
 *   `onnx.taxa_outputs`; the exported checkpoint's own 6 / 384 / two names when absent.
 * @param {number} [args.batchSize] sites per graph call; default `resolveBatchSize(N)`.
 * @param {Function} [args.progress] `(phase, done, total, message)`
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{crossAttn: Float64Array, taxaRepr: Float64Array, taxa: string[], N: number,
 *   L: number, embedDim: number, rowLayers: number, batchSize: number, calls: number,
 *   starsRewritten: number, elapsedSeconds: number}>}
 *   `crossAttn` is row-major N*N and `taxaRepr` row-major N*embedDim, both already divided —
 *   `splits.py:152-153`'s `mean_cross_attn` and `mean_taxa_repr`, over ALL alignment taxa in
 *   alignment order.
 */
export async function runDatingModelPass(args = {}) {
	const t0 = Date.now();
	const { alignmentText = null, sequences = null, session: handle, manifest = null, progress = null, signal = null } = args;
	if (!handle || !handle.session || !handle.ort) {
		throw new Error('runDatingModelPass: pass the handle returned by loadTaxaGraph() as `session`');
	}
	const declared = Array.isArray(handle.outputNames) ? handle.outputNames : null;
	const wanted = taxaOutputNames(manifest);
	if (declared) {
		const missing = wanted.filter((n) => !declared.includes(n));
		if (missing.length) {
			throw new Error(
				`runDatingModelPass: the loaded graph declares no ${missing.join(', ')}. That is the BACKBONE, not ` +
					`<variant>_taxa.onnx: its \`mean_root_attns\` is the root token's attention ROW and its \`root_repr\` ` +
					`the root token's VECTOR, where this pillar needs the taxon-by-taxon block and the per-taxon states. ` +
					`Neither is derivable from the other.`
			);
		}
	}
	throwIfAborted(signal);

	// See note 4 in the header: the substitution is a model input, not a cosmetic clean-up. A caller
	// that already has the pillar's sequences passes them and the substitution has happened; a caller
	// with raw text gets it here, through the same `starsToGaps` the model-free path uses, and the
	// count travels back in the result so a page can say it in place.
	let stars = 0;
	let seqs = sequences;
	if (seqs == null) {
		if (typeof alignmentText !== 'string' || !alignmentText.trim()) {
			throw new Error('runDatingModelPass: one of `alignmentText` or `sequences` is required');
		}
		const rewritten = starsToGaps(parseAlignmentSequences(alignmentText));
		stars = rewritten.stars;
		seqs = rewritten.sequences;
	}

	// dating.py:2553-2561 exactly: no cap, no duplicate pruning, TN93 because the pass is tree-free.
	// The alignment is re-emitted as FASTA rather than handed over as a map because the library's
	// loader takes text — and because the reference re-reads the FILE here too (prepare_alignment at
	// dating.py:2554 opens `align_p` again rather than reusing the `seq_dict` verify_coding_alignment
	// looked at), so the two sides start from the same place.
	const loaded = loadAlignmentAndTree(fastaFrom(seqs), null, { useTn93: true, pruneDuplicates: false, maxSpecies: null });
	const { N, L, taxa } = loaded;
	const { rowLayers, embedDim } = taxaGraphArch(manifest);
	throwIfAborted(signal);

	// The backbone's own sizing, measured to describe this graph as well (see the header).
	const batchSize = resolveBatchSize(N, args);

	const crossAttn = new Float64Array(N * N);
	const taxaRepr = new Float64Array(N * embedDim);
	let calls = 0;
	let width = 0;

	report(progress, 0, L, `Reading the model's view of ${N} sequences across ${L} codons...`);
	for (let start = 0; start < L; start += batchSize) {
		throwIfAborted(signal);
		const end = Math.min(start + batchSize, L);
		const idx = new Int32Array(end - start);
		for (let k = 0; k < idx.length; k++) idx[k] = start + k;
		const out = await runTaxaSites(handle.session, gatherSiteBatch(loaded, idx), handle.ort, wanted);
		const attn = out.cross_attn_sum;
		const repr = out.taxa_repr_sum;
		if (attn.length !== N * N) {
			throw new Error(`dating graph returned cross_attn_sum of ${attn.length} values for ${N} taxa (expected ${N * N})`);
		}
		width = repr.length / N;
		if (!Number.isInteger(width) || width !== embedDim) {
			throw new Error(
				`dating graph returned taxa_repr_sum of width ${repr.length / N} for ${N} taxa; the manifest says ${embedDim}`
			);
		}
		for (let i = 0; i < attn.length; i++) crossAttn[i] += attn[i];
		for (let i = 0; i < repr.length; i++) taxaRepr[i] += repr[i];
		calls += 1;
		report(progress, end, L, `Reading the model's view of ${N} sequences across ${L} codons...`);
		if (args.yieldBetweenBatches !== false) await yieldToLoop();
	}
	if (calls === 0) throw abortError();

	// splits.py:152-153. The row-layer factor is the graph's, not the batch's: TaxaGraph accumulates
	// over `m.row_layers` inside one call, exactly as splits.py accumulates over its own loop.
	const attnDiv = L * rowLayers;
	for (let i = 0; i < crossAttn.length; i++) crossAttn[i] /= attnDiv;
	for (let i = 0; i < taxaRepr.length; i++) taxaRepr[i] /= L;

	return {
		crossAttn,
		taxaRepr,
		taxa: [...taxa],
		N,
		L,
		embedDim: width || embedDim,
		rowLayers,
		batchSize,
		calls,
		starsRewritten: stars,
		elapsedSeconds: (Date.now() - t0) / 1000
	};
}

/** A sequence map back to FASTA, for the branch where the caller parsed the alignment itself. */
function fastaFrom(sequences) {
	const parts = [];
	for (const [name, seq] of sequences) parts.push(`>${name}\n${seq}`);
	return `${parts.join('\n')}\n`;
}
