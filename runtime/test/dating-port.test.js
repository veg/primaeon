/**
 * dating-port.test.js — the model-free dating pillar, end to end, against the reference's own
 * published record.
 *
 * WHY THIS FILE EXISTS. `runtime/src/dating/` wires four ported estimators to a reader's data, and
 * every failure mode of that wiring produces a NUMBER rather than an error: a root measured to the
 * wrong sequence, an asterisk scored as an unknown instead of a gap, a trailing nucleotide left on,
 * a holdout admitted to the fit — each moves the ancestor date by years and none of them throws. So
 * the assertion that matters is not "the code runs" but "the chain lands on `hyphaeon dating`'s own
 * numbers", and the suite is built in four layers that fail for different reasons:
 *
 *   1. THE ACCEPTANCE RUN. `examples/korber_env_gp160.fasta` with `--root-taxon CONSENSUS --no-tree
 *      --method ols`, compared field by field against the reference record the phase was specified
 *      from. The headline numbers are HARD-CODED here, in the open, so the test states the claim it
 *      makes; the full 142-row comparison uses the engine's `fixtures/dating/run_mrca_dating.json`,
 *      which is the CLI's own output, when that checkout carries it.
 *   2. THE SECOND CASE. `examples/H1N1_2009_pandemic.fasta` takes the OTHER branch of every rule
 *      korber exercises: no sequence named CONSENSUS, so the root falls through to the time-decay
 *      weighted consensus; the `L mod 3` trim fires; the spline is REJECTED so every predicted date
 *      is one division rather than a root find; no holdout and one flagged outlier. A port tested
 *      only on korber would pass with the trim missing and with case 4 never executed.
 *   3. THE INDEPENDENT CHECK. `runtime/src/clockRegression.js` is a SEPARATE implementation of the
 *      same centred fit, kept app-side and un-reconciled for exactly this purpose (read its header).
 *      Handed the same divergences and the same training rows it must agree with the port on every
 *      field it has. It deliberately has no interval, so the interval is out of its scope.
 *   4. THE SEAMS. The refusals, the vocabulary, the import boundary that keeps this pillar
 *      model-free, and the two writers' shape.
 *
 * WHAT THE TOLERANCES ARE, AND WHY THEY DIFFER BY FIELD. Every bound below was MEASURED at this
 * commit and is asserted twice: once as the class, and once against the value actually observed, so
 * a regression cannot hide in the slack between them.
 *
 *   - root divergences and sampling dates: EXACT. The reference's cross-TN93 matrix is float32
 *     widened to float64; a port that stayed in float64 would be wrong by ~6e-8 relative for free,
 *     and exact equality is the cheapest detector of a missing rounding step.
 *   - the OLS block: 1e-9 absolute. MEASURED worst on korber 4.5e-10, on a Fieller endpoint, and the
 *     reason is not this port — scipy's own `t.ppf(0.975, 139)` is 8.1e-13 out in probability, which
 *     the 97.7-year lever arm turns into half a nanosecond of calendar time.
 *   - the SPLINE block: 1e-5 absolute. Not slack: the reference solves UNCENTRED normal equations on
 *     a calendar axis at cond 9.3e12 (DATING Q5), so only about five significant figures survive.
 *     MEASURED 1.1e-8 years on korber's spline date and 7.3e-6 relative on H1N1's β₀.
 *   - `predicted_date` / `temporal_residual`: 1e-6 years (30 seconds). Under the spline these come
 *     from `brentq` at xtol 2e-12 on top of a β that already differs at Q5's level, so the bound is
 *     inherited from the conditioning and not from the root finder. MEASURED 4.5e-7 on korber, 0 on
 *     H1N1.
 *
 * THE FLAGSHIP NUMBERS, for a reader of this file (measured `hyphaeon dating -a
 * examples/korber_env_gp160.fasta --root-taxon CONSENSUS --no-tree --method ols`): 143 sequences,
 * 142 dated, 141 in the fit; OLS t_MRCA 1893.911 with a Fieller interval [1850.900, 1916.793] at
 * g = 0.0934; µ = 1.169e-3 substitutions per site per year; r² 0.231; the spline WINS the curvature
 * test at F = 5.26, p = 0.0234, ΔAIC = +3.27 and puts the ancestor at 1938.775 with no interval at
 * all; ZERO sequences are flagged; and the one sequence every reader looks at, the 1959 Léopoldville
 * isolate Z59ZR.ZHU, is a holdout at 17.6 % coverage which the rule forbids flagging.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	DATING_DIAGNOSTIC_CODES,
	DATING_REFUSALS,
	DATING_THRESHOLDS,
	RECORD_KEYS,
	TAXON_COLUMNS,
	admitEnsembleCandidates,
	coverageHoldout,
	datingCsvText,
	datingJsonText,
	datingDownloads,
	datingTaxonRecords,
	rankTaxonRows,
	runDating,
	selectClockModel,
	starsToGaps,
	verifyCodingAlignment
} from '../src/dating/index.js';
import { clockRegression } from '../src/clock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? join(RUNTIME, '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');
const DATING_FIXTURES = join(ENGINE, 'fixtures', 'dating');

/** The library must carry the phase-3 estimators; CI pins an ENGINE_REF that may predate them. */
let LIB = null;
let MISSING = [];
try {
	LIB = await import('@veg/hyphaeon-js');
	MISSING = ['runOlsDating', 'runRestrictedSplineClockDating', 'computeTreeFreeDivergences', 'clockFittedAndPredicted'].filter(
		(n) => typeof LIB[n] !== 'function'
	);
} catch (err) {
	MISSING = [`@veg/hyphaeon-js could not be imported: ${err.message}`];
}
if (MISSING.length > 0) {
	console.warn(
		`\n[dating-port] SUITE SKIPPED — the linked @veg/hyphaeon-js does not export ${MISSING.join(', ')}. ` +
			`It predates js/src/dating.js (feat/date-parsers); check out an engine carrying the dating port beside ` +
			`this repository.\n`
	);
}
const HAS_LIBRARY = MISSING.length === 0;
const HAS_EXAMPLES = existsSync(join(EXAMPLES, 'korber_env_gp160.fasta')) && existsSync(join(EXAMPLES, 'H1N1_2009_pandemic.fasta'));
if (!HAS_EXAMPLES) console.warn(`\n[dating-port] ACCEPTANCE RUN SKIPPED — needs ${EXAMPLES}/korber_env_gp160.fasta.\n`);
const HAS_RECORDS = existsSync(join(DATING_FIXTURES, 'run_mrca_dating.json'));
if (!HAS_RECORDS) console.warn(`\n[dating-port] PER-TAXON COMPARISON SKIPPED — needs ${DATING_FIXTURES}/run_mrca_dating.json.\n`);

const suite = describe.skipIf(!HAS_LIBRARY);
const withExamples = describe.skipIf(!HAS_LIBRARY || !HAS_EXAMPLES);
const withRecords = describe.skipIf(!HAS_LIBRARY || !HAS_EXAMPLES || !HAS_RECORDS);

// =================================================================================================
// The reference's numbers, stated rather than loaded
// =================================================================================================

/**
 * `hyphaeon dating -a examples/korber_env_gp160.fasta --root-taxon CONSENSUS --no-tree --method ols`,
 * measured 2026-09-07. These are the acceptance test: if the chain ever stops landing on them, the
 * failure names the field rather than pointing at a fixture file.
 */
const KORBER = Object.freeze({
	sequences: 143,
	dated: 142,
	n: 141,
	root_description: 'explicit_root_CONSENSUS',
	timespan: [1959.5, 1997.5],
	mu: 0.0011690322000749895,
	d0: 0.11415106391019024,
	t_ref: 1991.5567375886526,
	t_mrca: 1893.91095511759,
	se_mu: 0.00018073676662794878,
	se_d0: 0.0006706729732884341,
	se_mrca: 15.10730156514219,
	ci_fieller: [1850.9002455209902, 1916.7928463014516],
	ci_delta: [1864.0411349860476, 1923.7807752491324],
	fieller_g: 0.09343971122537506,
	r: 0.48099037761592794,
	r2: 0.23135174335911296,
	p_value: 1.569958274494354e-9,
	sigma2: 6.342211543103636e-5,
	rmse: 0.007907117740165328,
	spline: {
		t_mrca: 1938.7746674292187,
		beta: [-4.386825916889575, 0.0022626796143908924, -9.656883577635083e-4],
		knots: [1983.5, 1992.5, 1995.5],
		rate_ancestral: 0.0022626796143908924,
		rate_recent: 8.988080942299876e-5,
		rate_ratio: 0.039723171080583784,
		f_stat: 5.255140428205752,
		p_f_test: 0.023394714664289055,
		delta_aic: 3.2696711294240686,
		rss: 0.0084922817747531,
		aic: -1364.1473997265941,
		r2: 0.25954866890376405
	},
	selected_clock: 'Restricted Spline (rate deceleration (0.04x) detected: F=5.26, p=0.0234, ΔAIC=+3.3)',
	ensemble: { t_mrca: 1893.91095511759, ci: [1860.9646547273592, 1926.8572555078208] },
	holdout: { taxon: 'Z59ZR.ZHU', coverage: 0.1763506625891947, z_score: 1.7871525967316242, predicted_date: 1965.6297281454372 },
	first_row: { taxon: 'A92UG.037', root_divergence: 0.11822299659252167, predicted_date: 2003.6856960861119 },
	prediction_methods: { spline: 118, linear_arm: 12, linear_fallback: 12 },
	stars: 2389,
	star_taxa: 18,
	max_abs_z: 2.392941094929636,
	bracket_ceiling: 2097.5
});

/** The same command on `examples/H1N1_2009_pandemic.fasta`, which fails differently on every axis. */
const H1N1 = Object.freeze({
	sequences: 100,
	dated: 95,
	n: 95,
	root_description: 'time_decay_consensus_root (γ=3.0030)',
	trimmed_nt: 2,
	mu: 0.00258113859842902,
	t_mrca: 2009.0426391755814,
	ci_fieller: [2008.9545837411533, 2009.1101145211278],
	r2: 0.6766130002729183,
	p_value: 1.1102230246251565e-16,
	spline: { is_nonlinear_preferred: false, t_mrca: 2008.909417416679, f_stat: 0.9343819641317569, delta_aic: -1.040015804550194 },
	selected_clock: 'Linear (Standard OLS)',
	outlier: 'A/Santo_Domingo/WR1059N/2009|North_America_/_Dominican_Republic|181|2009.496'
});

/**
 * The worst |Δ| against the reference, per example, MEASURED at this commit. The tolerance classes
 * above say what would be acceptable; these say what actually happens, and the gap between them is
 * where a regression would otherwise live. 5 % of headroom absorbs a change in Node's libm.
 */
const MEASURED = Object.freeze({
	korber: { ols: 4.4519765651784837e-10, spline: 1.1392558008083142e-8, fitted: 1.4769518941193382e-11, date: 4.5323713493417017e-7, z: 1.9031018982929027e-9, ensemble: 2.8558133635669947e-10 },
	h1n1: { ols: 3.3306690738754696e-16, spline: 7.300432503853926e-6, fitted: 4.336808689942018e-19, date: 0, z: 1.3322676295501878e-15, ensemble: 0 }
});

/** The port against the independent preview, MEASURED: relative, except `tMrca` which is years. */
const MEASURED_VS_PREVIEW = Object.freeze({
	korber: { mu: 7.985221197928838e-13, tMrca: 7.79891706770286e-11 },
	h1n1: { mu: 5.926709624276747e-12, tMrca: 2.5011104298755527e-12 }
});

// =================================================================================================
// Helpers
// =================================================================================================

function runExample(fasta, rootTaxon = 'CONSENSUS', options = {}) {
	const text = readFileSync(join(EXAMPLES, fasta), 'utf8');
	const raw = LIB.parseAlignmentSequences(text);
	const seqs = raw instanceof Map ? raw : new Map(Object.entries(raw));
	// The date layer's own default for this example is the header fallback with the 1959 anchor ON,
	// which is what the reference applies unconditionally (dating.py:330-332, DATES_ARCHIVAL_1959).
	const dates = new Map([...seqs.keys()].map((t) => [t, LIB.parseHeaderTimestamp(t, { archival1959: true })]));
	return { text, seqs, dates, run: runDating({ alignmentText: text, dates, rootTaxon, alignmentName: `examples/${fasta}`, ...options }) };
}

function referenceRecord(name) {
	const cases = JSON.parse(readFileSync(join(DATING_FIXTURES, 'run_mrca_dating.json'), 'utf8'));
	return cases.find((c) => c.name === name)?.outputs?.result ?? null;
}

const near = (got, want, tol) => Math.abs(got - want) <= tol;
const code = (run, c) => run.warnings.find((w) => w.code === c);
const codes = (run) => run.warnings.map((w) => w.code);

// =================================================================================================
// 1 + 2. The acceptance run, and the second case
// =================================================================================================

withExamples('the acceptance run: hyphaeon dating --root-taxon CONSENSUS --no-tree --method ols', () => {
	const { run } = runExample('korber_env_gp160.fasta');

	it('reads 143 sequences, dates 142 and fits 141, with the 1959 isolate reserved', () => {
		expect(run.ok).toBe(true);
		expect(run.record.primaeon.sequences_in_file).toBe(KORBER.sequences);
		expect(run.taxa.length).toBe(KORBER.dated);
		expect(run.ols.n).toBe(KORBER.n);
		expect(run.record.primaeon.holdouts).toEqual([KORBER.holdout.taxon]);
		expect(run.rootDescription).toBe(KORBER.root_description);
		expect(run.record.timespan).toEqual(KORBER.timespan);
	});

	it('lands on the reference OLS fit: the rate, the ancestor and BOTH intervals', () => {
		expect(near(run.ols.mu, KORBER.mu, 1e-15)).toBe(true);
		expect(near(run.ols.d0, KORBER.d0, 1e-15)).toBe(true);
		expect(near(run.ols.t_ref, KORBER.t_ref, 1e-9)).toBe(true);
		expect(near(run.ols.t_mrca, KORBER.t_mrca, 1e-9)).toBe(true);
		expect(near(run.ols.se_mu, KORBER.se_mu, 1e-15)).toBe(true);
		expect(near(run.ols.se_d0, KORBER.se_d0, 1e-15)).toBe(true);
		expect(near(run.ols.se_mrca, KORBER.se_mrca, 1e-9)).toBe(true);
		expect(near(run.ols.ci_fieller[0], KORBER.ci_fieller[0], 1e-9)).toBe(true);
		expect(near(run.ols.ci_fieller[1], KORBER.ci_fieller[1], 1e-9)).toBe(true);
		expect(near(run.ols.ci_delta[0], KORBER.ci_delta[0], 1e-9)).toBe(true);
		expect(near(run.ols.ci_delta[1], KORBER.ci_delta[1], 1e-9)).toBe(true);
		expect(near(run.ols.fieller_g, KORBER.fieller_g, 1e-9)).toBe(true);
		expect(near(run.ols.r, KORBER.r, 1e-12)).toBe(true);
		expect(near(run.ols.r2, KORBER.r2, 1e-12)).toBe(true);
		expect(near(run.ols.p_value, KORBER.p_value, 1e-15)).toBe(true);
		expect(near(run.ols.sigma2, KORBER.sigma2, 1e-15)).toBe(true);
		expect(near(run.ols.rmse, KORBER.rmse, 1e-12)).toBe(true);
		expect(run.ols.status).toBe('OK');
		// dating.py:1246/1285 — `ci_bootstrap` is initialised to None and never assigned (B6).
		expect(run.ols.ci_bootstrap).toBeNull();
	});

	it('the curvature test prefers the spline, on the reference\'s own statistics', () => {
		const s = run.spline;
		expect(s.is_nonlinear_preferred).toBe(true);
		expect(near(s.f_stat, KORBER.spline.f_stat, 1e-9)).toBe(true);
		expect(near(s.p_f_test, KORBER.spline.p_f_test, 1e-9)).toBe(true);
		expect(near(s.delta_aic, KORBER.spline.delta_aic, 1e-9)).toBe(true);
		expect(near(s.t_mrca, KORBER.spline.t_mrca, 1e-5)).toBe(true);
		expect(near(s.rate_ratio, KORBER.spline.rate_ratio, 1e-9)).toBe(true);
		expect(near(s.rate_recent, KORBER.spline.rate_recent, 1e-9)).toBe(true);
		expect(s.knots).toEqual(KORBER.spline.knots);
		KORBER.spline.beta.forEach((b, i) => expect(near(s.beta[i], b, 1e-5)).toBe(true));
		expect(run.activeName).toBe('spline');
		expect(run.selectedClock).toBe(KORBER.selected_clock);
	});

	it('the spline has no interval, and says so rather than drawing [x, x]', () => {
		// DATING Q1: every bootstrap replicate raises upstream, so all four intervals ARE the point
		// estimates. Replicated on purpose; a widening here means someone "improved" the port.
		expect(run.spline.ci_mrca[0]).toBe(run.spline.ci_mrca[1]);
		expect(run.spline.ci_rate_ancestral[0]).toBe(run.spline.ci_rate_ancestral[1]);
		expect(run.spline.ci_rate_recent[0]).toBe(run.spline.ci_rate_recent[1]);
		expect(run.spline.ci_beta_2[0]).toBe(run.spline.ci_beta_2[1]);
		expect(code(run, 'DATING_SPLINE_NO_INTERVAL')?.severity).toBe('warn');
	});

	it('the model-averaged row weights OLS at 1.0 — and says it is ignoring the selected model', () => {
		expect(run.ensemble.weights).toEqual({ ols: 1 });
		expect(near(run.ensemble.t_mrca, KORBER.ensemble.t_mrca, 1e-9)).toBe(true);
		expect(near(run.ensemble.ci_mrca[0], KORBER.ensemble.ci[0], 1e-8)).toBe(true);
		expect(near(run.ensemble.ci_mrca[1], KORBER.ensemble.ci[1], 1e-8)).toBe(true);
		// B10, and the 45-year gap it opens between two numbers in one record.
		expect(run.ensemble.ci_mrca[0]).not.toBe(run.ols.ci_fieller[0]);
		expect(code(run, 'DATING_ENSEMBLE_IGNORES_SELECTED')?.data.selected).toBe('spline');
	});

	it('the asterisk convention is applied, and it is the one the published numbers came from', () => {
		expect(run.record.primaeon.star_convention).toBe('gap');
		expect(run.record.primaeon.stars_rewritten).toBe(KORBER.stars);
		expect(code(run, 'DATING_STARS_REWRITTEN')?.data.taxa.length).toBeGreaterThan(0);
		// The proof that the convention is load-bearing is the divergence it produces for the one
		// sequence that carries 2323 of the 2389 asterisks: as a gap 0.0608, as an unknown 0.1106.
		const held = run.rows.find((r) => r.taxon === KORBER.holdout.taxon);
		expect(held.root_divergence).toBe(0.06076439842581749);
	});

	it('the per-taxon table: zero flagged, the holdout never flagged, and three models in one column', () => {
		expect(run.rows.length).toBe(KORBER.dated);
		expect(run.rows.filter((r) => r.is_outlier)).toEqual([]);
		expect(Math.max(...run.rows.map((r) => Math.abs(r.z_score)))).toBeCloseTo(KORBER.max_abs_z, 8);
		const held = run.rows.find((r) => r.taxon === KORBER.holdout.taxon);
		expect(held.is_holdout).toBe(true);
		expect(held.is_outlier).toBe(false);
		expect(near(held.z_score, KORBER.holdout.z_score, 1e-8)).toBe(true);
		expect(near(held.predicted_date, KORBER.holdout.predicted_date, 1e-6)).toBe(true);
		expect(run.record.primaeon.prediction_methods).toEqual(KORBER.prediction_methods);
		expect(code(run, 'DATING_PREDICTION_FALLBACK')?.data.count).toBe(12);
	});

	it('names the rows whose date is the root find running out of bracket, not converging', () => {
		expect(run.record.primaeon.bracket_ceiling).toBe(KORBER.bracket_ceiling);
		const saturated = code(run, 'DATING_PREDICTION_SATURATED');
		expect(saturated.data.count).toBeGreaterThan(0);
		for (const t of saturated.data.taxa) {
			const row = run.rows.find((r) => r.taxon === t);
			expect(KORBER.bracket_ceiling - row.predicted_date).toBeLessThanOrEqual(DATING_THRESHOLDS.bracketSaturationYears);
		}
	});

	it('every warning it raises is in the vocabulary, in report order', () => {
		const seen = codes(run);
		for (const c of seen) expect(DATING_DIAGNOSTIC_CODES, c).toContain(c);
		const ranks = seen.map((c) => DATING_DIAGNOSTIC_CODES.indexOf(c));
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
	});
});

withExamples('the second case: H1N1, which takes the other branch of every rule', () => {
	const { run } = runExample('H1N1_2009_pandemic.fasta');

	it('falls through to the time-decay weighted consensus, γ and all', () => {
		// There is no sequence named CONSENSUS in this file, so dating.py:643's literal key test
		// fails and case 4 builds a root. That synthetic sequence must be reproduced character for
		// character or all 95 divergences are wrong.
		expect(run.rootDescription).toBe(H1N1.root_description);
		expect(run.rootCase).toBe(4);
		expect(code(run, 'DATING_ROOT_TAXON_NOT_FOUND')).toBeTruthy();
		expect(code(run, 'DATING_ROOT_SYNTHETIC')).toBeTruthy();
	});

	it('the L mod 3 trim fires here and not on korber, and it moves every distance', () => {
		expect(run.record.primaeon.trimmed_nt).toBe(H1N1.trimmed_nt);
		expect(code(run, 'DATING_ALIGNMENT_TRIMMED')?.data.rem).toBe(2);
	});

	it('lands on the reference fit, and REJECTS the spline', () => {
		expect(run.ols.n).toBe(H1N1.n);
		expect(near(run.ols.mu, H1N1.mu, 1e-15)).toBe(true);
		expect(near(run.ols.t_mrca, H1N1.t_mrca, 1e-9)).toBe(true);
		expect(near(run.ols.ci_fieller[0], H1N1.ci_fieller[0], 1e-9)).toBe(true);
		expect(near(run.ols.ci_fieller[1], H1N1.ci_fieller[1], 1e-9)).toBe(true);
		expect(near(run.ols.r2, H1N1.r2, 1e-12)).toBe(true);
		// DATING Q4, AND THE ONE FIELD THAT CANNOT MATCH. `dating.py:1269` spells the regression p as
		// `1 - f.cdf(...)` where the sibling test at :1877 correctly uses `f.sf(...)`, so on any
		// clock cleaner than korber's r2 = 0.23 the value quantises at one ulp of 1.0. The port
		// replicates the SPELLING — `1 - fCdf(...)` — and still lands on 0 here, because scipy's own
		// `f.cdf` returns one ulp BELOW 1.0 where the correctly rounded double is exactly 1.0 (the
		// numerics survey measured it at `f.cdf(194.58, 1, 93)`; it is recorded under
		// `scipy_deviations` in the library's fixtures with mpmath as the arbiter). So the reference
		// prints 1.11e-16, the port prints 0, and the TRUE survival is 1.59e-24. Neither number is
		// the answer; the page must not quote either as one.
		expect(H1N1.p_value).toBe(2 ** -53); // one ulp below 1.0, which is all `1 - cdf` can resolve
		expect(run.ols.p_value).toBe(0);
		// The survival function the reference MEANT to call still resolves the tail on both sides.
		expect(LIB.fSf(41.836941733804075, 1, 139)).toBeGreaterThan(0);
		expect(run.spline.is_nonlinear_preferred).toBe(false);
		expect(near(run.spline.f_stat, H1N1.spline.f_stat, 1e-9)).toBe(true);
		expect(run.activeName).toBe('ols');
		expect(run.selectedClock).toBe(H1N1.selected_clock);
	});

	it('no holdout, one flagged sequence, and every date from one division', () => {
		expect(run.record.primaeon.holdouts).toEqual([]);
		expect(run.rows.filter((r) => r.is_outlier).map((r) => r.taxon)).toEqual([H1N1.outlier]);
		expect(run.record.primaeon.prediction_methods).toEqual({ ols: 95 });
		expect(code(run, 'DATING_PREDICTION_FALLBACK')).toBeUndefined();
	});
});

withRecords('every row of the reference\'s own record', () => {
	for (const [name, fasta, key] of [
		['korber_env_gp160', 'korber_env_gp160.fasta', 'korber'],
		['H1N1_2009_pandemic', 'H1N1_2009_pandemic.fasta', 'h1n1']
	]) {
		it(`${fasta}: 142/95 divergences exact, and every derived column inside its class`, () => {
			const ref = referenceRecord(name);
			expect(ref, `${name} is not in run_mrca_dating.json`).toBeTruthy();
			const { run } = runExample(fasta);
			const failures = [];
			let worstFitted = 0;
			let worstDate = 0;
			let worstZ = 0;

			expect(run.rows.map((r) => r.taxon)).toEqual(ref.taxa_summary.map((r) => r.taxon));
			ref.taxa_summary.forEach((r, i) => {
				const g = run.rows[i];
				// EXACT: the distances are float32 widened, and the dates are the date layer's.
				if (g.root_divergence !== r.root_divergence) failures.push(`${r.taxon}.root_divergence ${g.root_divergence} vs ${r.root_divergence}`);
				if (g.sampling_date !== r.sampling_date) failures.push(`${r.taxon}.sampling_date ${g.sampling_date} vs ${r.sampling_date}`);
				if (!near(g.fitted_divergence, r.fitted_divergence, 1e-9)) failures.push(`${r.taxon}.fitted_divergence`);
				if (!near(g.divergence_residual, r.divergence_residual, 1e-9)) failures.push(`${r.taxon}.divergence_residual`);
				if (!near(g.predicted_date, r.predicted_date, 1e-6)) failures.push(`${r.taxon}.predicted_date ${g.predicted_date} vs ${r.predicted_date}`);
				if (!near(g.temporal_residual, r.temporal_residual, 1e-6)) failures.push(`${r.taxon}.temporal_residual`);
				if (!near(g.z_score, r.z_score, 1e-8)) failures.push(`${r.taxon}.z_score`);
				if (g.is_outlier !== r.is_outlier) failures.push(`${r.taxon}.is_outlier ${g.is_outlier} vs ${r.is_outlier}`);
				if (g.is_holdout !== r.is_holdout) failures.push(`${r.taxon}.is_holdout ${g.is_holdout} vs ${r.is_holdout}`);
				worstFitted = Math.max(worstFitted, Math.abs(g.fitted_divergence - r.fitted_divergence));
				worstDate = Math.max(worstDate, Math.abs(g.predicted_date - r.predicted_date));
				worstZ = Math.max(worstZ, Math.abs(g.z_score - r.z_score));
			});
			expect(failures, failures.slice(0, 8).join('\n')).toEqual([]);

			// The bounds are not vacuous: what was MEASURED, not what is permitted.
			const m = MEASURED[key];
			expect(worstFitted, `fitted worst (measured ${m.fitted})`).toBeLessThanOrEqual(m.fitted * 1.05 + 1e-18);
			expect(worstDate, `predicted_date worst (measured ${m.date})`).toBeLessThanOrEqual(m.date * 1.05 + 1e-18);
			expect(worstZ, `z_score worst (measured ${m.z})`).toBeLessThanOrEqual(m.z * 1.05 + 1e-18);
		});
	}
});

// =================================================================================================
// 3. The independent check — clockRegression.js, kept separate on purpose
// =================================================================================================

withExamples('the port against runtime/src/clockRegression.js, which was written independently', () => {
	for (const [fasta, key] of [
		['korber_env_gp160.fasta', 'korber'],
		['H1N1_2009_pandemic.fasta', 'h1n1']
	]) {
		it(`${fasta}: the two agree on every field the preview has`, () => {
			const { run } = runExample(fasta);
			// The preview must be handed the TRAINING subset, because that is what the fit used.
			const idx = run.trainIndices;
			const preview = clockRegression({
				taxa: idx.map((i) => run.taxa[i]),
				divergence: idx.map((i) => run.divergences[i]),
				times: idx.map((i) => run.times[i])
			});
			expect(preview.ok).toBe(true);
			expect(preview.n).toBe(run.ols.n);
			const rel = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));
			// 1e-9 relative is the fixtures' own class and is three decades looser than what the two
			// actually achieve; the pinned measurements below are the real assertion. They differ at
			// all only because the preview forms `mu = Σxd/Σx²` on a left fold where the port solves
			// the full 2x2 normal equations with numpy's summation order — the library's own header
			// measures that choice at 9.4e-16 relative against scipy.
			for (const [k, ours] of [
				['mu', run.ols.mu],
				['d0', run.ols.d0],
				['tRef', run.ols.t_ref],
				['r2', run.ols.r2],
				['sigma2', run.ols.sigma2],
				['seMu', run.ols.se_mu],
				['seD0', run.ols.se_d0],
				['rmse', run.ols.rmse],
				['seMrca', run.ols.se_mrca]
			]) {
				expect(rel(preview[k], ours), `${k}: ${preview[k]} vs ${ours}`).toBeLessThan(1e-9);
			}
			expect(Math.abs(preview.tMrca - run.ols.t_mrca), 't_mrca, years').toBeLessThan(1e-6);

			const m = MEASURED_VS_PREVIEW[key];
			expect(rel(preview.mu, run.ols.mu), `mu, measured ${m.mu}`).toBeLessThanOrEqual(m.mu * 1.05 + 1e-18);
			expect(Math.abs(preview.tMrca - run.ols.t_mrca), `t_mrca, measured ${m.tMrca}`).toBeLessThanOrEqual(m.tMrca * 1.05 + 1e-18);

			// And the one thing the preview deliberately does NOT have, which is the whole reason it
			// was kept separate: an interval. If this ever stops being true, its header is wrong.
			expect(preview.ciFieller).toBeUndefined();
			expect(preview.ci_mrca).toBeUndefined();
		});
	}
});

// =================================================================================================
// 4. The seams: the steps, the refusals, the writers, the boundary
// =================================================================================================

suite('verifyCodingAlignment (dating.py:135-222), returning where the reference raises', () => {
	it('trims the L mod 3 remainder without touching the caller\'s sequences', () => {
		const input = new Map([
			['a', 'ACGTAC'],
			['b', 'ACGTAA']
		]);
		const long = new Map([...input].map(([k, v]) => [k, v + 'GG']));
		const out = verifyCodingAlignment(long);
		expect(out.ok).toBe(true);
		expect(out.trimmedBy).toBe(2);
		expect(out.sequences.get('a')).toBe('ACGTAC');
		expect(long.get('a')).toBe('ACGTACGG');
		expect(out.warnings.map((w) => w.code)).toContain('DATING_ALIGNMENT_TRIMMED');
	});

	it('refuses an empty alignment and a ragged one, by code', () => {
		expect(verifyCodingAlignment(new Map()).refusal).toBe(DATING_REFUSALS.ALIGNMENT_EMPTY);
		const ragged = verifyCodingAlignment(new Map([['a', 'ACGACG'], ['b', 'ACG']]));
		expect(ragged.ok).toBe(false);
		expect(ragged.refusal).toBe(DATING_REFUSALS.ALIGNMENT_RAGGED);
	});

	it('counts internal stop codons but does not refuse for them, as the reference does not', () => {
		// TAA in codon 1 of 3 is internal; the LAST codon is exempt (dating.py:201's range).
		const out = verifyCodingAlignment(new Map([['a', 'TAAACGTGA'], ['b', 'ACGACGACG']]));
		expect(out.ok).toBe(true);
		expect(out.stops.total).toBe(1);
		expect(out.stops.taxa).toEqual(['a']);
		expect(verifyCodingAlignment(new Map([['a', 'TAAACGTGA']]), { allowStopCodons: false }).ok).toBe(false);
	});

	it('refuses rather than trims when the caller asked it not to trim', () => {
		const out = verifyCodingAlignment(new Map([['a', 'ACGTA']]), { autoTrimTrailing: false });
		expect(out.refusal).toBe(DATING_REFUSALS.ALIGNMENT_NOT_CODING);
	});
});

suite('the asterisk rule, and the counting behind it', () => {
	it('rewrites every asterisk as a gap and reports how many, in how many sequences', () => {
		const out = starsToGaps(new Map([['a', 'AC*GT*'], ['b', 'ACGGTT'], ['c', '***']]));
		expect(out.stars).toBe(5);
		expect(out.taxa).toEqual(['a', 'c']);
		expect(out.sequences.get('a')).toBe('AC-GT-');
		expect(out.sequences.get('b')).toBe('ACGGTT');
		expect(out.warnings[0].code).toBe('DATING_STARS_REWRITTEN');
	});

	it('says nothing at all when there is no asterisk to rewrite', () => {
		expect(starsToGaps(new Map([['a', 'ACGT']])).warnings).toEqual([]);
	});
});

suite('the coverage holdout (dating.py:2698-2709)', () => {
	const seqs = new Map([
		['full1', 'ACGTACGTAC'],
		['full2', 'ACGTACGTAC'],
		['full3', 'ACGTACGTAC'],
		['partial', 'AC--------']
	]);
	const taxa = ['full1', 'full2', 'full3', 'partial'];

	it('reserves a sequence below half coverage when three rows survive', () => {
		const out = coverageHoldout(seqs, taxa);
		expect(out.reserved).toBe(true);
		expect(out.holdouts).toEqual(['partial']);
		expect(out.trainIndices).toEqual([0, 1, 2]);
		expect(out.coverage[3]).toBeCloseTo(0.2, 12);
		expect(out.warnings[0].code).toBe('DATING_HOLDOUTS_RESERVED');
	});

	it('keeps the row in the fit below that guard — and says the label is then the wrong one', () => {
		const few = new Map([...seqs].filter(([t]) => t !== 'full3'));
		const out = coverageHoldout(few, ['full1', 'full2', 'partial']);
		expect(out.reserved).toBe(false);
		expect(out.trainIndices).toEqual([0, 1, 2]);
		// The reference computes `is_holdout` from coverage alone (dating.py:3046), so the row is
		// labelled held out while being in the fit. Replicated, and named.
		expect(out.isTrain[2]).toBe(false);
		expect(out.warnings[0].code).toBe('DATING_HOLDOUTS_IN_FIT');
	});

	it('counts only UPPER-CASE ACGT, which is only safe because the parse upper-cases', () => {
		const out = coverageHoldout(new Map([['a', 'acgtacgtac']]), ['a']);
		expect(out.coverage[0]).toBe(0);
	});
});

suite('selectClockModel (dating.py:2943-2996)', () => {
	const ols = { method: 'OLS', t_mrca: 1900, mu: 1e-3, fieller_g: 0.1, ci_mrca: [1880, 1920] };
	const spline = (over) => ({
		method: 'RESTRICTED_SPLINE',
		t_mrca: 1938.7746674292187,
		rate_ancestral: 0.0022626796143908924,
		rate_recent: 8.988080942299876e-5,
		rate_ratio: 0.039723171080583784,
		f_stat: 5.255140428205752,
		p_f_test: 0.023394714664289055,
		delta_aic: 3.2696711294240686,
		ci_mrca: [1938.7746674292187, 1938.7746674292187],
		n: 141,
		is_nonlinear_preferred: true,
		...over
	});

	it('builds the reference\'s sentence byte for byte, including its format specifiers', () => {
		const got = selectClockModel({ ols, spline: spline() });
		expect(got.name).toBe('spline');
		expect(got.selectedClock).toBe(KORBER.selected_clock);
	});

	it('says "acceleration" above 1 and keeps the same shape', () => {
		const got = selectClockModel({ ols, spline: spline({ rate_ratio: 2.5 }) });
		expect(got.selectedClock).toContain('rate acceleration (2.50x)');
	});

	it('leaves the answer with OLS when the curvature test did not prefer the spline', () => {
		const got = selectClockModel({ ols, spline: spline({ is_nonlinear_preferred: false }) });
		expect(got.name).toBe('ols');
		expect(got.selectedClock).toBe('Linear (Standard OLS)');
	});

	it('refuses to prefer a spline whose ancestral rate is not positive', () => {
		// The fourth conjunct of dating.py:1894-1898 is the library's; this is the selector's own
		// `spline_valid` guard (dating.py:2875) doing the same job one level up.
		const got = selectClockModel({ ols, spline: spline({ rate_ancestral: -1e-4 }) });
		expect(got.name).toBe('ols');
	});

	it('honours the forced modes', () => {
		expect(selectClockModel({ ols, spline: spline({ is_nonlinear_preferred: false }), clockModel: 'spline' }).selectedClock).toBe(
			'Restricted Spline (forced)'
		);
		expect(selectClockModel({ ols, spline: spline(), clockModel: 'linear' }).name).toBe('ols');
	});
});

suite('admitEnsembleCandidates (dating.py:2894-2941)', () => {
	const ols = { method: 'OLS', t_mrca: 1893.91095511759, mu: 1e-3, fieller_g: 0.09, ci_mrca: [1850.9002455209902, 1916.7928463014516] };

	it('drops a model whose interval has no width — which is how a SELECTED spline is ignored', () => {
		const spline = { method: 'RESTRICTED_SPLINE', t_mrca: 1938.77, rate_ancestral: 2e-3, is_nonlinear_preferred: true, ci_mrca: [1938.77, 1938.77] };
		const got = admitEnsembleCandidates({ ols, spline, minSampleTime: 1983.5, selected: 'spline' });
		expect(got.admitted).toEqual(['ols']);
		expect(got.ensemble.weights).toEqual({ ols: 1 });
		expect(got.warnings.map((w) => w.code)).toContain('DATING_ENSEMBLE_IGNORES_SELECTED');
	});

	it('drops a half-infinite interval and falls back to OLS unchanged', () => {
		const unbounded = { method: 'OLS', t_mrca: 1893.9, mu: 1e-3, fieller_g: 1.4, ci_mrca: [-Infinity, 1983.5] };
		const got = admitEnsembleCandidates({ ols: unbounded, spline: null, minSampleTime: 1983.5 });
		expect(got.admitted).toEqual([]);
		expect(got.ensemble.weights).toEqual({ ols: 1.0 });
		// This is the ONE path the reference does not re-symmetrise: the interval travels as it is.
		expect(got.ensemble.ci_mrca).toEqual([-Infinity, 1983.5]);
	});

	it('has no answer at all when the rate is not positive', () => {
		const dead = { method: 'OLS', t_mrca: NaN, mu: 0, fieller_g: NaN, ci_mrca: [NaN, NaN] };
		const got = admitEnsembleCandidates({ ols: dead, spline: null, minSampleTime: 2000 });
		expect(got.ensemble).toEqual({ t_mrca: null, ci_mrca: null, weights: {} });
	});
});

suite('datingTaxonRecords and the reader\'s order', () => {
	const active = { method: 'OLS', mu: 1e-3, d0: 0.1, t_ref: 2000 };
	const taxa = ['a', 'b', 'c', 'd'];
	const times = [1990, 1995, 2000, 2005];
	// `c` is wildly diverged; `d` is a holdout that would be flagged if the rule allowed it.
	const dists = [0.09, 0.095, 0.2, 0.25];

	it('never flags a holdout, whatever its residual (dating.py:3049)', () => {
		const out = datingTaxonRecords({ taxa, times, divergences: dists, active, isTrain: [true, true, true, false], trainIndices: [0, 1, 2] });
		const d = out.rows.find((r) => r.taxon === 'd');
		expect(d.is_holdout).toBe(true);
		expect(d.is_outlier).toBe(false);
		expect(Math.abs(d.z_score)).toBeGreaterThan(DATING_THRESHOLDS.outlierZ);
	});

	it('writes the reference\'s ten columns, in the reference\'s order, plus ours last', () => {
		const out = datingTaxonRecords({ taxa, times, divergences: dists, active, isTrain: [true, true, true, true], trainIndices: [0, 1, 2, 3] });
		expect(Object.keys(out.rows[0])).toEqual([...TAXON_COLUMNS, 'prediction_method']);
		expect(out.rows.map((r) => r.taxon)).toEqual(taxa);
	});

	it('predicts nothing at all when the rate is below the reference\'s floor', () => {
		const slow = { method: 'OLS', mu: 1e-9, d0: 0.1, t_ref: 2000 };
		const out = datingTaxonRecords({ taxa, times, divergences: dists, active: slow, isTrain: [true, true, true, true], trainIndices: [0, 1, 2, 3] });
		expect(out.rows.every((r) => Number.isNaN(r.predicted_date))).toBe(true);
		expect(out.rows.every((r) => Number.isNaN(r.temporal_residual))).toBe(true);
		expect(out.rows.every((r) => r.prediction_method === 'none')).toBe(true);
	});

	it('ranks flagged first, then holdouts, then by |z|, leaving the record in alignment order', () => {
		const out = datingTaxonRecords({ taxa, times, divergences: dists, active, isTrain: [true, true, true, false], trainIndices: [0, 1, 2] });
		const ranked = rankTaxonRows(out.rows);
		expect(out.rows.map((r) => r.taxon)).toEqual(taxa);
		expect(ranked[0].is_outlier || ranked[0].is_holdout).toBe(true);
		const zs = ranked.filter((r) => !r.is_outlier && !r.is_holdout).map((r) => Math.abs(r.z_score));
		expect(zs).toEqual([...zs].sort((a, b) => b - a));
	});
});

suite('runDating refuses rather than returning a number it cannot defend', () => {
	const seqs = new Map([
		['a', 'ACGACGACG'],
		['b', 'ACGACGACT'],
		['c', 'ACGACGATG']
	]);

	it('too few dated sequences', () => {
		const out = runDating({ sequences: seqs, dates: new Map([['a', 2000], ['b', NaN]]) });
		expect(out.ok).toBe(false);
		expect(out.refusal).toBe(DATING_REFUSALS.TOO_FEW_DATED);
		expect(out.warnings.at(-1).message).toContain('at least 3');
	});

	it('no span on the time axis', () => {
		const out = runDating({ sequences: seqs, dates: new Map([['a', 2000], ['b', 2000], ['c', 2000]]) });
		expect(out.refusal).toBe(DATING_REFUSALS.NO_TIME_SPAN);
	});

	it('a ragged alignment, before any distance is attempted', () => {
		const out = runDating({ sequences: new Map([['a', 'ACGACG'], ['b', 'ACG']]), dates: new Map([['a', 2000], ['b', 2001]]) });
		expect(out.refusal).toBe(DATING_REFUSALS.ALIGNMENT_RAGGED);
	});

	it('an interval method it has not ported — rather than silently giving Fieller', () => {
		// dating.py:1244-1258's chain ends in an `else` that makes any unknown string Fieller. A
		// page that offered "Poisson" and got Fieller would be lying about what it computed.
		expect(() => runDating({ sequences: seqs, dates: new Map([['a', 2000], ['b', 2001], ['c', 2002]]), ciMethod: 'poisson' })).toThrow(
			RangeError
		);
	});

	it('a cancelled run, with the name every worker in this package checks', () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => runDating({ sequences: seqs, dates: new Map([['a', 2000], ['b', 2001], ['c', 2002]]), signal: controller.signal })).toThrow(
			expect.objectContaining({ name: 'AbortError' })
		);
	});

	it('names an excluded sequence rather than quietly conditioning the estimate on it', () => {
		const dates = new Map([['a', 2000], ['b', 2001], ['c', 2002], ['d', 2003]]);
		const four = new Map([...seqs, ['d', 'ACGACTATG']]);
		const out = runDating({ sequences: four, dates, excludedTaxa: ['d'] });
		expect(out.taxa).not.toContain('d');
		expect(out.record.primaeon.excluded_taxa).toEqual(['d']);
		expect(codes(out)).toContain('DATING_TAXA_EXCLUDED');
	});
});

withExamples('the two downloads are the reference\'s two files', () => {
	const { run } = runExample('korber_env_gp160.fasta');

	it('the JSON carries the reference\'s keys, in the reference\'s order, and one of ours', () => {
		const parsed = JSON.parse(datingJsonText(run.record));
		expect(Object.keys(parsed)).toEqual([...RECORD_KEYS, 'primaeon']);
		expect(Object.keys(JSON.parse(datingJsonText(run.record, { includeProvenance: false })))).toEqual([...RECORD_KEYS]);
		// The estimators this build does not run are `null`, exactly as `--method ols` leaves them,
		// so a diff against a CLI run shows nulls and nothing else.
		expect(parsed.pgls).toBeNull();
		expect(parsed.power).toBeNull();
		expect(parsed.latent_root).toBeNull();
		expect(parsed.loocv).toBeNull();
		expect(parsed.tree).toBeNull();
		expect(parsed.distance_mode).toBe('tn93');
		expect(parsed.taxa_summary.length).toBe(KORBER.dated);
	});

	it('formats numbers the way Python does, not the way JSON.stringify does', () => {
		const text = datingJsonText(run.record, { includeProvenance: false });
		// `ensemble.weights` is a dict of floats keyed by model name: `1.0`, never `1`.
		expect(text).toContain('"ols": 1.0');
		// A float below 1e-4 takes Python's exponent form.
		expect(text).toContain('"p_value": 1.569958274494354e-09');
	});

	it('the CSV is the reference\'s ten columns, in alignment order, with True/False', () => {
		const csv = datingCsvText(run.rows);
		const lines = csv.split('\n');
		expect(lines[0]).toBe(TAXON_COLUMNS.join(','));
		expect(lines.length).toBe(KORBER.dated + 2); // header + rows + the trailing newline
		expect(lines[1].startsWith(`${KORBER.first_row.taxon},1992.5,${KORBER.first_row.root_divergence},`)).toBe(true);
		expect(lines[1].endsWith(',False,False')).toBe(true);
		// Ours is opt-in, so the default file diffs against a CLI run.
		expect(csv).not.toContain('prediction_method');
		expect(datingCsvText(run.rows, { predictionMethod: true }).split('\n')[0].endsWith(',prediction_method')).toBe(true);
	});

	it('offers both files and nothing when the run refused', () => {
		expect(datingDownloads(run).map((d) => d.name)).toEqual(['dating.json', 'dating.csv']);
		expect(datingDownloads({ ok: false })).toEqual([]);
	});
});

suite('the import boundary that makes "no model on this page" a fact', () => {
	it('nothing under src/dating/ can reach a session, a manifest or WebAssembly', () => {
		// PLAN-TEMPORAL phase 3 is "the half that needs no neural model", and the /time route's e2e
		// asserts no *.onnx and no ort-*.wasm is ever requested. The import graph is the mechanism.
		const dir = join(RUNTIME, 'src', 'dating');
		const forbidden = /from\s+'(\.\.\/(manifest|predict|feeds|createSession|session-web|session-node|tn93-wasm|pipeline|analyze)\.js|onnxruntime[^']*|node:fs|node:path)'/;
		const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
		expect(files.length).toBeGreaterThan(4);
		for (const f of files) {
			const src = readFileSync(join(dir, f), 'utf8');
			const hit = src.match(forbidden);
			expect(hit?.[0] ?? null, `${f} imports ${hit?.[0]}`).toBeNull();
		}
	});

	it('does not import clockRegression.js, which is the check and not a dependency', () => {
		// Naming it in a comment is the point — every file here says why it is separate. Importing it
		// would make the port depend on the thing that checks it.
		const dir = join(RUNTIME, 'src', 'dating');
		for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
			const imports = [...readFileSync(join(dir, f), 'utf8').matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
			expect(imports, f).not.toContain('../clockRegression.js');
			expect(imports, f).not.toContain('../clock.js');
		}
	});

	it('and clockRegression.js was not edited to make this port agree with it', () => {
		// Its header says it is the independent check; a port that "reconciled" the two would delete
		// the check. This asserts the three things that make it independent are still there.
		const src = readFileSync(join(RUNTIME, 'src', 'clockRegression.js'), 'utf8');
		expect(src).toContain('THIS FILE IS THE INDEPENDENT CHECK THE PORT IS COMPARED AGAINST');
		// It computes its own arithmetic: no import at all, from the library or from this port.
		expect([...src.matchAll(/^import\b/gm)]).toEqual([]);
		expect(src).not.toContain('runOlsDating(');
	});
});
