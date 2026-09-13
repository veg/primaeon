/**
 * datingModel.worker.ts — the ancestor-date run WITH the model: one forward pass through
 * `<variant>_taxa.onnx` over every codon, then the same `runDating` the model-free worker calls,
 * with the two matrices handed in.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A FIFTH WORKER RATHER THAN A SECOND REQUEST KIND ON EITHER
 * OF THE TWO IT SITS BETWEEN.
 *
 *   - NOT on `dating.worker.ts`. That worker's entire claim is its import graph:
 *     `@veg/hyphaeon-runtime/dating` reaches `@veg/hyphaeon-js` and nothing else, so the route that
 *     reviews dates cannot fetch a graph or an ORT binary even by accident, and `e2e/time.spec.ts`
 *     proves it by watching the network. Adding a model branch there would put `loadTaxaGraph` in
 *     the bundle of the worker the page starts for every estimate, and the proof would become a
 *     promise. The two workers are the mechanism; keeping them apart is the point.
 *   - NOT on `analyze.worker.ts`. That worker keeps one warm BACKBONE session for the report's
 *     pillars. This pass loads a DIFFERENT artifact (`<variant>_taxa.onnx`, 7.3 MB beside the
 *     backbone's 7.7 MB), over a different site set and a different taxon set — every codon rather
 *     than the variable ones, no cap and no duplicate pruning (`datingNeural.js` notes 1-3) — so
 *     there is nothing to share but the ORT WASM, which the browser caches by URL anyway. Reaching
 *     the report's worker from `/time` would also drag the whole orchestrator into this route's
 *     dependency graph for no benefit.
 *
 * THE COST IS THE WHOLE REASON THE RUN IS AN OPT-IN, and the page states it before the reader
 * clicks. A 7.3 MB download on the first run, then a full forward pass over the alignment:
 * measured on the development machine in Node at 4 threads, korber's 143 sequences × 981 codons is
 * 7.3 s in 13 calls of 78 sites. The model-free estimate on the same file is 0.35 s and loads
 * nothing. Progress is per batch and cancellation is the same `AbortError` contract every worker
 * here checks; `runDatingModelPass` honours the signal at every batch boundary and `runDating` at
 * every phase boundary, so a cancel is bounded by one batch rather than by the run.
 *
 * WHAT IT SENDS BACK is exactly `DatingResponse` plus a `model` block, so the page holds ONE shape
 * whether or not the model ran and the section renders from `record` either way. The two matrices
 * (N² + N·384 float64, 1.3 MB at 256 taxa) stay in this worker: they are inputs to the estimators,
 * not results, and posting them would double the stored size of every review to no end.
 */

import { loadManifest, modelLocation, pickVariant, runDatingModelPass } from '@veg/hyphaeon-runtime';
import type { Manifest } from '@veg/hyphaeon-runtime';
import { runDating } from '@veg/hyphaeon-runtime/dating';
import { isSessionLoaded, loadTaxaGraph } from '@veg/hyphaeon-runtime/web';
import { serve } from './serve';
import type { DatingModelRequest, DatingResponse } from './protocol';

let manifestPromise: Promise<Manifest> | null = null;
let manifestUrlLoaded: string | null = null;

function manifestFor(url: string): Promise<Manifest> {
	if (!manifestPromise || manifestUrlLoaded !== url) {
		manifestUrlLoaded = url;
		manifestPromise = loadManifest(url) as Promise<Manifest>;
		manifestPromise.catch(() => {
			manifestPromise = null;
		});
	}
	return manifestPromise;
}

serve<DatingModelRequest, DatingResponse>(async (payload, ctx) => {
	const started = Date.now();
	const manifest = await manifestFor(payload.manifestUrl);
	const variant = pickVariant(manifest, payload.variant ?? undefined);

	// The manifest is the only thing that knows whether this build has the artifact at all, and a
	// missing `taxa_onnx_sha256` is a fact about the build, not a failure of the run. It is raised
	// as a plain Error so the page can say which and why rather than showing a stalled button; the
	// runtime's own refusal vocabulary covers everything downstream of a graph that DOES load.
	if (!variant.taxaOnnxSha256 || !variant.taxaOnnxFile) {
		throw new Error(
			`models/manifest.json declares no dating graph for the ${variant.name} model, so the two ` +
				`model-based estimators cannot run. They need <variant>_taxa.onnx, which emits the ` +
				`taxon-by-taxon attention block and the per-taxon embeddings; the backbone carries the root ` +
				`token's attention row and the root token's vector, and neither is derivable from the other.`
		);
	}

	const prefix = payload.modelsBase.replace(/\/+$/, '');
	const sessionOptions = {
		modelUrl: `${prefix}/${variant.taxaOnnxFile}`,
		expectedSha256: variant.taxaOnnxSha256,
		ortWasmPath: payload.ortBase,
		numThreads: Math.max(1, Math.floor(payload.numThreads || 1))
	};
	const firstLoad = !isSessionLoaded(sessionOptions);
	ctx.progress(
		'dating-model',
		0,
		1,
		firstLoad
			? `Downloading the ${variant.name} dating graph and the ONNX runtime (first run only)…`
			: `Preparing the ${variant.name} dating graph…`
	);
	const session = await loadTaxaGraph(sessionOptions);

	const pass = await runDatingModelPass({
		// The RAW text, not a parsed map: `*` is rewritten to `-` inside the pass because the TN93
		// matrix it builds is a model INPUT, and the two conventions are two different forward passes
		// (datingNeural.js note 4). Handing over sequences we parsed here would put that decision on
		// this file, which is the wrong place for it.
		alignmentText: payload.alignmentText,
		session,
		manifest,
		progress: ctx.progress,
		signal: ctx.signal
	});

	const run = runDating({
		alignmentText: payload.alignmentText,
		alignmentName: payload.alignmentName,
		dates: { rows: payload.dates.map((d) => ({ taxon: d.taxon, value: d.value })) },
		rootTaxon: payload.rootTaxon,
		excludedTaxa: payload.excludedTaxa,
		clockModel: payload.clockModel,
		ciMethod: payload.ciMethod,
		distanceMode: payload.distanceMode,
		neural: pass,
		timeUnits: payload.timeUnits,
		progress: ctx.progress,
		signal: ctx.signal,
		provenance: {
			surface: 'web-time',
			model_variant: variant.name,
			model_artifact_sha256: session.sha256 ?? variant.taxaOnnxSha256
		}
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
		model: {
			variant: variant.name,
			sha256: session.sha256 ?? variant.taxaOnnxSha256,
			file: variant.taxaOnnxFile,
			numThreads: session.numThreads ?? 1,
			crossOriginIsolated: globalThis.crossOriginIsolated === true,
			firstLoad,
			taxa: pass.N,
			codons: pass.L,
			passSeconds: pass.elapsedSeconds
		}
	};
});
