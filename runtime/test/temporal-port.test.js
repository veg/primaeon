/**
 * temporal-port.test.js — the temporal-selection pillar, end to end, against `hyphaeon temporal`'s
 * own four files.
 *
 * WHY THIS FILE EXISTS. `runtime/src/temporal/` wires a dozen ported steps to a reader's data, and
 * almost every failure mode of that wiring produces a NUMBER rather than an error: a root residue
 * taken from the wrong window, an attention column matched to the wrong sequence, a gradient edge at
 * the wrong order, a float64 date where the reference casts to float32, a stage-one floor read in
 * the wrong units. None of those throws; each just quietly analyses a different dataset. So the
 * assertion that matters is not "the code runs" but "the chain lands on the reference's own
 * numbers", and the suite is four layers that fail for different reasons:
 *
 *   1. THE ACCEPTANCE RUN. `examples/H1N1_2009_pandemic.fasta` + `.nwk` at `-B 100
 *      --time-points 60`, compared column by column against `fixtures/temporal/acceptance/` — the
 *      CLI's own `--cpu` output, promoted into the engine checkout by this phase. The headline
 *      counts are HARD-CODED here, in the open, so the file states the claim it makes.
 *   2. THE DECOMPOSITION, CONDITIONED. `fpca_wave_variance_pct` and the four loading columns are
 *      downstream of the confirmed-sweep set and therefore of the null, so an end-to-end comparison
 *      of them is a comparison of two different matrices. They are compared on the REFERENCE'S OWN
 *      `is_confirmed_sweep` column instead, which is the only way to hold the decomposition to the
 *      strict class while the null is honestly statistical.
 *   3. THE NULL DRIVER. Chunking, resumption, cancellation, the cost model and the budget, all on
 *      synthetic operands so they run in milliseconds and without a graph.
 *   4. THE SEAMS. The refusals, the writers' shape, the reproduction line, the record's column
 *      store and the vocabulary.
 *
 * EVERY BOUND BELOW IS ASSERTED TWICE — once as the class, once against the value actually measured
 * at this commit — so a regression cannot hide in the slack between them. That is
 * `dating-port.test.js`'s convention and it is worth keeping.
 *
 * THE FLOOR ON EVERY CLAIM, AND WHERE IT COMES FROM. `hyphaeon temporal` does not reproduce ITSELF
 * across devices. `fixtures/temporal/acceptance/` carries both the `--cpu` and the MPS run of the
 * identical command, and comparing them over all 4,384 rows gives 6.3e-6 relative on `lrt`, 2.6e-7
 * on `r2_fpca`, 5.5e-7 on `peak_intensity`, ZERO on every selected quantity, and 1.7e-4 relative on
 * `Wave_1_loading`. Nothing here may be held tighter than that, and the envelope is itself asserted
 * below rather than quoted, so the tolerance table is testable.
 *
 * WHAT IS COMPARED AT WHICH CLASS, all measured at this commit:
 *
 *   EXACT, as text — `site`, `ref_aa`, `derived_aa`, `mutation_label`, `domain`, and the four
 *   SELECTED quantities `peak_date`, `t_half_start`, `t_half_end`, `fwhm_years`. A grid point and an
 *   argmax are chosen, not computed, so a bound on them would hide the off-by-one a bad gradient
 *   makes. MEASURED: all nine columns are bit-identical across all 4,384 rows, as is the time axis
 *   of `_waves.csv`.
 *
 *   STRICT GRAPH CLASS — `lrt` 1.15e-5 absolute / 7.14e-6 relative (this is onnxruntime against
 *   torch, and it sits at the reference's own device-to-device spread of 7.0e-6 / 6.3e-6);
 *   `p_static` 5.12e-7; `q_static` 9.0e-7; `r2_fpca` 5.0e-7; `peak_intensity`, `mean_intensity` and
 *   `auc` 1.68e-5 RELATIVE, which is the attention's own 7.45e-8 absolute error on rows that sum to
 *   1 propagating through the one matmul; the trajectories 6.7e-9 and the velocities 1.04e-7
 *   absolute.
 *
 *   EXACT, AS A SET — the 246 stage-one candidates. Justified by measurement rather than by hope:
 *   the binding floor is `tau_auc = 1e-5`, the smallest passing area is 2.00e-5 (2.0x) and the
 *   largest failing area 3.48e-6 (0.35x), so the set has a factor-two margin on one side and
 *   2.9 on the other and cannot move under a 1e-5 perturbation. The INVARIABLE and FLAT_NO_SIGNAL
 *   partitions of `classification` are exact for the same reason — neither reads the null.
 *
 *   STATISTICAL CLASS ONLY — `p_perm`, `q_perm`, `is_confirmed_sweep`, `is_rescued_sweep` and the
 *   sweep half of both classification columns. The reference draws from `np.random.RandomState(42)`
 *   (MT19937, temporal.py:651) and the library uses xoshiro256** per-draw substreams by design
 *   (D17). MEASURED at this B = 100 with C = 246: the reference confirms 18 and this runtime
 *   confirms 32, the two sets disagree on 18 codons, and EVERY ONE of those 18 has a reference
 *   `p_perm` within 0.0391 of the 0.05 cut against a three-sigma band of 0.0654. That is not slack,
 *   it is the shape of the answer at 100 draws: eleven of the 246 candidates sit within ONE draw
 *   (1/101 = 0.0099) of the cut. The test asserts the band, not the count.
 *
 *   SIGN-DEPENDENT, AND CONDITIONED — `wave_1..4` and `Wave_k_loading`. `temporal.py` has no sign
 *   convention (D28); the library's canonical rule flips each retained singular vector so its
 *   largest-magnitude entry is positive, BEFORE the loadings are derived. The flip vector against
 *   this fixture is (-1, +1, -1, -1), RECORDED here rather than absorbed, exactly as `MDS_SIGN.md`
 *   insists — a silently absorbed flip is what hid a real disagreement for two phases in the MDS
 *   work. After the flip, and conditioned on the reference's own sweep set, the four wave curves
 *   agree to 8.69e-8 and the loadings to 1.29e-5 relative, which is an order TIGHTER than the
 *   reference's own 1.7e-4 device spread.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { temporalWaveDecomposition } from '@veg/hyphaeon-js';

import { createSession } from '../src/createSession.js';
import { ingestDates, taxaForDates } from '../src/dates/index.js';
import { prepareRun } from '../src/pipeline.js';
import { releaseSessions } from '../src/session-node.js';
import {
	TEMPORAL_BEYOND_REFERENCE_RULES,
	TEMPORAL_DIAGNOSTIC_CODES,
	TEMPORAL_PERM_BUDGET_DEFAULT,
	TEMPORAL_PERM_RATE,
	TEMPORAL_PERM_ROUNDS,
	TEMPORAL_PERM_STAT_UNITS,
	TEMPORAL_REFERENCE_RULES,
	TEMPORAL_REFUSALS,
	TEMPORAL_SITES_COLUMNS,
	TEMPORAL_SUMMARY_KEYS,
	TEMPORAL_THRESHOLDS,
	candidateNnz,
	chunkFor,
	runTemporal,
	runTemporalNull,
	siteRow,
	temporalCurvesCsvText,
	temporalDownloads,
	temporalNullBudget,
	temporalNullWork,
	temporalReferenceCommand,
	temporalSitesCsvText,
	temporalSummaryJsonText,
	temporalWavesCsvText
} from '../src/temporal/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = process.env.HYPHAEON_MODELS_DIR ?? join(ENGINE, 'models');
const EXAMPLES = join(ENGINE, 'examples');
const FIXTURES = join(ENGINE, 'fixtures', 'temporal', 'acceptance');

const HAS_GRAPH = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(MODELS, 'manifest.json'));
const HAS_EXAMPLE = existsSync(join(EXAMPLES, 'H1N1_2009_pandemic.fasta'));
const HAS_FIXTURE = existsSync(join(FIXTURES, 'h1n1_cpu_sites_summary.csv'));
if (!HAS_GRAPH) console.warn(`\n[temporal-port] ACCEPTANCE RUN SKIPPED — needs ${MODELS}/general.onnx + manifest.json.\n`);
if (HAS_GRAPH && !HAS_FIXTURE) console.warn(`\n[temporal-port] ACCEPTANCE RUN SKIPPED — needs ${FIXTURES}/ (see its README).\n`);
const ready = HAS_GRAPH && HAS_EXAMPLE && HAS_FIXTURE;
const acceptance = describe.skipIf(!ready);

// =================================================================================================
// The fixture, as columns
// =================================================================================================

function parseCsv(path) {
	const lines = readFileSync(path, 'utf8').trim().split('\n');
	return { header: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) };
}
const csvColumn = (csv, name) => {
	const i = csv.header.indexOf(name);
	if (i < 0) throw new Error(`no column ${name}`);
	return csv.rows.map((r) => r[i]);
};
const nums = (values) => values.map((v) => (v === '' ? NaN : Number(v)));

/** Worst absolute and relative difference between two numeric columns, NaN-aware. */
function spread(a, b, { relFloor = 1e-12 } = {}) {
	let abs = 0;
	let rel = 0;
	let differing = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (Number.isNaN(x) && Number.isNaN(y)) continue;
		const d = Math.abs(x - y);
		if (d !== 0) differing++;
		if (d > abs) abs = d;
		if (Math.abs(x) > relFloor && d / Math.abs(x) > rel) rel = d / Math.abs(x);
	}
	return { abs, rel, differing };
}

// =================================================================================================
// Layer 1 + 2: the acceptance run
// =================================================================================================

/** The claim this file makes, in the open. Every one is the reference's own printed output. */
const HEADLINE = {
	taxa_total: 100,
	taxa_timestamped: 95,
	codons_total: 4384,
	codons_variable: 273,
	codons_invariable: 4111,
	t_min: 2009.2490234375,
	t_max: 2009.9150390625,
	timespan: 0.666015625,
	bandwidth: 0.05,
	sig_static_q10: 0,
	stage1_candidates: 246,
	reference_confirmed_sweeps: 18,
	reference_wave_variance_pct: [39.67, 32.37, 13.92, 9.31]
};

/** Measured at this commit; each is asserted against its class AND against itself. See the header. */
const MEASURED = {
	/**
	 * 1.152e-5 / 7.14e-6 at 4 intra-op threads and 1.144e-5 at 8: onnxruntime's reduction order
	 * depends on the thread count, so this one bound carries 10 % headroom for that alone. It is
	 * still four times tighter than the class and it still sits at the reference's OWN device spread.
	 */
	lrt: { abs: 1.3e-5, rel: 8e-6 },
	p_static: { abs: 5.13e-7 },
	q_static: { abs: 9.1e-7 },
	r2_fpca: { abs: 5.1e-7 },
	energy: { rel: 1.69e-5 },
	prevalence: { abs: 6.7e-9 },
	velocity: { abs: 1.05e-7 },
	waves: { abs: 8.7e-8 },
	loadings: { abs: 4.8e-6, rel: 1.29e-5 },
	/** The reference against ITSELF, MPS vs CPU, over the same 4,384 rows. */
	deviceSpread: { lrt: 6.4e-6, r2: 2.7e-7, energy: 5.6e-7, wave1Loading: 1.71e-4 },
	sweeps: { ours: 32, disagreeing: 18, worstDistanceFromCut: 0.0392, withinOneDraw: 11 },
	stageOne: { smallestPassingAuc: 1.997e-5, largestFailingAuc: 3.481e-6, closestR2ToGate: 0.0363 },
	flipVector: [-1, 1, -1, -1]
};

/** The classes, one decade or more above what was measured, and never below the device spread. */
const CLASS = {
	lrtAbs: 2e-5,
	lrtRel: 1e-5,
	pStatic: 1e-6,
	qStatic: 2e-6,
	r2: 1e-6,
	energyRel: 1e-4,
	prevalence: 1e-7,
	velocity: 1e-6,
	waves: 1e-6,
	loadingsRel: 1e-3
};

let chain = null;

beforeAll(async () => {
	if (!ready) return;
	const alignmentText = readFileSync(join(EXAMPLES, 'H1N1_2009_pandemic.fasta'), 'utf8');
	const treeText = readFileSync(join(EXAMPLES, 'H1N1_2009_pandemic.nwk'), 'utf8');
	// `maxSpecies` is lifted deliberately: NO acceptance comparison may run at a size that triggers
	// downsampling, because the reference's Faith's-PD reduction is time-blind (D27) and ours is not.
	const prep = await prepareRun({ alignmentText, treeText, options: { maxSpecies: 1000 } });
	const dates = ingestDates({ taxa: taxaForDates(alignmentText) });
	const session = await createSession({ modelsBase: MODELS, variant: 'general', threads: 4 });
	/** @type {object[]} */
	const stages = [];
	const record = await runTemporal({
		loaded: prep.loaded,
		dates,
		session: session.backbone,
		options: { numTimePoints: 60, permutations: 100 },
		inputs: { alignment: 'examples/H1N1_2009_pandemic.fasta', tree: 'examples/H1N1_2009_pandemic.nwk' },
		onProgress: (p) => stages.push(p.stage)
	});
	chain = {
		prep,
		record,
		stages,
		sites: parseCsv(join(FIXTURES, 'h1n1_cpu_sites_summary.csv')),
		mps: parseCsv(join(FIXTURES, 'h1n1_mps_sites_summary.csv')),
		curves: parseCsv(join(FIXTURES, 'h1n1_cpu_curves.csv')),
		waves: parseCsv(join(FIXTURES, 'h1n1_cpu_waves.csv')),
		summary: JSON.parse(readFileSync(join(FIXTURES, 'h1n1_cpu_summary.json'), 'utf8'))
	};
}, 300_000);

afterAll(async () => {
	if (HAS_GRAPH) await releaseSessions();
});

acceptance('the acceptance run, against `hyphaeon temporal`\'s own output', () => {
	it('reads the alignment the way the reference did', () => {
		const r = chain.record;
		expect(r.taxa_total).toBe(HEADLINE.taxa_total);
		expect(r.codons_total).toBe(HEADLINE.codons_total);
		expect(r.codons_variable).toBe(HEADLINE.codons_variable);
		expect(r.codons_invariable).toBe(HEADLINE.codons_invariable);
		expect(chain.summary.codons_variable).toBe(HEADLINE.codons_variable);
	});

	it('dates the same 95 of 100 sequences, by a rule the reference also has', () => {
		const r = chain.record;
		expect(r.taxa_timestamped).toBe(HEADLINE.taxa_timestamped);
		expect(chain.summary.taxa_timestamped).toBe(HEADLINE.taxa_timestamped);
		// D31's honesty check: on THIS example our wider ingestion buys nothing, so the two runs are
		// over the same sequences and the comparison below is a comparison.
		expect(r.dates.beyond_reference.count).toBe(0);
		expect(Object.keys(r.dates.by_rule)).toContain('header_decimal_year');
		for (const rule of Object.keys(r.dates.by_rule)) {
			if (rule === 'unparsed') continue;
			expect(TEMPORAL_REFERENCE_RULES, `${rule} is a rule temporal.py has`).toContain(rule);
		}
	});

	it('builds the reference\'s float32 time axis exactly, to the last bit', () => {
		const r = chain.record;
		// Float32 boundary #1 (temporal.py:468). A port that stayed in float64 would land on
		// 2009.249 and 2009.915 and miss the whole axis in the seventh digit.
		expect(r.t_min).toBe(HEADLINE.t_min);
		expect(r.t_max).toBe(HEADLINE.t_max);
		expect(r.timespan_years).toBe(HEADLINE.timespan);
		expect(r.bandwidth_years).toBe(HEADLINE.bandwidth);
		// The grid itself, against the reference's own `_waves.csv` first column.
		const refTime = nums(csvColumn(chain.waves, 'time'));
		expect(refTime.length).toBe(r.curves.T);
		for (let t = 0; t < refTime.length; t++) expect(r.curves.time[t]).toBe(refTime[t]);
		// And the number two phase-5 surveys carry wrongly.
		expect(r.t_max).not.toBe(2009.9200439453125);
	});

	it('takes the calendar regime and clamps the bandwidth at its floor', () => {
		expect(chain.record.regime.sweep_mode).toBe('episodic');
		expect(chain.record.regime.non_calendar).toBe(false);
		// 0.666 x 0.05 = 0.0333, below the reference's 0.05 floor (temporal.py:489).
		expect(chain.record.timespan_years * 0.05).toBeLessThan(0.05);
		expect(chain.record.warnings.map((w) => w.code)).toContain('TEMPORAL_BANDWIDTH_CLAMPED');
	});

	it('resolves the reference\'s own energy floors, override and all', () => {
		expect(chain.record.floors.tau_peak).toBe(0.5e-4);
		expect(chain.record.floors.tau_auc).toBeCloseTo(1e-5, 15);
		// Upstream bug TEMPORAL Q1: the documented default 1e-4 was NOT what ran.
		expect(chain.record.floors.tau_peak_overridden).toBe(true);
	});

	it('names every codon identically: five string columns, 4,384 rows, no bound', () => {
		const r = chain.record;
		for (const [name, ours] of [
			['site', Array.from(r.sites.site, String)],
			['ref_aa', r.sites.ref_aa],
			['derived_aa', r.sites.derived_aa],
			['mutation_label', r.sites.mutation_label],
			['domain', r.sites.domain]
		]) {
			expect(ours, `${name} length`).toHaveLength(HEADLINE.codons_total);
			expect(ours.join(' '), `${name} column`).toBe(csvColumn(chain.sites, name).join(' '));
		}
	});

	it('selects the same grid points: peak date, both half-max crossings and the width', () => {
		// EXACT, as text, on purpose — these are chosen, not computed (see the header). Comparing the
		// WRITTEN cell rather than the in-memory float also pins the float32 repr the reference's
		// pandas uses for three of these four columns.
		const written = parseCsvText(temporalSitesCsvText(chain.record));
		for (const name of ['peak_date', 't_half_start', 't_half_end', 'fwhm_years']) {
			expect(csvColumn(written, name).join(','), name).toBe(csvColumn(chain.sites, name).join(','));
		}
	});

	it('reproduces the static scan at the graph class, and calls nothing, as the reference does', () => {
		const r = chain.record;
		const lrt = spread(nums(csvColumn(chain.sites, 'lrt')), Array.from(r.sites.lrt));
		expect(lrt.abs, 'lrt |Δ|').toBeLessThan(CLASS.lrtAbs);
		expect(lrt.abs).toBeLessThan(MEASURED.lrt.abs);
		expect(lrt.rel, 'lrt relative').toBeLessThan(CLASS.lrtRel);
		expect(lrt.rel).toBeLessThan(MEASURED.lrt.rel);

		const ps = spread(nums(csvColumn(chain.sites, 'p_static')), Array.from(r.sites.p_static));
		expect(ps.abs).toBeLessThan(CLASS.pStatic);
		expect(ps.abs).toBeLessThan(MEASURED.p_static.abs);
		const qs = spread(nums(csvColumn(chain.sites, 'q_static')), Array.from(r.sites.q_static));
		expect(qs.abs).toBeLessThan(CLASS.qStatic);
		expect(qs.abs).toBeLessThan(MEASURED.q_static.abs);

		expect(r.sig_static_q10).toBe(HEADLINE.sig_static_q10);
		expect(chain.summary.sig_static_q10).toBe(HEADLINE.sig_static_q10);
		// Which is why all of this run's sweeps are "found only in time" and none is concordant:
		// the cross-classification is a function of an FDR threshold over 273 codons, not of biology.
		expect(r.concordant_sweeps).toBe(0);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_STATIC_NONE_SIGNIFICANT');
	});

	it('is no tighter than the reference is with itself', () => {
		// The tolerance table's own justification, asserted rather than quoted: MPS against CPU, the
		// identical command, the reference's own code on both sides.
		const dev = (name) => spread(nums(csvColumn(chain.sites, name)), nums(csvColumn(chain.mps, name)));
		expect(dev('lrt').rel).toBeLessThan(MEASURED.deviceSpread.lrt);
		expect(dev('lrt').rel).toBeGreaterThan(1e-6);
		expect(dev('r2_fpca').rel).toBeLessThan(MEASURED.deviceSpread.r2);
		expect(dev('peak_intensity').rel).toBeLessThan(MEASURED.deviceSpread.energy);
		expect(dev('Wave_1_loading').rel).toBeLessThan(MEASURED.deviceSpread.wave1Loading);
		// And the four selected quantities are bit-stable even across devices, which is what makes
		// exact equality the right test for them above.
		for (const name of ['peak_date', 't_half_start', 't_half_end', 'fwhm_years', 'p_perm']) {
			expect(dev(name).differing, `${name} across devices`).toBe(0);
		}
		// Our own wave loadings are TIGHTER against the fixture than the reference is against itself.
		expect(MEASURED.loadings.rel).toBeLessThan(MEASURED.deviceSpread.wave1Loading);
	});

	it('reproduces the trajectories and their energies', () => {
		const r = chain.record;
		const refCurves = chain.curves;
		const refSite = nums(csvColumn(refCurves, 'site'));
		const refPrev = nums(csvColumn(refCurves, 'prevalence'));
		const refVel = nums(csvColumn(refCurves, 'sweep_velocity'));
		expect(refCurves.rows.length).toBe(HEADLINE.stage1_candidates * r.curves.T);
		let wp = 0;
		let wv = 0;
		for (let i = 0; i < refSite.length; i++) {
			const s = refSite[i] - 1;
			const t = i % r.curves.T;
			wp = Math.max(wp, Math.abs(refPrev[i] - r.curves.prevalence[s * r.curves.T + t]));
			wv = Math.max(wv, Math.abs(refVel[i] - r.curves.velocity[s * r.curves.T + t]));
		}
		expect(wp, 'prevalence |Δ|').toBeLessThan(CLASS.prevalence);
		expect(wp).toBeLessThan(MEASURED.prevalence.abs);
		expect(wv, 'velocity |Δ|').toBeLessThan(CLASS.velocity);
		expect(wv).toBeLessThan(MEASURED.velocity.abs);

		for (const name of ['peak_intensity', 'mean_intensity', 'auc']) {
			const key = name === 'peak_intensity' ? 'peak_intensity' : name;
			const got = spread(nums(csvColumn(chain.sites, name)), Array.from(r.sites[key]));
			expect(got.rel, `${name} relative`).toBeLessThan(CLASS.energyRel);
			expect(got.rel).toBeLessThan(MEASURED.energy.rel);
		}
	});

	it('selects exactly the same 246 candidates, with the margin that makes that testable', () => {
		const r = chain.record;
		expect(r.stage1_candidates).toBe(HEADLINE.stage1_candidates);
		expect(chain.summary.stage1_candidates).toBe(HEADLINE.stage1_candidates);
		// The reference's own stage-one set, read out of `classification`: anything neither
		// INVARIABLE nor FLAT_NO_SIGNAL was tested.
		const refCls = csvColumn(chain.sites, 'classification');
		const refStage1 = [];
		for (let s = 0; s < refCls.length; s++) if (refCls[s] !== 'INVARIABLE' && refCls[s] !== 'FLAT_NO_SIGNAL') refStage1.push(s + 1);
		expect(Array.from(r.candidates)).toEqual(refStage1);

		// Why exact equality is the right test here and not a bound.
		let smallestPassing = Infinity;
		let largestFailing = 0;
		const cand = new Set(r.candidates);
		for (let s = 0; s < r.codons_total; s++) {
			if (r.sites.invariable[s]) continue;
			if (cand.has(s + 1)) smallestPassing = Math.min(smallestPassing, r.sites.auc[s]);
			else largestFailing = Math.max(largestFailing, r.sites.auc[s]);
		}
		expect(smallestPassing).toBeGreaterThan(r.floors.tau_auc * 1.9);
		expect(largestFailing).toBeLessThan(r.floors.tau_auc * 0.4);
		expect(smallestPassing).toBeCloseTo(MEASURED.stageOne.smallestPassingAuc, 8);
		expect(largestFailing).toBeCloseTo(MEASURED.stageOne.largestFailingAuc, 8);
	});

	it('reproduces r2_fpca, and the shape gate is not close to its own threshold', () => {
		const r = chain.record;
		const got = spread(nums(csvColumn(chain.sites, 'r2_fpca')), Array.from(r.sites.r2_fpca));
		expect(got.abs).toBeLessThan(CLASS.r2);
		expect(got.abs).toBeLessThan(MEASURED.r2_fpca.abs);
		let closest = Infinity;
		for (const site of r.candidates) closest = Math.min(closest, Math.abs(r.sites.r2_fpca[site - 1] - r.floors.min_r2_fpca));
		expect(closest).toBeGreaterThan(0.02);
		expect(closest).toBeCloseTo(MEASURED.stageOne.closestR2ToGate, 3);
		expect(r.gate_vacuous).toBe(false);
		expect(r.solitary_regime).toBe(false);
	});

	it('agrees with the reference exactly on the two partitions the null cannot reach', () => {
		const refCls = csvColumn(chain.sites, 'classification');
		const ours = chain.record.sites.classification;
		let mismatches = 0;
		for (let s = 0; s < refCls.length; s++) {
			const a = refCls[s] === 'INVARIABLE' || refCls[s] === 'FLAT_NO_SIGNAL';
			const b = ours[s] === 'INVARIABLE' || ours[s] === 'FLAT_NO_SIGNAL';
			if (a !== b || (a && refCls[s] !== ours[s])) mismatches++;
		}
		expect(mismatches).toBe(0);
	});

	it('disagrees on the sweep set only where the null cannot resolve it', () => {
		// THE STATISTICAL CLASS, stated as a checkable claim rather than as slack. Not "18 == 18":
		// every codon the two sides label differently must have a reference p_perm inside the
		// three-sigma Monte-Carlo band of the alpha it is being thresholded at.
		const r = chain.record;
		const refSweep = csvColumn(chain.sites, 'is_confirmed_sweep').map((v) => v === 'True');
		const refP = nums(csvColumn(chain.sites, 'p_perm'));
		expect(refSweep.filter(Boolean).length).toBe(HEADLINE.reference_confirmed_sweeps);
		expect(r.confirmed_sweeps).toBe(MEASURED.sweeps.ours);

		const B = r.permutations.completed;
		const alpha = r.floors.perm_alpha;
		const band = 3 * Math.sqrt((alpha * (1 - alpha)) / B);
		const disagreeing = [];
		for (let s = 0; s < r.codons_total; s++) if (Boolean(r.sites.is_confirmed_sweep[s]) !== refSweep[s]) disagreeing.push(s);
		expect(disagreeing.length).toBe(MEASURED.sweeps.disagreeing);
		const worst = Math.max(...disagreeing.map((s) => Math.abs(refP[s] - alpha)));
		expect(worst, 'every disagreement is inside the Monte-Carlo band').toBeLessThan(band);
		expect(worst).toBeLessThan(MEASURED.sweeps.worstDistanceFromCut);

		// And the reason the band is wide: at B = 100 the p grid is coarser than alpha/5.
		const oneDraw = 1 / (B + 1);
		const near = r.candidates.filter((site) => Math.abs(refP[site - 1] - alpha) <= oneDraw);
		expect(near.length).toBe(MEASURED.sweeps.withinOneDraw);
	});

	it('is rescued, not concordant, and knows which counts are which', () => {
		const r = chain.record;
		expect(r.rescued_sweeps).toBe(r.confirmed_sweeps);
		expect(r.concordant_sweeps).toBe(0);
		expect(r.filtered_static_noise).toBe(0);
		expect(chain.summary.rescued_sweeps).toBe(HEADLINE.reference_confirmed_sweeps);
		expect(r.escape_hatch_used).toBe(false);
	});

	it('records what the reference\'s output cannot say', () => {
		const r = chain.record;
		expect(r.permutations.completed).toBe(100);
		expect(r.permutations.tested).toBe(true);
		expect(r.permutations.rng).toBe('xoshiro256**');
		expect(r.permutations.seed).toBe(TEMPORAL_THRESHOLDS.seed);
		expect(r.permutations.grid_step).toBeCloseTo(1 / 101, 12);
		// Upstream TEMPORAL Q11: BH over 246 candidates cannot return below 246/101 = 2.4, clipped
		// to 1, so `q_perm` is uninformative and the call is made on p.
		expect(r.permutations.q_rank1_bound).toBe(1);
		expect(r.permutations.q_min).toBeGreaterThan(TEMPORAL_THRESHOLDS.qStaticCut);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_Q_PERM_UNREACHABLE');
		// The reference's own file shows the same thing, and it is the reason the sweep call is made
		// on p: all eighteen of ITS confirmed sweeps carry ONE q_perm, and it is 0.4298.
		const refQ = new Set(csvColumn(chain.sites, 'is_confirmed_sweep')
			.map((v, i) => (v === 'True' ? csvColumn(chain.sites, 'q_perm')[i] : null))
			.filter(Boolean));
		expect(refQ.size).toBe(1);
		expect(Number([...refQ][0])).toBeCloseTo(0.4298, 4);
		// And no candidate on either side reaches a threshold anybody would test at.
		for (const site of r.candidates) expect(r.sites.q_perm[site - 1]).toBeGreaterThan(TEMPORAL_THRESHOLDS.qStaticCut);
		// Which codons the model actually saw (the default scores every one, as the reference does).
		expect(r.primaeon.score_invariable_sites).toBe(true);
		expect(r.primaeon.scored_codons).toBe(HEADLINE.codons_total);
		// And the peak dates that are an argmax of zeros, so a page can draw an em dash.
		let flagged = 0;
		for (let s = 0; s < r.codons_total; s++) if (r.sites.peak_at_first_grid_point[s]) flagged++;
		expect(flagged).toBeGreaterThan(HEADLINE.codons_invariable - 1);
		for (let s = 0; s < r.codons_total; s++) {
			if (r.sites.peak_at_first_grid_point[s]) expect(r.sites.peak_date[s]).toBe(r.t_min);
		}
	});

	it('changes nothing but two columns when the invariable codons are not scored', async () => {
		// THE ONE REAL DIVERGENCE this application has from the reference (see `run.js`'s header),
		// asserted rather than argued. The reference sends every codon through the model; a browser
		// chaining this onto an existing analyze pass may send only the variable ones. MEASURED on
		// this machine: 12.89 s against 0.91 s for the model pass, a 93 % saving.
		const alignmentText = readFileSync(join(EXAMPLES, 'H1N1_2009_pandemic.fasta'), 'utf8');
		const session = await createSession({ modelsBase: MODELS, variant: 'general', threads: 4 });
		const lean = await runTemporal({
			loaded: chain.prep.loaded,
			dates: ingestDates({ taxa: taxaForDates(alignmentText) }),
			session: session.backbone,
			options: { numTimePoints: 60, permutations: 100, scoreInvariableSites: false }
		});
		const full = chain.record;
		expect(lean.primaeon.scored_codons).toBe(HEADLINE.codons_variable);
		// Identical where it matters: the same candidates, the same sweeps, the same labels.
		expect(Array.from(lean.candidates)).toEqual(Array.from(full.candidates));
		expect(lean.confirmed_sweeps).toBe(full.confirmed_sweeps);
		expect(Array.from(lean.sites.classification)).toEqual(Array.from(full.sites.classification));
		expect(Array.from(lean.sites.mutation_label)).toEqual(Array.from(full.sites.mutation_label));
		// The SELECTED quantities are bit-equal, which is what proves the two runs took the same
		// path. The COMPUTED ones are equal at the graph class and not bit for bit, because scoring
		// 273 codons rather than 4,384 changes the batch composition and onnxruntime's reductions
		// with it — the same property `predict.js` measured for the batch-size bound. MEASURED here:
		// 2.5e-8 relative on `auc`, four orders inside the class the fixture is compared at.
		let worstAuc = 0;
		let worstLrt = 0;
		for (let s = 0; s < full.codons_total; s++) {
			expect(lean.sites.peak_date[s]).toBe(full.sites.peak_date[s]);
			expect(lean.sites.fwhm_years[s]).toBe(full.sites.fwhm_years[s]);
			const den = Math.max(Math.abs(full.sites.auc[s]), 1e-300);
			worstAuc = Math.max(worstAuc, Math.abs(lean.sites.auc[s] - full.sites.auc[s]) / den);
		}
		expect(worstAuc).toBeLessThan(1e-6);
		expect(worstAuc).toBeLessThan(1e-7);
		// And different in exactly two columns, at exactly the unscored codons, by being ABSENT.
		let absent = 0;
		for (let s = 0; s < full.codons_total; s++) {
			if (full.sites.invariable[s]) {
				expect(Number.isNaN(lean.sites.lrt[s])).toBe(true);
				expect(Number.isNaN(lean.sites.p_static[s])).toBe(true);
				absent++;
			} else {
				worstLrt = Math.max(worstLrt, Math.abs(lean.sites.lrt[s] - full.sites.lrt[s]));
			}
		}
		expect(absent).toBe(HEADLINE.codons_invariable);
		expect(worstLrt).toBeLessThan(CLASS.lrtAbs);
		// q_static is untouched at the same class: BH runs over the variable subset alone
		// (temporal.py:529), so nothing the 4,111 absent LRTs would have said enters its denominator.
		let worstQ = 0;
		for (let s = 0; s < full.codons_total; s++) worstQ = Math.max(worstQ, Math.abs(lean.sites.q_static[s] - full.sites.q_static[s]));
		expect(worstQ).toBeLessThan(CLASS.qStatic);
		expect(lean.sig_static_q10).toBe(full.sig_static_q10);
	}, 120_000);

	it('streams the deterministic half before the null and the null before the waves', () => {
		// The app-side reordering `run.js` documents: the gate runs before the null, and a page sees
		// trajectories and candidates within a second with the labels arriving last.
		expect(chain.stages[0]).toBe('scored');
		expect(chain.stages).toContain('null');
		expect(chain.stages[chain.stages.length - 1]).toBe('complete');
		expect(chain.stages.indexOf('null')).toBeGreaterThan(chain.stages.indexOf('scored'));
	});
});

acceptance('the decomposition, conditioned on the reference\'s own sweep set', () => {
	// WHY CONDITIONED. `f_indices` is the confirmed-sweep set (temporal.py:720), which is thresholded
	// on `p_perm`, so an end-to-end comparison of the waves compares two different matrices. Both
	// phase-5 surveys list `var_explained` as strict class; that is true of the DECOMPOSITION and
	// false of the PIPELINE, and this block is where the difference is made honest.
	let wd = null;
	beforeAll(() => {
		if (!ready) return;
		const r = chain.record;
		const refMask = Uint8Array.from(csvColumn(chain.sites, 'is_confirmed_sweep'), (v) => (v === 'True' ? 1 : 0));
		wd = temporalWaveDecomposition({
			velocity: r.curves.velocity,
			L: r.codons_total,
			T: r.curves.T,
			isConfirmedSweep: refMask,
			peakIntensities: r.sites.peak_intensity,
			candIndices: Int32Array.from(r.candidates, (s) => s - 1)
		});
	});

	it('recovers the reference\'s singular values and variance shares', () => {
		const pct = Array.from(wd.varExplained.slice(0, 4), (v) => Number((v * 100).toFixed(2)));
		expect(pct).toEqual(HEADLINE.reference_wave_variance_pct);
		expect(pct).toEqual(chain.summary.fpca_wave_variance_pct);
		// Recovered independently from the reference's own CSVs: sum of squared loadings over
		// `f_indices` is sigma_j^2 (see the fixture README).
		expect(wd.sigma[0]).toBeCloseTo(20.6989, 3);
		expect(wd.sigma[3]).toBeCloseTo(10.0253, 3);
	});

	it('separates all four modes, so the per-vector comparison below is valid', () => {
		// D28 §4: below a relative gap of 0.05 a pair can rotate and only the pair is meaningful.
		for (let k = 0; k < 4; k++) expect(wd.gaps[k], `gap ${k + 1}`).toBeGreaterThan(TEMPORAL_THRESHOLDS.waveGapThreshold);
		expect(wd.gaps[0]).toBeCloseTo(0.0968, 3);
		expect(Array.from(wd.nearDegenerate.slice(0, 4))).toEqual([false, false, false, false]);
		expect(Array.from(wd.rankDeficient.slice(0, 4))).toEqual([false, false, false, false]);
	});

	it('matches every wave curve after the RECORDED flip, not a silently absorbed one', () => {
		// MDS_SIGN.md's rule: record the flip vector, never absorb it. A reviewer who sees
		// (-1, +1, -1, -1) knows the two sides agreed by convention and not by luck.
		const T = chain.record.curves.T;
		const flips = [];
		let worst = 0;
		for (let k = 0; k < 4; k++) {
			const ref = nums(csvColumn(chain.waves, `wave_${k + 1}`));
			let plus = 0;
			let minus = 0;
			for (let t = 0; t < T; t++) {
				plus = Math.max(plus, Math.abs(wd.waves[k * T + t] - ref[t]));
				minus = Math.max(minus, Math.abs(-wd.waves[k * T + t] - ref[t]));
			}
			flips.push(plus <= minus ? 1 : -1);
			worst = Math.max(worst, Math.min(plus, minus));
		}
		expect(flips).toEqual(MEASURED.flipVector);
		expect(worst).toBeLessThan(CLASS.waves);
		expect(worst).toBeLessThan(MEASURED.waves.abs);
		expect(wd.waveSign).toBe('canonical');
		// Three of the four are drawn the other way up by `hyphaeon temporal`, which has no
		// convention at all — the whole point of D28.
		expect(flips.filter((f) => f === -1).length).toBe(3);
	});

	it('matches every loading column under the same flip', () => {
		const flips = MEASURED.flipVector;
		let abs = 0;
		let rel = 0;
		for (let k = 0; k < 4; k++) {
			const ref = nums(csvColumn(chain.sites, `Wave_${k + 1}_loading`));
			for (let s = 0; s < ref.length; s++) {
				const d = Math.abs(wd.loadings[s * 4 + k] * flips[k] - ref[s]);
				abs = Math.max(abs, d);
				if (Math.abs(ref[s]) > 1e-3) rel = Math.max(rel, d / Math.abs(ref[s]));
			}
		}
		expect(abs).toBeLessThan(MEASURED.loadings.abs);
		expect(rel).toBeLessThan(CLASS.loadingsRel);
		expect(rel).toBeLessThan(MEASURED.loadings.rel);
	});
});

acceptance('the four files', () => {
	it('writes the reference\'s 27 columns, in its order, one row per codon', () => {
		const written = parseCsvText(temporalSitesCsvText(chain.record));
		expect(written.header).toEqual(chain.sites.header);
		expect(written.header).toEqual([...TEMPORAL_SITES_COLUMNS]);
		expect(written.rows.length).toBe(HEADLINE.codons_total);
		expect(csvColumn(written, 'site')).toEqual(csvColumn(chain.sites, 'site'));
		// Python's booleans, not JavaScript's.
		expect(new Set(csvColumn(written, 'is_confirmed_sweep'))).toEqual(new Set(['True', 'False']));
	});

	it('writes the curves file candidates-only, and replicates the duplicated column', () => {
		const written = parseCsvText(temporalCurvesCsvText(chain.record));
		expect(written.header).toEqual(chain.curves.header);
		expect(written.rows.length).toBe(chain.curves.rows.length);
		expect(written.rows.length).toBe(HEADLINE.stage1_candidates * chain.record.curves.T);
		expect(csvColumn(written, 'site')).toEqual(csvColumn(chain.curves, 'site'));
		// UPSTREAM BUG TEMPORAL Q9 (temporal.py:807-808), replicated so the file diffs clean and
		// pinned here so a later well-meaning "fix" fails loudly and is settled upstream first.
		const a = csvColumn(written, 'selection_intensity');
		const b = csvColumn(written, 'sweep_velocity');
		expect(a).toEqual(b);
		expect(csvColumn(chain.curves, 'selection_intensity')).toEqual(csvColumn(chain.curves, 'sweep_velocity'));
	});

	it('writes the waves file on the reference\'s own time axis', () => {
		const written = parseCsvText(temporalWavesCsvText(chain.record));
		expect(written.header).toEqual(chain.waves.header);
		expect(written.rows.length).toBe(chain.record.curves.T);
		expect(csvColumn(written, 'time')).toEqual(csvColumn(chain.waves, 'time'));
	});

	it('writes the summary\'s eighteen keys in the reference\'s order, with its quirks', () => {
		const ours = JSON.parse(temporalSummaryJsonText(chain.record));
		expect(Object.keys(ours)).toEqual([...TEMPORAL_SUMMARY_KEYS]);
		expect(Object.keys(ours)).toEqual(Object.keys(chain.summary));
		for (const key of ['alignment', 'tree', 'taxa_total', 'taxa_timestamped', 'codons_total',
			'codons_variable', 'codons_invariable', 'timespan_years', 't_min', 't_max',
			'bandwidth_years', 'sig_static_q10', 'stage1_candidates']) {
			expect(ours[key], key).toEqual(chain.summary[key]);
		}
		// UPSTREAM TEMPORAL Q10: "years" whatever `--time-units` was, and Python's round-half-to-even.
		expect(ours.timespan_years).toBe(0.67);
		expect(ours.t_max).toBe(2009.92);
	});

	it('names the four downloads after the reference\'s own suffixes', () => {
		const files = temporalDownloads(chain.record, { prefix: 'temporal' });
		expect(files.map((f) => f.name)).toEqual([
			'temporal_sites_summary.csv', 'temporal_curves.csv', 'temporal_waves.csv', 'temporal_summary.json'
		]);
	});

	it('prints a reproduction line, and says what it would not reproduce', () => {
		const { command, reproduces, caveats } = temporalReferenceCommand(chain.record);
		expect(command).toContain('hyphaeon temporal');
		expect(command).toContain('-a examples/H1N1_2009_pandemic.fasta');
		expect(command).toContain('-t examples/H1N1_2009_pandemic.nwk');
		expect(command).toContain('-B 100');
		expect(command).toContain('--time-points 60');
		// This run IS reproducible: our ingestion bought nothing extra here.
		expect(reproduces).toBe(true);
		// But the draw count and the wave sign are still named.
		expect(caveats.join(' ')).toContain('-B 100');
		expect(caveats.join(' ')).toContain('canonical');
	});
});

// =================================================================================================
// Layer 3: the null driver, on synthetic operands — no graph, milliseconds
// =================================================================================================

/** A candidate block with a known density, deterministic, and its identity-permutation curves. */
function operands({ C, N, T, rho, seed = 11 }) {
	let s = seed >>> 0;
	const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
	const candAttrs = new Float32Array(C * N);
	for (let i = 0; i < C * N; i++) candAttrs[i] = rnd() < rho ? Math.fround(rnd() * 0.02) : 0;
	// A plain Nadaraya-Watson weight block in taxon-major layout, as `taxonMajorWeights` produces.
	const WT = new Float64Array(N * T);
	for (let n = 0; n < N; n++) {
		let sum = 0;
		const w = new Float64Array(T);
		for (let t = 0; t < T; t++) {
			w[t] = Math.exp(-0.5 * ((t / (T - 1) - rnd()) / 0.2) ** 2);
			sum += w[t];
		}
		for (let t = 0; t < T; t++) WT[n * T + t] = w[t] / (sum + 1e-8);
	}
	const gradT = new Float64Array(T);
	for (let t = 0; t < T; t++) gradT[t] = t / (T - 1);
	const candCurves = new Float64Array(C * T);
	for (let c = 0; c < C; c++) {
		for (let n = 0; n < N; n++) {
			const v = candAttrs[c * N + n];
			if (v === 0) continue;
			for (let t = 0; t < T; t++) candCurves[c * T + t] += v * WT[n * T + t];
		}
	}
	return { candAttrs, candCurves, WT, gradT, C, N, T, sweepMode: 'episodic' };
}

const SMALL = operands({ C: 24, N: 30, T: 25, rho: 0.2 });

describe('the date-shuffling null, as this surface drives it', () => {
	it('is index-addressed: a run stopped at B is a run configured with B', async () => {
		// The property that makes progressive rounds and a cancel free (see `null.js`'s header).
		const short = await runTemporalNull({ ...SMALL, permutations: 40, workBudget: Infinity });
		const long = await runTemporalNull({ ...SMALL, permutations: 120, workBudget: Infinity });
		const resumed = await runTemporalNull({ ...SMALL, permutations: 40, workBudget: Infinity });
		expect(Array.from(resumed.exceed)).toEqual(Array.from(short.exceed));
		// The first 40 draws of the long run are the same 40 draws, so every exceedance count in the
		// short run is <= the long run's and the difference is the later draws only.
		for (let c = 0; c < short.exceed.length; c++) {
			expect(long.exceed[c]).toBeGreaterThanOrEqual(short.exceed[c]);
		}
	});

	it('is independent of the chunk size', async () => {
		// `chunkTargetMs` is honoured through a SUB-MILLISECOND clock: a draw on this shape is well
		// under 1 ms, and `Date.now()` would read the calibration draw as zero and take the maximum
		// chunk for every run, which would make this test pass by not testing anything.
		const fine = await runTemporalNull({ ...SMALL, permutations: 90, workBudget: Infinity, chunkTargetMs: 0.02 });
		const coarse = await runTemporalNull({ ...SMALL, permutations: 90, workBudget: Infinity, chunkTargetMs: 10_000 });
		expect(coarse.chunks).toBe(2);
		expect(fine.chunks).toBeGreaterThan(coarse.chunks);
		expect(Array.from(fine.exceed)).toEqual(Array.from(coarse.exceed));
		expect(Array.from(fine.p)).toEqual(Array.from(coarse.p));
	});

	it('computes v_obs through the kernel\'s own code path', async () => {
		// At the identity permutation the kernel and `smoothTrajectories` are the same sum in the
		// same order, so `v_obs` and `v_p` are comparable bit for bit at the `>=` tie boundary. A
		// degenerate all-zero candidate is exactly on that boundary on every draw, and must exceed.
		const zeroRow = operands({ C: 3, N: 12, T: 10, rho: 0 });
		const res = await runTemporalNull({ ...zeroRow, permutations: 20, workBudget: Infinity });
		expect(Array.from(res.exceed)).toEqual([20, 20, 20]);
		expect(Array.from(res.p)).toEqual([1, 1, 1]);
	});

	it('keeps the completed draws when it is cancelled, and never half a draw', async () => {
		const controller = new AbortController();
		let seen = 0;
		const res = await runTemporalNull({
			...SMALL,
			permutations: 5000,
			workBudget: Infinity,
			chunkTargetMs: 0.01,
			signal: controller.signal,
			onProgress: (p) => {
				seen = p.completed;
				if (p.completed >= 10) controller.abort();
			}
		});
		expect(res.cancelled).toBe(true);
		expect(res.completed).toBeGreaterThanOrEqual(10);
		expect(res.completed).toBeLessThan(5000);
		expect(res.requested).toBe(5000);
		expect(seen).toBeGreaterThan(0);
		// A valid null at a coarser grid, and the same estimator: (1 + exceed) / (b + 1).
		expect(res.grid_step).toBeCloseTo(1 / (res.completed + 1), 12);
		for (let c = 0; c < res.exceed.length; c++) {
			expect(res.p[c]).toBeCloseTo((1 + res.exceed[c]) / (res.completed + 1), 12);
			expect(res.exceed[c]).toBeLessThanOrEqual(res.completed);
		}
		// And the stopped run is bit-identical to one configured at the achieved count.
		const equivalent = await runTemporalNull({ ...SMALL, permutations: res.completed, workBudget: Infinity });
		expect(Array.from(equivalent.exceed)).toEqual(Array.from(res.exceed));
	});

	it('walks the rounds when no count is named, and stops at the reference\'s own default', async () => {
		const res = await runTemporalNull({ ...SMALL, workBudget: Infinity });
		expect(res.rounds).toEqual([...TEMPORAL_PERM_ROUNDS]);
		expect(res.requested).toBe(TEMPORAL_PERM_ROUNDS[TEMPORAL_PERM_ROUNDS.length - 1]);
		expect(res.completed).toBe(res.requested);
		expect(TEMPORAL_PERM_ROUNDS[0]).toBe(TEMPORAL_THRESHOLDS.permutationsDefault);
		expect(TEMPORAL_PERM_ROUNDS[2]).toBe(TEMPORAL_THRESHOLDS.permutationsReference);
	});

	it('costs what the cost model says, from MEASURED nnz and never from N', () => {
		const nnz = candidateNnz(SMALL.candAttrs, SMALL.C, SMALL.N);
		expect(nnz).toBeGreaterThan(0);
		expect(nnz).toBeLessThan(SMALL.C * SMALL.N);
		expect(temporalNullWork({ B: 100, C: SMALL.C, T: SMALL.T, nnz })).toBeCloseTo(
			100 * SMALL.C * SMALL.T * (nnz / SMALL.C + TEMPORAL_PERM_STAT_UNITS),
			6
		);
		// The fixed term dominates at low density, which is the correction this phase measured: the
		// kernel survey's cost model used 7 and the measurement says 21.
		expect(TEMPORAL_PERM_STAT_UNITS).toBe(21);
		expect(TEMPORAL_PERM_RATE).toBe(9.0e8);
	});

	it('admits the rounds that fit and refuses only what does not', () => {
		const fits = temporalNullBudget({ C: 246, N: 95, T: 60, nnz: 1000 });
		expect(fits.within).toBe(true);
		expect(fits.rounds).toEqual([...TEMPORAL_PERM_ROUNDS]);
		expect(fits.B).toBe(1000);
		// The acceptance run at the CLI's own defaults is 1.5e9 units, 3 % of the budget.
		expect(temporalNullWork({ B: 1000, C: 246, T: 250, nnz: 1002 })).toBeLessThan(TEMPORAL_PERM_BUDGET_DEFAULT / 30);

		// A partial admission: the budget stops the schedule midway.
		const partial = temporalNullBudget({ C: 1500, N: 256, T: 250, nnz: 115_000, workBudget: 2.0e10 });
		expect(partial.within).toBe(true);
		expect(partial.rounds).toEqual([200, 500]);
		expect(partial.B).toBe(500);

		// And an outright refusal, which needs a gene no organism has — the honest headline is that
		// this pillar's null is affordable and the DMS is the expensive section.
		const refused = temporalNullBudget({ C: 40_000, N: 512, T: 250, nnz: 40_000 * 256 });
		expect(refused.within).toBe(false);
		expect(refused.B).toBe(0);
		expect(refused.reason).toContain('above this surface');
		expect(refused.reason).toContain('40000');
	});

	it('withholds only the null when it refuses, and says so as a number', async () => {
		const res = await runTemporalNull({ ...SMALL, workBudget: 1 });
		expect(res.skipped).toBe(true);
		expect(res.completed).toBe(0);
		// Never 1.0, which means "tested and never exceeded". NaN means "not tested".
		expect(Array.from(res.p).every(Number.isNaN)).toBe(true);
		expect(res.v_obs.length).toBe(SMALL.C);
	});

	it('calibrates the chunk against the clock rather than guessing a count', () => {
		expect(chunkFor(0.001)).toBe(256);
		expect(chunkFor(200)).toBe(1);
		expect(chunkFor(4)).toBe(50);
		expect(chunkFor(0)).toBe(256);
	});
});

// =================================================================================================
// Layer 4: the seams
// =================================================================================================

describe('the refusals, which are the reader\'s input and not a server fault', () => {
	const loaded = {
		L: 4,
		N: 6,
		taxa: ['a', 'b', 'c', 'd', 'e', 'f'],
		a: new Int32Array(24),
		invariable: new Uint8Array([0, 0, 0, 0]),
		notices: { duplicatesCollapsed: 0 }
	};

	it('refuses fewer than five dated sequences, in the reference\'s own words', async () => {
		const out = await runTemporal({ loaded, dates: [2000, 2001, 2002, NaN, NaN, NaN], predict: async () => ({}) });
		expect(out.ok).toBe(false);
		expect(out.refusal).toBe(TEMPORAL_REFUSALS.TOO_FEW_DATED);
		expect(out.message).toContain('at least 5');
		expect(out.warnings[out.warnings.length - 1].severity).toBe('refuse');
	});

	it('refuses a non-positive span', async () => {
		const out = await runTemporal({ loaded, dates: [2000, 2000, 2000, 2000, 2000, 2000], predict: async () => ({}) });
		expect(out.ok).toBe(false);
		expect(out.refusal).toBe(TEMPORAL_REFUSALS.NO_TIME_SPAN);
		expect(out.message).toContain('same time coordinate');
	});

	it('refuses an undated alignment', async () => {
		const out = await runTemporal({ loaded, dates: new Array(6).fill(NaN), predict: async () => ({}) });
		expect(out.ok).toBe(false);
		expect(out.refusal).toBe(TEMPORAL_REFUSALS.NO_DATES);
	});

	it('refuses a date vector that is not the run\'s taxon set', async () => {
		await expect(runTemporal({ loaded, dates: [2000, 2001], predict: async () => ({}) })).rejects.toThrow(/date vector has 2 entries/);
	});

	it('refuses a two-output graph rather than reading zeros as attention', async () => {
		await expect(
			runTemporal({ loaded, dates: [2000, 2001, 2002, 2003, 2004, 2005], predict: async () => ({ lrt: new Float32Array(4) }) })
		).rejects.toThrow(/mean_root_attns/);
	});
});

describe('the vocabulary', () => {
	it('namespaces every code and orders them for a report', () => {
		for (const code of TEMPORAL_DIAGNOSTIC_CODES) expect(code).toMatch(/^TEMPORAL_/);
		expect(new Set(TEMPORAL_DIAGNOSTIC_CODES).size).toBe(TEMPORAL_DIAGNOSTIC_CODES.length);
		for (const code of Object.values(TEMPORAL_REFUSALS)) expect(TEMPORAL_DIAGNOSTIC_CODES).toContain(code);
	});

	it('splits our date rules from the reference\'s, with no rule in both lists', () => {
		// D31. A rule documented against `temporal.py` is one the temporal parser has; a rule
		// documented against `dating.py` is a lab convention it lacks and we must not benefit from
		// silently. `js/src/dates.js`'s own DATE_RULES table is the citation.
		const overlap = TEMPORAL_REFERENCE_RULES.filter((r) => TEMPORAL_BEYOND_REFERENCE_RULES.includes(r));
		expect(overlap).toEqual([]);
		expect(TEMPORAL_BEYOND_REFERENCE_RULES).toContain('korber_isolate');
		expect(TEMPORAL_REFERENCE_RULES).toContain('header_decimal_year');
	});

	it('carries the reference\'s own constants, not rounded versions of them', () => {
		expect(TEMPORAL_THRESHOLDS.minDatedTaxa).toBe(5);
		expect(TEMPORAL_THRESHOLDS.timePointsDefault).toBe(250);
		expect(TEMPORAL_THRESHOLDS.permAlpha).toBe(0.05);
		expect(TEMPORAL_THRESHOLDS.minR2Fpca).toBe(0.35);
		expect(TEMPORAL_THRESHOLDS.tauPeak).toBe(1e-4);
		expect(TEMPORAL_THRESHOLDS.qStaticCut).toBe(0.1);
		expect(TEMPORAL_THRESHOLDS.permutationsReference).toBe(1000);
		// D26: the browser's first answer is 200, and that is a different number from the CLI's.
		expect(TEMPORAL_THRESHOLDS.permutationsDefault).toBe(200);
		expect(TEMPORAL_THRESHOLDS.permutationsDefault).not.toBe(TEMPORAL_THRESHOLDS.permutationsReference);
	});
});

acceptance('the record is a column store, not a list of rows', () => {
	it('holds 27 parallel columns and builds a row only on demand', () => {
		const r = chain.record;
		expect(r.sites.lrt).toBeInstanceOf(Float32Array);
		expect(r.sites.peak_date).toBeInstanceOf(Float64Array);
		expect(r.sites.wave_loadings).toHaveLength(r.codons_total * 4);
		expect(r.curves.prevalence).toBeInstanceOf(Float64Array);
		expect(r.curves.prevalence).toHaveLength(r.codons_total * r.curves.T);
		const row = siteRow(r, 0);
		expect(Object.keys(row)).toEqual([...TEMPORAL_SITES_COLUMNS]);
		expect(row.site).toBe(1);
	});

	it('survives structuredClone, which is what IndexedDB and postMessage need', () => {
		const clone = structuredClone(chain.record);
		expect(clone.sites.lrt[17]).toBe(chain.record.sites.lrt[17]);
		expect(clone.curves.prevalence.length).toBe(chain.record.curves.prevalence.length);
		expect(clone.waves.sign).toBe('canonical');
	});
});

/** A CSV we just wrote, parsed the same way the fixture is. */
function parseCsvText(text) {
	const lines = text.trim().split('\n');
	return { header: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) };
}

// =================================================================================================
// Layer 4b: the branches no real example reaches, driven through a stub graph
// =================================================================================================

/**
 * A small synthetic run with the model replaced by a callback.
 *
 * WHY A STUB AND NOT THE REAL GRAPH. Five behaviours below — the escape hatch, an unscored
 * invariable codon, a cancelled null, a null above the budget, and an explicit root taxon carrying
 * gaps — cannot be reached from `examples/` at all: the acceptance run confirms sweeps without the
 * hatch, scores every codon, finishes its null in 45 ms and has no gapped root. A branch that is
 * only exercised by a real dataset is a branch that is not exercised, so these are built to order.
 * Nothing here is compared against the reference; what is asserted is the app-side SEMANTICS of
 * each, which is this layer's half of the split.
 */
function stubRun({ L = 12, N = 8, invariable = [], attn = null, lrt = null } = {}) {
	const taxa = Array.from({ length: N }, (_, i) => `t${i}`);
	const inv = new Uint8Array(L);
	for (const s of invariable) inv[s] = 1;
	// AA tokens: an invariable codon is one residue everywhere; a variable one alternates, so
	// `delta_root` is nonzero and the trajectory has somewhere to go.
	const a = new Int32Array(L * N);
	for (let s = 0; s < L; s++) {
		for (let n = 0; n < N; n++) a[s * N + n] = inv[s] ? 3 : n < N / 2 ? 3 : 7;
	}
	const loaded = { L, N, taxa, a, invariable: inv, notices: { duplicatesCollapsed: 0 } };
	const dates = Array.from({ length: N }, (_, i) => 2000 + i / (N - 1));
	const predict = async ({ siteIndices }) => {
		const out = new Float32Array(L);
		const rows = new Float32Array(L * N).fill(1 / N);
		for (const s of siteIndices) out[s] = lrt ? lrt(s) : 1 + (s % 3);
		if (attn) attn(rows, L, N);
		return { lrt: out, mean_root_attns: { data: rows, dims: [L, N] } };
	};
	return { loaded, dates, predict };
}

describe('the branches no example reaches', () => {
	it('reports an unscored invariable codon as ABSENT, and the writer leaves the cell empty', async () => {
		const { loaded, dates, predict } = stubRun({ L: 10, invariable: [0, 1, 9] });
		const r = await runTemporal({ loaded, dates, predict, options: { numTimePoints: 12, permutations: 20, scoreInvariableSites: false } });
		expect(r.ok).toBe(true);
		expect(r.primaeon.score_invariable_sites).toBe(false);
		expect(r.primaeon.scored_codons).toBe(7);
		for (const s of [0, 1, 9]) {
			// NaN, never 0 — a zero LRT is a real claim about a codon and this is the absence of one.
			expect(Number.isNaN(r.sites.lrt[s]), `site ${s + 1} lrt`).toBe(true);
			expect(Number.isNaN(r.sites.p_static[s])).toBe(true);
			// But the trajectory really is zero there, so its q, curve and loadings are untouched.
			expect(r.sites.q_static[s]).toBe(1);
			expect(r.sites.peak_intensity[s]).toBe(0);
		}
		const written = parseCsvText(temporalSitesCsvText(r));
		expect(csvColumn(written, 'lrt')[0]).toBe('');
		expect(csvColumn(written, 'p_static')[0]).toBe('');
		expect(csvColumn(written, 'lrt')[2]).not.toBe('');
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_INVARIABLE_SITES_UNSCORED');
		// And the reproduction line stops claiming it would reproduce the run.
		const { reproduces, caveats } = temporalReferenceCommand(r);
		expect(reproduces).toBe(false);
		expect(caveats.join(' ')).toContain('not sent to the model');
	});

	it('records the escape hatch, which the reference writes into no file at all', async () => {
		// temporal.py:692-693 fires when the confirmed COUNT is zero on a calendar run that is not
		// solitary, and then calls everything with `p_perm <= 0.10` OR a static `lrt >= 3.84` — two
		// hard-coded numbers, neither of them the caller's alpha. Forced here with `permAlpha: 0`,
		// which no p can ever satisfy (the smallest is 1/(B+1)), because no bundled example reaches
		// the branch: a CSV of a run that confirmed nothing and a CSV of a run that confirmed thirty
		// sites through the hatch are indistinguishable upstream, and `escape_hatch_used` is how this
		// record tells them apart.
		const { loaded, dates, predict } = stubRun({ L: 12, lrt: (s) => (s % 2 === 0 ? 9 : 0.1) });
		const r = await runTemporal({
			loaded, dates, predict,
			options: { numTimePoints: 16, permutations: 30, permAlpha: 0, minR2Fpca: 0.35 }
		});
		expect(r.ok).toBe(true);
		expect(r.solitary_regime).toBe(false);
		expect(r.stage1_candidates).toBeGreaterThan(3);
		expect(r.escape_hatch_used).toBe(true);
		expect(r.confirmed_sweeps).toBeGreaterThan(0);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_ESCAPE_HATCH');
		const w = r.warnings.find((x) => x.code === 'TEMPORAL_ESCAPE_HATCH');
		expect(w.message).toContain('fallback selection');
		expect(w.data.upstream).toContain('temporal.py:692-693');
		// Everything it called cleared one of the two hard-coded numbers, and NOT `permAlpha`.
		for (let s = 0; s < r.codons_total; s++) {
			if (!r.sites.is_confirmed_sweep[s]) continue;
			expect(r.sites.lrt[s] >= 3.84 || r.sites.p_perm[s] <= 0.1).toBe(true);
			expect(r.sites.p_perm[s]).toBeGreaterThan(r.floors.perm_alpha);
		}
		// The CSV it writes is silent about all of it, which is the point of the record field.
		const written = parseCsvText(temporalSitesCsvText(r));
		expect(written.header).not.toContain('escape_hatch_used');
	});

	it('withholds the null above the budget and withholds nothing else', async () => {
		const { loaded, dates, predict } = stubRun({ L: 12 });
		const r = await runTemporal({ loaded, dates, predict, options: { numTimePoints: 16, workBudget: 1 } });
		expect(r.ok).toBe(true);
		expect(r.permutations.skipped).toBe(true);
		expect(r.permutations.tested).toBe(false);
		expect(r.confirmed_sweeps).toBe(0);
		expect(r.escape_hatch_used).toBe(false);
		// The deterministic half is complete and correct.
		expect(r.stage1_candidates).toBeGreaterThan(0);
		expect(r.curves.prevalence.some((v) => v !== 0)).toBe(true);
		// `p_perm` at a candidate is ABSENT, not 1.0 — "not tested", never "not a sweep".
		for (const site of r.candidates) expect(Number.isNaN(r.sites.p_perm[site - 1])).toBe(true);
		// A non-candidate keeps the reference's own 1.0, which is what its CSV says.
		const nonCandidate = [...Array(r.codons_total).keys()].find((s) => !r.candidates.includes(s + 1));
		if (nonCandidate !== undefined) expect(r.sites.p_perm[nonCandidate]).toBe(1);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_NULL_SKIPPED');
		const { reproduces } = temporalReferenceCommand(r);
		expect(reproduces).toBe(false);
	});

	it('keeps the trajectories when the null is cancelled, and says at what draw count', async () => {
		const { loaded, dates, predict } = stubRun({ L: 12 });
		const controller = new AbortController();
		const r = await runTemporal({
			loaded, dates, predict,
			options: { numTimePoints: 16, permutations: 4000 },
			signal: controller.signal,
			onProgress: (p) => {
				if (p.stage === 'null' && p.permutations.completed >= 5) controller.abort();
			}
		});
		expect(r.ok).toBe(true);
		expect(r.permutations.cancelled).toBe(true);
		expect(r.permutations.completed).toBeGreaterThanOrEqual(5);
		expect(r.permutations.completed).toBeLessThan(4000);
		expect(r.permutations.tested).toBe(true);
		expect(r.curves.prevalence.some((v) => v !== 0)).toBe(true);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_NULL_TRUNCATED');
		const w = r.warnings.find((x) => x.code === 'TEMPORAL_NULL_TRUNCATED');
		expect(w.message).toContain(`${r.permutations.completed} of 4000`);
		// The estimator at the achieved count, which is the same estimator on a coarser grid.
		for (const site of r.candidates) {
			expect(r.sites.p_perm[site - 1]).toBeGreaterThanOrEqual(1 / (r.permutations.completed + 1) - 1e-7);
		}
	});

	it('names an explicit root, and flags the Alanine that an unknown residue becomes', async () => {
		// UPSTREAM BUG TEMPORAL Q2 (temporal.py:355). The root taxon's gaps become index 0, so every
		// other sequence reads as different from the root AT INVARIABLE CODONS TOO, which is the one
		// configuration in which the model's outputs there are load-bearing. `run.js` therefore pins
		// `scoreInvariableSites` back on rather than honouring a caller who turned it off.
		const { loaded, dates, predict } = stubRun({ L: 10, N: 8, invariable: [0, 1] });
		for (let s = 0; s < 10; s++) loaded.a[s * 8 + 2] = 20; // taxon t2 is a gap everywhere
		const r = await runTemporal({
			loaded, dates, predict,
			options: { numTimePoints: 12, permutations: 10, rootTaxon: 't2', scoreInvariableSites: false }
		});
		expect(r.root.source).toBe('root-taxon');
		expect(r.root.taxon).toBe('t2');
		expect(r.primaeon.score_invariable_sites).toBe(true);
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('TEMPORAL_ROOT_UNKNOWN_RESIDUES');
		const w = r.warnings.find((x) => x.code === 'TEMPORAL_ROOT_UNKNOWN_RESIDUES' && x.severity === 'warn');
		expect(w.data.count).toBe(10);
		expect(w.message).toContain('ALANINE');
		// And the bug's visible consequence: an invariable codon now carries a real trajectory.
		expect(r.sites.ref_aa[0]).toBe('A');
		expect(r.sites.peak_intensity[0]).toBeGreaterThan(0);
	});

	it('falls back to the earliest-sample consensus when the named root is not there', async () => {
		const { loaded, dates, predict } = stubRun({ L: 8 });
		const r = await runTemporal({ loaded, dates, predict, options: { numTimePoints: 10, permutations: 10, rootTaxon: 'nope' } });
		expect(r.root.source).toBe('early-consensus');
		// temporal.py:366's window: max(3, min(25, int(0.05*N))) — three for anything under 60.
		expect(r.root.window).toBe(3);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_ROOT_TAXON_NOT_FOUND');
	});

	it('takes the fixation branch on a non-calendar axis and says what changed', async () => {
		const { loaded, dates, predict } = stubRun({ L: 10 });
		const gens = dates.map((_, i) => i * 500);
		const r = await runTemporal({ loaded, dates: gens, predict, options: { numTimePoints: 16, permutations: 10, timeUnits: 'generations' } });
		expect(r.regime.sweep_mode).toBe('fixation');
		expect(r.regime.non_calendar).toBe(true);
		expect(r.regime.unit_label).toBe('gen');
		// temporal.py:494: no ceiling on the bandwidth off the calendar, and no [0.05, 2.0] clamp.
		expect(r.bandwidth_years).toBeGreaterThan(2.0);
		// temporal.py:684: non-calendar is always the solitary regime, so the shape gate is bypassed.
		expect(r.solitary_regime).toBe(true);
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_UNITS_NOT_CALENDAR');
		// And the quirk: the key still says "years" (upstream TEMPORAL Q10).
		expect(Object.keys(JSON.parse(temporalSummaryJsonText(r)))).toContain('timespan_years');
	});

	it('counts the dates our parser reads and the reference\'s cannot', async () => {
		// D31's honesty rule, driven from a DateIngest rather than a bare vector, because the rule
		// table only survives that shape. `korber_isolate` is one of the conventions
		// `temporal.parse_temporal_metadata` does not have at all.
		const { loaded, predict } = stubRun({ L: 8, N: 8 });
		const ingest = {
			schema_version: 1,
			source: 'headers',
			by_rule: { korber_isolate: 6, header_decimal_year: 2 },
			rows: loaded.taxa.map((t, i) => ({ taxon: t, value: 2000 + i / 7 }))
		};
		const r = await runTemporal({ loaded, dates: ingest, predict, options: { numTimePoints: 10, permutations: 10 } });
		expect(r.dates.beyond_reference.count).toBe(6);
		expect(r.dates.beyond_reference.rules).toEqual({ korber_isolate: 6 });
		expect(r.warnings.map((w) => w.code)).toContain('TEMPORAL_DATES_BEYOND_REFERENCE');
		const { reproduces, caveats } = temporalReferenceCommand(r);
		expect(reproduces).toBe(false);
		expect(caveats.join(' ')).toContain('will not reproduce this run');
	});
});
