/**
 * temporal.worker.ts — one `hyphaeon temporal` run in a worker: prepare the alignment, load and
 * verify the backbone graph, score every codon once, and hand the page three payloads as they land.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A SIXTH WORKER. The argument is in `protocol.ts` beside
 * `TemporalRequest`, and it is the same one that keeps `dating.worker.ts` and
 * `datingModel.worker.ts` apart: the date-review worker's import graph is the PROOF that reviewing
 * dates costs no model byte, and this pillar's first step is a forward pass over every codon, so it
 * cannot live there. The report's analyze worker holds a warm session for `runEverything`, which
 * `/time` does not run.
 *
 * THREE PAYLOADS, AND THE MIDDLE ONE IS DELIBERATELY THIN.
 *
 *   1. `scored` — the whole deterministic half: LRTs, the static p and q, every trajectory and
 *      velocity, peaks, widths, areas and the stage-one candidate set. It is posted the moment stage
 *      one finishes, which is before the null has drawn a single shuffle, so the page can draw two
 *      figures and fill a table while the wait that follows is still ahead of it.
 *   2. `null` — `p_perm`, `q_perm` and the permutation block, per chunk. NOT the record: the
 *      runtime's interim payload is a whole record whose arrays are shared references (free to
 *      build), but `postMessage` structured-clones what it is given, and the curve block alone is
 *      `2 · L · T` float64 — 17.5 MB on the acceptance alignment at the default grid. Posting that
 *      five times a second to deliver ten kilobytes of p-values would make the progress indicator
 *      the most expensive thing in the run. The page merges the two columns into the record it
 *      already holds.
 *   3. `complete` — the record, with the wave modes and both classification columns.
 *
 * CANCELLING KEEPS WHAT WAS COMPUTED, and that is the runtime's contract rather than this file's
 * courtesy: `runTemporalNull` catches its own `AbortError`, records `cancelled` with the achieved
 * draw count, and `runTemporal` then finishes the classification and the wave modes and RETURNS a
 * complete record. So a cancel during the null resolves this request normally, with
 * `permutations.cancelled` true and p-values on a coarser grid. A cancel during the model pass is
 * different in kind — `inferSites` throws — and rejects, which is why the page's Stop button changes
 * its label between the two phases.
 *
 * WHAT IT DOES NOT DO. There is no date ingestion here (that is `runtime/src/dates/`, whose union of
 * three parsers is wider than the reference's own and must be reported rather than enjoyed, D31),
 * and no result semantics (that is `lib/time/temporal.ts`). This file is a session, a signal and
 * three `postMessage`s.
 */

import { loadManifest, modelLocation, pickVariant, prepareRun } from '@veg/hyphaeon-runtime';
import type { Manifest } from '@veg/hyphaeon-runtime';
import { runTemporal, temporalDownloadNotes, temporalReferenceCommand } from '@veg/hyphaeon-runtime/temporal';
import { isSessionLoaded, loadSession } from '@veg/hyphaeon-runtime/web';
import { serve } from './serve';
import type { TemporalRequest, TemporalResponse } from './protocol';

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

/** Where the page serves the compiled TN93 from; strings only, because this travels in `options`. */
function tn93Sources(base: string): { glueUrl: string; wasmUrl: string; manifestUrl: string } {
	const prefix = base.replace(/\/+$/, '');
	return { glueUrl: `${prefix}/tn93.mjs`, wasmUrl: `${prefix}/tn93.wasm`, manifestUrl: `${prefix}/MANIFEST.json` };
}

serve<TemporalRequest, TemporalResponse>(async (req, ctx) => {
	const started = Date.now();
	const manifest = await manifestFor(req.manifestUrl);
	const variant = pickVariant(manifest, req.variant ?? undefined);
	const modelUrl = modelLocation(req.modelsBase, manifest, variant.name);
	const sessionOptions = {
		modelUrl,
		expectedSha256: variant.onnxSha256,
		ortWasmPath: req.ortBase,
		numThreads: Math.max(1, Math.floor(req.numThreads || 1))
	};
	const firstLoad = !isSessionLoaded(sessionOptions);
	ctx.progress(
		'temporal-prepare',
		0,
		1,
		firstLoad
			? `Downloading the ${variant.name} model and the ONNX runtime (first run only)…`
			: `Preparing the ${variant.name} model…`
	);
	const session = await loadSession(sessionOptions);

	const prepared = await prepareRun({
		alignmentText: req.alignmentText,
		treeText: req.treeText || null,
		options: {
			maxSpecies: req.options.maxSpecies,
			// D22: a tree with usable branch lengths is used as given; without one the library takes
			// pairwise TN93 distances straight into the MDS, which is the reference's own `--use-tn93`.
			...(req.tn93Base ? { tn93Wasm: tn93Sources(req.tn93Base) } : { tn93Engine: 'js' })
		},
		progress: ctx.progress,
		signal: ctx.signal
	});

	const run = await runTemporal({
		loaded: prepared.loaded,
		// The rule table travels with the values: `beyond_reference` is a count of the dates the
		// reference's own parser could not have read, and it is null — not zero — without it.
		dates: {
			schema_version: 1,
			rows: req.dates.map((d) => ({ taxon: d.taxon, value: d.value })),
			by_rule: req.datesByRule,
			source: req.datesSource
		},
		session,
		options: {
			timeUnits: req.timeUnits,
			numTimePoints: req.options.numTimePoints,
			permutations: req.options.permutations,
			bandwidth: req.options.bandwidth,
			rootTaxon: req.options.rootTaxon,
			scoreInvariableSites: req.options.scoreInvariableSites,
			seed: req.options.seed
		},
		inputs: { alignment: req.alignmentName, tree: req.treeName },
		provenance: {
			surface: 'web-time',
			model_variant: variant.name,
			model_artifact_sha256: session.sha256 ?? variant.onnxSha256,
			num_threads: session.numThreads ?? 1,
			cross_origin_isolated: globalThis.crossOriginIsolated === true
		},
		progress: ctx.progress,
		signal: ctx.signal,
		onProgress: (raw: object) => {
			const payload = raw as Record<string, unknown>;
			const stage = payload.stage as string;
			if (stage === 'null') {
				ctx.section(
					'temporal',
					{ stage: 'null', p_perm: payload.p_perm, q_perm: payload.q_perm, permutations: payload.permutations },
					false
				);
				return;
			}
			ctx.section('temporal', { stage, record: payload }, stage === 'complete');
		}
	});

	const model = { variant: variant.name, file: modelUrl.split('/').pop() ?? `${variant.name}.onnx`, sha256: session.sha256 ?? variant.onnxSha256 };
	if (run && (run as { ok?: boolean }).ok === false) {
		const refusal = run as unknown as { refusal: string; message: string; warnings: Array<{ code: string; severity: string; message: string }> };
		return {
			record: null,
			refusal: { code: refusal.refusal, message: refusal.message, warnings: refusal.warnings ?? [] },
			numThreads: session.numThreads ?? 1,
			crossOriginIsolated: globalThis.crossOriginIsolated === true,
			firstLoad,
			elapsedMs: Date.now() - started,
			model,
			reference: null,
			downloadNotes: []
		};
	}
	const record = run as unknown as Record<string, unknown>;
	return {
		record,
		refusal: null,
		numThreads: session.numThreads ?? 1,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		firstLoad,
		elapsedMs: Date.now() - started,
		model,
		reference: temporalReferenceCommand(record, {
			alignment: req.alignmentName ?? undefined,
			tree: req.treeName ?? undefined,
			dates: req.datesSource === 'table' || req.datesSource === 'auspice' ? '<metadata>' : undefined
		}),
		downloadNotes: temporalDownloadNotes(record)
	};
});
