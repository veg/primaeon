/**
 * analyze.worker.ts — every analysis on one dataset, in one Web Worker: manifest, hash-verified
 * ORT sessions (backbone + BUSTED head), the runtime's `runEverything` orchestrator, one
 * `section` message per finished section (many for the digital DMS as it fills), and — on a
 * second request kind — the on-demand phenotype run.
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
 *   Phase 1 and 2 had a THIRD worker for the tree, because fitting branch lengths meant a second
 *   WebAssembly engine with its own heap. D22 removed it: a tree with branch lengths is used as
 *   given, and without one the library takes TN93 distances into the MDS inside
 *   `loadAlignmentAndTree`. Nothing is prepared before this worker runs any more.
 *
 * THE PHENOTYPE REQUEST (Phase 3). The trait belongs to the reader, so the pillar cannot run with
 * the rest; `kind: 'phenotype'` is a second request on THIS worker rather than a worker of its
 * own, for the first reason above — it reads the same graph, from the same warm ORT session, over
 * the same prepared tensors, and a worker of its own would load a second copy of a 7.8 MB model to
 * answer a question that takes seconds. The runtime's `runPhenotype` (runtime/src/phenotype.js) is
 * the orchestration, the same contract the MCP's `hyphaeon_phenotype` calls, so the two surfaces
 * cannot drift; this worker only supplies the session and relays progress.
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
import { prepareRun, runPhenotype } from '@veg/hyphaeon-runtime';
import { serve } from './serve';
import {
	isPhenotypeRequest,
	type AnalyzeResponse,
	type AnalyzeWorkerRequest,
	type AnalyzeWorkerResponse,
	type PhenotypeRequest,
	type PhenotypeResponse
} from './protocol';
import { traitToPhenotypeOptions } from '$lib/api';

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

/**
 * Where the page serves the compiled TN93 from. STRINGS ONLY: this object travels inside the run's
 * `options`, which is structured-cloned across the worker boundary and stored with the record, so
 * anything unclonable here (a promise, a fetched object) fails the whole run with "could not be
 * cloned". The runtime fetches the manifest itself and verifies the wasm against it.
 */
function tn93Sources(base: string): { glueUrl: string; wasmUrl: string; manifestUrl: string } {
	const prefix = base.replace(/\/+$/, '');
	return {
		glueUrl: `${prefix}/tn93.mjs`,
		wasmUrl: `${prefix}/tn93.wasm`,
		manifestUrl: `${prefix}/MANIFEST.json`
	};
}

function abortError(): Error {
	const err = new Error('Cancelled');
	err.name = 'AbortError';
	return err;
}

/** The graph both request kinds need: manifest, variant, verified backbone session, BUSTED head. */
async function prepareModels(
	req: AnalyzeWorkerRequest,
	ctx: { progress: (phase: string, done: number, total: number, message: string) => void; signal: AbortSignal },
	wantHead: boolean
) {
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
	if (wantHead && variant.bustedHeadFile && variant.bustedHeadSha256) {
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
	return { manifest, variant, session, head, firstLoad };
}

serve<AnalyzeWorkerRequest, AnalyzeWorkerResponse>(async (req, ctx) => {
	if (isPhenotypeRequest(req)) return phenotype(req, ctx);
	const { manifest, variant, session, head, firstLoad } = await prepareModels(req, ctx, true);

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
			// A HINT only: the library decides inside `loadAlignmentAndTree` whether the tree is
			// usable and otherwise goes tree-free, and the provenance it writes is authoritative.
			// (Phase 2 also passed `requireBranchLengths: true` here, which asked the runtime to
			//  refuse a tree without lengths because the page had fitted them beforehand. D22
			//  removed both the fit and the refusal.)
			treeSource: req.treeSource,
			alignmentName: req.inputs.alignmentName,
			treeName: req.inputs.treeName,
			// The compiled TN93 (veg/tn93 v1.0.17) when the page served it, else the library's
			// JavaScript: `prepareRun` falls back on any load failure and records which ran in
			// `preprocessing.tn93_engine`. Only a tree-free run reaches either.
			...(req.tn93Base ? { tn93Wasm: tn93Sources(req.tn93Base) } : { tn93Engine: 'js' })
		},
		onSection: (name, payload, meta) => ctx.section(name, payload, Boolean(meta?.final))
	})) as unknown as AnalyzeResponse['record'];
	return {
		record,
		numThreads: session.numThreads,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		firstLoad,
		orchestrator: 'runtime'
	};
});

/**
 * One `hyphaeon phenotype` run against the report's own inputs.
 *
 * WHY IT PREPARES THE ALIGNMENT AGAIN. `runPhenotypeForReport` (runtime/src/analyze.js) is the
 * cheap path: it reuses the meme pass's attention off a LIVE record and costs no forward pass. A
 * record that has been through IndexedDB has lost those handles by design — an [L, N] attention
 * matrix does not belong in a browser database — and the report page is usually reading exactly
 * such a record (a reload, a gallery file, another day). So this takes the other path the runtime
 * documents: `prepareRun` on the same texts with the same options, which reproduces the same
 * `LoadedAlignment` deterministically, and `runPhenotype` with the session, which runs the
 * reference's own all-sites attribution loop. That loop is what `hyphaeon phenotype` itself does,
 * and epistasis.js measures the two attention sources as agreeing on every edge and sector.
 *
 * The trait goes to the runtime as the reader's OPTIONS, never as a ready vector: the library
 * resolves it itself that way and `phenotype_meta.description` comes out identical to the CLI's,
 * where a bare `y` would produce an empty description (PHASE3A.md, "The two shapes of
 * runPhenotypeAssociation's trait input are not equivalent, by design").
 *
 * Permulations need a tree with branch lengths. The request carries the tree the report used and
 * the runtime decides; a tree-free report gets `permulations: {reason: 'tree-free', detail}` back
 * and the panel prints that detail where the gene-level empirical p would have been.
 */
async function phenotype(
	req: PhenotypeRequest,
	ctx: { progress: (phase: string, done: number, total: number, message: string) => void; section: (name: string, payload: unknown, final: boolean) => void; signal: AbortSignal }
): Promise<PhenotypeResponse> {
	const t0 = performance.now();
	// No BUSTED head: the phenotype pillar reads `lrt` and `mean_root_attns` only.
	const { session, firstLoad } = await prepareModels(req, ctx, false);
	const prepared = await prepareRun({
		alignmentText: req.alignmentText,
		treeText: req.treeText || null,
		options: {
			maxSpecies: req.options.maxSpecies,
			referenceSequence: req.options.referenceSequence,
			treeSource: req.treeSource,
			useTn93: req.treeSource === 'tn93'
		},
		progress: ctx.progress,
		signal: ctx.signal
	});
	if (ctx.signal.aborted) throw abortError();
	const record = (await runPhenotype({
		prepared,
		session,
		phenotype: traitToPhenotypeOptions(req.trait),
		options: {
			...req.phenotypeOptions,
			minTaxa: req.phenotypeOptions.minTaxaPerSite,
			permutations: req.options.permutations,
			browser: true
		},
		inputs: { alignment: req.inputs?.alignmentName ?? null, tree: req.inputs?.treeName ?? null },
		progress: ctx.progress,
		signal: ctx.signal
	})) as PhenotypeResponse['record'];
	return {
		record,
		numThreads: session.numThreads,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		firstLoad,
		elapsedMs: Math.round(performance.now() - t0)
	};
}
