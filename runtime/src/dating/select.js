/**
 * select.js — which clock model answers, what that choice is called, and which models are allowed
 * into the model-averaged row.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT IN THE LIBRARY. Two things live here and both are
 * result semantics by CLAUDE.md's own test. First, ADJUDICATION: `dating.py:2943-2996` arbitrates
 * between five estimators, three of which this build does not run (PGLS and the latent root need a
 * taxon-by-taxon attention matrix the current ONNX export does not emit — D29, phase 4 — and the
 * power-law clock is dropped by D33), so the decision tree collapses to the branches a
 * `--method ols --clock-model auto` run can actually reach, and WHICH branches those are depends on
 * which estimators this surface ran. Second, the SENTENCE: `selected_clock` is an English
 * paragraph with numbers formatted into it, and the reference builds it inside the engine. The
 * library returns the fields; this file builds the sentence, byte for byte with the reference's own
 * format specifiers, so a browser run and a command-line run produce the same string.
 *
 * THE FOUR-CONJUNCT RULE THE SELECTION TURNS ON is the library's `is_nonlinear_preferred`
 * (dating.py:1894-1898): `p_f_test < 0.05` AND `delta_aic >= 2.0` AND `mu_ancestral > 0` AND
 * `|rate_ratio - 1| >= 0.15`. The third conjunct is the one that is easy to miss and it is what
 * stops a clock running backwards from being "preferred".
 *
 * THE ENSEMBLE'S ADMISSION IS POLICY; ITS ARITHMETIC IS THE LIBRARY'S. `dating.py:2895-2912` admits
 * a model only when its interval is finite AND HAS POSITIVE WIDTH, which is why the flagship example
 * reports `selected_clock: Restricted Spline` and `ensemble.weights: {ols: 1.0}` in the same record:
 * the spline IS selected and its interval is degenerate (upstream's dead bootstrap), so the
 * ensembler silently ignores the model the selector chose. Two numbers 45 years apart in one JSON,
 * with nothing connecting them. `admitEnsembleCandidates` reproduces the admission exactly and names
 * the disagreement so a page cannot print both without saying which is which.
 */

import { precisionWeightedEnsemble } from '@veg/hyphaeon-js';

import { DATING_MESSAGES, datingWarning, fillMessage } from './codes.js';

/** Python's `f"{x:.Nf}"` for the values these sentences carry (finite, ordinary magnitudes). */
function fixed(x, digits) {
	return Number(x).toFixed(digits);
}

/** Python's `f"{x:+.1f}"`. */
function signedFixed(x, digits) {
	const s = Number(x).toFixed(digits);
	return Number(x) >= 0 && !s.startsWith('-') ? `+${s}` : s;
}

/** `dating.py:2873` — a model answers only with a real date and a positive rate. */
function olsValid(ols) {
	return ols != null && Number.isFinite(ols.t_mrca) && ols.mu > 0;
}

/** `dating.py:2875` — the spline's positivity test is on its ANCESTRAL rate, not on `mu`. */
function splineValid(spline) {
	return spline != null && Number.isFinite(spline.t_mrca) && spline.rate_ancestral > 0;
}

/** `dating.py:2880` — Fieller's `g < 1` is what "the rate is bounded away from zero" means here. */
function fiellerBounded(model) {
	const g = model?.fieller_g;
	return typeof g === 'number' && !Number.isNaN(g) && g < 1.0;
}

/**
 * `dating.py:2943-2996`, restricted to the branches a model-free run reaches.
 *
 * @param {{ols: object|null, spline: object|null, clockModel?: 'auto'|'linear'|'spline'}} args
 * @returns {{name: 'ols'|'spline', model: object, selectedClock: string, olsValid: boolean,
 *   splineValid: boolean, olsBounded: boolean, warnings: Array<object>}}
 */
export function selectClockModel({ ols, spline, clockModel = 'auto' }) {
	const vOls = olsValid(ols);
	const vSpline = splineValid(spline);
	const bounded = fiellerBounded(ols);
	const warnings = [];

	/** `dating.py:2946-2948`: `--clock-model spline` takes the spline whatever the test says. */
	if (clockModel === 'spline' && spline != null) {
		return { name: 'spline', model: spline, selectedClock: 'Restricted Spline (forced)', olsValid: vOls, splineValid: vSpline, olsBounded: bounded, warnings };
	}
	/** `dating.py:2952-2961`, with PGLS absent: the linear arm is always OLS here. */
	if (clockModel === 'linear') {
		return {
			name: 'ols',
			model: ols,
			selectedClock: vOls ? 'Linear (Standard OLS)' : 'Linear (forced)',
			olsValid: vOls,
			splineValid: vSpline,
			olsBounded: bounded,
			warnings
		};
	}

	// auto. dating.py:2964-2967 — the curvature test first, and it is the only branch that can
	// take the answer away from OLS on this path.
	if (vSpline && spline.is_nonlinear_preferred) {
		const ratioStr =
			spline.rate_ratio > 1.0 ? `acceleration (${fixed(spline.rate_ratio, 2)}x)` : `deceleration (${fixed(spline.rate_ratio, 2)}x)`;
		const selectedClock =
			`Restricted Spline (rate ${ratioStr} detected: F=${fixed(spline.f_stat, 2)}, ` +
			`p=${fixed(spline.p_f_test, 4)}, ΔAIC=${signedFixed(spline.delta_aic, 1)})`;
		warnings.push(
			datingWarning(
				'DATING_SPLINE_PREFERRED',
				'note',
				fillMessage(DATING_MESSAGES.SPLINE_PREFERRED, {
					ancestral: spline.rate_ancestral.toExponential(3),
					recent: spline.rate_recent.toExponential(3),
					ratio: fixed(spline.rate_ratio, 2),
					f: fixed(spline.f_stat, 2),
					df: spline.n - 3,
					p: fixed(spline.p_f_test, 4),
					daic: signedFixed(spline.delta_aic, 1),
					tmrca: fixed(spline.t_mrca, 1)
				}),
				{
					rate_ancestral: spline.rate_ancestral,
					rate_recent: spline.rate_recent,
					rate_ratio: spline.rate_ratio,
					f_stat: spline.f_stat,
					p_f_test: spline.p_f_test,
					delta_aic: spline.delta_aic,
					t_mrca: spline.t_mrca
				}
			)
		);
		// DATING Q1: the spline's four intervals are its point estimates, always, because upstream's
		// bootstrap raises on every replicate. A page must not draw [x, x] as an interval.
		if (Array.isArray(spline.ci_mrca) && spline.ci_mrca[0] === spline.ci_mrca[1]) {
			warnings.push(datingWarning('DATING_SPLINE_NO_INTERVAL', 'warn', DATING_MESSAGES.SPLINE_NO_INTERVAL, { ci: [...spline.ci_mrca] }));
		}
		return { name: 'spline', model: spline, selectedClock, olsValid: vOls, splineValid: vSpline, olsBounded: bounded, warnings };
	}

	// dating.py:2985-2987 and :2993-2995 — the two arms left once PGLS is absent.
	return {
		name: 'ols',
		model: ols,
		selectedClock: vOls && bounded ? 'Linear (Standard OLS)' : 'Linear (parsimonious linear clock; non-positive rate)',
		olsValid: vOls,
		splineValid: vSpline,
		olsBounded: bounded,
		warnings
	};
}

/**
 * `dating.py:2894-2941`: who is allowed into the average, then the library's arithmetic, then the
 * reference's own `elif ols_valid` fallback when nobody is.
 *
 * @param {{ols: object|null, spline: object|null, minSampleTime: number, selected?: string}} args
 * @returns {{ensemble: {t_mrca: number|null, ci_mrca: number[]|null, weights: Record<string,number>},
 *   admitted: string[], warnings: Array<object>}}
 */
export function admitEnsembleCandidates({ ols, spline, minSampleTime, selected = null }) {
	const warnings = [];
	/** `dating.py:2897`: finite on both ends and strictly wider than zero. */
	const admissible = (model) => {
		const ci = model?.ci_mrca;
		if (!Array.isArray(ci) || ci.length !== 2) return false;
		if (ci[0] === -Infinity || ci[1] === Infinity) return false;
		const w = ci[1] - ci[0];
		return Number.isFinite(w) && w > 0;
	};

	/** Insertion order is the reference's `precisions` dict order: ols, then spline. */
	const candidates = [];
	if (olsValid(ols) && fiellerBounded(ols) && admissible(ols)) candidates.push({ name: 'ols', t_mrca: ols.t_mrca, ci_mrca: ols.ci_mrca });
	if (splineValid(spline) && spline.is_nonlinear_preferred && admissible(spline))
		candidates.push({ name: 'spline', t_mrca: spline.t_mrca, ci_mrca: spline.ci_mrca });

	const averaged = candidates.length > 0 ? precisionWeightedEnsemble(candidates, minSampleTime) : null;
	if (averaged) {
		warnings.push(datingWarning('DATING_ENSEMBLE_RESYMMETRISED', 'note', DATING_MESSAGES.ENSEMBLE_RESYMMETRISED, {}));
		if (selected && !candidates.some((c) => c.name === selected)) {
			warnings.push(
				datingWarning(
					'DATING_ENSEMBLE_IGNORES_SELECTED',
					'warn',
					`The model-averaged row does not include ${selected}, the model the curvature test selected: ` +
						`its interval has no width, so the ensembler drops it (dating.py:2910). The averaged date and the ` +
						`headline date therefore come from different models.`,
					{ selected, admitted: candidates.map((c) => c.name) }
				)
			);
		}
		return {
			ensemble: { t_mrca: averaged.t_mrca, ci_mrca: averaged.ci, weights: averaged.weights },
			admitted: candidates.map((c) => c.name),
			warnings
		};
	}

	// dating.py:2929-2932 — nobody was admitted, but OLS still has an answer, so it is the average
	// of one and its interval travels UNCHANGED (this is the one path that is not re-symmetrised).
	if (olsValid(ols)) {
		return { ensemble: { t_mrca: ols.t_mrca, ci_mrca: ols.ci_mrca ?? null, weights: { ols: 1.0 } }, admitted: [], warnings };
	}
	return { ensemble: { t_mrca: null, ci_mrca: null, weights: {} }, admitted: [], warnings };
}
