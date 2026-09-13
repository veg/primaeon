/**
 * headline.js — which of the ancestor dates in a dating record may be quoted as THE answer, and
 * what has to be said beside it when it is quoted anyway.
 *
 * WHY THIS FILE EXISTS. `hyphaeon dating`'s record presents FOUR ancestor dates and says nothing
 * about the relationship between them — measured on the flagship example, `ols.t_mrca` 1893.91 with
 * a Fieller interval, `spline.t_mrca` 1938.77 with an interval of zero width, `ensemble.t_mrca`
 * 1893.91 with a THIRD interval, and a top-level `t_mrca` of 1938.77 because `active_model` is the
 * spline. The `/time` page worked out a rule for that and encoded it in `web/src/lib/time/dating.ts`
 * (`headlineOf`); the MCP and the server did not have it, so phase 6 shipped three surfaces that
 * headlined different numbers from the same run. The rule is RESULT SEMANTICS — it decides which
 * number a reader is told is the answer — so under this repository's split it belongs in `runtime/`
 * where all three read it, and the browser's copy becomes a call to this one.
 *
 * WHY THE BROWSER'S RULE IS THE RIGHT ONE, argued rather than asserted, because the MCP and the
 * server were quoting `record.t_mrca` and that is what the command line prints:
 *
 *   The spline's bootstrap never runs upstream. `dating.py:1912` hands numpy's `rcond=` to
 *   `scipy.linalg.lstsq`, whose keyword is `cond=`, so every replicate raises inside a bare
 *   `except` and ALL FOUR of the spline's intervals collapse to their own point estimates. A
 *   record that says `ci_mrca: [1938.77, 1938.77]` is not reporting a 95 % interval of zero width;
 *   it is reporting that no interval was computed. Quoting an estimate that cannot be argued with,
 *   as the headline, over one that can, is the part no surface should do — and it is a REPORTING
 *   choice, not an arithmetic one, so it does not diverge from the reference's numbers at all:
 *   `datingHeadline` changes nothing in the record and every fit stays visible beside it.
 *
 *   The rule is deliberately NOT "always quote OLS". With the model on TN93 divergences the
 *   reference selects PGLS, its Fieller interval is finite and has width, and this rule then quotes
 *   the generalised fit — agreeing with the command line's own top-level `t_mrca`, which is the
 *   outcome a reader diffing the two expects. The only model it ever refuses is the spline, and
 *   only for the dead bootstrap.
 *
 * AND THE SECOND THING A HEADLINE HAS TO CARRY, which the browser's rule did not: WHETHER THE CLOCK
 * HAS ANY SIGNAL AT ALL. A dating fit on sequences with no temporal structure still produces a
 * date, an interval and a verdict sentence stating it. REPRODUCED here on 40 pseudorandom coding
 * sequences (300 codons, dated headers spread over 1980-2019, an explicit root taxon so the
 * time-decay consensus cannot manufacture a correlation of its own): `ols.t_mrca` 1934.12,
 * `ci_mrca` [-Infinity, 1972.26], `r2` 0.070, `p_value` 0.104, `fieller_g` 1.474 — and the section
 * still read "these 39 sequences share a common ancestor in 1934.1".
 *
 *   THE DECISION, AND IT IS A DECISION: state the date, with its own refutation attached, and do
 *   NOT refuse. The reference prints a date here, so refusing would be a divergence in the one
 *   direction this repository is least willing to take — deciding on a reader's behalf that their
 *   data say nothing — and `DATING_NON_POSITIVE_RATE` and `DATING_MRCA_AFTER_EARLIEST_SAMPLE`
 *   already cover the two cases where the arithmetic is impossible rather than merely weak. What
 *   was missing was a name for "weak": `quotable: false` plus `refutation`, which every surface
 *   must render in the same breath as the date. The warning that carries the same fact into the
 *   diagnostics strip is `DATING_NO_CLOCK_SIGNAL` (`codes.js`).
 *
 *   THE TEST IS THE ONE THE INTERVAL ALREADY USES. Fieller's `g >= 1` (dating.py:879-887) and a
 *   slope F-test `p_value >= 0.05` are the same statement: `g = t² se_mu² / mu²`, so `g >= 1` iff
 *   `|mu| / se_mu <= t`, which is the t-test the F on 1 and n-2 d.f. squares. Confirmed on the two
 *   runs above — `p 0.0109, g 0.572` and `p 0.104, g 1.474`. This file tests `p_value`, not `g`,
 *   for one reason: `g` exists only under `--ci-method fieller`, and a run under the delta or
 *   linear interval has no `g` and would otherwise get no warning at all. Where both exist they
 *   agree by construction.
 *
 * WHAT THIS FILE IS NOT. It computes nothing. Every number it reads was produced by
 * `@veg/hyphaeon-js`'s estimators through `runDating`; this is which of them to say out loud.
 */

/** The three estimator keys, in the order a table shows them. */
export const DATING_MODEL_KEYS = Object.freeze(['ols', 'pgls', 'spline']);

/** The α the slope test and the Fieller interval are both computed at (dating.py:879-887). */
export const DATING_SIGNAL_ALPHA = 0.05;

/** `[x, x]`: a point estimate wearing an interval's shape, which is never an interval. */
export function isDegenerateInterval(ci) {
	return Boolean(Array.isArray(ci) && ci.length === 2 && Number.isFinite(ci[0]) && ci[0] === ci[1]);
}

/** `[-Infinity, hi]`: the rate is not distinguishable from zero at the level asked for. */
export function isUnboundedInterval(ci) {
	return Boolean(Array.isArray(ci) && ci.length === 2 && !Number.isFinite(ci[0]) && Number.isFinite(ci[1]));
}

/** One model block off the record, or null; never a number, never a string. */
function modelOf(record, key) {
	const v = record?.[key];
	return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function num(model, key) {
	const v = model?.[key];
	return typeof v === 'number' ? v : NaN;
}

/**
 * Does the ordinary fit's slope carry any signal? `null` when the question cannot be asked — no OLS
 * record, or no `p_value`, which is every fit the reference does not produce an F for.
 *
 * @param {object} record a dating record
 * @returns {{hasSignal: boolean, p: number, r2: number, g: number|null, alpha: number}|null}
 */
export function datingClockSignal(record) {
	const ols = modelOf(record, 'ols');
	const p = num(ols, 'p_value');
	if (!Number.isFinite(p)) return null;
	const g = num(ols, 'fieller_g');
	return {
		hasSignal: p < DATING_SIGNAL_ALPHA,
		p,
		r2: num(ols, 'r2'),
		g: Number.isFinite(g) ? g : null,
		alpha: DATING_SIGNAL_ALPHA
	};
}

/**
 * WHICH FIT A SURFACE QUOTES, and whether it may quote it flatly.
 *
 * @param {object} record a dating record (`run.record`)
 * @returns {{key: string, model: object, activeKey: string, departed: boolean,
 *   quotable: boolean, refutation: string|null, signal: object|null}|null}
 *   `null` only when the record carries no usable fit at all.
 *
 *   `key`        the estimator to quote.
 *   `activeKey`  the estimator the REFERENCE selected — named always, even when it is the one quoted.
 *   `departed`   true when `key !== activeKey`, i.e. when this surface and the command line's
 *                top-level `t_mrca` will print different numbers and the surface must say why.
 *   `quotable`   false when the date must not be stated as a finding. The date is still returned;
 *                what changes is that `refutation` is not optional.
 *   `refutation` the sentence to render in the same breath as the date, or null.
 */
export function datingHeadline(record) {
	if (!record) return null;
	const activeKey = String(record.active_model ?? 'ols') || 'ols';
	const ols = modelOf(record, 'ols');
	const active = modelOf(record, activeKey) ?? ols;
	const usable = (m) => Boolean(m && Number.isFinite(num(m, 't_mrca')) && !isDegenerateInterval(m.ci_mrca));

	let key = activeKey;
	let model = active;
	let departed = false;
	if (!usable(active)) {
		if (ols && Number.isFinite(num(ols, 't_mrca'))) {
			key = 'ols';
			model = ols;
			departed = activeKey !== 'ols';
		}
	}
	if (!model) return null;

	const signal = datingClockSignal(record);
	const quotable = !signal || signal.hasSignal;
	const refutation = quotable
		? null
		: 'This date is not a finding. The clock rate is not distinguishable from zero at ' +
			`${Math.round((1 - DATING_SIGNAL_ALPHA) * 100)} % — the slope of divergence against sampling date has ` +
			`p = ${signal.p.toPrecision(3)} and accounts for ${(signal.r2 * 100).toFixed(1)} % of the spread ` +
			`(R² ${signal.r2.toFixed(3)})${signal.g != null ? `, which is the same fact the interval reports as Fieller g = ${signal.g.toFixed(3)} ≥ 1` : ''}. ` +
			'A date divides an intercept by that slope, so with no slope the date is whatever the intercept ' +
			'happens to be and the interval it comes with has no lower bound: these data are consistent with an ' +
			'arbitrarily old ancestor. `hyphaeon dating` prints the number too; it is reported here for the same ' +
			'reason, and refuted here because it cannot be read as an estimate.';

	return { key, model, activeKey, departed, quotable, refutation, signal };
}
