/**
 * datingModel.test.ts — what the ancestor-date section SAYS when the model ran, checked against the
 * reference's own record rather than against a fixture of ourselves.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOT LOAD A GRAPH. `dating.test.ts` runs the real
 * model-free estimator, which costs 0.4 s and no network. The model-based half cannot be run that
 * way: it needs a 7.3 MB ONNX graph and a full forward pass, and the runtime suite already
 * reproduces both against the reference (`runtime/test/dating-model.test.js`, 32 tests). What is
 * left for `web/` is the thing only `web/` can get wrong — the DECIDING and the SAYING — and the
 * strongest input for that is the reference's own two records:
 *
 *     ../HyphAeon/fixtures/dating/run_mrca_dating_model.json
 *       000_korber_tn93     hyphaeon dating … --method all --cpu --distance-mode tn93
 *       001_korber_latent   hyphaeon dating … --method all --cpu --distance-mode latent
 *
 * So the view model is driven from the CLI's own bytes. Two consequences worth stating:
 *
 *   1. THE SELECTION SENTENCE IS CHECKED BYTE FOR BYTE, in both modes, by replaying this build's
 *      `selectClockModel` on the reference's own `ols` / `pgls` / `spline` blocks and comparing the
 *      result to the reference's `selected_clock` string. That is a stronger statement than any
 *      assertion about the page's own wording, and it is free.
 *   2. THE WARNINGS ARE THE RUNTIME'S, NOT THE TEST'S. `DATING_CLADE_ATTENUATED` and the ensemble's
 *      two notes are produced by replaying the same two pure functions `runDating` calls, so a test
 *      that passes cannot be passing on hand-written diagnostics.
 *
 * THE ONE THING THE TEST SUPPLIES IS `primaeon`. The reference's record has no such key — it is
 * ours, added by `buildDatingRecord` — and three of the section's sentences read it: the counts
 * line, the holdout line and `modelRan`. The block below carries what the runtime would have
 * written for these runs, and nothing else; every number in it is derivable from the record beside
 * it (143 sequences in the alignment, 142 dated, 141 in the fit after the coverage holdout).
 */

import { describe, expect, it } from 'vitest';
import { admitEnsembleCandidates, selectClockModel } from '@veg/hyphaeon-runtime/dating';
import {
	agreementNote,
	datingView,
	distanceModeOf,
	divergenceSentence,
	estimatorRows,
	figureModel,
	headlineOf,
	latentRootView,
	modeShiftSentence,
	modelOffer,
	modelRan,
	statEntries,
	verdictSentence
} from './dating';
import { fixtureJson, fixturesAvailable } from './fixtures';
import type { DatingResult, TaxonDatingRow } from './types';

interface FixtureCase {
	name: string;
	outputs: { result: Record<string, unknown> };
}

const have = fixturesAvailable();

/** The reference's own record, wrapped in the shape the page holds. */
function fromReference(caseName: string, ran: boolean): DatingResult {
	const cases = fixtureJson<FixtureCase[]>('dating/run_mrca_dating_model.json');
	const found = cases.find((c) => c.name === caseName);
	if (!found) throw new Error(`fixture case ${caseName} is not in run_mrca_dating_model.json`);
	const record = { ...found.outputs.result } as Record<string, unknown>;

	// This build's adjudication, replayed on the reference's own fits. The assertions below check
	// that `selectedClock` came out identical to the reference's, so nothing here is assumed.
	const ols = record.ols as Record<string, unknown>;
	const pgls = (record.pgls ?? null) as Record<string, unknown> | null;
	const spline = (record.spline ?? null) as Record<string, unknown> | null;
	const selection = selectClockModel({ ols, pgls, spline, clockModel: 'auto' });
	const timespan = record.timespan as number[];
	const admitted = admitEnsembleCandidates({
		ols,
		pgls,
		spline,
		minSampleTime: timespan[0],
		selected: selection.name,
		cladeAttenuated: selection.cladeAttenuated
	});

	record.primaeon = {
		schema_version: 2,
		surface: 'web-time',
		time_units: 'years',
		sequences_in_file: 143,
		dated: 142,
		train_count: 141,
		holdouts: ['Z59ZR.ZHU'],
		holdouts_reserved: true,
		excluded_taxa: [],
		root_case: null,
		model_pass: ran
			? { taxa: 143, codons: 981, batch_size: 78, calls: 13, row_layers: 6, embed_dim: 384, elapsed_seconds: 7.3 }
			: null,
		model_unavailable_reason: ran ? null : 'the model-based estimators were not asked for',
		pagel_lambda: pgls ? (pgls.pagel_lambda as number) : null,
		estimators_not_built: [
			{ name: 'Power-law clock', reason: 'Not ported (PLAN-TEMPORAL D33).' },
			{ name: 'Leave-one-out / jackknife', reason: 'Opt-in upstream behind --loocv.' }
		]
	};

	return {
		ok: true,
		refusal: null,
		warnings: [...selection.warnings, ...admitted.warnings],
		record,
		rows: record.taxa_summary as TaxonDatingRow[],
		activeName: selection.name,
		selectedClock: selection.selectedClock,
		ensemble: admitted.ensemble,
		rootDescription: record.root_description as string,
		rootCase: null,
		elapsedMs: 0,
		ranAtIso: '2026-01-01T00:00:00.000Z',
		options: {
			root: 'taxon',
			rootTaxon: 'CONSENSUS',
			clockModel: 'auto',
			ciMethod: 'fieller',
			excludedTaxa: [],
			units: 'years',
			useModel: ran,
			distanceMode: caseName.endsWith('tn93') ? 'tn93' : 'auto'
		},
		model: ran
			? {
					variant: 'general',
					sha256: 'eb44892de6074c2806f858c17f3ead6fe8d7b1e8b9b3aa067efca20fbe4a1f10',
					file: 'general_taxa.onnx',
					numThreads: 4,
					crossOriginIsolated: true,
					firstLoad: true,
					taxa: 143,
					codons: 981,
					passSeconds: 7.3
				}
			: null
	};
}

describe.skipIf(!have)('the reference’s own record, replayed through this build’s adjudication', () => {
	it('reproduces `selected_clock` byte for byte on TN93 divergences', () => {
		const run = fromReference('000_korber_tn93', true);
		expect(run.selectedClock).toBe('Linear PGLS (parsimonious linear clock preferred, λ*=0.6984; p=0.5753)');
		expect(run.selectedClock).toBe(run.record.selected_clock);
		expect(run.activeName).toBe('pgls');
		expect(run.activeName).toBe(run.record.active_model);
	});

	it('reproduces `selected_clock` byte for byte on latent divergences, where OLS wins back', () => {
		const run = fromReference('001_korber_latent', true);
		expect(run.selectedClock).toBe(
			'Linear (OLS preferred: PGLS temporal slope non-significant, g=1.72 vs OLS g=0.173)'
		);
		expect(run.selectedClock).toBe(run.record.selected_clock);
		expect(run.activeName).toBe('ols');
	});

	it('reproduces the ensemble the reference published, including the weights that exclude PGLS', () => {
		const tn93 = fromReference('000_korber_tn93', true);
		const ref = tn93.record.ensemble as { t_mrca: number; weights: Record<string, number> };
		expect(tn93.ensemble.t_mrca).toBeCloseTo(ref.t_mrca, 6);
		expect(tn93.ensemble.weights.ols).toBeCloseTo(ref.weights.ols, 9);
		expect(tn93.ensemble.weights.pgls).toBeCloseTo(ref.weights.pgls, 9);

		// Latent: the generalised fit is clade attenuated, so it is barred from the average and the
		// weights collapse to the ordinary fit alone. That is the reference's own `{ols: 1.0}`.
		const latent = fromReference('001_korber_latent', true);
		expect(latent.ensemble.weights).toEqual({ ols: 1.0 });
		expect(latent.warnings.some((w) => w.code === 'DATING_CLADE_ATTENUATED')).toBe(true);
	});
});

describe.skipIf(!have)('which fit the page quotes', () => {
	it('quotes the generalised fit on TN93 divergences, agreeing with the CLI’s own t_mrca', () => {
		const run = fromReference('000_korber_tn93', true);
		const head = headlineOf(run)!;
		expect(head.key).toBe('pgls');
		expect(head.departed).toBe(false);
		expect(head.model.t_mrca).toBeCloseTo(1841.6129634138606, 6);
		// The CLI's top-level t_mrca is the selected model's, so the two cannot disagree here.
		expect(run.record.t_mrca).toBeCloseTo(head.model.t_mrca as number, 9);
	});

	it('quotes the ordinary fit on latent divergences, because that is what the reference selected', () => {
		const run = fromReference('001_korber_latent', true);
		const head = headlineOf(run)!;
		expect(head.key).toBe('ols');
		expect(head.departed).toBe(false);
		expect(head.model.t_mrca).toBeCloseTo(1926.8110853177513, 6);
	});

	it('never quotes a fit whose interval is its own point estimate', () => {
		// The latent spline lands at −1974.6 with ci_mrca [x, x]. It is in the table; it is never the
		// headline, whatever the selection says.
		const run = fromReference('001_korber_latent', true);
		const spline = run.record.spline as Record<string, number[]>;
		expect(spline.ci_mrca[0]).toBe(spline.ci_mrca[1]);
		expect(headlineOf(run)!.key).not.toBe('spline');
	});
});

describe.skipIf(!have)('what the section says about divergence', () => {
	it('says a TN93 distance is a sequence distance and involves no model', () => {
		const run = fromReference('000_korber_tn93', true);
		expect(distanceModeOf(run)).toBe('tn93');
		expect(divergenceSentence(run, 'years')).toContain('TN93 distance');
		expect(latentRootView(run)).toBeNull();
	});

	it('says a latent divergence is not a sequence distance, and that every estimator uses it', () => {
		const run = fromReference('001_korber_latent', true);
		expect(distanceModeOf(run)).toBe('latent');
		const sentence = divergenceSentence(run, 'years');
		expect(sentence).toContain('not a sequence distance');
		expect(sentence).toContain('the ordinary one included');
		expect(sentence).toContain('5.407 × 10⁻²'); // α, to four significant figures
		expect(sentence).toContain('0.374'); // the root's own temporal correlation
	});

	it('translates the latent root token rather than printing it, and never calls it a consensus', () => {
		const run = fromReference('001_korber_latent', true);
		const stats = statEntries(run, 'years');
		const last = stats[stats.length - 1];
		expect(last.label).toBe('Divergence measured to');
		expect(last.value).toBe('a latent root');
		expect(last.qualifier).toContain('inside its own representation');
		expect(last.qualifier).not.toContain('consensus');
	});

	it('reports the latent root’s anchors in the reference’s own order', () => {
		const latent = latentRootView(fromReference('001_korber_latent', true))!;
		expect(latent.anchors.map((a) => a.taxon)).toEqual([
			'B85US.ALA1',
			'D90UG.UG269A',
			'C89SO.SM145A',
			'C91DJ.259A',
			'D90UG.274A2',
			'D84ZR.NDK'
		]);
		expect(latent.anchors[0].weight).toBeCloseTo(0.323986291885376, 9);
		expect(latent.alpha).toBeCloseTo(0.05406843894704035, 12);
	});
});

describe.skipIf(!have)('the estimator table', () => {
	it('gives the generalised fit its own row, with λ* and the attenuation stated', () => {
		const run = fromReference('001_korber_latent', true);
		const rows = estimatorRows(run, 'years');
		const names = rows.map((r) => r.name);
		expect(names.slice(0, 3)).toEqual(['Root-to-tip OLS (TempEst)', 'Attention PGLS', 'Restricted spline clock']);
		const pgls = rows[1];
		expect(pgls.built).toBe(true);
		expect(pgls.date).toBe('1633.1');
		expect(pgls.note).toContain('Pagel λ* = 0.8591');
		expect(pgls.note).toContain('not distinguishable from zero');
		expect(pgls.note).toContain('clade attenuated');
	});

	it('writes a half-infinite interval as a clause and never as a number', () => {
		const rows = estimatorRows(fromReference('001_korber_latent', true), 'years');
		expect(rows[1].interval).toContain('no lower bound');
		expect(rows[1].interval).toContain('1836.7');
		expect(rows[1].interval).not.toContain('Infinity');
	});

	it('marks the spline as a generalised fit once the model has run', () => {
		const withModel = fromReference('000_korber_tn93', true);
		const spline = estimatorRows(withModel, 'years').find((r) => r.name === 'Restricted spline clock')!;
		expect(spline.note).toContain('fitted against the model’s covariance');
		expect(spline.date).toBe('1864.5');

		// And does NOT, when it did not: the same record read as a model-free run.
		const without = fromReference('000_korber_tn93', false);
		const plain = estimatorRows(without, 'years').find((r) => r.name === 'Restricted spline clock')!;
		expect(plain.note).not.toContain('covariance');
	});

	it('keeps the two model-based estimators out of the "not built" list once they are built', () => {
		const run = fromReference('000_korber_tn93', true);
		const unbuilt = estimatorRows(run, 'years')
			.filter((r) => !r.built)
			.map((r) => r.name);
		expect(unbuilt).toEqual(['Power-law clock', 'Leave-one-out / jackknife']);
		expect(unbuilt).not.toContain('Attention PGLS');
		expect(unbuilt).not.toContain('Latent root search');
	});
});

describe.skipIf(!have)('the paragraph that replaces averaging', () => {
	it('gives the span between the fits in years, and the cause', () => {
		const run = fromReference('001_korber_latent', true);
		const note = agreementNote(run, 'years')!;
		// −1974.6 (spline) to 1926.8 (ols): the span is stated, not hidden behind an average.
		expect(note).toContain('1926.8');
		expect(note).toContain('-1974.6');
		expect(note).toContain('Pagel');
		expect(note).toContain('clade-attenuation');
		expect(note).toContain('disqualified from the headline AND from the averaged row');
	});

	it('names the unbounded slope when that, and not attenuation, is what took the headline', () => {
		// The TN93 run: the generalised fit IS selected, so the note explains the agreement instead.
		const run = fromReference('000_korber_tn93', true);
		const note = agreementNote(run, 'years')!;
		expect(note).toContain('The reference selected the generalised fit');
		expect(note).toContain('1893.9'); // the ordinary fit is named, not hidden
	});

	it('returns nothing to explain when there is only one fit', () => {
		const run = fromReference('000_korber_tn93', true);
		const one = { ...run, record: { ...run.record, pgls: null, spline: null } };
		expect(agreementNote(one, 'years')).toBeNull();
	});
});

describe.skipIf(!have)('the ordinary fit moving when the model is switched on', () => {
	it('states the size of the move and that the arithmetic did not change', () => {
		const before = fromReference('000_korber_tn93', true);
		const after = fromReference('001_korber_latent', true);
		const sentence = modeShiftSentence(after, before, 'years')!;
		expect(sentence).toContain('1893.9');
		expect(sentence).toContain('1926.8');
		expect(sentence).toContain('32.9 years');
		expect(sentence).toContain('its arithmetic did not change');
		expect(sentence).toContain('two response');
	});

	it('says nothing when both runs measured divergence the same way', () => {
		const a = fromReference('000_korber_tn93', true);
		expect(modeShiftSentence(a, a, 'years')).toBeNull();
	});
});

describe.skipIf(!have)('the whole view', () => {
	it('carries the model’s identity and the mode through to the section', () => {
		const view = datingView(fromReference('001_korber_latent', true), 'years')!;
		expect(view.ok).toBe(true);
		expect(view.modelRan).toBe(true);
		expect(view.distanceMode).toBe('latent');
		expect(view.headline).toBe('ols');
		expect(view.activeModel).toBe('ols');
		expect(view.latent?.anchors).toHaveLength(6);
		expect(view.agreement).toBeTruthy();
		expect(view.divergence).toContain('not a sequence distance');
	});

	it('shows Pagel λ* rather than an em dash where a generalised fit has no F statistic', () => {
		const view = datingView(fromReference('000_korber_tn93', true), 'years')!;
		expect(view.headline).toBe('pgls');
		const labels = view.stats.map((s) => s.label);
		expect(labels).toContain('Pagel λ*');
		expect(labels).not.toContain('Slope p');
		const lambda = view.stats.find((s) => s.label === 'Pagel λ*')!;
		expect(lambda.value).toBe('0.6984');
		expect(view.stats.every((s) => s.value !== '—')).toBe(true);
	});

	it('puts the headline fit’s own line and bracket on the figure', () => {
		const run = fromReference('000_korber_tn93', true);
		const fig = figureModel(run)!;
		// The bracket is the generalised fit's, not the ordinary one's: 1753.2 to 1882.2.
		expect(fig.ancestor!.t).toBeCloseTo(1841.6129634138606, 6);
		expect(fig.ancestor!.low).toBeCloseTo(1753.1764616209157, 6);
		expect(fig.ancestor!.openLow).toBe(false);
		expect(fig.points).toHaveLength(142);
	});

	it('draws an unbounded lower bound as an open bracket rather than as a number', () => {
		// The latent PGLS interval is [−inf, 1836.7]; it is not the headline there, so take the
		// record that makes it one and check the figure refuses to draw a lower edge.
		const run = fromReference('001_korber_latent', true);
		const forced = { ...run, record: { ...run.record, active_model: 'pgls' } };
		const fig = figureModel(forced)!;
		expect(fig.ancestor!.openLow).toBe(true);
		expect(Number.isFinite(fig.ancestor!.low)).toBe(true);
	});

	it('names the run in the verdict when it is not the ordinary fit', () => {
		expect(verdictSentence(fromReference('000_korber_tn93', true), 'years')).toContain('by the generalised fit');
		expect(verdictSentence(fromReference('001_korber_latent', true), 'years')).not.toContain('by the generalised fit');
	});

	it('knows whether the graph ran, from the record and not from the caller', () => {
		expect(modelRan(fromReference('000_korber_tn93', true))).toBe(true);
		expect(modelRan(fromReference('000_korber_tn93', false))).toBe(false);
		expect(modelRan(null)).toBe(false);
	});
});

describe('what the page offers before a run', () => {
	it('offers the model with its cost stated', () => {
		const offer = modelOffer({ workers: true, dated: 142, codons: 981, maxTaxa: 1500 });
		expect(offer.available).toBe(true);
		expect(offer.cost).toContain('981 codons');
		expect(offer.cost).toContain('7.3 MB');
		expect(offer.cost).toContain('cancelled');
	});

	it('refuses above the cap, and says the reference downgrades there instead', () => {
		const offer = modelOffer({ workers: true, dated: 1501, codons: 300, maxTaxa: 1500 });
		expect(offer.available).toBe(false);
		expect(offer.reason).toContain('1501 dated sequences is more than the 1500');
		expect(offer.reason).toContain('falls back to the ordinary fit');
		expect(offer.cost).toBe('');
	});

	it('refuses without Web Workers, and says why that matters', () => {
		const offer = modelOffer({ workers: false, dated: 10, codons: 100, maxTaxa: 1500 });
		expect(offer.available).toBe(false);
		expect(offer.reason).toContain('cancelled');
	});
});
