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
 * PHASE 4 ADDED THE TWO ESTIMATORS THE MODEL FEEDS, AND WITH THEM A SECOND DISAGREEMENT THAT IS
 * NOT ABOUT WHICH ESTIMATOR TO QUOTE BUT ABOUT WHAT IS BEING FITTED. `--distance-mode auto` — the
 * reference's default — resolves to `latent` the moment a dating graph is present and there is no
 * tree (dating.py:2520-2523), and the latent root's distances are then fed to EVERY estimator, the
 * ordinary one included. Measured on the same flagship example, same sequences, same dates:
 *
 *     model off, TN93 divergences      ols 1893.91  mu 1.169e-3   pgls —        spline 1938.77
 *     model on,  TN93 divergences      ols 1893.91  mu 1.169e-3   pgls 1841.61  spline 1864.55
 *     model on,  latent divergences    ols 1926.81  mu 5.551e-4   pgls 1633.07  spline −1974.64
 *
 * Three things in that table are worth more than the numbers. The ordinary fit MOVES when the model
 * is turned on, because its input changed and not its arithmetic (`divergenceSentence` is the line
 * that says so, and `DATING_LATENT_DIVERGENCES` is the runtime's). The SPLINE moves on divergences
 * that did not move, because `dating.py:2844` hands it the model's covariance the moment the model
 * runs, so it is a generalised fit here and an ordinary one otherwise (`DATING_MODEL_SPLINE_
 * REWEIGHTED`). And the generalised fit can deflate the rate five-fold with a worse R² — the
 * reference's own clade-attenuation test, which takes the headline away from it AND bars it from
 * the averaged row, so a record can carry a PGLS fit that appears in neither.
 *
 * THE PAGE DOES NOT AVERAGE THE THREE. `agreementNote` says, in the run's own numbers, why they
 * differ and which one answers; the ensemble stays one row of the estimator table with its own
 * arithmetic stated. Averaging an ordinary fit with a generalised one whose slope is not
 * distinguishable from zero produces a number no reader could defend.
 *
 * THE PAGE QUOTES THE HEADLINE MODEL, WHICH IS `active_model` UNLESS ITS INTERVAL IS DEGENERATE.
 * The
 * curvature test does prefer the spline here, and the section says so in full (`clockNote`), with
 * the spline's date and the test that chose it. But the spline has no interval at all: its
 * bootstrap raises on every replicate upstream (`dating.py:1917` hands numpy's `rcond=` to
 * `scipy.linalg.lstsq`, whose keyword is `cond=`), so all four of its intervals collapse to their
 * point estimates, and a zero-width 95 % interval must never be drawn as an interval. An estimate
 * that cannot be argued with is not the one to headline, so the headline is the straight line —
 * from the model the test rejects — and the section states that in one paragraph rather than
 * leaving a reader to discover that the page and the CLI's top-level `t_mrca` differ by 45 years.
 *
 * That rule is stated as a rule (`headlineOf`) rather than as "always OLS", and phase 4 is why: on
 * TN93 divergences with the model on, `active_model` is `pgls` and its Fieller interval is finite
 * and positive-width, so the page quotes the generalised fit and agrees with the CLI's own
 * top-level `t_mrca`. The only model the rule ever refuses is the spline, and only because of the
 * dead bootstrap. `headlineOf().departed` is what the section prints the departure sentence from.
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

	// ---- phase 4 ---------------------------------------------------------------------------------
	/** Which fit the numbers above come from, and whether that is the reference's own selection. */
	headline: ModelKey;
	activeModel: ModelKey;
	/** The reference's own `selected_clock` sentence, byte for byte. */
	selectedClock: string;
	/** True when this run loaded `<variant>_taxa.onnx`. */
	modelRan: boolean;
	/** `'tn93' | 'latent'`, off the record. */
	distanceMode: 'tn93' | 'latent';
	/** What the y axis IS — a sequence distance, or a distance in the model's own space. */
	divergence: string;
	/** Why the fits disagree and which one answers; null when there is only one. */
	agreement: string | null;
	/** The latent root's scale, correlation and anchor sequences; null when it did not run. */
	latent: LatentRootView | null;
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
	DATING_MRCA_AFTER_EARLIEST_SAMPLE: 'Check the date on the earliest sequence, and the root above.',
	DATING_MODEL_TOO_MANY_TAXA:
		'Estimate without the model, which has no such limit, or date a subset. The reference stops at the same ' +
		'number and quietly falls back to the ordinary fit; this refuses instead, because the covariance the ' +
		'fallback does not build is the whole difference between the two answers.'
};

/**
 * What the page can say about the model-based half BEFORE a run: whether it can be offered at all,
 * and if not, which of the three reasons it is. This is application judgement and not the run's —
 * the run does not exist yet — so it lives beside the other sentences rather than in the runtime.
 */
export interface ModelOffer {
	available: boolean;
	/** The one sentence under the button, offered or refused. */
	reason: string;
	/** The cost, stated before a reader waits for it. Empty when the offer is refused. */
	cost: string;
}

export function modelOffer(args: {
	workers: boolean;
	dated: number;
	codons: number | null;
	/** The cap `runDating` refuses above (`DATING_NEURAL_MAX_TAXA`). */
	maxTaxa: number;
}): ModelOffer {
	const { workers, dated, codons, maxTaxa } = args;
	if (!workers) {
		return {
			available: false,
			reason: 'This browser has no Web Workers, so the model pass has nowhere to run that can be cancelled.',
			cost: ''
		};
	}
	if (dated > maxTaxa) {
		return {
			available: false,
			reason:
				`${dated} dated sequences is more than the ${maxTaxa} the model-based estimators are run at. The ` +
				`reference stops at the same number and falls back to the ordinary fit without saying so; this build ` +
				`refuses, because the covariance the fallback does not build is the whole difference between the two ` +
				`answers.`,
			cost: ''
		};
	}
	const sites = codons && Number.isFinite(codons) ? `${codons.toLocaleString()} codons` : 'every codon';
	return {
		available: true,
		reason:
			'The two model-based estimators need a taxon-by-taxon attention matrix and per-taxon embeddings, which ' +
			'only the dating graph emits. Running them loads one.',
		cost:
			`It is a second forward pass over ${sites} — every site, not the variable ones — through a 7.3 MB graph ` +
			`this page downloads once. Measured at four threads on the development machine, 143 sequences × 981 ` +
			`codons took 7.3 seconds after the download; the model-free estimate above takes about a third of a ` +
			`second and loads nothing. It runs in its own worker and can be cancelled.`
	};
}

function warningFor(run: DatingResult, code: string): { message: string } | null {
	return run.warnings.find((w) => w.code === code) ?? null;
}

type ModelRecord = Record<string, number | number[] | string | boolean | null>;

export type ModelKey = 'ols' | 'pgls' | 'spline';

function modelOf(run: DatingResult, key: ModelKey): ModelRecord | null {
	const value = (run.record as Record<string, unknown>)[key];
	return value && typeof value === 'object' ? (value as ModelRecord) : null;
}

/** The English name of each fit, used in the table, the sentences and the provenance alike. */
export const MODEL_NAMES: Record<ModelKey, string> = {
	ols: 'Root-to-tip OLS (TempEst)',
	pgls: 'Attention PGLS',
	spline: 'Restricted spline clock'
};

/** The short name, for running text where the full one would read as a citation. */
export const MODEL_SHORT: Record<ModelKey, string> = {
	ols: 'the ordinary fit',
	pgls: 'the generalised fit',
	spline: 'the spline'
};

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

/** True when an interval is `[x, x]` — a point estimate wearing an interval's shape. */
export function isDegenerate(ci: readonly number[] | null): boolean {
	return Boolean(ci && ci.length === 2 && Number.isFinite(ci[0]) && ci[0] === ci[1]);
}

export interface HeadlineModel {
	key: ModelKey;
	/** The record block itself, so every caller reads one object rather than re-branching. */
	model: ModelRecord;
	/** True when the page quotes something other than the reference's own `active_model`. */
	departed: boolean;
	/** The model the reference selected, always — named even when it is the one quoted. */
	activeKey: ModelKey;
}

/**
 * WHICH FIT THE PAGE QUOTES. The rule, in full: quote `active_model`, unless its 95 % interval is
 * a point estimate wearing an interval's shape, in which case quote the ordinary fit instead and
 * say so. Only the spline ever trips the second clause, and only because its bootstrap is dead
 * upstream (`DATING_SPLINE_NO_INTERVAL`); a fit whose interval cannot be argued with is not the
 * one to headline.
 *
 * It is deliberately NOT "always OLS". With the model on TN93 divergences the reference selects
 * PGLS and its Fieller interval is finite and has width, so the page quotes it and agrees with the
 * CLI's top-level `t_mrca` — which is the outcome a reader diffing the two would expect, and the
 * one the phase-3 rule could not produce.
 */
export function headlineOf(run: DatingResult): HeadlineModel | null {
	const activeKey = (String(run.record.active_model ?? 'ols') as ModelKey) || 'ols';
	const ols = modelOf(run, 'ols');
	const active = modelOf(run, activeKey) ?? ols;
	const usable = (m: ModelRecord | null) =>
		Boolean(m && Number.isFinite(Number(m.t_mrca)) && !isDegenerate(pair(m, 'ci_mrca')));
	if (usable(active)) return { key: activeKey, model: active as ModelRecord, departed: false, activeKey };
	if (ols && Number.isFinite(Number(ols.t_mrca))) {
		return { key: 'ols', model: ols, departed: activeKey !== 'ols', activeKey };
	}
	return active ? { key: activeKey, model: active, departed: false, activeKey } : null;
}

/**
 * The root, in words. `root_description` is the reference's own provenance token
 * (`explicit_root_CONSENSUS`, `time_decay_consensus_root (γ=3.0030)`), not a sentence, so it is
 * translated here rather than printed.
 */
export function rootSentence(run: DatingResult): string {
	const d = run.rootDescription ?? '';
	// Phase 4's root case, and it is tested FIRST because it has no `rootCase` at all: under
	// `--distance-mode latent` there is no consensus and no named sequence, only a position the
	// model found inside the convex hull of its own representation of the alignment
	// (dating.py:2586-2599). `rootCase` is null there, and the γ branch below would otherwise
	// describe it as a time-decay consensus, which is a different object entirely.
	if (d.startsWith('latent_convex_hull')) {
		const alpha = /α=([0-9.eE+-]+)/.exec(d)?.[1];
		return `a root the model placed inside its own representation of your sequences${alpha ? `, rescaled at α = ${alpha} substitutions per site per latent unit` : ''}`;
	}
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

/**
 * Everything the reader is told about the estimate, in `dl.stats`'s six-entry idiom, off the
 * HEADLINE fit rather than off OLS unconditionally.
 *
 * The fourth entry is the one that changes shape, and it has to: the OLS record carries `p_value`
 * from an F statistic and the PGLS record does not carry one at all (dating.py:1441-1460 returns
 * neither an F nor a p for the generalised fit). Printing an em dash there would read as a missing
 * number rather than as a fit that does not produce one, so the generalised fit shows Pagel's λ*
 * instead — which is the quantity that says how much of the residual covariance the model called
 * phylogenetic, and therefore the honest answer to "how far is this from the line above it".
 */
export function statEntries(run: DatingResult, units: TimeUnits): StatEntry[] {
	const head = headlineOf(run);
	const m = head?.model ?? modelOf(run, 'ols');
	const shown = pair(m, ciKey(run)) ?? pair(m, 'ci_mrca');
	const label = ciMethodOf(run) === 'delta' ? 'delta method' : 'Fieller';
	const word = ancestorWord(units);
	const rate = Number.isFinite(n(m, 'mu')) ? n(m, 'mu') : n(m, 'rate_ancestral');
	const entries: StatEntry[] = [
		{
			label: word[0].toUpperCase() + word.slice(1),
			value: yr(n(m, 't_mrca')),
			qualifier: `95 % interval (${label}): ${intervalText(shown, units)}`
		},
		{
			label: 'Clock rate',
			value: sci(rate),
			qualifier: `substitutions per site per ${unitWord(units)}${Number.isFinite(n(m, 'se_mu')) ? `, ± ${sci(n(m, 'se_mu'))}` : ''}`
		},
		{
			label: 'R²',
			value: num(n(m, 'r2'), 3),
			qualifier:
				head?.key === 'pgls'
					? `generalised (Buse), over ${n(m, 'n')} sequences in the fit`
					: `over ${n(m, 'n')} sequences in the fit`
		}
	];
	if (head?.key === 'pgls') {
		entries.push({
			label: 'Pagel λ*',
			value: num(n(m, 'pagel_lambda'), 4),
			qualifier: 'how much of the residual covariance the model read as shared ancestry, by profile REML'
		});
	} else {
		entries.push({
			label: 'Slope p',
			value: sci(n(m, 'p_value'), 3),
			qualifier: 'from the F statistic on 1 and n − 2 degrees of freedom'
		});
	}
	entries.push(
		{
			label: 'Residual RMSE',
			value: sci(n(m, 'rmse')),
			qualifier: 'substitutions per site, about the fitted line'
		},
		{
			label: 'Divergence measured to',
			value: distanceModeOf(run) === 'latent' ? 'a latent root' : run.rootCase === 1 ? (run.rootDescription ?? '').replace('explicit_root_', '') : 'consensus',
			qualifier: rootSentence(run)
		}
	);
	return entries;
}

/** `'tn93' | 'latent'` — read off the record, never assumed from whether a model ran. */
export function distanceModeOf(run: DatingResult): 'tn93' | 'latent' {
	return String(run.record.distance_mode ?? 'tn93') === 'latent' ? 'latent' : 'tn93';
}

/** True when this run loaded the dating graph; the record's own `primaeon.model_pass` says so. */
export function modelRan(run: DatingResult | null): boolean {
	const p = (run?.record?.primaeon ?? {}) as Record<string, unknown>;
	return p.model_pass != null;
}

/**
 * The lede: the estimate with its numbers inline, and nothing else (web/DESIGN.md §5). It names the
 * root in the same breath, because the root is a choice and the date moves with it.
 */
export function verdictSentence(run: DatingResult, units: TimeUnits): string {
	const head = headlineOf(run);
	const m = head?.model ?? modelOf(run, 'ols');
	const ci = pair(m, ciKey(run)) ?? pair(m, 'ci_mrca');
	const label = ciMethodOf(run) === 'delta' ? 'delta method' : 'Fieller';
	const fit = n(m, 'n');
	const where = units === 'years' ? 'in' : 'at';
	const rate = Number.isFinite(n(m, 'mu')) ? n(m, 'mu') : n(m, 'rate_ancestral');
	const interval = isUnbounded(ci)
		? `with a 95 % interval (${label}) that has no lower bound and an upper bound of ${yr(ci![1])}`
		: `with a 95 % interval (${label}) from ${yr(ci?.[0] ?? NaN)} to ${yr(ci?.[1] ?? NaN)}`;
	const which = head && head.key !== 'ols' ? `, by ${MODEL_SHORT[head.key]},` : '';
	return (
		`These ${fit} sequences${which} share a common ancestor ${where} ${yr(n(m, 't_mrca'))}, ${interval}. ` +
		`The clock runs at ${sci(rate)} substitutions per site per ${unitWord(units)} and accounts for ` +
		`${Math.round(n(m, 'r2') * 100)} % of the spread in divergence (R² ${num(n(m, 'r2'), 3)}). ` +
		`Divergence is measured to ${rootSentence(run)}.`
	);
}

/**
 * What the divergences on the y axis ARE, which phase 4 made a question. In a model-free run they
 * are TN93 distances to a root and the sentence is short; under `--distance-mode latent` they are
 * `α × ‖z_i − z_root‖` in the model's representation space, EVERY estimator is fitted against them
 * (the ordinary one included), and the ancestor date above is therefore model-dependent even when
 * the estimator quoting it is not. `DATING_LATENT_DIVERGENCES` is the runtime's version of this;
 * the difference is that this one is a sentence in the section rather than a diagnostic in a strip.
 */
export function divergenceSentence(run: DatingResult, units: TimeUnits): string {
	const lat = latentRootView(run);
	if (!lat) {
		return (
			`Divergence is a TN93 distance from each sequence to ${rootSentence(run)}, computed in this ` +
			`browser. No model is involved in it.`
		);
	}
	return (
		`Divergence here is not a sequence distance. The model placed a root inside the convex hull of ` +
		`its own representation of your ${lat.n} sequences and every divergence below is the distance to ` +
		`that root in that space, rescaled to substitutions per site by one slope (α = ${sci(lat.alpha)}) ` +
		`fitted against the observed pairwise differences. That root's own correlation with ` +
		`${axisWord(units)} is R = ${num(lat.r, 3)} (R² ${num(lat.r2, 3)}). Every estimator in the table ` +
		`below is fitted against these divergences, the ordinary one included, which is what ` +
		`\`--distance-mode auto\` resolves to once a dating graph is present and there is no tree.`
	);
}

export interface LatentRootView {
	alpha: number;
	r: number;
	r2: number;
	n: number;
	/** The reference's own `anchor_taxa`, in its own order (`np.argsort(-w)`). */
	anchors: Array<{ taxon: string; weight: number; date: number }>;
}

/**
 * `record.latent_root`, or null when the latent root did not run — which is TWO different facts and
 * the section says which: no dating graph at all, or a reader who pinned `--distance-mode tn93` and
 * asked for the covariance without the root.
 */
export function latentRootView(run: DatingResult | null): LatentRootView | null {
	const l = (run?.record?.latent_root ?? null) as Record<string, unknown> | null;
	if (!l || typeof l !== 'object') return null;
	const anchors = Array.isArray(l.anchor_taxa) ? (l.anchor_taxa as Array<Record<string, unknown>>) : [];
	return {
		alpha: Number(l.alpha),
		r: Number(l.temporal_r),
		r2: Number(l.temporal_r2),
		n: Number((run?.record?.taxa_count as number) ?? anchors.length),
		anchors: anchors.map((a) => ({ taxon: String(a.taxon), weight: Number(a.weight), date: Number(a.date) }))
	};
}

/**
 * Which clock model the curvature test chose, what that model says, and why the headline above is
 * not it. Plain `.note`, never a warning: web/DESIGN.md §5 sets caveats in the results' own voice,
 * and a test that ran and reported its answer is not a caveat at all.
 *
 * THE THREE SENTENCES THAT DO GET THE WARNING TREATMENT are the ones that change how every other
 * number on the page must be read: `divergence` when the mode is latent (the y axis stopped being a
 * sequence distance), `modeShift` (the ordinary fit moved and its arithmetic did not), and
 * `predictionCaveat` (a column of dates that are not dates). That is the page's rule — orange for
 * what changes the answer — and it is narrower than "anything surprising".
 */
export function clockNote(run: DatingResult, units: TimeUnits): string | null {
	const spline = modelOf(run, 'spline');
	if (!spline) return null;
	const preferred = spline.is_nonlinear_preferred === true;
	const f = n(spline, 'f_stat');
	const p = n(spline, 'p_f_test');
	const daic = n(spline, 'delta_aic');
	const df = n(spline, 'n') - 3;
	// DATING Q10. `dating.py:2844` hands the spline the model's covariance the moment the model
	// runs, so the same curvature test on the same divergences is a generalised fit here and an
	// ordinary one in a model-free run. On korber's TN93 divergences that moves its ancestor date
	// from 1938.77 to 1864.55 and flips `is_nonlinear_preferred` from true to false — the test's
	// ANSWER changes, not only its numbers — so the clause has to be in the sentence that reports it.
	const gls = modelRan(run) ? ' The test was fitted against the model’s covariance, not against independent residuals, so it is a generalised fit here and an ordinary one in a model-free run; the two are not comparable.' : '';
	if (!preferred) {
		return (
			`The automatic clock test looked for curvature and did not find enough to prefer it: ` +
			`F = ${num(f)} on 1 and ${df} d.f., p = ${num(p, 4)}, ΔAIC = ${signed(daic)}. The straight line is ` +
			`the model the test kept.${gls}`
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
		`argued with.${gls}`
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
			name: MODEL_NAMES.ols,
			date: yr(n(ols, 't_mrca')),
			interval: `${intervalText(pair(ols, ciKey(run)), units)} (${method})`,
			rate: sci(n(ols, 'mu')),
			r2: num(n(ols, 'r2'), 3),
			note: null,
			built: true
		}
	];
	// The generalised fit sits directly under the ordinary one because the pair is the comparison a
	// reader is being asked to make: same response vector, same design matrix, one of them told that
	// closely related sequences are not independent observations.
	const pgls = modelOf(run, 'pgls');
	if (pgls) {
		const g = n(pgls, 'fieller_g');
		const lam = n(pgls, 'pagel_lambda');
		const attenuated = run.warnings.some((w) => w.code === 'DATING_CLADE_ATTENUATED');
		const notes: string[] = [];
		if (Number.isFinite(lam)) notes.push(`Pagel λ* = ${num(lam, 4)}`);
		if (Number.isFinite(g) && g >= 1) notes.push(`slope not distinguishable from zero (Fieller g = ${num(g)} ≥ 1)`);
		if (attenuated) notes.push('clade attenuated: kept out of the headline and out of the averaged row');
		rows.push({
			name: MODEL_NAMES.pgls,
			date: yr(n(pgls, 't_mrca')),
			interval: `${intervalText(pair(pgls, ciKey(run)), units)} (${method})`,
			rate: sci(n(pgls, 'mu')),
			r2: num(n(pgls, 'r2'), 3),
			note: notes.join('; ') || null,
			built: true
		});
	}
	if (spline) {
		const degenerate = (() => {
			const ci = pair(spline, 'ci_mrca');
			return Boolean(ci && ci[0] === ci[1]);
		})();
		rows.push({
			name: MODEL_NAMES.spline,
			date: yr(n(spline, 't_mrca')),
			interval: degenerate
				? 'not computed — the reference’s bootstrap raises on every replicate, so its interval collapses to the point estimate'
				: intervalText(pair(spline, 'ci_mrca'), units),
			rate: sci(n(spline, 'rate_ancestral')),
			r2: num(n(spline, 'r2'), 3),
			note: [
				spline.is_nonlinear_preferred === true ? 'the model the curvature test selected' : 'tested and not preferred',
				modelRan(run) ? 'fitted against the model’s covariance (dating.py:2844), so not the spline a model-free run draws' : null
			]
				.filter(Boolean)
				.join('; '),
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

/**
 * WHY THE THREE ESTIMATES DIFFER, IN THIS RUN'S OWN NUMBERS — the paragraph that replaces averaging
 * them.
 *
 * The reference's record presents them side by side and says nothing about the relationship; its
 * `selected_clock` sentence names a winner without naming a margin, and its `ensemble` block
 * averages whichever of them happen to have an interval with width. Neither is an explanation. What
 * a reader needs is the size of the disagreement and its cause, and on this pillar the cause is
 * always one of three things, all of them readable off the record:
 *
 *   1. THE GENERALISED FIT DEFLATED THE RATE. `mu_pgls / mu_ols` is the reference's own `attr`
 *      (dating.py:2884), and when the fit is clade attenuated the same test bars it from the
 *      averaged row as well, so a record can carry a fit that appears in neither.
 *   2. THE GENERALISED FIT'S SLOPE IS NOT DISTINGUISHABLE FROM ZERO. Fieller g >= 1 gives an
 *      interval with no lower bound, and the reference then prefers the ordinary fit
 *      (dating.py:2969-2971). On korber under latent divergences that is exactly what happens:
 *      g = 1.72 against the ordinary fit's 0.173.
 *   3. THE CURVATURE TEST PREFERRED A SPLINE WHOSE INTERVAL IS DEAD. Phase 3's own case.
 *
 * Returns null on a model-free run with no spline, where there is only one estimate and nothing to
 * reconcile.
 */
export function agreementNote(run: DatingResult, units: TimeUnits): string | null {
	const head = headlineOf(run);
	if (!head) return null;
	const ols = modelOf(run, 'ols');
	const pgls = modelOf(run, 'pgls');
	const spline = modelOf(run, 'spline');
	const dates: Array<{ key: ModelKey; t: number }> = [];
	for (const key of ['ols', 'pgls', 'spline'] as ModelKey[]) {
		const m = key === 'ols' ? ols : key === 'pgls' ? pgls : spline;
		const t = n(m, 't_mrca');
		if (m && Number.isFinite(t)) dates.push({ key, t });
	}
	if (dates.length < 2) return null;

	const lo = dates.reduce((a, b) => (a.t <= b.t ? a : b));
	const hi = dates.reduce((a, b) => (a.t >= b.t ? a : b));
	const word = unitWord(units);
	const parts: string[] = [
		`The ${dates.length} fits below do not agree, and the page does not average them: they span ` +
			`${yr(lo.t)} to ${yr(hi.t)}, ${num(hi.t - lo.t, 1)} ${word}s apart.`
	];

	if (pgls && ols) {
		const attr = n(pgls, 'mu') / n(ols, 'mu');
		const g = n(pgls, 'fieller_g');
		parts.push(
			`${MODEL_SHORT.pgls[0].toUpperCase()}${MODEL_SHORT.pgls.slice(1)} is the same straight line told that ` +
				`closely related sequences are not independent observations: its errors are correlated by a covariance ` +
				`built from the model's own cross-taxa attention and per-taxon embeddings, with Pagel's ` +
				`λ* = ${num(n(pgls, 'pagel_lambda'), 4)} estimated by profile REML. It puts the clock at ` +
				`${sci(n(pgls, 'mu'))} against the ordinary fit's ${sci(n(ols, 'mu'))}` +
				(Number.isFinite(attr) && attr > 0 && attr < 1 ? `, ${num(1 / attr, 1)} times slower` : '') +
				`, and explains ${num(n(pgls, 'r2'), 3)} of the variance against ${num(n(ols, 'r2'), 3)}.`
		);
		if (run.warnings.some((w) => w.code === 'DATING_CLADE_ATTENUATED')) {
			parts.push(
				`That deflation with a worse fit is the reference's clade-attenuation signature — a sample whose ` +
					`phylogenetic structure and whose sampling dates are confounded, so the generalised fit attributes the ` +
					`temporal signal to shared ancestry. It is disqualified from the headline AND from the averaged row ` +
					`(dating.py:2884-2891, :2905), which is why it can appear in neither.`
			);
		} else if (Number.isFinite(g) && g >= 1) {
			parts.push(
				`Its slope is not distinguishable from zero at 95 % (Fieller g = ${num(g)} ≥ 1), so its interval has no ` +
					`lower bound and its ancestor ${units === 'years' ? 'date' : 'time'} of ${yr(n(pgls, 't_mrca'))} is not ` +
					`one you can argue with. The ordinary fit answers, and that is the reference's own rule ` +
					`(dating.py:2969-2971), not this page's preference.`
			);
		}
	}

	if (head.departed) {
		const active = head.activeKey;
		parts.push(
			`The reference selected ${MODEL_SHORT[active]} and this page quotes ${MODEL_SHORT[head.key]} instead, for ` +
				`one reason: ${MODEL_SHORT[active]}'s 95 % interval is its point estimate repeated, because its bootstrap ` +
				`raises on every replicate upstream. An estimate that cannot be argued with is not the one to headline.`
		);
	} else if (head.key !== 'ols' && ols) {
		parts.push(
			`The reference selected ${MODEL_SHORT[head.key]} and the ${ancestorWord(units)} above is therefore the same ` +
				`number the command line prints as \`t_mrca\`; the ordinary fit's ${yr(n(ols, 't_mrca'))} is in the table ` +
				`below, not hidden behind it.`
		);
	}
	return parts.join(' ');
}

/**
 * The one line a reader needs when the model is switched on and the ORDINARY fit moves — which is
 * the most surprising thing in this phase, because nothing about that estimator changed. Its input
 * did: `--distance-mode auto` swaps TN93 distances for the latent root's. Measured on the flagship
 * example, 1893.9 becomes 1926.8 and the rate halves.
 *
 * It compares two runs the reader made in this session; there is no stored history and no attempt
 * to reconstruct one, because a comparison between a run you watched and a run you did not is not a
 * comparison a page should make for you.
 */
export function modeShiftSentence(
	current: DatingResult | null,
	prior: DatingResult | null,
	units: TimeUnits
): string | null {
	if (!current?.ok || !prior?.ok) return null;
	const a = distanceModeOf(prior);
	const b = distanceModeOf(current);
	if (a === b) return null;
	const before = modelOf(prior, 'ols');
	const after = modelOf(current, 'ols');
	const t0 = n(before, 't_mrca');
	const t1 = n(after, 't_mrca');
	if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
	const name = (mode: 'tn93' | 'latent') => (mode === 'latent' ? 'the latent root' : 'TN93 distances');
	return (
		`The ordinary fit moved from ${yr(t0)} to ${yr(t1)} — ${num(Math.abs(t1 - t0), 1)} ${unitWord(units)}s — between ` +
		`your last two runs, and its arithmetic did not change. Its INPUT did: divergence was measured to ` +
		`${name(a)} and is now measured to ${name(b)}, and the rate went from ${sci(n(before, 'mu'))} to ` +
		`${sci(n(after, 'mu'))}. The two are not one estimator disagreeing with itself; they are two response ` +
		`vectors.`
	);
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
		units,
		headline: 'ols',
		activeModel: (String(run.record.active_model ?? 'ols') as ModelKey) || 'ols',
		selectedClock: run.selectedClock ?? '',
		modelRan: modelRan(run),
		distanceMode: distanceModeOf(run),
		divergence: '',
		agreement: null,
		latent: latentRootView(run)
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
		// The ordinary fit is the floor: if IT has no answer, nothing above it does either, whichever
		// model the reference selected. A generalised fit on the same failed response vector is not a
		// second opinion, and offering one would be the plausible wrong number this pillar exists to
		// avoid.
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
	const head = headlineOf(run);
	const ci = pair(head?.model ?? ols, ciKey(run));
	return {
		...base,
		ok: true,
		verdict: verdictSentence(run, units),
		counts: countsSentence(run),
		holdout: holdoutSentence(run, units),
		stats: statEntries(run, units),
		estimators: estimatorRows(run, units),
		clockNote: clockNote(run, units),
		unbounded: isUnbounded(ci),
		headline: head?.key ?? 'ols',
		divergence: divergenceSentence(run, units),
		agreement: agreementNote(run, units)
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
	// The line and the bracket are the HEADLINE fit's, so the figure and the sentence above it
	// cannot quote different numbers. The points and the curve are the ACTIVE model's, because
	// `fitted_divergence` in the record is computed from whichever model the reference selected.
	const head = headlineOf(run);
	const ols = head?.model ?? modelOf(run, 'ols');
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
