/**
 * manhattan.ts — the Manhattan plot's canvas drawing, as a function of data and colours.
 *
 * WHY THIS FILE EXISTS. Ported from axomeme3/index.html `renderManhattanPlot` (section 6, lines
 * 3323-3606 of the live file): a devicePixelRatio-scaled canvas, the predicted LRT on the left
 * axis, codon and amino-acid Shannon entropy as filled area overlays on a right axis fixed at
 * 0-6 bits, tier points with a halo and the site number inside a tier-1 point, and a list of
 * plotted points for hit-testing by the caller. Kept as a pure draw function (no DOM lookups, no
 * event handlers) so ManhattanPlot.svelte owns the element, the tooltip and the resize, and this
 * can be exercised on an OffscreenCanvas.
 *
 * WHAT CHANGED FROM THE PORT, and why:
 *   - No dashed tier threshold lines. axomeme3 drew "Tier 1 (98% or LRT ≥ 5.0)" rules; those
 *     read as significance cutoffs, which the score does not support (hyphy-scope's
 *     axomeme-plots.ts, "no threshold line", measured across 12 DataMonkey submissions). The tier
 *     colours carry the calling instead.
 *   - Colours come in as arguments (the app's --tier-* tokens, resolved by the component) rather
 *     than the original's hard-coded pink/orange, so the plot follows the light and dark schemes.
 *   - Invariable sites are drawn faint at zero, as in the original, but the tooltip says "not
 *     scored" (ManhattanPlot.svelte) rather than printing 0.00000.
 *
 * MEASUREMENTS BEHIND THE CONSTANTS. Paddings 70/65/30/40 and the 12 px hit radius are the
 * original's; MAX_ENTROPY 6 bits is the original's right-axis ceiling (log2 of 61 sense codons is
 * 5.93, so codon entropy never leaves the axis); the 1.15 head-room factor on the LRT axis and the
 * 0.2 floor are the original's.
 */

import type { SiteRow } from '$lib/results/derive';
import type { SiteComposition } from '$lib/results/entropy';

export interface PlotColours {
	background: string;
	grid: string;
	axisText: string;
	tier1: string;
	tier2: string;
	variable: string;
	invariable: string;
	codonEntropy: string;
	aaEntropy: string;
	label: string;
}

export interface PlotPoint {
	x: number;
	y: number;
	row: SiteRow;
	composition: SiteComposition | null;
}

export interface DrawOptions {
	width: number;
	height: number;
	dpr: number;
	colours: PlotColours;
	fontFamily: string;
	showEntropy: boolean;
	/** The 1-indexed site to emphasise (hovered or selected), if any. */
	highlight?: number | null;
}

export const PADDING = { left: 70, right: 65, top: 30, bottom: 40 } as const;
export const MAX_ENTROPY = 6.0;
export const HIT_RADIUS = 12;

function withAlpha(colour: string, alpha: number): string {
	const c = colour.trim();
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
	if (!m) return c;
	let hex = m[1];
	if (hex.length === 3) hex = hex.split('').map((h) => h + h).join('');
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Draw the plot and return the plotted points in CSS pixels.
 */
export function drawManhattan(
	ctx: CanvasRenderingContext2D,
	rows: readonly SiteRow[],
	compositions: readonly SiteComposition[] | null,
	options: DrawOptions
): PlotPoint[] {
	const { width, height, dpr, colours, fontFamily, showEntropy } = options;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	const graphWidth = width - PADDING.left - PADDING.right;
	const graphHeight = height - PADDING.top - PADDING.bottom;
	const baseline = PADDING.top + graphHeight;

	ctx.fillStyle = colours.background;
	ctx.fillRect(0, 0, width, height);
	if (rows.length === 0 || graphWidth <= 0 || graphHeight <= 0) return [];

	const maxSite = rows.length;
	const xOf = (site: number) =>
		PADDING.left + (maxSite > 1 ? (graphWidth / (maxSite - 1)) * (site - 1) : graphWidth / 2);
	let maxLrt = 0.2;
	for (const r of rows) if (r.lrt > maxLrt) maxLrt = r.lrt;
	maxLrt *= 1.15;
	const yOf = (lrt: number) => baseline - (lrt / maxLrt) * graphHeight;

	// Grid and left axis.
	ctx.strokeStyle = colours.grid;
	ctx.lineWidth = 1;
	ctx.fillStyle = colours.axisText;
	ctx.font = `10px ${fontFamily}`;
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	const yTicks = 5;
	for (let i = 0; i <= yTicks; i++) {
		const v = (maxLrt / yTicks) * i;
		const y = baseline - (graphHeight / yTicks) * i;
		ctx.beginPath();
		ctx.moveTo(PADDING.left, y);
		ctx.lineTo(PADDING.left + graphWidth, y);
		ctx.stroke();
		ctx.fillText(v.toFixed(2), PADDING.left - 8, y);
	}

	// Vertical grid and x ticks.
	const xTicks = Math.min(10, maxSite);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	for (let i = 0; i < xTicks; i++) {
		const site = xTicks > 1 ? Math.floor((maxSite / (xTicks - 1)) * i) || 1 : 1;
		const x = xOf(Math.min(site, maxSite));
		ctx.beginPath();
		ctx.moveTo(x, PADDING.top);
		ctx.lineTo(x, baseline);
		ctx.stroke();
		ctx.fillText(String(Math.min(site, maxSite)), x, baseline + 6);
	}

	// Axis labels.
	ctx.save();
	ctx.translate(18, PADDING.top + graphHeight / 2);
	ctx.rotate(-Math.PI / 2);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = colours.axisText;
	ctx.font = `11px ${fontFamily}`;
	ctx.fillText('Predicted LRT (uncalibrated)', 0, 0);
	ctx.restore();
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.fillStyle = colours.axisText;
	ctx.font = `11px ${fontFamily}`;
	ctx.fillText('Codon site', PADDING.left + graphWidth / 2, baseline + 22);

	// Right axis: entropy in bits.
	if (showEntropy && compositions) {
		const axisX = PADDING.left + graphWidth;
		ctx.strokeStyle = colours.grid;
		ctx.fillStyle = colours.axisText;
		ctx.font = `9px ${fontFamily}`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		for (let i = 0; i <= MAX_ENTROPY; i++) {
			const y = baseline - (graphHeight / MAX_ENTROPY) * i;
			ctx.beginPath();
			ctx.moveTo(axisX, y);
			ctx.lineTo(axisX + 5, y);
			ctx.stroke();
			ctx.fillText(i.toFixed(1), axisX + 8, y);
		}
		ctx.save();
		ctx.translate(width - 18, PADDING.top + graphHeight / 2);
		ctx.rotate(Math.PI / 2);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `11px ${fontFamily}`;
		ctx.fillText('Entropy (bits)', 0, 0);
		ctx.restore();

		const area = (pick: (c: SiteComposition) => number, colour: string) => {
			const yE = (bits: number) => baseline - (Math.min(bits, MAX_ENTROPY) / MAX_ENTROPY) * graphHeight;
			ctx.beginPath();
			ctx.moveTo(PADDING.left, baseline);
			for (const c of compositions) ctx.lineTo(xOf(c.site), yE(pick(c)));
			ctx.lineTo(PADDING.left + graphWidth, baseline);
			ctx.closePath();
			ctx.fillStyle = withAlpha(colour, 0.08);
			ctx.fill();
			ctx.beginPath();
			compositions.forEach((c, i) => {
				const x = xOf(c.site);
				const y = yE(pick(c));
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			});
			ctx.strokeStyle = withAlpha(colour, 0.45);
			ctx.lineWidth = 1.5;
			ctx.stroke();
		};
		area((c) => c.codonEntropy, colours.codonEntropy);
		area((c) => c.aaEntropy, colours.aaEntropy);
	}

	// Points. Neutral first so the tiers draw on top.
	const points: PlotPoint[] = [];
	const byComposition = compositions ? new Map(compositions.map((c) => [c.site, c])) : null;
	const ordered = [...rows].sort((a, b) => a.tier - b.tier);
	for (const r of ordered) {
		const x = xOf(r.site);
		const y = yOf(r.lrt);
		let colour = colours.invariable;
		let radius = 2.5;
		if (r.tier === 1) {
			colour = colours.tier1;
			radius = String(r.site).length > 2 ? 9.5 : 7.5;
		} else if (r.tier === 2) {
			colour = colours.tier2;
			radius = 4.5;
		} else if (r.isVariable) {
			colour = colours.variable;
			radius = 3;
		}
		const highlighted = options.highlight === r.site;
		if (r.tier === 1 || highlighted) {
			ctx.beginPath();
			ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
			ctx.fillStyle = withAlpha(highlighted ? colours.label : colour, 0.25);
			ctx.fill();
		}
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, 2 * Math.PI);
		ctx.fillStyle = colour;
		ctx.fill();
		if (r.tier === 1) {
			ctx.save();
			ctx.fillStyle = '#ffffff';
			ctx.font = `bold 8px ${fontFamily}`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(String(r.site), x, y);
			ctx.restore();
		}
		points.push({ x, y, row: r, composition: byComposition?.get(r.site) ?? null });
	}
	return points;
}

/** The plotted point nearest (x, y) within HIT_RADIUS, or null. */
export function nearestPoint(points: readonly PlotPoint[], x: number, y: number): PlotPoint | null {
	let closest: PlotPoint | null = null;
	let minDist = HIT_RADIUS;
	for (const p of points) {
		const d = Math.hypot(p.x - x, p.y - y);
		if (d < minDist) {
			minDist = d;
			closest = p;
		}
	}
	return closest;
}
