/**
 * run.js — the one call the `/time` page, the MCP and the server make: an alignment and a set of
 * dates in, a dated ancestor and a per-sequence table out.
 *
 * WHY THIS FILE EXISTS. `runMeme` is to `cmd_meme` what this is to `run_mrca_dating`
 * (hyphaeon/dating.py:2412-3192) on its model-free path: the phase order, the refusals, the
 * progress reporting, the cancellation and the provenance, with every estimator call going to
 * `@veg/hyphaeon-js`. The chain, and the reference line each step mirrors:
 *
 *   parse            dataset.py:252    `parseAlignmentSequences` — first-token names, upper case, U→T
 *   verify           dating.py:135-222 `verifyCodingAlignment`   — L mod 3 trim, uniformity, stops
 *   asterisks        dataset.py:840    `starsToGaps`             — this pillar's convention (see alignment.js)
 *   dates            dating.py:2487    the caller's, from `runtime/src/dates/`
 *   dated set        dating.py:2497    alignment order, NaN dropped, the root taxon dropped
 *   divergences      dating.py:624-698 `computeTreeFreeDivergences` — the four root cases
 *   holdouts         dating.py:2698    `coverageHoldout`
 *   OLS              dating.py:2714    `runOlsDating`
 *   spline           dating.py:2841    `runRestrictedSplineClockDating`
 *   selection        dating.py:2943    `selectClockModel`
 *   ensemble         dating.py:2894    `admitEnsembleCandidates`
 *   per-taxon table  dating.py:2999    `datingTaxonRecords`
 *
 * NOTHING HERE LOADS A MODEL, AND THAT IS ENFORCED BY THE IMPORT GRAPH, not by intention. This
 * directory imports `@veg/hyphaeon-js` and its own siblings and nothing else — not `manifest.js`,
 * not `predict.js`, not a session — so `@veg/hyphaeon-runtime/dating` cannot reach onnxruntime even
 * by accident, which is what keeps the `/time` route's "no `*.onnx`, no `ort-*.wasm`" assertion
 * true. That is why the four-line abort helper below is written out rather than imported from
 * `predict.js`, which reaches `feeds.js` and `manifest.js`; its behaviour (`err.name ===
 * 'AbortError'`) is deliberately identical, because every worker in this app checks that name.
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
	DATING_MESSAGES,
	DATING_REFUSALS,
	DATING_SCHEMA_VERSION,
	DATING_THRESHOLDS,
	datingWarning,
	fillMessage,
	nameSample,
	sortDatingWarnings
} from './codes.js';
import { buildDatingRecord, datingTaxonRecords } from './record.js';
import { admitEnsembleCandidates, selectClockModel } from './select.js';

/** The `ciMethod` strings this build implements; the library refuses the rest by name. */
export const DATING_CI_METHODS = Object.freeze(['fieller', 'delta', 'linear']);

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

	// --- 4. divergences to a root (dating.py:2687-2695) -------------------------------------------
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
	let tf;
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
	throwIfAborted(signal);

	const taxa = tf.taxa;
	const times = Float64Array.from(taxa, (t) => dateOf.get(t));
	const divergences = tf.divergences;
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

	// dating.py:2843-2855's own try/except: a spline that will not fit leaves the record null and
	// the run goes on with the straight line.
	report(progress, 4, 6, 'Testing the clock for curvature...');
	let spline = null;
	if (clockModel === 'auto' || clockModel === 'spline') {
		try {
			spline = runRestrictedSplineClockDating(fitTimes, fitDists);
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
	const selection = selectClockModel({ ols, spline, clockModel });
	warnings.push(...selection.warnings);
	const { ensemble, admitted, warnings: ensembleWarnings } = admitEnsembleCandidates({
		ols,
		spline,
		minSampleTime: tMin,
		selected: selection.name
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
		root_case: tf.case,
		root_taxa: tf.root_taxa,
		decay_gamma: tf.gamma,
		ensemble_admitted: admitted,
		prediction_methods: countBy(table.methods),
		bracket_ceiling: table.bracketCeiling,
		d_knot0: table.dKnot0,
		estimators_not_built: NOT_BUILT,
		...(provenance ?? {})
	};

	const record = buildDatingRecord({
		alignment: alignmentName,
		rootDescription: tf.root_description,
		distanceMode: 'tn93',
		taxaCount: taxa.length,
		timespan: [tMin, tMax],
		elapsedSeconds: (Date.now() - t0) / 1000,
		activeModel: selection.name,
		ols,
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
		spline,
		active: selection.model,
		activeName: selection.name,
		selectedClock: selection.selectedClock,
		ensemble,
		methods: table.methods,
		rootDescription: tf.root_description,
		rootCase: tf.case,
		rootSequence: tf.root_sequence ?? null
	};
}

/**
 * What this build does not estimate, and why — carried in the record so a page can say it in place
 * rather than promise it (web/DESIGN.md §5 forbids "coming soon"). PLAN-TEMPORAL D29 and D33.
 */
export const NOT_BUILT = Object.freeze([
	{
		name: 'Attention PGLS',
		reason:
			'Needs a taxon-by-taxon attention matrix and per-taxon embeddings averaged inside the graph; ' +
			'this build\'s export emits the root token\'s attention row and the root token\'s vector — vectors ' +
			'where those are matrices. A new export means a new manifest hash, new fixtures and a re-baked gallery.'
	},
	{
		name: 'Latent root search',
		reason: 'Same export, same reason: it optimises a root position in the model\'s representation space.'
	},
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
