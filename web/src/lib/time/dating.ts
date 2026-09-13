/**
 * dating.ts — the `/time` page's half of the ancestor-date section: turn a `runDating` result into
 * the sentences, the numbers and the table of estimators a reader is shown, and decide which of the
 * four ancestor dates in that result is the one to quote.
 *
 * WHY THIS FILE EXISTS. The arithmetic is `@veg/hyphaeon-runtime/dating`, which is the port of
 * `hyphaeon/dating.py`'s model-free path and which `mcp/` and `server/` will want verbatim. What
 * belongs to the page, and therefore lives here, is the DECIDING and the SAYING — and on this
 * pillar that is not a formatting job, because the reference's own record presents FOUR ancestor
 * dates and says nothing about the relationship between them. Measured on the flagship example:
 *
 *     ols.t_mrca        1893.91   Fieller [1850.90, 1916.79]
 *     spline.t_mrca     1938.77   ci_mrca [1938.77, 1938.77]   ← zero width, see below
 *     ensemble.t_mrca   1893.91   ci      [1860.96, 1926.86]   ← a THIRD interval off the first fit
 *     record.t_mrca     1938.77                                 ← because active_model is the spline
 *
 * THE PAGE QUOTES THE OLS ESTIMATE, AND THAT IS A DELIBERATE DEPARTURE FROM `active_model`. The
 * curvature test does prefer the spline here, and the section says so in full (`clockNote`), with
 * the spline's date and the test that chose it. But the spline has no interval at all: its
 * bootstrap raises on every replicate upstream (`dating.py:1917` hands numpy's `rcond=` to
 * `scipy.linalg.lstsq`, whose keyword is `cond=`), so all four of its intervals collapse to their
 * point estimates, and a zero-width 95 % interval must never be drawn as an interval. An estimate
 * that cannot be argued with is not the one to headline, so the headline is the straight line —
 * from the model the test rejects — and the section states that in one paragraph rather than
 * leaving a reader to discover that the page and the CLI's top-level `t_mrca` differ by 45 years.
 *
 * THE ENSEMBLE IS NOT A SECOND ANSWER. `dating.py:2916` converts each interval to a standard error
 * by `(hi − lo) / (2 × 1.96)` and re-forms a symmetric one, which applied to a deliberately skewed
 * Fieller interval returns a different interval from the one it was built from; and the admission
 * rule (`:2910`) drops any model whose interval has no width, so the SELECTED model is excluded and
 * `weights` reads `{ols: 1.0}`. It appears as the last row of the estimator table with that stated,
 * because the reference's record carries it, and nowhere else.
 *
 * WHAT THIS SECTION MUST NOT CONTRADICT. `ClockPreview` is on the same page and measures a
 * different thing: root-to-tip divergence on the READER'S TREE in tree units, against TN93
 * divergence to a chosen root in substitutions per site here. They will disagree, and the honest
 * move is to say so in one line rather than to reconcile them — `crossCheckSentence` is that line,
 * and `clockRegression.js` stays the independent check its own header says it is.
 *
 * FORBIDDEN VOCABULARY, kept from the preview's own rule and asserted by `e2e/time.spec.ts`: the
 * words *TMRCA*, *calibrated*, *confidence interval* and *molecular clock estimate* do not appear
 * on this page. "Ancestor date", "95 % interval (Fieller)", "clock rate" and "estimated" say the
 * same things and cost nothing.
 *
 * ROUNDING, ONE RULE so the sentence, the figure and both tables agree: dates and interval bounds
 * to one decimal; per-sequence dates to one; residuals to two; z to two; rates and RMSE to four
 * significant figures in scientific notation with real superscripts; R² to three decimals.
 */

import type { DatingResult, TaxonDatingRow, TimeUnits } from './types';

// ---- formatting ------------------------------------------------------------------------------

const SUPERSCRIPT: Record<string, string> = {
	'0': '⁰',
	'1': '¹',
	'2': '²',
	'3': '³',
	'4': '⁴',
	'5': '⁵',
	'6': '⁶',
	'7': '⁷',
	'8': '⁸',
	'9': '⁹',
	'-': '⁻'
};

export const EM_DASH = '—';

/**
 * Four significant figures in scientific notation, set as `1.169 × 10⁻³` with real superscripts —
 * web/DESIGN.md §3's table rule, applied to the running text as well so one quantity is never
 * spelled two ways on one page.
 */
export function sci(value: number | null | undefined, significant = 4): string {
	if (value == null || !Number.isFinite(value)) return EM_DASH;
	if (value === 0) return '0';
	const [mantissa, exponent] = value.toExponential(Math.max(0, significant - 1)).split('e');
	const exp = Number(exponent);
	if (exp === 0) return mantissa;
	return `${mantissa} × 10${String(exp)
		.split('')
		.map((c) => SUPERSCRIPT[c] ?? c)
		.join('')}`;
}

/** A date or an interval bound: one decimal, or an em dash. */
export function yr(value: number | null | undefined, dp = 1): string {
	return value == null || !Number.isFinite(value) ? EM_DASH : value.toFixed(dp);
}

/** A plain fixed-point number, or an em dash. */
export function num(value: number | null | undefined, dp = 2): string {
	return value == null || !Number.isFinite(value) ? EM_DASH : value.toFixed(dp);
}

/** `+3.27`, Python's `f"{x:+.2f}"`, for ΔAIC. */
export function signed(value: number, dp = 2): string {
	const s = value.toFixed(dp);
	return value >= 0 && !s.startsWith('-') ? `+${s}` : s;
}

/** The noun for this run's time axis. Only `years` renders as a calendar date anywhere. */
export function ancestorWord(units: TimeUnits): string {
	return units === 'years' ? 'ancestor date' : 'ancestor time';
}

/** The singular unit word, for "per year" / "per generation". */
export function unitWord(units: TimeUnits): string {
	return units === 'years' ? 'year' : units === 'generations' ? 'generation' : units === 'days' ? 'day' : 'time unit';
}

/** The x-axis label. */
export function axisWord(units: TimeUnits): string {
	return units === 'years' ? 'sampling date' : `sampling ${units}`;
}

// ---- the view model --------------------------------------------------------------------------

export interface DatingRefusalView {
	/** The code, for the test and for the provenance panel. */
	code: string;
	/** One sentence, the runtime's own words. */
	reason: string;
	/** The next action, which a refusal always offers (web/DESIGN.md §5). */
	next: string;
}

export interface StatEntry {
	label: string;
	value: string;
	qualifier: string;
}

export interface EstimatorRow {
	name: string;
	/** `null` when the estimator is not built; the row then carries `note` alone. */
	date: string | null;
	interval: string | null;
	rate: string | null;
	r2: string | null;
	/** A `--text-faint` qualifier, or the whole cell for an unbuilt estimator. */
	note: string | null;
	built: boolean;
}

export interface DatingView {
	ok: boolean;
	refusal: DatingRefusalView | null;
	/** The lede: the estimate with its numbers inline, or `''` when there is a refusal. */
	verdict: string;
	/** "143 sequences, 142 dated, 141 in the fit." */
	counts: string;
	/** The holdout sentence, which on the flagship example IS the result. */
	holdout: string | null;
	stats: StatEntry[];
	estimators: EstimatorRow[];
	/** Which clock model the curvature test chose, and why the headline is not it. */
	clockNote: string | null;
	/** True when Fieller returned `[-Infinity, hi]`: print the clause, never a symmetric pair. */
	unbounded: boolean;
	units: TimeUnits;
}

/** The one place a `*_REFUSAL` code becomes a next action. */
const NEXT_ACTION: Record<string, string> = {
	DATING_ALIGNMENT_EMPTY: 'Drop an alignment with at least three dated sequences in it.',
	DATING_ALIGNMENT_RAGGED: 'Align the sequences to one length and drop the alignment again.',
	DATING_ALIGNMENT_NOT_CODING: 'Trim the alignment to a whole number of codons, or let this page trim it.',
	DATING_TOO_FEW_DATED: 'Date at least three sequences in section 1 — a metadata table or a custom pattern is the usual fix.',
	DATING_NO_TIME_SPAN: 'Supply sequences collected at more than one time; a clock is a slope against time.',
	DATING_TN93_UNCOMPUTABLE: 'Estimate on a less divergent subset, or remove the saturated sequences.',
	DATING_NON_POSITIVE_RATE: 'Check the dates in section 1 and the root above; a clock running backwards is usually one of the two.',
	DATING_MRCA_AFTER_EARLIEST_SAMPLE: 'Check the date on the earliest sequence, and the root above.'
};

function warningFor(run: DatingResult, code: string): { message: string } | null {
	return run.warnings.find((w) => w.code === code) ?? null;
}

type ModelRecord = Record<string, number | number[] | string | boolean | null>;

function modelOf(run: DatingResult, key: 'ols' | 'spline'): ModelRecord | null {
	const value = (run.record as Record<string, unknown>)[key];
	return value && typeof value === 'object' ? (value as ModelRecord) : null;
}

function n(model: ModelRecord | null, key: string): number {
	const v = model?.[key];
	return typeof v === 'number' ? v : NaN;
}

/** `'fieller' | 'delta'`, read off the record rather than assumed. */
function ciMethodOf(run: DatingResult): 'fieller' | 'delta' {
	return String(run.record.ci_method ?? 'fieller') === 'delta' ? 'delta' : 'fieller';
}

/** Which of the OLS record's two intervals the run computed. */
function ciKey(run: DatingResult): 'ci_fieller' | 'ci_delta' {
	return ciMethodOf(run) === 'delta' ? 'ci_delta' : 'ci_fieller';
}

function pair(model: ModelRecord | null, key: string): [number, number] | null {
	const v = model?.[key];
	return Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : null;
}

/**
 * The interval, written so `-Infinity` is never rendered and a half-infinite interval never looks
 * like a symmetric one. `dating.py:879-887` returns `[-Infinity, hi]` whenever Fieller's `g >= 1`,
 * i.e. whenever the rate is not distinguishable from zero at the level asked for.
 */
export function intervalText(ci: readonly number[] | null, units: TimeUnits): string {
	if (!ci || ci.length !== 2 || !Number.isFinite(ci[1])) return 'no interval';
	if (!Number.isFinite(ci[0])) {
		return `no lower bound (the clock rate is not distinguishable from zero at 95 %); upper bound ${yr(ci[1])}`;
	}
	if (ci[0] === ci[1]) return 'not computed';
	return `${yr(ci[0])} to ${yr(ci[1])}`;
}

/** True when the interval is the half-infinite one; the page gives that clause the warning treatment. */
export function isUnbounded(ci: readonly number[] | null): boolean {
	return Boolean(ci && ci.length === 2 && !Number.isFinite(ci[0]) && Number.isFinite(ci[1]));
}

/**
 * The root, in words. `root_description` is the reference's own provenance token
 * (`explicit_root_CONSENSUS`, `time_decay_consensus_root (γ=3.0030)`), not a sentence, so it is
 * translated here rather than printed.
 */
export function rootSentence(run: DatingResult): string {
	const d = run.rootDescription ?? '';
	if (run.rootCase === 1) {
		const name = d.startsWith('explicit_root_') ? d.slice('explicit_root_'.length) : d;
		return `${name}, the sequence you named as the root`;
	}
	if (run.rootCase === 2) return 'an unweighted majority consensus of your sequences';
	if (run.rootCase === 3) {
		return d.startsWith('earliest_cohort_n')
			? `the mean divergence to the ${d.slice('earliest_cohort_n'.length)} earliest sequences`
			: `${d.replace('earliest_taxon_', '')}, your earliest sequence`;
	}
	const gamma = /γ=([0-9.]+)/.exec(d)?.[1];
	return `a time-decay weighted consensus this page built${gamma ? `, γ = ${gamma}` : ''}`;
}

/** "143 sequences, 142 dated, 141 in the fit." The three counts a reader otherwise reconciles alone. */
export function countsSentence(run: DatingResult): string {
	const p = (run.record.primaeon ?? {}) as Record<string, number | undefined>;
	const inFile = p.sequences_in_file ?? 0;
	const dated = p.dated ?? 0;
	const fit = p.train_count ?? 0;
	return `${inFile} sequences in the file, ${dated} dated, ${fit} in the fit.`;
}

/**
 * The holdout line. On the flagship example this IS the result — the 1959 Léopoldville isolate is
 * reserved out of the fit by the coverage rule and its predicted date is the pillar's own
 * out-of-sample check — so it is a sentence in the section, not a footnote under a table.
 */
export function holdoutSentence(run: DatingResult, units: TimeUnits): string | null {
	const p = (run.record.primaeon ?? {}) as Record<string, unknown>;
	const holdouts = Array.isArray(p.holdouts) ? (p.holdouts as string[]) : [];
	if (holdouts.length === 0) return null;
	const reserved = p.holdouts_reserved === true;
	const names = holdouts.slice(0, 3).join(', ') + (holdouts.length > 3 ? `, and ${holdouts.length - 3} more` : '');
	if (!reserved) {
		return (
			`${holdouts.length} sequence${holdouts.length === 1 ? '' : 's'} carry data at under half their sites ` +
			`(${names}) but stayed in the fit, because reserving them would leave too few sequences to fit on.`
		);
	}
	const rows = run.rows.filter((r) => r.is_holdout);
	const first = rows[0];
	const check =
		first && Number.isFinite(first.predicted_date)
			? ` The fit predicts ${first.taxon}'s ${units === 'years' ? 'date' : 'time'} as ${yr(first.predicted_date)} against a label of ${yr(first.sampling_date)}.`
			: '';
	return (
		`${holdouts.length} sequence${holdouts.length === 1 ? '' : 's'}, ${names}, ${holdouts.length === 1 ? 'was' : 'were'} ` +
		`held out of the fit because under half its sites carry data.${check}`
	);
}

/** Everything the reader is told about the estimate, in `dl.stats`'s six-entry idiom. */
export function statEntries(run: DatingResult, units: TimeUnits): StatEntry[] {
	const ols = modelOf(run, 'ols');
	const shown = pair(ols, ciKey(run));
	const label = ciMethodOf(run) === 'delta' ? 'delta method' : 'Fieller';
	const word = ancestorWord(units);
	return [
		{
			label: word[0].toUpperCase() + word.slice(1),
			value: yr(n(ols, 't_mrca')),
			qualifier: `95 % interval (${label}): ${intervalText(shown, units)}`
		},
		{
			label: 'Clock rate',
			value: sci(n(ols, 'mu')),
			qualifier: `substitutions per site per ${unitWord(units)}, ± ${sci(n(ols, 'se_mu'))}`
		},
		{
			label: 'R²',
			value: num(n(ols, 'r2'), 3),
			qualifier: `over ${n(ols, 'n')} sequences in the fit`
		},
		{
			label: 'Slope p',
			value: sci(n(ols, 'p_value'), 3),
			qualifier: 'from the F statistic on 1 and n − 2 degrees of freedom'
		},
		{
			label: 'Residual RMSE',
			value: sci(n(ols, 'rmse')),
			qualifier: 'substitutions per site, about the fitted line'
		},
		{
			label: 'Root',
			value: run.rootCase === 1 ? (run.rootDescription ?? '').replace('explicit_root_', '') : 'consensus',
			qualifier: rootSentence(run)
		}
	];
}

/**
 * The lede: the estimate with its numbers inline, and nothing else (web/DESIGN.md §5). It names the
 * root in the same breath, because the root is a choice and the date moves with it.
 */
export function verdictSentence(run: DatingResult, units: TimeUnits): string {
	const ols = modelOf(run, 'ols');
	const ci = pair(ols, ciKey(run));
	const label = ciMethodOf(run) === 'delta' ? 'delta method' : 'Fieller';
	const fit = n(ols, 'n');
	const where = units === 'years' ? 'in' : 'at';
	const interval = isUnbounded(ci)
		? `with a 95 % interval (${label}) that has no lower bound and an upper bound of ${yr(ci![1])}`
		: `with a 95 % interval (${label}) from ${yr(ci?.[0] ?? NaN)} to ${yr(ci?.[1] ?? NaN)}`;
	return (
		`These ${fit} sequences share a common ancestor ${where} ${yr(n(ols, 't_mrca'))}, ${interval}. ` +
		`The clock runs at ${sci(n(ols, 'mu'))} substitutions per site per ${unitWord(units)} and accounts for ` +
		`${Math.round(n(ols, 'r2') * 100)} % of the spread in divergence (R² ${num(n(ols, 'r2'), 3)}). ` +
		`Divergence is measured to ${rootSentence(run)}.`
	);
}

/**
 * Which clock model the curvature test chose, what that model says, and why the headline above is
 * not it. Plain `.note`, never a warning: web/DESIGN.md §5 sets caveats in the results' own voice,
 * and orange on this page is reserved for problems with the dates.
 */
export function clockNote(run: DatingResult, units: TimeUnits): string | null {
	const spline = modelOf(run, 'spline');
	if (!spline) return null;
	const preferred = spline.is_nonlinear_preferred === true;
	const f = n(spline, 'f_stat');
	const p = n(spline, 'p_f_test');
	const daic = n(spline, 'delta_aic');
	const df = n(spline, 'n') - 3;
	if (!preferred) {
		return (
			`The automatic clock test looked for curvature and did not find enough to prefer it: ` +
			`F = ${num(f)} on 1 and ${df} d.f., p = ${num(p, 4)}, ΔAIC = ${signed(daic)}. The straight line above is ` +
			`the model the test kept.`
		);
	}
	const ratio = n(spline, 'rate_ratio');
	const direction = ratio > 1 ? 'accelerating' : 'decelerating';
	return (
		`The automatic clock test prefers a ${direction} spline over the straight line this estimate assumes: ` +
		`the rate ${ratio > 1 ? 'rises' : 'falls'} from ${sci(n(spline, 'rate_ancestral'))} early to ` +
		`${sci(n(spline, 'rate_recent'))} recently, a ratio of ${num(ratio)} (F = ${num(f)} on 1 and ${df} d.f., ` +
		`p = ${num(p, 4)}, ΔAIC = ${signed(daic)}). That model puts the ${ancestorWord(units)} at ${yr(n(spline, 't_mrca'))}. ` +
		`This build computes no interval for it — the reference's own bootstrap raises on every replicate — so the ` +
		`estimate above, from the model the test rejects, is the one quoted, because it is the one that can be ` +
		`argued with.`
	);
}

/**
 * The CLI's own table of estimators, including the four this build does not run. They are ROWS
 * saying what is missing and why, never a promise: web/DESIGN.md §5 forbids "coming soon", and a
 * table that simply omitted them would let a reader think this is the whole pillar.
 */
export function estimatorRows(run: DatingResult, units: TimeUnits): EstimatorRow[] {
	const ols = modelOf(run, 'ols');
	const spline = modelOf(run, 'spline');
	const method = ciMethodOf(run) === 'delta' ? 'delta' : 'Fieller';
	const rows: EstimatorRow[] = [
		{
			name: 'Root-to-tip OLS (TempEst)',
			date: yr(n(ols, 't_mrca')),
			interval: `${intervalText(pair(ols, ciKey(run)), units)} (${method})`,
			rate: sci(n(ols, 'mu')),
			r2: num(n(ols, 'r2'), 3),
			note: null,
			built: true
		}
	];
	if (spline) {
		const degenerate = (() => {
			const ci = pair(spline, 'ci_mrca');
			return Boolean(ci && ci[0] === ci[1]);
		})();
		rows.push({
			name: 'Restricted spline clock',
			date: yr(n(spline, 't_mrca')),
			interval: degenerate
				? 'not computed — the reference’s bootstrap raises on every replicate, so its interval collapses to the point estimate'
				: intervalText(pair(spline, 'ci_mrca'), units),
			rate: sci(n(spline, 'rate_ancestral')),
			r2: num(n(spline, 'r2'), 3),
			note: spline.is_nonlinear_preferred === true ? 'the model the curvature test selected' : 'tested and not preferred',
			built: true
		});
	}
	const notBuilt = ((run.record.primaeon ?? {}) as Record<string, unknown>).estimators_not_built;
	if (Array.isArray(notBuilt)) {
		for (const e of notBuilt as Array<{ name: string; reason: string }>) {
			rows.push({ name: e.name, date: null, interval: null, rate: null, r2: null, note: e.reason, built: false });
		}
	}
	const ens = run.ensemble;
	if (ens && ens.t_mrca != null && Number.isFinite(ens.t_mrca)) {
		const weights = Object.entries(ens.weights ?? {})
			.map(([k, v]) => `${k} ${Math.round(v * 100)} %`)
			.join(', ');
		rows.push({
			name: 'Model-averaged ensemble',
			date: yr(ens.t_mrca),
			interval: intervalText(ens.ci_mrca, units),
			rate: null,
			r2: null,
			note:
				`averages ${weights || 'nothing'}, and re-forms the asymmetric interval it was built from as a ` +
				`symmetric Gaussian one; reported because the reference record carries it, not because it is a second answer`,
			built: true
		});
	}
	return rows;
}

/** The whole section's view model. One call from the component. */
export function datingView(run: DatingResult | null, units: TimeUnits): DatingView | null {
	if (!run) return null;
	const base: DatingView = {
		ok: false,
		refusal: null,
		verdict: '',
		counts: '',
		holdout: null,
		stats: [],
		estimators: [],
		clockNote: null,
		unbounded: false,
		units
	};
	if (!run.ok) {
		const code = run.refusal ?? 'DATING_ALIGNMENT_EMPTY';
		return {
			...base,
			refusal: {
				code,
				reason: warningFor(run, code)?.message ?? 'The run produced no estimate.',
				next: NEXT_ACTION[code] ?? 'Change the input above and estimate again.'
			}
		};
	}
	const ols = modelOf(run, 'ols');
	const status = String(ols?.status ?? '');
	if (status !== 'OK' || !Number.isFinite(n(ols, 't_mrca'))) {
		const code = status === 'NON_POSITIVE_RATE' ? 'DATING_NON_POSITIVE_RATE' : 'DATING_MRCA_AFTER_EARLIEST_SAMPLE';
		return {
			...base,
			counts: countsSentence(run),
			refusal: {
				code,
				reason: warningFor(run, code)?.message ?? 'The fit produced no ancestor estimate.',
				next: NEXT_ACTION[code] ?? 'Change the input above and estimate again.'
			}
		};
	}
	const ci = pair(ols, ciKey(run));
	return {
		...base,
		ok: true,
		verdict: verdictSentence(run, units),
		counts: countsSentence(run),
		holdout: holdoutSentence(run, units),
		stats: statEntries(run, units),
		estimators: estimatorRows(run, units),
		clockNote: clockNote(run, units),
		unbounded: isUnbounded(ci)
	};
}

// ---- the figure's geometry ---------------------------------------------------------------------

export interface DatingPoint {
	taxon: string;
	time: number;
	divergence: number;
	fitted: number;
	holdout: boolean;
	outlier: boolean;
}

export interface DatingFigureModel {
	points: DatingPoint[];
	/** The straight-line fit, as two endpoints in data coordinates. */
	line: { x1: number; y1: number; x2: number; y2: number } | null;
	/** The selected spline's fitted values, sorted by time; empty unless the spline was preferred. */
	curve: Array<{ x: number; y: number }>;
	/** Where the ancestor sits on the time axis, and its interval as a bracket. */
	ancestor: { t: number; low: number; high: number; openLow: boolean } | null;
	domain: { x0: number; x1: number; y0: number; y1: number };
}

/**
 * Everything the figure draws, computed here so the component holds no arithmetic.
 *
 * The x domain is widened to hold the ancestor and its interval, because on the flagship example
 * both sit sixty to a hundred and forty years before the earliest sequence: a figure that cropped
 * them would show a line and hide the thing the line is for. A half-infinite lower bound is not
 * extended — the domain stops at the ancestor and the bracket is drawn open, which is what
 * `openLow` says.
 */
export function figureModel(run: DatingResult | null): DatingFigureModel | null {
	if (!run?.ok || run.rows.length === 0) return null;
	const ols = modelOf(run, 'ols');
	const spline = modelOf(run, 'spline');
	const points: DatingPoint[] = run.rows.map((r) => ({
		taxon: r.taxon,
		time: r.sampling_date,
		divergence: r.root_divergence,
		fitted: r.fitted_divergence,
		holdout: r.is_holdout,
		outlier: r.is_outlier
	}));
	let x0 = Math.min(...points.map((p) => p.time));
	let x1 = Math.max(...points.map((p) => p.time));
	const y1 = Math.max(...points.map((p) => Math.max(p.divergence, p.fitted)));

	const tMrca = n(ols, 't_mrca');
	const ci = pair(ols, ciKey(run));
	let ancestor: DatingFigureModel['ancestor'] = null;
	if (Number.isFinite(tMrca)) {
		const openLow = !ci || !Number.isFinite(ci[0]);
		const low = openLow ? tMrca : ci![0];
		const high = ci && Number.isFinite(ci[1]) ? ci[1] : tMrca;
		ancestor = { t: tMrca, low, high, openLow };
		x0 = Math.min(x0, low, tMrca);
		x1 = Math.max(x1, high);
	}

	const mu = n(ols, 'mu');
	const d0 = n(ols, 'd0');
	const tRef = n(ols, 't_ref');
	const at = (t: number) => d0 + mu * (t - tRef);
	const line = Number.isFinite(mu) && Number.isFinite(d0) ? { x1: x0, y1: at(x0), x2: x1, y2: at(x1) } : null;

	// The curve is the ACTIVE model's own fitted values at the sampled times, sorted — not a
	// re-evaluation of the basis. Re-evaluating would mean a second implementation of
	// `compute_rcs_basis` on the page, and the fitted column is already the thing the record
	// carries and the table prints, so the line and the column cannot disagree.
	const preferred = spline?.is_nonlinear_preferred === true;
	const curve = preferred ? [...points].sort((a, b) => a.time - b.time).map((p) => ({ x: p.time, y: p.fitted })) : [];

	return { points, line, curve, ancestor, domain: { x0, x1, y0: 0, y1 } };
}

// ---- the per-sequence table --------------------------------------------------------------------

export type TaxonSortKey =
	| 'rank'
	| 'taxon'
	| 'sampling_date'
	| 'root_divergence'
	| 'fitted_divergence'
	| 'predicted_date'
	| 'temporal_residual'
	| 'divergence_residual'
	| 'z_score'
	| 'status';

export interface TaxonRowView extends TaxonDatingRow {
	index: number;
	/** Flagged first, then the labelled holdouts, then by |z| descending. */
	rank: number;
	/** Words, not marks: `flagged`, `held out`, or empty. web/DESIGN.md §8's `/time` rule. */
	status: string;
	/** `spline`, `linear fallback`, … — ours, because the reference emits no such column. */
	methodText: string;
	excluded: boolean;
}

const METHOD_TEXT: Record<string, string> = {
	ols: 'straight line',
	spline: 'spline',
	linear_arm: 'spline, linear arm',
	linear_fallback: 'straight line (no curve solution)',
	none: 'not predicted'
};

/** One view row per `taxa_summary` row, in alignment order. */
export function taxonRows(run: DatingResult | null, excluded: readonly string[] = []): TaxonRowView[] {
	if (!run?.ok) return [];
	const drop = new Set(excluded);
	return run.rows.map((r, index) => ({
		...r,
		index,
		rank: r.is_outlier ? 0 : r.is_holdout ? 1 : 2,
		status: r.is_outlier ? 'flagged' : r.is_holdout ? 'held out' : '',
		methodText: METHOD_TEXT[r.prediction_method] ?? r.prediction_method,
		excluded: drop.has(r.taxon)
	}));
}

/**
 * The reader's default order, which is NOT the record's: flagged first, then the labelled holdouts,
 * then by |z| descending, then by name. On the flagship example the flagged set is EMPTY, which is
 * exactly why this is a per-sequence table that sorts problems to the top rather than an
 * outliers-only table: the latter would be blank on the page's own flagship dataset.
 */
export function sortTaxonRows(rows: TaxonRowView[], key: TaxonSortKey, ascending: boolean): TaxonRowView[] {
	const out = [...rows];
	if (key === 'rank') {
		out.sort(
			(a, b) =>
				a.rank - b.rank ||
				(Number.isFinite(b.z_score) ? Math.abs(b.z_score) : -Infinity) - (Number.isFinite(a.z_score) ? Math.abs(a.z_score) : -Infinity) ||
				a.taxon.localeCompare(b.taxon)
		);
		return ascending ? out : out.reverse();
	}
	const value = (r: TaxonRowView): string | number => {
		if (key === 'taxon') return r.taxon;
		if (key === 'status') return r.status || 'zzz';
		const v = r[key as keyof TaxonDatingRow];
		return typeof v === 'number' ? (Number.isFinite(v) ? v : Number.POSITIVE_INFINITY) : String(v);
	};
	out.sort((a, b) => {
		const av = value(a);
		const bv = value(b);
		const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
		if (cmp === 0) return a.index - b.index;
		return ascending ? cmp : -cmp;
	});
	return out;
}

export function filterTaxonRows(rows: TaxonRowView[], query: string, flaggedOnly: boolean): TaxonRowView[] {
	const q = query.trim().toLowerCase();
	return rows.filter((r) => {
		if (flaggedOnly && !r.is_outlier && !r.is_holdout) return false;
		if (!q) return true;
		return r.taxon.toLowerCase().includes(q) || r.status.includes(q) || r.methodText.includes(q);
	});
}

/**
 * THE ONE THING THIS TABLE MUST NOT BE READ AS, when the curvature test has selected a decelerating
 * clock. Inverting that clock per sequence is badly behaved at the modern end, and the reference
 * says nothing about it. Measured on the flagship example, under the selected spline:
 *
 *     43 of 142 sequences are predicted after the latest sample (1997.5), 36 after 2010, 13 after
 *     2050, and the largest is 2097.19 against the root find's own bracket ceiling of
 *     max(time) + 100 = 2097.5; the largest `temporal_residual` is +101.69 years
 *
 * None of those are dates; they are an inversion running out of curve. So when the active model is
 * the spline the section states it above the table, with this dataset's own counts rather than a
 * general warning, and the column is presented as what it is. `bracketSaturationYears` in the
 * runtime already names the rows pressed against the ceiling; this covers the much larger set that
 * merely lands implausibly late.
 *
 * Returns null under a straight-line clock, where the inversion is one division and behaves.
 */
export function predictionCaveat(run: DatingResult | null, units: TimeUnits): { text: string; count: number } | null {
	if (!run?.ok || run.activeName !== 'spline' || run.rows.length === 0) return null;
	let latest = -Infinity;
	for (const r of run.rows) if (r.sampling_date > latest) latest = r.sampling_date;
	const beyond = run.rows.filter((r) => Number.isFinite(r.predicted_date) && r.predicted_date > latest);
	if (beyond.length === 0) return null;
	const worst = Math.max(...beyond.map((r) => r.predicted_date));
	const word = unitWord(units);
	return {
		count: beyond.length,
		text:
			`The predicted ${units === 'years' ? 'dates' : 'times'} in this table come from the curved clock the ` +
			`test selected, and inverting a decelerating clock is badly behaved at the recent end: ` +
			`${beyond.length} of ${run.rows.length} sequences are placed after ${yr(latest)}, the latest ${word} in ` +
			`the data, the furthest at ${yr(worst)}. Those are the inversion running out of curve, not ` +
			`${units === 'years' ? 'dates' : 'times'}. Read the column as a residual check — which sequences sit ` +
			`where the clock does not expect them — rather than as an estimate of when each sequence was collected.`
	};
}

// ---- the one line that reconciles this section with the preview above it -----------------------

/**
 * The preview and this section measure different things and will disagree; saying so in one line is
 * the honest move, and it is what replaces the preview's own ancestor tile once a run exists (see
 * `ClockPreview.svelte`). `wide` is true when the gap is larger than the interval this section
 * quotes, which is the point at which the disagreement is the headline rather than a footnote.
 */
export function crossCheckSentence(
	datingTMrca: number,
	previewTMrca: number,
	ciWidth: number,
	units: TimeUnits
): { text: string; wide: boolean } | null {
	if (!Number.isFinite(datingTMrca) || !Number.isFinite(previewTMrca)) return null;
	const gap = Math.abs(datingTMrca - previewTMrca);
	const wide = Number.isFinite(ciWidth) && ciWidth > 0 ? gap > ciWidth : false;
	const word = unitWord(units);
	return {
		text:
			`The ${ancestorWord(units)} section below estimates ${yr(datingTMrca)} from tree-free TN93 distances to a ` +
			`chosen root; this preview's line, on your tree, puts it at ${yr(previewTMrca)} — a difference of ` +
			`${num(gap, 1)} ${word}s, which is what a different root and a different distance measure buy you.`,
		wide
	};
}
