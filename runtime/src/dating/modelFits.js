/**
 * modelFits.js — the model-based half of `run_mrca_dating`, expressed over two matrices.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS IN THIS DIRECTORY. `@veg/hyphaeon-js` ports the four
 * estimators (`computeNeuralCovarianceKernel` dating.py:78, `estimateRemlPagelLambda` :1476,
 * `runPglsDating` :1299, `optimizeLatentConvexHullRoot` :701) and nothing else: they take numbers
 * and return numbers. What sits between them — which taxa are in which matrix, in what ORDER, which
 * rows are sliced away and WHEN, which sequences may anchor a root, and what the reference's own
 * `ridge` argument actually is — is orchestration, and getting any of it wrong produces an ancestor
 * date that is wrong by decades and looks exactly like a right one. That is result semantics, so it
 * is app-side, and it is here rather than in `../datingNeural.js` because it loads nothing: it takes
 * `crossAttn` and `taxaRepr` as arguments and `dating-port.test.js`'s import-boundary check over
 * this directory stays exactly as written.
 *
 * =========================== THE FOUR THINGS THAT ARE EASY TO GET WRONG ===========================
 *
 * 1. CENTRE THEN SUBSET, NEVER SUBSET THEN CENTRE. `dating.py:2568` builds `K_neural` over ALL
 *    alignment taxa; `:2576` slices it to the dated ones; `:2781` slices again to the training ones.
 *    `compute_neural_covariance_kernel` centres each column across the taxa it is given
 *    (dating.py:95, :106), so a kernel rebuilt over a subset is a DIFFERENT matrix from a slice of
 *    the kernel built over everything. On the acceptance example the root sequence `CONSENSUS`
 *    carries no date, is in no fit, and still contributes its row to the centring. `neuralKernel`
 *    takes the full matrices and `sliceSymmetric` does every narrowing after it.
 *
 * 2. `ridge` AND `pagel_lambda` ARE TWO NAMES FOR ONE NUMBER, AND ONE OF THEM DOES NOTHING
 *    (DATING Q8). `dating.py:2790-2796` runs REML, takes λ*, and computes
 *    `effective_ridge = clip(1 − λ*, 0.01, 0.20)` — which it PRINTS and passes to `run_pgls_dating`
 *    as `ridge`. Because `pagel_lambda` is not None, that argument never reaches the covariance
 *    (dating.py:1352-1357) and `:1466` recomputes the returned `'ridge'` field as `1 − eff_lam`.
 *    So on korber the CLI prints `nugget ridge = 0.2000` and the JSON ships
 *    `pgls.ridge = 0.301574527827`. The clip DOES bite on the spline, which takes the argument
 *    additively (dating.py:1846) — which is why `effectiveRidge` is computed here once and handed to
 *    both, and why a page must never show both numbers under one word.
 *
 * 3. THE ANCHOR MASK AND THE HOLDOUT ARE THE SAME RULE READ TWICE. `dating.py:2578-2585` masks a
 *    sequence below 50 % ACGT out of the root anchor set; `:2698-2707` reserves the same sequences
 *    as out-of-sample test taxa. The second has a guard the first does not (it only reserves when at
 *    least three training rows survive), so `coverageHoldout`'s `isTrain` — the ungated rule — is the
 *    anchor mask, and its `trainIndices` — the gated one — is the fit.
 *
 * 4. THE KERNEL IS DECOMPOSED ONCE, NOT THREE TIMES (DATING Q9). `estimate_reml_pagel_lambda`
 *    returns `w_K`/`V` at dating.py:1545-1546 precisely so `run_pgls_dating` can reuse them, but the
 *    reuse branch at `:1331-1336` only fires when `ridge == 'auto'` and `run_mrca_dating:2799` always
 *    passes a float — so `la.eigh` runs again on the same matrix at `:1347`, and the spline
 *    decomposes it a third time at `:1845`. `fitPgls` passes the REML decomposition straight through
 *    as `options.eigen`. That is deduplication of an identical call, not a change: same matrix, same
 *    routine, same output. The spline's is a DIFFERENT decomposition (it wants a dense `C_inv`) and
 *    is left alone.
 *
 * WHAT IS NOT HERE, AND WHY IT IS A REFUSAL RATHER THAN AN OMISSION. The library refuses
 * `n > 2500` (the reference's truncated Lanczos, a float32 ARPACK approximation with no JavaScript
 * equivalent), `n > 2000` in REML (its stratified subsample), `ridge: 'auto'`, and the three
 * Monte-Carlo intervals. Each of those is a branch that would otherwise return a plausible number
 * under the same name. The reference itself declines the neural route above 1,500 sequences without
 * a tree (dating.py:2745-2747), which is the precedent this pillar's own cap cites.
 */

import {
	computeNeuralCovarianceKernel,
	estimateRemlPagelLambda,
	optimizeLatentConvexHullRoot,
	pairwiseAcgtHammingMatrix,
	runPglsDating
} from '@veg/hyphaeon-js';

/** `dating.py:2745` — above this the reference skips the transformer entirely and says so. */
export const DATING_NEURAL_MAX_TAXA = 1500;

/**
 * `dating.py:2792`, the one clip that is real. `run_pgls_dating` ignores the number (Q8) but
 * `run_restricted_spline_clock_dating` adds it to every eigenvalue (dating.py:1846), so the
 * difference between `1 − λ*` and its clip is visible in the spline and nowhere else.
 */
export function effectiveRidge(pagelLambda) {
	return Math.min(0.2, Math.max(0.01, 1.0 - pagelLambda));
}

/**
 * `compute_neural_covariance_kernel(cross_attn, taxa_repr)` over the FULL alignment
 * (dating.py:2568). See note 1: this is the only call, and every narrowing is a slice of its result.
 *
 * @param {{crossAttn: ArrayLike<number>, taxaRepr: ArrayLike<number>, N: number, embedDim: number}} pass
 *   the object `runDatingModelPass` returned
 * @returns {Float64Array} row-major N*N, unit diagonal
 */
export function neuralKernel(pass) {
	return computeNeuralCovarianceKernel(pass.crossAttn, pass.N, pass.taxaRepr, pass.embedDim);
}

/**
 * `K[np.ix_(idx, idx)]` — a symmetric slice in the order `indices` gives, which is the dated-taxon
 * order and not the alignment's.
 *
 * @param {ArrayLike<number>} matrix row-major n*n
 * @param {number} n
 * @param {ArrayLike<number>} indices
 * @returns {Float64Array} row-major m*m
 */
export function sliceSymmetric(matrix, n, indices) {
	const m = indices.length;
	const out = new Float64Array(m * m);
	for (let a = 0; a < m; a++) {
		const row = indices[a] * n;
		for (let b = 0; b < m; b++) out[a * m + b] = matrix[row + indices[b]];
	}
	return out;
}

/** `taxa_repr[sub_indices]` — the same reordering on the [N, D] block. */
export function sliceRows(matrix, cols, indices) {
	const m = indices.length;
	const out = new Float64Array(m * cols);
	for (let a = 0; a < m; a++) {
		const src = indices[a] * cols;
		for (let k = 0; k < cols; k++) out[a * cols + k] = matrix[src + k];
	}
	return out;
}

/**
 * `dating.py:2544-2601`: the latent convex-hull root, and the divergences every estimator is then
 * fitted against — OLS included. That last part is what makes `--distance-mode auto` a decision
 * about the whole record and not just about PGLS (DATING Q11): with no tree and a model available,
 * `auto` resolves to `latent` (dating.py:2520-2523), so the ordinary fit is an ordinary fit on
 * `alpha * ||z_i − z_root||`. On korber that moves `ols.t_mrca` from 1893.91 to 1926.81 and `ols.mu`
 * from 1.169e-3 to 5.551e-4. A report must name the divergence source, not only the estimator.
 *
 * `pairwise_phys_dists` (dating.py:2588-2596) is a raw nucleotide HAMMING p-distance over the
 * columns where both sequences resolve to ACGT — NOT TN93, despite the reference's own docstring —
 * and it is used for one thing: the no-intercept slope `alpha` that turns latent units into
 * substitutions per site. The reference computes it in a Python double loop, so it is the dominant
 * cost of the latent path at any size; the library's `pairwiseAcgtHammingMatrix` is the same
 * arithmetic vectorised.
 *
 * @param {object} args
 * @param {ArrayLike<number>} args.taxaRepr row-major, the FULL [N, embedDim] block
 * @param {number} args.embedDim
 * @param {readonly number[]} args.subIndices positions of the dated taxa in the alignment's order
 * @param {readonly string[]} args.taxa the dated taxa, in their own order
 * @param {ArrayLike<number>} args.times
 * @param {readonly string[]} args.sequences aligned sequence strings, in `taxa` order
 * @param {readonly boolean[]} args.anchorMask coverage >= 50 % (see note 3)
 * @returns {Record<string, any>} the reference's `latent_root_res`
 */
export function latentRoot({ taxaRepr, embedDim, subIndices, taxa, times, sequences, anchorMask }) {
	const zSub = sliceRows(taxaRepr, embedDim, subIndices);
	const phys = pairwiseAcgtHammingMatrix(sequences);
	return optimizeLatentConvexHullRoot(zSub, times, {
		embedDim,
		taxaNames: [...taxa],
		pairwisePhysDists: phys,
		anchorMask
	});
}

/**
 * `dating.py:2596-2599`'s own sentence, byte for byte: `f"latent_convex_hull (α={alpha:.5f}
 * subs/site/unit, R={r:+.3f})"`. It is the `root_description` a reader sees and a download diffs.
 */
export function latentRootDescription(latent) {
	const alpha = Number(latent.alpha).toFixed(5);
	// Python's `+` sign flag: an explicit `+` on anything that does not already print a `-`.
	const r = Number(latent.temporal_r).toFixed(3);
	return `latent_convex_hull (α=${alpha} subs/site/unit, R=${r.startsWith('-') ? r : `+${r}`})`;
}

/**
 * `dating.py:2788-2805`: REML for Pagel's λ, then the GLS fit, on the TRAINING rows of the sliced
 * covariance. The decomposition is computed once and handed to both (note 4).
 *
 * @param {{times: ArrayLike<number>, dists: ArrayLike<number>, covTrain: ArrayLike<number>,
 *   ciMethod?: string}} args
 * @returns {{pgls: Record<string, any>, reml: Record<string, any>, pagelLambda: number,
 *   printedRidge: number}} `printedRidge` is the number the CLI prints and the spline uses; the
 *   record's own `pgls.ridge` is `1 − λ*` and is a different number (Q8).
 */
export function fitPgls({ times, dists, covTrain, ciMethod = 'fieller' }) {
	const reml = estimateRemlPagelLambda(times, dists, covTrain);
	const pagelLambda = reml.best_lambda;
	const printedRidge = effectiveRidge(pagelLambda);
	const pgls = runPglsDating(times, dists, covTrain, {
		ridge: printedRidge,
		pagelLambda,
		ciMethod,
		eigen: { values: reml.w_K, vectors: reml.V }
	});
	return { pgls, reml, pagelLambda, printedRidge };
}
