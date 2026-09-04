/**
 * infer.worker.ts — the whole site-selection run in one Web Worker: manifest, hash-verified ORT
 * session, the runtime's `runMeme`, and the conversion to the stored record.
 *
 * WHY THIS FILE EXISTS, AND WHY ONE WORKER. PLAN.md §4.2 wants preprocessing and inference off
 * the main thread, and allowed two designs: an adapter that runs each of `runMeme`'s phases in
 * its own worker, or the whole `runMeme` inside one worker with the session created there. This
 * is the second, chosen because it is simpler and loses nothing:
 *
 *   - An `InferenceSession` cannot be posted between workers, so the session has to live where
 *     inference runs; putting `prepare` elsewhere would mean copying the prepared tensors (L·N
 *     tokens, N² distances, and the [b, N, N] batches) through `postMessage` for every batch.
 *   - `runMeme` already yields between batches and reports `progress(phase, done, total,
 *     message)` (runtime/src/pipeline.js), so a single worker gives the page the same phase
 *     granularity the adapter would, and cancellation through `AbortSignal` at the same points.
 *   - The main thread does nothing but relay progress; ORT's thread pool is spawned from this
 *     worker (nested workers), so the page stays responsive at any N.
 *
 * THREADS. `numThreads` is what the page asked for (`navigator.hardwareConcurrency`); the
 * runtime honours it only when `crossOriginIsolated` is true in THIS worker's scope (a worker
 * inherits the document's isolation) and reports the count it used, which the record keeps so
 * the e2e can assert threads engaged (PLAN.md D13).
 *
 * URLS ARE ABSOLUTE. A worker's `location` is the bundle under `_app/immutable/workers/`, so a
 * root-relative `/models/...` would be wrong under a `paths.base` prefix; the page resolves
 * `manifestUrl`, `modelsBase` and `ortBase` against the document and passes them in.
 *
 * THE SESSION IS MEMOISED BY THE RUNTIME (session-web.js keeps verified sessions keyed by
 * URL/hash/threads), so a second run on the same variant skips the ~21 MB download and the graph
 * optimisation; `firstLoad` in the response tells the page which case it was. The manifest is
 * fetched once per worker life.
 */

import { runMeme, loadManifest, pickVariant, modelLocation } from '@veg/hyphaeon-runtime';
import type { Manifest, RuntimeMemeResult } from '@veg/hyphaeon-runtime';
import { loadSession, isSessionLoaded } from '@veg/hyphaeon-runtime/web';
import { toMemeRecord } from '$lib/analyze/record';
import { serve } from './serve';
import { CALL_MODES, type InferRequest, type InferResponse } from './protocol';

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

serve<InferRequest, InferResponse>(async (req, ctx) => {
	const t0 = performance.now();
	if (!CALL_MODES.includes(req.options.callMode)) {
		throw new Error(`Unknown call mode "${req.options.callMode}"`);
	}

	// --- model ---------------------------------------------------------------------------------
	const manifest = await manifestFor(req.manifestUrl);
	const variant = pickVariant(manifest, req.options.variant);
	const modelUrl = modelLocation(req.modelsBase, manifest, variant.name);
	const requestedThreads = Math.max(1, Math.floor(req.numThreads || 1));
	const sessionOptions = {
		modelUrl,
		expectedSha256: variant.onnxSha256,
		ortWasmPath: req.ortBase,
		numThreads: requestedThreads
	};
	const firstLoad = !isSessionLoaded(sessionOptions);
	ctx.progress(
		'load',
		0,
		1,
		firstLoad
			? `Downloading the ${variant.name} model and the ONNX runtime (first run only)...`
			: `Preparing the ${variant.name} model...`
	);
	const session = await loadSession(sessionOptions);
	if (ctx.signal.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}
	ctx.progress('load', 1, 1, `Model ready (${session.numThreads} thread${session.numThreads === 1 ? '' : 's'})`);

	// --- run -----------------------------------------------------------------------------------
	const phaseMs: Record<string, number> = {};
	let currentPhase: string | null = null;
	let phaseStart = performance.now();
	const progress = (phase: string, done: number, total: number, message: string) => {
		if (phase !== currentPhase) {
			const now = performance.now();
			if (currentPhase) phaseMs[currentPhase] = (phaseMs[currentPhase] ?? 0) + (now - phaseStart);
			currentPhase = phase;
			phaseStart = now;
		}
		ctx.progress(phase, done, total, message);
	};

	const raw = (await runMeme({
		alignmentText: req.alignmentText,
		treeText: req.treeText,
		options: {
			callMode: req.options.callMode,
			maxSpecies: req.options.maxSpecies,
			referenceSequence: req.options.referenceSequence ?? undefined,
			treeSource: req.treeSource,
			// The page estimated a tree when one was needed (lib/analyze/run.ts); a tree still without
			// branch lengths here is a bug to surface, not a case to paper over with 1e-3 defaults.
			requireBranchLengths: true,
			filter: req.options.filter,
			attribute: req.options.attribute,
			alignmentName: req.name
		},
		session,
		progress,
		surface: 'browser',
		signal: ctx.signal,
		provenance: {
			model_version: manifest.model_version,
			model_variant: variant.name,
			artifact_sha256: session.sha256,
			reference_version: manifest.reference_version ?? null
		}
	})) as RuntimeMemeResult;
	if (currentPhase) phaseMs[currentPhase] = (phaseMs[currentPhase] ?? 0) + (performance.now() - phaseStart);

	const result = toMemeRecord(raw, {
		alignmentText: req.alignmentText,
		treeText: req.treeText,
		treeSource: req.treeSource,
		options: req.options,
		name: req.name,
		createdAtIso: new Date().toISOString(),
		versions: {
			ort_threads: session.numThreads,
			cross_origin_isolated: globalThis.crossOriginIsolated === true ? 1 : 0,
			model_bytes: session.bytes,
			worker_wall_ms: Math.round(performance.now() - t0)
		}
	});

	return {
		result,
		numThreads: session.numThreads,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		phaseMs,
		firstLoad
	};
});
