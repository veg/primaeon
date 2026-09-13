/**
 * dating.worker.ts — the ancestor-date run, off the main thread and cancellable.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A FOURTH WORKER RATHER THAN A REQUEST ON THE ANALYZE ONE.
 * The analyze worker exists to keep ONE warm, hash-verified ORT session and the prepared tensors
 * every pillar reads; this run touches none of that. It loads no manifest and no graph — the only
 * thing it fetches is the 250 KB compiled TN93 named below, not the ~20 MB of ORT WASM and 7-8 MB
 * of graph that putting this on the analyze worker would drag into a route whose entire claim is
 * that it costs no MODEL byte. `e2e/time.spec.ts` asserts that claim by watching the network for
 * `*.onnx` and `ort-*.wasm`, and this file is the mechanism that makes it true.
 *
 * WHY IT FETCHES THE COMPILED TN93 AT ALL. Root-to-tip divergence here IS a TN93 distance
 * (`computeTreeFreeDivergences` -> `tn93CrossDistanceMatrix`), and until this was fixed this worker
 * computed it with the library's JavaScript port while `web/src/lib/viz/ProvenancePanel.svelte`
 * stood ready to say the compiled engine had run. That port no longer exists in either package
 * (runtime/src/tn93-wasm.js's header has the decision and the reason), so the three files under
 * `static/tn93/` are not an optimisation here: WITHOUT THEM THIS ROUTE CANNOT PRODUCE A DATE AT
 * ALL. `tn93Base` is therefore required in practice — `/time` sets it on every request — and a
 * missing base, a failed fetch or a sha256 mismatch is a refusal the page renders as such, with the
 * loader's stage, the vendored release and both hashes, rather than a slower run.
 * MEASURED (korber, 143 sequences x 2,943 nt, Node): the rectangular matrix is 142 comparisons,
 * not 143^2, so the compiled engine is 13.2 ms against the deleted port's 4.2 — the one shape where
 * it was slower, because the fixed cost of two FASTA files and a CLI invocation dominates 142 pairs.
 * That is the price of one engine across the product, and it was accepted deliberately.
 *
 * WHY A WORKER AT ALL, AND WHAT THE RUN ACTUALLY COSTS — measured, because the obvious guess is
 * wrong. `compute_tree_free_divergences` measures divergence to ONE root, so it is N comparisons of
 * width L, not N²; the consensus it may have to build first is another O(N·L) pass. Measured on the
 * development machine in Node, one thread, warm (three runs, best of):
 *
 *     143 sequences × 2,943 nt    32 ms to a named root    30 ms to a consensus
 *     1,500 × 2,943              156 ms                   288 ms
 *     3,000 × 2,943              276 ms                   538 ms
 *
 * So this is NOT the minutes-long job the plan's cost note anticipated for the model path, and a
 * reader with a surveillance-sized upload is not waiting. The worker is still the right home for it:
 * a third of a second of synchronous character work on the main thread drops frames on the table the
 * reader is looking at, the numbers above are a warm JIT on one machine rather than a promise about
 * anyone's laptop, and — the reason that cannot be designed around — a main-thread loop cannot be
 * cancelled. `runDating` checks its AbortSignal at every phase boundary and throws an `AbortError`,
 * which `serve.ts` relays by name and the page treats as "keep the previous estimate".
 *
 * WHAT IT POSTS BACK is deliberately smaller than what `runDating` returns. The result carries the
 * fitted vectors, the residuals, the training-index list, the full model records with their typed
 * arrays and the raw divergences — all structured-cloneable, and all of it either already in the
 * record (`record.ols`, `record.spline`, `taxa_summary`) or derivable from it. The page stores this
 * response in IndexedDB, so sending the arrays would double the stored size of every review for
 * nothing.
 */

import { runDating } from '@veg/hyphaeon-runtime/dating';
import { resolveTn93Options } from '@veg/hyphaeon-runtime/tn93-wasm';
import { serve } from './serve';
import type { DatingRequest, DatingResponse } from './protocol';

/** Where the page serves the compiled TN93 from; strings only, as temporal.worker.ts does. */
function tn93Sources(base: string): { glueUrl: string; wasmUrl: string; manifestUrl: string } {
	const prefix = base.replace(/\/+$/, '');
	return { glueUrl: `${prefix}/tn93.mjs`, wasmUrl: `${prefix}/tn93.wasm`, manifestUrl: `${prefix}/MANIFEST.json` };
}

serve<DatingRequest, DatingResponse>(async (payload, ctx) => {
	const started = Date.now();
	// `runDating` is synchronous and this loader is not, so the resolution happens HERE and the
	// resolved `{pairwiseDistances}` is handed in. `'cross'` is the rectangular hook, which is the
	// one `computeTreeFreeDivergences` calls; handing it the square provider would silently return
	// row 0 of a square matrix as every taxon's distance to the root (tn93-wasm.js guards it).
	if (!payload.tn93Base) {
		// There is no engine to fall back to, so this is a refusal and not a slower path. It names the
		// missing input rather than letting the loader report "glueUrl and wasmUrl are required".
		throw new Error(
			'No TN93 engine URLs were given (tn93Base), so the root-to-tip divergences cannot be ' +
				'computed: veg/tn93\'s compiled build is the only TN93 in this product. The page serves it ' +
				'from static/tn93/ (tn93.mjs, tn93.wasm, MANIFEST.json); check that the build copied them.'
		);
	}
	const tn93 = await resolveTn93Options({ shape: 'cross', wasm: tn93Sources(payload.tn93Base) });
	const run = runDating({
		alignmentText: payload.alignmentText,
		alignmentName: payload.alignmentName,
		dates: { rows: payload.dates.map((d) => ({ taxon: d.taxon, value: d.value })) },
		rootTaxon: payload.rootTaxon,
		excludedTaxa: payload.excludedTaxa,
		clockModel: payload.clockModel,
		ciMethod: payload.ciMethod,
		timeUnits: payload.timeUnits,
		tn93Options: tn93.tn93Options,
		tn93Engine: tn93.tn93Engine,
		progress: ctx.progress,
		signal: ctx.signal,
		provenance: { surface: 'web-time' }
	});
	return {
		ok: run.ok,
		refusal: run.refusal,
		warnings: run.warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message, data: w.data })),
		record: run.record,
		rows: run.rows,
		activeName: run.activeName,
		selectedClock: run.selectedClock,
		ensemble: run.ensemble,
		rootDescription: run.rootDescription,
		rootCase: run.rootCase,
		elapsedMs: Date.now() - started,
		// Phase 4 gave the response a `model` block. This worker's whole purpose is that it is null
		// here — `modelUnavailableReason` is what the record then says instead, and the section turns
		// it into the two rows naming what did not run.
		model: null
	};
});
