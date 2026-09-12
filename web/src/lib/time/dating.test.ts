/**
 * dating.test.ts — what the ancestor-date section says, checked against a real run of the pillar on
 * the alignment the phase was measured on.
 *
 * WHY THIS FILE EXISTS, AND WHY IT RUNS THE REAL ESTIMATOR. `web/` has no component-test harness, so
 * every decision the section makes lives in `dating.ts` and is asserted here. A hand-built fixture
 * would let the view model and the runtime's record drift apart silently — which is the one failure
 * this page cannot afford, since the whole section is an argument about WHICH of four ancestor dates
 * to quote. So the suite calls `runDating` on `examples/korber_env_gp160.fasta` (0.4 s, no model, no
 * network) and asserts the sentences against numbers reproduced from the reference:
 *
 *     ancestor 1893.9   Fieller [1850.9, 1916.8]   rate 1.169 × 10⁻³   R² 0.231   n 141
 *     spline   1938.8   F 5.26, p = 0.0234, ΔAIC = +3.27, preferred
 *     zero sequences flagged; Z59ZR.ZHU held out, predicted 1965.6 against a label of 1959.5
 *
 * THE TWO CLAIMS WORTH SPELLING OUT, because they are the ones a later change could quietly break:
 * the section quotes the OLS estimate even though `active_model` is the spline (the spline has no
 * interval), and the per-sequence table's `predicted_date` column comes from the SPLINE, in three
 * different arms. A test that only checked formatting would not notice either.
 */

import { describe, expect, it } from 'vitest';
import { runDating } from '@veg/hyphaeon-runtime/dating';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import {
	clockNote,
	countsSentence,
	crossCheckSentence,
	datingView,
	estimatorRows,
	figureModel,
	holdoutSentence,
	intervalText,
	isUnbounded,
	num,
	predictionCaveat,
	rootSentence,
	sci,
	signed,
	sortTaxonRows,
	statEntries,
	taxonRows,
	verdictSentence,
	yr
} from './dating';
import { available, example } from './fixtures';
import type { DatingResult } from './types';

/** `runDating` returns typed arrays the worker drops; the page only ever sees this much. */
function runOn(text: string, rootTaxon: string | null, excluded: string[] = []): DatingResult {
	const taxa = taxaForDates(text);
	const ingest = ingestDates({ taxa, headerOf: null, timeUnits: 'years' });
	const run = runDating({
		alignmentText: text,
		alignmentName: 'korber_env_gp160.fasta',
		dates: { rows: ingest.rows.map((r) => ({ taxon: r.taxon, value: r.value })) },
		rootTaxon,
		excludedTaxa: excluded
	});
	return {
		ok: run.ok,
		refusal: run.refusal,
		warnings: run.warnings,
		record: run.record,
		rows: run.rows,
		activeName: run.activeName,
		selectedClock: run.selectedClock,
		ensemble: run.ensemble,
		rootDescription: run.rootDescription,
		rootCase: run.rootCase,
		elapsedMs: 0,
		ranAtIso: '2026-01-01T00:00:00.000Z',
		options: {
			root: 'taxon',
			rootTaxon,
			clockModel: 'auto',
			ciMethod: 'fieller',
			excludedTaxa: excluded,
			units: 'years',
			useModel: false,
			distanceMode: 'auto'
		}
	};
}

describe('formatting', () => {
	it('sets scientific notation with real superscripts, four significant figures', () => {
		expect(sci(0.0011690322000749895)).toBe('1.169 × 10⁻³');
		expect(sci(1.8073676662794878e-4)).toBe('1.807 × 10⁻⁴');
		expect(sci(1.569958274494354e-9, 3)).toBe('1.57 × 10⁻⁹');
		expect(sci(0)).toBe('0');
		// No exponent means no `× 10⁰` — a bare mantissa is the honest rendering.
		expect(sci(1.5)).toBe('1.500');
	});

	it('renders a missing number as an em dash rather than as NaN', () => {
		expect(sci(NaN)).toBe('—');
		expect(yr(NaN)).toBe('—');
		expect(num(null)).toBe('—');
		expect(yr(Infinity)).toBe('—');
	});

	it('signs ΔAIC the way the reference formats it', () => {
		expect(signed(3.2696711294240686)).toBe('+3.27');
		expect(signed(-1.040015804550194)).toBe('-1.04');
	});
});

describe('the interval, including the one that has no lower bound', () => {
	it('writes a bounded interval as two dates', () => {
		expect(intervalText([1850.9002455209902, 1916.7928463014516], 'years')).toBe('1850.9 to 1916.8');
	});

	it('never renders −∞, and says in words why there is no lower bound', () => {
		const text = intervalText([-Infinity, 1916.79], 'years');
		expect(text).not.toMatch(/Infinity|−∞|-∞/);
		expect(text).toMatch(/no lower bound/);
		expect(text).toMatch(/1916\.8/);
		expect(isUnbounded([-Infinity, 1916.79])).toBe(true);
		expect(isUnbounded([1850.9, 1916.79])).toBe(false);
	});

	it('calls a zero-width interval "not computed" rather than drawing it as an interval', () => {
		// dating.py:1917's dead bootstrap: the spline's four intervals ARE their point estimates.
		expect(intervalText([1938.7746674292187, 1938.7746674292187], 'years')).toBe('not computed');
	});
});

describe.runIf(available())('the flagship example, end to end through the view model', () => {
	const run = runOn(example('korber_env_gp160.fasta'), 'CONSENSUS');
	const view = datingView(run, 'years')!;

	it('reproduces the reference numbers the phase was measured against', () => {
		const ols = run.record.ols as Record<string, number>;
		expect(ols.mu).toBeCloseTo(0.0011690322000749895, 15);
		expect(ols.t_mrca).toBeCloseTo(1893.91095511759, 6);
		expect(ols.r2).toBeCloseTo(0.23135174335911296, 12);
		expect(ols.n).toBe(141);
		expect((ols.ci_fieller as unknown as number[])[0]).toBeCloseTo(1850.9002455209902, 6);
		expect((ols.ci_fieller as unknown as number[])[1]).toBeCloseTo(1916.7928463014516, 6);
	});

	it('quotes the straight line, not the model `active_model` names', () => {
		// The reference's own selection prefers the spline and its top-level t_mrca is 1938.77.
		expect(run.activeName).toBe('spline');
		expect(run.record.t_mrca).toBeCloseTo(1938.77, 1);
		// The page quotes 1893.9 anyway, and says why in `clockNote`.
		expect(view.verdict).toContain('1893.9');
		expect(view.verdict).not.toContain('1938.8');
		expect(view.clockNote).toContain('1938.8');
		expect(view.clockNote).toMatch(/no interval for it/);
	});

	it('states the estimate with its numbers inline and names the root in the same breath', () => {
		expect(view.verdict).toContain('141 sequences');
		expect(view.verdict).toContain('1850.9');
		expect(view.verdict).toContain('1916.8');
		expect(view.verdict).toContain('1.169 × 10⁻³');
		expect(view.verdict).toContain('0.231');
		expect(view.verdict).toContain('CONSENSUS');
		expect(verdictSentence(run, 'years')).toBe(view.verdict);
	});

	it('reconciles the three taxon counts on one line', () => {
		expect(countsSentence(run)).toBe('143 sequences in the file, 142 dated, 141 in the fit.');
	});

	it('makes the holdout a sentence, because on this dataset the holdout is the result', () => {
		const line = holdoutSentence(run, 'years')!;
		expect(line).toContain('Z59ZR.ZHU');
		expect(line).toContain('1965.6');
		expect(line).toContain('1959.5');
		expect(line).toMatch(/under half its sites carry data/);
	});

	it('names the root in words rather than printing the provenance token', () => {
		expect(rootSentence(run)).toBe('CONSENSUS, the sequence you named as the root');
	});

	it('fills the six stat entries, with the interval in the qualifier and nothing at display size', () => {
		const stats = statEntries(run, 'years');
		// The last label is 'Divergence measured to', not 'Root': phase 4 made the two different
		// questions, because under the latent distance mode there is no root sequence to name.
		expect(stats.map((s) => s.label)).toEqual([
			'Ancestor date',
			'Clock rate',
			'R²',
			'Slope p',
			'Residual RMSE',
			'Divergence measured to'
		]);
		expect(stats[0].value).toBe('1893.9');
		expect(stats[0].qualifier).toContain('95 % interval (Fieller): 1850.9 to 1916.8');
		expect(stats[1].value).toBe('1.169 × 10⁻³');
		expect(stats[2].qualifier).toBe('over 141 sequences in the fit');
		expect(stats[4].value).toBe('7.907 × 10⁻³');
	});

	it('writes the curvature test with the numbers the reference reports', () => {
		const note = clockNote(run, 'years')!;
		expect(note).toContain('decelerating');
		expect(note).toContain('F = 5.26');
		expect(note).toContain('p = 0.0234');
		expect(note).toContain('ΔAIC = +3.27');
		expect(note).toContain('2.263 × 10⁻³');
		expect(note).toContain('8.988 × 10⁻⁵');
	});

	it('lists every estimator, including the four it did not run, with the reason in the row', () => {
		const rows = estimatorRows(run, 'years');
		const names = rows.map((r) => r.name);
		expect(names[0]).toBe('Root-to-tip OLS (TempEst)');
		expect(names[1]).toBe('Restricted spline clock');
		expect(names).toContain('Attention PGLS');
		expect(names).toContain('Latent root search');
		expect(names).toContain('Power-law clock');
		expect(names.at(-1)).toBe('Model-averaged ensemble');
		// An unbuilt estimator carries no number at all, only its reason.
		const pgls = rows.find((r) => r.name === 'Attention PGLS')!;
		expect(pgls.built).toBe(false);
		expect(pgls.date).toBeNull();
		expect(pgls.note).toMatch(/taxon-by-taxon attention matrix/);
		// The spline's interval is stated as not computed, and the ensemble says what it is.
		expect(rows[1].interval).toMatch(/not computed/);
		expect(rows.at(-1)!.note).toMatch(/not because it is a second answer/);
		// Nothing in the table promises anything (web/DESIGN.md §5).
		for (const row of rows) expect(`${row.name} ${row.note ?? ''}`).not.toMatch(/coming soon|to be written|TODO/i);
	});

	it('builds a figure whose x domain reaches the ancestor and its interval', () => {
		const fig = figureModel(run)!;
		expect(fig.points).toHaveLength(142);
		expect(fig.ancestor!.t).toBeCloseTo(1893.911, 2);
		expect(fig.ancestor!.openLow).toBe(false);
		// The estimate is an extrapolation: the domain must open far to the left of the data.
		expect(fig.domain.x0).toBeCloseTo(1850.9, 1);
		expect(fig.domain.x1).toBeCloseTo(1997.5, 1);
		// The spline was preferred, so the curve is drawn, through its own fitted values.
		expect(fig.curve.length).toBe(142);
		expect(fig.line).not.toBeNull();
		expect(fig.points.filter((p) => p.holdout)).toHaveLength(1);
		expect(fig.points.filter((p) => p.outlier)).toHaveLength(0);
	});

	it('ranks the per-sequence table by problem, and says which model each date came from', () => {
		const rows = taxonRows(run);
		expect(rows).toHaveLength(142);
		// Zero flagged: max |z| is 2.393 against the reference's fixed 2.5. This is the measurement
		// that makes an outliers-only table the wrong design for this page.
		expect(rows.filter((r) => r.is_outlier)).toHaveLength(0);
		expect(Math.max(...rows.map((r) => Math.abs(r.z_score)))).toBeLessThan(2.5);
		const ranked = sortTaxonRows(rows, 'rank', true);
		expect(ranked[0].taxon).toBe('Z59ZR.ZHU');
		expect(ranked[0].status).toBe('held out');
		// Three arms of one column, which the reference leaves unmarked.
		const byMethod = rows.reduce<Record<string, number>>((acc, r) => {
			acc[r.prediction_method] = (acc[r.prediction_method] ?? 0) + 1;
			return acc;
		}, {});
		expect(byMethod).toEqual({ spline: 118, linear_arm: 12, linear_fallback: 12 });
		expect(rows.find((r) => r.prediction_method === 'linear_fallback')!.methodText).toBe('straight line (no curve solution)');
	});

	it('refuses to present the predicted-date column as dates under the selected curved clock', () => {
		// MEASURED at this commit: under the selected spline, 43 of 142 sequences are placed after
		// the latest sample (1997.5) and the furthest at 2097.19, against the root find's own
		// bracket ceiling of 2097.5. (The surface survey counted 36, against a threshold of 2010;
		// the sentence uses the latest sample, which is the defensible line.) The reference marks
		// none of them.
		const caveat = predictionCaveat(run, 'years')!;
		expect(caveat.count).toBe(43);
		expect(caveat.text).toContain('1997.5');
		expect(caveat.text).toContain('2097.2');
		expect(caveat.text).toMatch(/running out of curve, not dates/);
	});

	it('carries the upstream quirks forward as warnings rather than swallowing them', () => {
		const codes = run.warnings.map((w) => w.code);
		expect(codes).toContain('DATING_SPLINE_NO_INTERVAL');
		expect(codes).toContain('DATING_ENSEMBLE_IGNORES_SELECTED');
		expect(codes).toContain('DATING_PREDICTION_FALLBACK');
		expect(codes).toContain('DATING_HOLDOUTS_RESERVED');
	});

	it('says none of the four words the preview reserves', () => {
		const text = [
			view.verdict,
			view.counts,
			view.holdout ?? '',
			view.clockNote ?? '',
			...view.stats.flatMap((s) => [s.label, s.value, s.qualifier]),
			...view.estimators.flatMap((r) => [r.name, r.interval ?? '', r.note ?? ''])
		].join(' ');
		for (const word of [/TMRCA/i, /calibrated/i, /confidence interval/i, /molecular clock estimate/i]) {
			expect(text, `the section said ${word}`).not.toMatch(word);
		}
	});
});

describe.runIf(available())('excluding a sequence changes the fit and is never silent', () => {
	it('drops the row from the table and names it in the run', () => {
		const text = example('korber_env_gp160.fasta');
		const base = runOn(text, 'CONSENSUS');
		const without = runOn(text, 'CONSENSUS', ['Z59ZR.ZHU']);
		expect(without.rows).toHaveLength(base.rows.length - 1);
		expect(without.rows.some((r) => r.taxon === 'Z59ZR.ZHU')).toBe(false);
		expect(without.warnings.map((w) => w.code)).toContain('DATING_TAXA_EXCLUDED');
		const primaeon = without.record.primaeon as Record<string, unknown>;
		expect(primaeon.excluded_taxa).toEqual(['Z59ZR.ZHU']);
	});
});

describe('a refusal is a refusal, and it renders nothing else', () => {
	const refused: DatingResult = {
		ok: false,
		refusal: 'DATING_TOO_FEW_DATED',
		warnings: [{ code: 'DATING_TOO_FEW_DATED', severity: 'refuse', message: 'Only 2 sequences could be dated; at least 3 are needed.' }],
		record: {},
		rows: [],
		activeName: 'ols',
		selectedClock: '',
		ensemble: { t_mrca: null, ci_mrca: null, weights: {} },
		rootDescription: '',
		rootCase: 4,
		elapsedMs: 0,
		ranAtIso: '',
		options: {
			root: 'consensus',
			rootTaxon: null,
			clockModel: 'auto',
			ciMethod: 'fieller',
			excludedTaxa: [],
			units: 'years',
			useModel: false,
			distanceMode: 'auto'
		}
	};

	it('carries one reason and one next action, and no numbers at all', () => {
		const view = datingView(refused, 'years')!;
		expect(view.ok).toBe(false);
		expect(view.refusal!.code).toBe('DATING_TOO_FEW_DATED');
		expect(view.refusal!.reason).toMatch(/at least 3 are needed/);
		expect(view.refusal!.next).toMatch(/metadata table or a custom pattern/);
		// The estimate slot is empty: a grid of em dashes reads as a render failure, not a decision.
		expect(view.verdict).toBe('');
		expect(view.stats).toEqual([]);
		expect(view.estimators).toEqual([]);
		expect(figureModel(refused)).toBeNull();
		expect(taxonRows(refused)).toEqual([]);
		expect(predictionCaveat(refused, 'years')).toBeNull();
	});

	it('treats a clock that runs backwards as a refusal, not as an estimate with NaN in it', () => {
		const backwards: DatingResult = {
			...refused,
			ok: true,
			refusal: null,
			warnings: [{ code: 'DATING_NON_POSITIVE_RATE', severity: 'warn', message: 'The clock rate is not positive (-0.0001).' }],
			record: { ols: { status: 'NON_POSITIVE_RATE', t_mrca: NaN, mu: -1e-4 }, ci_method: 'fieller', primaeon: {} }
		};
		const view = datingView(backwards, 'years')!;
		expect(view.ok).toBe(false);
		expect(view.refusal!.code).toBe('DATING_NON_POSITIVE_RATE');
		expect(view.verdict).toBe('');
	});
});

describe('the cross-check that keeps the preview and the estimate from contradicting each other', () => {
	it('names both numbers and the gap, and flags a gap wider than the interval', () => {
		const near = crossCheckSentence(1893.9, 1901.2, 66.0, 'years')!;
		expect(near.text).toContain('1893.9');
		expect(near.text).toContain('1901.2');
		expect(near.text).toContain('7.3 years');
		expect(near.wide).toBe(false);
		expect(crossCheckSentence(1893.9, 1990.0, 66.0, 'years')!.wide).toBe(true);
	});

	it('says nothing when either side has no estimate', () => {
		expect(crossCheckSentence(NaN, 1901.2, 66.0, 'years')).toBeNull();
		expect(crossCheckSentence(1893.9, NaN, 66.0, 'years')).toBeNull();
	});
});
