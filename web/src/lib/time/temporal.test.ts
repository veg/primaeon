/**
 * temporal.test.ts — the view model of `/time` section 5, driven the way `dating.test.ts` drives
 * section 3's: `web/` has no component-test harness, so every decision that could be wrong lives in
 * `temporal.ts` and is asserted here, and the `.svelte` files hold markup and a scale function.
 *
 * THE RECORD IS SYNTHETIC AND DELIBERATELY SMALL — eight codons, twelve grid points — so that every
 * intermediate is printable and a failing assertion can be diagnosed by eye. It is NOT a parity
 * fixture: the numbers `hyphaeon temporal` produces are compared element by element in
 * `runtime/test/temporal-port.test.js` against the reference's own four files, on the real graph.
 * What is checked here is the layer above that: which rows a table shows, in what order, what a
 * classification is CALLED, which figure can be drawn at all, and — the reason most of these
 * assertions exist — that the three things a reader comparing this page with a command-line run
 * must be told are actually printed.
 *
 * THE ONE MEASURED CONSTANT IN THE FILE is the borderline band. At B = 100 draws, three standard
 * errors of a Monte-Carlo p at α = 0.05 is 0.0654, and the acceptance run has ELEVEN of its 246
 * candidates within one draw (1/101) of the cut — which is why the band is marked on rows rather
 * than left for a reader to discover that 0.0495 and 0.0594 are the same answer.
 */

import { describe, expect, it } from 'vitest';
import {
	borderlineBand,
	classificationFigure,
	codonCeiling,
	costMeasured,
	costSentences,
	duration,
	honestyNotes,
	isBorderline,
	ledeSentence,
	nullCeiling,
	peakDateText,
	pText,
	remainingSeconds,
	siteRows,
	sortRows,
	temporalGate,
	trajectoryFigure,
	velocityFigure,
	waveFigure,
	widthText,
	type TemporalRecord
} from './temporal';

// =================================================================================================
// A record, built from a small description
// =================================================================================================

interface CodonSpec {
	classification: 'INVARIABLE' | 'FLAT_NO_SIGNAL' | 'TEMPORAL_NOISE' | 'CONFIRMED_SWEEP';
	cross: 'NEGATIVE_CONSENSUS' | 'FILTERED_STATIC_NOISE' | 'CONCORDANT_SWEEP' | 'RESCUED_SWEEP';
	peak: number;
	pPerm?: number;
	qStatic?: number;
	r2?: number;
	intensity?: number;
}

const T = 12;
const T_MIN = 2009.0;
const T_MAX = 2010.0;

function makeRecord(specs: CodonSpec[], opts: Partial<TemporalRecord> = {}): TemporalRecord {
	const L = specs.length;
	const time = Float64Array.from({ length: T }, (_, i) => T_MIN + (i * (T_MAX - T_MIN)) / (T - 1));
	const prevalence = new Float64Array(L * T);
	const velocity = new Float64Array(L * T);
	const site = Int32Array.from({ length: L }, (_, i) => i + 1);
	const stage1 = new Uint8Array(L);
	const invariable = new Uint8Array(L);
	const sweep = new Uint8Array(L);
	const peakDate = new Float64Array(L);
	const peakIntensity = new Float64Array(L);
	const peakAtFirst = new Uint8Array(L);
	const pPerm = new Float32Array(L).fill(1);
	const qPerm = new Float32Array(L).fill(1);
	const qStatic = new Float32Array(L).fill(1);
	const pStatic = new Float64Array(L).fill(0.5);
	const lrt = new Float32Array(L).fill(1.5);
	const r2 = new Float32Array(L);
	const fwhm = new Float32Array(L);
	const loadings = new Float32Array(L * 4);
	const classification: string[] = [];
	const cross: string[] = [];
	const labels: string[] = [];

	specs.forEach((spec, s) => {
		classification.push(spec.classification);
		cross.push(spec.cross);
		labels.push(`A${s + 1}V`);
		invariable[s] = spec.classification === 'INVARIABLE' ? 1 : 0;
		stage1[s] = spec.classification === 'TEMPORAL_NOISE' || spec.classification === 'CONFIRMED_SWEEP' ? 1 : 0;
		sweep[s] = spec.classification === 'CONFIRMED_SWEEP' ? 1 : 0;
		peakDate[s] = spec.peak;
		peakAtFirst[s] = spec.peak === T_MIN ? 1 : 0;
		peakIntensity[s] = spec.intensity ?? (stage1[s] ? 0.01 * (s + 1) : 0);
		fwhm[s] = stage1[s] ? 0.2 : 0;
		if (spec.pPerm !== undefined) pPerm[s] = spec.pPerm;
		if (spec.qStatic !== undefined) qStatic[s] = spec.qStatic;
		r2[s] = spec.r2 ?? (stage1[s] ? 0.8 : 0);
		for (let t = 0; t < T; t++) {
			prevalence[s * T + t] = stage1[s] ? (t / T) * peakIntensity[s] : 0;
			velocity[s * T + t] = stage1[s] && t === 6 ? peakIntensity[s] : 0;
		}
		loadings[s * 4] = 0.1 * (s + 1);
	});

	const candidates = Array.from(site).filter((_, s) => stage1[s] === 1);
	return {
		ok: true,
		stage: 'complete',
		complete: true,
		alignment: 'demo.fasta',
		tree: null,
		taxa_total: 20,
		taxa_timestamped: 18,
		codons_total: L,
		codons_variable: L - invariable.reduce((a, v) => a + v, 0),
		codons_invariable: invariable.reduce((a, v) => a + v, 0),
		timespan_years: T_MAX - T_MIN,
		t_min: T_MIN,
		t_max: T_MAX,
		bandwidth_years: 0.05,
		sig_static_q10: Array.from(qStatic).filter((q) => q <= 0.1).length,
		stage1_candidates: candidates.length,
		confirmed_sweeps: Array.from(sweep).filter(Boolean).length,
		concordant_sweeps: cross.filter((c) => c === 'CONCORDANT_SWEEP').length,
		rescued_sweeps: cross.filter((c) => c === 'RESCUED_SWEEP').length,
		filtered_static_noise: cross.filter((c) => c === 'FILTERED_STATIC_NOISE').length,
		fpca_wave_variance_pct: [40, 32, 14, 9],
		runtime_sec: 2.5,
		sites: {
			count: L,
			site,
			ref_aa: specs.map(() => 'A'),
			derived_aa: specs.map(() => 'V'),
			mutation_label: labels,
			domain: specs.map(() => 'Core'),
			classification,
			cross_classification: cross,
			is_confirmed_sweep: sweep,
			is_concordant_sweep: Uint8Array.from(cross.map((c) => (c === 'CONCORDANT_SWEEP' ? 1 : 0))),
			is_rescued_sweep: Uint8Array.from(cross.map((c) => (c === 'RESCUED_SWEEP' ? 1 : 0))),
			lrt,
			p_static: pStatic,
			q_static: qStatic,
			p_perm: pPerm,
			q_perm: qPerm,
			r2_fpca: r2,
			peak_date: peakDate,
			peak_intensity: peakIntensity,
			t_half_start: new Float32Array(L),
			t_half_end: new Float32Array(L),
			fwhm_years: fwhm,
			mean_intensity: new Float64Array(L),
			auc: new Float64Array(L),
			wave_loadings: loadings,
			scored: new Uint8Array(L).fill(1),
			invariable,
			stage1,
			peak_at_first_grid_point: peakAtFirst
		},
		curves: { T, time, prevalence, velocity },
		waves: {
			count: 4,
			data: new Float64Array(4 * T).map((_, i) => Math.sin(i / 3)),
			time,
			var_explained: [0.4, 0.32, 0.14, 0.09],
			sigma: [20.7, 18.7, 12.3, 10.0],
			gaps: [0.097, 0.311, 0.108, 0.237],
			near_degenerate: [false, false, false, false],
			rank_deficient: [false, false, false, false],
			gap_threshold: 0.05,
			sign: 'canonical',
			source_sites: candidates,
			source: 'confirmed-sweeps'
		},
		candidates,
		permutations: {
			requested: 100,
			completed: 100,
			cancelled: false,
			skipped: false,
			grid_step: 1 / 101,
			q_min: 0.43,
			q_rank1_bound: 2.4,
			rounds: [100],
			work: 1e6,
			budget: 5e10,
			within: true,
			nnz: 1000,
			reason: null,
			estimator: 'monte-carlo',
			rng: 'xoshiro256**',
			seed: 42,
			chunks: 4,
			ms_per_draw: 0.4,
			tested: true
		},
		escape_hatch_used: false,
		solitary_regime: false,
		gate_vacuous: false,
		regime: { time_units: 'years', sweep_mode: 'episodic', non_calendar: false, unit_label: 'yrs', prune_duplicates: true },
		grid: { time_points: T, t_min: T_MIN, t_max: T_MAX, step: (T_MAX - T_MIN) / (T - 1) },
		floors: {
			tau_peak: 5e-5,
			tau_auc: 1e-5,
			tau_peak_overridden: false,
			tau_auc_defaulted: true,
			perm_alpha: 0.05,
			min_r2_fpca: 0.35,
			q_static_cut: 0.1
		},
		root: { source: 'consensus', taxon: null, window: 3, early_indices: [0, 1, 2] },
		dates: {
			dated: 18,
			undated: 2,
			source: 'header',
			by_rule: null,
			beyond_reference: null,
			taxa: [],
			values: [2009.1, 2009.4, 2009.9],
			span: { min: T_MIN, max: T_MAX, span: 1, unique: 3 }
		},
		warnings: [],
		primaeon: { score_invariable_sites: true, scored_codons: L, taxon_cap: null },
		...opts
	} as TemporalRecord;
}

/** Two sweeps, two tested-not-confirmed, two flat, two invariable — every branch of every table. */
function demo(): TemporalRecord {
	return makeRecord([
		{ classification: 'INVARIABLE', cross: 'NEGATIVE_CONSENSUS', peak: T_MIN },
		{ classification: 'FLAT_NO_SIGNAL', cross: 'NEGATIVE_CONSENSUS', peak: T_MIN },
		{ classification: 'FLAT_NO_SIGNAL', cross: 'FILTERED_STATIC_NOISE', peak: T_MIN, qStatic: 0.02 },
		{ classification: 'TEMPORAL_NOISE', cross: 'NEGATIVE_CONSENSUS', peak: 2009.8, pPerm: 0.4 },
		{ classification: 'TEMPORAL_NOISE', cross: 'NEGATIVE_CONSENSUS', peak: 2009.5, pPerm: 0.0594 },
		{ classification: 'CONFIRMED_SWEEP', cross: 'RESCUED_SWEEP', peak: 2009.7, pPerm: 0.0099 },
		{ classification: 'CONFIRMED_SWEEP', cross: 'CONCORDANT_SWEEP', peak: 2009.2, pPerm: 0.0495, qStatic: 0.01 },
		{ classification: 'INVARIABLE', cross: 'NEGATIVE_CONSENSUS', peak: T_MIN }
	]);
}

// =================================================================================================

describe('the gate', () => {
	it('quotes section 1 when the dates are not settled', () => {
		const g = temporalGate(40, { span: 3 }, false, ['2 sequences carry no date.']);
		expect(g.ok).toBe(false);
		expect(g.reasons[0]).toBe('2 sequences carry no date.');
	});

	it("refuses under the reference's own floor of five dated sequences", () => {
		const g = temporalGate(4, { span: 3 }, true);
		expect(g.ok).toBe(false);
		expect(g.reasons[0]).toMatch(/at least 5 dated sequences and this alignment has 4/);
		expect(g.reasons[0]).toMatch(/temporal\.py:474/);
	});

	it('refuses a span of zero, which is not a time axis', () => {
		const g = temporalGate(50, { span: 0 }, true);
		expect(g.ok).toBe(false);
		expect(g.reasons.join(' ')).toMatch(/same time coordinate/);
	});

	it('offers the pillar when both hold', () => {
		expect(temporalGate(50, { span: 3 }, true).ok).toBe(true);
	});
});

describe('the cost, before the run', () => {
	it('reads the codon count off the first sequence of a FASTA', () => {
		expect(codonCeiling('>a\nATGATG\n>b\nATGATG\n')).toBe(2);
		expect(codonCeiling('>a\nATG\nATG\nAT\n>b\nATGATGAT\n')).toBe(2);
	});

	it('returns null rather than guessing on a matrix it cannot read', () => {
		expect(codonCeiling('#NEXUS\nbegin data;\n')).toBeNull();
		expect(codonCeiling('')).toBeNull();
	});

	it('bounds the null by the two ceilings and says which they are', () => {
		// Every codon a candidate, every dated sequence carrying the derived residue.
		const c = nullCeiling({ B: 200, C: 169, T: 250, N: 97 });
		expect(c.work).toBe(200 * 169 * 250 * (97 + 21));
		const [modelPass, nullSentence] = costSentences({ codons: 566, dated: 97, timePoints: 250, draws: 200, scoreInvariable: true });
		expect(modelPass).toMatch(/all 566 codons/);
		expect(modelPass).toMatch(/temporal\.py:512/);
		expect(nullSentence).toMatch(/At most 200 × 566 × 97 × 250/);
		expect(nullSentence).toMatch(/Both counts are ceilings/);
		expect(nullSentence).toMatch(/development machine/);
	});

	it('says what skipping the invariable codons costs the downloads', () => {
		const [modelPass] = costSentences({ codons: 566, dated: 97, timePoints: 250, draws: 200, scoreInvariable: false });
		expect(modelPass).toMatch(/every variable codon/);
		expect(modelPass).toMatch(/empty rather than scored/);
	});

	it('names no number it cannot read', () => {
		const [modelPass, nullSentence] = costSentences({ codons: null, dated: 97, timePoints: 250, draws: 200, scoreInvariable: true });
		expect(modelPass).toMatch(/every codon of your alignment/);
		expect(nullSentence).toMatch(/× C ×/);
		expect(nullSentence).not.toMatch(/multiply-adds/);
	});

	it('replaces the estimate with what the run measured', () => {
		const text = costMeasured(demo());
		expect(text).toMatch(/8 codons scored over 18 dated sequences, 4 candidates past the energy floor/);
		expect(text).toMatch(/100 shuffles in 4 chunks at 0.40 ms a draw over 1,000 nonzero attribution entries/);
		expect(text).toMatch(/2\.5 s in all/);
	});

	it('prints a duration as words', () => {
		expect(duration(0.4)).toBe('under a second');
		expect(duration(41)).toBe('about 41 seconds');
		expect(duration(300)).toBe('about 5 minutes');
	});
});

describe('the borderline band — the whole reason the RNG divergence is visible', () => {
	it('is three Monte-Carlo standard errors, measured at the acceptance B', () => {
		expect(borderlineBand(100)).toBeCloseTo(0.0654, 4);
		expect(borderlineBand(1000)).toBeCloseTo(0.0207, 4);
	});

	it('marks both sides of the cut, because either could have been the other', () => {
		// The acceptance run's two crowded grid steps: 5 sweeps at 0.0495 and 6 non-sweeps at 0.0594.
		expect(isBorderline(0.0495, 100)).toBe(true);
		expect(isBorderline(0.0594, 100)).toBe(true);
		expect(isBorderline(0.4, 100)).toBe(false);
		expect(isBorderline(Number.NaN, 100)).toBe(false);
	});
});

describe('the table rows', () => {
	it('calls each classification what a reader calls it', () => {
		const rows = siteRows(demo(), 'all');
		expect(rows.map((r) => r.callWord)).toEqual([
			'Not scored',
			'Flat',
			'Flat',
			'Tested, not confirmed',
			'Tested, not confirmed',
			'Swept',
			'Swept',
			'Not scored'
		]);
		expect(rows.map((r) => r.crossWord)).toEqual([
			'Neither',
			'Neither',
			'Static only',
			'Neither',
			'Neither',
			'Found only in time',
			'Both agree',
			'Neither'
		]);
	});

	it('shows the candidates by default and every codon on request', () => {
		const record = demo();
		expect(siteRows(record, 'candidates')).toHaveLength(4);
		expect(siteRows(record, 'all')).toHaveLength(8);
		expect(siteRows(record, 'sweeps')).toHaveLength(2);
	});

	it('marks every candidate the band reaches, on both sides of the cut', () => {
		// At B = 100 the band is +/-0.0654, so it reaches 0.0099 as well as the two grid steps that
		// straddle the cut. That width IS the answer at a hundred draws, which is the point of saying
		// it: only the candidate at p = 0.4 is out of reach of a different set of shuffles.
		const rows = siteRows(demo(), 'candidates');
		expect(rows.filter((r) => r.borderline).map((r) => r.site)).toEqual([5, 6, 7]);
		expect(rows.filter((r) => !r.borderline).map((r) => r.site)).toEqual([4]);
	});

	it('says "not tested", never "not a sweep", when no shuffle was drawn', () => {
		const record = demo();
		record.permutations!.tested = false;
		record.permutations!.completed = 0;
		record.sites.p_perm = new Float32Array(record.codons_total).fill(Number.NaN);
		const rows = siteRows(record, 'candidates');
		for (const row of rows) {
			expect(row.call).toBe('not-tested');
			expect(row.callWord).toBe('not tested');
			expect(row.crossWord).toBe('not tested');
		}
	});

	it('orders sweeps by peak date, then the rest by p, and never floats a NaN to the top', () => {
		const record = demo();
		record.sites.p_perm[3] = Number.NaN;
		const rows = sortRows(siteRows(record, 'candidates'), 'default', true);
		expect(rows.map((r) => r.site)).toEqual([7, 6, 5, 4]);
	});

	it('sorts a column both ways and keeps the NaN last in both', () => {
		const record = demo();
		record.sites.peak_intensity[4] = Number.NaN;
		const up = sortRows(siteRows(record, 'candidates'), 'peakIntensity', true).map((r) => r.site);
		const down = sortRows(siteRows(record, 'candidates'), 'peakIntensity', false).map((r) => r.site);
		expect(up[up.length - 1]).toBe(5);
		expect(down[down.length - 1]).toBe(5);
	});

	it('renders a peak of the first grid point as an em dash, not as a date', () => {
		const rows = siteRows(demo(), 'all');
		expect(peakDateText(rows[0], 'years')).toBe('—');
		expect(peakDateText(rows[5], 'years')).toMatch(/^2009-/);
	});

	it('formats p, width and the absent ones the way the columns need', () => {
		expect(pText(0.0495)).toBe('0.0495');
		expect(pText(1e-6)).toMatch(/10⁻⁶/);
		expect(pText(Number.NaN)).toBe('—');
		expect(widthText(0.2, 'yrs')).toBe('0.200 yrs');
		expect(widthText(0, 'yrs')).toBe('—');
	});
});

describe('the lede', () => {
	it('states the finding with the numbers inline and then stops', () => {
		const text = ledeSentence(demo(), 'years');
		expect(text).toMatch(/^2 of 8 codons are confirmed sweeps/);
		expect(text).toMatch(/the earliest peaking at 2009-03-/);
		expect(text).toMatch(/the strongest A6V at p = 0.0099/);
		expect(text).toMatch(/1 of them are also called by the static scan/);
	});

	it('says the cross-classification is arithmetic when the static scan calls nothing', () => {
		const record = makeRecord([
			{ classification: 'CONFIRMED_SWEEP', cross: 'RESCUED_SWEEP', peak: 2009.5, pPerm: 0.01 },
			{ classification: 'TEMPORAL_NOISE', cross: 'NEGATIVE_CONSENSUS', peak: 2009.6, pPerm: 0.3 }
		]);
		expect(ledeSentence(record, 'years')).toMatch(/All 1 are found only in time: the static scan calls nothing/);
	});

	it('claims nothing when the null has not run', () => {
		const record = demo();
		record.permutations!.tested = false;
		expect(ledeSentence(record, 'years')).toMatch(/none is confirmed or ruled out/);
	});

	it('says so plainly when nothing was confirmed', () => {
		const record = demo();
		record.confirmed_sweeps = 0;
		record.sites.is_confirmed_sweep = new Uint8Array(record.codons_total);
		expect(ledeSentence(record, 'years')).toMatch(/No codon of the 4 candidates is confirmed/);
	});
});

describe('the sentences a reader comparing with a command-line run must see', () => {
	it('always says the permutation p came from a different generator', () => {
		const notes = honestyNotes(demo());
		const rng = notes.find((n) => n.id === 'rng')!;
		expect(rng.lead).toMatch(/different generator/);
		expect(rng.rest).toMatch(/xoshiro256\*\*/);
		expect(rng.rest).toMatch(/Mersenne Twister/);
		expect(rng.rest).toMatch(/in distribution, not digit for digit/);
		expect(rng.warn).toBe(false);
	});

	it('names the grid step and the number of borderline codons', () => {
		const note = honestyNotes(demo()).find((n) => n.id === 'borderline')!;
		expect(note.lead).toMatch(/At 100 shuffles, a p near 0.05 carries about ±0.065/);
		expect(note.rest).toMatch(/3 candidates sit within three standard errors/);
	});

	it('says the permutation q carries no decision when it cannot reach the threshold', () => {
		const note = honestyNotes(demo()).find((n) => n.id === 'qperm')!;
		expect(note.rest).toMatch(/smallest q Benjamini-Hochberg returned anywhere in this run is 0\.4300/);
		expect(note.rest).toMatch(/temporal\.py:687-689/);
	});

	it('drops the q note when the q-value is a usable threshold after all', () => {
		const record = demo();
		record.permutations!.q_min = 0.02;
		expect(honestyNotes(record).some((n) => n.id === 'qperm')).toBe(false);
	});

	it('states the wave-sign convention as a convention', () => {
		const note = honestyNotes(demo()).find((n) => n.id === 'wave-sign')!;
		expect(note.lead).toMatch(/A wave and its negative are the same mode/);
		expect(note.rest).toMatch(/canonical/);
		expect(note.rest).toMatch(/no classification reads a sign/);
	});

	it('warns, rather than quietly benefiting, when our date layer read what the reference cannot', () => {
		const record = demo();
		record.dates.beyond_reference = { count: 142, rules: { korber_isolate: 142 } };
		const note = honestyNotes(record).find((n) => n.id === 'beyond-reference')!;
		expect(note.warn).toBe(true);
		expect(note.lead).toMatch(/142 of these dates were read by a rule `hyphaeon temporal` does not have/);
		expect(note.rest).toMatch(/not comparable codon by codon/);
	});

	it('warns when the alignment was downsampled before the model saw it', () => {
		const record = demo();
		record.primaeon.taxon_cap = 'applied';
		const note = honestyNotes(record).find((n) => n.id === 'downsampled')!;
		expect(note.warn).toBe(true);
		expect(note.rest).toMatch(/time-blind/);
	});
});

describe('the figures', () => {
	it('draws every sweep and caps the rest, saying so', () => {
		const record = demo();
		const model = trajectoryFigure(record, 1);
		expect(model.called).toHaveLength(2);
		expect(model.background).toHaveLength(1);
		expect(model.capped).toBe(true);
		expect(model.samples).toEqual([2009.1, 2009.4, 2009.9]);
		// The cap keeps the strongest uncalled candidate, not the first one.
		expect(model.background[0].site).toBe(5);
	});

	it('orders the velocity rows by peak date, the way the table does', () => {
		const model = velocityFigure(demo());
		expect(model.source).toBe('sweeps');
		expect(model.rows.map((r) => r.site)).toEqual([7, 6]);
		expect(model.rows[0].peakIndex).toBe(6);
	});

	it('falls back to the strongest candidates when nothing was confirmed, rather than vanishing', () => {
		const record = demo();
		record.sites.is_confirmed_sweep = new Uint8Array(record.codons_total);
		const model = velocityFigure(record);
		expect(model.source).toBe('candidates');
		expect(model.rows.length).toBeGreaterThan(0);
	});

	it('reports the wave panels with their shares and their separation', () => {
		const model = waveFigure(demo())!;
		expect(model.panels).toHaveLength(4);
		expect(model.panels[0].pct).toBe(40);
		expect(model.degeneratePairs).toEqual([]);
		expect(model.sign).toBe('canonical');
	});

	it('names the pair that cannot be told apart', () => {
		const record = demo();
		record.waves!.near_degenerate = [false, true, false, false];
		expect(waveFigure(record)!.degeneratePairs).toEqual(['2 and 3']);
	});

	it('cannot draw the classification before the null has run, and says nothing instead', () => {
		const record = demo();
		record.permutations!.tested = false;
		expect(classificationFigure(record)).toBeNull();
	});

	it('draws only the candidates, and counts the ones the wave gate stopped', () => {
		const record = demo();
		// A candidate that cleared the permutation cut and failed R² >= 0.35.
		record.sites.p_perm[3] = 0.01;
		record.sites.r2_fpca[3] = 0.1;
		const model = classificationFigure(record)!;
		expect(model.points).toHaveLength(4);
		expect(model.gateFailed).toBe(1);
		expect(model.points.filter((p) => p.sweep)).toHaveLength(2);
		expect(model.gridStep).toBeCloseTo(1 / 101, 6);
	});
});

describe('the progress estimate', () => {
	it('refuses to guess from the calibration draw', () => {
		expect(remainingSeconds(0.4, 50, 200, 1)).toBeNull();
		expect(remainingSeconds(null, 50, 200, 4)).toBeNull();
	});

	it('projects from the rate the draws already done achieved', () => {
		expect(remainingSeconds(10, 100, 200, 4)).toBeCloseTo(1, 6);
	});
});
