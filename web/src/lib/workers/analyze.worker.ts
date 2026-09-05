/**
 * analyze.worker.ts — every analysis on one dataset, in one Web Worker: manifest, hash-verified
 * ORT sessions (backbone + BUSTED head), the runtime's `runEverything` orchestrator, and one
 * `section` message per finished section (many for the digital DMS as it fills).
 *
 * WHY THIS FILE EXISTS, AND WHY ONE WORKER FOR THE WHOLE ORCHESTRATOR. PLAN.md §4.0 (D21): the
 * user uploads, everything runs, one report streams in. PLAN.md §4.2 allowed two designs for the
 * pillars — "each in a worker with progress callbacks", or the runtime's own orchestration in one
 * worker. This is the second, for the same reasons infer.worker.ts gave for `runMeme` and two
 * that are new with Phase 2:
 *
 *   - Every pillar reads the SAME forward pass. The attention (`mean_root_attns`) that the
 *     epistasis network needs comes out of the site-selection pass; the omnibus needs its LRTs
 *     and `root_repr`; attribution and the filter re-score the same prepared tensors; DMS
 *     mutates the same token bundle. Per-phase workers would copy an [L, N] attention matrix
 *     and an N² distance matrix through `postMessage` between every phase, and hold two ORT
 *     sessions (one per worker) for one graph.
 *   - Ordering and cancellation are the orchestrator's (runtime/src/analyze.js): it decides
 *     that DMS runs last and progressively, checks the work cap, and honours one AbortSignal
 *     at every batch boundary. The page only relays `progress` and `section` events and, on
 *     cancel, aborts the one request. A per-phase adapter would re-implement that order in
 *     the app, where the MCP's `hyphaeon_analyze` and the server could not share it.
 *
 *   The tree tools stay in their own worker (tree.worker.ts): HyPhy's Emscripten heap and ORT's
 *   never share one WASM memory, and the page has already fitted branch lengths (or built an NJ
 *   tree) before this worker is asked to run — the same handoff run.ts made for `runMeme`.
 *
 * ONE ORCHESTRATOR. Phase 2b's integration removed the interim bridge (runMeme + runBusted posted
 * as the sites/attribution/gene sections with epistasis/filter/dms marked unavailable) once
 * `runEverything` was a permanent export of @veg/hyphaeon-runtime; the response's
 * `orchestrator` field stays so stored records name what produced them.
 *
 * THREADS AND URLS are as in infer.worker.ts: `numThreads` is honoured only when this worker's
 * scope is cross-origin isolated; the page resolves the model, manifest and ORT URLs against the
 * document because a worker's `location` is the bundle.
 */

import { runEverything, loadManifest, pickVariant, modelLocation } from '@veg/hyphaeon-runtime';
import type { Manifest, RuntimeSessionHandle } from '@veg/hyphaeon-runtime';
import { loadSession, loadBustedHead, isSessionLoaded } from '@veg/hyphaeon-runtime/web';
import { serve } from './serve';
import type { AnalyzeRequest, AnalyzeResponse } from './protocol';

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

function abortError(): Error {
	const err = new Error('Cancelled');
	err.name = 'AbortError';
	return err;
}

serve<AnalyzeRequest, AnalyzeResponse>(async (req, ctx) => {
	// --- models ---------------------------------------------------------------------------------
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
		'prepare',
		0,
		1,
		firstLoad
			? `Downloading the ${variant.name} model and the ONNX runtime (first run only)...`
			: `Preparing the ${variant.name} model...`
	);
	const session = await loadSession(sessionOptions);
	if (ctx.signal.aborted) throw abortError();

	let head: RuntimeSessionHandle | null = null;
	if (variant.bustedHeadFile && variant.bustedHeadSha256) {
		const prefix = req.modelsBase.replace(/\/+$/, '');
		try {
			head = await loadBustedHead({
				modelUrl: `${prefix}/${variant.bustedHeadFile}`,
				expectedSha256: variant.bustedHeadSha256,
				ortWasmPath: req.ortBase,
				numThreads: 1
			});
		} catch (err) {
			// The gene section then carries the statistical fields only, as the fixtures do.
			ctx.progress('prepare', 1, 1, `BUSTED head not loaded (${(err as Error).message}); statistics only.`);
			head = null;
		}
	}
	if (ctx.signal.aborted) throw abortError();
	ctx.progress('prepare', 1, 1, `Model ready (${session.numThreads} thread${session.numThreads === 1 ? '' : 's'})`);

	const common = {
		alignmentText: req.alignmentText,
		treeText: req.treeText || null,
		session,
		head,
		surface: 'browser',
		signal: ctx.signal,
		progress: ctx.progress,
		// A web session handle carries the URL and the sha256 only; the manifest names the rest.
		provenance: {
			model_version: manifest.model_version,
			model_variant: variant.name,
			artifact_sha256: session.sha256,
			reference_version: manifest.reference_version ?? null
		}
	};

	// --- the orchestrator -------------------------------------------------------------------------
	const record = (await runEverything({
		...common,
		inputs: req.inputs,
		options: {
			...req.options,
			treeSource: req.treeSource,
			requireBranchLengths: true,
			alignmentName: req.inputs.alignmentName,
			treeName: req.inputs.treeName
		},
		onSection: (name, payload, meta) => ctx.section(name, payload, Boolean(meta?.final))
	})) as AnalyzeResponse['record'];
	return {
		record,
		numThreads: session.numThreads,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		firstLoad,
		orchestrator: 'runtime'
	};
});
