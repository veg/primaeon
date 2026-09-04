/**
 * tree.worker.ts — HyPhy WASM in its own worker: HKY85 branch lengths for a topology-only tree,
 * or a neighbour-joining tree when none was given.
 *
 * WHY THIS FILE EXISTS. PLAN.md D5/D6 and §4.2: "no branch lengths → HyPhy WASM HKY85; no tree
 * → NJ via HyPhy WASM"; axomeme3's silent star-tree fallback is dropped. The runtime's
 * `createHyPhy` (runtime/src/hyphy/index.js) is the driver — axomeme3's and DataMonkey 3's HBL
 * scripts over the vendored 2.5.98 build — and it says `callMain` is synchronous and blocks the
 * thread for the whole optimisation (camelid's 212-taxon HKY85 fit is ~3 s), so it runs here and
 * never on the main thread. It also says the Emscripten glue in a MODULE worker is loaded by
 * fetch + `new Function` ('eval' strategy; `importScripts` does not exist in module workers), for
 * which DataMonkey's `_headers` already grant 'unsafe-eval'.
 *
 * The HyPhy handle is created once per worker life (the WebAssembly.Module is compiled once and
 * every run instantiates a fresh module from it, as axomeme3 does); `hyphyBase` is the absolute
 * URL prefix of the vendored files, resolved by the page under `paths.base`.
 *
 * The alignment is handed to HyPhy as given (`ReadDataFile` sniffs FASTA / NEXUS / PHYLIP); an
 * embedded tree is cut out of the alignment text (lib/analyze/newick.ts) when branch lengths are
 * to be fitted on it. What comes back is the tool's Newick, unparsed and unsanitised — the
 * runtime's `loadAlignmentAndTree` applies dataset.py's enforce_nonzero_branch_lengths and the
 * diagnostics report negative or saturated lengths (treeSanitation.js) — plus HyPhy's status
 * lines as `notes`.
 */

import { createHyPhy, HYPHY_WASM_VERSION } from '@veg/hyphaeon-runtime/hyphy';
import { embeddedNewick } from '$lib/analyze/newick';
import { serve } from './serve';
import type { TreeRequest, TreeResponse } from './protocol';

type HyPhyHandle = Awaited<ReturnType<typeof createHyPhy>>;

let handlePromise: Promise<HyPhyHandle> | null = null;
let handleBase: string | null = null;

function hyphyFor(base: string, progress: (phase: string, done: number, total: number, message: string) => void): Promise<HyPhyHandle> {
	if (!handlePromise || handleBase !== base) {
		handleBase = base;
		// scripts/copy-assets.mjs vendors the build under static/wasm/hyphy/<version>/.
		const prefix = `${base.endsWith('/') ? base : `${base}/`}${HYPHY_WASM_VERSION}/`;
		handlePromise = createHyPhy({
			locateFile: (name: string) => `${prefix}${name}`,
			glueStrategy: 'auto',
			progress
		});
		handlePromise.catch(() => {
			handlePromise = null;
		});
	}
	return handlePromise;
}

serve<TreeRequest, TreeResponse>(async (req, ctx) => {
	const t0 = performance.now();
	const notes: string[] = [];
	const progress = (phase: string, done: number, total: number, message: string) => {
		if (phase === 'run' && message) notes.push(message);
		ctx.progress(phase, done, total, message);
	};
	ctx.progress('load', 0, 1, 'Loading HyPhy WASM (first use only)...');
	const hyphy = await hyphyFor(req.hyphyBase, progress);
	if (ctx.signal.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}

	if (req.treeText === null) {
		ctx.progress('run', 0, 1, 'Inferring a neighbour-joining tree (TN93 distances)...');
		const nj = await hyphy.njTree(req.alignmentText, { progress });
		const treeText = nj.result.trim().endsWith(';') ? nj.result.trim() : `${nj.result.trim()};`;
		return { treeText, treeSource: 'nj', elapsedMs: Math.round(performance.now() - t0), notes: notes.slice(-20) };
	}

	const topology = req.treeText.trim() ? req.treeText : embeddedNewick(req.alignmentText);
	if (!topology) throw new Error('No tree to fit branch lengths on');
	ctx.progress('run', 0, 1, 'Fitting HKY85 branch lengths on the given topology...');
	const fit = await hyphy.estimateBranchLengths(req.alignmentText, topology, { progress });
	const treeText = fit.result.trim().endsWith(';') ? fit.result.trim() : `${fit.result.trim()};`;
	return {
		treeText,
		treeSource: 'hyphy-hky85',
		elapsedMs: Math.round(performance.now() - t0),
		notes: notes.slice(-20)
	};
});
