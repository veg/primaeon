/**
 * temporal.ts — the view model of `/time` section 5: what a `TemporalRecord` LOOKS like to a
 * reader, in pure functions the components only render.
 *
 * WHY THIS FILE EXISTS. `runtime/src/temporal/` decides every number and every diagnostic message;
 * this file decides the words around them — which rows a table shows and in what order, which
 * trajectories a figure can afford to draw, what "CONFIRMED_SWEEP" is called in English, and which
 * sentences must be printed because the reference's own output cannot say them. `web/` has no
 * component-test harness, so everything that could be wrong lives here and is driven by
 * `temporal.test.ts`; the `.svelte` files below it hold markup and a scale function and nothing
 * else. That is the split `dating.ts` / `DatingSection.svelte` already established on this route.
 *
 * THE THREE THINGS THIS PAGE MUST SAY THAT `hyphaeon temporal` DOES NOT, and which are therefore
 * functions here rather than prose in a component:
 *
 *   1. THE PERMUTATION P-VALUE COMES FROM A DIFFERENT GENERATOR. The reference draws from numpy's
 *      Mersenne Twister at a hard-coded `RandomState(42)` (temporal.py:651); the library uses
 *      per-draw xoshiro256** substreams by design (D17). So `p_perm`, `q_perm`, the sweep label and
 *      both classification columns agree with a command-line run IN DISTRIBUTION, not digit for
 *      digit, and a site whose p sits within three Monte-Carlo standard errors of the cut can land
 *      either side of it. `borderlineBand` is that number and `isBorderline` is that test; the
 *      table marks those rows rather than letting a reader read 0.0495 and 0.0594 as different
 *      kinds of answer.
 *   2. A WAVE'S SIGN IS A CONVENTION. Right singular vectors are defined up to sign and the
 *      reference has no rule, so it writes its solver's raw signs (D28). This page's canonical rule
 *      — largest-magnitude entry positive, applied before the loadings are derived — means a curve
 *      here may be a command-line run's curve upside down, with its `Wave_k_loading` column negated
 *      and nothing else different. `honestyNotes` prints that beside the figure and beside the
 *      download.
 *   3. OUR DATE LAYER IS WIDER THAN THE REFERENCE'S PARSER. `runtime/src/dates/` is the union of
 *      all three upstream parsers (D31), so a run here can be over a different set of sequences
 *      than `hyphaeon temporal` would use — on the Korber alignment the reference dates none of 143
 *      headers and we date 142. The record carries `dates.beyond_reference`; `honestyNotes` says so
 *      and `temporalReferenceCommand` (runtime) marks the printed command as not reproducing.
 *
 * THE COST SENTENCE IS AN UPPER BOUND, AND SAYS SO. Before stage one has run, the candidate count
 * is unknowable, and so is `nnz` — the number of (codon, sequence) pairs that actually carry a
 * non-root residue, which is what the null's kernel multiplies (`runtime/src/temporal/null.js`
 * measured rho = 0.043 on the acceptance alignment, so the real cost is usually a twentieth of the
 * bound). `nullCeiling` therefore substitutes the two ceilings a reader can check — every variable
 * codon is a candidate, every dated sequence carries the derived residue — and the page replaces it
 * with the run's own measured figures the moment the first payload lands.
 */

import { readsAs } from './dateReview';
import { num, sci, yr } from './dating';
import type { TimeUnits } from './types';

const EM_DASH = '—';

/**
 * How many uncalled trajectories Figure 4 will draw. 300 one-pixel polylines is about 300 DOM nodes
 * and 18,000 coordinate pairs at T = 60 — well inside what an inline SVG renders without a canvas —
 * and beyond a few hundred overlapping grey lines the figure stops being read as individual
 * trajectories anyway. Confirmed sweeps are NEVER subject to this cap; the caption says how many of
 * how many are drawn whenever it bites.
 */
export const TEMPORAL_MAX_TRAJECTORIES = 300;

/** Rows in Figure 5's waterfall. Each is 22 px tall, so 24 is a 530 px figure. */
export const TEMPORAL_MAX_RIDGES = 24;

/** Rows the per-site table shows per page. */
export const TEMPORAL_PAGE_SIZE = 40;

/**
 * The sequence cap this page runs at, and the reason it is the report's own (`REPORT_DEFAULTS`,
 * `runtime/src/analyze.js:107` — the manifest's `default_taxon_cap`) rather than something looser.
 * Above it the library reduces the alignment by Faith's phylogenetic diversity, which is TIME-BLIND
 * (D27) and can remove the early part of an epidemic — exactly the part a sweep is measured
 * against — so a downsampled run is not comparable with a command-line run on the whole file.
 * `honestyNotes` says so whenever `primaeon.taxon_cap` reports that it bit.
 */
export const TEMPORAL_MAX_SPECIES = 256;

// =================================================================================================
// The record, as it reaches the page
// =================================================================================================

export interface TemporalPermutations {
	requested: number;
	completed: number;
	cancelled: boolean;
	skipped: boolean;
	grid_step: number;
	q_min: number | null;
	q_rank1_bound: number | null;
	rounds: number[];
	work: number;
	budget: number;
	within: boolean;
	nnz: number;
	reason: string | null;
	estimator: string;
	rng: string;
	seed: number;
	chunks: number;
	ms_per_draw: number | null;
	tested: boolean;
}

export interface TemporalWaves {
	count: number;
	data: Float64Array;
	time: Float64Array;
	var_explained: number[];
	sigma: number[];
	gaps: number[];
	near_degenerate: boolean[];
	rank_deficient: boolean[];
	gap_threshold: number;
	sign: string;
	source_sites: number[];
	source: string;
}

export interface TemporalSites {
	count: number;
	site: Int32Array;
	ref_aa: string[];
	derived_aa: string[];
	mutation_label: string[];
	domain: string[];
	classification: string[] | null;
	cross_classification: string[] | null;
	is_confirmed_sweep: Uint8Array;
	is_concordant_sweep: Uint8Array;
	is_rescued_sweep: Uint8Array;
	lrt: Float32Array;
	p_static: Float64Array;
	q_static: Float32Array;
	p_perm: Float32Array;
	q_perm: Float32Array;
	r2_fpca: Float32Array;
	peak_date: Float64Array;
	peak_intensity: Float64Array;
	t_half_start: Float32Array;
	t_half_end: Float32Array;
	fwhm_years: Float32Array;
	mean_intensity: Float64Array;
	auc: Float64Array;
	wave_loadings: Float32Array;
	scored: Uint8Array;
	invariable: Uint8Array;
	stage1: Uint8Array;
	peak_at_first_grid_point: Uint8Array;
}

export interface TemporalWarning {
	code: string;
	severity: string;
	message: string;
	data?: unknown;
}

/** The fields of `runtime/src/temporal/record.js` this page reads. */
export interface TemporalRecord {
	ok: true;
	stage: 'scored' | 'null' | 'complete';
	complete: boolean;
	alignment: string | null;
	tree: string | null;
	taxa_total: number;
	taxa_timestamped: number;
	codons_total: number;
	codons_variable: number;
	codons_invariable: number;
	timespan_years: number;
	t_min: number;
	t_max: number;
	bandwidth_years: number;
	sig_static_q10: number;
	stage1_candidates: number;
	confirmed_sweeps: number;
	concordant_sweeps: number;
	rescued_sweeps: number;
	filtered_static_noise: number;
	fpca_wave_variance_pct: number[];
	runtime_sec: number;
	sites: TemporalSites;
	curves: { T: number; time: Float64Array; prevalence: Float64Array; velocity: Float64Array };
	waves: TemporalWaves | null;
	candidates: number[];
	permutations: TemporalPermutations | null;
	escape_hatch_used: boolean;
	solitary_regime: boolean;
	gate_vacuous: boolean;
	regime: { time_units: TimeUnits; sweep_mode: string; non_calendar: boolean; unit_label: string; prune_duplicates: boolean };
	grid: { time_points: number; t_min: number; t_max: number; step: number };
	floors: {
		tau_peak: number;
		tau_auc: number;
		tau_peak_overridden: boolean;
		tau_auc_defaulted: boolean;
		perm_alpha: number;
		min_r2_fpca: number;
		q_static_cut: number;
	};
	root: { source: string; taxon: string | null; window: number; early_indices: number[] };
	dates: {
		dated: number;
		undated: number;
		source: string | null;
		by_rule: Record<string, number> | null;
		beyond_reference: { count: number; rules: Record<string, number> } | null;
		taxa: string[];
		values: number[];
		span: { min: number; max: number; span: number; unique: number };
	};
	warnings: TemporalWarning[];
	primaeon: Record<string, unknown> & { score_invariable_sites?: boolean; scored_codons?: number; taxon_cap?: string | null };
}

/** What `runTemporal` returns when it will not run at all; never thrown (runtime `codes.js`). */
export interface TemporalRefusal {
	ok: false;
	refusal: string;
	message: string;
	warnings: TemporalWarning[];
}

/** The state this section is in, and the one the components switch on. */
export type TemporalState = 'blocked' | 'offered' | 'running' | 'landed' | 'refused';

// =================================================================================================
// The gate: can this pillar be offered at all
// =================================================================================================

export interface TemporalGate {
	ok: boolean;
	reasons: string[];
}

/**
 * The reference's own two refusals, checked before the button rather than after the model pass:
 * fewer than five dated sequences (temporal.py:474-478) and a non-positive span (temporal.py:483).
 * Section 1's own gate is checked first, because a run on dates the reader has not accepted would
 * be a run on the wrong sequences.
 *
 * @param dated how many sequences carry a date
 * @param span the time span those dates cover, or null
 * @param sectionOneReady section 1's `readyGate().ready`
 * @param sectionOneReasons section 1's reasons, quoted rather than re-worded
 */
export function temporalGate(
	dated: number,
	span: { span: number } | null,
	sectionOneReady: boolean,
	sectionOneReasons: string[] = []
): TemporalGate {
	const reasons: string[] = [];
	if (!sectionOneReady) reasons.push(...(sectionOneReasons.length ? sectionOneReasons : ['The dates are not ready yet.']));
	if (dated < 5) {
		reasons.push(
			`Temporal selection needs at least 5 dated sequences and this alignment has ${dated}. ` +
				'That floor is the reference\'s own (temporal.py:474).'
		);
	}
	if (span && !(span.span > 0)) {
		reasons.push('Every dated sequence carries the same time coordinate, so there is no time axis to smooth along.');
	}
	return { ok: reasons.length === 0, reasons };
}

// =================================================================================================
// The cost, before the run
// =================================================================================================

export interface NullCeiling {
	/** Multiply-adds, the bound with every variable codon a candidate and every sequence derived. */
	work: number;
	/** Seconds at the rate the runtime measured; a floor-machine figure, labelled as such. */
	seconds: number;
	B: number;
	C: number;
	T: number;
	N: number;
}

/**
 * The a-priori upper bound on the null, in the runtime's own units.
 *
 * `runtime/src/temporal/null.js` computes `W = B·C·T·(nnz/C + 21)` from the MEASURED number of
 * nonzero attribution entries. Before stage one there is no candidate set and no `nnz`, so both are
 * replaced by their ceilings: `C = codons_variable` (every variable codon passes the energy floor)
 * and `nnz/C = N` (every dated sequence carries a non-root residue at every one of them). On the
 * acceptance alignment the measured density was 0.043, so the bound over-states by roughly twenty
 * times — which is the right direction for a number a reader is asked to wait on.
 */
export function nullCeiling({ B, C, T, N, rate = 9.0e8 }: { B: number; C: number; T: number; N: number; rate?: number }): NullCeiling {
	const work = B > 0 && C > 0 && T > 0 ? B * C * T * (N + 21) : 0;
	return { work, seconds: rate > 0 ? work / rate : 0, B, C, T, N };
}

/** "1.3 × 10⁹" for a big count, "9,700" for a small one. */
export function bigNumber(value: number): string {
	if (!Number.isFinite(value)) return EM_DASH;
	if (value === 0) return '0';
	return Math.abs(value) >= 1e6 ? sci(value, 2) : Math.round(value).toLocaleString('en-US');
}

/** "about 40 seconds", "about 2 minutes", "under a second". */
export function duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'no time at all';
	if (seconds < 1) return 'under a second';
	if (seconds < 90) return `about ${Math.round(seconds)} second${Math.round(seconds) === 1 ? '' : 's'}`;
	const minutes = seconds / 60;
	const shown = minutes < 10 ? Number(minutes.toFixed(1)) : Math.round(minutes);
	return `about ${shown} minutes`;
}

/**
 * The number of codons this alignment can hold, read off the first sequence. It is a CEILING and is
 * used as one: before a run there is no candidate count, no variable count and no `nnz`, so the cost
 * paragraph substitutes the only quantity a reader can check for themselves. FASTA only — a NEXUS or
 * PHYLIP matrix returns null and the copy then names no number rather than guessing one.
 */
export function codonCeiling(alignmentText: string): number | null {
	if (!alignmentText || !alignmentText.trimStart().startsWith('>')) return null;
	const lines = alignmentText.split(/\r?\n/);
	let started = false;
	let width = 0;
	for (const line of lines) {
		if (line.startsWith('>')) {
			if (started) break;
			started = true;
			continue;
		}
		if (started) width += line.trim().length;
	}
	return width >= 3 ? Math.floor(width / 3) : null;
}

/**
 * The offer's cost paragraph, as sentences. The model pass is named in codons and sequences rather
 * than in seconds, because this build has measured it in Node and not in a browser and a number
 * measured somewhere else, printed without its provenance, is the thing this page exists to stop.
 * The null IS given a time, because it is bounded arithmetic and the bound is stated as one.
 */
export function costSentences(args: {
	codons: number | null;
	dated: number;
	timePoints: number;
	draws: number;
	scoreInvariable: boolean;
}): string[] {
	const { codons, dated, timePoints, draws, scoreInvariable } = args;
	const where = codons == null ? 'every codon of your alignment' : `all ${codons.toLocaleString('en-US')} codons`;
	const ceiling = codons == null ? null : nullCeiling({ B: draws, C: codons, T: timePoints, N: dated });
	return [
		`The model scores ${scoreInvariable ? where : 'every variable codon'} once, over ` +
			`${dated.toLocaleString('en-US')} dated sequence${dated === 1 ? '' : 's'}` +
			(scoreInvariable
				? ', the invariable ones included — which is what `hyphaeon temporal` does (temporal.py:512), and what makes the ' +
					'downloads below diffable against it.'
				: '; the invariable ones are skipped, so their static LRT and p-value come back empty rather than scored.') +
			' Nothing re-enters the graph after that: the trajectories, the null and the wave modes are all arithmetic over that one pass.',
		`The null is the only part that grows with the number of draws, and it is the product of four numbers: ` +
			`draws × candidate codons × dated sequences × grid points. At most ${draws.toLocaleString('en-US')} × ` +
			`${codons == null ? 'C' : codons.toLocaleString('en-US')} × ${dated.toLocaleString('en-US')} × ${timePoints.toLocaleString('en-US')}` +
			(ceiling
				? `, so at most ${bigNumber(ceiling.work)} multiply-adds — ${duration(ceiling.seconds)} at the rate this build ` +
					'measured on its own development machine, which is a floor for a browser rather than a promise.'
				: '.') +
			' Both counts are ceilings: most codons do not pass the sweep-energy floor, and most sequences carry the root residue ' +
			'at most codons, which the kernel skips — on the reference\'s own demo alignment that made the null twenty times ' +
			'cheaper than this bound. The exact figure replaces this one as soon as the first stage has counted the candidates, ' +
			'and you can stop at any point and keep what has finished.',
		'Section 4 is worth reading first. A sequence whose date disagrees with its divergence moves every trajectory, not ' +
			'just its own row. This pillar reads section 1\'s dates; sequences you excluded from the ancestor-date fit are ' +
			'not excluded here.'
	];
}

/** What the run actually cost, once it has one — measured, never modelled. */
export function costMeasured(record: TemporalRecord): string {
	const perm = record.permutations;
	const scored = (record.primaeon.scored_codons as number) ?? record.codons_total;
	const parts = [
		`${scored.toLocaleString('en-US')} codon${scored === 1 ? '' : 's'} scored over ${record.taxa_timestamped.toLocaleString('en-US')} ` +
			`dated sequence${record.taxa_timestamped === 1 ? '' : 's'}, ${record.stage1_candidates.toLocaleString('en-US')} candidate` +
			`${record.stage1_candidates === 1 ? '' : 's'} past the energy floor`
	];
	if (perm && perm.completed > 0) {
		parts.push(
			`${perm.completed.toLocaleString('en-US')} shuffle${perm.completed === 1 ? '' : 's'} in ${perm.chunks} chunk` +
				`${perm.chunks === 1 ? '' : 's'}` +
				(perm.ms_per_draw ? ` at ${num(perm.ms_per_draw, 2)} ms a draw` : '') +
				` over ${perm.nnz.toLocaleString('en-US')} nonzero attribution entries`
		);
	} else if (perm?.skipped) {
		parts.push('the null was not run');
	}
	parts.push(`${num(record.runtime_sec, 1)} s in all`);
	return `${parts.join('; ')}.`;
}

// =================================================================================================
// The vocabulary: the engine's enum strings, in a reader's words
// =================================================================================================

export interface Wording {
	word: string;
	sentence: string;
}

/** `classification` — what the dates alone say (temporal.py:700-716). */
export const CLASSIFICATION_WORDS: Record<string, Wording> = {
	CONFIRMED_SWEEP: {
		word: 'Swept',
		sentence: 'The signal rises and falls in time, and shuffling the dates reproduced that shape in fewer than 5 % of draws.'
	},
	TEMPORAL_NOISE: {
		word: 'Tested, not confirmed',
		sentence: 'It moved enough to be worth testing; shuffling the dates reproduced it too often.'
	},
	FLAT_NO_SIGNAL: {
		word: 'Flat',
		sentence: 'Variable, but the signal never moves enough in time to be worth testing.'
	},
	INVARIABLE: {
		word: 'Not scored',
		sentence: 'One residue in every sequence, so there is nothing to track.'
	}
};

/** `cross_classification` — what it adds to the ordinary static scan. */
export const CROSS_WORDS: Record<string, Wording> = {
	CONCORDANT_SWEEP: { word: 'Both agree', sentence: 'Called by the static scan at q ≤ 0.10 and confirmed here.' },
	RESCUED_SWEEP: { word: 'Found only in time', sentence: 'The static scan does not call it; using the dates does.' },
	FILTERED_STATIC_NOISE: { word: 'Static only', sentence: 'The static scan calls it, but nothing about it moves in time.' },
	NEGATIVE_CONSENSUS: { word: 'Neither', sentence: 'Neither scan calls it.' }
};

/** The words a row takes when the null did not run: never "not a sweep" (web/DESIGN.md §5). */
export const UNTESTED_WORD = 'not tested';

// =================================================================================================
// The table
// =================================================================================================

export type TemporalCall = 'swept' | 'tested' | 'flat' | 'not-scored' | 'not-tested';

export interface TemporalSiteRow {
	site: number;
	label: string;
	refAa: string;
	derivedAa: string;
	domain: string;
	classification: string;
	cross: string;
	call: TemporalCall;
	callWord: string;
	crossWord: string;
	peakDate: number;
	peakAtFirst: boolean;
	fwhm: number;
	peakIntensity: number;
	meanIntensity: number;
	auc: number;
	tHalfStart: number;
	tHalfEnd: number;
	lrt: number;
	pStatic: number;
	qStatic: number;
	pPerm: number;
	qPerm: number;
	r2: number;
	waves: number[];
	borderline: boolean;
	isCandidate: boolean;
	isSweep: boolean;
	scored: boolean;
}

/**
 * Three standard errors of a Monte-Carlo p at the call threshold. Two estimates of the same p agree
 * within this; a site inside it can land either side of the cut purely on which generator drew the
 * shuffles, which is why the table marks those rows instead of printing two numbers that look
 * categorically different. MEASURED on the acceptance run at B = 100: the band is ±0.065 and eleven
 * of 246 candidates sit within ONE draw (1/101) of the cut.
 */
export function borderlineBand(B: number, alpha = 0.05): number {
	if (!(B > 0)) return Infinity;
	return 3 * Math.sqrt((alpha * (1 - alpha)) / B);
}

export function isBorderline(p: number, B: number, alpha = 0.05): boolean {
	if (!Number.isFinite(p) || !(B > 0)) return false;
	return Math.abs(p - alpha) <= borderlineBand(B, alpha);
}

/**
 * One row per codon, over the whole record or over the candidates alone.
 *
 * A row is built, never stored: `record.sites` is 27 parallel typed arrays precisely so a quarter
 * of a million row objects never exist (`runtime/src/temporal/record.js`), and this is the one
 * place the page turns some of them into objects.
 */
export function siteRows(record: TemporalRecord, which: 'candidates' | 'all' | 'sweeps' = 'candidates'): TemporalSiteRow[] {
	const c = record.sites;
	const tested = record.permutations?.tested ?? false;
	const B = record.permutations?.completed ?? 0;
	const alpha = record.floors.perm_alpha;
	const indices: number[] =
		which === 'all'
			? Array.from({ length: record.codons_total }, (_, i) => i)
			: which === 'sweeps'
				? Array.from(record.candidates, (site) => site - 1).filter((s) => c.is_confirmed_sweep[s] === 1)
				: Array.from(record.candidates, (site) => site - 1);

	return indices.map((s) => {
		const classification = c.classification?.[s] ?? (c.invariable[s] ? 'INVARIABLE' : c.stage1[s] ? 'TEMPORAL_NOISE' : 'FLAT_NO_SIGNAL');
		const cross = c.cross_classification?.[s] ?? 'NEGATIVE_CONSENSUS';
		const isCandidate = c.stage1[s] === 1;
		const untested = isCandidate && !tested;
		const call: TemporalCall = untested
			? 'not-tested'
			: classification === 'CONFIRMED_SWEEP'
				? 'swept'
				: classification === 'TEMPORAL_NOISE'
					? 'tested'
					: classification === 'FLAT_NO_SIGNAL'
						? 'flat'
						: 'not-scored';
		const pPerm = c.p_perm[s];
		return {
			site: c.site[s],
			label: c.mutation_label[s],
			refAa: c.ref_aa[s],
			derivedAa: c.derived_aa[s],
			domain: c.domain[s],
			classification,
			cross,
			call,
			callWord: untested ? UNTESTED_WORD : (CLASSIFICATION_WORDS[classification]?.word ?? classification),
			crossWord: untested ? UNTESTED_WORD : (CROSS_WORDS[cross]?.word ?? cross),
			peakDate: c.peak_date[s],
			peakAtFirst: c.peak_at_first_grid_point[s] === 1,
			fwhm: c.fwhm_years[s],
			peakIntensity: c.peak_intensity[s],
			meanIntensity: c.mean_intensity[s],
			auc: c.auc[s],
			tHalfStart: c.t_half_start[s],
			tHalfEnd: c.t_half_end[s],
			lrt: c.lrt[s],
			pStatic: c.p_static[s],
			qStatic: c.q_static[s],
			pPerm,
			qPerm: c.q_perm[s],
			r2: c.r2_fpca[s],
			waves: [c.wave_loadings[s * 4], c.wave_loadings[s * 4 + 1], c.wave_loadings[s * 4 + 2], c.wave_loadings[s * 4 + 3]],
			borderline: isCandidate && tested && isBorderline(pPerm, B, alpha),
			isCandidate,
			isSweep: c.is_confirmed_sweep[s] === 1,
			scored: c.scored[s] === 1
		};
	});
}

export type TemporalSortKey =
	| 'default'
	| 'site'
	| 'peakDate'
	| 'fwhm'
	| 'peakIntensity'
	| 'lrt'
	| 'qStatic'
	| 'pPerm'
	| 'wave1';

/**
 * The default order, and the one Figure 5's rows share so the two read together: confirmed sweeps
 * first by peak date ascending, then the remaining candidates by permutation p ascending, then by
 * codon. A NaN p (a candidate the null never reached) sorts after every number rather than to the
 * top, where it would read as the strongest result on the page.
 */
export function sortRows(rows: TemporalSiteRow[], key: TemporalSortKey, ascending: boolean): TemporalSiteRow[] {
	const out = [...rows];
	if (key === 'default') {
		out.sort((a, b) => {
			if (a.isSweep !== b.isSweep) return a.isSweep ? -1 : 1;
			if (a.isSweep && b.isSweep) return a.peakDate - b.peakDate || a.site - b.site;
			return cmpNumber(a.pPerm, b.pPerm) || a.site - b.site;
		});
		return out;
	}
	const pick = (r: TemporalSiteRow): number =>
		key === 'site'
			? r.site
			: key === 'peakDate'
				? r.peakDate
				: key === 'fwhm'
					? r.fwhm
					: key === 'peakIntensity'
						? r.peakIntensity
						: key === 'lrt'
							? r.lrt
							: key === 'qStatic'
								? r.qStatic
								: key === 'pPerm'
									? r.pPerm
									: r.waves[0];
	out.sort((a, b) => {
		// NaN is "not measured", not "smallest" or "largest": it sorts last in BOTH directions, so
		// reversing a column never floats an untested codon to the top of the page.
		const av = pick(a);
		const bv = pick(b);
		const an = !Number.isFinite(av);
		const bn = !Number.isFinite(bv);
		if (an || bn) return an && bn ? a.site - b.site : an ? 1 : -1;
		const d = av - bv;
		return (ascending ? d : -d) || a.site - b.site;
	});
	return out;
}

/** NaN last, always, whichever direction the column is sorted. */
function cmpNumber(a: number, b: number): number {
	const an = !Number.isFinite(a);
	const bn = !Number.isFinite(b);
	if (an && bn) return 0;
	if (an) return 1;
	if (bn) return -1;
	return a - b;
}

// =================================================================================================
// Formatting
// =================================================================================================

/** A peak date, or an em dash when the velocity row was identically zero (upstream `argmax` of 0). */
export function peakDateText(row: TemporalSiteRow, units: TimeUnits): string {
	if (row.peakAtFirst || !Number.isFinite(row.peakDate)) return EM_DASH;
	return units === 'years' ? readsAs(row.peakDate, units) : yr(row.peakDate, 2);
}

/** A p or q value: four decimals down to 1e-4, scientific below, an em dash for NaN. */
export function pText(value: number): string {
	if (!Number.isFinite(value)) return EM_DASH;
	if (value === 0) return '0';
	return value < 1e-4 ? sci(value, 3) : value.toFixed(4);
}

/** An energy (peak intensity, area): these run to 1e-5, so scientific unless they are of order 1. */
export function energyText(value: number): string {
	if (!Number.isFinite(value)) return EM_DASH;
	if (value === 0) return '0';
	return Math.abs(value) >= 0.01 ? num(value, 4) : sci(value, 3);
}

/** A width, in the run's own unit label. */
export function widthText(value: number, unitLabel: string): string {
	if (!Number.isFinite(value) || value === 0) return EM_DASH;
	return `${num(value, 3)} ${unitLabel}`;
}

// =================================================================================================
// The lede and the honest notes
// =================================================================================================

/** The finding, with the numbers inline, and then it stops (web/DESIGN.md §5). */
export function ledeSentence(record: TemporalRecord, units: TimeUnits): string {
	const tested = record.permutations?.tested ?? false;
	const C = record.stage1_candidates;
	const L = record.codons_total;
	if (!tested) {
		return (
			`${C.toLocaleString('en-US')} of ${L.toLocaleString('en-US')} codons passed the sweep-energy floor and are ` +
			`candidates; none has been tested against the shuffled dates, so none is confirmed or ruled out.`
		);
	}
	const n = record.confirmed_sweeps;
	if (n === 0) {
		return (
			`No codon of the ${C.toLocaleString('en-US')} candidates is confirmed: every one of them was reproduced too often ` +
			`by shuffling the dates, or failed the wave-alignment gate at R² ≥ ${record.floors.min_r2_fpca}.`
		);
	}
	const rows = sortRows(siteRows(record, 'sweeps'), 'default', true);
	const earliest = rows[0];
	const strongest = [...rows].sort((a, b) => cmpNumber(a.pPerm, b.pPerm))[0];
	const where = record.rescued_sweeps === n
		? `All ${n} are found only in time: the static scan calls nothing at q ≤ ${record.floors.q_static_cut} on this alignment.`
		: `${record.concordant_sweeps} of them are also called by the static scan at q ≤ ${record.floors.q_static_cut}; ${record.rescued_sweeps} are found only in time.`;
	return (
		`${n} of ${L.toLocaleString('en-US')} codons are confirmed sweeps, the earliest peaking at ` +
		`${peakDateText(earliest, units)} (${earliest.label}) and the strongest ${strongest.label} at p = ${pText(strongest.pPerm)}. ` +
		where
	);
}

export interface HonestyNote {
	id: string;
	lead: string;
	rest: string;
	warn: boolean;
}

/**
 * The sentences a reader comparing this page with a command-line run must see, in report order.
 * Everything the runtime already says in its own words is rendered from `record.warnings`; these
 * are the four the runtime cannot say because they are about what a READER will do with the numbers.
 */
export function honestyNotes(record: TemporalRecord): HonestyNote[] {
	const notes: HonestyNote[] = [];
	const perm = record.permutations;
	const B = perm?.completed ?? 0;

	notes.push({
		id: 'rng',
		lead: 'The permutation p-value comes from a different generator than the reference\'s.',
		rest:
			`Significance is estimated by shuffling the sample dates ${B ? B.toLocaleString('en-US') : 'B'} times. The shuffle uses this ` +
			`application's generator (${perm?.rng ?? 'xoshiro256**'}, seeded at ${perm?.seed ?? 42}), not \`hyphaeon temporal\`'s numpy ` +
			'Mersenne Twister, so the permutation p-value, its q-value and the sweep label agree with a command-line run ' +
			'in distribution, not digit for digit. Everything else here — the trajectories, velocities, peaks, widths and areas, ' +
			'and the static LRT and its p and q — is computed the same way and agrees to within float noise.',
		warn: false
	});

	if (B > 0) {
		const band = borderlineBand(B, record.floors.perm_alpha);
		const borderline = siteRows(record, 'candidates').filter((r) => r.borderline).length;
		notes.push({
			id: 'borderline',
			lead: `At ${B.toLocaleString('en-US')} shuffles, a p near ${record.floors.perm_alpha} carries about ±${num(band, 3)}.`,
			rest:
				`The smallest p this test can report is 1/(${B.toLocaleString('en-US')} + 1) = ${pText(perm!.grid_step)}, and ` +
				`${borderline} candidate${borderline === 1 ? '' : 's'} sit${borderline === 1 ? 's' : ''} within three standard errors of the ` +
				'cut. Those rows are marked borderline: they would land on either side of the threshold depending on which ' +
				'shuffles were drawn. Re-run with more shuffles to settle them.',
			warn: false
		});
	}

	if (perm && perm.q_min != null && perm.q_min > record.floors.q_static_cut) {
		notes.push({
			id: 'qperm',
			lead: 'The permutation q-value carries no decision here.',
			rest:
				`With ${record.stage1_candidates.toLocaleString('en-US')} candidate codons and ${B.toLocaleString('en-US')} shuffles, the ` +
				`smallest q Benjamini-Hochberg returned anywhere in this run is ${num(perm.q_min, 4)} — above the 0.10 a reader would ` +
				'test at. The sweep call is made on p (temporal.py:687-689) and the q column rides along in the table because the ' +
				'reference writes it.',
			warn: false
		});
	}

	if (record.waves && record.waves.count > 0) {
		notes.push({
			id: 'wave-sign',
			lead: 'A wave and its negative are the same mode.',
			rest:
				`The sign here is fixed by a convention this page states and \`hyphaeon temporal\` does not have (${record.waves.sign}: ` +
				'the element of largest magnitude is made positive, applied to the singular vector before the loadings are derived, so a ' +
				'wave and its loading column always flip together). A command-line run may therefore draw any of these curves upside ' +
				'down with the matching Wave column negated. No singular value, no variance share, no R² and no classification reads a sign.',
			warn: false
		});
	}

	const beyond = record.dates.beyond_reference;
	if (beyond && beyond.count > 0) {
		notes.push({
			id: 'beyond-reference',
			lead: `${beyond.count} of these dates were read by a rule \`hyphaeon temporal\` does not have.`,
			rest:
				`This page's date layer is the union of all three upstream parsers (${Object.keys(beyond.rules).join(', ')}); the temporal ` +
				'pillar\'s own parser reads none of those headers. The trajectories and the null on this page are therefore computed over a ' +
				'different set of sequences than the reference would use, and the two are not comparable codon by codon. Supply the same ' +
				'dates as a metadata table with `-d` and the command below reproduces this run.',
			warn: true
		});
	}

	if (record.primaeon.taxon_cap === 'applied') {
		notes.push({
			id: 'downsampled',
			lead: 'This alignment was downsampled before the model saw it.',
			rest:
				'The reference reduces by Faith\'s phylogenetic diversity after a stride prefilter, which is time-blind and can remove ' +
				'the early part of an epidemic; a run that was downsampled is not comparable with a command-line run on the whole file. ' +
				'Raise the sequence cap, or run the whole alignment at the command line.',
			warn: true
		});
	}

	return notes;
}

/** The one line a running null shows, with the live sweep count the runtime reports. */
export function progressLine(done: number, total: number, message: string): string {
	if (total > 0) return message || `Running: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}.`;
	return message || 'Running…';
}

/**
 * Seconds left, from the rate the draws already done actually achieved — never from a constant. It
 * returns null rather than a guess until two chunks have been timed, because a first chunk pays the
 * JIT and the CSR build and reads 20-50× the warm cost (`null.js`, CHUNK_EWMA_ALPHA).
 */
export function remainingSeconds(msPerDraw: number | null | undefined, done: number, total: number, chunks: number): number | null {
	if (!msPerDraw || !(msPerDraw > 0) || chunks < 2 || total <= done) return null;
	return ((total - done) * msPerDraw) / 1000;
}

// =================================================================================================
// The four figures
// =================================================================================================

export interface TrajectoryFigureModel {
	T: number;
	time: number[];
	tMin: number;
	tMax: number;
	yMax: number;
	/** Uncalled candidate trajectories, already capped. */
	background: Array<{ site: number; label: string; values: number[] }>;
	/** Confirmed sweeps, never capped. */
	called: Array<{ site: number; label: string; values: number[] }>;
	/** Sampling dates, for the rug. */
	samples: number[];
	drawn: number;
	candidates: number;
	capped: boolean;
}

export function trajectoryFigure(record: TemporalRecord, max = TEMPORAL_MAX_TRAJECTORIES): TrajectoryFigureModel {
	const { T, time, prevalence } = record.curves;
	const c = record.sites;
	const cand = Array.from(record.candidates, (site) => site - 1);
	const sweeps = cand.filter((s) => c.is_confirmed_sweep[s] === 1);
	const rest = cand
		.filter((s) => c.is_confirmed_sweep[s] !== 1)
		.sort((a, b) => c.peak_intensity[b] - c.peak_intensity[a]);
	const shown = rest.slice(0, Math.max(0, max));
	const row = (s: number) => ({
		site: c.site[s],
		label: c.mutation_label[s],
		values: Array.from(prevalence.subarray(s * T, s * T + T))
	});
	const background = shown.map(row);
	const called = sweeps.map(row);
	let yMax = 0;
	for (const line of [...background, ...called]) for (const v of line.values) if (v > yMax) yMax = v;
	return {
		T,
		time: Array.from(time),
		tMin: record.t_min,
		tMax: record.t_max,
		yMax: yMax > 0 ? yMax : 1,
		background,
		called,
		samples: record.dates.values.filter((v) => Number.isFinite(v)),
		drawn: background.length + called.length,
		candidates: cand.length,
		capped: rest.length > shown.length
	};
}

export interface RidgeRow {
	site: number;
	label: string;
	values: number[];
	peakIndex: number;
	peakDate: number;
	halfStart: number;
	halfEnd: number;
	max: number;
}

export interface VelocityFigureModel {
	T: number;
	time: number[];
	tMin: number;
	tMax: number;
	rows: RidgeRow[];
	/** Whether the rows are the confirmed sweeps or the fallback (strongest candidates). */
	source: 'sweeps' | 'candidates';
	total: number;
	capped: boolean;
}

/**
 * Figure 5's rows: the confirmed sweeps by peak date, or — when nothing was confirmed — the
 * strongest candidates by peak intensity, so the figure exists in every landed state and the figure
 * NUMBERING does not move between two runs of the same page. The caption says which it is drawing.
 */
export function velocityFigure(record: TemporalRecord, max = TEMPORAL_MAX_RIDGES): VelocityFigureModel {
	const { T, time, velocity } = record.curves;
	const c = record.sites;
	const cand = Array.from(record.candidates, (site) => site - 1);
	const sweeps = cand.filter((s) => c.is_confirmed_sweep[s] === 1);
	const source: 'sweeps' | 'candidates' = sweeps.length > 0 ? 'sweeps' : 'candidates';
	const pool =
		source === 'sweeps'
			? sweeps.sort((a, b) => c.peak_date[a] - c.peak_date[b] || a - b)
			: [...cand].sort((a, b) => c.peak_intensity[b] - c.peak_intensity[a]);
	const chosen = pool.slice(0, Math.max(1, max));
	const rows: RidgeRow[] = chosen.map((s) => {
		const values = Array.from(velocity.subarray(s * T, s * T + T));
		let peakIndex = 0;
		let peak = -Infinity;
		for (let t = 0; t < values.length; t++) {
			if (values[t] > peak) {
				peak = values[t];
				peakIndex = t;
			}
		}
		return {
			site: c.site[s],
			label: c.mutation_label[s],
			values,
			peakIndex,
			peakDate: c.peak_date[s],
			halfStart: c.t_half_start[s],
			halfEnd: c.t_half_end[s],
			max: peak > 0 ? peak : 1
		};
	});
	return { T, time: Array.from(time), tMin: record.t_min, tMax: record.t_max, rows, source, total: pool.length, capped: pool.length > rows.length };
}

export interface WaveFigureModel {
	T: number;
	time: number[];
	panels: Array<{ k: number; values: number[]; pct: number; sigma: number; gap: number; nearDegenerate: boolean; rankDeficient: boolean }>;
	/** Consecutive pairs whose singular values are too close to tell apart. */
	degeneratePairs: string[];
	gapThreshold: number;
	sign: string;
	source: string;
	sourceCount: number;
}

export function waveFigure(record: TemporalRecord): WaveFigureModel | null {
	const w = record.waves;
	if (!w || w.count === 0) return null;
	const T = record.curves.T;
	const panels = [];
	for (let k = 0; k < w.count; k++) {
		panels.push({
			k: k + 1,
			values: Array.from(w.data.subarray(k * T, k * T + T)),
			pct: record.fpca_wave_variance_pct[k] ?? 0,
			sigma: w.sigma[k] ?? 0,
			gap: w.gaps[k] ?? 0,
			nearDegenerate: Boolean(w.near_degenerate[k]),
			rankDeficient: Boolean(w.rank_deficient[k])
		});
	}
	const degeneratePairs: string[] = [];
	for (let k = 0; k < w.count - 1; k++) if (w.near_degenerate[k]) degeneratePairs.push(`${k + 1} and ${k + 2}`);
	return {
		T,
		time: Array.from(w.time),
		panels,
		degeneratePairs,
		gapThreshold: w.gap_threshold,
		sign: w.sign,
		source: w.source,
		sourceCount: w.source_sites.length
	};
}

export interface ClassificationPoint {
	site: number;
	label: string;
	x: number;
	y: number;
	sweep: boolean;
	borderline: boolean;
	gateFailed: boolean;
}

export interface ClassificationFigureModel {
	points: ClassificationPoint[];
	xCut: number;
	yCut: number;
	xMax: number;
	yMax: number;
	/** Candidates that cleared the permutation cut but failed the wave-alignment gate. */
	gateFailed: number;
	candidates: number;
	alpha: number;
	qCut: number;
	minR2: number;
	gateApplied: boolean;
	gridStep: number;
}

/** Figure 7. Null-free candidates cannot be placed on the y axis, so it returns null until tested. */
export function classificationFigure(record: TemporalRecord): ClassificationFigureModel | null {
	if (!record.permutations?.tested) return null;
	const c = record.sites;
	const alpha = record.floors.perm_alpha;
	const qCut = record.floors.q_static_cut;
	const minR2 = record.floors.min_r2_fpca;
	const gateApplied = !record.solitary_regime;
	const points: ClassificationPoint[] = [];
	const B = record.permutations.completed;
	let gateFailed = 0;
	for (const site of record.candidates) {
		const s = site - 1;
		const p = c.p_perm[s];
		const q = c.q_static[s];
		const sweep = c.is_confirmed_sweep[s] === 1;
		const failed = !sweep && p <= alpha && gateApplied && c.r2_fpca[s] < minR2;
		if (failed) gateFailed++;
		points.push({
			site,
			label: c.mutation_label[s],
			x: safeLog10(q),
			y: safeLog10(p),
			sweep,
			borderline: isBorderline(p, B, alpha),
			gateFailed: failed
		});
	}
	const xMax = Math.max(-Math.log10(qCut) * 1.6, ...points.map((p) => p.x), 0.5);
	const yMax = Math.max(-Math.log10(alpha) * 1.4, ...points.map((p) => p.y), 0.5);
	return {
		points,
		xCut: -Math.log10(qCut),
		yCut: -Math.log10(alpha),
		xMax,
		yMax,
		gateFailed,
		candidates: record.candidates.length,
		alpha,
		qCut,
		minR2,
		gateApplied,
		gridStep: record.permutations.grid_step
	};
}

function safeLog10(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 0;
	return -Math.log10(v);
}
