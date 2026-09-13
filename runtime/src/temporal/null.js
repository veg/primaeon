/**
 * null.js — the date-shuffling null, run in chunks a reader can watch and stop.
 *
 * WHY THIS FILE EXISTS. `temporal.py:618-666` is the pillar's stage two: draw a permutation of the
 * sampling dates, re-smooth every candidate codon's attribution against the permuted time axis,
 * take the same statistic, and count how often the shuffled trajectory beats the real one. The
 * ARITHMETIC of that is the library's (`temporalNullDraws`, `temporalPermStat`,
 * `temporalDrawPermutation`, `temporalPermPValues`) and is pure and index-addressed, so that draw
 * `b` is the same draw whoever asks for it. It is NOT allocation-free inside the draw loop, which an
 * earlier writing of this line claimed: every buffer the kernel writes into is hoisted above the
 * loop, but three things are still built per draw — the `Int32Array(N)` of row bases, the
 * `Xoshiro256` its per-draw substream needs, and the gradient coefficient arrays the statistic
 * rebuilds per call. `@veg/hyphaeon-js`'s `temporalNullDraws` names all three and records the
 * measurements that say hoisting them loses. What is left is
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
 * MEASURED, TWICE, AND THE TWO DISAGREE BY 1.7x — which is the single most important thing to know
 * about these constants and is why the shipped rate is not either fit.
 *
 * RUN A (this change). Node 22.22.0, x64 under Rosetta on an Apple-silicon Mac (Apple M4 Pro), five
 * shapes, five isolated processes each, BEST of five, through THIS driver — so with the chunking,
 * the per-chunk CSR rebuild and the `setTimeout(0)` yields the reference's single loop does not pay.
 * One-minute load average at each run recorded and 3.7-5.4 throughout, which is a shared machine and
 * not an idle one. Against `@veg/hyphaeon-js` at `feat/temporal` 37a3d4a plus that branch's
 * `devScratch` change to `temporalPermStat`, which is IN these numbers (it is worth ~8 % on the
 * acceptance shape, so a measurement taken before it would read slower still). The raw run is not
 * committed; the numbers are:
 *
 *     shape                                      B    best     worst    ms/draw  W (k=15)   R best
 *     acceptance  C=246  N=95  T=60  rho=0.045   100     89 ms     95 ms   0.893   2.85e7   3.2e8 *
 *     acceptance  C=246  N=95  T=60  rho=0.045  1000    297 ms    311 ms   0.297   2.85e8   9.6e8
 *     acceptance  C=246  N=95  T=250 rho=0.045  1000    900 ms    980 ms   0.900   1.19e9   1.3e9
 *     mid         C=400  N=256 T=250 rho=0.303   500  4 709 ms  5 360 ms   9.42    4.62e9   9.8e8
 *     large       C=1500 N=256 T=250 rho=0.302   200  7 246 ms  8 814 ms  36.2     6.91e9   9.5e8
 *
 *     * NOT a throughput point: see THE FIXED COST below.
 *
 * Solving for `k` and the rate from the two EXTREME throughput points (acceptance T=60 at B=1000,
 * and large) gives k = 14.925 and 9.53e8 units/s. That pair predicts mid — which it was not fitted
 * to — within 2.9 %, and over-states acceptance at T=250 by 38 %.
 *
 * RUN B (the review of this phase, same machine, isolated processes, best of three, same five
 * shapes). Its measured times were 1.5x ours: mid 8.07 s against our 4.71, large 11.9 s against our
 * 7.25. At k = 15 those imply 5.73e8 and 5.81e8 units/s, and its own refit landed on k ≈ 15.3,
 * R ≈ 5.7e8 — the SAME fixed term to 3 %, a rate 1.7x lower.
 *
 * WHAT THAT MEANS, AND WHAT THE CONSTANTS ARE. `k` is a property of the code and both measurements
 * agree on it. The RATE is a property of the machine's state at the moment of measurement, and this
 * machine varies by 1.7x between one quiet-ish afternoon and another. A constant used to promise a
 * reader a wall time must therefore be a FLOOR under everything anyone has measured, not the best of
 * them — a floor that only holds when the box is idle is not a floor. So:
 *
 *     TEMPORAL_PERM_STAT_UNITS = 15   (fitted 14.925 here, 15.3 at the review; the kernel survey's
 *                                      operation count said 7 and is wrong by a factor of two)
 *     TEMPORAL_PERM_RATE       = 5.5e8 (under BOTH runs: 4 % under run B's 5.73e8, and 1.7-2.4x
 *                                      under run A, so every prediction over-states)
 *
 * PREDICTED AGAINST MEASURED at those two constants — the table the previous version of this header
 * did not have, and the claim it made ("flat across a 100x spread", "5 % under the fit") that the
 * review correctly refused: predictions over-state run A by 1.74x (acceptance T=60 B=1000), 2.40x
 * (acceptance T=250), 1.79x (mid) and 1.73x (large), and run B by 1.04x (mid) and 1.06x (large).
 * The model is NOT flat: at k = 15 the implied rates across run A's four throughput shapes span
 * 9.5e8 to 1.3e9, a 1.38x spread, which is the residual the T = 250 sparse shape leaves behind. It
 * is flatTER than k = 21, where the same four span 1.02e9 to 1.73e9 (1.70x), and that is the whole
 * claim.
 *
 * THE FIXED COST, which no throughput rate can carry. The B = 100 row above is 3x the model's
 * prediction because a null that short is dominated by JIT, the first CSR build and the first touch
 * of every scratch page. Fitting `t = c + B·m` to the two acceptance T = 60 rows gives c = 66 ms and
 * m = 0.231 ms/draw: SIXTY-SIX MILLISECONDS before the first draw is paid for. It does not matter at
 * B >= 1000 (7 % of 297 ms) and it dominates below B ~ 300. `W` is a throughput model and is used
 * for a BUDGET, where under-counting a cheap run is harmless; nothing quotes it as a countdown (the
 * live one uses measured ms/draw).
 *
 * THE MEASUREMENT WINS OVER BOTH PRIOR ESTIMATES AND BOTH ARE RECORDED AS WRONG. The plan's
 * "minutes at realistic sizes" is out by two orders on the demo: the whole null at the REFERENCE'S
 * OWN default of 1,000 draws costs 297 ms on the acceptance shape, against 17.5 s for the single
 * model pass that feeds it. The kernel survey had the wrong fixed term — its `7` under-counts the
 * statistic by a factor of two, which matters precisely in the sparse regime it was measuring. The
 * null is not this pillar's expensive section; the model is, and the report's digital DMS still
 * dwarfs both.
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
 * and progress cadence. MEASURED per-draw times across the shapes above span 0.30 ms (acceptance) to
 * 36.2 ms (large divergent) — a factor of 120 — so a fixed chunk COUNT would be wrong by two orders
 * at one end. Draw zero is timed alone, the chunk is set to `TEMPORAL_PERM_CHUNK_TARGET_MS /
 * msPerDraw` clamped to [1, 256], the first WARM chunk replaces that cold estimate outright, and an
 * EWMA maintains it thereafter so a throttled or contended tab does not stall the cancel. 200 ms
 * gives about five progress ticks a second and bounds the work a cancel throws away at one chunk.
 *
 * MEASURED cost of all of it: driving the kernel through this file rather than calling it once
 * cost 2-8 % when it was last measured against the bare kernel (381 ms against 381, 1 319 against
 * 1 276, 5 414 against 5 071, 8 353 against 7 570), and the review reproduced the same envelope at
 * -6 % to +1 %. Every time in this file's tables is through the driver, so the overhead is IN them,
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
 * to rescue essentially never fires at the report's own caps.
 *
 * HOW RARELY, IN CANDIDATE CODONS — the quantity C is, and the correction to a sentence that used to
 * say "codons" and to quote the survey's `+7` where the shipped constant is
 * `TEMPORAL_PERM_STAT_UNITS = 15`. Refusing is `B · C · T · (nnz/C + 15) > budget`, so
 * `C_crit = budget / (B · T · (rho·N + 15))`. COMPUTED from the shipped constants through
 * `temporalNullBudget` itself (bisection on C; the closed form agrees), at the report's own
 * 256-taxon cap, T = 250 and a dense rho = 0.3:
 *
 *     B = 200  (the default schedule's floor, `permutationsMin`)   first refused at C = 10,894
 *     B = 500                                                      first refused at C =  4,358
 *     B = 1000 (the reference's own default, named explicitly)     first refused at C =  2,179
 *
 * CANDIDATES, NOT CODONS: stage one passed 246 of 4,384 codons on the acceptance run, so at that
 * rate 2,179 candidates is an alignment of roughly 39,000 codons — and at the acceptance run's own
 * measured density (N = 95, rho = 0.0428) the B = 1000 threshold is 10,490 candidates instead.
 * Rare, then, rather than impossible, and rarest on the path a reader actually takes: the browser
 * walks the rounds and so tests at B = 200, while the surfaces that name B = 1000 (the parity runner
 * and the server) lift the cap to `Infinity` anyway. Recorded here so it is not re-discovered rather
 * than implemented on spec.
 */

import {
	temporalNullDraws,
	temporalPermPValues,
	temporalPermStat
} from '@veg/hyphaeon-js';

import { TEMPORAL_MESSAGES, TEMPORAL_THRESHOLDS, fillMessage } from './codes.js';

/**
 * Units of work per second: a middling anchor on an UNLOADED machine, and NOT a floor. An earlier
 * writing of this block called it "a FLOOR under every measurement taken of this driver on this
 * machine"; run C below is that claim's counter-example, and the rule is now the one
 * `web/.../temporal.ts`'s `TEMPORAL_MODEL_RATE` already carries — nothing here may call this
 * conservative, a floor or an upper bound.
 *
 * Run A of the header's table (best of five, five isolated processes per shape, Node 22.22.0 x64
 * under Rosetta on an Apple M4 Pro, one-minute load average 3.7-5.4) implies 9.5e8-1.3e9; run B,
 * the review's, implies 5.73e8 and 5.81e8 on the same machine and shapes. 5.5e8 sits under both.
 *
 * RUN C (the final check of this phase, same machine and driver, one isolated process per row,
 * three rows per shape, one-minute load average 10-36 throughout — other agents building and
 * testing on the same cores, which is the ordinary state of this box and not an aberration):
 *
 *     shape                                       B     ms per run            implied units/s
 *     acceptance  C=246 N=95  T=60  rho=0.0488   1000    321 /  303 /   325   9.02 / 9.58 / 8.93 e8
 *     acceptance  C=246 N=95  T=250 rho=0.0488   1000   1007 /  964 /   926   1.20 / 1.25 / 1.30 e9
 *     mid         C=400 N=256 T=250 rho=0.313     500   4863 / 5836 / 13254   9.79 / 8.16 / 3.59 e8
 *     large       C=1500 N=256 T=250 rho=0.312    200  16352 /18860 / 14100   4.35 / 3.78 / 5.05 e8
 *     acceptance  C=246 N=95  T=60  rho=0.0488    100     97 /  101 /    99   2.99 / 2.89 / 2.93 e8 *
 *
 *     * the fixed-cost row again, not a throughput point: see THE FIXED COST in the header.
 *
 * FOUR of the six dense-shape runs are BELOW 5.5e8 — 3.59e8 at worst, which makes a prediction at
 * this constant 1.5x optimistic. The sparse shapes stay at 8.9e8-1.3e9 in the same session, so what
 * moves is the machine and the density, not the model: `k` is stable and the rate is not.
 *
 * THE CONSTANT STAYS AT 5.5e8 ANYWAY, deliberately. It converts a WORK budget into a sentence and
 * bounds nothing itself; lowering it to cover a contended machine would over-state the wait for
 * every reader on an idle one, which is the same trade `TEMPORAL_MODEL_RATE` settled the same way.
 * What changed is what may be SAID about it: the surfaces quoting it call it "the rate this build
 * measured on its own development machine" and claim no bound.
 *
 * THE BROWSER FIGURE THIS BLOCK USED TO CARRY WAS ARITHMETICALLY WRONG and is corrected here rather
 * than repeated: the review clocked 1.12 ms/draw at C = 247, N = 95, T = 250 in Chromium, and at
 * this model that draw is 247·250·(nnz/C + 15) ≈ 1.18e6 units, so 1.12 ms is about **1.0e9** units/s
 * — not the "about 5e9" the old line claimed, and not faster than run C's own 1.2-1.3e9 at the same
 * shape under Node. There is no measurement here saying a browser is quicker than Node at this
 * kernel, so this block no longer says one.
 */
export const TEMPORAL_PERM_RATE = 5.5e8;

/**
 * The fixed per-grid-point cost of the statistic, in units of one fused multiply-add, FITTED to the
 * two extreme throughput measurements in the header: 14.925 on run A, 15.3 on the review's run B.
 * `k` is a property of the code rather than of the machine, which is why two runs 1.7x apart in rate
 * agree on it to 3 %. The kernel survey's model said 7 from an operation count; the measurement says
 * twice that, and at the acceptance run's rho = 0.045 — where `nnz/C` is only 4.28 — that term is
 * more than three quarters of the whole cost.
 */
export const TEMPORAL_PERM_STAT_UNITS = 15;

/**
 * Cumulative draw counts the section refines through. The first is D26's guaranteed answer, the last
 * is the reference's own default. Each is admitted only if the cumulative work still fits.
 */
export const TEMPORAL_PERM_ROUNDS = Object.freeze([200, 500, 1000]);

/**
 * The work a whole null may cost before this surface declines to run it: 5.0e10 units.
 *
 * IN SECONDS, at the rate above: **91 s**, and that is the number to quote a reader — but as an
 * anchor, not as a bound, because `TEMPORAL_PERM_RATE` is not a floor (see its own block). On the
 * machine's faster state (run A, 9.5e8) the same cap is 53 s; on run B's 5.7e8 it is 88 s; at run
 * C's worst dense measurement on a loaded box (3.59e8) it is 139 s. The previous "about 55 s" here
 * was the faster state quoted as if it were the promise, and the "because it is a floor" that
 * replaced it was the same error one level up.
 *
 * The CAP is unchanged at 5.0e10 and is deliberately in WORK, not in seconds: a work cap refuses the
 * same runs on every machine, which is what makes a record comparable across surfaces, and the rate
 * only ever converts it for a sentence. Justified against the latency this report has already
 * accepted for a background section — the digital DMS's own prebake tail is 70 s on HIV1_RT — and
 * against the fact that, unlike a fixed B, an overrun here is recoverable because the section is
 * progressive and cancellable. It essentially never fires: at the report's own 256-taxon cap, with
 * T = 250 and a dense nonzero fraction rho = 0.3, refusing takes 10,894 CANDIDATE codons on the
 * default schedule (which tests at B = 200) and 2,179 at an explicit B = 1000 — candidates, not
 * codons, and stage one passed 246 of 4,384 on the acceptance run. The header's table has the
 * arithmetic and how it was computed. `Infinity` lifts it (the server and the parity runner do).
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
 * `W = B · C · T · (nnz/C + TEMPORAL_PERM_STAT_UNITS)` — the header's cost model, in units, at a
 * given draw count. The fixed term is the CONSTANT, never a literal: it was 7 in the kernel survey's
 * operation count and is 15 at the measurements in the header, and a JSDoc that spells it out goes stale
 * the first time it is refitted.
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
