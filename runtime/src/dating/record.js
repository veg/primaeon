/**
 * record.js — the per-sequence table a reader acts on, and the record every surface stores and
 * downloads.
 *
 * WHY THIS FILE EXISTS. The library computes fitted values, inverted dates and a residual scale
 * (`clockFittedAndPredicted`, `residualScale`, both mirroring dating.py:3000-3042). What it does not
 * do, and must not, is decide what a row MEANS: which sequence is flagged, in what order the rows
 * are read, what the columns are called, and which of them are safe to present as dates. That is
 * result semantics — the same reason `postprocess.js` and `callModes.js` are app-side for the
 * selection pillar — and it is where the honest work of this phase is.
 *
 * KEY NAMES AND KEY ORDER ARE THE REFERENCE'S (dating.py:3052-3062), because they are the download
 * contract: `pd.DataFrame(taxon_records).to_csv(index=False)` at :3186 writes exactly these ten
 * columns in exactly this order, and `taxa_summary` in the JSON is the same records. A port that
 * renamed one would break a diff against a CLI run silently. ONE column is added, last, and it is
 * ours: `prediction_method`.
 *
 * =========================== WHY `prediction_method` EXISTS (MEASURED) ===========================
 *
 * Under the selected spline on the flagship example, the `predicted_date` column is produced by
 * THREE different models and the reference marks none of them:
 *
 *     118 of 142 rows   brentq on the fitted curve
 *      12 of 142 rows   the strictly linear arm below the first knot (d <= d_kn0)
 *      12 of 142 rows   the ANCESTRAL LINEAR inverse, because a decelerating spline is bounded
 *                       above and those sequences are more diverged than the curve ever gets, so
 *                       brentq's bracket is refused and dating.py:3026's bare `except` substitutes
 *                       a different model — producing dates of 1994-1999 that look entirely ordinary
 *
 * and the surviving root finds are not healthy either: 36 rows predict after 2010, 13 after 2050,
 * and the largest is 2097.19 against a bracket ceiling of `max(times) + 100 = 2097.5`. That is an
 * inversion pressed against its own bracket, not a date. `DATING_PREDICTION_FALLBACK` names the
 * first defect and `DATING_PREDICTION_SATURATED` the second, and both are the reason the plan's own
 * risk line — "a subtly wrong port produces plausible, wrong dates that never announce themselves" —
 * applies to the reference itself here, not only to the port.
 *
 * TWO NON-ROBUST CHOICES ARE REPLICATED ON PURPOSE, and `clockRegression.js` already says why in its
 * own header: the z-score is a DIVERGENCE residual over a PLAIN population standard deviation
 * (ddof = 0) of the TRAINING residuals, so gross outliers inflate their own denominator; and the
 * flag is a fixed |z| >= 2.5. Substituting a median-absolute-deviation scale would be improving
 * during a port. On the acceptance example the consequence is concrete: max |z| is 2.393 and the
 * run therefore flags NOTHING, while the sequence every reader looks at — the 1959 Léopoldville
 * isolate — is a holdout that the rule forbids flagging at all (dating.py:3049).
 *
 * ROW ORDER. `datingTaxonRecords` returns rows in ALIGNMENT ORDER, because that is what the
 * reference's CSV is and a download must be diffable against a CLI run. `rankTaxonRows` is the
 * separate, reader-facing order — flagged first, then the labelled holdouts, then by |z| descending,
 * then by name — and a page sorts with it rather than re-sorting the record.
 */

import { clockFittedAndPredicted, residualScale } from '@veg/hyphaeon-js';

import { DATING_MESSAGES, DATING_SCHEMA_VERSION, DATING_THRESHOLDS, datingWarning, fillMessage, nameSample } from './codes.js';

/** The reference's ten columns, in the reference's order (dating.py:3052-3062). */
export const TAXON_COLUMNS = Object.freeze([
	'taxon',
	'sampling_date',
	'root_divergence',
	'fitted_divergence',
	'predicted_date',
	'divergence_residual',
	'temporal_residual',
	'z_score',
	'is_outlier',
	'is_holdout'
]);

/** The reference's top-level key set and order (dating.py:3150-3181). */
export const RECORD_KEYS = Object.freeze([
	'alignment',
	'tree',
	'root_description',
	'distance_mode',
	'latent_root',
	'taxa_count',
	'timespan',
	'elapsed_seconds',
	'active_model',
	't_mrca',
	'ci_mrca',
	'mu',
	'ols',
	'pgls',
	'spline',
	'power',
	'clock_model',
	'ci_method',
	'selected_clock',
	'ensemble',
	'loocv',
	'taxa_summary'
]);

/**
 * `dating.py:3000-3062`, in alignment order.
 *
 * @param {{taxa: readonly string[], times: ArrayLike<number>, divergences: ArrayLike<number>,
 *   active: object, isTrain: readonly boolean[], trainIndices: readonly number[]}} args
 * @returns {{rows: object[], residuals: Float64Array, scale: number, methods: string[],
 *   dKnot0: number|null, bracketCeiling: number|null, warnings: Array<object>}}
 */
export function datingTaxonRecords({ taxa, times, divergences, active, isTrain, trainIndices }) {
	const n = taxa.length;
	const { fitted, predicted, methods, dKnot0 } = clockFittedAndPredicted(active, times, divergences);
	const residuals = new Float64Array(n);
	for (let i = 0; i < n; i++) residuals[i] = divergences[i] - fitted[i];
	const scale = residualScale(residuals, trainIndices);

	// dating.py:3019's bracket ceiling, recomputed here only so a saturated row can be named.
	let tMax = -Infinity;
	for (let i = 0; i < n; i++) if (times[i] > tMax) tMax = times[i];
	const isSpline = active?.method === 'RESTRICTED_SPLINE';
	const bracketCeiling = isSpline && Number.isFinite(tMax) ? tMax + 100.0 : null;

	const rows = [];
	const fallbacks = [];
	const saturated = [];
	const outliers = [];
	for (let i = 0; i < n; i++) {
		const holdout = !isTrain[i];
		const z = residuals[i] / scale;
		// dating.py:3049 — a holdout is NEVER flagged, whatever its residual.
		const outlier = holdout ? false : Math.abs(z) >= DATING_THRESHOLDS.outlierZ;
		if (outlier) outliers.push(taxa[i]);
		if (methods[i] === 'linear_fallback') fallbacks.push(taxa[i]);
		if (
			bracketCeiling !== null &&
			methods[i] === 'spline' &&
			Number.isFinite(predicted[i]) &&
			bracketCeiling - predicted[i] <= DATING_THRESHOLDS.bracketSaturationYears
		) {
			saturated.push(taxa[i]);
		}
		rows.push({
			taxon: taxa[i],
			sampling_date: times[i],
			root_divergence: divergences[i],
			fitted_divergence: fitted[i],
			predicted_date: predicted[i],
			divergence_residual: residuals[i],
			temporal_residual: Number.isNaN(predicted[i]) ? NaN : predicted[i] - times[i],
			z_score: z,
			is_outlier: outlier,
			is_holdout: holdout,
			// Ours, appended after the reference's ten so a reader of the CLI's record sees the same
			// prefix. PARITY.md's rule: extra keys are ignored.
			prediction_method: methods[i]
		});
	}

	const warnings = [];
	if (fallbacks.length > 0) {
		warnings.push(
			datingWarning('DATING_PREDICTION_FALLBACK', 'warn', fillMessage(DATING_MESSAGES.PREDICTION_FALLBACK, { n: fallbacks.length }), {
				count: fallbacks.length,
				taxa: fallbacks.slice(0, DATING_THRESHOLDS.sampleNames)
			})
		);
	}
	if (saturated.length > 0) {
		warnings.push(
			datingWarning(
				'DATING_PREDICTION_SATURATED',
				'warn',
				fillMessage(DATING_MESSAGES.PREDICTION_SATURATED, {
					n: saturated.length,
					window: DATING_THRESHOLDS.bracketSaturationYears,
					ceiling: bracketCeiling
				}),
				{ count: saturated.length, ceiling: bracketCeiling, taxa: saturated.slice(0, DATING_THRESHOLDS.sampleNames) }
			)
		);
	}
	if (outliers.length > 0) {
		warnings.push(
			datingWarning(
				'DATING_OUTLIERS',
				'warn',
				fillMessage(DATING_MESSAGES.OUTLIERS, { n: outliers.length, z: DATING_THRESHOLDS.outlierZ }),
				{ count: outliers.length, taxa: outliers.slice(0, DATING_THRESHOLDS.sampleNames) }
			)
		);
	}

	return { rows, residuals, scale, methods, dKnot0, bracketCeiling, warnings };
}

/**
 * The reader's order, which is NOT the record's: flagged first, then the sequences labelled held
 * out, then by |z| descending, then by name. A page sorts a copy with this; the record itself stays
 * in alignment order so a download diffs against a CLI run.
 *
 * @param {object[]} rows
 * @returns {object[]} a new array
 */
export function rankTaxonRows(rows) {
	const key = (r) => (Number.isFinite(r.z_score) ? Math.abs(r.z_score) : -Infinity);
	return [...rows].sort(
		(a, b) =>
			Number(b.is_outlier) - Number(a.is_outlier) ||
			Number(b.is_holdout) - Number(a.is_holdout) ||
			key(b) - key(a) ||
			a.taxon.localeCompare(b.taxon)
	);
}

/**
 * The reference's record (dating.py:3150-3181) plus one key of ours.
 *
 * `power` and `loocv` are `null` here exactly as the reference leaves them under this build's
 * options (D33 drops the power-law clock; `--loocv` is not offered), and `tree` is always `null`
 * because this pillar is tree-free by construction (D34 declines re-rooting). `pgls` and
 * `latent_root` are null ONLY when the model-based half did not run — either because the manifest
 * declares no dating graph or because the caller did not ask for it — which is what `--method ols`
 * produces on the reference too. `elapsed_seconds` is the run's own wall clock, which is the one
 * field two runs of the reference itself disagree on.
 *
 * `latent_root` IS A FOUR-KEY SUBSET, not the estimator's whole record. `dating.py:3155-3161`
 * exports `alpha`, `temporal_r`, `temporal_r2` and `anchor_taxa` and drops `z_root`, `weights`,
 * `dists`, `dists_latent`, `mu_ols` and `t_mrca_ols` — the 384-vector and the four per-taxon arrays
 * are not in the download, and `t_mrca_ols` in particular is a DIAGNOSTIC fitted on the uncentred
 * calendar axis (dating.py:804-806) that would sit beside the real OLS fit looking like a second
 * opinion. The subset is the reference's and is reproduced exactly.
 *
 * `primaeon` is the added key: a name the reference does not use, so it cannot collide, carrying the
 * provenance a browser run needs and a CLI run has no place for.
 *
 * @param {object} args
 * @returns {Record<string, any>}
 */
export function buildDatingRecord(args) {
	const {
		alignment = null,
		rootDescription,
		distanceMode = 'tn93',
		taxaCount,
		timespan,
		elapsedSeconds,
		activeModel,
		ols,
		pgls = null,
		latentRoot = null,
		spline,
		clockModel = 'auto',
		ciMethod = 'fieller',
		selectedClock,
		ensemble,
		rows,
		primaeon = null
	} = args;

	const active = activeModel === 'spline' ? spline : activeModel === 'pgls' ? pgls : ols;
	const tMrca = active && Number.isFinite(active.t_mrca) ? active.t_mrca : null;
	const mu = active ? (active.mu ?? active.rate_ancestral ?? 0.0) : null;

	return {
		alignment,
		tree: null,
		root_description: rootDescription,
		distance_mode: distanceMode,
		latent_root: latentRootExport(latentRoot),
		taxa_count: taxaCount,
		timespan,
		elapsed_seconds: elapsedSeconds,
		active_model: activeModel,
		t_mrca: tMrca,
		ci_mrca: active ? (active.ci_mrca ?? null) : null,
		mu,
		ols: stripArrays(ols, ['residuals', 'fitted', 'times', 'cov_beta']),
		// dating.py:3169 drops the same three keys from the PGLS record; `cov_beta` is the library's
		// one addition and joins them for the same reason it does on the OLS record.
		pgls: stripArrays(pgls, ['residuals', 'fitted', 'times', 'cov_beta']),
		spline: stripArrays(spline, ['residuals', 'fitted']),
		power: null,
		clock_model: clockModel,
		ci_method: ciMethod,
		selected_clock: selectedClock,
		ensemble,
		loocv: null,
		taxa_summary: rows,
		primaeon: primaeon ?? { schema_version: DATING_SCHEMA_VERSION }
	};
}

/** `dating.py:3155-3161`'s four keys, in the reference's order. See the note in the header. */
function latentRootExport(latent) {
	if (latent == null) return null;
	return {
		alpha: latent.alpha,
		temporal_r: latent.temporal_r,
		temporal_r2: latent.temporal_r2,
		anchor_taxa: (latent.anchor_taxa ?? []).map((a) => ({ taxon: a.taxon, weight: a.weight, date: a.date }))
	};
}

/**
 * `{k: v for k, v in res.items() if k not in [...]}` (dating.py:3170-3172), preserving key order.
 * `cov_beta` joins the dropped set on the OLS record: it is the library's ONE added key, a typed
 * array the app uses to avoid refitting, and it is not in the reference's download.
 */
function stripArrays(record, drop) {
	if (record == null) return null;
	const out = {};
	for (const [k, v] of Object.entries(record)) {
		if (drop.includes(k)) continue;
		out[k] = ArrayBuffer.isView(v) ? Array.from(/** @type {any} */ (v)) : v;
	}
	return out;
}

export { stripArrays };

/** The named-sample helper, re-exported so a caller building its own message need not reach past. */
export { nameSample };
