/**
 * run.js — the one call the `/time` page, the MCP and the server make for temporal selection: an
 * alignment, a session and a set of dates in, per-codon selection trajectories and a four-way
 * classification out.
 *
 * WHY THIS FILE EXISTS. `runMeme` is to `cmd_meme` what this is to `run_temporal_surveillance`
 * (hyphaeon/temporal.py:399-905, at engine tag `phase-5c`): the phase order, the refusals, the
 * progress reporting, the cancellation and the provenance, with every number coming from
 * `@veg/hyphaeon-js`. The reference is one 500-line function that interleaves model loading,
 * alignment preparation, printing, CSV writing and matplotlib with about a dozen numeric steps;
 * `js/src/temporal.js` is those numeric steps and this is everything else. The chain, and the
 * reference line each step mirrors:
 *
 *   S0  regime          temporal.py:430-441  `resolveTemporalRegime`    — units -> sweep mode, duplicate policy
 *   S2  alignment       temporal.py:453-461  the caller's `prepareRun`  — parse, collapse, cap, tree or TN93, MDS
 *   S3  dates           temporal.py:463-484  the caller's, from `runtime/src/dates/`, filtered to float32
 *   S4  bandwidth       temporal.py:486-495  `resolveTemporalBandwidth` — 5 % of the span, clamped
 *   S5  root            temporal.py:497-503  `inferRootSequence`        — a named taxon, else the earliest consensus
 *   S6  inference       temporal.py:505-523  `inferSites`               — ONE pass; nothing re-enters the graph
 *   S7  static          temporal.py:525-532  `pvalsFromLrtSelfLiang` + BH over the VARIABLE subset
 *   S8  attribution     temporal.py:534-540  `directionalAttribution`   — attention x "differs from root"
 *   S9  smoothing       temporal.py:542-549  `nadarayaWatsonWeights`, `smoothTrajectories`
 *   S10 metric          temporal.py:551-582  `sweepMetric`, `temporalTrajectoryStatistics`
 *   S11 widths          temporal.py:584-597  (the same call)
 *   S12 stage one       temporal.py:599-616  `resolveEnergyFloors`, `stageOneMask`
 *   S14 shape gate      temporal.py:667-679  `fpcaShapeGate`            — a thin SVD that never forms U
 *   S13 the null        temporal.py:618-666  `./null.js`                — chunked, cancellable, progressive
 *   S15 confirmation    temporal.py:681-697  `confirmSweeps`            — incl. the unrecorded escape hatch
 *   S16 classification  temporal.py:699-716  `classifyTemporalSites`
 *   S17 waves           temporal.py:718-741  `temporalWaveDecomposition`
 *   S18 labels          temporal.py:743-760  `temporalMutationLabels`
 *   S19 the files       temporal.py:762-905  `./results.js` over the library's byte-equal writers
 *
 * ONE DELIBERATE REORDERING, WHICH CHANGES NO NUMBER. The reference runs the null (618-666) before
 * the shape gate (667-679); this file runs the gate first. They are independent — `r2_fpca` does not
 * read `p_perm`, and `is_confirmed_sweep` needs both — and the gate is an O(T^3) eigenproblem that
 * finishes in milliseconds while the null is the section's only long wait. Running it first lets a
 * page show the trajectories, the candidate set and the wave shapes within a second, with the sweep
 * labels arriving last. Recorded as an app-side reordering because a reader diffing against the
 * reference will see the print order differ.
 *
 * THE ONE REAL DIVERGENCE THE APPLICATION HAS TO DECIDE: `scoreInvariableSites`. The reference sends
 * EVERY codon through the model, invariable ones included (temporal.py:512) — 4,384 forward rows
 * against our meme pass's 273 on the acceptance alignment, a 16x inference cost for columns at
 * codons the pillar itself labels INVARIABLE. What actually depends on those rows is `lrt` and
 * `p_static` AT those codons and nothing else: `q_static`'s Benjamini-Hochberg runs over the
 * variable subset alone (temporal.py:529), `stage1_mask` is `~inv & ...`, and under a consensus root
 * `delta_root` is identically zero at an invariable codon, so its curve, velocity, peak, width, area
 * and wave loadings are exactly zero whatever the attention was. So the default is `true` on the
 * node, parity, MCP and server surfaces — the fixture reproduces bit for bit — and a browser that
 * chains this onto an existing analyze pass may set it `false`, in which case `lrt` and `p_static`
 * at those codons are reported ABSENT (NaN, which the writers emit as pandas' own empty cell) and
 * NEVER zero-filled, the provenance records it, and the page says which codons carry no static
 * score. `feeds.js`'s `dropped_heads_policy: "omit"` is the same rule one layer down.
 *
 * THE ONE CONFIGURATION IN WHICH THAT IS NOT SAFE, and the reason this file forces the flag back on:
 * with an EXPLICIT root taxon carrying gaps, `root_indices` becomes 0 = ALANINE at every gapped
 * position (temporal.py:355, upstream bug TEMPORAL Q2), so `delta_root` is 1 for every sequence
 * carrying anything else — including at invariable codons, which then acquire nonzero curves, peaks,
 * areas and loadings. That is the only configuration in which the model's outputs at invariable
 * codons matter at all, so `rootTaxon` pins `scoreInvariableSites` to `true` and says why.
 *
 * WHAT THIS FILE REFUSES TO DO. There is no date ingestion here: `runtime/src/dates/` owns the
 * delimiter sniffing, the Auspice walk, the column discovery and the rule table, because that layer
 * is deliberately WIDER than `temporal.py:73-330` (D31) and the difference is a sentence a reader
 * must be shown, not a number. This file takes dates already resolved against `loaded.taxa`, counts
 * how many of them were read by a rule the reference's own parser does not have, and puts that count
 * on the record as `dates.beyond_reference` so no surface can quietly benefit from it.
 *
 * COST, MEASURED on this machine (Node 22 under Rosetta, 8 intra-op threads, `general.onnx`) on the
 * acceptance run — 100 sequences x 4,384 codons, 95 dated, 246 candidates, T = 60:
 *
 *     the model pass, all 4,384 codons          17.5 s      (35 forward calls at batch 128)
 *     everything from attention to stage one     0.16 s
 *     the shape gate and the wave decomposition  0.01 s
 *     the null at B = 100 (the fixture's own)    0.024 s
 *     the null at B = 1000 (the reference's)     0.243 s
 *
 * The null is not this pillar's expensive section and the plan's estimate of it was two orders out;
 * see `null.js`'s header for the measurement and the corrected cost model. The model pass is the
 * cost, `scoreInvariableSites: false` removes 94 % of it, and the report's digital DMS still dwarfs
 * both.
 */

import {
	benjaminiHochberg,
	classifyTemporalSites,
	confirmSweeps,
	directionalAttribution,
	fpcaShapeGate,
	inferRootSequence,
	nadarayaWatsonWeights,
	pvalsFromLrtSelfLiang,
	resolveEnergyFloors,
	resolveTemporalBandwidth,
	resolveTemporalRegime,
	smoothTrajectories,
	stageOneMask,
	sweepMetric,
	taxonMajorWeights,
	temporalMutationLabels,
	temporalTimeGrid,
	temporalTrajectoryStatistics,
	temporalWaveDecomposition,
	TEMPORAL_UNKNOWN_AA,
	WAVE_GAP_THRESHOLD
} from '@veg/hyphaeon-js';

import { report } from '../pipeline.js';
import { inferSites, throwIfAborted } from '../predict.js';
import {
	TEMPORAL_BEYOND_REFERENCE_RULES,
	TEMPORAL_MESSAGES,
	TEMPORAL_REFUSALS,
	TEMPORAL_THRESHOLDS,
	fillMessage,
	nameSample,
	sortTemporalWarnings,
	temporalWarning
} from './codes.js';
import { runTemporalNull } from './null.js';
import { temporalRecord } from './record.js';

/** `--sweep-mode` (temporal.py:427). */
export const TEMPORAL_SWEEP_MODES = Object.freeze(['auto', 'episodic', 'fixation']);

/** `--time-units` (temporal.py:426). */
export const TEMPORAL_TIME_UNITS = Object.freeze(['years', 'generations', 'days', 'arbitrary']);

/** The refusal shape every surface reads: never thrown, always returned. */
function refuse(code, message, data = {}, warnings = []) {
	return {
		ok: false,
		analysis: 'temporal',
		refusal: code,
		message,
		data,
		warnings: sortTemporalWarnings([...warnings, temporalWarning(code, 'refuse', message, data)])
	};
}

/**
 * Dates against `loaded.taxa`, whatever shape the caller has them in.
 *
 * Three are accepted because three exist in this repository already: the date layer's `DateIngest`
 * (what `/time` holds), a plain vector in taxon order (what `alignDatesToRun` returns), and a map
 * (what an MCP argument or a server JSON body is). The RULE table only survives the first, which is
 * why `beyond_reference` is null rather than zero for the other two — an unknown provenance must not
 * be reported as a clean one.
 *
 * @param {*} dates
 * @param {readonly string[]} taxa
 * @returns {{vector: Float64Array, byRule: Record<string, number>|null, source: string|null}}
 */
export function resolveTemporalDates(dates, taxa) {
	const n = taxa.length;
	if (dates && Array.isArray(dates.rows) && typeof dates.schema_version === 'number') {
		const byTaxon = new Map(dates.rows.map((r) => [r.taxon, r.value]));
		const vector = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const v = byTaxon.get(taxa[i]);
			vector[i] = v === undefined ? NaN : v;
		}
		return { vector, byRule: dates.by_rule ?? null, source: dates.source ?? null };
	}
	if (dates instanceof Map || (dates && typeof dates === 'object' && !ArrayBuffer.isView(dates) && !Array.isArray(dates))) {
		const byTaxon = dates instanceof Map ? dates : new Map(Object.entries(dates));
		const vector = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const v = byTaxon.get(taxa[i]);
			vector[i] = v === undefined || v === null ? NaN : Number(v);
		}
		return { vector, byRule: null, source: 'map' };
	}
	const list = Array.from(dates ?? []);
	if (list.length !== n) {
		throw new Error(
			`runTemporal: the date vector has ${list.length} entries and the run kept ${n} sequences. ` +
				'Pass a DateIngest, a taxon->value map, or a vector in `loaded.taxa` order.'
		);
	}
	return { vector: Float64Array.from(list, (v) => (v === null || v === undefined ? NaN : Number(v))), byRule: null, source: 'vector' };
}

/** How many of the dates came from a rule `temporal.parse_temporal_metadata` does not have. */
function beyondReference(byRule) {
	if (!byRule) return null;
	const rules = {};
	let count = 0;
	for (const rule of TEMPORAL_BEYOND_REFERENCE_RULES) {
		const n = byRule[rule] ?? 0;
		if (n > 0) {
			rules[rule] = n;
			count += n;
		}
	}
	return { count, rules };
}

/**
 * `run_temporal_surveillance` over a loaded alignment and a loaded session.
 *
 * @param {object} args
 * @param {object} args.loaded the library's `LoadedAlignment` (from `prepareRun`)
 * @param {*} args.dates a `DateIngest`, a taxon->value map, or a vector in `loaded.taxa` order
 * @param {{session: any, ort: any}} [args.session] a `loadSession` handle; required unless `predict`
 * @param {Function} [args.predict] test seam: `(sites) => {lrt, mean_root_attns}`; see `inferForRun`
 * @param {object} [args.options]
 * @param {string} [args.options.timeUnits] `years` (default) | generations | days | arbitrary
 * @param {string} [args.options.sweepMode] `auto` (default) | episodic | fixation
 * @param {boolean} [args.options.keepDuplicates] informational here: the collapse happened in `prepareRun`
 * @param {number} [args.options.numTimePoints] `--time-points`, default 250
 * @param {number|null} [args.options.bandwidth] `-bw`, default auto
 * @param {number|null} [args.options.permutations] `-B`; null walks `TEMPORAL_PERM_ROUNDS`
 * @param {number} [args.options.permAlpha] default 0.05
 * @param {number} [args.options.minR2Fpca] default 0.35
 * @param {number|null} [args.options.tauPeak] default 1e-4 — see upstream bug TEMPORAL Q1
 * @param {number|null} [args.options.tauAuc] default null (derived from the timespan)
 * @param {string|null} [args.options.rootTaxon] `--root-taxon`
 * @param {Record<number,string>|null} [args.options.domainMap] 1-based codon -> domain name
 * @param {number} [args.options.seed] default 42
 * @param {boolean} [args.options.scoreInvariableSites] default true; see the header
 * @param {'canonical'|'lapack'} [args.options.waveSign] default 'canonical' (D28)
 * @param {number} [args.options.workBudget] the null's cap; `Infinity` lifts it
 * @param {number} [args.options.batchSize] sites per forward call
 * @param {{alignment?: string|null, tree?: string|null, dates?: string|null}} [args.inputs] names for the record
 * @param {object} [args.provenance] overrides merged into the record's `primaeon` block
 * @param {(payload: object) => void} [args.onProgress] interim section payloads, one per stage and
 *   one per null chunk, exactly as `runDms` publishes per slab
 * @param {Function} [args.progress] `(phase, done, total, message)`
 * @param {AbortSignal} [args.signal] cancelling the null keeps everything upstream of it
 * @returns {Promise<object>} the `TemporalRecord`, or `{ok: false, refusal, message}`
 */
export async function runTemporal({
	loaded,
	dates,
	session = null,
	predict = null,
	options = {},
	inputs = {},
	provenance = {},
	onProgress = null,
	progress = null,
	signal = null
} = {}) {
	if (!loaded || !loaded.a || !Number.isInteger(loaded.L)) {
		throw new Error('runTemporal: pass the library LoadedAlignment as `loaded`');
	}
	const started = Date.now();
	const { L, N: nTaxa, taxa } = loaded;
	/** @type {Array<object>} */
	const warnings = [];

	// --- S0: the regime switches (temporal.py:430-441) -------------------------------------------
	const regime = resolveTemporalRegime({
		timeUnits: options.timeUnits ?? 'years',
		sweepMode: options.sweepMode ?? 'auto',
		keepDuplicates: options.keepDuplicates === true
	});
	if (regime.nonCalendar) {
		warnings.push(
			temporalWarning('TEMPORAL_UNITS_NOT_CALENDAR', 'info', fillMessage(TEMPORAL_MESSAGES.UNITS_NOT_CALENDAR, { units: regime.timeUnits }), {
				time_units: regime.timeUnits,
				sweep_mode: regime.sweepMode
			})
		);
	}
	// The collapse already happened, in `prepareRun`, which is where the taxon set is decided. This
	// layer can only say what it cost, and for surveillance data it is a real hazard: identical
	// haplotypes sampled on DIFFERENT DAYS collapse to one sequence carrying one date, which
	// silently deletes time points. `prune_dups` is the reference's own default on the calendar path
	// (temporal.py:441).
	const collapsed = loaded.notices?.duplicatesCollapsed ?? 0;
	if (collapsed > 0 && regime.pruneDuplicates) {
		warnings.push(
			temporalWarning('TEMPORAL_DUPLICATES_COLLAPSED', 'warn', fillMessage(TEMPORAL_MESSAGES.DUPLICATES_COLLAPSED, { count: collapsed, kept: nTaxa }), {
				collapsed,
				kept: nTaxa
			})
		);
	}

	// --- S3: the date filter (temporal.py:463-484) ------------------------------------------------
	const resolved = resolveTemporalDates(dates, taxa);
	// FLOAT32, and it is load-bearing: the reference casts at temporal.py:468, so `t_min` and `t_max`
	// are float64 OF FLOAT32 VALUES (2009.2490234375, not 2009.249) and every grid point, kernel
	// weight and exported date inherits that rounding. A port that stayed in float64 would miss the
	// whole time axis in the seventh digit.
	const allDates = Float32Array.from(resolved.vector);
	/** @type {number[]} */
	const validIdx = [];
	for (let i = 0; i < nTaxa; i++) if (!Number.isNaN(allDates[i])) validIdx.push(i);
	const validTaxaIndices = Int32Array.from(validIdx);
	const N = validTaxaIndices.length;
	const taxaDates = Float32Array.from(validTaxaIndices, (i) => allDates[i]);

	if (N === 0) {
		return refuse(TEMPORAL_REFUSALS.NO_DATES, TEMPORAL_MESSAGES.NO_DATES, { dated: 0, taxa: nTaxa }, warnings);
	}
	if (N < TEMPORAL_THRESHOLDS.minDatedTaxa) {
		return refuse(
			TEMPORAL_REFUSALS.TOO_FEW_DATED,
			fillMessage(TEMPORAL_MESSAGES.TOO_FEW_DATED, { min: TEMPORAL_THRESHOLDS.minDatedTaxa, dated: N }),
			{ dated: N, taxa: nTaxa, min: TEMPORAL_THRESHOLDS.minDatedTaxa },
			warnings
		);
	}
	let tMin = Infinity;
	let tMax = -Infinity;
	const seen = new Map();
	for (const v of taxaDates) {
		if (v < tMin) tMin = v;
		if (v > tMax) tMax = v;
		seen.set(v, (seen.get(v) ?? 0) + 1);
	}
	const timespan = tMax - tMin;
	if (!(timespan > 0)) {
		return refuse(TEMPORAL_REFUSALS.NO_TIME_SPAN, fillMessage(TEMPORAL_MESSAGES.NO_TIME_SPAN, { value: tMin }), { t_min: tMin, t_max: tMax }, warnings);
	}

	const undated = taxa.filter((_, i) => Number.isNaN(allDates[i]));
	if (undated.length > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_UNDATED_TAXA', 'warn', fillMessage(TEMPORAL_MESSAGES.UNDATED_TAXA, { count: undated.length, total: nTaxa, sample: nameSample(undated) }), {
				count: undated.length,
				names: undated.slice(0, 12)
			})
		);
	}
	const beyond = beyondReference(resolved.byRule);
	if (beyond && beyond.count > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_DATES_BEYOND_REFERENCE', 'warn', fillMessage(TEMPORAL_MESSAGES.DATES_BEYOND_REFERENCE, { count: beyond.count, dated: N, rules: Object.keys(beyond.rules).join(', ') }), beyond)
		);
	}
	let tied = 0;
	for (const n of seen.values()) if (n > tied) tied = n;
	if (seen.size < N / 2) {
		warnings.push(
			temporalWarning('TEMPORAL_DATES_TIED', 'info', fillMessage(TEMPORAL_MESSAGES.DATES_TIED, { tied, unique: seen.size, dated: N }), { tied, unique: seen.size, dated: N })
		);
	}

	// --- S4: the bandwidth (temporal.py:486-495) --------------------------------------------------
	const T = Math.max(2, Math.floor(options.numTimePoints ?? TEMPORAL_THRESHOLDS.timePointsDefault));
	const bandwidth = resolveTemporalBandwidth(timespan, {
		timeUnits: regime.timeUnits,
		bandwidth: options.bandwidth ?? null,
		numTimePoints: T
	});
	const auto = !(Number.isFinite(options.bandwidth) && options.bandwidth > 0);
	if (auto && regime.timeUnits === 'years' && Math.abs(bandwidth - timespan * 0.05) > 1e-12) {
		warnings.push(
			temporalWarning('TEMPORAL_BANDWIDTH_CLAMPED', 'info', fillMessage(TEMPORAL_MESSAGES.BANDWIDTH_CLAMPED, {
				bandwidth: bandwidth.toPrecision(3),
				unit: regime.unitLabel,
				edge: bandwidth > timespan * 0.05 ? 'floor' : 'ceiling',
				timespan: timespan.toPrecision(3)
			}), { bandwidth, timespan, five_percent: timespan * 0.05 })
		);
	}
	const { denseT, normDenseT, gradT } = temporalTimeGrid(tMin, tMax, T, regime.nonCalendar);

	// --- S5: the root (temporal.py:497-503) -------------------------------------------------------
	// `a_valid` is the AA token matrix over the DATE-FILTERED sequences: [L, N], site-major, exactly
	// `a.squeeze(-1)[:, valid_taxa_mask]` (temporal.py:503).
	const aValid = new Int32Array(L * N);
	for (let s = 0; s < L; s++) {
		const src = s * nTaxa;
		const dst = s * N;
		for (let j = 0; j < N; j++) aValid[dst + j] = loaded.a[src + validTaxaIndices[j]];
	}
	const rootTaxon = options.rootTaxon ?? null;
	const root = inferRootSequence({ aValid, L, N, taxa, validTaxaIndices, taxaDates, rootTaxon });
	if (rootTaxon && root.source !== 'root-taxon') {
		warnings.push(
			temporalWarning('TEMPORAL_ROOT_TAXON_NOT_FOUND', 'warn', fillMessage(TEMPORAL_MESSAGES.ROOT_TAXON_NOT_FOUND, { name: rootTaxon }), { requested: rootTaxon, used: root.source })
		);
	}
	/** Upstream bug TEMPORAL Q2: how many positions of an explicit root are a gap read as Alanine. */
	let rootUnknown = 0;
	if (root.source === 'root-taxon') {
		const col = validTaxaIndices.indexOf(taxa.indexOf(rootTaxon));
		if (col >= 0) for (let s = 0; s < L; s++) if (aValid[s * N + col] >= TEMPORAL_UNKNOWN_AA) rootUnknown++;
		if (rootUnknown > 0) {
			warnings.push(
				temporalWarning('TEMPORAL_ROOT_UNKNOWN_RESIDUES', 'warn', fillMessage(TEMPORAL_MESSAGES.ROOT_UNKNOWN_RESIDUES, { count: rootUnknown, name: rootTaxon }), {
					count: rootUnknown,
					root_taxon: rootTaxon,
					upstream: 'TEMPORAL Q2 (temporal.py:355)'
				})
			);
		}
	}

	// --- S6: the one inference pass (temporal.py:505-523) -----------------------------------------
	// An explicit root with gaps makes the model's outputs at invariable codons load-bearing (Q2,
	// see the header), so the flag is pinned back on rather than honoured.
	const wantInvariable = root.source === 'root-taxon' ? true : options.scoreInvariableSites !== false;
	const forcedInvariable = root.source === 'root-taxon' && options.scoreInvariableSites === false;
	/** @type {number[]} */
	const siteList = [];
	for (let s = 0; s < L; s++) if (wantInvariable || !loaded.invariable[s]) siteList.push(s);
	const siteIndices = Int32Array.from(siteList);
	const scored = new Uint8Array(L);
	for (const s of siteIndices) scored[s] = 1;

	report(progress, 'temporal-infer', 0, siteIndices.length, `Scoring ${siteIndices.length} codon(s)...`);
	const inferred = predict
		? await predict({ loaded, siteIndices, options, signal })
		: await inferSites(loaded, sessionHandleOf(session), {
				siteIndices,
				outputs: ['lrt', 'mean_root_attns'],
				batchSize: options.batchSize,
				signal,
				onProgress: (done, total) => report(progress, 'temporal-infer', done, total, `Scoring codons: ${done} of ${total}...`)
			});
	throwIfAborted(signal);
	if (!inferred?.mean_root_attns) {
		throw new Error(
			'runTemporal: the graph returned no `mean_root_attns`. This pillar reads the root attention ' +
				'row at every codon; a two-output export cannot run it.'
		);
	}

	/** `lrts` at every codon; NaN — never 0 — where the model was not asked (see the header). */
	const lrts = new Float32Array(L);
	for (let s = 0; s < L; s++) lrts[s] = scored[s] ? inferred.lrt[s] : NaN;
	const attnWidth = inferred.mean_root_attns.dims[1];
	const meanAttns = new Float32Array(L * N);
	for (let s = 0; s < L; s++) {
		const src = s * attnWidth;
		const dst = s * N;
		for (let j = 0; j < N; j++) meanAttns[dst + j] = inferred.mean_root_attns.data[src + validTaxaIndices[j]];
	}
	let unscored = 0;
	for (let s = 0; s < L; s++) if (!scored[s]) unscored++;
	if (unscored > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_INVARIABLE_SITES_UNSCORED', 'info', fillMessage(TEMPORAL_MESSAGES.INVARIABLE_SITES_UNSCORED, { count: unscored }), { count: unscored })
		);
	}
	if (forcedInvariable) {
		warnings.push(
			temporalWarning('TEMPORAL_ROOT_UNKNOWN_RESIDUES', 'info', 'Every codon was scored because an explicit root taxon was named: with one, the attention at an invariable codon is no longer multiplied by zero (upstream bug TEMPORAL Q2).', { root_taxon: rootTaxon })
		);
	}

	// --- S7: the static baseline (temporal.py:525-532) --------------------------------------------
	const pStatic = pvalsFromLrtSelfLiang(lrts);
	const qStatic = new Float32Array(L).fill(1);
	/** @type {number[]} */
	const varIdx = [];
	for (let s = 0; s < L; s++) if (!loaded.invariable[s]) varIdx.push(s);
	if (varIdx.length > 0) {
		const q = benjaminiHochberg(Float64Array.from(varIdx, (s) => pStatic[s]));
		for (let i = 0; i < varIdx.length; i++) qStatic[varIdx[i]] = q[i];
	}
	let nSigStatic = 0;
	for (let s = 0; s < L; s++) if (qStatic[s] <= TEMPORAL_THRESHOLDS.qStaticCut) nSigStatic++;
	if (nSigStatic === 0 && varIdx.length > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_STATIC_NONE_SIGNIFICANT', 'info', fillMessage(TEMPORAL_MESSAGES.STATIC_NONE_SIGNIFICANT, { cut: TEMPORAL_THRESHOLDS.qStaticCut, family: varIdx.length }), {
				family: varIdx.length,
				cut: TEMPORAL_THRESHOLDS.qStaticCut
			})
		);
	}

	// --- S8-S11: attribution, smoothing, metric, peaks and widths (temporal.py:534-597) ------------
	report(progress, 'temporal-smooth', 0, 1, 'Anchoring attention to the root and smoothing along the dates...');
	const attr = directionalAttribution(meanAttns, aValid, root.rootIndices, L, N);
	const W = nadarayaWatsonWeights(denseT, taxaDates, bandwidth);
	const WT = taxonMajorWeights(W, T, N);
	const curves = smoothTrajectories(attr, L, N, WT, T);
	const metric = sweepMetric(curves, L, T, { sweepMode: regime.sweepMode, gradT });
	const stats = temporalTrajectoryStatistics({
		curves, metric, L, T, denseT, normDenseT, gradT, sweepMode: regime.sweepMode, meanAttns, N
	});
	throwIfAborted(signal);

	// --- S12: the energy floors and stage one (temporal.py:599-616) --------------------------------
	const floors = resolveEnergyFloors({
		timespan,
		nonCalendar: regime.nonCalendar,
		tauPeak: options.tauPeak === undefined ? TEMPORAL_THRESHOLDS.tauPeak : options.tauPeak,
		tauAuc: options.tauAuc === undefined ? null : options.tauAuc
	});
	if (floors.tauPeakOverridden && options.tauPeak !== undefined) {
		warnings.push(
			temporalWarning('TEMPORAL_TAU_PEAK_OVERRIDDEN', 'warn', fillMessage(TEMPORAL_MESSAGES.TAU_PEAK_OVERRIDDEN, { supplied: options.tauPeak, resolved: floors.tauPeak }), {
				supplied: options.tauPeak,
				resolved: floors.tauPeak,
				upstream: 'TEMPORAL Q1 (temporal.py:604, 610)'
			})
		);
	}
	const { mask, candIndices } = stageOneMask(loaded.invariable, stats.peakIntensities, stats.aucs, floors.tauPeak, floors.tauAuc);
	const C = candIndices.length;
	report(progress, 'temporal-smooth', 1, 1, `${C} candidate codon(s) passed the sweep-energy floor`);

	const labels = temporalMutationLabels({ aValid, L, N, rootIndices: root.rootIndices, rootAas: root.rootAas, domainMap: options.domainMap ?? null });

	/** The payload after stage one: everything deterministic, with the null not yet run. */
	const scoredPayload = () =>
		temporalRecord({
			stage: 'scored', loaded, inputs, options, provenance, regime, root, labels, floors, warnings,
			L, nTaxa, N, T, taxa, validTaxaIndices, taxaDates, tMin, tMax, timespan, bandwidth, denseT,
			lrts, pStatic, qStatic, nSigStatic, scored, varCount: varIdx.length,
			curves, stats, mask, candIndices, dates: { ...resolved, beyond, undated: undated.length },
			nullBlock: null, r2: null, gate: null, confirm: null, cls: null, waves: null,
			elapsedSec: (Date.now() - started) / 1000
		});
	if (onProgress) onProgress(scoredPayload());

	if (C === 0) {
		warnings.push(
			temporalWarning('TEMPORAL_NO_CANDIDATES', 'info', fillMessage(TEMPORAL_MESSAGES.NO_CANDIDATES, { tauPeak: floors.tauPeak, tauAuc: floors.tauAuc }), floors)
		);
	}

	// --- S14 BEFORE S13: the shape gate (temporal.py:667-679; see the header on the reordering) ----
	const r2 = new Float32Array(L);
	/** @type {ReturnType<typeof fpcaShapeGate>|null} */
	let gate = null;
	const candMetric = new Float64Array(C * T);
	const candCurves = new Float64Array(C * T);
	const candAttrs = new Float32Array(C * N);
	for (let i = 0; i < C; i++) {
		const s = candIndices[i];
		candMetric.set(stats.velocity.subarray(s * T, s * T + T), i * T);
		candCurves.set(curves.subarray(s * T, s * T + T), i * T);
		candAttrs.set(attr.subarray(s * N, s * N + N), i * N);
	}
	if (C >= 2) {
		gate = fpcaShapeGate(candMetric, C, T, { kMax: TEMPORAL_THRESHOLDS.waveCount, waveSign: options.waveSign ?? 'canonical' });
		for (let i = 0; i < C; i++) r2[candIndices[i]] = gate.r2[i];
		if (gate.vacuous) {
			warnings.push(temporalWarning('TEMPORAL_GATE_VACUOUS', 'warn', TEMPORAL_MESSAGES.GATE_VACUOUS, { candidates: C, k_eff: gate.kEff, upstream: 'TEMPORAL Q8 (temporal.py:672)' }));
		}
		if (gate.flatRows?.length > 0) {
			warnings.push(
				temporalWarning('TEMPORAL_FLAT_CANDIDATES', 'warn', fillMessage(TEMPORAL_MESSAGES.FLAT_CANDIDATES, { count: gate.flatRows.length }), {
					count: gate.flatRows.length,
					sites: Array.from(gate.flatRows, (i) => candIndices[i] + 1).slice(0, 12),
					upstream: 'TEMPORAL Q7 (temporal.py:669)'
				})
			);
		}
	} else {
		// temporal.py:678-679: a single candidate is given R2 = 1, and that run is solitary anyway.
		for (let i = 0; i < C; i++) r2[candIndices[i]] = 1;
	}
	throwIfAborted(signal);

	// --- S13: the date-shuffling null (temporal.py:618-666), chunked ------------------------------
	const nullBlock = await runTemporalNull({
		candAttrs, candCurves, C, N, T, WT,
		sweepMode: regime.sweepMode, gradT, normDenseT,
		seed: options.seed ?? TEMPORAL_THRESHOLDS.seed,
		permutations: options.permutations ?? null,
		workBudget: options.workBudget,
		signal,
		report: (done, total, message) => report(progress, 'temporal-null', done, total, message),
		onProgress: onProgress
			? (partial) => {
					const pp = spreadPerm(partial, candIndices, L);
					onProgress({ ...scoredPayload(), stage: 'null', p_perm: pp.p, q_perm: pp.q, permutations: partial });
				}
			: null
	});
	if (nullBlock.skipped) {
		warnings.push(temporalWarning('TEMPORAL_NULL_SKIPPED', 'warn', nullBlock.reason, { C, N, T, work: nullBlock.work, budget: nullBlock.budget }));
	} else if (nullBlock.cancelled) {
		warnings.push(
			temporalWarning('TEMPORAL_NULL_TRUNCATED', 'warn', fillMessage(TEMPORAL_MESSAGES.NULL_TRUNCATED, {
				done: nullBlock.completed,
				requested: nullBlock.requested,
				gridStep: nullBlock.grid_step.toPrecision(3)
			}), { completed: nullBlock.completed, requested: nullBlock.requested, grid_step: nullBlock.grid_step })
		);
	}
	if (C > 0 && nullBlock.completed > 0 && nullBlock.q_floor >= TEMPORAL_THRESHOLDS.qStaticCut) {
		warnings.push(
			temporalWarning('TEMPORAL_Q_PERM_UNREACHABLE', 'info', fillMessage(TEMPORAL_MESSAGES.Q_PERM_UNREACHABLE, {
				C,
				B: nullBlock.completed,
				floor: Number(nullBlock.q_floor).toPrecision(3),
				needed: Math.ceil(10 * C)
			}), { candidates: C, draws: nullBlock.completed, q_floor: nullBlock.q_floor, upstream: 'TEMPORAL Q11' })
		);
	}

	// --- S15/S16: confirmation, the escape hatch and the four-way table (temporal.py:681-716) -------
	const { p: pPerm, q: qPerm, tested } = spreadPerm(nullBlock, candIndices, L);
	const confirm = confirmSweeps({
		stage1Mask: mask,
		pPerm: tested ? pPerm : new Float32Array(L).fill(1),
		r2Fpca: r2,
		lrts,
		L,
		nStage1: C,
		nonCalendar: regime.nonCalendar,
		permAlpha: options.permAlpha ?? TEMPORAL_THRESHOLDS.permAlpha,
		minR2Fpca: options.minR2Fpca ?? TEMPORAL_THRESHOLDS.minR2Fpca
	});
	if (!tested) {
		// No draw completed, so nothing is confirmed and nothing is ruled out. `confirmSweeps` would
		// otherwise read the initialised 1.0s as "tested and never exceeded" and confirm nothing —
		// the right count for the wrong reason, and its escape hatch would then fire on a null that
		// never ran. The four-way classification degrades to three; the record says so.
		confirm.isConfirmedSweep.fill(0);
		confirm.escapeHatchUsed = false;
		confirm.nSweeps = 0;
	}
	if (confirm.solitaryRegime) {
		const why = C <= 3 ? `only ${C} candidate codon(s) passed the energy floor` : regime.nonCalendar ? `the time axis is in ${regime.timeUnits}` : 'the gate threshold is not positive';
		warnings.push(temporalWarning('TEMPORAL_SOLITARY_REGIME', 'info', fillMessage(TEMPORAL_MESSAGES.SOLITARY_REGIME, { reason: why }), { candidates: C, non_calendar: regime.nonCalendar }));
	}
	if (confirm.escapeHatchUsed) {
		warnings.push(
			temporalWarning('TEMPORAL_ESCAPE_HATCH', 'warn', fillMessage(TEMPORAL_MESSAGES.ESCAPE_HATCH, { count: confirm.nSweeps }), {
				count: confirm.nSweeps,
				upstream: 'TEMPORAL Q5 (temporal.py:692-693)'
			})
		);
	}
	const cls = classifyTemporalSites({ inv: loaded.invariable, stage1Mask: mask, isConfirmedSweep: confirm.isConfirmedSweep, qStatic, L });

	// --- S17: the waves (temporal.py:718-741) -----------------------------------------------------
	report(progress, 'temporal-waves', 0, 1, 'Extracting the collective wave modes...');
	const waves = temporalWaveDecomposition({
		velocity: stats.velocity, L, T,
		isConfirmedSweep: confirm.isConfirmedSweep,
		peakIntensities: stats.peakIntensities,
		candIndices,
		K: TEMPORAL_THRESHOLDS.waveCount,
		waveSign: options.waveSign ?? 'canonical'
	});
	if (confirm.nSweeps < TEMPORAL_THRESHOLDS.waveCount && waves.fIndices.length > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_WAVES_FALLBACK_SET', 'info', fillMessage(TEMPORAL_MESSAGES.WAVES_FALLBACK_SET, { count: waves.fIndices.length }), {
				count: waves.fIndices.length,
				confirmed: confirm.nSweeps,
				upstream: 'TEMPORAL Q4 (temporal.py:722)'
			})
		);
	}
	const degenerate = [];
	for (let k = 0; k < (waves.nearDegenerate?.length ?? 0); k++) if (waves.nearDegenerate[k]) degenerate.push(`${k + 1}-${k + 2}`);
	if (degenerate.length > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_WAVES_NEAR_DEGENERATE', 'warn', fillMessage(TEMPORAL_MESSAGES.WAVES_NEAR_DEGENERATE, { pairs: degenerate.join(', '), threshold: WAVE_GAP_THRESHOLD }), {
				pairs: degenerate,
				gaps: Array.from(waves.gaps ?? []),
				threshold: WAVE_GAP_THRESHOLD
			})
		);
	}
	const deficient = Array.from(waves.rankDeficient ?? []).filter(Boolean).length;
	if (deficient > 0) {
		warnings.push(temporalWarning('TEMPORAL_WAVES_RANK_DEFICIENT', 'warn', fillMessage(TEMPORAL_MESSAGES.WAVES_RANK_DEFICIENT, { count: deficient }), { count: deficient }));
	}
	if (waves.nWaves > 0) {
		warnings.push(
			temporalWarning('TEMPORAL_WAVE_SIGN_CONVENTION', 'info', fillMessage(TEMPORAL_MESSAGES.WAVE_SIGN_CONVENTION, { convention: waves.waveSign }), {
				wave_sign: waves.waveSign,
				reference_has_convention: false
			})
		);
	}

	const record = temporalRecord({
		stage: 'complete', loaded, inputs, options, provenance, regime, root, labels, floors, warnings,
		L, nTaxa, N, T, taxa, validTaxaIndices, taxaDates, tMin, tMax, timespan, bandwidth, denseT,
		lrts, pStatic, qStatic, nSigStatic, scored, varCount: varIdx.length,
		curves, stats, mask, candIndices, dates: { ...resolved, beyond, undated: undated.length },
		nullBlock, r2, gate, confirm, cls, waves, pPerm: tested ? pPerm : null, qPerm: tested ? qPerm : null,
		elapsedSec: (Date.now() - started) / 1000
	});
	if (onProgress) onProgress(record);
	report(progress, 'temporal-waves', 1, 1, `${confirm.nSweeps} confirmed sweep(s) of ${C} candidate(s)`);
	return record;
}

/**
 * The candidate-length p and q vectors, spread back over all L codons.
 *
 * Non-candidates keep the reference's own 1.0 (temporal.py:645-646, `np.ones(L, dtype=float32)`).
 * A candidate whose null did not run keeps NaN — NOT 1.0, which is a real value meaning "tested and
 * never exceeded" — so a surface can render "not tested" rather than "not a sweep". That distinction
 * is the whole reason a cancelled run is worth keeping.
 */
function spreadPerm(nullBlock, candIndices, L) {
	const p = new Float32Array(L).fill(1);
	const q = new Float32Array(L).fill(1);
	const tested = Boolean(nullBlock && nullBlock.completed > 0);
	if (!nullBlock) return { p, q, tested: false };
	for (let i = 0; i < candIndices.length; i++) {
		p[candIndices[i]] = tested ? nullBlock.p[i] : NaN;
		q[candIndices[i]] = tested ? nullBlock.q[i] : NaN;
	}
	return { p, q, tested };
}

/** `createSession`'s handle, a bare `loadSession` handle, or neither. */
function sessionHandleOf(session) {
	if (!session) throw new Error('runTemporal: pass a `session` handle or a `predict` callback');
	return session.backbone ?? session;
}
