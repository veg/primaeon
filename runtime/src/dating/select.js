/**
 * select.js — which clock model answers, what that choice is called, and which models are allowed
 * into the model-averaged row.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT IN THE LIBRARY. Two things live here and both are
 * result semantics by CLAUDE.md's own test. First, ADJUDICATION: `dating.py:2943-2996` arbitrates
 * between five estimators, of which this build runs four — OLS, the neural PGLS fit, the restricted
 * spline and (as a source of divergences rather than of a date) the latent convex-hull root. Only
 * the power-law clock is absent, dropped by D33. Which BRANCHES are reachable therefore depends on
 * whether the model ran: a model-free run collapses the tree to the two arms a `--method ols` run
 * can reach, and a run with the dating graph opens the four PGLS arms below. Second, the SENTENCE:
 * `selected_clock` is an English paragraph with numbers formatted into it, and the reference builds
 * it inside the engine. The library returns the fields; this file builds the sentence, byte for
 * byte with the reference's own format specifiers, so a browser run and a command-line run produce
 * the same string.
 *
 * THE CLADE-ATTENUATION TEST IS THE ONE BRANCH WITH NO ANALOGUE IN THE MODEL-FREE TREE
 * (dating.py:2884-2891). `attr = mu_pgls / mu_ols`, and a fit is "clade attenuated" when OLS's
 * Fieller g is bounded AND the rate deflated by more than half AND the generalised R² fell below
 * 65 % of the ordinary one. It does two things: it takes the answer away from PGLS, and it
 * disqualifies PGLS from the model-averaged row. Both matter on real data, where a phylogenetically
 * structured sample can make the GLS slope collapse toward zero.
 *
 * WHY BOTH `pgls_bounded` AND `ols_bounded` APPEAR IN ONE CONDITION. Arm 2
 * (dating.py:2969-2971) prefers OLS when PGLS's g >= 1 — an unbounded Fieller interval, i.e. a
 * slope that is not significantly positive — but ONLY when OLS's own g is below 1. On korber under
 * `--distance-mode latent` that is exactly what happens (PGLS g = 1.72 against OLS g = 0.173), so
 * the headline date comes from the ordinary fit while the record still carries the PGLS one. A page
 * that prints both must say which was selected and why, which is what the sentence is for.
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

/** `dating.py:2874` — the same two clauses on the GLS fit; the field names are identical. */
function pglsValid(pgls) {
	return pgls != null && Number.isFinite(pgls.t_mrca) && pgls.mu > 0;
}

/**
 * `dating.py:2884-2891`. `1e-12` floors both the ratio's denominator and `mu_ols` itself, as the
 * reference does, so a zero rate cannot make this NaN and silently fall through.
 *
 * @returns {{attenuated: boolean, attr: number, muOls: number, muPgls: number}}
 */
function cladeAttenuation(ols, pgls) {
	const vOls = olsValid(ols);
	const vPgls = pglsValid(pgls);
	const muOls = ols ? (ols.mu ?? 1e-12) : 1e-12;
	const muPgls = pgls ? (pgls.mu ?? 1e-12) : 1e-12;
	const attr = vOls && vPgls ? muPgls / Math.max(1e-12, muOls) : 1.0;
	const r2Ols = ols?.r2 ?? 0.0;
	const r2Pgls = pgls?.r2 ?? 0.0;
	const attenuated = fiellerBounded(ols) && attr < 0.5 && r2Pgls < 0.65 * r2Ols;
	return { attenuated, attr, muOls, muPgls };
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
 * `dating.py:2943-2996`. With `pgls` null the PGLS arms are unreachable and the tree collapses to
 * exactly what a model-free run reached before phase 4; with `pgls` supplied every arm is live.
 *
 * @param {{ols: object|null, pgls?: object|null, spline: object|null,
 *   clockModel?: 'auto'|'linear'|'spline'}} args
 * @returns {{name: 'ols'|'pgls'|'spline', model: object, selectedClock: string, olsValid: boolean,
 *   pglsValid: boolean, splineValid: boolean, olsBounded: boolean, pglsBounded: boolean,
 *   cladeAttenuated: boolean, attenuation: number, warnings: Array<object>}}
 */
export function selectClockModel({ ols, pgls = null, spline, clockModel = 'auto' }) {
	const vOls = olsValid(ols);
	const vPgls = pglsValid(pgls);
	const vSpline = splineValid(spline);
	const bounded = fiellerBounded(ols);
	const pglsBounded = fiellerBounded(pgls);
	const { attenuated, attr, muOls, muPgls } = cladeAttenuation(ols, pgls);
	const warnings = [];
	const common = {
		olsValid: vOls,
		pglsValid: vPgls,
		splineValid: vSpline,
		olsBounded: bounded,
		pglsBounded,
		cladeAttenuated: attenuated,
		attenuation: attr,
		warnings
	};
	if (vPgls && attenuated) {
		warnings.push(
			datingWarning(
				'DATING_CLADE_ATTENUATED',
				'warn',
				fillMessage(DATING_MESSAGES.CLADE_ATTENUATED, {
					factor: fixed(1 / attr, 1),
					ols: muOls.toExponential(2),
					pgls: muPgls.toExponential(2)
				}),
				{ attenuation: attr, mu_ols: muOls, mu_pgls: muPgls, r2_ols: ols?.r2 ?? null, r2_pgls: pgls?.r2 ?? null }
			)
		);
	}

	/** `dating.py:2946-2948`: `--clock-model spline` takes the spline whatever the test says. */
	if (clockModel === 'spline' && spline != null) {
		return { name: 'spline', model: spline, selectedClock: 'Restricted Spline (forced)', ...common };
	}
	/** `dating.py:2952-2961`: the linear arm prefers PGLS unless it is attenuated or unidentified. */
	if (clockModel === 'linear') {
		if (vPgls && !attenuated && (pglsBounded || !bounded)) {
			return { name: 'pgls', model: pgls, selectedClock: 'Linear (HyphAeon PGLS)', ...common };
		}
		if (vOls) {
			return { name: 'ols', model: ols, selectedClock: 'Linear (Standard OLS)', ...common };
		}
		return { name: pgls != null ? 'pgls' : 'ols', model: pgls ?? ols, selectedClock: 'Linear (forced)', ...common };
	}

	// auto. dating.py:2964-2967 — the curvature test first, whatever else ran.
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
		return { name: 'spline', model: spline, selectedClock, ...common };
	}

	// dating.py:2969-2971 — PGLS ran, its slope is not significantly positive (Fieller g >= 1) and
	// OLS's is: the ordinary fit answers and the sentence says why. This is korber's own branch under
	// --distance-mode latent.
	if (vPgls && !pglsBounded && bounded) {
		return {
			name: 'ols',
			model: ols,
			selectedClock: `Linear (OLS preferred: PGLS temporal slope non-significant, g=${fixed(pgls.fieller_g, 2)} vs OLS g=${fixed(ols.fieller_g, 3)})`,
			...common
		};
	}

	// dating.py:2974-2976 — the clade-attenuation escape. `1/attr` is the deflation factor the
	// sentence quotes, and `%.2e` is Python's own exponent form for the two rates.
	if (vPgls && attenuated) {
		return {
			name: 'ols',
			model: ols,
			selectedClock:
				`Linear (OLS preferred: PGLS clade attenuation detected, rate deflated ${fixed(1 / attr, 1)}x ` +
				`from OLS ${muOls.toExponential(2)} to ${muPgls.toExponential(2)})`,
			...common
		};
	}

	// dating.py:2979-2984 — the ordinary preference for the GLS fit when it is identified. `sp_p`
	// reads the SPLINE's p even though the spline was not selected, and prints "p=n/a" when no
	// spline was fitted at all; both are the reference's.
	if (vPgls && pglsBounded) {
		const spP = spline ? `p=${fixed(spline.p_f_test, 4)}` : 'p=n/a';
		const lam = pgls.pagel_lambda;
		const lamStr = typeof lam === 'number' && Number.isFinite(lam) ? `, λ*=${fixed(lam, 4)}` : '';
		return {
			name: 'pgls',
			model: pgls,
			selectedClock: `Linear PGLS (parsimonious linear clock preferred${lamStr}; ${spP})`,
			...common
		};
	}

	// dating.py:2985-2987
	if (vOls && bounded) {
		return { name: 'ols', model: ols, selectedClock: 'Linear (Standard OLS)', ...common };
	}

	// dating.py:2988-2992 — PGLS is valid but nobody's interval is bounded. Python formats a NaN g
	// as the literal "inf" here, which is its own inaccuracy and is reproduced.
	if (vPgls) {
		const gp = Number.isNaN(pgls.fieller_g) ? 'inf' : fixed(pgls.fieller_g, 2);
		const go = ols == null || Number.isNaN(ols.fieller_g) ? 'inf' : fixed(ols.fieller_g, 2);
		return {
			name: 'pgls',
			model: pgls,
			selectedClock: `Linear PGLS (unbounded temporal signal: PGLS g=${gp}, OLS g=${go}; slope p >= 0.05)`,
			...common
		};
	}

	// dating.py:2993-2997
	if (vOls) {
		return { name: 'ols', model: ols, selectedClock: 'Linear (OLS fallback: PGLS non-positive rate)', ...common };
	}
	return {
		name: pgls != null ? 'pgls' : 'ols',
		model: pgls ?? ols,
		selectedClock: 'Linear (parsimonious linear clock; non-positive rate)',
		...common
	};
}

/**
 * `dating.py:2894-2941`: who is allowed into the average, then the library's arithmetic, then the
 * reference's own `elif ols_valid` fallback when nobody is.
 *
 * PGLS IS ADMITTED UNDER AN EXTRA CLAUSE THE OTHER TWO DO NOT HAVE (dating.py:2905): valid, Fieller
 * bounded, finite interval — and NOT clade attenuated. So the same test that can take the headline
 * away from PGLS also removes it from the average, and a record can carry a PGLS fit that appears
 * in neither. That is the reference's, and it is why `admitted` travels back to the caller.
 *
 * @param {{ols: object|null, pgls?: object|null, spline: object|null, minSampleTime: number,
 *   selected?: string, cladeAttenuated?: boolean}} args
 * @returns {{ensemble: {t_mrca: number|null, ci_mrca: number[]|null, weights: Record<string,number>},
 *   admitted: string[], warnings: Array<object>}}
 */
export function admitEnsembleCandidates({ ols, pgls = null, spline, minSampleTime, selected = null, cladeAttenuated = false }) {
	const warnings = [];
	/** `dating.py:2897`: finite on both ends and strictly wider than zero. */
	const admissible = (model) => {
		const ci = model?.ci_mrca;
		if (!Array.isArray(ci) || ci.length !== 2) return false;
		if (ci[0] === -Infinity || ci[1] === Infinity) return false;
		const w = ci[1] - ci[0];
		return Number.isFinite(w) && w > 0;
	};

	/** Insertion order is the reference's `precisions` dict order: ols, then pgls, then spline. */
	const candidates = [];
	if (olsValid(ols) && fiellerBounded(ols) && admissible(ols)) candidates.push({ name: 'ols', t_mrca: ols.t_mrca, ci_mrca: ols.ci_mrca });
	if (pglsValid(pgls) && fiellerBounded(pgls) && !cladeAttenuated && admissible(pgls))
		candidates.push({ name: 'pgls', t_mrca: pgls.t_mrca, ci_mrca: pgls.ci_mrca });
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
