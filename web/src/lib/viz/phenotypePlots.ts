/**
 * phenotypePlots.ts — Observable Plot specs for the phenotype association: the impulse plot along
 * the codons, and the two other views of the same rows.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.5 "phenotype": "association impulse plot with q ≤ α
 * highlighted". An impulse — a stem from zero at each codon, not a dot cloud and not a line — is
 * the right mark here for a reason the epistasis and sites plots do not share: the quantity is a
 * DIRECTIONAL correlation on [-1, 1] whose sign means something (positive tracks the foreground,
 * negative tracks the background), so zero is a real baseline and the distance from it is the
 * reading. A line would imply that neighbouring codons interpolate; a dot cloud would hide the
 * sign flips that make the picture.
 *
 * WHAT IS HIGHLIGHTED, AND WHY IT IS NOT JUST "q ≤ α". The reference's own trait co-selection
 * block takes `q_value <= alpha AND association_rho > 0` (phenotype.py:545), and
 * `significant_sites_count` in the record is the size of that set. A site with a small q and a
 * NEGATIVE rho is a real finding about the background, not a called site of a directional test, so
 * it is drawn in its own colour rather than lumped in with the calls or hidden.
 *
 * NO THRESHOLD RULE ON THE SCORE, for rankedPlots.ts's reason: the score
 * (`sqrt(max(0, lrt)) * max(0, rho)`) mixes a surrogate LRT with a correlation and is not
 * calibrated to any cut-off. The q-value view does draw the α rule, because α IS the cut-off the
 * calls were made at and the reader chose it.
 *
 * SITES ARRIVE IN SCORE ORDER, not position order (phenotype.py:518 sorts before the BH pass), and
 * only sites the pillar could score are present at all — a site with a zero-norm attribution row or
 * fewer than `min_taxa_per_site` sequenced taxa is absent, not zero. The x-axis is therefore the
 * codon number with gaps in it, which is the same convention the sites plots use for invariable
 * columns.
 */

import * as Plot from '@observablehq/plot';
import type { PhenotypeSiteRecord } from '$lib/report/types';

export interface PhenotypePlotContext {
	/** Called-site colour, background-tracking colour, and the rest. */
	called: string;
	negative: string;
	neutral: string;
	gridColour: string;
	width: number;
	/** The BH level the run used; the q view draws its rule here. */
	alpha: number;
	/** The 1-indexed codon count, so the axis spans the gene and not just the scored sites. */
	codonCount: number;
}

export type PhenotypePlotKind = 'association' | 'score' | 'significance';

export interface PhenotypePlotOption {
	kind: PhenotypePlotKind;
	label: string;
	description: string;
}

export const PHENOTYPE_PLOTS: readonly PhenotypePlotOption[] = [
	{
		kind: 'association',
		label: 'Association by codon',
		description:
			'Each scored codon’s directional association ρ between its attribution vector over taxa and the trait vector, drawn as an impulse from zero. Above zero the site’s signal tracks the foreground; below it, the background. Highlighted sites are the calls: q ≤ α with ρ > 0, the same bracket the reference takes into its trait sectors.'
	},
	{
		kind: 'score',
		label: 'Score by codon',
		description:
			'√max(0, LRT) × max(0, ρ): the pillar’s own ranking statistic, which asks for selection AND agreement with the trait at the same codon. It is not calibrated to a threshold — no rule is drawn — and the PARS bracket takes the first 15 sites of this order that also clear ρ ≥ 0.40 and score ≥ 0.50.'
	},
	{
		kind: 'significance',
		label: 'Significance by codon',
		description:
			'−log₁₀ of the Benjamini–Hochberg q over the combined p (ACAT of the site’s LRT p and its association p), with the α rule drawn because α is where the calls were made. Reading it as a MEME p-value would be wrong twice over: the LRT half is a surrogate’s prediction, and the association half is a correlation over taxa, not over independent observations.'
	}
];

/** The calls: the reference's own directional bracket (phenotype.py:545). */
export function isCalled(row: PhenotypeSiteRecord, alpha: number): boolean {
	return (row.q_value ?? 1) <= alpha && row.association_rho > 0;
}

/** A site with a small q but a negative ρ: a finding about the BACKGROUND, drawn as its own class. */
export function tracksBackground(row: PhenotypeSiteRecord, alpha: number): boolean {
	return (row.q_value ?? 1) <= alpha && row.association_rho <= 0;
}

type Klass = 'called' | 'background' | 'other';

function classify(row: PhenotypeSiteRecord, alpha: number): Klass {
	if (isCalled(row, alpha)) return 'called';
	if (tracksBackground(row, alpha)) return 'background';
	return 'other';
}

const LABEL: Record<Klass, string> = {
	called: 'q ≤ α, tracks foreground',
	background: 'q ≤ α, tracks background',
	other: 'not called'
};

function tip(row: PhenotypeSiteRecord, alpha: number): string {
	const q = row.q_value ?? NaN;
	return [
		`Codon ${row.site} — ${row.ref_aa}→${row.derived_aa}`,
		`association ρ ${row.association_rho.toFixed(3)}`,
		`score ${row.score.toFixed(3)}`,
		`surrogate LRT ${row.hyphaeon_lrt.toFixed(3)} (p ${row.p_lrt.toExponential(2)})`,
		`association p ${row.p_assoc.toExponential(2)}${row.p_assoc_perm != null ? ' (permulation)' : ''}`,
		`combined p ${row.p_value.toExponential(2)}, q ${Number.isFinite(q) ? q.toExponential(2) : '—'}`,
		`foreground ${row.foreground_freq_pct.toFixed(0)}% vs background ${row.background_freq_pct.toFixed(0)}%`,
		LABEL[classify(row, alpha)]
	].join('\n');
}

function colour(ctx: PhenotypePlotContext) {
	return {
		domain: [LABEL.called, LABEL.background, LABEL.other],
		range: [ctx.called, ctx.negative, ctx.neutral],
		legend: false
	};
}

interface PlotRow extends PhenotypeSiteRecord {
	klass: string;
	y: number;
}

function rowsFor(sites: PhenotypeSiteRecord[], ctx: PhenotypePlotContext, y: (r: PhenotypeSiteRecord) => number): PlotRow[] {
	return sites.map((r) => ({ ...r, klass: LABEL[classify(r, ctx.alpha)], y: y(r) }));
}

/**
 * The impulse plot. `Plot.ruleX` from zero to the value is the stem and `Plot.dot` its head; the
 * called sites are drawn LAST so a call is never hidden under a neutral neighbour in a long gene
 * (Smc6 has 1,097 codons in an 800-pixel axis, so overlap is the normal case, not the exception).
 */
export function createPhenotypePlot(kind: PhenotypePlotKind, sites: PhenotypeSiteRecord[], ctx: PhenotypePlotContext) {
	const domain: [number, number] = [0, Math.max(ctx.codonCount, ...sites.map((s) => s.site), 1)];
	const value =
		kind === 'association'
			? (r: PhenotypeSiteRecord) => r.association_rho
			: kind === 'score'
				? (r: PhenotypeSiteRecord) => r.score
				: (r: PhenotypeSiteRecord) => {
						const q = r.q_value ?? 1;
						return q > 0 ? -Math.log10(q) : 15;
					};
	const rows = rowsFor(sites, ctx, value);
	const ordered = [...rows].sort((a, b) => Number(a.klass !== LABEL.other) - Number(b.klass !== LABEL.other));
	const yLabel =
		kind === 'association' ? '↑ Association ρ with the trait' : kind === 'score' ? '↑ Score (uncalibrated)' : '↑ −log₁₀ q';
	const marks: Plot.Markish[] = [
		Plot.ruleY([0], { stroke: ctx.gridColour }),
		Plot.ruleX(ordered, { x: 'site', y1: 0, y2: 'y', stroke: 'klass', strokeWidth: 1.5, title: (d: PlotRow) => tip(d, ctx.alpha) }),
		Plot.dot(ordered.filter((r) => r.klass !== LABEL.other), {
			x: 'site',
			y: 'y',
			fill: 'klass',
			r: 3.2,
			title: (d: PlotRow) => tip(d, ctx.alpha)
		})
	];
	if (kind === 'significance' && ctx.alpha > 0) {
		marks.push(
			Plot.ruleY([-Math.log10(ctx.alpha)], { stroke: ctx.called, strokeDasharray: '4,4' }),
			Plot.text([{ x: domain[1], y: -Math.log10(ctx.alpha) }], {
				x: 'x',
				y: 'y',
				text: () => `q = ${ctx.alpha}`,
				dy: -6,
				dx: -4,
				textAnchor: 'end',
				fill: ctx.called,
				fontSize: 10
			})
		);
	}
	return Plot.plot({
		width: ctx.width,
		height: 320,
		marginBottom: 44,
		marginLeft: 60,
		x: { label: 'Codon site →', grid: false, domain },
		y: { label: yLabel, grid: false, zero: kind !== 'significance' },
		color: colour(ctx),
		marks
	});
}

/**
 * Foreground against background residue frequency at the called sites: the PARS signature as a
 * picture. A site in the top-left quadrant carries its derived residue in the foreground and not in
 * the background, which is what a phenotype-associated residue signature asserts.
 */
export function createParsPlot(sites: PhenotypeSiteRecord[], ctx: PhenotypePlotContext) {
	const rows = rowsFor(sites, ctx, (r) => r.score);
	return Plot.plot({
		width: ctx.width,
		height: 320,
		marginBottom: 44,
		marginLeft: 60,
		x: { label: 'Background frequency of the derived residue (%) →', grid: false, domain: [0, 100] },
		y: { label: '↑ Foreground frequency (%)', grid: false, domain: [0, 100] },
		color: colour(ctx),
		marks: [
			Plot.line(
				[
					{ x: 0, y: 0 },
					{ x: 100, y: 100 }
				],
				{ x: 'x', y: 'y', stroke: ctx.gridColour, strokeDasharray: '4,4' }
			),
			Plot.dot(rows, {
				x: 'background_freq_pct',
				y: 'foreground_freq_pct',
				fill: 'klass',
				r: 4,
				title: (d: PlotRow) => tip(d, ctx.alpha)
			})
		]
	});
}
