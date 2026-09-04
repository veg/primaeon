/**
 * rankedPlots.ts — Observable Plot specs for the ranked-sites view.
 *
 * WHY THIS FILE EXISTS. Ported from hyphy-scope/src/lib/utils/axomeme-plots.ts (the plots DM3's
 * AxomemeVisualization renders), with its prose kept as written. Its one rule governs these too:
 *
 *   NO THRESHOLD LINE. Every other per-site plot in hyphy-scope draws a rule at the significance
 *   cutoff, because for a real likelihood ratio test that line means something. The surrogate's
 *   score is not calibrated to that scale — across 12 real DataMonkey submissions and 662
 *   variable sites it reached the p <= 0.10 gate once and the p <= 0.05 gate never, on data
 *   where MEME itself reports significant sites. A horizontal rule here would be read as
 *   significance and would be wrong. What the model provides is an ORDER, so these plots show
 *   position within that order and let the tier colours carry the calling.
 *
 * Invariant sites are excluded upstream (`scoredRows`); their zeros were never predictions.
 *
 * WHAT CHANGED FROM THE PORT: the rows are this app's SiteRow (tier already assigned by
 * derive.ts, so `assignTiers`' floor-ordering trick is not needed); colours come from the app's
 * tokens through theme.ts rather than hyphy-scope's AXOMEME_COLORS; the fourth option,
 * "Synonymous vs non-synonymous", needs the retired 2.0 export's dS / dN+ heads and is declared
 * with its availability rule (never true for a three-output graph) so the option list matches
 * DM3's and lights up if a record ever carries rates.
 */

import * as Plot from '@observablehq/plot';
import type { SiteRow } from '$lib/results/derive';
import type { TierPalette } from './theme';

export interface PlotOption {
	label: string;
	available: (rows: SiteRow[]) => boolean;
}

type RateRow = SiteRow & { alphaDs?: number; betaPosDn?: number };

/** Sites the model actually scored. */
export function scoredRows(rows: SiteRow[]): SiteRow[] {
	return (rows ?? []).filter((r) => r.isVariable);
}

function hasRates(rows: SiteRow[]): boolean {
	return rows.some((r) => (r as RateRow).alphaDs !== undefined || (r as RateRow).betaPosDn !== undefined);
}

export function getPlotOptions(): PlotOption[] {
	return [
		{ label: 'Ranked sites', available: () => true },
		{ label: 'Score by site', available: () => true },
		{ label: 'Rank distribution', available: (s) => scoredRows(s).length >= 5 },
		{ label: 'Synonymous vs non-synonymous', available: (s) => scoredRows(s).length > 0 && hasRates(s) }
	];
}

export function getPlotDescription(plotType: string): string {
	const d: Record<string, string> = {
		'Ranked sites':
			'Every scored site, ordered by the model’s score. The x-axis is rank within this alignment, not codon position — it shows how sharply the top sites separate from the rest. A long flat tail means the model found little to distinguish.',
		'Score by site':
			'The model’s score along the coding sequence. Position on the y-axis is meaningful only relative to the other sites in this same alignment; the value is not calibrated to MEME’s scale and no significance threshold is drawn, because none would be meaningful.',
		'Rank distribution':
			'How the scores are spread across scored sites. A distribution with a clear right tail is one where the ranking is informative; a narrow one means the top-ranked sites are barely separated from the rest and the ordering carries little signal.',
		'Synonymous vs non-synonymous':
			'Predicted synonymous (dS) against non-synonymous (dN⁺) rate per site. Points above the diagonal have dN⁺ > dS, the pattern associated with positive selection. These are model estimates, not fitted rates.'
	};
	return d[plotType] ?? '';
}

/** Shared legend so tier colours mean the same thing in every plot. */
function tierLegend(rows: SiteRow[], palette: TierPalette, neutralLabel: string) {
	const labels = new Map<string, number>();
	for (const r of rows) if (r.isVariable && r.tier > 0) labels.set(r.call, r.tier);
	const ordered = [...labels.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
	return {
		domain: [...ordered, neutralLabel],
		range: [...ordered.map((l) => (labels.get(l) === 1 ? palette.tier1 : palette.tier2)), palette.neutral]
	};
}

export interface PlotContext {
	palette: TierPalette;
	neutralLabel: string;
	gridColour: string;
	width: number;
}

const tip = (d: SiteRow, extra: string) =>
	`Site ${d.site} (${d.refCodon}/${d.refAa})\n${extra}score ${d.lrt.toFixed(3)}\npercentile ${d.percentile.toFixed(1)}\n${d.call}`;

/**
 * Sites ordered by score — the plot that actually matches what the model does.
 *
 * A Manhattan plot along the sequence answers "where are the significant sites"; this answers "how
 * strongly does the ranking separate anything", which is the question a ranker can support.
 */
export function createRankPlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	const legend = tierLegend(rows, ctx.palette, ctx.neutralLabel);
	const ranked = [...scored].sort((a, b) => b.lrt - a.lrt).map((s, i) => ({ ...s, rank: i + 1 }));
	return Plot.plot({
		width: ctx.width,
		height: 320,
		marginBottom: 44,
		marginLeft: 56,
		x: { label: 'Rank within this alignment →', grid: true },
		y: { label: '↑ Score (uncalibrated)', grid: true, zero: true },
		color: { ...legend, legend: true },
		marks: [
			Plot.ruleY([0], { stroke: ctx.gridColour }),
			Plot.dot(ranked, {
				x: 'rank',
				y: 'lrt',
				fill: 'call',
				r: 3.2,
				title: (d: SiteRow & { rank: number }) => tip(d, `rank ${d.rank} of ${ranked.length}\n`)
			})
		]
	});
}

/**
 * Score along the coding sequence.
 *
 * The familiar per-site view, deliberately WITHOUT a threshold rule. Only scored sites appear, so
 * gaps in the x-axis are invariant columns rather than missing data.
 */
export function createSitePlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	const legend = tierLegend(rows, ctx.palette, ctx.neutralLabel);
	return Plot.plot({
		width: ctx.width,
		height: 320,
		marginBottom: 44,
		marginLeft: 56,
		x: { label: 'Codon site →', grid: true },
		y: { label: '↑ Score (uncalibrated)', grid: true, zero: true },
		color: { ...legend, legend: true },
		marks: [
			Plot.ruleY([0], { stroke: ctx.gridColour }),
			Plot.ruleX(scored, { x: 'site', y1: 0, y2: 'lrt', stroke: ctx.gridColour, strokeWidth: 1 }),
			Plot.dot(scored, { x: 'site', y: 'lrt', fill: 'call', r: 3.2, title: (d: SiteRow) => tip(d, '') })
		]
	});
}

/** How spread out the scores are — a narrow distribution means the ranking carries little. */
export function createDistributionPlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	return Plot.plot({
		width: ctx.width,
		height: 280,
		marginBottom: 44,
		marginLeft: 56,
		x: { label: 'Score (uncalibrated) →', grid: true },
		y: { label: '↑ Sites', grid: true },
		marks: [
			// fill belongs to the MARK, not to the bin transform's inputs — binX only accepts channel
			// definitions, and passing a constant colour through it is a type error.
			Plot.rectY(scored, { ...Plot.binX({ y: 'count' }, { x: 'lrt' }), fill: ctx.palette.tier2 }),
			Plot.ruleY([0])
		]
	});
}

/** dS against dN+, with the neutral diagonal for reference. */
export function createRatePlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows) as RateRow[];
	const legend = tierLegend(rows, ctx.palette, ctx.neutralLabel);
	const max = Math.max(1, ...scored.map((s) => Math.max(s.alphaDs ?? 0, s.betaPosDn ?? 0)));
	return Plot.plot({
		width: ctx.width,
		height: 400,
		marginBottom: 44,
		marginLeft: 56,
		x: { label: 'Synonymous rate (dS) →', grid: true, domain: [0, max] },
		y: { label: '↑ Non-synonymous rate (dN⁺)', grid: true, domain: [0, max] },
		color: { ...legend, legend: true },
		marks: [
			// dN = dS. Above it, dN+ exceeds dS — the positive-selection pattern.
			Plot.line(
				[
					{ x: 0, y: 0 },
					{ x: max, y: max }
				],
				{ x: 'x', y: 'y', stroke: ctx.gridColour, strokeDasharray: '4,4' }
			),
			Plot.dot(scored, {
				x: 'alphaDs',
				y: 'betaPosDn',
				fill: 'call',
				r: 3.2,
				title: (d: RateRow) =>
					`Site ${d.site} (${d.refCodon}/${d.refAa})\ndS ${(d.alphaDs ?? 0).toFixed(3)}\ndN⁺ ${(d.betaPosDn ?? 0).toFixed(3)}\n${d.call}`
			})
		]
	});
}

/** Dispatch by plot label. */
export function createPlot(plotType: string, rows: SiteRow[], ctx: PlotContext) {
	switch (plotType) {
		case 'Score by site':
			return createSitePlot(rows, ctx);
		case 'Rank distribution':
			return createDistributionPlot(rows, ctx);
		case 'Synonymous vs non-synonymous':
			return createRatePlot(rows, ctx);
		case 'Ranked sites':
		default:
			return createRankPlot(rows, ctx);
	}
}
