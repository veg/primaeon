/**
 * rankedPlots.ts — Observable Plot specs for the ranked-sites view.
 *
 * WHY THIS FILE EXISTS. Ported from hyphy-scope/src/lib/utils/axomeme-plots.ts (the plots DM3's
 * AxomemeVisualization renders), with its prose kept as written. Its one rule governs these too:
 *
 *   NO SIGNIFICANCE LINE. Every other per-site plot in hyphy-scope draws a rule at the
 *   significance cutoff, because for a real likelihood ratio test that line means something. The
 *   surrogate's score is not calibrated to that scale — across 12 real DataMonkey submissions and
 *   662 variable sites it reached the p <= 0.10 gate once and the p <= 0.05 gate never, on data
 *   where MEME itself reports significant sites. A horizontal rule at χ² 3.84 would be read as
 *   significance and would be wrong. What the model provides is an ORDER, so these plots show
 *   position within that order.
 *
 *   The one rule that IS drawn (DESIGN.md §3 "Ranked plot") is the ACTIVE CALL CUT — the lowest
 *   LRT the reader's chosen mode called, named with that mode's own label ("top 5 % of variable
 *   sites, LRT ≥ 3.29"). It is the plot explaining the cut the table used, not a claim about
 *   significance, and it is omitted when the mode called nothing.
 *
 * Invariant sites are excluded upstream (`scoredRows`); their zeros were never predictions.
 *
 * WHAT CHANGED FROM THE PORT: the rows are this app's SiteRow (tier already assigned by
 * derive.ts, so `assignTiers`' floor-ordering trick is not needed); colours come from the app's
 * tokens through theme.ts rather than hyphy-scope's AXOMEME_COLORS, and there are two of them —
 * called and not called — with no legend, because the caption carries the encoding; called sites
 * are labelled with residue and codon number; the fourth option, "Synonymous vs non-synonymous",
 * needs the retired 2.0 export's dS / dN+ heads and is declared with its availability rule
 * (never true for a three-output graph) so the option list matches DM3's and lights up if a
 * record ever carries rates.
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

/** The caption body of each plot: what is plotted, what the marks mean, what is not drawn. */
export function getPlotDescription(plotType: string): string {
	const d: Record<string, string> = {
		'Ranked sites':
			'Every scored site, ordered by predicted LRT. The x-axis is rank within this alignment, not codon position, so the curve shows how sharply the top sites separate from the rest; a long flat tail means the model found little to distinguish. Purple marks are called sites, labelled with residue and codon number; grey marks were not called.',
		'Score by site':
			'Predicted LRT along the coding sequence, scored sites only, so a gap on the x-axis is an invariable column rather than missing data. The value is meaningful only relative to the other sites in this alignment and is not calibrated to MEME’s scale. Purple marks are called sites; grey marks were not called.',
		'Rank distribution':
			'How the predicted LRTs are spread across scored sites. A distribution with a clear right tail is one where the ranking is informative; a narrow one means the top-ranked sites are barely separated from the rest and the ordering carries little signal.',
		'Synonymous vs non-synonymous':
			'Predicted synonymous (dS) against non-synonymous (dN⁺) rate per site. Points above the diagonal have dN⁺ > dS, the pattern associated with positive selection. These are model estimates, not fitted rates. Purple marks are called sites.'
	};
	return d[plotType] ?? '';
}

export interface PlotThreshold {
	lrt: number;
	label: string;
}

export interface PlotContext {
	palette: TierPalette;
	neutralLabel: string;
	/** Axis and baseline colour (`--plot-axis`). */
	gridColour: string;
	width: number;
	/** Tick labels and axis titles (`--plot-tick`). */
	tickColour?: string;
	/** The dashed threshold rule (`--plot-threshold`). */
	thresholdColour?: string;
	fontFamily?: string;
	/** The active call cut, drawn as a labelled dashed rule; null when nothing was called. */
	threshold?: PlotThreshold | null;
}

const label = (d: SiteRow) => `${d.refAa && d.refAa !== '?' ? d.refAa : ''}${d.site}`;

const tip = (d: SiteRow, extra: string) =>
	`${label(d)} (${d.refCodon})\n${extra}LRT ${d.lrt.toFixed(3)}\npercentile ${d.percentile.toFixed(1)}\n${d.tier > 0 ? d.call : 'not called'}`;

function style(ctx: PlotContext) {
	return {
		fontFamily: ctx.fontFamily ?? 'inherit',
		fontSize: '12px',
		color: ctx.tickColour ?? ctx.gridColour,
		background: 'transparent',
		overflow: 'visible'
	};
}

const fillOf = (ctx: PlotContext) => (d: SiteRow) => (d.tier > 0 ? ctx.palette.tier1 : ctx.palette.neutral);
const rOf = (d: SiteRow) => (d.tier > 0 ? 3.5 : 2.5);

/** The dashed rule at the active cut with its label at the right, or nothing. */
function thresholdMarks(ctx: PlotContext) {
	const t = ctx.threshold;
	if (!t || !Number.isFinite(t.lrt)) return [];
	return [
		Plot.ruleY([t.lrt], { stroke: ctx.thresholdColour ?? ctx.gridColour, strokeDasharray: '4,3' }),
		Plot.text([t], {
			y: 'lrt',
			frameAnchor: 'right',
			text: 'label',
			textAnchor: 'end',
			dy: -7,
			fill: ctx.tickColour ?? ctx.gridColour
		})
	];
}

/**
 * Sites ordered by score — the plot that actually matches what the model does.
 *
 * A Manhattan plot along the sequence answers "where are the significant sites"; this answers "how
 * strongly does the ranking separate anything", which is the question a ranker can support.
 */
export function createRankPlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	const ranked = [...scored].sort((a, b) => b.lrt - a.lrt).map((s, i) => ({ ...s, rank: i + 1 }));
	const called = ranked.filter((d) => d.tier > 0);
	return Plot.plot({
		width: ctx.width,
		height: RANK_PLOT.height,
		marginBottom: RANK_PLOT.marginBottom,
		marginLeft: RANK_PLOT.marginLeft,
		marginRight: RANK_PLOT.marginRight,
		marginTop: RANK_PLOT.marginTop,
		style: style(ctx),
		x: { label: 'rank', labelArrow: 'none', grid: false, ticks: 6 },
		y: { label: 'LRT', labelArrow: 'none', grid: false, zero: true, ticks: 4 },
		marks: [
			Plot.ruleY([0], { stroke: ctx.gridColour }),
			...thresholdMarks(ctx),
			Plot.dot(ranked, {
				x: 'rank',
				y: 'lrt',
				fill: fillOf(ctx),
				r: rOf,
				title: (d: SiteRow & { rank: number }) => tip(d, `rank ${d.rank} of ${ranked.length}\n`)
			}),
			...staggeredLabels(called, ctx, ranked.length)
		]
	});
}

/**
 * Called sites at consecutive ranks sit a few pixels apart, so their labels would print on top of
 * one another. Labels are placed in pixel space (the same margins and domain the plot uses, so the
 * estimate is within a tick of the real position): each takes the lowest line (0, 1, 2 …) on which
 * it clears every label already placed, and one text mark is emitted per line with its own `dy`.
 */
const RANK_PLOT = { height: 300, marginTop: 24, marginBottom: 40, marginLeft: 48, marginRight: 20 } as const;
function staggeredLabels(called: (SiteRow & { rank: number })[], ctx: PlotContext, n: number) {
	const innerW = ctx.width - RANK_PLOT.marginLeft - RANK_PLOT.marginRight;
	const innerH = RANK_PLOT.height - RANK_PLOT.marginTop - RANK_PLOT.marginBottom;
	const maxLrt = Math.max(0.2, ...called.map((d) => d.lrt)) * 1.02;
	const px = (d: { rank: number; lrt: number }) => ({
		x: RANK_PLOT.marginLeft + (innerW * (d.rank - 1)) / Math.max(1, n - 1),
		y: RANK_PLOT.marginTop + innerH * (1 - d.lrt / maxLrt)
	});
	const lines: (SiteRow & { rank: number })[][] = [];
	const placed: { x: number; y: number; w: number }[] = [];
	for (const d of [...called].sort((a, b) => b.lrt - a.lrt)) {
		const { x, y } = px(d);
		const w = label(d).length * 7.5;
		let line = 0;
		for (;;) {
			const ly = y - 9 - 13 * line;
			const clash = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - ly) < 12);
			if (!clash) break;
			line++;
		}
		placed.push({ x, y: y - 9 - 13 * line, w });
		(lines[line] ??= []).push(d);
	}
	return lines.map((data, line) =>
		Plot.text(data, { x: 'rank', y: 'lrt', text: label, dy: -9 - 13 * line, fill: ctx.palette.tier1, fontWeight: 700 })
	);
}

/**
 * Score along the coding sequence. Only scored sites appear, so gaps in the x-axis are invariant
 * columns rather than missing data.
 */
export function createSitePlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	const called = scored.filter((d) => d.tier > 0);
	return Plot.plot({
		width: ctx.width,
		height: 300,
		marginBottom: 40,
		marginLeft: 48,
		marginTop: 24,
		style: style(ctx),
		x: { label: 'codon', labelArrow: 'none', grid: false, ticks: 6 },
		y: { label: 'LRT', labelArrow: 'none', grid: false, zero: true, ticks: 4 },
		marks: [
			Plot.ruleY([0], { stroke: ctx.gridColour }),
			...thresholdMarks(ctx),
			Plot.ruleX(scored, { x: 'site', y1: 0, y2: 'lrt', stroke: fillOf(ctx), strokeWidth: 1.5 }),
			Plot.dot(called, { x: 'site', y: 'lrt', fill: ctx.palette.tier1, r: 3, title: (d: SiteRow) => tip(d, '') }),
			Plot.text(called, { x: 'site', y: 'lrt', text: label, dy: -9, fill: ctx.palette.tier1, fontWeight: 700 })
		]
	});
}

/** How spread out the scores are — a narrow distribution means the ranking carries little. */
export function createDistributionPlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows);
	const t = ctx.threshold;
	return Plot.plot({
		width: ctx.width,
		height: 260,
		marginBottom: 40,
		marginLeft: 48,
		marginTop: 24,
		style: style(ctx),
		x: { label: 'LRT', labelArrow: 'none', grid: false, ticks: 6 },
		y: { label: 'sites', labelArrow: 'none', grid: false, ticks: 4 },
		marks: [
			// fill belongs to the MARK, not to the bin transform's inputs — binX only accepts channel
			// definitions, and passing a constant colour through it is a type error.
			Plot.rectY(scored, { ...Plot.binX({ y: 'count' }, { x: 'lrt' }), fill: ctx.palette.neutral, insetLeft: 1 }),
			Plot.ruleY([0], { stroke: ctx.gridColour }),
			...(t && Number.isFinite(t.lrt)
				? [
						Plot.ruleX([t.lrt], { stroke: ctx.thresholdColour ?? ctx.gridColour, strokeDasharray: '4,3' }),
						Plot.text([t], { x: 'lrt', frameAnchor: 'top', text: 'label', textAnchor: 'start', dx: 4, dy: 4, fill: ctx.tickColour ?? ctx.gridColour })
					]
				: [])
		]
	});
}

/** dS against dN+, with the neutral diagonal for reference. */
export function createRatePlot(rows: SiteRow[], ctx: PlotContext) {
	const scored = scoredRows(rows) as RateRow[];
	const called = scored.filter((d) => d.tier > 0);
	const max = Math.max(1, ...scored.map((s) => Math.max(s.alphaDs ?? 0, s.betaPosDn ?? 0)));
	return Plot.plot({
		width: ctx.width,
		height: 380,
		marginBottom: 40,
		marginLeft: 48,
		marginTop: 24,
		style: style(ctx),
		x: { label: 'dS', labelArrow: 'none', grid: false, domain: [0, max] },
		y: { label: 'dN⁺', labelArrow: 'none', grid: false, domain: [0, max] },
		marks: [
			// dN = dS. Above it, dN+ exceeds dS — the positive-selection pattern.
			Plot.line(
				[
					{ x: 0, y: 0 },
					{ x: max, y: max }
				],
				{ x: 'x', y: 'y', stroke: ctx.thresholdColour ?? ctx.gridColour, strokeDasharray: '4,3' }
			),
			Plot.dot(scored, {
				x: 'alphaDs',
				y: 'betaPosDn',
				fill: fillOf(ctx),
				r: rOf,
				title: (d: RateRow) =>
					`${label(d)} (${d.refCodon})\ndS ${(d.alphaDs ?? 0).toFixed(3)}\ndN⁺ ${(d.betaPosDn ?? 0).toFixed(3)}\n${d.tier > 0 ? d.call : 'not called'}`
			}),
			Plot.text(called, { x: 'alphaDs', y: 'betaPosDn', text: label, dy: -9, fill: ctx.palette.tier1, fontWeight: 700 })
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
