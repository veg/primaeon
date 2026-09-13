/**
 * run.js — the one call the `/time` page, the MCP and the server make: an alignment and a set of
 * dates in, a dated ancestor and a per-sequence table out.
 *
 * WHY THIS FILE EXISTS. `runMeme` is to `cmd_meme` what this is to `run_mrca_dating`
 * (hyphaeon/dating.py:2412-3192): the phase order, the refusals, the progress reporting, the
 * cancellation and the provenance, with every estimator call going to `@veg/hyphaeon-js`. The
 * chain, and the reference line each step mirrors:
 *
 *   parse            dataset.py:252    `parseAlignmentSequences` — first-token names, upper case, U→T
 *   verify           dating.py:135-222 `verifyCodingAlignment`   — L mod 3 trim, uniformity, stops
 *   asterisks        dataset.py:840    `starsToGaps`             — this pillar's convention (see alignment.js)
 *   dates            dating.py:2487    the caller's, from `runtime/src/dates/`
 *   dated set        dating.py:2497    alignment order, NaN dropped, the root taxon dropped
 *   distance mode    dating.py:2512    `auto` -> latent with a model and no tree, else tn93
 *   covariance       dating.py:2568    `neuralKernel`            — over ALL alignment taxa, then sliced
 *   latent root      dating.py:2586    `latentRoot`              — 250 Adam steps, the divergences
 *   divergences      dating.py:624-698 `computeTreeFreeDivergences` — the four root cases (tn93 mode)
 *   holdouts         dating.py:2698    `coverageHoldout`
 *   OLS              dating.py:2714    `runOlsDating`
 *   REML + PGLS      dating.py:2790    `fitPgls`
 *   spline           dating.py:2841    `runRestrictedSplineClockDating` (with the covariance, Q10)
 *   selection        dating.py:2943    `selectClockModel`
 *   ensemble         dating.py:2894    `admitEnsembleCandidates`
 *   per-taxon table  dating.py:2999    `datingTaxonRecords`
 *
 * THE MODEL ARRIVES AS TWO MATRICES, NOT AS A SESSION. `runDatingModelPass`
 * (`runtime/src/datingNeural.js`, outside this directory on purpose) runs `<variant>_taxa.onnx` and
 * hands its result in as `neural`. Nothing here loads anything, which is what keeps the `/time`
 * route's "no `*.onnx`, no `ort-*.wasm`" assertion true for a model-free run and makes the model an
 * opt-in a reader chooses rather than a cost a page pays by default.
 *
 * `--distance-mode auto` IS A DECISION ABOUT THE WHOLE RECORD (DATING Q11). With no tree and a model
 * available it resolves to `latent` (dating.py:2520-2523), and the latent root's distances are then
 * fed to EVERY estimator — the ordinary one included. On korber that moves `ols.t_mrca` from 1893.91
 * to 1926.81 and `ols.mu` from 1.169e-3 to 5.551e-4, on the same sequences and the same dates. The
 * two are not one estimator disagreeing with itself; they are two different response vectors, and
 * `DATING_LATENT_DIVERGENCES` exists so a page cannot show one without saying which.
 *
 * NOTHING HERE LOADS A MODEL, AND THAT IS ENFORCED BY THE IMPORT GRAPH, not by intention. This
 * directory imports `@veg/hyphaeon-js` and its own siblings and nothing else — not `manifest.js`,
 * not `predict.js`, not a session — so `@veg/hyphaeon-runtime/dating` cannot reach onnxruntime even
 * by accident, which is what keeps the `/time` route's "no `*.onnx`, no `ort-*.wasm`" assertion
 * true. That is why the four-line abort helper below is written out rather than imported from
 * `predict.js`, which reaches `feeds.js` and `manifest.js`; its behaviour (`err.name ===
 * 'AbortError'`) is deliberately identical, because every worker in this app checks that name.
 *
 * WHAT THE MODEL COSTS, AND WHY IT IS A SECOND PASS. The reference's dating pass reads EVERY codon,
 * invariable sites included, with no taxon cap and no duplicate pruning (dating.py:2553-2561) —
 * a different site set and a different taxon set from the report's forward pass, so it cannot ride
 * it. Measured on korber (143 taxa x 981 codons, onnxruntime-node, 4 threads): 7.3 s for the pass
 * and about 0.6 s for everything this file then does with it, of which the 142x142 pairwise ACGT
 * Hamming matrix that calibrates one scalar is most.
 *
 * WHAT IT REFUSES TO DO. There is no tree here at all: PLAN-TEMPORAL D34 declines the reference's
 * re-rooting search (up to sixty deep tree copies, a re-root per candidate, picked by residual sum
 * of squares) precisely because a subtly wrong port of it yields plausible wrong dates that never
 * announce themselves, and the tree-free default does not need it. There is no bootstrap, no
 * Poisson interval, no wild-residual interval and no jackknife, so THIS PILLAR CARRIES NO RANDOM
 * NUMBER GENERATOR AND NO SEED AT ALL — the single largest reduction in parity risk available here,
 * and for the spline's interval it is also what the reference itself produces (its bootstrap raises
 * on every replicate; see `DATING_SPLINE_NO_INTERVAL`). `runOlsDating` REFUSES the three unported
 * `ciMethod` strings rather than silently returning Fieller as the reference's `else` branch does,
 * so this file validates the option before it gets there and says which methods exist.
 *
 * COST, MEASURED on this machine (Node 22, one thread, pure JavaScript): the whole korber chain —
 * 143 sequences x 2943 nt, parse to per-taxon table — is about 0.35 s, of which the 142 cross-TN93
 * distances are nearly all. The cost is quadratic in taxa only when the root is a consensus
 * (N distances either way; it is the CONSENSUS that is O(N·L)), so a surveillance-sized upload is
 * dominated by N·L character work, not by the fit, which is microseconds.
 */

import { computeTreeFreeDivergences, parseAlignmentSequences, runOlsDating, runRestrictedSplineClockDating } from '@veg/hyphaeon-js';

import { coverageHoldout, starsToGaps, verifyCodingAlignment } from './alignment.js';
import {
	DATING_NEURAL_MAX_TAXA,
	fitPgls,
	latentRoot,
	latentRootDescription,
	neuralKernel,
	sliceSymmetric
} from './modelFits.js';
import {
	DATING_MESSAGES,
	DATING_REFUSALS,
	DATING_SCHEMA_VERSION,
	DATING_THRESHOLDS,
	datingWarning,
	fillMessage,
	nameSample,
	sortDatingWarnings
} from './codes.js';
import { DATING_SIGNAL_ALPHA } from './headline.js';
import { buildDatingRecord, datingTaxonRecords } from './record.js';
import { admitEnsembleCandidates, selectClockModel } from './select.js';

/** The `ciMethod` strings this build implements; the library refuses the rest by name. */
export const DATING_CI_METHODS = Object.freeze(['fieller', 'delta', 'linear']);

/** `--distance-mode`'s values this build accepts (dating.py:1900's `choices`, minus `tree`). */
export const DATING_DISTANCE_MODES = Object.freeze(['auto', 'tn93', 'latent']);

/**
 * `dating.py:2512-2532`, with `tree` unreachable (D34: this pillar takes no tree). `auto` is the
 * only value whose answer depends on anything, and what it depends on is whether a model ran — which
 * is why this returns the REASON as well as the mode: a record that says `latent` must be able to
 * say that nothing was chosen, it was the default with a model present.
 *
 * @param {'auto'|'tn93'|'latent'} requested
 * @param {boolean} hasModel
 * @returns {{mode: 'tn93'|'latent', reason: string}}
 */
export function resolveDistanceMode(requested, hasModel) {
	const mode = String(requested ?? 'auto').toLowerCase().trim();
	if (mode === 'auto') {
		return hasModel
			? { mode: 'latent', reason: 'auto: no tree and the dating graph is available (dating.py:2520-2523)' }
			: { mode: 'tn93', reason: 'auto: no tree and no dating graph (dating.py:2522-2523)' };
	}
	if (mode === 'latent' || mode === 'continuous' || mode === 'hull' || mode === 'manifold') {
		return { mode: 'latent', reason: `requested: --distance-mode ${mode}` };
	}
	if (mode === 'tn93' || mode === 'consensus') {
		return { mode: 'tn93', reason: `requested: --distance-mode ${mode}` };
	}
	throw new RangeError(
		`distanceMode '${requested}' is not one of ${DATING_DISTANCE_MODES.join(', ')}. The reference's ` +
			`'tree' mode needs a tree and is declined by PLAN-TEMPORAL D34; its own fall-through for an ` +
			`unrecognised string silently picks one (dating.py:2531-2532), which this refuses to do.`
	);
}

/** See the header: identical in name and shape to `predict.js`'s, local so this stays a leaf. */
function datingAbortError() {
	const err = new Error('HyphAeon dating run cancelled');
	err.name = 'AbortError';
	return err;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : datingAbortError();
}

/** `progress(phase, done, total, message)`, the package's one progress contract. */
function report(progress, done, total, message) {
	if (typeof progress === 'function') progress('dating', done, total, message);
}

/**
 * Taxon -> time, from whatever the caller has: a `DateIngest` from `runtime/src/dates/`, a Map, or
 * a plain object. Nothing here parses a date string; that is the date layer's job and there is no
 * second date parser in this package.
 */
function datesMapFrom(dates) {
	if (dates == null) return new Map();
	if (Array.isArray(dates.rows)) return new Map(dates.rows.map((r) => [r.taxon, r.value]));
	if (dates instanceof Map) return dates;
	return new Map(Object.entries(dates));
}

/** The library raises `tn93: ValueError: …` on a pair whose distance does not exist. */
function isTn93Refusal(err) {
	return typeof err?.message === 'string' && err.message.startsWith('tn93:');
}

function refuse(code, message, data = {}, warnings = []) {
	const all = sortDatingWarnings([...warnings, datingWarning(code, 'refuse', message, data)]);
	return { ok: false, refusal: code, warnings: all, record: null, rows: [] };
}

/**
 * `hyphaeon dating -a <alignment> --no-tree --method ols`, in process.
 *
 * @param {object} args
 * @param {string} [args.alignmentText] FASTA/NEXUS/PHYLIP text; or pass `sequences` directly.
 * @param {Map<string,string>|Record<string,string>} [args.sequences] already parsed, upper-cased.
 * @param {string|null} [args.alignmentName] recorded as the reference's `alignment` field.
 * @param {Map<string,number>|Record<string,number>|{rows: Array<{taxon: string, value: number}>}} args.dates
 * @param {string|null} [args.rootTaxon] a sequence name, one of the reference's magic strings
 *   (`unweighted_consensus`, `earliest`, …), or null for the time-decay consensus.
 * @param {number|null} [args.decayGamma] dating.py:248-308's γ, when a caller wants to set it.
 * @param {number|null} [args.decayHalfLife] the half-life form; the CLI has no flag for it.
 * @param {readonly string[]} [args.excludedTaxa] sequences the reader dropped; never silent.
 * @param {'auto'|'linear'|'spline'} [args.clockModel]
 * @param {'fieller'|'delta'|'linear'} [args.ciMethod]
 * @param {'auto'|'tn93'|'latent'} [args.distanceMode] `auto` (the reference's default) resolves to
 *   `latent` when `neural` is supplied and to `tn93` when it is not.
 * @param {object|null} [args.neural] what `runDatingModelPass` returned: `{crossAttn, taxaRepr,
 *   taxa, N, embedDim, ...}`. Its ABSENCE is a fact about the run, not an error — the record simply
 *   carries `pgls: null` and `latent_root: null`, as `--method ols` does upstream.
 * @param {string|null} [args.modelUnavailableReason] why `neural` is absent, when the caller knows
 *   (`'this build declares no dating graph'`); reported as `DATING_MODEL_GRAPH_ABSENT`.
 * @param {string} [args.timeUnits] carried through; only `'years'` renders as a calendar date.
 * @param {boolean} [args.allowStopCodons]
 * @param {boolean} [args.autoTrimTrailing]
 * @param {Function} [args.progress] `(phase, done, total, message)`
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.provenance] merged into the record's `primaeon` block.
 * @returns {object}
 */
export function runDating(args = {}) {
	const t0 = Date.now();
	const {
		alignmentText = null,
		sequences: suppliedSequences = null,
		alignmentName = null,
		dates,
		rootTaxon = null,
		decayGamma = null,
		decayHalfLife = null,
		excludedTaxa = [],
		clockModel = 'auto',
		ciMethod = 'fieller',
		distanceMode = 'auto',
		neural = null,
		modelUnavailableReason = null,
		timeUnits = 'years',
		allowStopCodons = true,
		autoTrimTrailing = true,
		progress = null,
		signal = null,
		provenance = null
	} = args;

	if (!DATING_CI_METHODS.includes(String(ciMethod).toLowerCase())) {
		throw new RangeError(
			`ciMethod '${ciMethod}' is not implemented. This build ports ${DATING_CI_METHODS.join(', ')}; the ` +
				`reference's poisson, residual-boot and jackknife intervals each need a bit-compatible mirror of ` +
				`numpy's PCG64 to reproduce and are deferred (PLAN-TEMPORAL §5.0). The reference would silently ` +
				`return Fieller for an unknown string (dating.py:1244-1258); this refuses instead.`
		);
	}

	const warnings = [];
	throwIfAborted(signal);

	// --- 1. parse and verify ---------------------------------------------------------------------
	report(progress, 0, 6, 'Reading the alignment...');
	const parsed = suppliedSequences ?? parseAlignmentSequences(alignmentText ?? '');
	const verified = verifyCodingAlignment(parsed, { allowStopCodons, autoTrimTrailing });
	warnings.push(...verified.warnings);
	if (!verified.ok) {
		const w = verified.warnings.find((x) => x.severity === 'refuse');
		return refuse(verified.refusal, w?.message ?? DATING_MESSAGES.ALIGNMENT_EMPTY, w?.data ?? {}, warnings.filter((x) => x !== w));
	}

	// --- 2. this pillar's asterisk convention -----------------------------------------------------
	const stars = starsToGaps(verified.sequences);
	warnings.push(...stars.warnings);
	const seqs = stars.sequences;
	throwIfAborted(signal);

	// --- 3. the dated set, in alignment order (dating.py:2497) ------------------------------------
	const dateOf = datesMapFrom(dates);
	const excluded = new Set(excludedTaxa);
	if (excluded.size > 0) {
		warnings.push(
			datingWarning('DATING_TAXA_EXCLUDED', 'warn', fillMessage(DATING_MESSAGES.TAXA_EXCLUDED, { n: excluded.size, names: nameSample([...excluded]) }), {
				taxa: [...excluded].slice(0, DATING_THRESHOLDS.sampleNames),
				count: excluded.size
			})
		);
	}
	const datedTaxa = [...seqs.keys()].filter(
		(t) => !excluded.has(t) && t !== rootTaxon && dateOf.has(t) && Number.isFinite(dateOf.get(t))
	);
	if (datedTaxa.length < DATING_THRESHOLDS.minDatedTaxa) {
		return refuse(
			DATING_REFUSALS.TOO_FEW_DATED,
			fillMessage(DATING_MESSAGES.TOO_FEW_DATED, { dated: datedTaxa.length, min: DATING_THRESHOLDS.minDatedTaxa }),
			{ dated: datedTaxa.length, min: DATING_THRESHOLDS.minDatedTaxa },
			warnings
		);
	}

	// --- 4. the distance mode, and the model's covariance (dating.py:2512-2601) -------------------
	const hasModel = neural != null;
	const { mode: distMode, reason: distModeReason } = resolveDistanceMode(distanceMode, hasModel);
	if (!hasModel) {
		if (distMode === 'latent') {
			throw new RangeError(
				`distanceMode 'latent' needs the dating graph: pass \`neural\`, the object ` +
					`runDatingModelPass() returns. The latent root is a position in the MODEL'S representation ` +
					`space and there is nothing to approximate it with.`
			);
		}
		warnings.push(
			datingWarning(
				'DATING_MODEL_GRAPH_ABSENT',
				'note',
				fillMessage(DATING_MESSAGES.MODEL_GRAPH_ABSENT, {
					reason: modelUnavailableReason ?? 'the model-based estimators were not asked for'
				}),
				{ reason: modelUnavailableReason ?? null }
			)
		);
	}
	if (hasModel && datedTaxa.length > DATING_NEURAL_MAX_TAXA) {
		return refuse(
			DATING_REFUSALS.MODEL_TOO_MANY_TAXA,
			fillMessage(DATING_MESSAGES.MODEL_TOO_MANY_TAXA, { n: datedTaxa.length, max: DATING_NEURAL_MAX_TAXA }),
			{ taxa: datedTaxa.length, max: DATING_NEURAL_MAX_TAXA },
			warnings
		);
	}

	// dating.py:2568 — the kernel is built ONCE, over every taxon the model read, and only then
	// sliced. Centre-then-subset is not subset-then-centre; see modelFits.js note 1.
	let kernel = null;
	let modelIndexOf = null;
	if (hasModel) {
		report(progress, 1, 6, `Building the model's covariance over ${neural.N} sequences...`);
		kernel = neuralKernel(neural);
		modelIndexOf = new Map(neural.taxa.map((t, i) => [t, i]));
	}
	throwIfAborted(signal);

	/** `taxa` in the fit's order, and the taxon's row in the model's matrices. */
	let taxa;
	let divergences;
	let rootDescription;
	let rootCase = null;
	let rootSequence = null;
	let latent = null;
	let tf = null;

	if (distMode === 'latent') {
		// dating.py:2571-2574 — the dated taxa the MODEL also read, in the dated set's order. A name
		// in one and not the other is dropped silently upstream; here it is named.
		taxa = datedTaxa.filter((t) => modelIndexOf.has(t));
		const dropped = datedTaxa.filter((t) => !modelIndexOf.has(t));
		if (dropped.length > 0) {
			warnings.push(
				datingWarning(
					'DATING_MODEL_TAXA_MISSING',
					'warn',
					fillMessage(DATING_MESSAGES.MODEL_TAXA_MISSING, { n: dropped.length, names: nameSample(dropped) }),
					{ count: dropped.length, taxa: dropped.slice(0, DATING_THRESHOLDS.sampleNames) }
				)
			);
		}
		if (taxa.length < DATING_THRESHOLDS.minDatedTaxa) {
			return refuse(
				DATING_REFUSALS.TOO_FEW_DATED,
				fillMessage(DATING_MESSAGES.TOO_FEW_DATED, { dated: taxa.length, min: DATING_THRESHOLDS.minDatedTaxa }),
				{ dated: taxa.length, min: DATING_THRESHOLDS.minDatedTaxa },
				warnings
			);
		}
		report(progress, 2, 6, `Placing a root in the model's representation of ${taxa.length} sequences...`);
		const subIndices = taxa.map((t) => modelIndexOf.get(t));
		const latentTimes = Float64Array.from(taxa, (t) => dateOf.get(t));
		// dating.py:2578-2585: the anchor mask is the UNGATED coverage rule, which is exactly
		// `coverageHoldout`'s `isTrain` (its `trainIndices` is the gated one the fit uses).
		const anchorCoverage = coverageHoldout(seqs, taxa);
		latent = latentRoot({
			taxaRepr: neural.taxaRepr,
			embedDim: neural.embedDim,
			subIndices,
			taxa,
			times: latentTimes,
			sequences: taxa.map((t) => seqs.get(t)),
			anchorMask: anchorCoverage.isTrain
		});
		divergences = latent.dists;
		rootDescription = latentRootDescription(latent);
		warnings.push(
			datingWarning(
				'DATING_LATENT_DIVERGENCES',
				'note',
				fillMessage(DATING_MESSAGES.LATENT_DIVERGENCES, {
					alpha: Number(latent.alpha).toPrecision(4),
					r: Number(latent.temporal_r).toFixed(3)
				}),
				{ alpha: latent.alpha, temporal_r: latent.temporal_r, temporal_r2: latent.temporal_r2, reason: distModeReason }
			)
		);
	} else {
		report(progress, 1, 6, `Measuring TN93 divergence for ${datedTaxa.length} sequences...`);
		if (rootTaxon && !seqs.has(rootTaxon) && !isMagicRoot(rootTaxon)) {
			warnings.push(
				datingWarning(
					'DATING_ROOT_TAXON_NOT_FOUND',
					'warn',
					fillMessage(DATING_MESSAGES.ROOT_TAXON_NOT_FOUND, { root: rootTaxon, used: 'a time-decay weighted consensus' }),
					{ root: rootTaxon }
				)
			);
		}
		try {
			tf = computeTreeFreeDivergences(seqs, datedTaxa, dateOf, { rootTaxon, decayGamma, decayHalfLife });
		} catch (err) {
			if (isTn93Refusal(err)) {
				return refuse(
					DATING_REFUSALS.TN93_UNCOMPUTABLE,
					fillMessage(DATING_MESSAGES.TN93_UNCOMPUTABLE, { error: err.message }),
					{ error: err.message },
					warnings
				);
			}
			throw err;
		}
		if (tf.case !== 1) {
			warnings.push(
				datingWarning('DATING_ROOT_SYNTHETIC', 'note', fillMessage(DATING_MESSAGES.ROOT_SYNTHETIC, { description: tf.root_description }), {
					root_description: tf.root_description,
					case: tf.case,
					gamma: tf.gamma
				})
			);
		}
		taxa = tf.taxa;
		divergences = tf.divergences;
		rootDescription = tf.root_description;
		rootCase = tf.case;
		rootSequence = tf.root_sequence ?? null;
	}
	throwIfAborted(signal);

	const times = Float64Array.from(taxa, (t) => dateOf.get(t));
	let tMin = Infinity;
	let tMax = -Infinity;
	for (const v of times) {
		if (v < tMin) tMin = v;
		if (v > tMax) tMax = v;
	}
	if (!(tMax > tMin)) {
		return refuse(DATING_REFUSALS.NO_TIME_SPAN, fillMessage(DATING_MESSAGES.NO_TIME_SPAN, { value: tMin }), { value: tMin }, warnings);
	}

	// --- 5. the coverage holdout (dating.py:2698-2709) --------------------------------------------
	const holdout = coverageHoldout(seqs, taxa);
	warnings.push(...holdout.warnings);
	const fitTimes = Float64Array.from(holdout.trainIndices, (i) => times[i]);
	const fitDists = Float64Array.from(holdout.trainIndices, (i) => divergences[i]);
	throwIfAborted(signal);

	// --- 6. the estimators (dating.py:2714, 2841) -------------------------------------------------
	report(progress, 3, 6, `Fitting the clock on ${fitTimes.length} sequences...`);
	const ols = runOlsDating(fitTimes, fitDists, { ciMethod });
	if (ols.status === 'NON_POSITIVE_RATE') {
		warnings.push(datingWarning('DATING_NON_POSITIVE_RATE', 'warn', fillMessage(DATING_MESSAGES.NON_POSITIVE_RATE, { mu: ols.mu }), { mu: ols.mu }));
	} else if (ols.status === 'MRCA_AFTER_EARLIEST_SAMPLE') {
		let earliest = Infinity;
		for (const v of fitTimes) if (v < earliest) earliest = v;
		warnings.push(
			datingWarning(
				'DATING_MRCA_AFTER_EARLIEST_SAMPLE',
				'warn',
				fillMessage(DATING_MESSAGES.MRCA_AFTER_EARLIEST_SAMPLE, { tmrca: (ols.t_ref - ols.d0 / ols.mu).toFixed(1), earliest }),
				{ earliest }
			)
		);
	}
	// THE CLOCK ITSELF, before any statement about an interval's shape. `DATING_UNBOUNDED_ANTIQUITY`
	// below reports that the Fieller interval has no lower bound; this reports WHY, in the
	// regression's own vocabulary, and it fires under the delta and linear intervals too, where
	// there is no `fieller_g` to test. `headline.js` carries the whole argument and the reproduction.
	if (ols.status === 'OK' && Number.isFinite(ols.p_value) && ols.p_value >= DATING_SIGNAL_ALPHA) {
		warnings.push(
			datingWarning(
				'DATING_NO_CLOCK_SIGNAL',
				'warn',
				fillMessage(DATING_MESSAGES.NO_CLOCK_SIGNAL, {
					p: Number(ols.p_value).toPrecision(3),
					pct: (Number(ols.r2) * 100).toFixed(1),
					r2: Number(ols.r2).toFixed(3)
				}),
				{ p_value: ols.p_value, r2: ols.r2, fieller_g: Number.isFinite(ols.fieller_g) ? ols.fieller_g : null, alpha: DATING_SIGNAL_ALPHA }
			)
		);
	}
	if (ols.fieller_g >= 1.0 && Array.isArray(ols.ci_fieller) && ols.ci_fieller[0] === -Infinity) {
		warnings.push(
			datingWarning(
				'DATING_UNBOUNDED_ANTIQUITY',
				'warn',
				fillMessage(DATING_MESSAGES.UNBOUNDED_ANTIQUITY, { g: ols.fieller_g.toFixed(3), high: ols.ci_fieller[1].toFixed(1) }),
				{ g: ols.fieller_g, ci: [...ols.ci_fieller] }
			)
		);
	}

	// dating.py:2777-2805 — REML for Pagel's λ on the TRAINING slice of the covariance, then the GLS
	// fit. The covariance is sliced twice, in this order: kernel over every taxon the model read ->
	// the dated ones -> the training ones (:2568, :2576, :2781).
	let pgls = null;
	let covTrain = null;
	let pagelLambda = null;
	let printedRidge = null;
	if (hasModel) {
		// In latent mode `taxa` came FROM the model's own list, so every name is there. In tn93 mode it
		// came from the divergence step, and a name the model never read has no row in the covariance.
		// The reference builds `sub_taxa` and then indexes `is_train` by position in it
		// (dating.py:2776-2781) — which is the taxa-order index, so a dropped name silently shifts
		// every holdout by one. Rather than replicate an off-by-one into a date, this drops the
		// model-based half for the run and says so; the ordinary fit and the curvature test are
		// unaffected, because they never used the covariance.
		const missing = taxa.filter((t) => !modelIndexOf.has(t));
		if (missing.length > 0) {
			warnings.push(
				datingWarning(
					'DATING_MODEL_TAXA_MISSING',
					'warn',
					fillMessage(DATING_MESSAGES.MODEL_TAXA_MISSING, { n: missing.length, names: nameSample(missing) }),
					{ count: missing.length, taxa: missing.slice(0, DATING_THRESHOLDS.sampleNames) }
				)
			);
		} else {
			report(progress, 3, 6, `Fitting the model's clock on ${fitTimes.length} sequences...`);
			// kernel over every taxon the model read -> the dated ones -> the training ones
			// (dating.py:2568, :2576, :2781), in that order and never the other way round.
			const cov = sliceSymmetric(kernel, neural.N, taxa.map((t) => modelIndexOf.get(t)));
			covTrain = sliceSymmetric(cov, taxa.length, holdout.trainIndices);
			const fit = fitPgls({ times: fitTimes, dists: fitDists, covTrain, ciMethod });
			pgls = fit.pgls;
			pagelLambda = fit.pagelLambda;
			printedRidge = fit.printedRidge;
		}
	}
	throwIfAborted(signal);

	// dating.py:2843-2855's own try/except: a spline that will not fit leaves the record null and
	// the run goes on with the straight line. DATING Q10: with the model loaded, :2844 hands it the
	// SAME covariance the PGLS fit was given, so this is a generalised spline and not the one a
	// model-free run draws.
	report(progress, 4, 6, 'Testing the clock for curvature...');
	let spline = null;
	if (clockModel === 'auto' || clockModel === 'spline') {
		try {
			spline = covTrain
				? runRestrictedSplineClockDating(fitTimes, fitDists, { covMatrix: covTrain, ridge: printedRidge })
				: runRestrictedSplineClockDating(fitTimes, fitDists);
			if (covTrain) {
				warnings.push(
					datingWarning(
						'DATING_MODEL_SPLINE_REWEIGHTED',
						'note',
						fillMessage(DATING_MESSAGES.MODEL_SPLINE_REWEIGHTED, { ridge: Number(printedRidge).toFixed(4) }),
						{ ridge: printedRidge, pagel_lambda: pagelLambda }
					)
				);
			}
		} catch (err) {
			warnings.push(
				datingWarning('DATING_SPLINE_PREFERRED', 'note', `The curvature test did not run: ${err.message}. The straight-line clock stands.`, {
					error: err.message
				})
			);
		}
	}
	throwIfAborted(signal);

	// --- 7. selection, ensemble, and the per-taxon table -------------------------------------------
	const selection = selectClockModel({ ols, pgls, spline, clockModel });
	warnings.push(...selection.warnings);
	const { ensemble, admitted, warnings: ensembleWarnings } = admitEnsembleCandidates({
		ols,
		pgls,
		spline,
		minSampleTime: tMin,
		selected: selection.name,
		cladeAttenuated: selection.cladeAttenuated
	});
	warnings.push(...ensembleWarnings);

	report(progress, 5, 6, `Predicting a date for each of ${taxa.length} sequences...`);
	const table = datingTaxonRecords({
		taxa,
		times,
		divergences,
		active: selection.model,
		isTrain: holdout.isTrain,
		trainIndices: holdout.trainIndices
	});
	warnings.push(...table.warnings);

	const primaeon = {
		schema_version: DATING_SCHEMA_VERSION,
		surface: provenance?.surface ?? 'runtime',
		time_units: timeUnits,
		/** See `alignment.js`: this pillar reads `*` as a gap because its reference-of-record did. */
		star_convention: 'gap',
		stars_rewritten: stars.stars,
		trimmed_nt: verified.trimmedBy,
		codon_count: verified.nCodons,
		sequences_in_file: verified.nTaxa,
		dated: datedTaxa.length,
		excluded_taxa: [...excluded],
		holdouts: holdout.holdouts,
		holdouts_reserved: holdout.reserved,
		train_count: holdout.trainIndices.length,
		root_case: rootCase,
		root_taxa: tf?.root_taxa ?? null,
		decay_gamma: tf?.gamma ?? null,
		distance_mode_reason: distModeReason,
		model_pass: hasModel
			? {
					taxa: neural.N,
					codons: neural.L ?? null,
					batch_size: neural.batchSize ?? null,
					calls: neural.calls ?? null,
					row_layers: neural.rowLayers ?? null,
					embed_dim: neural.embedDim ?? null,
					elapsed_seconds: neural.elapsedSeconds ?? null
				}
			: null,
		model_unavailable_reason: hasModel ? null : (modelUnavailableReason ?? null),
		/**
		 * DATING Q8: `pagel_lambda` is what the covariance was built from, `printed_ridge` is the
		 * `clip(1 - λ*, 0.01, 0.20)` the CLI prints and the SPLINE adds to every eigenvalue, and
		 * `record.pgls.ridge` is a third number (`1 - λ*` unclipped). They are recorded separately
		 * because a page that showed one under the other's name would be lying about the fit.
		 */
		pagel_lambda: pagelLambda,
		printed_ridge: printedRidge,
		clade_attenuation: pgls ? selection.attenuation : null,
		ensemble_admitted: admitted,
		prediction_methods: countBy(table.methods),
		bracket_ceiling: table.bracketCeiling,
		d_knot0: table.dKnot0,
		estimators_not_built: notBuilt(hasModel),
		...(provenance ?? {})
	};

	const record = buildDatingRecord({
		alignment: alignmentName,
		rootDescription,
		distanceMode: distMode,
		taxaCount: taxa.length,
		timespan: [tMin, tMax],
		elapsedSeconds: (Date.now() - t0) / 1000,
		activeModel: selection.name,
		ols,
		pgls,
		latentRoot: latent,
		spline,
		clockModel,
		ciMethod,
		selectedClock: selection.selectedClock,
		ensemble,
		rows: table.rows,
		primaeon
	});

	report(progress, 6, 6, 'Done.');
	return {
		ok: true,
		refusal: null,
		warnings: sortDatingWarnings(warnings),
		record,
		rows: table.rows,
		taxa,
		times,
		divergences,
		coverage: holdout.coverage,
		trainIndices: holdout.trainIndices,
		ols,
		pgls,
		latent,
		spline,
		distanceMode: distMode,
		distanceModeReason: distModeReason,
		pagelLambda,
		printedRidge,
		covTrain,
		active: selection.model,
		activeName: selection.name,
		selectedClock: selection.selectedClock,
		ensemble,
		methods: table.methods,
		rootDescription,
		rootCase,
		rootSequence
	};
}

/**
 * What this build does not estimate, and why — carried in the record so a page can say it in place
 * rather than promise it (web/DESIGN.md §5 forbids "coming soon"). PLAN-TEMPORAL D29 and D33.
 */
export const NOT_BUILT = Object.freeze([
	{
		name: 'Power-law clock',
		reason:
			'Not ported (PLAN-TEMPORAL D33): a box-constrained quasi-Newton fit on a 7x4 restart grid plus 500 ' +
			'bootstrap refits, serving a branch the automatic choice never selects.'
	},
	{
		name: 'Leave-one-out / jackknife',
		reason: 'Opt-in upstream behind --loocv, refit from scratch per taxon, and it brings a sixth interval method.'
	}
]);

/**
 * The two entries that come out only when the model-based half did NOT run. They are not "not
 * built" any more — phase 4 built them — so on a run without the dating graph they say what is
 * missing and why, and on a run with it they are absent from the list entirely. `NOT_BUILT` above
 * is what stays true either way.
 */
export const NOT_BUILT_WITHOUT_MODEL = Object.freeze([
	{
		name: 'Attention PGLS',
		reason:
			'Needs the dating graph (`<variant>_taxa.onnx`): a taxon-by-taxon attention matrix and ' +
			'per-taxon embeddings, averaged inside the graph because the unreduced tensor is 12.6 MB per ' +
			'site. The backbone emits the ROOT token\'s attention row and the ROOT token\'s vector — ' +
			'vectors where these are matrices — and neither can be derived from the other.'
	},
	{
		name: 'Latent root search',
		reason:
			'Same graph, same reason: it places a root inside the convex hull of the model\'s own ' +
			'representation of the sequences, so without those representations there is nothing to search.'
	}
]);

/** What to tell a reader this run did not estimate, given whether the model ran. */
function notBuilt(hasModel) {
	return hasModel ? NOT_BUILT : Object.freeze([...NOT_BUILT_WITHOUT_MODEL, ...NOT_BUILT]);
}

/** `dating.py:650` and `:659` — the magic strings the root argument may be instead of a name. */
function isMagicRoot(name) {
	const l = String(name).toLowerCase();
	return ['unweighted_consensus', 'flat_consensus', 'modal_consensus', 'earliest', 'earliest_taxon', 'earliest_cohort'].includes(l);
}

function countBy(values) {
	const out = {};
	for (const v of values) out[v] = (out[v] ?? 0) + 1;
	return out;
}
