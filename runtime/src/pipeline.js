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
 *                `> 10` rescale, Faith's PD to the cap, MDS, tokens, the invariable mask. A tree
 *                without branch lengths goes to `options.estimateTree` when the caller gave one
 *                (the runtime's HyPhy / NJ, PLAN.md D5/D6) and the load is repeated with the
 *                estimated tree; otherwise the library has already taken dataset.py:609-614's
 *                "HyPhy not found" branch (1e-3 / 1e-4 defaults) and that fact is recorded
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
 *   - Two cmd_meme quirks pass through unchanged because the library replicates them and the
 *     fixtures pin them: with an embedded tree and ≥ 1 masked artifact `--filter` fails at the
 *     cleaned reload ("No tree specified", cli.py:192), and the cleaned re-score reuses the
 *     baseline tree cache (cli.py:195-197). Both are upstream issues, not app policy.
 *
 * SURROGATE, NOT MEME. Every result carries `is_surrogate` / `surrogate_for` as data (PLAN.md
 * §2, hard truth 1). Nothing here presents the output as a completed selection analysis.
 */

import {
	loadAlignmentAndTree,
	parseAlignmentSequences,
	memeSitePq,
	runAlignmentFilter,
	attributeSelection,
	memeSiteRecords,
	attributionsOneIndexed,
	diagnose,
	MAX_SPECIES_DEFAULT,
	MAX_SPECIES_CAP as LIBRARY_MAX_SPECIES_CAP
} from '@veg/hyphaeon-js';

import { buildPredictions, CALL_DEFAULTS } from './postprocess.js';
import { inferSites, predictFromSession, resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';

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

/** Verbatim from DM3 AnalyzeTab.svelte:167-184 via predict.js. Do not reword — surfaces must agree. */
export const NO_TREE_MESSAGE =
	'HyphAeon needs a phylogenetic tree. Infer one or upload your own before running it.';
export const NO_BRANCH_LENGTHS_MESSAGE =
	'HyphAeon needs a tree with branch lengths — it reads them as evolutionary distances. ' +
	'This tree has none, so every pair of sequences would look equally related. Infer a ' +
	'neighbor-joining tree or upload one with branch lengths.';

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
 * The shared front half of every analysis: parse (taxon count gate), load through the library,
 * estimate branch lengths through the caller's hook when the tree has none, and describe what
 * happened in PLAN.md §3.5's `preprocessing` terms.
 *
 * @param {{alignmentText: string, treeText?: string|null, options?: object, progress?: Function,
 *   signal?: AbortSignal, defaultMaxSpecies?: number}} args
 * @returns {Promise<{loaded: object, names: string[], rawSeqs: Map<string, string>,
 *   treeArg: string|null, treeSource: string, branchLengthsEstimated: boolean,
 *   speciesCap: number|null, warnings: object[], preprocessing: object}>}
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

	// --- prepare -------------------------------------------------------------------------------
	report(progress, 'prepare', 0, 2, 'Computing tree distances and embedding...');
	await yieldToLoop();
	let treeArg = treeArgument(treeText);
	let treeSource = options.treeSource ?? (treeArg ? 'user' : 'embedded');
	const load = (tree) => {
		try {
			return loadAlignmentAndTree(alignmentText, tree, {
				maxSpecies: speciesCap,
				pruneDuplicates,
				referenceName: options.referenceSequence
			});
		} catch (err) {
			if (/No tree specified|Could not parse phylogenetic tree/.test(err?.message ?? '')) {
				throw new Error(NO_TREE_MESSAGE, { cause: err });
			}
			throw err;
		}
	};
	let loaded = load(treeArg);
	let branchLengthsEstimated = false;
	if (loaded.notices.branchLengthsMissing) {
		if (typeof options.estimateTree === 'function') {
			// dataset.py:601-611 shells out to HyPhy here; the runtime's hook is that call.
			report(progress, 'prepare', 1, 2, 'Estimating branch lengths...');
			const est = await options.estimateTree(alignmentText, treeArg);
			const estText = typeof est === 'string' ? est : est?.treeText;
			if (typeof estText !== 'string' || !estText.trim()) {
				throw new Error('estimateTree returned no tree text');
			}
			treeArg = estText.trim();
			treeSource = (typeof est === 'object' && est?.source) || 'hyphy-hky85';
			branchLengthsEstimated = true;
			loaded = load(treeArg);
			if (loaded.notices.branchLengthsMissing) {
				warnings.push(
					warning(
						'BRANCH_LENGTHS_MISSING',
						'warn',
						'The estimated tree still has no usable branch lengths; dataset.py defaults (1e-3 / 1e-4) were applied.'
					)
				);
			}
		} else if (options.requireBranchLengths) {
			throw new Error(NO_BRANCH_LENGTHS_MESSAGE);
		} else {
			// dataset.py:609-614, the "HyPhy not found" branch: enforce defaults and continue. The
			// library did that; the run is recorded as having done so.
			warnings.push(
				warning(
					'BRANCH_LENGTHS_MISSING',
					'warn',
					'The tree has no branch lengths and no estimator was available; dataset.py defaults ' +
						'(1e-3 for missing, 1e-4 minimum) were applied, as the reference does without HyPhy.',
					{ recoverable: true }
				)
			);
		}
	}
	throwIfAborted(signal);
	report(progress, 'prepare', 2, 2, `Distances and embedding ready: ${loaded.N} taxa, ${loaded.L} codons`);

	const n = loaded.notices;
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
		tree_source: treeSource,
		branch_lengths_missing: n.branchLengthsMissing,
		branch_lengths_estimated: branchLengthsEstimated,
		distance_rescaled: n.distanceRescaled,
		raw_dist_max: n.rawDistMax,
		codons_trimmed: n.codonsTrimmed,
		unequal_lengths: n.unequalLengths,
		unknown_codon_fraction: n.unknownCodonFraction,
		in_frame_stops: n.inFrameStops
	};
	return { loaded, names, rawSeqs, treeArg, treeSource, branchLengthsEstimated, speciesCap, warnings, preprocessing };
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
export function diagnoseWarnings({ alignmentText, treeArg, loaded, speciesCap, runtimeWarnings, enabled }) {
	const out = [...runtimeWarnings];
	if (enabled === false) return out;
	try {
		const d = diagnose({
			alignmentText,
			treeText: treeArg,
			parsed: loaded,
			maxSpecies: speciesCap ?? MAX_SPECIES_CAP
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
 * @param {boolean} [args.options.filter] cli.py `--filter`
 * @param {number} [args.options.filterPThresh] cli.py `--filter-p-thresh`, default 0.01
 * @param {boolean} [args.options.attribute] cli.py `--attribute`
 * @param {number} [args.options.attributionMinLrt] cli.py `--attribution-min-lrt`, default 3.84
 * @param {string} [args.options.callMode] one of CALL_MODES; anything else throws
 * @param {object} [args.options.calling] extra buildPredictions gate overrides; `callMode` wins
 * @param {(alignmentText: string, treeText: string|null) => Promise<string|{treeText: string, source?: string}>}
 *   [args.options.estimateTree] called when the tree has no branch lengths (dataset.py:601-611's HyPhy call)
 * @param {boolean} [args.options.requireBranchLengths] refuse (NO_BRANCH_LENGTHS_MESSAGE) instead of
 *   taking the reference's "HyPhy not found" branch when no estimator is given
 * @param {string} [args.options.treeSource] 'user' | 'embedded' | 'hyphy-hky85' | 'nj' | 'tn93' (recorded)
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
 *   sites, arrays, filter?, attention?, root_repr?, summary, provenance }
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
	const prep = await prepareRun({ alignmentText, treeText, options, progress, signal });
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
		enabled: options.diagnose
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
	// The loaded tensors, for a consumer that continues the analysis (busted, later epistasis)
	// without loading twice. Non-enumerable so a JSON.stringify / structured clone of the result
	// does not drag L·N tokens and an N×N matrix along.
	Object.defineProperty(result, 'loaded', { value: loaded, enumerable: false, writable: false });
	return result;
}
