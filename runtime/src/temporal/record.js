/**
 * record.js — the `TemporalRecord`: what one temporal-selection run IS, once it has finished or
 * been stopped, in the one shape the page, the downloads, the MCP and the server all read.
 *
 * WHY THIS FILE EXISTS. `run.js` produces about twenty arrays and a dozen scalars; `results.js`
 * writes the reference's four files from them; a page draws four figures and a table from them. If
 * each of those three reached into the run's locals, the record would be whatever the last caller
 * happened to need. This file is the contract instead, and it makes three decisions the reference's
 * own output cannot express.
 *
 * 1. COLUMNS, NOT ROWS. PLAN-TEMPORAL §5.1.3's one memory rule: "the per-site, per-time table must
 *    be stored as columns, not as a quarter of a million row objects". `sites` is 27 parallel typed
 *    arrays of length L and `curves` is two `[L, T]` float64 blocks; on the acceptance run that is
 *    4,384 x 60 x 8 bytes x 2 = 4.2 MB of trajectory against roughly 90 MB for the same numbers as
 *    `{site, time, value}` objects, and it survives `structuredClone` into IndexedDB and across
 *    `postMessage` without a serialiser. A consumer that wants a row builds one; `siteRow(record, s)`
 *    is here so nobody writes that loop twice.
 *
 * 2. WHAT THE REFERENCE CANNOT SAY. Eight fields exist because `hyphaeon temporal`'s own output is
 *    silent about something a reader would misread. `permutations.completed` (a stopped null is a
 *    valid null at a coarser grid, and its p-values must never be printed without the count);
 *    `permutations.q_min` beside `q_rank1_bound` (BH's rank one alone cannot put a candidate below
 *    `C/(B+1)` — 2.44 on the acceptance run — so the smallest q any of its 246 candidates reaches is
 *    0.4298, shared by all eighteen confirmed sweeps, and the call is made on p);
 *    `escape_hatch_used` (temporal.py:692-693 fires a fallback selection and records it in NO output
 *    file, so a run that confirmed nothing and one that confirmed thirty look identical in the CSV); `scored` (which codons the model actually saw, so an absent LRT reads as absent and
 *    not as zero); `waves.sign`, `waves.sigma`, `waves.gaps` and `waves.near_degenerate` (a singular
 *    vector's sign is a convention this record states and the reference does not have, D28, and two
 *    near-equal singular values make the pair rotatable so that neither wave alone is a property of
 *    the data); and `peak_at_first_grid_point` (an all-zero velocity row has `argmax = 0`, so the
 *    reference reports `t_min` as the peak date of a codon with no signal at all — numerically
 *    correct, and a sentence like "peaked at the start of the epidemic" would be a lie).
 *
 * 3. THE REFERENCE'S EIGHTEEN SUMMARY KEYS ARE KEPT, IN ITS ORDER, AT THE TOP LEVEL, with their own
 *    names and quirks intact — `timespan_years` and `bandwidth_years` carry the word "years"
 *    whatever `--time-units` was (upstream TEMPORAL Q10). Everything this repository adds lives
 *    under `primaeon`, the sibling key the dating record already established, so a reader diffing
 *    `temporal_summary.json` against the reference's sees the same eighteen keys and then ours.
 */

import { TEMPORAL_SCHEMA_VERSION, TEMPORAL_THRESHOLDS, sortTemporalWarnings } from './codes.js';

/** The per-codon columns, in `_sites_summary.csv`'s own order (temporal.py:763-791). */
export const TEMPORAL_SITE_COLUMNS = Object.freeze([
	'site', 'ref_aa', 'derived_aa', 'mutation_label', 'domain', 'cross_classification', 'classification',
	'is_confirmed_sweep', 'is_concordant_sweep', 'is_rescued_sweep', 'lrt', 'p_static', 'q_static',
	'p_perm', 'q_perm', 'r2_fpca', 'peak_date', 'peak_intensity', 't_half_start', 't_half_end',
	'fwhm_years', 'mean_intensity', 'auc', 'Wave_1_loading', 'Wave_2_loading', 'Wave_3_loading', 'Wave_4_loading'
]);

/**
 * Assemble the record. Called twice by `run.js` — once after stage one with `stage: 'scored'` and
 * the null half null, once at the end — so a page can render the deterministic half while the null
 * is still drawing. The two share every field they both have; nothing is recomputed.
 *
 * @param {object} a everything `run.js` has at the call site; see its two call sites.
 * @returns {object} the `TemporalRecord`
 */
export function temporalRecord(a) {
	const { L, T, N, nTaxa, stage } = a;
	const complete = stage === 'complete';
	const K = TEMPORAL_THRESHOLDS.waveCount;

	// 1.0 is the reference's own fill for a codon the null never tested (temporal.py:620-621) — an
	// upstream bug replicated and flagged, not endorsed; `run.js`'s `spreadPerm` carries the full
	// note and `temporalDownloadNotes` says it to anyone who takes the CSV away. `sites.stage1` is
	// the mask that tells a 1.0 that was measured from a 1.0 that was assumed.
	const pPerm = a.pPerm ?? new Float32Array(L).fill(1);
	const qPerm = a.qPerm ?? new Float32Array(L).fill(1);
	const r2 = a.r2 ?? new Float32Array(L);
	const classification = a.cls?.classification ?? null;
	const loadings = a.waves?.loadings ?? new Float32Array(L * K);

	/** The one derived flag the reference's `argmax` of a zero row makes necessary. See the header. */
	const peakAtFirst = new Uint8Array(L);
	for (let s = 0; s < L; s++) if (a.stats.peakIntensities[s] === 0) peakAtFirst[s] = 1;

	const sites = {
		count: L,
		/** 1-based, as every printed codon index in this product is. */
		site: Int32Array.from({ length: L }, (_, s) => s + 1),
		ref_aa: a.root.rootAas,
		derived_aa: a.labels.derivedAas,
		mutation_label: a.labels.mutationLabels,
		domain: a.labels.domains,
		classification,
		cross_classification: a.cls?.crossClassification ?? null,
		is_confirmed_sweep: a.confirm?.isConfirmedSweep ?? new Uint8Array(L),
		is_concordant_sweep: a.cls?.isConcordant ?? new Uint8Array(L),
		is_rescued_sweep: a.cls?.isRescued ?? new Uint8Array(L),
		/** NaN at a codon the model was not asked about — never 0 (`run.js`'s header). */
		lrt: a.lrts,
		p_static: a.pStatic,
		q_static: a.qStatic,
		p_perm: pPerm,
		q_perm: qPerm,
		r2_fpca: r2,
		peak_date: a.stats.peakTimes,
		peak_intensity: a.stats.peakIntensities,
		t_half_start: a.stats.tHalfStart,
		t_half_end: a.stats.tHalfEnd,
		fwhm_years: a.stats.fwhm,
		mean_intensity: a.stats.meanIntensity,
		auc: a.stats.aucs,
		/** Row-major `[L, 4]`, float32 — the reference's own store (temporal.py:741). */
		wave_loadings: loadings,
		/** Which codons the model actually scored. */
		scored: a.scored,
		/** Which codons are invariable, over ALL sequences (dataset.py:1132), dated or not. */
		invariable: Uint8Array.from(a.loaded.invariable),
		/** Stage one's survivors. */
		stage1: a.mask,
		/** `peak_date` is `t_min` because the velocity row is identically zero: render an em dash. */
		peak_at_first_grid_point: peakAtFirst
	};

	return {
		schema_version: TEMPORAL_SCHEMA_VERSION,
		analysis: 'temporal',
		ok: true,
		stage,
		complete,

		// --- the reference's own eighteen, in its order (temporal.py:841-859) ---------------------
		/**
		 * The ONLY source of `_summary.json`'s `alignment` and `tree`, which is why `runTemporal`
		 * refuses an `inputs` key it does not recognise instead of letting `??` turn a typo into a
		 * summary that cannot say what it analysed. `null` here means the run carried no name.
		 * `inputs.dates`, the third accepted key, is not a summary key upstream and lands on
		 * `dates.file` below — every accepted key reaches the record, which is what makes the
		 * refusal above a guard against typos rather than a list of names two of which are kept.
		 */
		alignment: a.inputs?.alignment ?? null,
		tree: a.inputs?.tree ?? null,
		taxa_total: nTaxa,
		taxa_timestamped: N,
		codons_total: L,
		codons_variable: a.varCount,
		codons_invariable: L - a.varCount,
		/** "years" whatever `--time-units` was — upstream TEMPORAL Q10, replicated. */
		timespan_years: a.timespan,
		t_min: a.tMin,
		t_max: a.tMax,
		bandwidth_years: a.bandwidth,
		sig_static_q10: a.nSigStatic,
		stage1_candidates: a.candIndices.length,
		confirmed_sweeps: a.confirm?.nSweeps ?? 0,
		concordant_sweeps: a.cls?.counts?.concordant ?? 0,
		rescued_sweeps: a.cls?.counts?.rescued ?? 0,
		filtered_static_noise: a.cls?.counts?.filteredStaticNoise ?? 0,
		fpca_wave_variance_pct: a.waves ? Array.from(a.waves.varExplained.slice(0, K), (v) => v * 100) : [],
		runtime_sec: a.elapsedSec,

		// --- the tables --------------------------------------------------------------------------
		sites,
		/**
		 * `[L, T]` float64, column-stored (see the header). `prevalence` is the smoothed
		 * attention-weighted fraction carrying a non-root residue; `velocity` is the sweep metric.
		 * The reference's `_curves.csv` writes `velocity` into TWO differently named columns
		 * (temporal.py:807-808, upstream TEMPORAL Q9); this record carries one array once and
		 * `results.js` replicates the duplication where the file needs it.
		 */
		curves: { T, time: a.denseT, prevalence: a.curves, velocity: a.stats.velocity },
		waves: a.waves
			? {
					count: a.waves.nWaves,
					/** Row-major `[4, T]`, zero-padded when fewer than four modes exist. */
					data: a.waves.waves,
					time: a.denseT,
					var_explained: Array.from(a.waves.varExplained),
					sigma: Array.from(a.waves.sigma),
					/** `(s_j - s_{j+1}) / s_1`; the last entry is the gap to the FIRST DISCARDED mode. */
					gaps: Array.from(a.waves.gaps ?? []),
					near_degenerate: Array.from(a.waves.nearDegenerate ?? [], Boolean),
					rank_deficient: Array.from(a.waves.rankDeficient ?? [], Boolean),
					gap_threshold: TEMPORAL_THRESHOLDS.waveGapThreshold,
					/** D28. The reference has no convention and writes its solver's raw signs. */
					sign: a.waves.waveSign,
					/** Which codons the modes were extracted from: the sweeps, or the fallback set. */
					source_sites: Array.from(a.waves.fIndices, (s) => s + 1),
					source: a.confirm && a.confirm.nSweeps >= K ? 'confirmed-sweeps' : 'peak-intensity-fallback'
				}
			: null,
		candidates: Array.from(a.candIndices, (s) => s + 1),

		// --- what the reference's output cannot say -----------------------------------------------
		permutations: a.nullBlock
			? {
					requested: a.nullBlock.requested,
					completed: a.nullBlock.completed,
					cancelled: a.nullBlock.cancelled,
					skipped: a.nullBlock.skipped,
					grid_step: a.nullBlock.grid_step,
					/** The smallest q this run produced, and what BH's rank one alone would allow. */
					q_min: a.nullBlock.q_min,
					q_rank1_bound: a.nullBlock.q_rank1_bound,
					rounds: a.nullBlock.rounds,
					work: a.nullBlock.work,
					budget: a.nullBlock.budget,
					within: a.nullBlock.within,
					nnz: a.nullBlock.nnz,
					reason: a.nullBlock.reason,
					estimator: a.nullBlock.estimator,
					rng: a.nullBlock.rng,
					seed: a.nullBlock.seed,
					chunks: a.nullBlock.chunks,
					ms_per_draw: a.nullBlock.ms_per_draw,
					/** No draw completed: every label downstream of the null is withheld, not zeroed. */
					tested: a.nullBlock.completed > 0
				}
			: null,
		/** temporal.py:692-693's fallback selection, which the reference records nowhere. */
		escape_hatch_used: a.confirm?.escapeHatchUsed ?? false,
		/** temporal.py:685: the shape gate was bypassed, so a sweep needed only the permutation test. */
		solitary_regime: a.confirm?.solitaryRegime ?? false,
		/** temporal.py:672 at exactly four candidates: the gate cannot discriminate. */
		gate_vacuous: a.gate?.vacuous ?? false,

		// --- how the run was set up ----------------------------------------------------------------
		regime: {
			time_units: a.regime.timeUnits,
			sweep_mode: a.regime.sweepMode,
			non_calendar: a.regime.nonCalendar,
			unit_label: a.regime.unitLabel,
			prune_duplicates: a.regime.pruneDuplicates
		},
		grid: { time_points: T, t_min: a.tMin, t_max: a.tMax, step: T > 1 ? (a.tMax - a.tMin) / (T - 1) : 0 },
		floors: {
			tau_peak: a.floors.tauPeak,
			tau_auc: a.floors.tauAuc,
			tau_peak_overridden: a.floors.tauPeakOverridden,
			tau_auc_defaulted: a.floors.tauAucDefaulted,
			perm_alpha: a.options.permAlpha ?? TEMPORAL_THRESHOLDS.permAlpha,
			min_r2_fpca: a.options.minR2Fpca ?? TEMPORAL_THRESHOLDS.minR2Fpca,
			q_static_cut: TEMPORAL_THRESHOLDS.qStaticCut
		},
		root: {
			source: a.root.source,
			taxon: a.options.rootTaxon ?? null,
			window: a.root.nEarly,
			/** The dated sequences the consensus was taken over, 0-based into the DATED set. */
			early_indices: Array.from(a.root.earlyIndices ?? [])
		},
		dates: {
			/**
			 * The DATE FILE's name, from `runTemporal`'s `inputs.dates` and nowhere else — the third
			 * of the three names `assertInputNames` accepts, and the source of `-d` on the
			 * reproduction line (results.js). It is not one of the reference's eighteen summary keys,
			 * which is why it lives here beside the dates rather than at the top level with
			 * `alignment` and `tree`. `null` means the dates came from the headers, or from a caller
			 * that passed no name.
			 */
			file: a.inputs?.dates ?? null,
			dated: N,
			undated: a.dates.undated,
			source: a.dates.source,
			by_rule: a.dates.byRule,
			/** D31: how many dates the reference's own parser could not have read. See `codes.js`. */
			beyond_reference: a.dates.beyond,
			taxa: Array.from(a.validTaxaIndices, (i) => a.taxa[i]),
			values: Array.from(a.taxaDates),
			span: { min: a.tMin, max: a.tMax, span: a.timespan, unique: new Set(Array.from(a.taxaDates)).size }
		},
		warnings: sortTemporalWarnings(a.warnings),

		primaeon: {
			schema_version: TEMPORAL_SCHEMA_VERSION,
			surface: a.provenance?.surface ?? 'node',
			seed: a.options.seed ?? TEMPORAL_THRESHOLDS.seed,
			wave_sign: a.waves?.waveSign ?? (a.options.waveSign ?? 'canonical'),
			/** True when the model saw every codon, as `hyphaeon temporal` does (temporal.py:513-520). */
			score_invariable_sites: countOnes(a.scored) === L,
			scored_codons: countOnes(a.scored),
			taxon_cap: a.loaded.notices?.pdSubsampled ? 'applied' : null,
			/**
			 * D22: `{reason}` when this run took pairwise TN93 distances into the MDS instead of a
			 * tree (`prepareRun`'s own notice, `js/src/diagnostics.js`), `null` when a tree with
			 * usable branch lengths was used as given. The reproduction line reads it: tree-free is
			 * `--no-tree` / `--use-tn93` upstream (cli.py:1829-1830), not a default, so a command
			 * printed without it asks for patristic distances this run never computed.
			 */
			tree_free: a.loaded.notices?.treeFree ?? null,
			duplicates_collapsed: a.loaded.notices?.duplicatesCollapsed ?? 0,
			elapsed_sec: a.elapsedSec,
			...a.provenance
		}
	};
}

function countOnes(mask) {
	let n = 0;
	for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
	return n;
}

/**
 * One codon as a plain object, for a table row or a JSON dump. The record itself never holds these.
 *
 * @param {object} record
 * @param {number} s 0-based codon index
 * @returns {Record<string, unknown>}
 */
export function siteRow(record, s) {
	const c = record.sites;
	const K = TEMPORAL_THRESHOLDS.waveCount;
	return {
		site: c.site[s],
		ref_aa: c.ref_aa[s],
		derived_aa: c.derived_aa[s],
		mutation_label: c.mutation_label[s],
		domain: c.domain[s],
		cross_classification: c.cross_classification ? c.cross_classification[s] : null,
		classification: c.classification ? c.classification[s] : null,
		is_confirmed_sweep: Boolean(c.is_confirmed_sweep[s]),
		is_concordant_sweep: Boolean(c.is_concordant_sweep[s]),
		is_rescued_sweep: Boolean(c.is_rescued_sweep[s]),
		lrt: c.lrt[s],
		p_static: c.p_static[s],
		q_static: c.q_static[s],
		p_perm: c.p_perm[s],
		q_perm: c.q_perm[s],
		r2_fpca: c.r2_fpca[s],
		peak_date: c.peak_date[s],
		peak_intensity: c.peak_intensity[s],
		t_half_start: c.t_half_start[s],
		t_half_end: c.t_half_end[s],
		fwhm_years: c.fwhm_years[s],
		mean_intensity: c.mean_intensity[s],
		auc: c.auc[s],
		Wave_1_loading: c.wave_loadings[s * K],
		Wave_2_loading: c.wave_loadings[s * K + 1],
		Wave_3_loading: c.wave_loadings[s * K + 2],
		Wave_4_loading: c.wave_loadings[s * K + 3]
	};
}

/** The 0-based codon indices a surface shows by default: the stage-one candidates. */
export function candidateSiteIndices(record) {
	return Array.from(record.candidates, (site) => site - 1);
}
