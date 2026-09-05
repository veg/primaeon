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
-->
<script lang="ts">
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
	const ROW_H = 11;
	const TRACK_H = 44;
	const GAP = 8;
	const LEFT = 26;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let wrap = $state<HTMLDivElement | null>(null);
	let width = $state(800);
	let hover = $state<{ x: number; y: number; text: string } | null>(null);

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
	const height = TRACK_H + GAP + ROW_H * 20 + 18;
	const colW = $derived(Math.max(1, (width - LEFT) / Math.max(1, L)));

	/** Diverging blue (negative) → surface → orange (positive). */
	function color(v: number): string {
		const t = Math.max(-1, Math.min(1, v / limit));
		if (t >= 0) {
			const k = t;
			return `rgb(${Math.round(255 - (255 - 217) * k)}, ${Math.round(255 - (255 - 114) * k)}, ${Math.round(255 - (255 - 27) * k)})`;
		}
		const k = -t;
		return `rgb(${Math.round(255 - (255 - 33) * k)}, ${Math.round(255 - (255 - 102) * k)}, ${Math.round(255 - (255 - 172) * k)})`;
	}

	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) width = Math.max(320, Math.floor(e.contentRect.width));
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	$effect(() => {
		const c = canvas;
		if (!c) return;
		const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
		c.width = Math.floor(width * dpr);
		c.height = Math.floor(height * dpr);
		c.style.width = `${width}px`;
		c.style.height = `${height}px`;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const surface = token('--surface');
		const faint = token('--text-faint');
		const text = token('--text-muted');
		const accent = token('--accent');
		const brand = token('--brand');
		// Blank matrix background.
		ctx.fillStyle = token('--bg-subtle');
		ctx.fillRect(LEFT, TRACK_H + GAP, width - LEFT, ROW_H * 20);
		// Row labels.
		ctx.fillStyle = text;
		ctx.font = `9px ${token('--font-mono')}`;
		ctx.textBaseline = 'middle';
		for (let r = 0; r < 20; r++) ctx.fillText(AAS[r], 8, TRACK_H + GAP + r * ROW_H + ROW_H / 2);
		// Track axis.
		ctx.fillStyle = faint;
		ctx.fillRect(LEFT, TRACK_H - 0.5, width - LEFT, 1);
		ctx.fillText('plasticity', 0, 8);
		const cw = colW;
		for (const p of plasticity) {
			const x = LEFT + (p.site - 1) * cw;
			// Plasticity bar.
			const h = (p.intrinsic_plasticity / maxPlasticity) * (TRACK_H - 12);
			ctx.fillStyle = p.site === selected ? accent : brand;
			ctx.fillRect(x, TRACK_H - h, Math.max(1, cw - (cw > 3 ? 1 : 0)), h);
			// Cells.
			for (let r = 0; r < 20; r++) {
				const aa = AAS[r];
				const y = TRACK_H + GAP + r * ROW_H;
				if (aa === p.wt_aa) {
					ctx.fillStyle = surface;
					ctx.fillRect(x, y, Math.max(1, cw), ROW_H);
					ctx.strokeStyle = faint;
					ctx.lineWidth = 0.6;
					ctx.beginPath();
					ctx.moveTo(x, y + ROW_H);
					ctx.lineTo(x + Math.max(1, cw), y);
					ctx.stroke();
					continue;
				}
				const v = p.mutant_deltas[aa];
				if (v == null || !Number.isFinite(v)) continue;
				ctx.fillStyle = color(v);
				ctx.fillRect(x, y, Math.max(1, cw), ROW_H);
			}
		}
		if (selected != null) {
			ctx.strokeStyle = accent;
			ctx.lineWidth = 1.5;
			ctx.strokeRect(LEFT + (selected - 1) * cw - 0.5, TRACK_H + GAP - 0.5, Math.max(2, cw) + 1, ROW_H * 20 + 1);
		}
		// Site axis ticks.
		ctx.fillStyle = text;
		ctx.textBaseline = 'top';
		const step = L <= 60 ? 10 : L <= 400 ? 50 : L <= 1200 ? 100 : 250;
		for (let s = 1; s <= L; s += step) {
			const x = LEFT + (s - 1) * cw;
			ctx.fillRect(x, TRACK_H + GAP + ROW_H * 20, 1, 3);
			ctx.fillText(String(s), x + 2, TRACK_H + GAP + ROW_H * 20 + 4);
		}
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
	<div class="legend">
		<span class="swatch" style="background: {color(-limit)}"></span>−{limit.toFixed(2)}
		<span class="ramp"></span>
		<span class="swatch" style="background: {color(limit)}"></span>+{limit.toFixed(2)}
		<span class="key">ΔLRT = mutant − baseline (98th percentile of |Δ| sets the scale) · hatched = wild type · click a site for its 19 deltas</span>
	</div>
</div>

<style>
	.heat {
		position: relative;
		width: 100%;
	}
	canvas {
		display: block;
		width: 100%;
		cursor: crosshair;
		border-radius: var(--radius);
	}
	.tip {
		position: absolute;
		pointer-events: none;
		background: var(--text);
		color: var(--bg);
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
		white-space: nowrap;
		z-index: 2;
	}
	.legend {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-muted);
		font-family: var(--font-mono);
		flex-wrap: wrap;
	}
	.swatch {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 2px;
	}
	.ramp {
		display: inline-block;
		width: 6rem;
		height: 0.6rem;
		border-radius: 999px;
		background: linear-gradient(to right, rgb(33, 102, 172), #fff, rgb(217, 114, 27));
	}
	.key {
		font-family: var(--font-text);
		margin-left: var(--space-2);
	}
</style>
