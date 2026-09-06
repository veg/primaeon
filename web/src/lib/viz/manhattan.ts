/**
 * manhattan.ts — the Manhattan plot's canvas drawing, as a function of data and colours.
 *
 * WHY THIS FILE EXISTS. Ported from axomeme3/index.html `renderManhattanPlot` (section 6, lines
 * 3323-3606 of the live file) and since reset to DESIGN.md §3 "Manhattan plot": a
 * devicePixelRatio-scaled canvas, the predicted LRT on the left axis, codon and amino-acid
 * Shannon entropy as two opt-in lines on a right axis fixed at 0-6 bits, and a list of plotted
 * stems for hit-testing by the caller. Kept as a pure draw function (no DOM lookups, no event
 * handlers) so ManhattanPlot.svelte owns the element, the tooltip and the resize, and this can be
 * exercised on an OffscreenCanvas.
 *
 * WHAT IS DRAWN, and why:
 *   - Variable sites are 1.5 px STEMS from the baseline in the uncalled grey; a called site's stem
 *     is purple with a 3 px dot and its residue-prefixed label ("D697") above. One glyph means
 *     "called" across the report (the same purple square sits in the table's Call column), so a
 *     reader learns it once. There are no tier halos and no dot on an uncalled site: called or
 *     not is the only distinction the surrogate score supports.
 *   - Invariable sites are NOT drawn. Their zeros were set before the model was consulted
 *     (runtime/src/postprocess.js header); drawing them at zero would print a score that was
 *     never made. The caption says how many are left blank.
 *   - One labelled THRESHOLD RULE at the active call cut — the lowest LRT the active mode called
 *     — so the plot explains its own cut. It is the mode's rule, not a fixed χ² 3.84 the mode may
 *     not be using, and it is omitted when the mode called nothing.
 *   - No frame, no grid: hairline axes with a title each ("LRT", "codon"), 12 px tick labels.
 *   - Colours come in as arguments (the app's --plot-* tokens, resolved by the component through
 *     theme.ts) so the plot follows the light and dark schemes and hard-codes nothing.
 *
 * MEASUREMENTS BEHIND THE CONSTANTS. MAX_ENTROPY 6 bits is axomeme3's right-axis ceiling (log2
 * of 61 sense codons is 5.93, so codon entropy never leaves the axis); the 1.15 head-room factor
 * on the LRT axis and the 0.2 floor are the original's; the 8 px hit half-width is the width of
 * a fingertip's worth of stem at 1.5 px, wide enough to catch and narrow enough not to grab a
 * neighbour on a 1,000-codon gene at 900 px.
 */

import type { SiteRow } from '$lib/results/derive';
import type { SiteComposition } from '$lib/results/entropy';

export interface PlotColours {
	/** Axis lines. */
	axis: string;
	/** Tick labels and axis titles. */
	tick: string;
	/** Called stems, dots and labels. */
	called: string;
	/** Uncalled variable stems. */
	uncalled: string;
	/** The dashed threshold rule. */
	threshold: string;
	/** The two entropy lines. */
	entropy: string;
	/** The hovered stem. */
	highlight: string;
}

export interface PlotPoint {
	/** Stem x in CSS px. */
	x: number;
	/** Stem top in CSS px. */
	y: number;
	/** Baseline in CSS px (the stem's foot). */
	y0: number;
	row: SiteRow;
	composition: SiteComposition | null;
}

export interface Threshold {
	lrt: number;
	label: string;
}

export interface DrawOptions {
	width: number;
	height: number;
	dpr: number;
	colours: PlotColours;
	fontFamily: string;
	showEntropy: boolean;
	/** The active call cut, or null when the mode called nothing. */
	threshold?: Threshold | null;
	/** The 1-indexed site to emphasise (hovered or selected), if any. */
	highlight?: number | null;
}

export const PADDING = { left: 44, right: 16, rightWithEntropy: 44, top: 26, bottom: 34 } as const;
export const MAX_ENTROPY = 6.0;
export const HIT_HALF_WIDTH = 8;
export const TICK_FONT = 12;

/** Tick positions from 0 to `max` at a "nice" step (1, 2, 5 × 10^k), about `count` of them. */
export function niceTicks(max: number, count = 5): number[] {
	if (!(max > 0)) return [0];
	const raw = max / count;
	const pow = Math.pow(10, Math.floor(Math.log10(raw)));
	const m = raw / pow;
	const step = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * pow;
	const ticks: number[] = [];
	for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
	return ticks;
}

/**
 * Draw the plot and return the plotted stems in CSS pixels.
 */
export function drawManhattan(
	ctx: CanvasRenderingContext2D,
	rows: readonly SiteRow[],
	compositions: readonly SiteComposition[] | null,
	options: DrawOptions
): PlotPoint[] {
	const { width, height, dpr, colours, fontFamily, showEntropy } = options;
	const entropyOn = showEntropy && compositions !== null && compositions.length > 0;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const right = entropyOn ? PADDING.rightWithEntropy : PADDING.right;
	const graphWidth = width - PADDING.left - right;
	const graphHeight = height - PADDING.top - PADDING.bottom;
	const baseline = PADDING.top + graphHeight;
	const x0 = PADDING.left;
	const x1 = PADDING.left + graphWidth;
	if (rows.length === 0 || graphWidth <= 0 || graphHeight <= 0) return [];

	const maxSite = rows.length;
	const xOf = (site: number) => x0 + (maxSite > 1 ? (graphWidth / (maxSite - 1)) * (site - 1) : graphWidth / 2);
	let maxLrt = 0.2;
	for (const r of rows) if (r.isVariable && r.lrt > maxLrt) maxLrt = r.lrt;
	maxLrt *= 1.15;
	const yOf = (lrt: number) => baseline - (Math.max(0, lrt) / maxLrt) * graphHeight;

	const tickFont = `${TICK_FONT}px ${fontFamily}`;
	const labelFont = `bold ${TICK_FONT}px ${fontFamily}`;

	// Left axis: a hairline, tick labels, and the title "LRT" above the ticks.
	ctx.lineWidth = 1;
	ctx.strokeStyle = colours.axis;
	ctx.beginPath();
	ctx.moveTo(x0 + 0.5, PADDING.top);
	ctx.lineTo(x0 + 0.5, baseline + 0.5);
	ctx.lineTo(x1, baseline + 0.5);
	ctx.stroke();

	ctx.fillStyle = colours.tick;
	ctx.font = tickFont;
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for (const v of niceTicks(maxLrt / 1.15, 4)) {
		const y = yOf(v);
		ctx.beginPath();
		ctx.moveTo(x0 - 4, Math.round(y) + 0.5);
		ctx.lineTo(x0, Math.round(y) + 0.5);
		ctx.stroke();
		ctx.fillText(formatTick(v), x0 - 7, y);
	}
	ctx.textBaseline = 'bottom';
	ctx.fillText('LRT', x0 - 7, PADDING.top - 6);

	// Bottom axis: codon ticks at a nice step, the first one at codon 1, the title at the right.
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	const xTicks = niceTicks(maxSite, 6).filter((v) => v > 0 && v <= maxSite);
	for (const site of [1, ...xTicks]) {
		const x = Math.round(xOf(site)) + 0.5;
		ctx.beginPath();
		ctx.moveTo(x, baseline + 1);
		ctx.lineTo(x, baseline + 5);
		ctx.stroke();
		ctx.fillText(String(site), x, baseline + 8);
	}
	ctx.textAlign = 'right';
	ctx.fillText('codon', x1, baseline + 20);

	// Right axis and the two entropy lines: codon (solid) and amino acid (dashed), one colour.
	if (entropyOn && compositions) {
		const yE = (bits: number) => baseline - (Math.min(bits, MAX_ENTROPY) / MAX_ENTROPY) * graphHeight;
		ctx.strokeStyle = colours.axis;
		ctx.beginPath();
		ctx.moveTo(x1 + 0.5, PADDING.top);
		ctx.lineTo(x1 + 0.5, baseline);
		ctx.stroke();
		ctx.fillStyle = colours.tick;
		ctx.font = tickFont;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		for (let i = 0; i <= MAX_ENTROPY; i += 2) {
			const y = Math.round(yE(i)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(x1 + 1, y);
			ctx.lineTo(x1 + 5, y);
			ctx.stroke();
			ctx.fillText(String(i), x1 + 8, y);
		}
		ctx.textBaseline = 'bottom';
		ctx.fillText('bits', x1 + 8, PADDING.top - 6);

		const line = (pick: (c: SiteComposition) => number, dash: number[]) => {
			ctx.save();
			ctx.setLineDash(dash);
			ctx.strokeStyle = colours.entropy;
			ctx.lineWidth = 1;
			ctx.beginPath();
			compositions.forEach((c, i) => {
				const x = xOf(c.site);
				const y = yE(pick(c));
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			});
			ctx.stroke();
			ctx.restore();
		};
		line((c) => c.codonEntropy, []);
		line((c) => c.aaEntropy, [3, 3]);
	}

	// The active call cut: a dashed rule with its name at the right, above the line.
	const threshold = options.threshold ?? null;
	if (threshold && Number.isFinite(threshold.lrt) && threshold.lrt > 0 && threshold.lrt <= maxLrt) {
		const y = Math.round(yOf(threshold.lrt)) + 0.5;
		ctx.save();
		ctx.setLineDash([4, 3]);
		ctx.strokeStyle = colours.threshold;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(x0 + 1, y);
		ctx.lineTo(x1, y);
		ctx.stroke();
		ctx.restore();
		ctx.fillStyle = colours.tick;
		ctx.font = tickFont;
		ctx.textAlign = 'right';
		ctx.textBaseline = 'bottom';
		ctx.fillText(threshold.label, x1 - 2, y - 3);
	}

	// Stems: uncalled first so the called ones draw on top; invariable sites are not drawn.
	const points: PlotPoint[] = [];
	const byComposition = compositions ? new Map(compositions.map((c) => [c.site, c])) : null;
	const variable = rows.filter((r) => r.isVariable);
	const uncalled = variable.filter((r) => r.tier === 0);
	const called = variable.filter((r) => r.tier > 0);

	const stem = (r: SiteRow, colour: string, widthPx: number) => {
		const x = xOf(r.site);
		const y = yOf(r.lrt);
		ctx.strokeStyle = colour;
		ctx.lineWidth = widthPx;
		ctx.beginPath();
		ctx.moveTo(x, baseline);
		ctx.lineTo(x, y);
		ctx.stroke();
		return { x, y };
	};

	for (const r of uncalled) {
		const highlighted = options.highlight === r.site;
		const { x, y } = stem(r, highlighted ? colours.highlight : colours.uncalled, highlighted ? 2.5 : 1.5);
		points.push({ x, y, y0: baseline, row: r, composition: byComposition?.get(r.site) ?? null });
	}

	// Labels: stack a label up one line when it would overlap the one placed before it.
	const placed: { left: number; right: number; bottom: number }[] = [];
	ctx.font = labelFont;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'bottom';
	for (const r of [...called].sort((a, b) => a.site - b.site)) {
		const highlighted = options.highlight === r.site;
		const { x, y } = stem(r, colours.called, highlighted ? 2.5 : 1.5);
		ctx.fillStyle = colours.called;
		ctx.beginPath();
		ctx.arc(x, y, 3, 0, 2 * Math.PI);
		ctx.fill();

		const text = `${r.refAa && r.refAa !== '?' ? r.refAa : ''}${r.site}`;
		const w = ctx.measureText(text).width;
		let left = Math.max(x0, Math.min(x1 - w, x - w / 2));
		let bottom = y - 5;
		for (const p of placed) {
			const overlapsX = left < p.right + 4 && left + w > p.left - 4;
			const overlapsY = bottom > p.bottom - TICK_FONT - 2 && bottom - TICK_FONT < p.bottom + 2;
			if (overlapsX && overlapsY) bottom = p.bottom - TICK_FONT - 2;
		}
		if (bottom - TICK_FONT < 2) bottom = TICK_FONT + 2;
		ctx.fillText(text, left + w / 2, bottom);
		placed.push({ left, right: left + w, bottom });
		points.push({ x, y, y0: baseline, row: r, composition: byComposition?.get(r.site) ?? null });
	}
	return points;
}

function formatTick(v: number): string {
	if (Number.isInteger(v)) return String(v);
	return v < 1 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(1);
}

/**
 * The stem nearest (x, y): within HIT_HALF_WIDTH horizontally and between its top and its foot
 * (with the same slack) vertically, the closest in x winning. Null when nothing is close.
 */
export function nearestPoint(points: readonly PlotPoint[], x: number, y: number): PlotPoint | null {
	let closest: PlotPoint | null = null;
	let minDx = HIT_HALF_WIDTH;
	for (const p of points) {
		const dx = Math.abs(p.x - x);
		if (dx >= minDx) continue;
		if (y < p.y - HIT_HALF_WIDTH || y > p.y0 + HIT_HALF_WIDTH) continue;
		minDx = dx;
		closest = p;
	}
	return closest;
}
