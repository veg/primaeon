/**
 * pipeline.js — the site-selection (`meme`) run, end to end, over a session someone else loaded.
 *
 * WHY THIS FILE EXISTS. PLAN.md §3.2: `runtime/` holds "pipeline orchestration (prep → MDS → infer
 * → postprocess) over the library". This is that orchestration for `meme`, rewritten in Phase 1b
 * over `@veg/hyphaeon-js` at veg/HyphAeon phase-1a so that the numbers it produces are the
 * numbers `hyphaeon meme` writes. It mirrors `cmd_meme` in hyphaeon/cli.py:51-327 phase for
 * phase, and keeps the phase-callback shape of datamonkey3's AxomemeAnalysisRunner.js
 * (main@fac1330) and datamonkey-js-server's predict.js (main@1e84d6f) that the browser worker,
 * the MCP tool and the job server wrap: `progress(phase, done, total, message)`.
 *
 *   parse        the alignment is parsed by the library's `parseAlignmentSequences`
 *                (dataset.py:59-159) to count taxa; < 3 is refused (veg/HyphAeon#7)
 *   prepare      `loadAlignmentAndTree` (dataset.py:523-730): tree, matching, duplicates, the
 *                `> 10` rescale, Faith's PD to the cap, MDS, tokens, the invariable mask — or,
 *                under PLAN.md D22, the reference's own TREE-FREE path (dataset.py:598-636):
 *                pairwise TN93 distances straight into the MDS whenever there is no usable tree.
 *                `decideTreePolicy` makes that call here, before the library, so the run records
 *                WHY (`tree_source`, `tree_free.reason`); a display-only tree is attached as
 *                `displayTree` — the user's own topology with unit lengths when the upload
 *                carried one, else NJ on the same distances (nj.js) — and the model never sees it
 *   infer        `predict_site_lrts` (inference.py:162-192): VARIABLE sites only, batched, the
 *                clamp at 0, float32; invariable sites are never sent to the graph
 *   stats        cli.py:99-100 — p = float32(pvals_from_lrt_meme(lrt)); q = float32(BH(p))
 *   filter       cli.py:111-218 (`--filter`), the cmd_meme copy of the OCI screen, through the
 *                library's `runAlignmentFilter` with `{cliVariant: true}`; when an artifact was
 *                masked the cleaned LRT / p / q / invariable replace the raw ones (cli.py:214-218)
 *   attribute    cli.py:257-277 (`--attribute`): `attribute_selection` on the ORIGINAL tokens with
 *                the (cleaned) LRTs as `base_lrts`
 *   postprocess  the per-site records of cli.py:280-296 (site, hyphaeon_lrt, p_value, q_value,
 *                is_invariable, + attribution fields), PLUS the app's own columns — DM3's z-score,
 *                percentile and tier call (postprocess.js / callModes.js) — attached as extra
 *                fields and never replacing the Python ones; provenance per PLAN.md §3.5; warnings
 *                from the library's `diagnose` (PLAN.md §4.3)
 *
 * THE SESSION IS AN ARGUMENT, NOT LOADED HERE. Loading is the surface's business (createSession.js
 * or the session modules directly) — it is the expensive, memoised, hash-verified step that must
 * not be triggered by a module import. Callers pass the handle `loadSession()` returned.
 *
 * WHAT IS MIRRORED AND WHAT IS THE APP'S:
 *   - Everything a Python field holds (`hyphaeon_lrt`, `p_value`, `q_value`, `is_invariable`, the
 *     attribution fields, `artifacts_masked`, `taxa_count`, `codon_count`) is the library's
 *     arithmetic on the library's tensors and is checked against `hyphaeon meme` by
 *     scripts/parity-node.mjs and test/parity-fixtures.test.js.
 *   - `zScore`, `percentile`, `call`, `refCodon`, `refAa`, `logLrt` are DM3's result semantics
 *     (percentile / z / q tiers, PLAN.md D11), computed over the variable sites, and are not in
 *     the Python. `isVariable` is `!is_invariable` — one source of truth, dataset.py:718-723.
 *   - The taxon cap defaults to 256 (manifest `default_taxon_cap`, PLAN.md §3.3) where the CLI's
 *     `--max-species` default is None (cli.py:1025); pass `maxSpecies: Infinity` for the CLI's
 *     behaviour (no cap — the parity runner does). The hard cap is 512.
 *   - THE TREE POLICY IS D22's, AND IT IS THE APP'S, NOT THE REFERENCE'S. A tree with branch
 *     lengths is used exactly as the reference uses it. No tree at all, and a tree whose branch
 *     lengths are missing or unusable (`hasNonzeroBranchLengths`, dataset.py:214-222), both take
 *     TN93 distances instead: the reference raises for the first (dataset.py:647-651) and shells
 *     out to HyPhy for the second (dataset.py:655-668), and Phase 3 removed HyPhy from this
 *     product, so `--use-tn93` — a flag there — is the DEFAULT here whenever a tree is absent.
 *     `../HyphAeon/PHASE3A.md` records the same two divergences on the library side, and
 *     `notices.treeFree.reason` names which one was taken ('requested' | 'no_tree' |
 *     'no_branch_lengths'). Unparseable tree TEXT still raises on both sides: that is a bad
 *     input, not a missing one. `options.requireBranchLengths` restores the old refusal for a
 *     caller that insists on a real tree.
 *   - Two cmd_meme quirks pass through unchanged because the library replicates them and the
 *     fixtures pin them: with an embedded tree and ≥ 1 masked artifact `--filter` fails at the
 *     cleaned reload ("No tree specified", cli.py:192), and the cleaned re-score reuses the
 *     baseline tree cache (cli.py:195-197). Both are upstream issues, not app policy.
 *
 * SURROGATE, NOT MEME. Every result carries `is_surrogate` / `surrogate_for` as data (PLAN.md
 * §2, hard truth 1). Nothing here presents the output as a completed selection analysis.
 */

import { tn93WasmOptions } from './tn93-wasm.js';
import {
	loadAlignmentAndTree,
	parseAlignmentSequences,
	extractTree,
	hasNonzeroBranchLengths,
	memeSitePq,
	runAlignmentFilter,
	attributeSelection,
	memeSiteRecords,
	attributionsOneIndexed,
	diagnose,
	TN93_MATCH_MODE,
	MAX_SPECIES_DEFAULT,
	MAX_SPECIES_CAP as LIBRARY_MAX_SPECIES_CAP
} from '@veg/hyphaeon-js';

import { buildPredictions, CALL_DEFAULTS } from './postprocess.js';
import { inferSites, predictFromSession, resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';
import { njTreeFromLoaded, newickFromTree, newickLabel } from './nj.js';

/** PLAN.md §3.5: the provenance block's schema version. */
export const SCHEMA_VERSION = 1;

/** Surfaces a caller may claim. PLAN.md §3.5. */
export const SURFACES = Object.freeze([
	'browser',
	'node-server',
	'mcp-stdio',
	'mcp-http',
	'python-reference'
]);

/**
 * Phases, in order. `filter` and `attribute` are reported only when requested. Progress is
 * reported at the start and end of each and per batch inside `infer`, `filter` and `attribute`.
 */
export const PHASES = Object.freeze(['parse', 'prepare', 'infer', 'stats', 'filter', 'attribute', 'postprocess']);

/**
 * Calling modes buildPredictions understands. An EXPLICIT `callMode` outside this list is refused
 * rather than coerced — a caller who typed "z-score" wants zscore semantics, not percentile ones
 * under a zscore label. A mode arriving only via `options.calling.mode` passes through untouched
 * (DM3 parity: buildPredictions falls to its else branch for a mode it does not recognise).
 */
export const CALL_MODES = Object.freeze(['percentile', 'zscore', 'pvalue']);

/**
 * The two refusals a caller can still ask for with `options.requireBranchLengths`. They are NOT
 * the default any more (PLAN.md D22: a missing tree is a tree-free run, not a refusal), so
 * nothing reaches a user through them unless a surface deliberately insisted on a real tree.
 * The first sentence of each is unchanged from DM3 AnalyzeTab.svelte:167-184 because
 * `mcp/src/engine.js` classifies input errors by matching it.
 */
export const NO_TREE_MESSAGE =
	'HyphAeon needs a phylogenetic tree. This run asked for one explicitly ' +
	'(requireBranchLengths); upload a tree with branch lengths, or drop that requirement and ' +
	'HyphAeon will use TN93 distances from the alignment instead.';
export const NO_BRANCH_LENGTHS_MESSAGE =
	'HyphAeon needs a tree with branch lengths — it reads them as evolutionary distances. ' +
	'This tree has none, so every pair of sequences would look equally related. This run asked ' +
	'for real branch lengths explicitly (requireBranchLengths); upload a tree that has them, or ' +
	'drop that requirement and HyphAeon will use TN93 distances from the alignment instead.';

/** `nwk_path` values dataset.py:598 reads as "no tree, use TN93" (the library takes the same three). */
export const TREE_FREE_MODES = Object.freeze(['tn93', 'none', 'skip']);

/**
 * Hard bounds on the taxon cap. 512 is the model's `taxon_cap` (manifest, MAX_SPECIES_CAP). The
 * floor is 3, not predict.js's 2: PLAN.md §4.3 refuses two-taxon input (veg/HyphAeon#7) on every
 * surface, and this is the one place every surface passes through.
 */
export const MIN_SPECIES = 3;
export const MAX_SPECIES_CAP = LIBRARY_MAX_SPECIES_CAP;

/** cli.py:1025 `--attribution-min-lrt` default; cli.py:1030 `--filter-p-thresh` default. */
export const ATTRIBUTION_MIN_LRT_DEFAULT = 3.84;
export const FILTER_P_THRESH_DEFAULT = 0.01;

/**
 * Emit progress without letting the sink take the run down with it: a worker's postMessage and an
 * SSE write can both fail for reasons unrelated to the prediction, and a run that has done the
 * expensive work must not be lost to a failed status update. Progress is advisory.
 */
export function report(progress, phase, done, total, message) {
	if (typeof progress !== 'function') return;
	try {
		progress(phase, done, total, message);
	} catch {
		// Swallowing this is the point.
	}
}

/**
 * Resolve the taxon cap: an integer in [MIN_SPECIES, MAX_SPECIES_CAP]; `null`/`undefined` (not
 * set) fall back to `fallback`; `Infinity` (or the string 'none') means NO cap, which is the
 * CLI's `--max-species` default for meme (cli.py:1025, None) — the library then applies no
 * stride pre-selection and no Faith's PD. Anything unusable falls back too. null is checked
 * BEFORE Number(): Number(null) is 0, so `maxSpecies: null` would otherwise clamp to the floor.
 *
 * @returns {number|null} null = no cap
 */
export function clampMaxSpecies(value, fallback = MAX_SPECIES_DEFAULT) {
	if (value == null) return fallback;
	if (value === Infinity || value === 'none') return null;
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(MAX_SPECIES_CAP, Math.max(MIN_SPECIES, n));
}

/** A warning in PLAN.md §3.5's shape. */
function warning(code, severity, message, data = {}) {
	return { code, severity, message, data };
}

function now() {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

/** The tree argument the library receives: the trimmed text, or null to look inside the alignment. */
export function treeArgument(treeText) {
	const t = typeof treeText === 'string' ? treeText.trim() : '';
	return t ? t : null;
}

/**
 * @typedef {{
 *   useTn93: boolean,
 *   reason: 'requested'|'no_tree'|'no_branch_lengths'|null,
 *   treeSupplied: 'user'|'embedded'|null,
 *   tree: object|null,
 *   branchLengthsMissing: boolean,
 *   treeUnparseable: boolean
 * }} TreePolicy
 */

/**
 * PLAN.md D22's tree decision, made by the RUNTIME rather than left to the library.
 *
 * The library decides the same thing inside `loadAlignmentAndTree` and would reach the same
 * answer with `useTn93` unset; the runtime asks first anyway for three reasons. It has to refuse
 * before loading when a caller passed `requireBranchLengths`. It has to record `tree_source` and
 * the reason in provenance, and reading that back out of `notices` alone cannot tell "the upload
 * carried a topology-only tree" from "the upload carried no tree". And a surface (the MCP, the
 * diagnostics panel) wants to say what WILL happen before paying for the load.
 *
 *   tree with usable branch lengths                     -> the tree path, as the reference runs it
 *   `options.useTn93`, or treeText 'tn93'/'none'/'skip'  -> tree-free, reason 'requested'
 *   no tree in the upload or the alignment              -> tree-free, reason 'no_tree'
 *   a tree without usable branch lengths                -> tree-free, reason 'no_branch_lengths'
 *   tree TEXT that will not parse                       -> NOT tree-free: the library raises
 *
 * `hasNonzeroBranchLengths` is the reference's own predicate (dataset.py:214-222: at least one
 * non-root branch, and at least half of them present and strictly positive), imported rather than
 * re-implemented so "usable" means one thing in this repository.
 *
 * @param {string} alignmentText
 * @param {string|null} treeArg the trimmed tree text, or null to look inside the alignment
 * @param {{useTn93?: boolean}} [options]
 * @returns {TreePolicy}
 */
export function decideTreePolicy(alignmentText, treeArg, options = {}) {
	const mode = treeArg === null ? null : treeArg.trim().toLowerCase();
	if (options.useTn93 === true || (mode !== null && TREE_FREE_MODES.includes(mode))) {
		return { useTn93: true, reason: 'requested', treeSupplied: null, tree: null, branchLengthsMissing: false, treeUnparseable: false };
	}
	/** @type {object|null} */
	let tree = null;
	/** @type {'user'|'embedded'|null} */
	let treeSupplied = null;
	if (treeArg === null) {
		tree = extractTree(alignmentText);
		if (tree) treeSupplied = 'embedded';
	} else {
		tree = extractTree(treeArg);
		if (tree) treeSupplied = 'user';
		else {
			// Bad tree text is a bad input, not a missing one: let the library raise it, verbatim
			// (its message is what mcp/src/engine.js classifies on).
			return { useTn93: false, reason: null, treeSupplied: null, tree: null, branchLengthsMissing: false, treeUnparseable: true };
		}
	}
	if (tree === null) {
		return { useTn93: true, reason: 'no_tree', treeSupplied: null, tree: null, branchLengthsMissing: false, treeUnparseable: false };
	}
	const branchLengthsMissing = !hasNonzeroBranchLengths(tree);
	return {
		useTn93: branchLengthsMissing,
		reason: branchLengthsMissing ? 'no_branch_lengths' : null,
		treeSupplied,
		tree,
		branchLengthsMissing,
		treeUnparseable: false
	};
}

/** `display_tree.source` / `preprocessing.display_tree_source` values (PLAN.md §3.5, D22, D6). */
export const DISPLAY_TREE_SOURCES = Object.freeze(['user', 'user-topology', 'nj']);

/**
 * The caption a UI prints under a `user-topology` display tree. One string, shared with the web
 * report through `display_tree.label`, so the modal and the foreground picker say the same thing.
 */
export const USER_TOPOLOGY_LABEL = 'your topology; branch lengths not estimated (model used TN93 distances)';

/**
 * The user's topology as a Newick with UNIT branch lengths, pruned to the taxa the model saw.
 *
 * PLAN.md D6 ("its topology is kept only for display"): a tree without usable branch lengths is
 * not a phylogram, so it cannot be drawn as one — but its topology is still the reader's own
 * statement about how the sequences relate, and a reader who uploaded it wants to see parsimony
 * substitutions on IT, not on an inferred neighbour-joining tree. Every non-root branch is written
 * as `:1`, whatever fraction of lengths the file did carry (below `hasNonzeroBranchLengths`'s
 * threshold they are not distances the model could have used, and mixing real and unit lengths
 * would draw a tree that is neither). Tips that are not among `keep` (dropped by the taxon cap,
 * duplicate collapse or an unmatched name) are removed, internal nodes left with one child are
 * collapsed, and internal labels (a name, or the support value the parser filed under
 * `confidence` as Bio.Phylo does) survive only on nodes that keep two children.
 *
 * Iterative post-order over the library's array-shaped PhyloTree (`root`, `children[node]`,
 * `name[node]`, `confidence[node]`), so a 2,000-tip tree does not recurse.
 *
 * @param {{root: number, children: number[][], name: (string|null)[], confidence?: (number|null)[]}} tree
 *   the library's parsed tree
 * @param {Iterable<string>} keep the taxon names the model saw (`loaded.taxa`)
 * @returns {{newick: string, tips: number, pruned: number}|null} null when fewer than two tips remain
 */
export function unitTopologyNewick(tree, keep) {
	if (!tree || !Array.isArray(tree.children) || !Array.isArray(tree.name)) return null;
	const wanted = new Set();
	for (const k of keep) wanted.add(String(k));
	// dataset.py:233/309 strips quotes from tip names before matching; nothing else is normalised.
	const stripQuotes = (s) => String(s ?? '').replace(/^['"]+|['"]+$/g, '');
	/** @type {(string|null)[]} text per node: a subtree WITHOUT its own `:1`, or null when pruned away */
	const text = new Array(tree.children.length).fill(null);
	/** @type {number[]} surviving tips per node */
	const tips = new Array(tree.children.length).fill(0);
	let pruned = 0;
	/** @type {Array<[number, number]>} */
	const stack = [[tree.root, 0]];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		const [node, visited] = frame;
		const kids = tree.children[node] ?? [];
		if (visited < kids.length) {
			frame[1] = visited + 1;
			stack.push([kids[visited], 0]);
			continue;
		}
		stack.pop();
		const label = tree.name[node];
		if (kids.length === 0) {
			const name = stripQuotes(label);
			if (wanted.has(name) || wanted.has(String(label ?? ''))) {
				text[node] = newickLabel(name);
				tips[node] = 1;
			} else {
				pruned++;
			}
			continue;
		}
		const alive = kids.filter((k) => text[k] !== null);
		if (alive.length === 0) continue;
		tips[node] = alive.reduce((s, k) => s + tips[k], 0);
		if (alive.length === 1) {
			// A unary node is not a split: hand the child up unchanged (its own `:1` is written by
			// the parent, so the collapsed path costs one unit, not two).
			text[node] = text[alive[0]];
			continue;
		}
		const inner = alive.map((k) => `${text[k]}:1`).join(',');
		const confidence = Array.isArray(tree.confidence) ? tree.confidence[node] : null;
		const internal = label ? newickLabel(String(label)) : confidence != null ? String(confidence) : '';
		text[node] = `(${inner})${internal}`;
	}
	const rootText = text[tree.root];
	if (rootText === null || tips[tree.root] < 2) return null;
	// A root left with one child was collapsed into a bare tip or subtree; wrap so the result is a
	// tree and not a label.
	const newick = rootText.startsWith('(') ? `${rootText};` : `(${rootText}:1);`;
	return { newick, tips: tips[tree.root], pruned };
}

/**
 * The Newick a UI may draw for this run — the site-tree modal and the phenotype foreground
 * picker (PLAN.md §4.5, D22, D6). DISPLAY ONLY; see nj.js.
 *
 *   the tree path        the user's own tree: the uploaded text verbatim, or the embedded tree
 *                        serialised back out of the parse (`source: 'user'`)
 *   tree-free, with a    THE USER'S TOPOLOGY, pruned to the taxa the model saw and written with
 *   topology-only tree   unit branch lengths (`source: 'user-topology'`, `unitTopologyNewick`),
 *                        captioned `USER_TOPOLOGY_LABEL`: the model read TN93 distances, and
 *                        nothing estimated lengths for this tree — the `:1`s are a drawing
 *                        convention, not a fit
 *   tree-free, no tree   neighbour joining on the TN93 matrix the model was actually given, over
 *                        the taxa it actually saw (`source: 'nj'`)
 *
 * NJ is the fallback, never the first choice when a topology exists (PLAN.md D6 as written: "its
 * topology is kept only for display"). The topology is still handed to NJ in two cases where it
 * cannot be drawn: fewer than two of its tips name taxa the model saw (the names did not match
 * the alignment's), and a tree-free run that was REQUESTED (`useTn93`, or 'tn93' / 'none' as the
 * tree text) — the reference's own flag ignores the tree, `decideTreePolicy` does not parse it,
 * and the display follows the analysis. What the upload carried is recorded separately as
 * `preprocessing.tree_provided`.
 *
 * @param {object} loaded the library's LoadedAlignment
 * @param {TreePolicy} policy
 * @param {string|null} treeArg
 * @param {{maxTaxa?: number}} [options]
 * @returns {{newick: string, source: 'user'|'user-topology'|'nj', from: 'tree-text'|'alignment'|'tn93',
 *   taxa: number, label?: string, prunedTips?: number, clampedBranches?: number}|null}
 */
export function displayTreeFor(loaded, policy, treeArg, options = {}) {
	const treeFree = loaded?.notices?.treeFree ?? null;
	if (!treeFree) {
		// The upload's own tree. Its TEXT when the caller handed text over — that is exactly what
		// the user gave and what the model read — else the embedded tree serialised back out of
		// the parse, which is the only form of it this runtime ever holds.
		if (policy.treeSupplied === 'user' && treeArg) {
			return { newick: treeArg, source: 'user', from: 'tree-text', taxa: loaded.N };
		}
		if (loaded.tree) {
			try {
				return {
					newick: newickFromTree(loaded.tree),
					source: 'user',
					from: policy.treeSupplied === 'embedded' ? 'alignment' : 'tree-text',
					taxa: loaded.N
				};
			} catch {
				// A tree that parsed but will not serialise is a decoration that failed, not a run
				// that failed.
				return null;
			}
		}
		return null;
	}
	if (policy.tree && Array.isArray(loaded?.taxa)) {
		// The reader's own topology (reason 'no_branch_lengths'): drawn as given, pruned to the
		// taxa the model saw, with unit lengths. See unitTopologyNewick.
		const topology = unitTopologyNewick(policy.tree, loaded.taxa);
		if (topology && topology.tips >= 2) {
			return {
				newick: topology.newick,
				source: 'user-topology',
				from: policy.treeSupplied === 'embedded' ? 'alignment' : 'tree-text',
				taxa: topology.tips,
				prunedTips: topology.pruned,
				label: USER_TOPOLOGY_LABEL
			};
		}
	}
	const nj = njTreeFromLoaded(loaded, options);
	if (!nj) return null;
	return { newick: nj.newick, source: 'nj', from: 'tn93', taxa: nj.n, clampedBranches: nj.clampedBranches };
}

/**
 * The shared front half of every analysis: parse (taxon count gate), the D22 tree decision, the
 * load through the library, the display-only tree, and a description of what happened in
 * PLAN.md §3.5's `preprocessing` terms.
 *
 * @param {{alignmentText: string, treeText?: string|null, options?: object, progress?: Function,
 *   signal?: AbortSignal, defaultMaxSpecies?: number}} args
 * @param {boolean} [args.options.useTn93] force the tree-free path even when the tree is usable
 *   (the reference's `--use-tn93`)
 * @param {boolean} [args.options.requireBranchLengths] refuse instead of going tree-free
 * @param {boolean} [args.options.displayTree] build the display tree (default true)
 * @returns {Promise<{loaded: object, names: string[], rawSeqs: Map<string, string>,
 *   treeArg: string|null, treeSource: string, treeFree: {reason: string, taxaOrder: string}|null,
 *   useTn93: boolean, displayTree: object|null, tree: object|null,
 *   branchLengthsEstimated: boolean, speciesCap: number|null, warnings: object[],
 *   preprocessing: object}>}
 */
export async function prepareRun({ alignmentText, treeText, options = {}, progress, signal, defaultMaxSpecies = MAX_SPECIES_DEFAULT }) {
	const warnings = [];
	const speciesCap = clampMaxSpecies(options.maxSpecies, defaultMaxSpecies);
	const pruneDuplicates = options.pruneDuplicates !== false;

	// --- parse ---------------------------------------------------------------------------------
	report(progress, 'parse', 0, 1, 'Reading alignment...');
	if (typeof alignmentText !== 'string' || !alignmentText.trim()) {
		throw new Error('No sequence data available in the alignment');
	}
	const rawSeqs = parseAlignmentSequences(alignmentText);
	const names = Array.from(rawSeqs.keys());
	if (names.length === 0) throw new Error('No sequences found in the alignment');
	if (names.length < MIN_SPECIES) {
		throw new Error(
			`HyphAeon needs at least ${MIN_SPECIES} sequences; this alignment has ${names.length}.`
		);
	}
	report(progress, 'parse', 1, 1, `Alignment read: ${names.length} sequences`);
	throwIfAborted(signal);

	// --- the D22 tree decision, before the load -------------------------------------------------
	const treeArg = treeArgument(treeText);
	const policy = decideTreePolicy(alignmentText, treeArg, options);
	if (policy.useTn93 && options.requireBranchLengths) {
		// The only two refusals left, and only for a caller that asked for them.
		throw new Error(policy.reason === 'no_branch_lengths' ? NO_BRANCH_LENGTHS_MESSAGE : NO_TREE_MESSAGE);
	}

	// --- prepare -------------------------------------------------------------------------------
	report(
		progress,
		'prepare',
		0,
		2,
		policy.useTn93
			? 'Computing TN93 distances and embedding...'
			: 'Computing tree distances and embedding...'
	);
	await yieldToLoop();

	// --- the distance engine, tree-free runs only ------------------------------------------------
	// `tn93Engine` picks who computes the pairwise numbers: 'wasm' is veg/tn93's own compiled code
	// (runtime/src/tn93-wasm.js, vendored build), 'js' is the library's port of the tn93 package,
	// 'auto' (the default) takes the compiled one and falls back to the port with a warning if it
	// cannot be loaded. The two agree entry for entry on every bundled example; the compiled one is
	// about five times faster at 476 taxa (181 ms against 887 ms) and the gap widens with N^2.
	// Everything downstream of the raw numbers stays in the library either way (see tn93-wasm.js).
	let tn93Options = options.tn93Options;
	let tn93Engine = 'js';
	if (policy.useTn93 && options.tn93Engine !== 'js' && !options.tn93Options?.pairwiseDistances) {
		try {
			const wasm = await tn93WasmOptions(options.tn93Wasm ?? {});
			tn93Options = { ...(options.tn93Options ?? {}), ...wasm };
			tn93Engine = 'wasm';
		} catch (err) {
			if (options.tn93Engine === 'wasm') throw err;
			warnings.push(
				warning(
					'TN93_ENGINE_FALLBACK',
					'info',
					'The compiled TN93 could not be loaded, so distances were computed in JavaScript. ' +
						'The two agree on every alignment measured; this run was only slower.',
					{ error: String(err?.message ?? err) }
				)
			);
		}
	}

	let loaded;
	try {
		loaded = loadAlignmentAndTree(alignmentText, treeArg, {
			maxSpecies: speciesCap,
			pruneDuplicates,
			referenceName: options.referenceSequence,
			// `useTn93` is passed ONLY for a genuine request. The library reaches the same decision
			// from the same predicates for the other two cases, and it labels the reason more
			// precisely than the flag can: `useTn93: true` makes `notices.treeFree.reason`
			// 'requested', which would erase the difference between "the user asked for TN93",
			// "there was no tree" and "the tree had no usable branch lengths" — the three things
			// the report has to be able to say. The runtime's own decision is checked against the
			// library's below, so this is not a silent hand-off.
			useTn93: policy.reason === 'requested',
			tn93Options
		});
	} catch (err) {
		// The `tn93` package raises where dataset.py expects a sentinel and nothing catches it: a
		// saturated pair reaches `math.log` of a non-positive number and a pair with no overlapping
		// unambiguous position divides by zero (../HyphAeon/PHASE3A.md, "Python quirks replicated").
		// The library reproduces the exception by name; a user meeting it deserves to be told what
		// it means about their alignment rather than shown `ValueError` from a package they never
		// invoked. `diagnose` reports the same condition as TN93_SATURATED_PAIRS at refuse level.
		if (policy.useTn93 && /^tn93:/.test(String(err?.message ?? ''))) {
			throw new Error(
				'TN93 distances could not be computed for this alignment: ' +
					`${err.message} — at least one pair of sequences is saturated (no shared history the ` +
					'model can read) or shares no overlapping unambiguous position. Supply a tree with ' +
					'branch lengths, or drop the sequences the diagnostics flag.',
				{ cause: err }
			);
		}
		throw err;
	}
	throwIfAborted(signal);

	const n = loaded.notices;
	const treeFree = n.treeFree;
	if (Boolean(treeFree) !== policy.useTn93) {
		// The runtime and the library disagreed about the tree. Neither is authoritative over the
		// other by design — they apply the same predicates to the same input — so a disagreement is
		// a drift between this repository and the library it is pinned to, and provenance must not
		// quietly claim the path that was not taken.
		warnings.push(
			warning(
				'TREE_POLICY_MISMATCH',
				'warn',
				`The runtime expected the ${policy.useTn93 ? 'tree-free' : 'tree'} path and the library took the ` +
					`${treeFree ? 'tree-free' : 'tree'} one. The library's decision is what the model saw and is what is recorded.`,
				{ runtimeReason: policy.reason, libraryReason: treeFree ? treeFree.reason : null }
			)
		);
	}
	if (treeFree) {
		// PLAN.md §4.3's row: info, with the reason. `diagnose` raises the same code with its own
		// data; diagnoseWarnings keeps whichever came first, and this one knows the real load.
		warnings.push(
			warning(
				'TREE_FREE_TN93',
				'info',
				treeFree.reason === 'requested'
					? 'Tree-free mode was requested: pairwise TN93 distances were computed from the alignment and used instead of a tree.'
					: treeFree.reason === 'no_tree'
						? 'No tree was supplied or embedded, so pairwise TN93 distances were computed from the alignment and used instead (PLAN.md D22).'
						: 'The tree has no usable branch lengths, so pairwise TN93 distances were computed from the alignment and used instead (PLAN.md D22).',
				{
					// The first five keys are `diagnose`'s own, with the same names and meanings
					// (diagnostics.js TREE_FREE_TN93): `diagnoseWarnings` keeps whichever version of a
					// code came first, so a consumer must see the same fields either way. The last
					// three are what only a completed load knows.
					reason: treeFree.reason,
					taxaOrder: treeFree.taxaOrder,
					distances: 'tn93',
					matchMode: TN93_MATCH_MODE,
					treeKeptForDisplay: policy.tree !== null,
					treeProvided: policy.treeSupplied,
					saturatedPairs: n.tn93SaturatedPairs ?? 0,
					recoverable: true
				}
			)
		);
	}
	report(
		progress,
		'prepare',
		2,
		2,
		`${treeFree ? 'TN93 distances' : 'Distances'} and embedding ready: ${loaded.N} taxa, ${loaded.L} codons`
	);

	// --- the display-only tree (nj.js) ----------------------------------------------------------
	const displayTree = options.displayTree === false ? null : displayTreeFor(loaded, policy, treeArg);
	throwIfAborted(signal);

	const treeSource = treeFree ? 'tn93' : (options.treeSource ?? policy.treeSupplied ?? 'embedded');
	const usedSet = new Set(loaded.taxa);
	const preprocessing = {
		taxa_in_alignment: names.length,
		taxa_used: loaded.N,
		dropped_taxa: names.filter((name) => !usedSet.has(name)),
		taxa_not_in_tree: n.droppedTaxa.alignment,
		tips_not_in_alignment: n.droppedTaxa.tree,
		match_tier: n.matchTier,
		duplicates_collapsed: n.duplicatesCollapsed,
		pd_subsampled: n.pdSubsampled,
		stride_preselected: n.stridePreselected,
		taxon_cap: speciesCap,
		reference_sequence: referenceNameFor(loaded, options.referenceSequence),
		/** PLAN.md §3.5: 'user' | 'embedded' | 'tn93' (D22 removed 'hyphy-hky85'; 'nj' / 'user-topology' are display only). */
		tree_source: treeSource,
		/** What the UPLOAD carried, whether or not the model used it. */
		tree_provided: policy.treeSupplied,
		tree_free: treeFree ? { reason: treeFree.reason, taxa_order: treeFree.taxaOrder } : null,
		tn93_saturated_pairs: n.tn93SaturatedPairs,
		/** Who computed the pairwise distances on a tree-free run: veg/tn93's compiled code, or the
		 * library's port of the tn93 package. `null` when the run used a tree. */
		tn93_engine: treeFree ? tn93Engine : null,
		branch_lengths_missing: n.branchLengthsMissing,
		/** D22: nothing estimates branch lengths any more. Kept so the block's shape does not move. */
		branch_lengths_estimated: false,
		/** DISPLAY_TREE_SOURCES: 'user' | 'user-topology' | 'nj' (D6: a topology-only upload is drawn as given). */
		display_tree_source: displayTree ? displayTree.source : null,
		distance_rescaled: n.distanceRescaled,
		raw_dist_max: n.rawDistMax,
		codons_trimmed: n.codonsTrimmed,
		unequal_lengths: n.unequalLengths,
		unknown_codon_fraction: n.unknownCodonFraction,
		in_frame_stops: n.inFrameStops
	};
	return {
		loaded,
		names,
		rawSeqs,
		treeArg,
		treeSource,
		treeFree: treeFree ? { reason: treeFree.reason, taxaOrder: treeFree.taxaOrder } : null,
		useTn93: policy.useTn93,
		displayTree,
		tree: treeFree ? null : loaded.tree,
		branchLengthsEstimated: false,
		speciesCap,
		warnings,
		preprocessing
	};
}

/**
 * The sequence whose codons the app shows as `refCodon`: the caller's choice when it was kept,
 * else the first matched taxon — dataset.py takes L from that one (dataset.py:658).
 */
export function referenceNameFor(loaded, requested) {
	if (requested && loaded.referenceIndex >= 0) return loaded.taxa[loaded.referenceIndex];
	return loaded.taxa[0];
}

/**
 * PLAN.md §4.3 warnings from the library's `diagnose`, merged with the runtime's own (a code the
 * runtime already raised is not repeated). Diagnostics never take a run down.
 */
export function diagnoseWarnings({ alignmentText, treeArg, loaded, speciesCap, runtimeWarnings, enabled, useTn93 = false }) {
	const out = [...runtimeWarnings];
	if (enabled === false) return out;
	try {
		const d = diagnose({
			alignmentText,
			treeText: treeArg,
			parsed: loaded,
			maxSpecies: speciesCap ?? MAX_SPECIES_CAP,
			// D22: `diagnose` must reach the same tree decision the load did, or it would report a
			// tree-based depth on a run that used TN93 distances (diagnostics.js `useTn93`).
			useTn93
		});
		const have = new Set(out.map((w) => w.code));
		for (const w of d.warnings) if (!have.has(w.code)) out.push(w);
	} catch (err) {
		out.push(warning('DIAGNOSTICS_FAILED', 'info', `diagnose() failed: ${err?.message ?? err}`));
	}
	return out;
}

/** Everything in `options` that can be serialised, for the provenance block. */
export function submittedOptions(options) {
	const out = {};
	for (const [k, v] of Object.entries(options ?? {})) {
		if (typeof v === 'function') continue;
		out[k] = v === Infinity ? 'none' : v;
	}
	return out;
}

/**
 * The provenance block of PLAN.md §3.5.
 *
 * @param {object} args
 */
export function provenanceBlock({ surface, session, head = null, surrogateFor, seed, elapsedSec, options, preprocessing, warnings, inputs, overrides = {} }) {
	return {
		schema_version: SCHEMA_VERSION,
		surface,
		hyphaeon_js_version: overrides.hyphaeon_js_version ?? session.libraryVersion ?? null,
		reference_version: overrides.reference_version ?? session.referenceVersion ?? null,
		model_version: overrides.model_version ?? session.modelVersion ?? null,
		model_variant: overrides.model_variant ?? session.variant ?? null,
		artifact_sha256: overrides.artifact_sha256 ?? session.sha256 ?? null,
		artifact_verified: session.verified ?? (session.sha256 != null),
		...(head
			? {
					busted_head_sha256: overrides.busted_head_sha256 ?? head.sha256 ?? null,
					busted_head_verified: head.verified ?? (head.sha256 != null)
				}
			: {}),
		is_surrogate: true,
		surrogate_for: surrogateFor,
		seed: overrides.seed ?? seed ?? null,
		elapsed_sec: elapsedSec,
		options: submittedOptions(options),
		inputs,
		preprocessing,
		warnings
	};
}

/**
 * Score every codon site of an alignment with the HyphAeon `meme` surrogate.
 *
 * @param {object} args
 * @param {string} args.alignmentText FASTA / NEXUS / PHYLIP, gaps intact; may carry an embedded tree
 * @param {string|null} [args.treeText] Newick; null/empty to use a tree embedded in the alignment
 * @param {object} [args.options]
 * @param {number|null} [args.options.maxSpecies] taxon cap, clamped to [3, 512]; default 256;
 *   `Infinity` = no cap (the CLI's default)
 * @param {boolean} [args.options.pruneDuplicates] default true (cli.py `--no-prune-duplicates` off)
 * @param {string} [args.options.referenceSequence] the sequence whose codons are shown as `refCodon`
 * @param {number} [args.options.batchSize] sites per graph call (default: the reference's adaptive size)
 * @param {number} [args.options.batchBudgetBytes] tensor budget per batch (`batchSizeFor`)
 * @param {boolean} [args.options.attention] also return `mean_root_attns` as `attention` [L, N]
 * @param {boolean} [args.options.rootRepr] also return `root_repr` [L, 384]
 * @param {object} [args.options.prepared] a `prepareRun()` result to reuse instead of parsing and
 *   loading again (analyze.js shares one loaded alignment across every phase of the report)
 * @param {boolean} [args.options.filter] cli.py `--filter`
 * @param {number} [args.options.filterPThresh] cli.py `--filter-p-thresh`, default 0.01
 * @param {boolean} [args.options.attribute] cli.py `--attribute`
 * @param {number} [args.options.attributionMinLrt] cli.py `--attribution-min-lrt`, default 3.84
 * @param {string} [args.options.callMode] one of CALL_MODES; anything else throws
 * @param {object} [args.options.calling] extra buildPredictions gate overrides; `callMode` wins
 * @param {boolean} [args.options.useTn93] force the tree-free TN93 path even when the tree is
 *   usable (the reference's `--use-tn93`); it is taken automatically without a usable tree (D22)
 * @param {object} [args.options.tn93Options] `matchMode` / `maxAmbigFraction` / `ignoreGaps` for
 *   the library's `tn93DistanceMatrix`; the reference's own defaults apply
 * @param {boolean} [args.options.requireBranchLengths] refuse (NO_TREE_MESSAGE /
 *   NO_BRANCH_LENGTHS_MESSAGE) instead of going tree-free
 * @param {boolean} [args.options.displayTree] build the display-only tree (default true)
 * @param {string} [args.options.treeSource] 'user' | 'embedded' (recorded; a tree-free run is
 *   always recorded as 'tn93')
 * @param {boolean} [args.options.diagnose] run the library's diagnose() for warnings (default true)
 * @param {string} [args.options.alignmentName] label written as the document's `alignment`
 * @param {string} [args.options.treeName] label written as the document's `tree`
 * @param {number} [args.options.seed] recorded; `meme` draws no random numbers
 * @param {{session: any, ort: any, sha256?: string|null, outputNames?: string[]}} args.session
 *   the backbone handle loadSession() / createSession().backbone returned
 * @param {(phase: string, done: number, total: number, message: string) => void} [args.progress]
 * @param {string} [args.surface] one of SURFACES; default 'browser'
 * @param {AbortSignal} [args.signal] checked between phases and between batches
 * @param {object} [args.provenance] overrides for the provenance block: model_version,
 *   model_variant, artifact_sha256, hyphaeon_js_version, reference_version, seed
 * @returns {Promise<object>} { schema_version, method, is_surrogate, surrogate_for, taxa_count,
 *   codon_count, runtime_sec, filter_enabled, artifacts_masked, attribution_enabled, attributions,
 *   sites, display_tree, arrays, filter?, attention?, root_repr?, summary, provenance } plus two non-enumerable
 *   properties: `loaded` (the library's LoadedAlignment) and `inference` (the raw pass: `lrt`,
 *   `siteIndices`, `batchSize`, `mean_root_attns`, `root_repr`)
 */
export async function runMeme({
	alignmentText,
	treeText = null,
	options = {},
	session,
	progress,
	surface = 'browser',
	signal,
	provenance: provenanceOverrides = {}
} = {}) {
	const t0 = now();
	if (!session || !session.session || !session.ort) {
		throw new Error('runMeme: pass the handle returned by loadSession() as `session`');
	}
	if (!SURFACES.includes(surface)) {
		throw new Error(`runMeme: unknown surface "${surface}" (one of ${SURFACES.join(', ')})`);
	}
	const { callMode } = options;
	if (callMode != null && !CALL_MODES.includes(callMode)) {
		throw new Error(`Unknown callMode "${callMode}". Valid modes: ${CALL_MODES.join(', ')}.`);
	}

	// --- parse + prepare -------------------------------------------------------------------------
	// `options.prepared` is a prepareRun() result the caller already holds (analyze.js runs the
	// front half once so that diagnostics can be reported before inference and every later phase
	// shares ONE loaded alignment); the phases are then not repeated and not re-reported.
	const prep =
		options.prepared && options.prepared.loaded
			? options.prepared
			: await prepareRun({ alignmentText, treeText, options, progress, signal });
	const { loaded, names, rawSeqs, treeArg, speciesCap, preprocessing } = prep;
	const runtimeWarnings = prep.warnings;
	const { L, N } = loaded;

	// --- infer (inference.py:162-192) ----------------------------------------------------------
	const outputs = ['lrt'];
	if (options.attention) outputs.push('mean_root_attns');
	if (options.rootRepr) outputs.push('root_repr');
	const batchSize = resolveBatchSize(N, options);
	report(progress, 'infer', 0, L, `Scoring variable sites (${L} codons)...`);
	const inferred = await inferSites(loaded, session, {
		outputs,
		batchSize,
		signal,
		onProgress: (done, total) =>
			report(progress, 'infer', done, total, `Scoring variable site ${done} of ${total}...`)
	});
	const numVariable = inferred.siteIndices.length;
	report(progress, 'infer', numVariable, numVariable, `Scored ${numVariable} variable sites`);
	// cli.py:97 — `elapsed` is measured from the load to the end of prediction, before p/q.
	const runtimeSec = (now() - t0) / 1000;
	throwIfAborted(signal);

	// --- stats (cli.py:99-100) -----------------------------------------------------------------
	report(progress, 'stats', 0, 1, 'MEME mixture p-values and BH q-values...');
	let lrt = inferred.lrt;
	let { pvals, qvals } = memeSitePq(lrt);
	let invariable = loaded.invariable;
	const rawArrays = { lrt, pvals, qvals, invariable };
	report(progress, 'stats', 1, 1, 'Statistics ready');

	// --- filter (cli.py:111-218) ---------------------------------------------------------------
	let filterResult = null;
	let artifactsMasked = [];
	const predict = predictFromSession(session, { signal });
	if (options.filter) {
		report(progress, 'filter', 0, 1, 'Screening for alignment artifacts...');
		filterResult = await runAlignmentFilter(
			{ alignmentText, treeText: treeArg, loaded, baseLrts: lrt },
			predict,
			{
				cliVariant: true,
				pLocalThresh: options.filterPThresh ?? FILTER_P_THRESH_DEFAULT,
				maxSpecies: speciesCap,
				pruneDuplicates: options.pruneDuplicates !== false,
				batchSize,
				onProgress: (p) =>
					report(progress, 'filter', p.done, p.total, `Re-scoring cleaned alignment: site ${p.done} of ${p.total}...`)
			}
		);
		artifactsMasked = filterResult.artifacts_masked;
		if (filterResult.num_artifacts_masked > 0 && filterResult.cleaned) {
			// cli.py:214-218: the cleaned arrays replace the raw ones.
			lrt = filterResult.cleaned.lrts;
			pvals = filterResult.cleaned.pvals;
			qvals = filterResult.cleaned.qvals;
			invariable = filterResult.cleaned.loaded.invariable;
		}
		report(progress, 'filter', 1, 1, `${filterResult.num_artifacts_masked} artifact patch(es) masked`);
		throwIfAborted(signal);
	}

	// --- attribute (cli.py:257-277) ------------------------------------------------------------
	let attributions = new Map();
	if (options.attribute) {
		report(progress, 'attribute', 0, 1, 'Attributing selection to taxa...');
		attributions = await attributeSelection(loaded, predict, {
			minLrt: options.attributionMinLrt ?? ATTRIBUTION_MIN_LRT_DEFAULT,
			baseLrts: lrt,
			taxa: loaded.taxa,
			batchSize,
			onProgress: (p) =>
				report(progress, 'attribute', p.done, p.total, `Attributing site ${p.done} of ${p.total}...`)
		});
		report(progress, 'attribute', 1, 1, `${attributions.size} site(s) attributed`);
		throwIfAborted(signal);
	}

	// --- postprocess -----------------------------------------------------------------------------
	report(progress, 'postprocess', 0, 1, 'Building per-site results...');
	const pythonSites = memeSiteRecords(lrt, pvals, qvals, invariable, attributions);
	const refName = referenceNameFor(loaded, options.referenceSequence);
	const refSeq = rawSeqs.get(refName) ?? '';
	const refCodons = Array.from({ length: L }, (_, i) => refSeq.slice(i * 3, i * 3 + 3));
	const variable = Array.from(invariable, (v) => !v);
	// ONE source of truth for the calling mode. An explicit callMode wins over calling.mode; when
	// callMode is absent, calling.mode survives rather than being stomped by a default.
	const callConfig = { ...(options.calling ?? {}), ...(callMode ? { mode: callMode } : {}) };
	const appSites = buildPredictions({ lrt }, { refCodons, variable }, callConfig);
	const sites = pythonSites.map((py, i) => ({ ...py, ...appSites[i] }));

	const p05 = Math.fround(0.05);
	const p10 = Math.fround(0.1);
	let sigP05 = 0;
	let sigP10 = 0;
	let fdrQ05 = 0;
	let fdrQ10 = 0;
	for (let i = 0; i < L; i++) {
		if (pvals[i] <= p05) sigP05++;
		if (pvals[i] <= p10) sigP10++;
		if (qvals[i] <= p05) fdrQ05++;
		if (qvals[i] <= p10) fdrQ10++;
	}

	const warnings = diagnoseWarnings({
		alignmentText,
		treeArg,
		loaded,
		speciesCap,
		runtimeWarnings,
		enabled: options.diagnose,
		useTn93: prep.useTn93
	});
	report(progress, 'postprocess', 1, 1, 'Done');

	const elapsed = (now() - t0) / 1000;
	const inputs = {
		alignment: options.alignmentName ?? null,
		tree: options.treeName ?? (treeArg === null ? 'embedded_in_alignment' : null)
	};
	const result = {
		schema_version: SCHEMA_VERSION,
		method: 'meme',
		// Load-bearing for every consumer: these are PREDICTIONS of what MEME would report, not MEME.
		is_surrogate: true,
		surrogate_for: 'MEME',
		// cli.py:298-311 top-level fields.
		taxa_count: N,
		codon_count: L,
		runtime_sec: runtimeSec,
		filter_enabled: Boolean(options.filter),
		artifacts_masked: artifactsMasked,
		attribution_enabled: Boolean(options.attribute),
		attributions: attributionsOneIndexed(attributions),
		sites,
		/**
		 * DISPLAY ONLY (nj.js, PLAN.md D22): the user's own tree when the run used one, else a
		 * neighbour-joining tree on the TN93 distances the model was given. It is here so a site-tree
		 * modal and the phenotype foreground picker have a topology without asking for one; nothing
		 * downstream of the graph reads it.
		 */
		display_tree: prep.displayTree,
		/** The typed arrays the writers consume (results.js); `raw` is the pre-filter set. */
		arrays: {
			lrt,
			p_value: pvals,
			q_value: qvals,
			invariable,
			raw: filterResult && filterResult.num_artifacts_masked > 0 ? rawArrays : null
		},
		attributionRecords: attributions,
		summary: {
			totalSites: L,
			variableSites: variable.filter(Boolean).length,
			invariableSites: L - variable.filter(Boolean).length,
			calledSites: sites.filter((s) => s.call !== 'Neutral').length,
			speciesUsed: N,
			speciesInAlignment: names.length,
			referenceSequence: refName,
			// Named in the footer: it changes what a "call" means, and the default is not the
			// reference driver's.
			callMode: callConfig.mode ?? CALL_DEFAULTS.mode,
			matchTier: loaded.notices.matchTier,
			duplicatesCollapsed: loaded.notices.duplicatesCollapsed,
			batchSize,
			// cli.py:220-223 / 104-107, the printed significance counts (float32 comparisons).
			sigSitesP05: sigP05,
			sigSitesP10: sigP10,
			fdrSitesQ05: fdrQ05,
			fdrSitesQ10: fdrQ10,
			filterEnabled: Boolean(options.filter),
			artifactsMasked: artifactsMasked.length,
			patchesDetected: filterResult ? filterResult.num_patches_detected : 0,
			attributionEnabled: Boolean(options.attribute),
			attributedSites: attributions.size
		},
		provenance: provenanceBlock({
			surface,
			session,
			surrogateFor: 'MEME',
			seed: options.seed ?? session.defaultSeed ?? null,
			elapsedSec: elapsed,
			options,
			preprocessing,
			warnings,
			inputs,
			overrides: provenanceOverrides
		})
	};
	if (filterResult) {
		result.filter = {
			num_patches_detected: filterResult.num_patches_detected,
			num_artifacts_masked: filterResult.num_artifacts_masked,
			masked_codons_count: filterResult.masked_codons_count,
			patches: filterResult.patches,
			artifacts: filterResult.artifacts,
			artifacts_masked: filterResult.artifacts_masked,
			masked_codon_ranges_1idx_by_taxon: filterResult.masked_codon_ranges_1idx_by_taxon,
			raw_metrics: filterResult.raw_metrics,
			cleaned_metrics: filterResult.cleaned_metrics,
			suppressed_spurious_sites: filterResult.suppressed_spurious_sites,
			cleaned_fasta: filterResult.cleaned ? filterResult.cleaned.fastaText : null
		};
	}
	if (inferred.mean_root_attns) result.attention = inferred.mean_root_attns;
	if (inferred.root_repr) result.root_repr = inferred.root_repr;
	// The raw forward pass, for a consumer that continues from it without re-running the graph
	// (analyze.js: busted from `root_repr`, epistasis from `mean_root_attns`, the DMS baseline
	// from `lrt`). `lrt` here is the PRE-filter clamped float32 vector inference.py produced,
	// `siteIndices` the variable sites it scored. Non-enumerable, like `loaded`, so a serialised
	// result does not carry an [L, N] attention matrix and an [L, 384] representation twice.
	Object.defineProperty(result, 'inference', {
		value: {
			lrt: inferred.lrt,
			siteIndices: inferred.siteIndices,
			batchSize: inferred.batchSize,
			mean_root_attns: inferred.mean_root_attns,
			root_repr: inferred.root_repr
		},
		enumerable: false,
		writable: false
	});
	// The loaded tensors, for a consumer that continues the analysis (busted, later epistasis)
	// without loading twice. Non-enumerable so a JSON.stringify / structured clone of the result
	// does not drag L·N tokens and an N×N matrix along.
	Object.defineProperty(result, 'loaded', { value: loaded, enumerable: false, writable: false });
	return result;
}
