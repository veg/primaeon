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
 * library's signature has no `tn93Options`, so it computed that matrix with the JavaScript port
 * while the analyze worker two clicks later used veg/tn93's compiled build. `diagnoseUpload`
 * (runtime/src/pipeline.js) is the same `diagnose()` with the resolved engine handed in through its
 * existing `parsed` argument. MEASURED per process, median of 7, alignment only and no tree:
 * camelid 212 taxa 200 ms compiled against 373 ported, HIV1_RT 475 taxa 981 ms against 2,776 — with
 * an IDENTICAL diagnosis either way (same warning codes and severities, byte-identical summary, all
 * five bundled examples). This runs on a debounce as the reader types, so it is the one place in
 * the product where that difference is felt directly. Below the loader's measured break-even the
 * compiled engine's fixed load costs more than the whole matrix (bat_oas1, 18 taxa: 44 ms against
 * 14), so `auto` sizes the job and takes the port there on purpose.
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
		// Without URLs there is nothing to load, so ask for the port by name rather than letting
		// `auto` try, fail and attach a fallback reason that says only "the page served no files".
		tn93Engine: wasm ? 'auto' : 'js',
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
		// The run's own answer, read off the diagnosis rather than off the request: `auto` falls back
		// to the port when the module will not load, and takes it deliberately below the break-even.
		tn93Engine: diagnosis.tn93_engine,
		names,
		prescreen,
		elapsedMs: performance.now() - t0
	};
});
