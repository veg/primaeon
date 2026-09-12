/**
 * clockRegression.js — centred ordinary least squares of divergence on sampling time, the /time
 * page's clock PREVIEW, plus the per-taxon residual table the reader acts on.
 *
 * WHY THIS FILE EXISTS. `rootToTip.js` produces a divergence per taxon; the date layer
 * (`runtime/src/dates/`) produces a time per taxon. This is the arithmetic that turns the pair into
 * a rate, an ancestor time and a list of sequences whose dates do not fit — the diagnostic that
 * tells a reader whether the dates they have just reviewed carry a clock signal at all.
 *
 * IT MIRRORS `run_ols_dating` (hyphaeon/dating.py:1170-1291) AND THE PER-TAXON RECORD BUILDER
 * (dating.py:3040-3062) FORMULA BY FORMULA, but it is APP-SIDE and it is not a port: PLAN-TEMPORAL
 * phase 3 ports `run_ols_dating` into `@veg/hyphaeon-js` with its confidence-interval machinery, and
 * when it does, THIS FILE IS THE INDEPENDENT CHECK THE PORT IS COMPARED AGAINST. Do not later
 * "reconcile" the two into one; that deletes the check. What is deliberately absent here, and must
 * stay absent, is the interval: the pillar's default is Fieller (`--ci-method fieller`), which needs
 * an inverse Student-t the library does not yet carry and which is materially WIDER than the delta
 * interval. A preview that quoted a narrow interval which then widened under the real run would be
 * worse than one that quotes none. Standard errors only, labelled as such.
 *
 * WHY THE FIT IS CENTRED ON `t_ref = mean(t)` (dating.py:1191, and its docstring at :1183-1188).
 * With `X = [t - t_ref, 1]`, `XᵀX = diag(Σx², n)` — off-diagonal exactly zero. Three things follow.
 *   1. The standard errors are closed forms with no matrix inverse: `se_mu = sqrt(sigma2 / Σx²)`,
 *      `se_d0 = sqrt(sigma2 / n)`. Uncentred, `XᵀX` is `[[Σt², Σt], [Σt, n]]`, whose condition
 *      number on a calendar axis is catastrophic — for dates near 2021 over a two-year span,
 *      `Σt²/n ≈ 4.1e6` against a variance near 0.33, a ratio near 1e7.
 *   2. `d0` becomes a quantity with meaning: divergence at the MEAN sampling date, inside the data
 *      and independent of `mu`, rather than divergence at year 0 with a slope correlation near −1.
 *      That independence is what makes the delta-method gradient a two-term sum.
 *   3. It is the only way this preview and phase 3's port can be compared field by field.
 * Centring changes neither `mu`, nor `t_mrca`, nor `r2`, nor the residuals. It is a
 * reparameterisation. `t_ref` is reported beside `d0` so the pair is interpretable.
 *
 * TWO NON-ROBUST CHOICES ARE THE REFERENCE'S AND ARE REPLICATED ON PURPOSE. `z_score` is the
 * DIVERGENCE residual over a PLAIN population standard deviation (numpy `ddof = 0`, floored at
 * 1e-12, falling back to 1.0), so a handful of gross outliers inflates the denominator and hides
 * itself; and the flag threshold is 2.5. Substituting a MAD scale here would be "improving during a
 * port" — if a robust scale is ever wanted it goes in a second, separately named column.
 *
 * `temporal_residual` — "this sequence looks 4.2 years older than its label" — is the column a
 * reader acts on, so the rows are returned sorted by it and `z_score` is kept as the flag.
 */

/** `dating.py:1218-1229`'s three outcomes, verbatim. */
export const CLOCK_STATUS = Object.freeze({
	OK: 'OK',
	NON_POSITIVE_RATE: 'NON_POSITIVE_RATE',
	MRCA_AFTER_EARLIEST_SAMPLE: 'MRCA_AFTER_EARLIEST_SAMPLE'
});

/** Why no fit at all. Returned, never thrown. */
export const CLOCK_REFUSALS = Object.freeze({
	TOO_FEW_DATED: 'TOO_FEW_DATED',
	NO_TIME_SPAN: 'NO_TIME_SPAN'
});

/** `dating.py:1179`: fewer than three dated points is not a fit. */
export const MIN_DATED = 3;

/** `dating.py:3061`. Non-robust by construction; see the header. */
export const OUTLIER_Z = 2.5;

/** `dating.py:2622`'s own "negligible signal" cutoffs, so the preview and the run never disagree. */
export const NEGLIGIBLE_RATE = 1e-6;
export const NEGLIGIBLE_R2 = 0.02;

/** `dating.py:1218` / `:3049`'s guards. */
const RATE_ZERO = 1e-12;
const PREDICT_RATE_FLOOR = 1e-6;
const STD_FLOOR = 1e-12;

function mean(values) {
	let s = 0;
	for (const v of values) s += v;
	return values.length === 0 ? Number.NaN : s / values.length;
}

/** Pearson r over raw (t, d), guarded at sd > 1e-8 as `dating.py:1263` guards it. */
export function pearson(x, y) {
	const n = x.length;
	if (n < 2) return Number.NaN;
	const mx = mean(x);
	const my = mean(y);
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		const dx = x[i] - mx;
		const dy = y[i] - my;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	if (Math.sqrt(sxx / n) <= 1e-8 || Math.sqrt(syy / n) <= 1e-8) return Number.NaN;
	return sxy / Math.sqrt(sxx * syy);
}

/**
 * The fit, the statuses and the per-taxon rows.
 *
 * @param {{taxa: string[], divergence: ArrayLike<number>, times: ArrayLike<number>,
 *   undated?: number, units?: string}} input
 *   `taxa`, `divergence` and `times` are parallel and the caller has ALREADY excluded undated taxa
 *   (nothing here imputes a date); `undated` is their count, carried so the page can report it.
 * @returns {object}
 */
export function clockRegression(input) {
	const units = input.units ?? 'years';
	const undated = input.undated ?? 0;
	const taxa = [];
	const d = [];
	const t = [];
	for (let i = 0; i < input.taxa.length; i++) {
		const di = Number(input.divergence[i]);
		const ti = Number(input.times[i]);
		if (!Number.isFinite(di) || !Number.isFinite(ti)) continue;
		taxa.push(input.taxa[i]);
		d.push(di);
		t.push(ti);
	}
	const n = taxa.length;
	const base = { ok: false, n, nUndated: undated, nDropped: input.taxa.length - n, units };

	if (n < MIN_DATED) return { ...base, refusal: CLOCK_REFUSALS.TOO_FEW_DATED, rows: [] };

	const tRef = mean(t);
	let sxx = 0;
	let sxd = 0;
	for (let i = 0; i < n; i++) {
		const x = t[i] - tRef;
		sxx += x * x;
		sxd += x * d[i];
	}
	if (!(sxx > 0)) {
		return { ...base, refusal: CLOCK_REFUSALS.NO_TIME_SPAN, rows: [], tied: t[0] };
	}

	const mu = sxd / sxx; // dating.py:1196-1198
	const d0 = mean(d); // dating.py:1199
	const residuals = new Float64Array(n);
	let rss = 0;
	for (let i = 0; i < n; i++) {
		const fitted = d0 + mu * (t[i] - tRef);
		residuals[i] = d[i] - fitted;
		rss += residuals[i] * residuals[i];
	}
	const sigma2 = rss / Math.max(1, n - 2); // dating.py:1206
	const seMu = Math.sqrt(sigma2 / sxx); // dating.py:1209
	const seD0 = Math.sqrt(sigma2 / n); // dating.py:1210
	const rmse = Math.sqrt(rss / n); // dating.py:1287
	const r = pearson(t, d); // dating.py:1263
	const r2 = Number.isFinite(r) ? r * r : Number.NaN;

	let status = CLOCK_STATUS.OK;
	let tMrca = tRef - d0 / mu; // dating.py:1226
	let seMrca = Math.sqrt((d0 / (mu * mu)) ** 2 * seMu * seMu + (1 / mu) ** 2 * seD0 * seD0); // :1234-1237
	const earliest = Math.min(...t);
	if (mu <= RATE_ZERO) {
		status = CLOCK_STATUS.NON_POSITIVE_RATE;
		tMrca = Number.NaN;
		seMrca = Number.NaN;
	} else if (tMrca >= earliest) {
		status = CLOCK_STATUS.MRCA_AFTER_EARLIEST_SAMPLE;
		tMrca = Number.NaN;
		seMrca = Number.NaN;
	}

	// dating.py:3057 — a PLAIN population standard deviation of the divergence residuals.
	let residualSd = 0;
	{
		const m = mean(Array.from(residuals));
		let ss = 0;
		for (const v of residuals) ss += (v - m) * (v - m);
		residualSd = Math.sqrt(ss / n);
		if (!(residualSd > STD_FLOOR)) residualSd = 1.0;
	}

	const rows = [];
	for (let i = 0; i < n; i++) {
		const fitted = d0 + mu * (t[i] - tRef);
		const residual = d[i] - fitted;
		const predicted = Math.abs(mu) > PREDICT_RATE_FLOOR ? tRef + (d[i] - d0) / mu : Number.NaN;
		const z = residual / residualSd;
		rows.push({
			taxon: taxa[i],
			samplingDate: t[i],
			rootDivergence: d[i],
			fittedDivergence: fitted,
			divergenceResidual: residual,
			predictedDate: predicted,
			temporalResidual: Number.isFinite(predicted) ? predicted - t[i] : Number.NaN,
			zScore: z,
			isOutlier: Math.abs(z) >= OUTLIER_Z
		});
	}
	rows.sort((a, b) => {
		const av = Number.isFinite(a.temporalResidual) ? a.temporalResidual : 0;
		const bv = Number.isFinite(b.temporalResidual) ? b.temporalResidual : 0;
		return av - bv || a.taxon.localeCompare(b.taxon);
	});

	return {
		...base,
		ok: true,
		refusal: null,
		status,
		mu,
		d0,
		tRef,
		sigma2,
		seMu,
		seD0,
		tMrca,
		seMrca,
		r,
		r2,
		rmse,
		residualSd,
		earliest,
		latest: Math.max(...t),
		outliers: rows.filter((row) => row.isOutlier).length,
		negligible: !(mu > NEGLIGIBLE_RATE) || !(r2 >= NEGLIGIBLE_R2),
		rows
	};
}

/**
 * The cheap robustness check the preview can afford, because the regression is O(n) over a fixed
 * divergence vector: the SPREAD of the ancestor estimate across several rootings. When it exceeds a
 * quarter of the sampling span, "where you put the root moves this estimate by N years" is the
 * honest headline and the page prints it instead of a single number.
 *
 * @param {Array<{label: string, fit: object}>} fits
 * @returns {{values: Array<{label: string, tMrca: number}>, spread: number, wide: boolean}|null}
 */
export function rootSensitivity(fits, samplingSpan) {
	const values = fits
		.filter((f) => f.fit && f.fit.ok && Number.isFinite(f.fit.tMrca))
		.map((f) => ({ label: f.label, tMrca: f.fit.tMrca }));
	if (values.length < 2) return null;
	const nums = values.map((v) => v.tMrca);
	const spread = Math.max(...nums) - Math.min(...nums);
	return { values, spread, wide: Number.isFinite(samplingSpan) && samplingSpan > 0 && spread > samplingSpan / 4 };
}
