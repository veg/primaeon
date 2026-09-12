/**
 * null.js — the date-shuffling null, run in chunks a reader can watch and stop.
 *
 * WHY THIS FILE EXISTS. `temporal.py:618-666` is the pillar's stage two: draw a permutation of the
 * sampling dates, re-smooth every candidate codon's attribution against the permuted time axis,
 * take the same statistic, and count how often the shuffled trajectory beats the real one. The
 * ARITHMETIC of that is the library's (`temporalNullDraws`, `temporalPermStat`,
 * `temporalDrawPermutation`, `temporalPermPValues`) and is pure, allocation-free inside the draw
 * loop, and index-addressed so that draw `b` is the same draw whoever asks for it. What is left is
 * exactly what the library refuses to own and what this file is: a cost model, a work budget, a
 * chunk size calibrated against the clock, a progress cadence, a cancel that keeps what was
 * computed, and the sentences a reader is owed about all four.
 *
 * THE SHAPE IS `runtime/src/dms.js`'s, deliberately. Same `{work, budget, within, reason}` return
 * from the budget check, same "cancelling keeps what was computed" rule, same `yieldToLoop()` at the
 * chunk boundary as the only place a worker can post progress and a cancel can land. A reader of one
 * should recognise the other.
 *
 * ==============================================================================================
 * THE COST MODEL, AND THE TWO ESTIMATES IT CORRECTS
 * ==============================================================================================
 *
 * PLAN-TEMPORAL.md §5.1.3 budgets the null at "35 to 100 s at 200 candidate sites, 3 to 8 minutes
 * at 1,000" and calls it "one to two orders of magnitude more expensive than everything else
 * combined, including the model". That arithmetic assumed a DENSE attribution matrix. It is not
 * dense. `leaf_attributions = mean_attns * delta_root` (temporal.py:540) multiplies the attention by
 * an INDICATOR of carrying a non-root residue, so the matrix is zero wherever a sequence agrees with
 * the root — MEASURED on the acceptance run's own 246 candidates over 95 dated sequences, 1,000 of
 * 23,370 entries are nonzero, rho = 0.0428. The library's kernel skips those zeros (bit-safe:
 * `x + 0.0 = x` exactly, and the accumulator never sees `-0.0 + 0.0`), so the real cost per draw per
 * candidate is `nnz_c·T` for the matrix product plus a FIXED per-grid-point cost for the statistic —
 * `curves.fill` plus a gradient with numpy's non-uniform coefficients, a clamp, a pairwise mean and
 * a pairwise sum of squared deviations — which is independent of nnz and DOMINATES at this density.
 *
 *     W = B · C · T · (nnz/C + TEMPORAL_PERM_STAT_UNITS)
 *
 * MEASURED ON THIS MACHINE (Node 22.22.0, x64 under Rosetta on an Apple-silicon Mac, which is a
 * FLOOR: a native arm64 browser should be 1.5-2x faster), best of three, through THIS driver — so
 * with the chunking, the per-chunk CSR rebuild and the `setTimeout(0)` yields the reference's single
 * loop does not pay:
 *
 *     shape                                      B      wall     nnz    ms/draw   W (k=21)   rate
 *     acceptance  C=246  N=95  T=60  rho=0.043   100     45 ms    1000    0.450    3.70e7   8.2e8
 *     acceptance  C=246  N=95  T=60  rho=0.043  1000    390 ms    1000    0.390    3.70e8   9.5e8
 *     acceptance  C=246  N=95  T=250 rho=0.043  1000  1 353 ms    1002    1.353    1.55e9   1.1e9
 *     mid         C=400  N=256 T=250 rho=0.30    500  5 034 ms  30 822   10.07     4.90e9   9.7e8
 *     large       C=1500 N=256 T=250 rho=0.30    200  7 719 ms 115 419   38.60     7.35e9   9.5e8
 *
 * Solving for `k` and the rate from the two EXTREME points (acceptance T=60 at B=1000, and large)
 * gives k = 21.1 and 9.49e8 units/s, and that pair then predicts the two shapes it was not fitted to
 * within 2.6 % (mid) and 20 % (acceptance at T=250) — over-stating in both cases, which is the right
 * direction for a budget. So:
 *
 *     TEMPORAL_PERM_STAT_UNITS = 21    (the kernel survey's cost model said 7)
 *     TEMPORAL_PERM_RATE       = 9.0e8 (5 % under the fit, so every prediction stays conservative;
 *                                       the kernel survey measured 1.0e9 on a bare kernel with no
 *                                       PRNG in it and 0.65e9 with one, at its own k = 7)
 *
 * With those two the model is flat across a 100x spread in per-draw cost and a 7x spread in density,
 * which the survey's k = 7 was not: at k = 7 the same five measurements imply rates from 3.2e8 to
 * 8.3e8, a 2.6x spread that no single constant can serve.
 *
 * THE MEASUREMENT WINS OVER BOTH PRIOR ESTIMATES AND BOTH ARE RECORDED AS WRONG. The plan's
 * "minutes at realistic sizes" is out by two orders on the demo: the whole null at the REFERENCE'S
 * OWN default of 1,000 draws costs 390 ms on the acceptance shape, against 17.5 s for the single
 * model pass that feeds it. The kernel survey had the right rate and the wrong fixed term — its
 * `7` under-counts the statistic by a factor of three, which matters precisely in the sparse regime
 * it was measuring, so its per-shape predictions ran optimistic by 1.6x on the demo while landing on
 * the dense cases. The null is not this pillar's expensive section; the model is, and the report's
 * digital DMS still dwarfs both.
 *
 * Two cautions against over-reading that, both of which are why the budget machinery below stays.
 * rho is dataset-dependent and rises with divergence: a deep-time or recombinant alignment reaches
 * 0.3-0.5, where the matrix term finally overtakes the fixed one. And the budget is computed from
 * MEASURED nnz after stage one, never from `N` — `candidateNnz` counts the matrix that will actually
 * be multiplied.
 *
 * ==============================================================================================
 * WHY ROUNDS, AND WHY A ROUND BOUNDARY IS FREE
 * ==============================================================================================
 *
 * D26 asks for "200, not the reference's 1,000, and say so on the page". A fixed 200 would be the
 * literal reading and it would also leave the reference's own default on the table at 390 ms. So the
 * default is PROGRESSIVE: 200 draws, then 500, then 1,000, each admitted only if the cumulative work
 * still fits the budget, with the p-table republished at every boundary and the ACHIEVED count
 * recorded beside every p-value.
 *
 * That is free, and it is free for a reason worth stating: the library seeds draw `b` from a
 * per-draw substream (`splitmix64(seed0, b)`), not from one stream advanced draw by draw, so a run
 * stopped at 500 is BIT-IDENTICAL to a run configured with B = 500. The stopping rule is the clock
 * and the budget, both fixed before any statistic is seen, so `p = (1 + exceed)/(b + 1)` at the
 * stopping `b` is exactly the reference's estimator at that `B` — no bias and no special pleading.
 *
 * A PARTIALLY COMPLETED DRAW IS NEVER COUNTED. `exceed` is incremented only by draws that finished
 * every candidate, which is what makes the answer independent of where a cancel landed, and it is
 * the one rule a later refactor is most likely to break. The library enforces it structurally —
 * `temporalNullDraws` takes a draw RANGE and returns only whole draws — and this file never asks for
 * a fractional one.
 *
 * ==============================================================================================
 * WHAT THE CHUNK SIZE IS FOR
 * ==============================================================================================
 *
 * Not the frame budget: this runs in a worker and never blocks the UI thread. It is cancel latency
 * and progress cadence. MEASURED per-draw times across the shapes above span 0.38 ms (acceptance) to
 * 37.9 ms (large divergent) — a factor of 100 — so a fixed chunk COUNT would be wrong by two orders
 * at one end. Draw zero is timed alone, the chunk is set to `TEMPORAL_PERM_CHUNK_TARGET_MS /
 * msPerDraw` clamped to [1, 256], the first WARM chunk replaces that cold estimate outright, and an
 * EWMA maintains it thereafter so a throttled or contended tab does not stall the cancel. 200 ms
 * gives about five progress ticks a second and bounds the work a cancel throws away at one chunk.
 *
 * MEASURED cost of all of it: driving the kernel through this file rather than calling it once
 * costs 2-8 % (381 ms against 381, 1 319 against 1 276, 5 414 against 5 071, 8 353 against 7 570),
 * which is the per-chunk CSR rebuild and the yields. Worth it for a cancel that lands in 200 ms.
 *
 * ONE CAVEAT, RECORDED RATHER THAN SOLVED: `yieldToLoop()` is `setTimeout(0)`, and a dedicated
 * worker's timers can be clamped to 1 Hz in a backgrounded tab, which would make cancel latency one
 * second rather than 200 ms. If that is ever measured, the fix is a `MessageChannel` port round-trip
 * in `predict.js`'s helper — a runtime-wide change that the digital DMS inherits for free, not a
 * temporal one.
 *
 * ==============================================================================================
 * WHAT THIS CANNOT PROMISE
 * ==============================================================================================
 *
 * Bit-identical across browser, MCP and server given the same inputs, options, seed, `T` and draw
 * count — and independent of chunk size, round boundaries and where a cancel landed. NOT identical
 * to `hyphaeon temporal`: the reference draws from numpy's MT19937 at a hard-coded `RandomState(42)`
 * (temporal.py:651) and the library standardises on xoshiro256** per-draw substreams by design
 * (D17), the same divergence this repository already recorded for the phenotype permulations. So
 * `p_perm`, `q_perm`, `is_confirmed_sweep`, both classification columns and the three sweep counts
 * are STATISTICAL class only; everything upstream of the shuffle is strict graph class.
 *
 * Besag-Clifford curtailment (retire a candidate once its exceedance count reaches h, then report
 * `h/b_c`) is the kernel survey's second gear and is NOT implemented. It is off by default there
 * too, it changes the estimator so a record carrying it must say so, and the budget check it exists
 * to rescue essentially never fires at the report's own caps — refusing needs
 * `C·T·(rho·N + 7) > budget/B_MIN`, which at 256 taxa, T = 250 and rho = 0.3 means more codons than
 * any gene. Recorded here so it is not re-discovered rather than implemented on spec.
 */

import {
	temporalNullDraws,
	temporalPermPValues,
	temporalPermStat
} from '@veg/hyphaeon-js';

import { TEMPORAL_MESSAGES, TEMPORAL_THRESHOLDS, fillMessage } from './codes.js';

/**
 * Units of work per second, MEASURED through this driver on this machine. See the header's table.
 * It is a floor (x64 Node under Rosetta); a surface that cares should re-measure and record its own.
 */
export const TEMPORAL_PERM_RATE = 9.0e8;

/**
 * The fixed per-grid-point cost of the statistic, in units of one fused multiply-add, FITTED to the
 * two extreme measurements in the header (21.0, rounded from 20.97). The kernel survey's model said
 * 7 from an operation count; the measurement says three times that, and at the acceptance run's
 * rho = 0.043 — where `nnz/C` is only 4.07 — that term is five sixths of the whole cost.
 */
export const TEMPORAL_PERM_STAT_UNITS = 21;

/**
 * Cumulative draw counts the section refines through. The first is D26's guaranteed answer, the last
 * is the reference's own default. Each is admitted only if the cumulative work still fits.
 */
export const TEMPORAL_PERM_ROUNDS = Object.freeze([200, 500, 1000]);

/**
 * The work a whole null may cost before this surface declines to run it: 5.0e10 units, about 55 s at
 * `TEMPORAL_PERM_RATE`. Justified against the latency this report has already accepted for a
 * background section — the digital DMS's own prebake tail is 70 s on HIV1_RT — and against the fact
 * that, unlike a fixed B, an overrun here is recoverable because the section is progressive and
 * cancellable. `Infinity` lifts it (the server and the parity runner do).
 */
export const TEMPORAL_PERM_BUDGET_DEFAULT = 5.0e10;

/** Target wall time per chunk, in ms. Cancel latency and progress cadence; see the header. */
export const TEMPORAL_PERM_CHUNK_TARGET_MS = 200;

/** Chunk bounds. 256 draws is the upper clamp so even a trivially cheap null ticks regularly. */
export const TEMPORAL_PERM_CHUNK_MAX = 256;

/**
 * EWMA weight on the newest chunk's measured rate, once there IS a warm measurement. 0.4 tracks a
 * throttled tab within two chunks.
 *
 * The calibration draw is deliberately NOT folded in with this weight. Draw zero pays the JIT, the
 * CSR build and the first touch of every scratch page, and is 20-50x the warm cost; MEASURED, an
 * EWMA seeded from it took nine chunks to reach full size on the acceptance shape at B = 1000, where
 * three suffice. So the first warm chunk REPLACES the estimate outright and the EWMA starts after
 * that. The numbers are unaffected either way — a chunk boundary is whole draws — but a reader
 * watching a progress bar sees five ticks rather than nine.
 */
const CHUNK_EWMA_ALPHA = 0.4;

/** Let the event loop turn: the only place a worker posts progress and a cancel lands. */
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A sub-millisecond monotonic clock. `Date.now()` has 1 ms granularity, and a draw on the acceptance
 * shape is 0.38 ms — so timing the calibration draw with it reads ZERO, `chunkFor(0)` takes the
 * maximum, and the chunk size stops being calibrated at all. `performance.now()` exists in Node 16+
 * and in every browser this ships to; the fallback is only for an exotic host.
 */
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * The four-line abort helper, written out rather than imported from `predict.js`. That module
 * reaches `feeds.js` and `manifest.js`, and this one deliberately imports nothing but the library
 * and its own sibling vocabulary, so a surface can take the kernel driver without the ONNX surface.
 * The behaviour (`err.name === 'AbortError'`) is identical, because every worker in this app checks
 * that name.
 */
function nullAbortError() {
	const err = new Error('HyphAeon run cancelled');
	err.name = 'AbortError';
	return err;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : nullAbortError();
}

/**
 * How many entries of the candidate attribution matrix are actually multiplied.
 *
 * This is the quantity the budget is computed from, never `C·N`: `leaf_attributions` is
 * `mean_attns * delta_root`, so it is zero at every (codon, sequence) pair where that sequence
 * carries the root residue or an ambiguity, and the kernel skips those. MEASURED on the acceptance
 * run: 1,000 nonzero of 23,370, rho = 0.0428.
 *
 * @param {ArrayLike<number>} candAttrs row-major C*N
 * @param {number} C
 * @param {number} N
 * @returns {number}
 */
export function candidateNnz(candAttrs, C, N) {
	let nnz = 0;
	for (let i = 0; i < C * N; i++) if (candAttrs[i] !== 0) nnz++;
	return nnz;
}

/**
 * `W = B · C · T · (nnz/C + 7)` — the header's cost model, in units, at a given draw count.
 *
 * @param {{B: number, C: number, T: number, nnz: number}} args
 * @returns {number}
 */
export function temporalNullWork({ B, C, T, nnz }) {
	if (!(C > 0) || !(T > 0) || !(B > 0)) return 0;
	return B * C * T * (nnz / C + TEMPORAL_PERM_STAT_UNITS);
}

/**
 * Which draw counts this surface will admit, and the numbers to say so with.
 *
 * The contract is `dmsBudget`'s (`runtime/src/dms.js`): `{work, budget, within, reason}`, plus the
 * schedule the driver will actually follow. `requested` pins the count when a caller names one (the
 * parity runner and the server both do); otherwise the rounds are walked and the largest that fits
 * is taken.
 *
 * @param {{C: number, N: number, T: number, nnz: number, requested?: number|null,
 *   rounds?: readonly number[], workBudget?: number}} args
 * @returns {{rounds: number[], B: number, work: number, budget: number, within: boolean,
 *   reason: string|null, nnz: number, rate: number}}
 */
export function temporalNullBudget({ C, N, T, nnz, requested = null, rounds = TEMPORAL_PERM_ROUNDS, workBudget = TEMPORAL_PERM_BUDGET_DEFAULT }) {
	const budget = Number.isFinite(workBudget) && workBudget > 0 ? workBudget : TEMPORAL_PERM_BUDGET_DEFAULT;
	const base = { budget, nnz, rate: TEMPORAL_PERM_RATE };
	if (!(C > 0)) return { ...base, rounds: [], B: 0, work: 0, within: true, reason: null };

	const explicit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : null;
	const schedule = explicit === null ? Array.from(rounds).filter((b) => b > 0).sort((a, b) => a - b) : [explicit];

	const admitted = [];
	for (const b of schedule) {
		if (temporalNullWork({ B: b, C, T, nnz }) <= budget) admitted.push(b);
		else break;
	}
	if (admitted.length > 0) {
		const B = admitted[admitted.length - 1];
		return { ...base, rounds: admitted, B, work: temporalNullWork({ B, C, T, nnz }), within: true, reason: null };
	}

	// Nothing fits. The floor is the count below which a p-value near the cut is a coin flip
	// (TEMPORAL_THRESHOLDS.permutationsMin); refusing is `W(floor) > budget`.
	const floor = explicit === null ? TEMPORAL_THRESHOLDS.permutationsMin : explicit;
	const work = temporalNullWork({ B: floor, C, T, nnz });
	return {
		...base,
		rounds: [],
		B: 0,
		work,
		within: false,
		reason: fillMessage(TEMPORAL_MESSAGES.NULL_SKIPPED, {
			C,
			B: floor,
			N,
			T,
			work: work.toExponential(2),
			budget: budget.toExponential(2)
		})
	};
}

/**
 * The observed statistic, from the SAME code path the null uses.
 *
 * `v_obs` must not be recomputed by a different route from `v_p`. The reference takes both from
 * separate BLAS calls (temporal.py:648 and 659-660), and at the `>=` tie boundary — which is real
 * here, since a degenerate constant curve puts every draw on `0 >= 0` — a different summation order
 * on the two sides biases the exceedance count systematically. `candCurves` must therefore be the
 * rows `smoothTrajectories` produced at the identity permutation, which is exactly what the library
 * documents that routine's `baseRow` default for.
 *
 * @param {{candCurves: ArrayLike<number>, C: number, T: number, sweepMode: string,
 *   gradT?: ArrayLike<number>|null, normDenseT?: ArrayLike<number>|null}} args
 * @returns {Float64Array}
 */
export function temporalObservedStat({ candCurves, C, T, sweepMode, gradT = null, normDenseT = null }) {
	return temporalPermStat(candCurves, C, T, { sweepMode, gradT, normDenseT });
}

/**
 * Run the date-shuffling null in chunks, reporting progress and honouring a cancel.
 *
 * @param {object} args
 * @param {ArrayLike<number>} args.candAttrs row-major C*N, the attribution rows at the candidates
 * @param {ArrayLike<number>} args.candCurves row-major C*T, the SAME rows smoothed at identity
 * @param {number} args.C
 * @param {number} args.N
 * @param {number} args.T
 * @param {ArrayLike<number>} args.WT taxon-major normalised weights, row-major N*T
 * @param {'episodic'|'fixation'} args.sweepMode
 * @param {ArrayLike<number>|null} [args.gradT]
 * @param {ArrayLike<number>|null} [args.normDenseT]
 * @param {number} [args.seed] default 42, the report's own
 * @param {number|null} [args.permutations] an explicit B; null walks `rounds`
 * @param {readonly number[]} [args.rounds]
 * @param {number} [args.workBudget] `Infinity` lifts the cap
 * @param {number} [args.chunkTargetMs]
 * @param {(payload: object) => void} [args.onProgress] one interim payload per chunk and per round
 * @param {(done: number, total: number, message: string) => void} [args.report] progress line
 * @param {AbortSignal} [args.signal] cancelling keeps the completed draws
 * @returns {Promise<object>} the null block of the record; see `nullPayload`
 */
export async function runTemporalNull({
	candAttrs,
	candCurves,
	C,
	N,
	T,
	WT,
	sweepMode,
	gradT = null,
	normDenseT = null,
	seed = TEMPORAL_THRESHOLDS.seed,
	permutations = null,
	rounds = TEMPORAL_PERM_ROUNDS,
	workBudget = TEMPORAL_PERM_BUDGET_DEFAULT,
	chunkTargetMs = TEMPORAL_PERM_CHUNK_TARGET_MS,
	onProgress = null,
	report = null,
	signal = null
} = {}) {
	const nnz = C > 0 ? candidateNnz(candAttrs, C, N) : 0;
	const plan = temporalNullBudget({ C, N, T, nnz, requested: permutations, rounds, workBudget });

	if (C === 0) {
		return nullPayload({ exceed: new Int32Array(0), requested: 0, completed: 0, plan, seed, vObs: new Float64Array(0), msPerDraw: null, chunks: 0 });
	}
	if (!plan.within) {
		return nullPayload({
			exceed: new Int32Array(C),
			requested: plan.B,
			completed: 0,
			plan,
			seed,
			vObs: temporalObservedStat({ candCurves, C, T, sweepMode, gradT, normDenseT }),
			msPerDraw: null,
			chunks: 0,
			skipped: true
		});
	}

	const vObs = temporalObservedStat({ candCurves, C, T, sweepMode, gradT, normDenseT });
	const exceed = new Int32Array(C);
	const requested = plan.B;
	let completed = 0;
	let cancelled = false;
	let msPerDraw = null;
	let chunks = 0;

	const emit = (final) => {
		if (!onProgress) return;
		onProgress(nullPayload({ exceed, requested, completed, plan, seed, vObs, msPerDraw, chunks, partial: !final }));
	};

	if (report) report(0, requested, `Date-shuffling null: 0 of ${requested} shuffles over ${C} candidate codon(s)...`);

	try {
		for (const roundEnd of plan.rounds) {
			while (completed < roundEnd) {
				throwIfAborted(signal);
				// Draw zero is timed on its own so the first chunk cannot be a minute long; after
				// that the EWMA tracks the machine. Whole draws only: the range boundary is the one
				// place a caller may stop, which is what makes the result independent of the cancel.
				const size = msPerDraw === null ? 1 : chunkFor(msPerDraw, chunkTargetMs);
				const to = Math.min(completed + size, roundEnd);
				const t0 = now();
				temporalNullDraws({
					candAttrs, C, N, T, WT, vObs, sweepMode, gradT, normDenseT,
					seed, fromDraw: completed, toDraw: to, exceed
				});
				const per = (now() - t0) / Math.max(1, to - completed);
				// Chunk 0 is the cold calibration draw and chunk 1 is the first warm measurement;
				// both REPLACE the estimate rather than blending into it (see CHUNK_EWMA_ALPHA).
				msPerDraw = chunks <= 1 ? per : CHUNK_EWMA_ALPHA * per + (1 - CHUNK_EWMA_ALPHA) * msPerDraw;
				completed = to;
				chunks++;
				if (report) {
					report(
						completed,
						requested,
						`Date-shuffling null: ${completed} of ${requested} shuffles, ` +
							`${countAtOrBelow(exceed, completed, TEMPORAL_THRESHOLDS.permAlpha)} candidate sweep(s) so far`
					);
				}
				emit(false);
				await yieldToLoop();
			}
			// A round boundary is its own emit so a page can show the p-values sharpening rather
			// than flickering. It costs nothing: draw b is the same draw at every B (see header).
			emit(completed >= requested);
		}
	} catch (err) {
		// A cancel keeps what was computed; anything else is a real failure and propagates.
		if (err?.name !== 'AbortError' && !signal?.aborted) throw err;
		cancelled = true;
	}

	return nullPayload({ exceed, requested, completed, plan, seed, vObs, msPerDraw, chunks, cancelled });
}

/** Draws per chunk from the measured rate, clamped so a cancel always lands within a chunk. */
export function chunkFor(msPerDraw, targetMs = TEMPORAL_PERM_CHUNK_TARGET_MS) {
	if (!(msPerDraw > 0)) return TEMPORAL_PERM_CHUNK_MAX;
	return Math.max(1, Math.min(TEMPORAL_PERM_CHUNK_MAX, Math.round(targetMs / msPerDraw)));
}

/** The smallest finite entry, or null. */
function minOf(values) {
	let m = Infinity;
	for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
	return Number.isFinite(m) ? m : null;
}

/** How many candidates sit at or below `alpha` at the current draw count — the live sweep count. */
function countAtOrBelow(exceed, completed, alpha) {
	let n = 0;
	for (let c = 0; c < exceed.length; c++) if ((1 + exceed[c]) / (completed + 1) <= alpha) n++;
	return n;
}

/**
 * The null block of the record, in the shape every surface reads.
 *
 * `p` and `q` are always the estimator at the ACHIEVED count, never at the requested one — that is
 * what makes a stopped run a valid null rather than a wrong one — and `grid_step` is printed beside
 * them so a reader can see the resolution they were bought at.
 */
function nullPayload({ exceed, requested, completed, plan, seed, vObs, msPerDraw, chunks, cancelled = false, skipped = false, partial = false }) {
	const C = exceed.length;
	const { p, q, gridStep } = completed > 0 || C === 0
		? temporalPermPValues(exceed, completed)
		: { p: new Float64Array(C).fill(NaN), q: new Float64Array(C).fill(NaN), gridStep: NaN };
	return {
		/** Per candidate, in `candIndices` order. NaN when no draw completed — never 1.0, which is a
		 * real value meaning "tested and never exceeded". */
		p,
		q,
		exceed,
		v_obs: vObs,
		requested,
		completed,
		cancelled,
		skipped,
		partial,
		grid_step: gridStep,
		/** The SMALLEST q-value this run actually produced — the number a page must judge by. */
		q_min: completed > 0 && C > 0 ? minOf(q) : null,
		/**
		 * What Benjamini-Hochberg returns at rank one BEFORE its step-up minimum: `C·p_min` =
		 * `C/(B+1)`, clipped at 1. On the acceptance run that is 246/101 = 2.44, so no candidate's
		 * own rank can put it below 0.10 and only the step-up could — which on that run bottoms out
		 * at 0.4298 for all eighteen confirmed sweeps. It is the cheapest way to say "this draw count
		 * cannot make `q_perm` a decision threshold" without reading the data (TEMPORAL Q11).
		 */
		q_rank1_bound: completed > 0 && C > 0 ? Math.min(1, C / (completed + 1)) : null,
		rounds: plan.rounds,
		work: plan.work,
		budget: plan.budget,
		within: plan.within,
		nnz: plan.nnz,
		reason: plan.reason,
		estimator: 'monte-carlo',
		rng: 'xoshiro256**',
		seed,
		chunks,
		ms_per_draw: msPerDraw,
		rate_assumed: plan.rate
	};
}
