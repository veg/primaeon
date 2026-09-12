/**
 * codes.js — the vocabulary of the dating pillar: diagnostic codes, the numbers this layer decides
 * with, and the refusal and warning texts a reader is shown.
 *
 * WHY THIS FILE EXISTS. It imports nothing but `fillMessage`/`nameSample` from the date layer's own
 * import-free `codes.js`, for the same reason that file imports nothing: a caller that only wants to
 * know what a code MEANS — the `/time` route rendering a warning, the MCP deciding whether a failure
 * is the reader's fault or ours — must be able to ask without loading an estimator, an alignment
 * parser or the library.
 *
 * WHAT IT IS NOT. There is no dating arithmetic here and there must never be. Every estimator on
 * this path is `@veg/hyphaeon-js`'s (`runOlsDating`, `runRestrictedSplineClockDating`,
 * `computeTreeFreeDivergences`, `clockFittedAndPredicted`, `residualScale`,
 * `precisionWeightedEnsemble`), ported function by function from `hyphaeon/dating.py`. A second
 * estimator in this repository is a bug, not a convenience — with ONE stated exception,
 * `runtime/src/clockRegression.js`, which is deliberately independent because it is the check this
 * port is compared against (read its header before touching anything near it).
 *
 * THE CODES ARE NAMESPACED `DATING_*` so they never collide with the date layer's `DATES_*` / `DATE_*`
 * or the library's `DIAGNOSTIC_CODES`, and `DATING_DIAGNOSTIC_CODES` is the REPORT ORDER, exactly as
 * `DATE_DIAGNOSTIC_CODES` is for the date layer.
 *
 * WHY SO MANY OF THESE WARNINGS EXIST AT ALL. The reference's own record presents four different
 * ancestor dates on the flagship example — `ols.t_mrca` 1893.91, `spline.t_mrca` 1938.77,
 * `ensemble.t_mrca` 1893.91 with a THIRD interval, and a top-level `t_mrca` of 1938.77 because the
 * selected model is the spline — and says nothing about the relationship between them. Three of the
 * codes below (`DATING_SPLINE_NO_INTERVAL`, `DATING_SPLINE_PREFERRED`,
 * `DATING_ENSEMBLE_RESYMMETRISED`) exist so a page cannot print those numbers side by side without
 * saying which is which. That is result semantics, which is why it is here and not in the library.
 */

import { fillMessage, nameSample } from '../dates/codes.js';

export { fillMessage, nameSample };

/**
 * Bumped when `DatingRecord`'s shape changes in a way a stored record cannot be read under. Phase 4
 * takes it to 2: `pgls` and `latent_root` stop being permanently null, `distance_mode` can now say
 * `'latent'`, and `primaeon` gains the model block (`model_pass`, `pagel_lambda`, `printed_ridge`,
 * `distance_mode_reason`). A version-1 record is still readable — every added key is additive — but
 * a reader that shows a PGLS fit must know whether the record could have carried one.
 */
export const DATING_SCHEMA_VERSION = 2;

/**
 * Deterministic report order. A warning whose code is not in this list sorts last, stably.
 * The order runs: what was done to the sequences before anything was measured -> what was done to
 * the taxon set -> which model was chosen and what it can and cannot say -> what the per-taxon
 * table means -> the refusals.
 */
export const DATING_DIAGNOSTIC_CODES = Object.freeze([
	'DATING_ALIGNMENT_TRIMMED',
	'DATING_STOP_CODONS',
	'DATING_STARS_REWRITTEN',
	'DATING_ROOT_TAXON_NOT_FOUND',
	'DATING_ROOT_SYNTHETIC',
	'DATING_TAXA_EXCLUDED',
	'DATING_HOLDOUTS_RESERVED',
	'DATING_HOLDOUTS_IN_FIT',
	'DATING_MODEL_GRAPH_ABSENT',
	'DATING_MODEL_TAXA_MISSING',
	'DATING_LATENT_DIVERGENCES',
	'DATING_LATENT_ALPHA_ASSUMED',
	'DATING_MODEL_SPLINE_REWEIGHTED',
	'DATING_CLADE_ATTENUATED',
	'DATING_SPLINE_PREFERRED',
	'DATING_SPLINE_NO_INTERVAL',
	'DATING_UNBOUNDED_ANTIQUITY',
	'DATING_ENSEMBLE_RESYMMETRISED',
	'DATING_ENSEMBLE_IGNORES_SELECTED',
	'DATING_PREDICTION_FALLBACK',
	'DATING_PREDICTION_SATURATED',
	'DATING_OUTLIERS',
	'DATING_NON_POSITIVE_RATE',
	'DATING_MRCA_AFTER_EARLIEST_SAMPLE',
	'DATING_ALIGNMENT_EMPTY',
	'DATING_ALIGNMENT_RAGGED',
	'DATING_ALIGNMENT_NOT_CODING',
	'DATING_TOO_FEW_DATED',
	'DATING_NO_TIME_SPAN',
	'DATING_TN93_UNCOMPUTABLE',
	'DATING_MODEL_TOO_MANY_TAXA'
]);

/**
 * The refusals: a run that produced no estimate. Every one of these is RETURNED as
 * `{ok: false, refusal: <code>}` with a message, never thrown — the date layer's contract, and the
 * one `diagnose()` set for the whole package.
 */
export const DATING_REFUSALS = Object.freeze({
	ALIGNMENT_EMPTY: 'DATING_ALIGNMENT_EMPTY',
	ALIGNMENT_RAGGED: 'DATING_ALIGNMENT_RAGGED',
	ALIGNMENT_NOT_CODING: 'DATING_ALIGNMENT_NOT_CODING',
	TOO_FEW_DATED: 'DATING_TOO_FEW_DATED',
	NO_TIME_SPAN: 'DATING_NO_TIME_SPAN',
	TN93_UNCOMPUTABLE: 'DATING_TN93_UNCOMPUTABLE',
	/**
	 * `dating.py:2745-2747` gives up on the transformer above 1,500 sequences without a tree and
	 * falls back to OLS and the spline. A run that ASKED for the model-based estimators at that size
	 * is refused here instead, because the fallback and the thing that was asked for are different
	 * answers under one name.
	 */
	MODEL_TOO_MANY_TAXA: 'DATING_MODEL_TOO_MANY_TAXA'
});

/**
 * Which arm of `clockFittedAndPredicted` produced a row's `predicted_date`. THE REFERENCE EMITS NO
 * SUCH FIELD, and that is the defect this vocabulary answers: on the flagship example 12 of 142 rows
 * come from the ancestral LINEAR inverse because `brentq`'s bracket was refused (dating.py:3024's
 * bare `except`), 12 more from the spline's strictly linear arm below the first knot, and 118 from
 * the root find — three models in one column with nothing in the JSON or the CSV marking them.
 */
export const PREDICTION_METHODS = Object.freeze(['ols', 'spline', 'linear_arm', 'linear_fallback', 'none']);

/**
 * The numbers this layer decides with. Each is either the reference's own constant, cited, or a
 * judgement stated here so it can be argued with in one place.
 */
export const DATING_THRESHOLDS = Object.freeze({
	/** `dating.py:2505`. Two dated points give a line with no residual degrees of freedom. */
	minDatedTaxa: 3,
	/** `dating.py:1837`. The restricted cubic spline needs three knots and a residual d.f. */
	minSplineTaxa: 5,
	/** `dating.py:2701`. Fraction of UPPER-CASE `ACGT` at or above which a sequence calibrates. */
	coverageTrain: 0.5,
	/** `dating.py:2706`. A holdout is only reserved when at least this many training rows survive. */
	minTrainAfterHoldout: 3,
	/** `dating.py:3061`, and `clockRegression.js`'s `OUTLIER_Z`. Non-robust by construction. */
	outlierZ: 2.5,
	/** `dating.py:3015`/`:3038`. Below this rate no date is predicted at all. */
	predictRateFloor: 1e-6,
	/** How many names a message carries, matching the date layer's own cap. */
	sampleNames: 10,
	/**
	 * A `predicted_date` within this many years of the root find's bracket ceiling
	 * (`max(times) + 100`, dating.py:3019) is reported as SATURATED rather than as a date. MEASURED
	 * on korber under the selected spline: the largest predicted date is 2097.19 against a ceiling
	 * of 2097.5, i.e. the inversion is pressed against its own bracket, and 13 rows land after 2050.
	 * One year is a tenth of the smallest gap between that cluster and the next date below it.
	 */
	bracketSaturationYears: 1.0
});

/**
 * The texts. `{...}` placeholders are filled by `fillMessage`. Every one of these is a FACT in the
 * results' own voice (web/DESIGN.md §5), not an alarm: a refusal is one sentence plus the next
 * action, a warning is what happened and what it costs.
 */
export const DATING_MESSAGES = Object.freeze({
	ALIGNMENT_EMPTY: 'The alignment holds no sequences, so there is nothing to date.',
	ALIGNMENT_RAGGED:
		'The sequences are not aligned to one length ({length} nt expected). Mismatched: {details}. ' +
		'Every distance here is computed column by column, so a ragged alignment has no distances to ' +
		'compute — align the sequences first.',
	ALIGNMENT_NOT_CODING:
		'The alignment is {length} nt long, which is not a multiple of three ({rem} left over). ' +
		'HyphAeon is a codon model and the reference trims the remainder; this run was asked not to.',
	ALIGNMENT_TRIMMED:
		'The alignment is {length} nt long, not a multiple of three, so {rem} trailing nucleotide(s) ' +
		'were trimmed before anything was measured — the reference does the same, silently ' +
		'(dating.py:163-174). Distances, and therefore every number below, are computed on the ' +
		'trimmed sequences.',
	STOP_CODONS:
		'{total} internal stop codon(s) across {taxa} of {all} sequences. The dating path does not ' +
		'translate anything, so they cost nothing here, but they usually mean the reading frame is ' +
		'not what it looks like.',
	STARS_REWRITTEN:
		'{stars} asterisk(s) across {taxa} sequence(s) were read as gaps before distances were ' +
		'computed. That is what the reference does when a compiled `tn93` is on its PATH ' +
		'(dataset.py:840, 844) and not what it does otherwise, and the two give different answers: ' +
		'on this pillar the gap convention is the one the published numbers came from.',
	ROOT_TAXON_NOT_FOUND:
		"No sequence is named '{root}', so divergence was not measured to it. The reference tests " +
		'that name against the alignment first and falls through without a word (dating.py:643); ' +
		'this run used {used} instead. Check the spelling if you meant a sequence.',
	ROOT_SYNTHETIC:
		'The root is not one of your sequences: {description}. Divergence is measured to a sequence ' +
		'this run built, so the ancestor date moves with it — a root a constant amount too deep moves ' +
		'the ancestor earlier by that amount divided by the clock rate.',
	TAXA_EXCLUDED: '{n} sequence(s) were excluded from this run at your request: {names}.',
	HOLDOUTS_RESERVED:
		'{n} sequence(s) carry data at under half their sites and were reserved OUT of the fit as ' +
		'out-of-sample checks: {names}. Their dates are predicted from a clock they did not ' +
		'calibrate, and a reserved sequence is never flagged as an outlier (dating.py:3049), so a ' +
		'wrong date on a partial sequence cannot be caught in the table below.',
	HOLDOUTS_IN_FIT:
		'{n} sequence(s) carry data at under half their sites and are labelled "held out" in the table ' +
		'below — but they are IN the fit, because reserving them would leave fewer than {min} ' +
		'sequences to calibrate on. The reference computes the label and the fit separately ' +
		'(dating.py:2706 against :3046) and does not notice; here the label is the one that is wrong. ' +
		'Sequences: {names}.',
	SPLINE_PREFERRED:
		'The curvature test prefers a decelerating clock over the straight line: the rate falls from ' +
		'{ancestral} early to {recent} recently, a ratio of {ratio} (F = {f} on 1 and {df} d.f., ' +
		'p = {p}, ΔAIC = {daic}). That model puts the ancestor at {tmrca}.',
	SPLINE_NO_INTERVAL:
		'The spline clock has no interval to show. Its bootstrap never runs upstream — ' +
		'`dating.py:1917` passes numpy\'s `rcond=` to `scipy.linalg.lstsq`, whose keyword is `cond=`, ' +
		'so every replicate raises inside a bare `except` and all four of its intervals collapse to ' +
		'their point estimates. A zero-width 95 % interval is not an interval and must not be drawn ' +
		'as one.',
	UNBOUNDED_ANTIQUITY:
		'The interval has no lower bound: the clock rate is not distinguishable from zero at 95 % ' +
		'(Fieller g = {g} ≥ 1), so the data are consistent with an arbitrarily old ancestor. The ' +
		'upper bound is {high}.',
	ENSEMBLE_RESYMMETRISED:
		'The model-averaged row reads each interval as a symmetric Gaussian one — (high − low) / ' +
		'(2 × 1.96), dating.py:2916 — and re-forms it. Applied to a Fieller interval, which is ' +
		'deliberately skewed, that returns a different interval from the one it was built from. It is ' +
		'reported because the reference record carries it, not as a second answer.',
	PREDICTION_FALLBACK:
		'{n} predicted date(s) do not come from the model the rest of the column comes from. Under a ' +
		'decelerating spline the fitted divergence is bounded above, so a sequence more diverged than ' +
		'that ceiling has no date on the curve; the reference catches the failure and substitutes the ' +
		'ancestral straight line (dating.py:3024) without marking the row. These rows are marked.',
	PREDICTION_SATURATED:
		'{n} predicted date(s) sit within {window} year(s) of the root find\'s own bracket ceiling ' +
		'({ceiling}), which means the inversion ran out of room rather than converging on a date. ' +
		'Read them as "later than the data can say", not as dates.',
	OUTLIERS:
		'{n} sequence(s) sit at |z| ≥ {z} and are flagged. The scale is a plain population standard ' +
		'deviation of the training residuals (dating.py:3041, ddof = 0), so several bad dates inflate ' +
		'their own denominator and mask one another; the threshold is the reference\'s fixed 2.5.',
	NON_POSITIVE_RATE:
		'The clock rate is not positive ({mu}), so no ancestor date was computed. Divergence does not ' +
		'increase with sampling date in these data: check the dates, the root, and whether the ' +
		'sequences are one clade.',
	MRCA_AFTER_EARLIEST_SAMPLE:
		'The fitted ancestor ({tmrca}) is not earlier than the earliest sequence in the fit ' +
		'({earliest}), which is impossible, so the estimate was discarded rather than labelled — the ' +
		'reference does the same (dating.py:1230).',
	TOO_FEW_DATED:
		'Only {dated} sequence(s) could be dated; at least {min} are needed. Two dated points define a ' +
		'line with no residual degrees of freedom, so every rate and every interval would be undefined.',
	NO_TIME_SPAN:
		'Every dated sequence carries the same date ({value}). A clock is a slope against time; with ' +
		'no spread on the time axis there is nothing to estimate.',
	TN93_UNCOMPUTABLE:
		'A pair of sequences is too diverged for a TN93 distance to exist ({error}). The distance is ' +
		'the logarithm of a quantity that has gone non-positive — the alignment is saturated at this ' +
		'depth, and a number here would be fiction rather than a distance.',
	MODEL_GRAPH_ABSENT:
		'The two model-based estimators did not run: this build has no dating graph ({reason}). They ' +
		'need a taxon-by-taxon attention matrix and per-taxon embeddings, which the backbone graph ' +
		'does not emit — it carries the ROOT token\'s attention row and the ROOT token\'s vector, ' +
		'vectors where these are matrices, and neither can be derived from the other. The ordinary ' +
		'fit and the curvature test below are unaffected.',
	MODEL_TAXA_MISSING:
		'{n} dated sequence(s) are not in the model\'s own taxon list and were dropped from the ' +
		'covariance and from every fit: {names}. That happens when the alignment the model read and ' +
		'the sequences being dated are not the same set.',
	MODEL_TOO_MANY_TAXA:
		'{n} sequences is more than the {max} the model-based estimators are run at. The reference ' +
		'stops at the same number and quietly falls back to the ordinary fit (dating.py:2745); this ' +
		'refuses instead, because the covariance the fallback does not build is the whole difference ' +
		'between the two answers.',
	LATENT_DIVERGENCES:
		'Divergence here is NOT a sequence distance. The model placed a root inside the convex hull ' +
		'of its own representation of your sequences, and every divergence below is the distance to ' +
		'that root in that space, rescaled to substitutions per site by one slope (α = {alpha}) fitted ' +
		'against the observed pairwise differences. EVERY estimator is fitted against it, the ' +
		'ordinary one included: this is what `--distance-mode auto` resolves to when there is no tree ' +
		'and a model is available (dating.py:2520-2523). The temporal correlation of that root is ' +
		'R = {r}.',
	LATENT_ALPHA_ASSUMED:
		'The latent-to-substitution scale was not fitted: with no pairwise sequence distances to ' +
		'calibrate against, the reference assumes 0.05 substitutions per site at the mean latent ' +
		'distance (dating.py:756-757). The clock rate below is therefore a scale guess and not a ' +
		'measurement; the ancestor DATE, which is a ratio of two quantities on the same scale, is not ' +
		'affected.',
	MODEL_SPLINE_REWEIGHTED:
		'The curvature test was fitted against the model\'s covariance, not against independent ' +
		'residuals — `dating.py:2844` hands the spline the same kernel the PGLS fit uses the moment ' +
		'the model runs. On identical divergences that moves its answer: it is a generalised fit ' +
		'here and an ordinary one in a model-free run, and the two are not comparable. It is also ' +
		'regularised differently from the PGLS fit beside it (K + {ridge}·I against λK + (1−λ)I), ' +
		'which is upstream\'s inconsistency and is reproduced rather than reconciled.',
	CLADE_ATTENUATED:
		'The model\'s covariance deflated the clock rate {factor}-fold, from {ols} to {pgls}, while ' +
		'explaining less of the variance than the ordinary fit. That is the signature of a sample ' +
		'whose phylogenetic structure and whose sampling dates are confounded: the generalised fit ' +
		'attributes the temporal signal to shared ancestry instead. The ordinary fit answers, and the ' +
		'generalised one is kept out of the model-averaged row as well (dating.py:2884-2891, :2905).'
});

/**
 * Sort a warning list into `DATING_DIAGNOSTIC_CODES` order, stably; an unknown code sorts last.
 * @template {{code: string}} W
 * @param {W[]} warnings
 * @returns {W[]}
 */
export function sortDatingWarnings(warnings) {
	const rank = (/** @type {{code: string}} */ w) => {
		const i = DATING_DIAGNOSTIC_CODES.indexOf(w.code);
		return i < 0 ? DATING_DIAGNOSTIC_CODES.length : i;
	};
	return warnings
		.map((w, i) => ({ w, i }))
		.sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
		.map(({ w }) => w);
}

/**
 * One diagnostic. `severity` is the date layer's: `'refuse'` stops the run, `'warn'` is shown,
 * `'note'` is a fact worth stating that costs the reader nothing.
 * @param {string} code
 * @param {'refuse'|'warn'|'note'} severity
 * @param {string} message
 * @param {object} [data]
 */
export function datingWarning(code, severity, message, data = {}) {
	return { code, severity, message, data };
}
