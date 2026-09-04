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
 * The prescreen (runtime/src/prescreen, DM3's XGBoost gate) reads a Newick STRING with branch
 * lengths. For a user tree that is the text as given; for a tree embedded in a NEXUS alignment
 * the TREE command's Newick is cut out with the same pattern `js/src/preprocess/tree.js` uses
 * (`extract_tree_from_string_or_file`, dataset.py:161-212, step 1). Its 735 KB model file is
 * loaded here through the runtime's `?raw` import, so the main bundle never carries it.
 */

import { diagnose, parseAlignmentSequences } from '@veg/hyphaeon-js';
import { estimateHitLikelihood, loadHitLikelihoodModel } from '@veg/hyphaeon-runtime/prescreen';
import { embeddedNewick } from '$lib/analyze/newick';
import { serve } from './serve';
import type { PrepRequest, PrepResponse } from './protocol';
import type { PrescreenResult } from '$lib/diagnostics/panel';

function sequenceNames(alignmentText: string): string[] {
	try {
		return Array.from(parseAlignmentSequences(alignmentText).keys());
	} catch {
		return [];
	}
}

serve<PrepRequest, PrepResponse>(async (req) => {
	const t0 = performance.now();
	const diagnosis = diagnose({
		alignmentText: req.alignmentText,
		treeText: req.treeText,
		maxSpecies: req.maxSpecies
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
		names,
		prescreen,
		elapsedMs: performance.now() - t0
	};
});
