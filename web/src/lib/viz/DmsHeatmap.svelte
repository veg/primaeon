<!--
	DmsHeatmap.svelte — the digital DMS as a 20 × L ΔLRT heatmap on canvas, with the plasticity
	track above it, hover, click-to-select, and progressive fill.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "dms — 20 × L ΔLRT heatmap, plasticity track, per-site
	detail". L is often > 1,000, so an SVG rect per cell (20,000+) would be the slowest thing on the
	page; a canvas draws the whole matrix in one pass and redraws when the payload grows (DMS
	arrives progressively: `plasticity` holds the sites swept so far, in site order, and columns
	not yet scored are left blank rather than drawn as zero). Deltas are MUTANT − BASELINE
	(dms.js header: positive means the substitution increases the selection signal), drawn on a
	diverging scale symmetric about 0 whose limit is the 98th percentile of |Δ| so one outlier does
	not flatten the picture; the wild-type cell is hatched. Hover reports site, residue, Δ; a click
	hands the site to the parent for the 19-delta detail. Rows are the 20 standard residues in the
	reference's REV_AA_MAP order (alphabetical one-letter codes).

	COLOUR (DESIGN.md §3 "DMS heatmap and legend"). The ramp is built from tokens the site already
	has: --dms-positive (the brand purple) for ΔLRT > 0 through --dms-zero (the page ground) to
	--dms-negative (the muted grey) for ΔLRT < 0. Purple and grey differ in chroma, not only in
	lightness, so sign survives at a glance; the tooltip and the per-site table print the signed
	number, so sign is never carried by colour alone. Every colour is read from the stylesheet at
	draw time and the canvas redraws when the scheme changes.
-->
<script lang="ts">
	import { interpolateRgb } from 'd3';
	import type { DmsSiteRecord } from '$lib/report/types';
	import { token } from './theme';

	interface Props {
		plasticity: DmsSiteRecord[];
		/** Codon count of the alignment; columns beyond the swept sites stay blank. */
		L: number;
		selected?: number | null;
		onSelect?: (site: number) => void;
	}
	let { plasticity, L, selected = null, onSelect }: Props = $props();

	const AAS = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y'];
	const ROW_H = 12;
	const TRACK_H = 44;
	const GAP = 8;
	const LEFT = 26;
	const AXIS_H = 20;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let wrap = $state<HTMLDivElement | null>(null);
	let width = $state(800);
	let hover = $state<{ x: number; y: number; text: string } | null>(null);
	/** Bumped when the colour scheme changes so the draw effect re-reads its tokens. */
	let scheme = $state(0);

	const bySite = $derived(new Map(plasticity.map((p) => [p.site, p])));
	const limit = $derived.by(() => {
		const abs: number[] = [];
		for (const p of plasticity) for (const v of Object.values(p.mutant_deltas)) if (Number.isFinite(v)) abs.push(Math.abs(v));
		if (abs.length === 0) return 1;
		abs.sort((a, b) => a - b);
		const q = abs[Math.min(abs.length - 1, Math.floor(0.98 * abs.length))];
		return q > 0 ? q : abs[abs.length - 1] || 1;
	});
	const maxPlasticity = $derived(plasticity.reduce((m, p) => Math.max(m, p.intrinsic_plasticity), 0) || 1);
	const height = TRACK_H + GAP + ROW_H * 20 + AXIS_H;
	const colW = $derived(Math.max(1, (width - LEFT) / Math.max(1, L)));

	/** The diverging ramp, resolved from the stylesheet; `t` in −1..1. */
	const ramp = $derived.by(() => {
		void scheme;
		const zero = token('--dms-zero') || token('--bg');
		const positive = token('--dms-positive') || token('--brand');
		const negative = token('--dms-negative') || token('--text-muted');
		const up = interpolateRgb(zero, positive);
		const down = interpolateRgb(zero, negative);
		return (t: number) => (t >= 0 ? up(Math.min(1, t)) : down(Math.min(1, -t)));
	});
	const color = (v: number) => ramp(Math.max(-1, Math.min(1, v / limit)));
	/** Nine steps of the ramp for the legend; a discrete ramp, not a gradient. */
	const STEPS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) width = Math.max(320, Math.floor(e.contentRect.width));
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const bump = () => scheme++;
		mq.addEventListener('change', bump);
		const mo = new MutationObserver(bump);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return () => {
			mq.removeEventListener('change', bump);
			mo.disconnect();
		};
	});

	$effect(() => {
		const c = canvas;
		if (!c) return;
		void scheme;
		const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
		c.width = Math.floor(width * dpr);
		c.height = Math.floor(height * dpr);
		c.style.width = `${width}px`;
		c.style.height = `${height}px`;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const bg = token('--bg');
		const axis = token('--plot-axis') || token('--text-faint');
		const tick = token('--plot-tick') || token('--text-muted');
		const hatch = token('--plot-hatch') || token('--text-faint');
		const bar = token('--plot-uncalled') || token('--text-faint');
		const ink = token('--text');
		const blank = token('--plot-null-band') || token('--surface-2');
		const font = token('--font-text');
		const paint = color;
		// Columns not yet swept: a blank band, not a zero.
		ctx.fillStyle = blank;
		ctx.fillRect(LEFT, TRACK_H + GAP, width - LEFT, ROW_H * 20);
		// Row labels.
		ctx.fillStyle = tick;
		ctx.font = `11px ${font}`;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		for (let r = 0; r < 20; r++) ctx.fillText(AAS[r], LEFT - 6, TRACK_H + GAP + r * ROW_H + ROW_H / 2);
		ctx.textAlign = 'left';
		// Plasticity baseline and title.
		ctx.fillStyle = axis;
		ctx.fillRect(LEFT, TRACK_H - 0.5, width - LEFT, 1);
		ctx.fillStyle = tick;
		ctx.textBaseline = 'top';
		ctx.fillText('intrinsic plasticity', LEFT, 0);
		ctx.textBaseline = 'middle';
		const cw = colW;
		for (const p of plasticity) {
			const x = LEFT + (p.site - 1) * cw;
			// Plasticity bar.
			const h = (p.intrinsic_plasticity / maxPlasticity) * (TRACK_H - 16);
			ctx.fillStyle = p.site === selected ? ink : bar;
			ctx.fillRect(x, TRACK_H - h, Math.max(1, cw - (cw > 3 ? 1 : 0)), h);
			// Cells.
			for (let r = 0; r < 20; r++) {
				const aa = AAS[r];
				const y = TRACK_H + GAP + r * ROW_H;
				if (aa === p.wt_aa) {
					ctx.fillStyle = bg;
					ctx.fillRect(x, y, Math.max(1, cw), ROW_H);
					ctx.strokeStyle = hatch;
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.moveTo(x, y + ROW_H);
					ctx.lineTo(x + Math.max(1, cw), y);
					ctx.stroke();
					continue;
				}
				const v = p.mutant_deltas[aa];
				if (v == null || !Number.isFinite(v)) continue;
				ctx.fillStyle = paint(v);
				ctx.fillRect(x, y, Math.max(1, cw), ROW_H);
			}
		}
		if (selected != null) {
			ctx.strokeStyle = ink;
			ctx.lineWidth = 1;
			ctx.strokeRect(LEFT + (selected - 1) * cw - 0.5, TRACK_H + GAP - 0.5, Math.max(2, cw) + 1, ROW_H * 20 + 1);
		}
		// Site axis: a hairline and ticks.
		const axisY = TRACK_H + GAP + ROW_H * 20;
		ctx.fillStyle = axis;
		ctx.fillRect(LEFT, axisY, width - LEFT, 1);
		ctx.fillStyle = tick;
		ctx.textBaseline = 'top';
		const step = L <= 60 ? 10 : L <= 400 ? 50 : L <= 1200 ? 100 : 250;
		for (let s = 1; s <= L; s += step) {
			const x = LEFT + (s - 1) * cw;
			ctx.fillStyle = axis;
			ctx.fillRect(x, axisY, 1, 4);
			ctx.fillStyle = tick;
			ctx.fillText(String(s), x + 3, axisY + 6);
		}
		ctx.textAlign = 'right';
		ctx.fillText('codon', width, axisY + 6);
		ctx.textAlign = 'left';
	});

	function siteAt(ev: MouseEvent): { site: number; row: number } | null {
		const rect = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		const x = ev.clientX - rect.left;
		const y = ev.clientY - rect.top;
		if (x < LEFT) return null;
		const site = Math.floor((x - LEFT) / colW) + 1;
		if (site < 1 || site > L) return null;
		const row = y >= TRACK_H + GAP ? Math.floor((y - TRACK_H - GAP) / ROW_H) : -1;
		return { site, row: row >= 20 ? -1 : row };
	}

	function onMove(ev: PointerEvent) {
		const hit = siteAt(ev);
		if (!hit) return (hover = null);
		const p = bySite.get(hit.site);
		const rect = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		let text: string;
		if (!p) text = `site ${hit.site}: not scored yet`;
		else if (hit.row < 0) text = `site ${hit.site} (${p.wt_aa}) · plasticity ${p.intrinsic_plasticity.toFixed(3)} · baseline LRT ${p.baseline_lrt.toFixed(2)}`;
		else {
			const aa = AAS[hit.row];
			text = aa === p.wt_aa ? `site ${hit.site}: ${aa} is the wild type` : `site ${hit.site} ${p.wt_aa}→${aa} · ΔLRT ${(p.mutant_deltas[aa] ?? NaN).toFixed(3)}`;
		}
		hover = { x: ev.clientX - rect.left, y: ev.clientY - rect.top, text };
	}
	function onClick(ev: MouseEvent) {
		const hit = siteAt(ev);
		if (hit && bySite.has(hit.site)) onSelect?.(hit.site);
	}
</script>

<div class="heat" bind:this={wrap}>
	<figure>
		<canvas
			bind:this={canvas}
			aria-label="Digital DMS heatmap: 20 residues by {L} sites, {plasticity.length} sites scored"
			onpointermove={onMove}
			onpointerleave={() => (hover = null)}
			onclick={onClick}
		></canvas>
		{#if hover}
			<div class="tip" style="left: {Math.min(hover.x + 12, width - 260)}px; top: {hover.y + 14}px">{hover.text}</div>
		{/if}
		<figcaption>
			<b>Digital deep mutational scan.</b>
			<span class="legend" aria-label="colour scale from −{limit.toFixed(2)} to +{limit.toFixed(2)}">
				<span class="num">−{limit.toFixed(2)}</span>
				<span class="ramp">
					{#each STEPS as t (t)}<span class="step" style="background: {ramp(t)}"></span>{/each}
				</span>
				<span class="num">+{limit.toFixed(2)}</span>
			</span>
			ΔLRT = mutant − baseline for each of the 19 substitutions at every swept site, purple above zero
			and grey below; the 98th percentile of |Δ| sets the scale. The hatched cell is the wild type, the
			track above is intrinsic plasticity, and columns not yet swept are blank. Click a site for its 19 deltas.
		</figcaption>
	</figure>
</div>

<style>
	.heat {
		position: relative;
		width: 100%;
	}
	figure {
		margin: 0;
		position: relative;
	}
	canvas {
		display: block;
		width: 100%;
		cursor: crosshair;
	}
	.tip {
		position: absolute;
		pointer-events: none;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--rule);
		font-size: var(--text-md);
		padding: 0.25rem 0.5rem;
		white-space: nowrap;
		z-index: 2;
	}
	figcaption {
		margin: var(--space-2) 0 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin-right: var(--space-1);
		font-size: var(--text-sm);
		vertical-align: -0.1em;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.ramp {
		display: inline-flex;
		border: 1px solid var(--hair);
	}
	.step {
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
	}
</style>
