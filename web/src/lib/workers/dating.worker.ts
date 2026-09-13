/**
 * dating.worker.ts — the ancestor-date run, off the main thread and cancellable.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A FOURTH WORKER RATHER THAN A REQUEST ON THE ANALYZE ONE.
 * The analyze worker exists to keep ONE warm, hash-verified ORT session and the prepared tensors
 * every pillar reads; this run touches none of that. It loads no manifest, no graph and no
 * WebAssembly — its whole import graph is `@veg/hyphaeon-runtime/dating`, which reaches
 * `@veg/hyphaeon-js` and nothing else — and putting it on the analyze worker would drag ORT's
 * ~20 MB of WASM into a route whose entire claim is that it costs no model byte. `e2e/time.spec.ts`
 * asserts that claim by watching the network, and this file is the mechanism that makes it true.
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
import { serve } from './serve';
import type { DatingRequest, DatingResponse } from './protocol';

serve<DatingRequest, DatingResponse>((payload, ctx) => {
	const started = Date.now();
	const run = runDating({
		alignmentText: payload.alignmentText,
		alignmentName: payload.alignmentName,
		dates: { rows: payload.dates.map((d) => ({ taxon: d.taxon, value: d.value })) },
		rootTaxon: payload.rootTaxon,
		excludedTaxa: payload.excludedTaxa,
		clockModel: payload.clockModel,
		ciMethod: payload.ciMethod,
		timeUnits: payload.timeUnits,
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
