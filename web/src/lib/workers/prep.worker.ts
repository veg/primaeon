/**
 * prep.worker.ts — the "Before you run" computation: the library's `diagnose()` and the runtime's
 * MEME hit-likelihood prescreen, off the main thread.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.3: the checks run "in the browser instantly" on every input
 * change. `diagnose` is not instant on a large paste — its model-level pass runs
 * `loadAlignmentAndTree` (patristic distances, Faith's PD, MDS) so that the numbers it reports are
 * the numbers the model would be given — and a 512-taxon MDS is a second or two of synchronous
 * work. Doing that on the main thread on every keystroke would freeze the textarea, so the page
 * debounces and posts here. The worker answers with the diagnosis, the sequence names in file
 * order (from the library's parser, which supersedes the header sniff for the reference-sequence
 * dropdown), and the prescreen result.
 *
 * IT RUNS THE SAME TN93 THE RUN WILL. `diagnose()`'s model-level pass calls
 * `loadAlignmentAndTree`, so a tree-free check computes the whole N x N distance matrix — and the
 * library's signature had no `tn93Options`, so it computed that matrix with the JavaScript port
 * while the analyze worker two clicks later used veg/tn93's compiled build. `diagnoseUpload`
 * (runtime/src/pipeline.js) is the same `diagnose()` with the resolved engine handed in. MEASURED
 * per process, median of 7, alignment only and no tree: camelid 212 taxa 200 ms compiled against
 * 373 in the port, HIV1_RT 475 taxa 981 ms against 2,776 — with an IDENTICAL diagnosis either way
 * (same warning codes and severities, byte-identical summary, all five bundled examples). This runs
 * on a debounce as the reader types, so it is the one place in the product where the compiled
 * engine's fixed ~90 ms load is felt directly on a small input (bat_oas1, 18 taxa: 44 ms against
 * 14). It is paid anyway: that port is deleted, and one engine everywhere is the point.
 *
 * SO A DIAGNOSIS CAN NOW SAY "NO ENGINE". The three files under `static/tn93/` are the only TN93
 * this page has; a failed fetch or a sha256 mismatch means a tree-free upload cannot be measured at
 * all. `diagnoseUpload` reports that rather than throwing — a `refuse`-level
 * `TN93_ENGINE_UNAVAILABLE` row carrying the stage, the vendored release, the files and both
 * hashes — so the panel shows a refusal a reader can act on and the Run button stays shut.
 *
 * The prescreen (runtime/src/prescreen, DM3's XGBoost gate) reads a Newick STRING with branch
 * lengths. For a user tree that is the text as given; for a tree embedded in a NEXUS alignment
 * the TREE command's Newick is cut out with the same pattern `js/src/preprocess/tree.js` uses
 * (`extract_tree_from_string_or_file`, dataset.py:161-212, step 1). Its 735 KB model file is
 * loaded here through the runtime's `?raw` import, so the main bundle never carries it.
 */

import { parseAlignmentSequences } from '@veg/hyphaeon-js';
import { diagnoseUpload } from '@veg/hyphaeon-runtime';
import { estimateHitLikelihood, loadHitLikelihoodModel } from '@veg/hyphaeon-runtime/prescreen';
import { embeddedNewick } from '$lib/analyze/newick';
import { serve } from './serve';
import type { PrepRequest, PrepResponse } from './protocol';
import type { PrescreenResult } from '$lib/diagnostics/panel';

/** Where the page serves the compiled TN93 from; strings only, as every other worker takes them. */
function tn93Sources(base: string): { glueUrl: string; wasmUrl: string; manifestUrl: string } {
	const prefix = base.replace(/\/+$/, '');
	return { glueUrl: `${prefix}/tn93.mjs`, wasmUrl: `${prefix}/tn93.wasm`, manifestUrl: `${prefix}/MANIFEST.json` };
}

function sequenceNames(alignmentText: string): string[] {
	try {
		return Array.from(parseAlignmentSequences(alignmentText).keys());
	} catch {
		return [];
	}
}

serve<PrepRequest, PrepResponse>(async (req) => {
	const t0 = performance.now();
	const wasm = req.tn93Base ? tn93Sources(req.tn93Base) : null;
	const diagnosis = await diagnoseUpload({
		alignmentText: req.alignmentText,
		treeText: req.treeText,
		maxSpecies: req.maxSpecies,
		// The URLs when the page served them, nothing when it did not: only a TREE-FREE diagnosis
		// loads the engine, so an upload with usable branch lengths is unaffected either way, and one
		// without gets the loader's own refusal (TN93_ENGINE_UNAVAILABLE, stage `no_sources`) as a
		// diagnostic row. There is no port to ask for instead.
		tn93Wasm: wasm
	});
	const names = sequenceNames(req.alignmentText);

	let prescreen: PrescreenResult | null = null;
	if (req.prescreen) {
		const tree = req.treeText ?? embeddedNewick(req.alignmentText);
		if (tree) {
			const model = await loadHitLikelihoodModel();
			prescreen = (await estimateHitLikelihood({
				method: 'meme',
				alignment: req.alignmentText,
				tree,
				treeSource: req.treeSource,
				model
			})) as unknown as PrescreenResult;
		}
	}

	return {
		diagnosis: {
			ok: diagnosis.ok,
			warnings: diagnosis.warnings,
			summary: diagnosis.summary
		},
		// The diagnosis's own answer, read off the result rather than off the request: `'wasm'` when
		// the compiled build measured this matrix, `'custom'` for a provider handed in, and null when
		// the upload used a tree, when it was too large to load, or when no engine could be reached
		// (in which case `diagnosis.warnings` carries the TN93_ENGINE_UNAVAILABLE refusal).
		tn93Engine: diagnosis.tn93_engine,
		names,
		prescreen,
		elapsedMs: performance.now() - t0
	};
});
