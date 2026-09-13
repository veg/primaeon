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
 *   2. A WAVE'S SIGN IS A CONVENTION, AND ITS VARIANCE SHARE IS CONDITIONED ON THE NULL. Right
 *      singular vectors are defined up to sign and the reference has no rule, so it writes its
 *      solver's raw signs (D28). This page's canonical rule — largest-magnitude entry positive,
 *      applied before the loadings are derived — means a curve here may be a command-line run's
 *      curve upside down, with its `Wave_k_loading` column negated and nothing else different. The
 *      SHARES are a separate and larger divergence, and saying only "no variance share reads a
 *      sign" invites a reader to take them as comparable: the decomposition is taken over the
 *      CONFIRMED-SWEEP SET, and that set is thresholded on the permutation p, so a different null
 *      decomposes a different matrix. THAT IS TRUE OF ONE OF THE TWO ROW SETS ONLY — the library
 *      falls back to the `max(4, candidates)` codons of largest peak intensity when fewer than four
 *      were confirmed (`js/src/temporal.js`, `temporalWaveDecomposition`), and that set is read off
 *      the trajectories before the null exists, so it is neither conditioned on the permutation p
 *      nor moved by drawing more shuffles. `record.waves.source` says which happened and
 *      `honestyNotes` prints one sentence per case; the measurement below is the sweep-set one.
 *      MEASURED on the acceptance run (H1N1, `-B 100 --time-points
 *      60`, this runtime against `fixtures/temporal/acceptance/h1n1_cpu_summary.json`): we confirm
 *      32 codons and the reference 18, and the four shares are 33.84 / 28.26 / 17.81 / 11.11 %
 *      against its 39.67 / 32.37 / 13.92 / 9.31 — 5.8 points on the leading mode, with no
 *      arithmetic difference anywhere between the two decompositions. `honestyNotes` prints both
 *      halves beside the figure and beside the download.
 *   3. OUR DATE LAYER IS WIDER THAN THE REFERENCE'S PARSER. `runtime/src/dates/` is the union of
 *      all three upstream parsers (D31), so a run here can be over a different set of sequences
 *      than `hyphaeon temporal` would use — on the Korber alignment the reference dates none of 143
 *      headers and we date 142. The record carries `dates.beyond_reference`; `honestyNotes` says so
 *      and `temporalReferenceCommand` (runtime) marks the printed command as not reproducing.
 *
 * A RUNNING NULL IS A FOURTH STATE, AND IT IS NOT A RESULT. The interim payload the worker publishes
 * per chunk carries `p_perm`, `q_perm` and `permutations` and NOTHING downstream of them: the
 * classification columns, `is_confirmed_sweep` and the three sweep counts are still the scored
 * payload's zeros until the run finishes (`runtime/src/temporal/run.js` builds the complete record
 * once, at the end). `permutations.tested` flips true after the FIRST chunk, so keying a sentence on
 * it alone makes the page state a completed negative finding while the null is a few draws in — and
 * it is a finding that is guaranteed at the start of every run, because p at draw k is
 * `(1 + exceedances)/(k + 1)` and therefore near 1 by construction. `nullInFlight` is that
 * distinction, read off the record's own `stage`, and every function that would otherwise call a
 * codon, count a sweep or plot a classification goes through it.
 *
 * THE COST SENTENCE IS AN UPPER BOUND, AND SAYS SO. Before stage one has run, the candidate count
 * is unknowable, and so is `nnz` — the number of (codon, sequence) pairs that actually carry a
 * non-root residue, which is what the null's kernel multiplies (`runtime/src/temporal/null.js`
 * measured rho = 0.043 on the acceptance alignment, so the real cost is usually a twentieth of the
 * bound). `nullCeiling` therefore substitutes the two ceilings a reader can check — every codon the
 * file holds is a candidate (`codonCeiling`, the TOTAL count, not the variable one: it is what a
 * reader can count off the file before a run, and it is the more conservative of the two), every
 * dated sequence carries the derived residue — and the page replaces it with the run's own measured
 * figures the moment the first payload lands. The two constants that bound is computed with are the
 * runtime's, copied and pinned equal to it by a test (`PERM_RATE`, `PERM_STAT_UNITS`).
 */

import { TEMPORAL_NULL_ASSUMPTION, TEMPORAL_THRESHOLDS } from '@veg/hyphaeon-runtime/temporal/codes';

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
 * The sequence cap this page runs at. It is the report's own (`REPORT_DEFAULTS`,
 * `runtime/src/analyze.js:107` — the manifest's `default_taxon_cap`) rather than something looser:
 * above it the library reduces the alignment by Faith's phylogenetic diversity, which is TIME-BLIND
 * (D27) and can remove the early part of an epidemic — exactly the part a sweep is measured
 * against — so a downsampled run is not comparable with a command-line run on the whole file.
 * `honestyNotes` says so whenever `primaeon.taxon_cap` reports that it bit.
 *
 * IT IS NOW READ FROM THE RUNTIME rather than written here. Phase 6 shipped this page capping at
 * 256 while the MCP and the server passed `Infinity`, with no statement anywhere of what each
 * choice cost; `runtime/src/temporal/caps.js` holds the policy for all three, with the measured
 * table behind it (memory is flat at 1.3-2.3 GB from 97 to 1,499 sequences, so the binding
 * constraint is TIME: 3.5 s of model pass at 97 and 192 s at 1,499 on a 566-codon gene). This
 * constant stays exported so nothing downstream has to change its import.
 */
export const TEMPORAL_MAX_SPECIES = TEMPORAL_THRESHOLDS.browserTaxonCap;

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
	/**
	 * `scored`, `null` and `complete` are the runtime's own (`runtime/src/temporal/run.js`).
	 * `stopped` is THIS PAGE'S and the runtime never writes it: when a cancel is not honoured within
	 * the worker client's grace the worker is terminated, the promise rejects with an AbortError and
	 * the last record the page holds is a `null`-stage one whose null is now never going to finish.
	 * `routes/time/+page.svelte` stamps `stopped` on it so the section stops saying "still running"
	 * about a worker that no longer exists. It is deliberately NOT `complete`: no call, sweep count
	 * or wave mode was ever computed on that record, and promoting it would have the page read those
	 * off the scored payload's zeros.
	 */
	stage: 'scored' | 'null' | 'complete' | 'stopped';
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

/**
 * Whether this record's shuffles are still being drawn: some draws are in, and the labels that
 * depend on them are not.
 *
 * THE ONE THING THIS SECTION MUST NOT DO IS CALL A CODON EARLY. The per-chunk payload replaces
 * `p_perm`, `q_perm` and `permutations` and nothing else, so `classification`, `is_confirmed_sweep`
 * and the three sweep counts are still the scored payload's zeros while `permutations.tested` is
 * already true. Reading `tested` alone therefore prints a completed negative finding a second into
 * a run — and one that is guaranteed, because p at draw k is `(1 + exceedances)/(k + 1)` and so
 * begins near 1 for every codon. The record's own `stage` is the discriminator, not the draw count:
 * a STOPPED null lands at `stage: 'complete'` with `completed < requested` and its labels ARE final.
 */
export function nullInFlight(record: TemporalRecord): boolean {
	return (record.permutations?.tested ?? false) && record.stage !== 'complete' && record.stage !== 'stopped';
}

/** Whether the call columns, the sweep counts and the wave modes on this record are final. */
export function callsAreFinal(record: TemporalRecord): boolean {
	return (record.permutations?.tested ?? false) && record.stage === 'complete';
}

/**
 * THE NULL HAS FOUR STATES, NOT THREE, and every caption that mentions it switches on this rather
 * than on `tested` or on `nullInFlight` alone:
 *
 *   `not-started`  no shuffle has been drawn and the run may still reach one.
 *   `running`      draws are arriving; nothing downstream of them exists yet (`nullInFlight`).
 *   `finished`     the record is complete and its calls, sweep counts and wave modes are final.
 *                  A run the reader STOPPED is here too when it kept at least one draw: the runtime
 *                  catches its own abort, finishes the classification at the achieved draw count and
 *                  returns a complete record, so those labels are results and not a half-answer.
 *   `stopped`      the null ended and produced nothing usable — declined over the work budget
 *                  (`skipped`), stopped before a single draw, or the run abandoned mid-null (the
 *                  page's own `stage: 'stopped'`, below). Saying "has not finished" here is false:
 *                  nothing is coming.
 *
 * The last of those is the one that used to be missing, and it read as `running` forever.
 */
export type NullState = 'not-started' | 'running' | 'finished' | 'stopped';

/**
 * THE TRANSITION A STOPPED RUN MUST MAKE, as a function so it can be driven by a test rather than
 * only by a browser.
 *
 * `routes/time/+page.svelte` calls this from the one place a run can end without a record of its
 * own: the AbortError the worker client raises when a cancel went unanswered for its grace
 * (`lib/workers/client.ts` terminates the worker and rejects every pending call). The cooperative
 * cancel does NOT come here — `runTemporalNull` catches its own abort and the run resolves with a
 * complete record at the achieved draw count — so a record reaching this function is one whose
 * `stage` is still `'null'`, and every sentence keyed on that stage says "the null is N of M
 * shuffles through" about a worker that no longer exists. That is the defect: without this the page
 * stayed in the in-flight sentence permanently, with nothing on screen saying the run had ended.
 *
 * It is deliberately NOT promoted to `'complete'`: no call, sweep count or wave mode was ever
 * computed on this record, and `'complete'` would have the section read all three off the scored
 * payload's zeros. A record that IS already complete is returned unchanged, so a late abort after a
 * finished run cannot demote a result.
 */
export function recordAfterAbort(record: TemporalRecord | null): TemporalRecord | null {
	if (!record) return null;
	if (record.stage === 'complete') return record;
	return { ...record, stage: 'stopped' };
}

export function nullState(record: TemporalRecord): NullState {
	const perm = record.permutations;
	if (record.stage === 'stopped') return 'stopped';
	if (!perm) return 'not-started';
	if (perm.skipped) return 'stopped';
	if (nullInFlight(record)) return 'running';
	if (record.stage !== 'complete') return 'not-started';
	if (perm.tested) return 'finished';
	return perm.cancelled ? 'stopped' : 'not-started';
}

/**
 * Why nothing is called, as a clause a caption drops into "…, because <clause>". Null in the
 * `finished` state, where the caption has a result to print instead of a reason.
 */
export function uncalledBecause(record: TemporalRecord): string | null {
	const state = nullState(record);
	if (state === 'finished') return null;
	if (state === 'running') return 'the date-shuffling null has not finished';
	if (state === 'not-started') return 'the date-shuffling null has not been drawn';
	if (record.stage === 'stopped') {
		// TWO STOPS, NOT ONE. `recordAfterAbort` marks any non-complete record `stopped`, and the
		// record it is handed is whatever the last interim payload was. That is usually a per-chunk
		// null payload — shuffles were being drawn — but between the scored payload and the first
		// chunk (the fPCA pass, the budget check, the calibration draw) there is a window in which
		// the record carries NO permutation block at all, and telling that reader the null "was
		// being drawn" names a thing that had not started.
		return (record.permutations?.completed ?? 0) > 0
			? 'this run was stopped while the null was being drawn, and the calls are computed only at the end'
			: 'this run was stopped before the null drew a single shuffle, and the calls are computed only at the end';
	}
	if (record.permutations?.skipped) return 'the date-shuffling null was declined before it started, as over the work budget';
	return 'the date-shuffling null was stopped before a single shuffle was drawn';
}

/**
 * Whether the wave loadings and R² on this record are still the interim ZEROS rather than numbers.
 * `runtime/src/temporal/record.js:70,72` fills both with zero arrays until the decomposition runs,
 * and the decomposition runs once, at the end — so mid-null a table that renders those cells draws
 * a hard 0 that a reader cannot tell from a measured 0.
 */
export function waveColumnsPending(record: TemporalRecord): boolean {
	return record.waves == null && record.stage !== 'complete';
}

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

/**
 * `runtime/src/temporal/null.js`'s two cost constants, COPIED rather than imported, and held equal
 * to the runtime's by a test.
 *
 * WHY A COPY. Importing `@veg/hyphaeon-runtime/temporal` into this module would put `predict.js`,
 * the library and onnxruntime into the route's initial bundle, so that a reader who never presses
 * the button downloads the model layer to read a sentence about it; that is why the page's own
 * download handler imports it dynamically at the click (`routes/time/+page.svelte`). Two literals
 * cost nothing. Two literals that silently drift from the runtime's do, so `temporal.test.ts`
 * imports `TEMPORAL_PERM_RATE` and `TEMPORAL_PERM_STAT_UNITS` from the runtime and asserts these
 * equal them: a re-measurement there fails this page's suite instead of splitting the two.
 *
 * WHAT IS NO LONGER COPIED, since phase 6's review. `@veg/hyphaeon-runtime/temporal/codes` is a
 * SECOND subpath onto `src/temporal/codes.js` alone, which imports nothing but the date layer's own
 * import-free `codes.js` — no session, no eigensolver, no library — so the pillar's VOCABULARY is
 * importable here at no bundle cost. The sequence cap (`TEMPORAL_MAX_SPECIES`) and the null's
 * stated assumption (`TEMPORAL_NULL_ASSUMPTION`, rendered as the first honesty note) come from
 * there rather than being written twice. Only the two RATE constants above stay copied, because
 * they live in `null.js`, which does reach the model layer.
 */
export const PERM_RATE = 5.5e8;
export const PERM_STAT_UNITS = 15;

/**
 * The model pass, in codon-sequences a second. MEASURED through this repository's own runtime
 * (`runTemporal` at 4 threads, `general.onnx`, onnxruntime-node, Node 22.22.0 x64 under Rosetta on
 * an Apple M4 Pro), timing the `temporal-infer` phase alone — the graph call and nothing else — in
 * an isolated process per row, with the machine's one-minute load average beside each, because that
 * is the variable that moves this number most:
 *
 *   codons   sequences   seconds   codon-sequences/s   load
 *   4,384           95     21.87              19,044     18
 *   4,384           95     30.39              13,703     14
 *   4,384           95     30.18              13,800     11
 *   4,384           95     32.14              12,957     26
 *   4,384           95     40.05              10,400    133
 *     566           97      3.60              15,263      9   (H5N1_HA_geo.fasta)
 *     566           97      4.52              12,155      9
 *     566           97      4.16              13,194     56
 *     566           97      3.93              13,984     52
 *
 * Two shapes, nine runs, and the sequence count is the DATED one (H1N1 dates 95 of its 100
 * sequences), because that is what the pass is over. The product of the two counts is the unit to
 * quote the rate in: 4,384 x 95 is 7.6 times 566 x 97 in codon-sequences and took 5.5-8.4 times the
 * seconds across these runs, so the pass is close enough to linear in the product that a single rate
 * is the right shape of anchor.
 *
 * THE MARGIN, AND WHAT MAY BE SAID ABOUT IT. Nothing above reaches 2.0e4: the fastest of these nine
 * is 19,044, which is 5 % UNDER the constant, and the median is about 13,700. An earlier writing of
 * this header called 2.0e4 "11 % under the slowest" measured shape, and a third-party run on an idle
 * machine measured 23,073 / 20,650 / 24,423 on shapes of this kind, where it would be 3 % under the
 * slowest. Both of those describe an idle machine; this one was never idle (load 9-133 throughout,
 * other work on the same cores), and on it the printed estimate UNDER-states the wait — by about 5 %
 * at best and by half at load 133.
 *
 * So the constant stays — it is the right order of magnitude on both shapes and in both machine
 * states, and lowering it to cover a loaded machine would over-state the wait for every reader on an
 * idle one — but nothing here may call it conservative, a floor, or an upper bound. It is a middling
 * anchor, and the sentence it feeds says "at the rate this build measured on its own development
 * machine" for exactly that reason. `TEMPORAL_PERM_RATE` was written up as the other rule — a floor
 * under two runs 1.7x apart — and it is not one either: a third measurement through the same driver,
 * on the same machine at a one-minute load average of 10-36, put four of six dense-shape runs below
 * it (3.59e8 against the constant's 5.5e8). Its own block now carries that table. So BOTH rates on
 * this page are middling anchors, both say so in the sentences they feed, and neither claims a
 * bound.
 *
 * It is a Node measurement and the page says so: a browser's WASM backend is a different engine at
 * a different thread count and this is an anchor, not a promise.
 */
export const TEMPORAL_MODEL_RATE = 2.0e4;

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
 * `runtime/src/temporal/null.js` computes `W = B·C·T·(nnz/C + TEMPORAL_PERM_STAT_UNITS)` from the
 * MEASURED number of nonzero attribution entries. Before stage one there is no candidate set and no
 * `nnz`, so both are replaced by their ceilings: `nnz/C = N` (every dated sequence carries a
 * non-root residue at every candidate) and `C` = every codon the alignment holds. `C` is quoted as
 * the TOTAL codon count rather than the variable one — `codonCeiling` is what the caller can read
 * off the file before a run, it is the more conservative of the two, and the sentence calls it a
 * ceiling. On the acceptance alignment the measured density was 0.043, so the bound over-states by
 * roughly twenty times — which is the right direction for a number a reader is asked to wait on.
 */
export function nullCeiling({
	B,
	C,
	T,
	N,
	rate = PERM_RATE
}: {
	B: number;
	C: number;
	T: number;
	N: number;
	rate?: number;
}): NullCeiling {
	const work = B > 0 && C > 0 && T > 0 ? B * C * T * (N + PERM_STAT_UNITS) : 0;
	return { work, seconds: rate > 0 ? work / rate : 0, B, C, T, N };
}

/**
 * Seconds of model pass, at `TEMPORAL_MODEL_RATE` — the one quantity the offer used to describe
 * without pricing, and the one that dominates what a reader actually waits for. MEASURED on the
 * acceptance shape (H1N1, 4,384 codons over 95 dated sequences, `-B 100 --time-points 60`, 4
 * threads, three isolated runs): `temporal-infer` 21.87 / 30.39 / 30.18 s against a null of
 * 0.153 / 0.171 / 0.155 s — the achieved `ms_per_draw` times the 100 draws — so the null is
 * 0.5-0.7 % of the wait. At the command line's own defaults (`-B 1000 --time-points 250`) the same
 * alignment is 36.07 / 35.49 s of model pass against 4.27 / 1.57 s of null, which is its most
 * expensive setting and still 4-11 % of the wait. Whichever end it is read at, pricing the null
 * alone — as this paragraph once did — prices the wrong half. Null when either count is unknown, so
 * the sentence names no number it cannot read.
 */
export function modelSeconds(codons: number | null, sequences: number | null): number | null {
	if (!codons || !sequences || !(codons > 0) || !(sequences > 0)) return null;
	return (codons * sequences) / TEMPORAL_MODEL_RATE;
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
 * The offer's cost paragraph, as sentences. BOTH halves are priced. The model pass is the long one
 * — measured on the acceptance shape it is 21.87-30.39 s against a null of 0.15-0.17 s, and at the
 * command line's own defaults 35.49-36.07 s against 1.57-4.27 s (the numbers and their conditions
 * are in `modelSeconds`) — so quoting only the null, as this paragraph once did, prices the cheap
 * part and reads as the wait. Its rate is Node's and the sentence says so; the null's bound is
 * arithmetic and is stated as one.
 *
 * @param sequences the sequences the model will see — every sequence in the file, not just the
 *   dated ones, capped at `TEMPORAL_MAX_SPECIES`; null when the file has not been read
 */
export function costSentences(args: {
	codons: number | null;
	sequences?: number | null;
	dated: number;
	timePoints: number;
	draws: number;
	scoreInvariable: boolean;
}): string[] {
	const { codons, sequences = null, dated, timePoints, draws, scoreInvariable } = args;
	const where = codons == null ? 'every codon of your alignment' : `all ${codons.toLocaleString('en-US')} codons`;
	const ceiling = codons == null ? null : nullCeiling({ B: draws, C: codons, T: timePoints, N: dated });
	const model = modelSeconds(scoreInvariable ? codons : null, sequences);
	return [
		`The model scores ${scoreInvariable ? where : 'every variable codon'} once, over ` +
			`${dated.toLocaleString('en-US')} dated sequence${dated === 1 ? '' : 's'}` +
			(scoreInvariable
				? ', the invariable ones included — which is what `hyphaeon temporal` does (temporal.py:510, 514: the pass is a '+
					'loop over every one of the L codons, where the static scan below it takes `var_indices` alone), and what makes the ' +
					'downloads below diffable against it.'
				: '; the invariable ones are skipped, so their static LRT and p-value come back empty rather than scored.') +
			' Nothing re-enters the graph after that: the trajectories, the null and the wave modes are all arithmetic over that one pass.' +
			(model
				? ` That pass is the long part of the wait: ${duration(model)} at the rate this build measured on its own ` +
					`development machine — ${TEMPORAL_MODEL_RATE.toLocaleString('en-US')} codon-sequences a second under Node, ` +
					`against the ${sequences!.toLocaleString('en-US')} sequence${sequences === 1 ? '' : 's'} this file carries. Your ` +
					'browser runs a different engine at a different thread count, so read it as an anchor and not as a promise.'
				: ' It is also the long part of the wait, and it is not priced here: ' +
					(scoreInvariable
						? 'the codon and sequence counts could not both be read off this file.'
						: 'how many codons vary, and are therefore scored, is not known until the alignment has been read.')),
		`The null is the only part that grows with the number of draws, and it is the product of four numbers: ` +
			`draws × candidate codons × dated sequences × grid points. At most ${draws.toLocaleString('en-US')} × ` +
			`${codons == null ? 'C' : codons.toLocaleString('en-US')} × ${dated.toLocaleString('en-US')} × ${timePoints.toLocaleString('en-US')}` +
			(ceiling
				? `, so at most ${bigNumber(ceiling.work)} multiply-adds — ${duration(ceiling.seconds)} at the rate this build ` +
					'measured on its own development machine. That rate is an anchor and not a bound: on a busy machine the same '+
					'kernel has measured half of it, so read the ceiling above, which over-states by roughly twenty times, as the '+
					'part of this sentence that is arithmetic.'
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

/**
 * What the run actually cost, once it has one — measured, never modelled. Mid-run it is what the
 * run has cost SO FAR: the shuffle count is live and the elapsed figure is the scored payload's,
 * and neither of them is an "in all".
 *
 * WHAT THAT ELAPSED FIGURE COVERS. `runtime/src/temporal/record.js` writes `runtime_sec` from
 * `Date.now() - started`, where `started` is the first line of `runTemporal` (run.js), so the
 * stage-one record's figure is the whole of stage one — the regime switches, the root, the model
 * pass, the root-anchoring and smoothing, the sweep-energy screen and the static scan — and not the
 * model pass alone. MEASURED on the acceptance shape (H1N1, 4,384 codons over 95 dated sequences, 4
 * threads, three isolated runs): stage one ran 21.954 / 30.477 / 30.265 s against a `temporal-infer`
 * phase of 21.869 / 30.393 / 30.180 s, so the rest of stage one is 0.084-0.085 s of it. On the same
 * alignment at 250 grid points instead of 60 it is 0.188-0.230 s, which is the smoothing paying for
 * the longer grid. The difference is small either way, which is exactly why calling the figure "the
 * model pass" was wrong and survived unnoticed: the sentence names the STAGE, not the pass.
 */
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
	const state = nullState(record);
	const elapsed =
		state === 'running'
			? 'to the end of stage one — the model pass, the smoothing and the static scan — with the null still running'
			: state === 'stopped' && record.stage === 'stopped'
				? 'to the end of stage one, after which this run was stopped'
				: 'in all';
	parts.push(`${num(record.runtime_sec, 1)} s ${elapsed}`);
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
 *
 * A row reads "not tested" while the null is IN FLIGHT as well as before it starts (`nullInFlight`):
 * mid-run the classification column is still the scored payload's, so calling a row from it would
 * label every candidate "Tested, not confirmed" a second into the run. The live p and q columns are
 * shown either way — they are the estimator at the achieved draw count, which is a real number.
 */
export function siteRows(record: TemporalRecord, which: 'candidates' | 'all' | 'sweeps' = 'candidates'): TemporalSiteRow[] {
	const c = record.sites;
	const tested = callsAreFinal(record);
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

/**
 * The finding, with the numbers inline, and then it stops (web/DESIGN.md §5). FIVE forms, one per
 * state the section can be in: the null is still being drawn, the null ended without an answer, the
 * null has not been drawn, nothing was confirmed, and the finding. "Nothing was confirmed" may only
 * be printed once the run is complete — mid-run it would be both false and guaranteed, since p at
 * draw k starts near 1 for every codon.
 *
 * WHICH WAY "ABOVE" AND "BELOW" POINT. This sentence is the FIRST thing `TemporalSection.svelte`
 * renders after the controls: the cost line, the stat strip, Figures 4-7 and the table are all
 * below it. An earlier writing sent a reader upwards for the trajectories, where there is nothing.
 */
export function ledeSentence(record: TemporalRecord, units: TimeUnits): string {
	const tested = record.permutations?.tested ?? false;
	const state = nullState(record);
	const C = record.stage1_candidates;
	const L = record.codons_total;
	const candidates = `${C.toLocaleString('en-US')} of ${L.toLocaleString('en-US')} codons passed the sweep-energy floor and are candidates`;
	if (state === 'running') {
		const perm = record.permutations!;
		const done = perm.completed.toLocaleString('en-US');
		const asked = perm.requested.toLocaleString('en-US');
		return (
			`${candidates}; the null is ${done} of ${asked} shuffles through, so nothing here is confirmed or ruled out yet. ` +
			`The p-values in the table below are the estimator at ${done} draws — (1 + exceedances) / (${done} + 1), which ` +
			'starts near 1 for every codon and falls as the shuffles accumulate — and the calls, the sweep counts and the ' +
			'wave modes are computed once, when it finishes. The trajectories, peaks, widths and areas in the two figures ' +
			'below are already final.'
		);
	}
	if (state === 'stopped') {
		const done = record.permutations?.completed ?? 0;
		return (
			`${candidates}, and ${uncalledBecause(record)}, so none is confirmed or ruled out. ` +
			(done > 0
				? `The p-values in the table below are the estimator at the ${done.toLocaleString('en-US')} shuffle` +
					`${done === 1 ? '' : 's'} that were drawn, and the call columns were never computed. `
				: '') +
			'The trajectories, peaks, widths and areas in the two figures below are final; ' +
			(record.permutations?.skipped ? 'the note below says why the null was declined.' : 'run it again to test them.')
		);
	}
	if (!tested) {
		return `${candidates}; none has been tested against the shuffled dates, so none is confirmed or ruled out.`;
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
	// Every count on this section pluralises its own verb; a fixed "are" beside an interpolated
	// number is the one copy defect a reader is guaranteed to meet, because n = 1 is common.
	const where = record.rescued_sweeps === n
		? `${n === 1 ? 'It is' : `All ${n} are`} found only in time: the static scan calls nothing at q ≤ ${record.floors.q_static_cut} on this alignment.`
		: `${record.concordant_sweeps} of them ${record.concordant_sweeps === 1 ? 'is' : 'are'} also called by the static scan at ` +
			`q ≤ ${record.floors.q_static_cut}; ${record.rescued_sweeps} ${record.rescued_sweeps === 1 ? 'is' : 'are'} found only in time.`;
	return (
		`${n} of ${L.toLocaleString('en-US')} codons ${n === 1 ? 'is a confirmed sweep' : 'are confirmed sweeps'}, the earliest peaking at ` +
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
 * are the ones the runtime cannot say because they are about what a READER will do with the numbers.
 *
 * THE FIRST IS THE EXCEPTION and is deliberately not written here: `exchangeable` is the runtime's
 * own `TEMPORAL_NULL_ASSUMPTION`, rendered verbatim, because the same sentence has to reach the
 * download notes and the MCP's honesty block and three copies of it would drift.
 */
export function honestyNotes(record: TemporalRecord): HonestyNote[] {
	const notes: HonestyNote[] = [];
	const perm = record.permutations;
	const B = perm?.completed ?? 0;
	// Two of these notes count codons against a threshold, and mid-run every p is still falling
	// towards its final value, so both would describe a distribution that no longer exists by the
	// time the reader finishes the sentence. They wait for the run instead of printing a number that
	// will be wrong (`nullInFlight`).
	const inFlight = nullInFlight(record);

	// WHAT THE NULL ASSUMES, first and on every run that drew one, because it is the assumption the
	// whole section rests on and it is the one a reader cannot infer from any number on the page.
	// The words are the runtime's (`TEMPORAL_NULL_ASSUMPTION`), so this page, the download notes and
	// the MCP's honesty block cannot drift apart; `warn: false` because the test is valid and it is
	// the READING that has to be bounded, which is what this section's notes are for.
	if (B > 0) {
		notes.push({
			id: 'exchangeable',
			lead: TEMPORAL_NULL_ASSUMPTION.lead,
			rest: TEMPORAL_NULL_ASSUMPTION.rest,
			warn: false
		});
	}

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

	if (B > 0 && !inFlight) {
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

	if (perm && !inFlight && perm.q_min != null && perm.q_min > record.floors.q_static_cut) {
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
		// The sign note is about a sign; the shares need their own sentence, because "no variance
		// share reads a sign" is easily read as "the shares are comparable", and they are not.
		//
		// AND THE REASON THEY ARE NOT DEPENDS ON WHICH ROW SET WAS USED. `temporalWaveDecomposition`
		// (`js/src/temporal.js`) takes the confirmed sweeps when there are at least four of them, and
		// otherwise the `max(4, candidates)` codons of the WHOLE alignment with the largest peak
		// intensity — a set chosen from the trajectories alone, before the null exists and unmoved by
		// it. Saying "thresholded on the permutation p" of that second set was simply false.
		const fromSweeps = record.waves.source === 'confirmed-sweeps';
		const rows = record.waves.source_sites.length;
		const rowCount = `${rows.toLocaleString('en-US')} codon${rows === 1 ? '' : 's'}`;
		notes.push({
			id: 'wave-shares',
			lead: fromSweeps
				? 'The percentages beside the waves are conditioned on which codons were confirmed.'
				: 'The percentages beside the waves are conditioned on a set the null did not choose.',
			rest: fromSweeps
				? `The decomposition runs over the ${rowCount} in the confirmed-sweep set, and that set is thresholded on the ` +
					'permutation p — which comes from a different generator than the reference\'s. A command-line run that confirms a ' +
					'different set of codons therefore decomposes a DIFFERENT MATRIX, and its shares differ by more than float noise ' +
					'even though the arithmetic is identical. Measured on the acceptance alignment: this runtime confirmed 32 codons ' +
					'where the reference confirmed 18, and the four shares came out 33.84 / 28.26 / 17.81 / 11.11 % against its ' +
					'39.67 / 32.37 / 13.92 / 9.31 — 5.8 points on the leading mode. Compare the shapes and the ordering, not the digits.'
				: `Fewer than four codons were confirmed, so the decomposition falls back to the ${rowCount} with the largest peak ` +
					'intensity in the whole alignment — as many as there were candidates, and at least four. That set is read off the ' +
					'trajectories alone, BEFORE the null is drawn, so unlike the confirmed-sweep set it is neither thresholded on the ' +
					'permutation p nor changed by drawing more shuffles. What the null still decides is WHICH BRANCH is taken: a ' +
					'command-line run that confirmed four or more codons decomposes its own sweep set instead, which is a different ' +
					'matrix, and its shares are then not comparable with these at all. Compare the shapes and the ordering, not the digits.',
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
	/** Whether `called` is a result. False before the null and while it is still being drawn. */
	called_is_final: boolean;
	/**
	 * Why nothing is called, when `called_is_final` is false — the null has not been drawn, is being
	 * drawn, or ended without an answer. Null when the calls ARE final, where the caption prints the
	 * count instead. `uncalledBecause`; the caption may not invent its own, which is how it came to
	 * tell a reader whose null was SKIPPED that it "has not finished".
	 */
	uncalled_reason: string | null;
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
		capped: rest.length > shown.length,
		called_is_final: callsAreFinal(record),
		uncalled_reason: uncalledBecause(record)
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
	/**
	 * Whether the rows are the confirmed sweeps, the fallback after a run that confirmed none, or
	 * the strongest candidates of a run that has no calls — three different sentences, because "no
	 * codon was confirmed" is a result and the third state is not one.
	 */
	source: 'sweeps' | 'candidates' | 'untested';
	/** Why there are no calls, when `source` is `untested`; null otherwise. `uncalledBecause`. */
	uncalled_reason: string | null;
	total: number;
	capped: boolean;
}

/**
 * Figure 5's rows: the confirmed sweeps by peak date, or — when nothing was confirmed, or the run
 * has no calls at all — the strongest candidates by peak intensity, so the figure exists in every
 * landed state and the figure NUMBERING does not move between two runs of the same page. The
 * caption says which of the three it is drawing, and in the third case WHY, from `uncalledBecause`
 * rather than from a guess: a null that was skipped over budget has not "not finished yet".
 */
export function velocityFigure(record: TemporalRecord, max = TEMPORAL_MAX_RIDGES): VelocityFigureModel {
	const { T, time, velocity } = record.curves;
	const c = record.sites;
	const cand = Array.from(record.candidates, (site) => site - 1);
	const final = callsAreFinal(record);
	const sweeps = final ? cand.filter((s) => c.is_confirmed_sweep[s] === 1) : [];
	const source: 'sweeps' | 'candidates' | 'untested' = sweeps.length > 0 ? 'sweeps' : final ? 'candidates' : 'untested';
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
	return {
		T,
		time: Array.from(time),
		tMin: record.t_min,
		tMax: record.t_max,
		rows,
		source,
		uncalled_reason: source === 'untested' ? uncalledBecause(record) : null,
		total: pool.length,
		capped: pool.length > rows.length
	};
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

/**
 * Figure 7. Null-free candidates cannot be placed on the y axis, so it returns null until tested —
 * and it stays null while the null is IN FLIGHT, which is a stronger condition than "some draws are
 * in". Mid-run the y coordinate is a p that is still falling and the fill, the borderline mark and
 * the gate count all read the scored payload's zeros, so the figure would be a picture of an
 * unfinished computation with every point in the wrong quadrant. The caller says which of the two
 * states it is in; both are honest and only one of them is permanent.
 */
export function classificationFigure(record: TemporalRecord): ClassificationFigureModel | null {
	if (!callsAreFinal(record)) return null;
	const c = record.sites;
	const alpha = record.floors.perm_alpha;
	const qCut = record.floors.q_static_cut;
	const minR2 = record.floors.min_r2_fpca;
	const gateApplied = !record.solitary_regime;
	const points: ClassificationPoint[] = [];
	const perm = record.permutations!;
	const B = perm.completed;
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
		gridStep: perm.grid_step
	};
}

function safeLog10(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 0;
	return -Math.log10(v);
}
