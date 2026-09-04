/**
 * pipeline.js — the site-selection (`meme`) run, end to end, over a session someone else loaded.
 *
 * WHY THIS FILE EXISTS. PLAN.md §3.2: `runtime/` holds "pipeline orchestration (prep → MDS → infer
 * → postprocess) over the library". This is that orchestration for `meme`. It mirrors the phase
 * order of datamonkey3/src/lib/services/AxomemeAnalysisRunner.js (main@fac1330) and of its Node
 * port, datamonkey-js-server/lib/axomeme/predict.js (main@1e84d6f), WITHOUT the
 * BaseAnalysisRunner inheritance, the IndexedDB lifecycle, and the percent-based progress bar:
 * the browser worker, the MCP tool and the job server each wrap this one function and translate
 * `progress(phase, done, total, message)` into whatever their transport wants (PLAN.md §3.5's
 * `{phase, done, total, message}`).
 *
 *   parse        fastaValidation.parseAlignment over stripEmbeddedTrees(alignmentText)
 *   prepare      library prepareAlignment: tree parse, patristic distances, Max-PD cap, tokens,
 *                MDS on the padded matrix (the ~0.6-2 s synchronous step; run this in a worker)
 *   infer        session.run over site batches sized by batchSizeFor; the first bundle is checked
 *                against the model contract (validateInputBundle), later ones cannot differ in the
 *                per-alignment tensors
 *   postprocess  variability over the SELECTED sequences, buildPredictions, provenance
 *
 * THE SESSION IS AN ARGUMENT, NOT LOADED HERE. Loading is the surface's business — the browser
 * fetches from static/ with the vendored WASM, Node reads a path — and it is the expensive,
 * memoised, hash-verified step that must not be triggered by a module import. Callers pass the
 * handle `loadSession()` returned ({session, ort, sha256, outputNames}).
 *
 * TWO GATES BEFORE ANY SCORING, verbatim from predict.js (which took them from DM3's
 * AnalyzeTab.svelte:167-184): a tree is required, and a tree with branch lengths is required.
 * The model reads a patristic distance matrix; a topology-only tree yields an all-zero matrix and
 * an all-zero embedding, from which the model returns confident numbers computed from nothing.
 * PLAN.md D5/D6 put tree inference (NJ, TN93, HKY85) UPSTREAM of this function, in the caller.
 *
 * WHAT THIS DOES NOT DO YET, stated so nobody reads absence as a decision:
 *   - No MEME-mixture p-values or BH q-values. Those are hyphaeon/stats.py, port order 2 in
 *     PLAN.md §5.2; until the library exports them the site rows are DM3's (lrt, z, percentile,
 *     tier call) and the Python's `p_value` / `q_value` columns are absent, not zero.
 *   - No `--filter`, no `--attribute`. Same reason; same phase.
 *   - No taxon dedupe, no `>10` distance rescale, no PHYLIP: library gaps listed in PLAN.md §5.1.
 *   - Invariable sites are still sent through the graph and zeroed afterwards (DM3's behaviour),
 *     where inference.py:170-186 skips them. Same numbers, more work; kept for DM3 parity in
 *     Phase 0 and to be changed together with the library's fixture harness.
 *
 * SURROGATE, NOT MEME. Every result carries `is_surrogate` / `surrogate_for` as data (PLAN.md
 * §2, hard truth 1). Nothing here presents the output as a completed selection analysis.
 */

import {
	prepareAlignment,
	batchSizeFor,
	validateInputBundle,
	MAX_SPECIES_DEFAULT
} from '@veg/hyphaeon-js';

import { parseAlignment, stripEmbeddedTrees, findStopCodons } from './fastaValidation.js';
import { inspectBranchLengths } from './treeSanitation.js';
import { treeHasBranchLengths } from './prescreen/scope.js';
import { runSites } from './feeds.js';
import { buildPredictions, siteVariability, CALL_DEFAULTS } from './postprocess.js';

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

/** Phases, in order. Progress is reported at the start of each and per batch during `infer`. */
export const PHASES = Object.freeze(['parse', 'prepare', 'infer', 'postprocess']);

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
 * Below this magnitude a negative branch length is float noise from NJ's unclamped subtraction,
 * not a broken tree. DM3's threshold for the distance-clamping notice; NJ routinely emits -1e-5.
 */
const NOISY_NEGATIVE = -0.001;

/**
 * Hard bounds on the taxon cap. 512 is the value the tensors are padded to (the library's
 * MAX_SPECIES_DEFAULT). The floor is 3, not predict.js's 2: PLAN.md §4.3 refuses two-taxon input
 * (veg/HyphAeon#7, the 2-taxon bug) on every surface, and this is the one place every surface
 * passes through.
 */
export const MIN_SPECIES = 3;
export const MAX_SPECIES_CAP = MAX_SPECIES_DEFAULT;

/** dataset.py:709-712 reports unknown codons above this fraction. */
const UNKNOWN_CODON_WARN_FRACTION = 0.05;

/** Let the event loop turn between batches so a worker can post progress and a cancel can land. */
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Emit progress without letting the sink take the run down with it: a worker's postMessage and an
 * SSE write can both fail for reasons unrelated to the prediction, and a run that has done the
 * expensive work must not be lost to a failed status update. Progress is advisory.
 */
function report(progress, phase, done, total, message) {
	if (typeof progress !== 'function') return;
	try {
		progress(phase, done, total, message);
	} catch {
		// Swallowing this is the point.
	}
}

/**
 * Clamp the taxon cap to an integer in [MIN_SPECIES, MAX_SPECIES_CAP]; anything unusable falls
 * back to the default. null is checked BEFORE Number(): Number(null) is 0, so `maxSpecies: null`
 * would otherwise clamp to the floor and silently score a subsample instead of meaning "not set".
 */
export function clampMaxSpecies(value, fallback = MAX_SPECIES_DEFAULT) {
	if (value == null) return fallback;
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(MAX_SPECIES_CAP, Math.max(MIN_SPECIES, n));
}

function abortError() {
	const err = new Error('HyphAeon run cancelled');
	err.name = 'AbortError';
	return err;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

/** A warning in PLAN.md §3.5's shape. */
function warning(code, severity, message, extra = {}) {
	return { code, severity, message, ...extra };
}

/**
 * Score every codon site of an alignment with the HyphAeon `meme` surrogate.
 *
 * @param {object} args
 * @param {string} args.alignmentText FASTA or NEXUS, gaps intact
 * @param {string} args.treeText newick WITH branch lengths — required, see the gates above
 * @param {object} [args.options]
 * @param {string} [args.options.callMode] one of CALL_MODES; anything else throws
 * @param {object} [args.options.calling] extra buildPredictions gate overrides; `callMode` wins
 * @param {number} [args.options.maxSpecies] taxon cap, clamped to [3, 512]
 * @param {string} [args.options.referenceSequence] the sequence that defines the site count
 * @param {number} [args.options.batchBudgetBytes] tensor budget per batch (batchSizeFor's default)
 * @param {string} [args.options.treeSource] 'user' | 'embedded' | 'hyphy-hky85' | 'nj' | 'tn93',
 *   recorded in provenance; default 'user'
 * @param {{session: any, ort: any, sha256?: string|null, outputNames?: string[]}} args.session
 *   the handle loadSession() returned (session-web or session-node)
 * @param {(phase: string, done: number, total: number, message: string) => void} [args.progress]
 * @param {string} [args.surface] one of SURFACES; default 'browser'
 * @param {AbortSignal} [args.signal] checked between batches
 * @param {object} [args.provenance] overrides / additions for the provenance block:
 *   model_version, model_variant, hyphaeon_js_version, reference_version, seed
 * @returns {Promise<object>} { schema_version, method, is_surrogate, surrogate_for, sites,
 *   attention?, root_repr?, summary, provenance }
 */
export async function runMeme({
	alignmentText,
	treeText,
	options = {},
	session,
	progress,
	surface = 'browser',
	signal,
	provenance: provenanceOverrides = {}
} = {}) {
	const t0 = now();
	const warnings = [];

	if (!session || !session.session || !session.ort) {
		throw new Error('runMeme: pass the handle returned by loadSession() as `session`');
	}
	if (!SURFACES.includes(surface)) {
		throw new Error(`runMeme: unknown surface "${surface}" (one of ${SURFACES.join(', ')})`);
	}
	const { callMode, maxSpecies, referenceSequence, batchBudgetBytes } = options;
	if (callMode != null && !CALL_MODES.includes(callMode)) {
		throw new Error(`Unknown callMode "${callMode}". Valid modes: ${CALL_MODES.join(', ')}.`);
	}
	const speciesCap = clampMaxSpecies(maxSpecies);

	// --- parse ---------------------------------------------------------------------------------
	report(progress, 'parse', 0, 1, 'Reading alignment...');
	if (typeof alignmentText !== 'string' || !alignmentText.trim()) {
		throw new Error('No sequence data available in the alignment');
	}
	// stripEmbeddedTrees first: a trailing newick line in a FASTA upload would otherwise be appended
	// to the last sequence and quietly corrupt that taxon's codons.
	const parsed = parseAlignment(stripEmbeddedTrees(alignmentText));
	const names = parsed.sequences.map((s) => s.header);
	const sequences = parsed.sequences.map((s) => s.sequence);
	if (names.length === 0) throw new Error('No sequences found in the alignment');
	if (names.length < MIN_SPECIES) {
		throw new Error(
			`HyphAeon needs at least ${MIN_SPECIES} sequences; this alignment has ${names.length}.`
		);
	}

	// --- tree gates ----------------------------------------------------------------------------
	const tree = typeof treeText === 'string' ? treeText.trim() : '';
	if (!tree) throw new Error(NO_TREE_MESSAGE);
	if (!treeHasBranchLengths(tree)) throw new Error(NO_BRANCH_LENGTHS_MESSAGE);
	const treeReport = inspectBranchLengths(tree);
	report(progress, 'parse', 1, 1, 'Alignment read');
	throwIfAborted(signal);

	// --- prepare -------------------------------------------------------------------------------
	report(progress, 'prepare', 0, 1, 'Computing tree distances and embedding...');
	await yieldToLoop();
	const prepared = prepareAlignment({
		names,
		sequences,
		treeText: tree,
		maxSpecies: speciesCap,
		referenceName: referenceSequence
	});
	if (prepared.totalCodons === 0) {
		throw new Error('The reference sequence is shorter than one codon');
	}
	report(progress, 'prepare', 1, 1, 'Distances and embedding ready');
	throwIfAborted(signal);

	// --- infer ---------------------------------------------------------------------------------
	const L = prepared.totalCodons;
	const N = prepared.speciesCount;
	const budget =
		Number.isFinite(batchBudgetBytes) && batchBudgetBytes > 0 ? Math.floor(batchBudgetBytes) : undefined;
	const batch = budget === undefined ? batchSizeFor(N) : batchSizeFor(N, budget);
	const outputNames = session.outputNames ?? ['lrt'];

	// Preallocated, and filled with `set` rather than `push(...out)`: batchSizeFor scales as 1/N^2,
	// so a few-taxon alignment gets batches of 10^5-10^6 sites, and spreading that many elements
	// into a call blows V8's argument limit ("Maximum call stack size exceeded" at ~90% progress —
	// DM3 measured the throw at 167,772 elements, exactly the batch size for a 10-taxon alignment).
	const lrt = new Float32Array(L);
	// The optional heads are allocated when the first batch shows them. `dropped_heads_policy:
	// "omit"` — a graph without them yields a result without them, never zero-filled ones.
	let attention = null;
	let rootRepr = null;

	report(progress, 'infer', 0, L, `Scoring ${L} sites...`);
	let fullyValidated = false;
	for (let start = 0; start < L; start += batch) {
		const bundle = prepared.batch(start, batch);
		const b = bundle.msa_codons.dims[0];
		if (!fullyValidated) {
			// The contract check is cheap next to inference and catches the whole class of errors that
			// produce a well-formed tensor meaning something the model never saw. Once: dist_matrix and
			// mds_coords are per-alignment memcpy'd copies, so later batches cannot differ there.
			const check = validateInputBundle(bundle, {
				batch: b,
				numSpecies: N,
				windowSize: prepared.windowSize
			});
			if (!check.ok) {
				throw new Error(`HyphAeon input check failed: ${check.errors.slice(0, 3).join('; ')}`);
			}
			fullyValidated = true;
		}

		const out = await runSites(session.session, bundle, session.ort, outputNames);
		lrt.set(out.lrt.subarray ? out.lrt.subarray(0, b) : Array.from(out.lrt).slice(0, b), start);
		if (out.mean_root_attns) {
			const width = out.mean_root_attns.length / b;
			if (!attention) attention = { data: new Float32Array(L * width), dims: [L, width] };
			attention.data.set(out.mean_root_attns, start * width);
		}
		if (out.root_repr) {
			const width = out.root_repr.length / b;
			if (!rootRepr) rootRepr = { data: new Float32Array(L * width), dims: [L, width] };
			rootRepr.data.set(out.root_repr, start * width);
		}

		const done = Math.min(start + batch, L);
		report(progress, 'infer', done, L, `Scoring site ${done} of ${L}...`);
		// Between batches is the only place this loop yields, so it is the only place a cancel can
		// take effect.
		await yieldToLoop();
		throwIfAborted(signal);
	}

	// --- postprocess ---------------------------------------------------------------------------
	report(progress, 'postprocess', 0, 1, 'Building per-site results...');
	// Variability is judged over the SELECTED species, which is what the model saw — not over every
	// sequence in the file, which may include taxa the tree did not contain. BY INDEX, not
	// `names.indexOf(name)`: with duplicate FASTA headers indexOf returns the FIRST match while
	// orderSpecies keeps the LAST, so the flags would come from a different sequence than the one
	// the model was tokenised from.
	const selectedSeqs = prepared.selectedIndices.map((i) => sequences[i] ?? '');
	const variable = siteVariability(selectedSeqs, L);
	const refSeq = sequences[prepared.referenceIndex] ?? sequences[0];
	const refCodons = Array.from({ length: L }, (_, i) => refSeq.slice(i * 3, i * 3 + 3));
	// ONE source of truth for the calling mode. An explicit callMode wins over calling.mode; when
	// callMode is absent, calling.mode survives rather than being stomped by a default.
	const callConfig = {
		...(options.calling ?? {}),
		...(callMode ? { mode: callMode } : {})
	};
	const sites = buildPredictions({ lrt }, { refCodons, variable }, callConfig);

	// --- warnings ------------------------------------------------------------------------------
	// Only surface tree problems worth acting on. inspectBranchLengths reports ANY negative branch,
	// and NJ routinely emits float noise around -1e-5; warning about those trains users to ignore the
	// warning box. A meaningfully negative tree still gets through, here and via mostNegativeDistance.
	const minLength = treeReport.min ?? 0;
	if (treeReport.negative > 0 && minLength <= NOISY_NEGATIVE) {
		warnings.push(
			warning(
				'TREE_NEGATIVE_LENGTHS',
				'warn',
				treeReport.reasons.find((r) => /negative/.test(r)) ?? 'negative branch lengths',
				{ min: treeReport.min, negative: treeReport.negative }
			)
		);
	}
	if (treeReport.saturated > 0) {
		warnings.push(
			warning(
				'TREE_SATURATION_SENTINEL',
				'warn',
				treeReport.reasons.find((r) => /saturation/.test(r)) ?? 'saturated branch lengths',
				{ saturated: treeReport.saturated }
			)
		);
	}
	if (prepared.clampedDistances > 0) {
		// Reported, not hidden. Clamping matches the model's training pipeline, so it is not an
		// error — but a tree whose distances are meaningfully negative is a different situation from
		// one carrying float noise, and only the magnitude distinguishes them.
		warnings.push(
			warning(
				'DISTANCES_CLAMPED',
				prepared.mostNegativeDistance <= NOISY_NEGATIVE ? 'warn' : 'info',
				`${prepared.clampedDistances} negative patristic distance(s) clamped to 0 ` +
					`(most negative ${prepared.mostNegativeDistance})`,
				{ clamped: prepared.clampedDistances, mostNegative: prepared.mostNegativeDistance }
			)
		);
	}
	const selectedSet = new Set(prepared.selectedIndices);
	const droppedTaxa = names.filter((_, i) => !selectedSet.has(i));
	const pdSubsampled = names.length > speciesCap && N === speciesCap;
	const notInTree = pdSubsampled ? [] : droppedTaxa;
	if (notInTree.length) {
		// veg/HyphAeon#9: taxa missing from the tree must not vanish silently. The diagnostics layer
		// (PLAN.md §4.3) refuses these before a run; this is the last line if it did not.
		warnings.push(
			warning(
				'TAXA_NOT_IN_TREE',
				'warn',
				`${notInTree.length} alignment sequence(s) have no tip in the tree and were not scored: ` +
					notInTree.slice(0, 10).join(', ') +
					(notInTree.length > 10 ? ', ...' : ''),
				{ taxa: notInTree }
			)
		);
	}
	if (!prepared.matchedFromTree) {
		warnings.push(
			warning(
				'TREE_NAMES_UNMATCHED',
				'warn',
				'No tree tip matched an alignment sequence name; species order fell back to alignment order'
			)
		);
	}
	const trailing = refSeq.length % 3;
	if (trailing !== 0) {
		warnings.push(
			warning(
				'ALIGNMENT_NOT_MULTIPLE_OF_3',
				'warn',
				`Reference sequence length (${refSeq.length}) is not a multiple of 3; ${trailing} trailing nucleotide(s) ignored`
			)
		);
	}
	const unknownCodonFraction = unknownFraction(prepared.codonTokens);
	if (unknownCodonFraction > UNKNOWN_CODON_WARN_FRACTION) {
		warnings.push(
			warning(
				'UNKNOWN_CODON_FRACTION',
				'warn',
				`${(unknownCodonFraction * 100).toFixed(1)}% of codons contain gaps, ambiguities, or unrecognized bases`,
				{ fraction: unknownCodonFraction }
			)
		);
	}
	const stops = findStopCodons(alignmentText);
	const inFrameStops = stops.scanned
		? stops.affected.reduce((n, seq) => n + seq.hits.length, 0)
		: null;
	if (inFrameStops) {
		warnings.push(
			warning(
				'IN_FRAME_STOPS',
				'info',
				`${inFrameStops} in-frame stop codon(s) in ${stops.affected.length} sequence(s), excluding each sequence's terminal codon`,
				{ count: inFrameStops, sequences: stops.affected.length }
			)
		);
	}

	report(progress, 'postprocess', 1, 1, 'Done');

	const elapsed = (now() - t0) / 1000;
	const submittedOptions = {};
	for (const [k, v] of Object.entries(options)) if (typeof v !== 'function') submittedOptions[k] = v;

	const result = {
		schema_version: SCHEMA_VERSION,
		method: 'meme',
		// Load-bearing for every consumer: these are PREDICTIONS of what MEME would report, not MEME.
		is_surrogate: true,
		surrogate_for: 'MEME',
		sites,
		summary: {
			totalSites: L,
			variableSites: sites.filter((s) => s.isVariable).length,
			calledSites: sites.filter((s) => s.call !== 'Neutral').length,
			speciesUsed: N,
			speciesInAlignment: names.length,
			referenceSequence: prepared.referenceName,
			// Named in the footer: it changes what a "call" means, and the default is not the
			// reference driver's.
			callMode: callConfig.mode ?? CALL_DEFAULTS.mode,
			matchedFromTree: prepared.matchedFromTree,
			duplicateSelections: prepared.duplicateSelections,
			clampedDistances: prepared.clampedDistances,
			mostNegativeDistance: prepared.mostNegativeDistance,
			treeWarnings: treeReport.ok
				? []
				: treeReport.reasons.filter((r) => !/negative/.test(r) || minLength <= NOISY_NEGATIVE)
		},
		provenance: {
			schema_version: SCHEMA_VERSION,
			surface,
			hyphaeon_js_version: provenanceOverrides.hyphaeon_js_version ?? null,
			reference_version: provenanceOverrides.reference_version ?? null,
			model_version: provenanceOverrides.model_version ?? null,
			model_variant: provenanceOverrides.model_variant ?? null,
			artifact_sha256: provenanceOverrides.artifact_sha256 ?? session.sha256 ?? null,
			artifact_verified: session.verified ?? (session.sha256 != null),
			is_surrogate: true,
			surrogate_for: 'MEME',
			// `meme` draws no random numbers; the seed is recorded for the pillars that do.
			seed: provenanceOverrides.seed ?? null,
			elapsed_sec: elapsed,
			options: submittedOptions,
			preprocessing: {
				taxa_in_alignment: names.length,
				taxa_used: N,
				dropped_taxa: droppedTaxa,
				// The library does not collapse identical sequences yet (PLAN.md §5.1, dataset.py gaps).
				duplicates_collapsed: 0,
				pd_subsampled: pdSubsampled,
				taxon_cap: speciesCap,
				reference_sequence: prepared.referenceName,
				tree_source: options.treeSource ?? 'user',
				branch_lengths_estimated: false,
				distances_clamped: prepared.clampedDistances,
				// dataset.py:680-681 divides by L when max patristic > 10; not in the library yet.
				distance_rescaled: false,
				codons_trimmed: trailing === 0 ? 0 : 1,
				trailing_nucleotides_trimmed: trailing,
				unknown_codon_fraction: unknownCodonFraction,
				in_frame_stops: inFrameStops
			},
			warnings
		}
	};
	if (attention) result.attention = attention;
	if (rootRepr) result.root_repr = rootRepr;
	return result;
}

/** Fraction of codon tokens that are the gap (64) or unknown (65) sentinel. */
function unknownFraction(codonTokens) {
	if (!codonTokens || codonTokens.length === 0) return 0;
	let unknown = 0;
	for (let i = 0; i < codonTokens.length; i++) if (codonTokens[i] >= 64n) unknown++;
	return unknown / codonTokens.length;
}

function now() {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}
