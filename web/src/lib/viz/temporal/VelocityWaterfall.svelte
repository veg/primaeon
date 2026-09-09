<!--
	VelocityWaterfall.svelte — Panel B: the positive sweep-velocity waterfall v_s(t) on canvas.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the engine guide's Panel B — a heatmap of v_s(t) over
	every sweep site, rows sorted chronologically by peak-velocity epoch, so coordinated horizontal
	bands mark substitutions that swept in the same window. Drawn on canvas for the same reason
	DmsHeatmap is (a rect per cell would be the slowest thing on the page); the ramp is white → brand
	purple (velocity is non-negative, so a sequential ramp, not the DMS diverging one), read from
	tokens at draw time and redrawn on a scheme change. Rows labelled by mutation; the x axis is
	calendar year shared with the trajectory panel.
-->
<script lang="ts">
	import { interpolateRgb } from 'd3';
	import type { TemporalCurve } from '$lib/temporal/types';
	import { token } from '../theme';

	interface Props {
		curves: TemporalCurve[];
	}
	let { curves }: Props = $props();

	const ROW_H = 16;
	const LEFT = 62;
	const AXIS_H = 22;
	const TOP = 6;

	let wrap = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(760);
	let scheme = $state(0);
	let hover = $state<{ x: number; y: number; text: string } | null>(null);

	// Rows sorted by peak-velocity time. Each row: label + {t[], v[]} + peak time + max v.
	const rows = $derived.by(() => {
		const out = curves.map((c) => {
			let peakT = c.t[0] ?? 0;
			let maxV = 0;
			for (let i = 0; i < c.t.length; i++) {
				const v = c.v[i];
				if (v !== null && v > maxV) {
					maxV = v;
					peakT = c.t[i];
				}
			}
			return { label: c.mutation_label, t: c.t, v: c.v, peakT, maxV };
		});
		out.sort((a, b) => a.peakT - b.peakT);
		return out;
	});
	const tMin = $derived(Math.min(...curves.flatMap((c) => c.t)));
	const tMax = $derived(Math.max(...curves.flatMap((c) => c.t)));
	const vMax = $derived(Math.max(1e-9, ...rows.map((r) => r.maxV)));
	const height = $derived(TOP + rows.length * ROW_H + AXIS_H);

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
		void rows;
		void width;
		const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
		c.width = Math.floor(width * dpr);
		c.height = Math.floor(height * dpr);
		c.style.width = `${width}px`;
		c.style.height = `${height}px`;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const zero = token('--dms-zero') || '#ffffff';
		const hot = token('--dms-positive') || token('--brand') || '#5b3fa0';
		const tick = token('--plot-tick') || token('--text-muted');
		const axis = token('--plot-axis') || token('--text-faint');
		const font = token('--font-text');
		const ramp = interpolateRgb(zero, hot);
		const plotW = width - LEFT;
		const span = Math.max(1e-9, tMax - tMin);

		// Cells: for each row, draw a segment per timepoint spanning to the next timepoint.
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			const y = TOP + r * ROW_H;
			for (let i = 0; i < row.t.length; i++) {
				const v = row.v[i];
				if (v === null) continue;
				const x0 = LEFT + ((row.t[i] - tMin) / span) * plotW;
				const x1 =
					i + 1 < row.t.length ? LEFT + ((row.t[i + 1] - tMin) / span) * plotW : LEFT + plotW;
				ctx.fillStyle = ramp(Math.min(1, Math.max(0, v / vMax)));
				ctx.fillRect(x0, y, Math.max(1, x1 - x0), ROW_H - 1);
			}
			// Row label.
			ctx.fillStyle = tick;
			ctx.font = `11px ${font}`;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'right';
			ctx.fillText(row.label, LEFT - 6, y + ROW_H / 2);
			ctx.textAlign = 'left';
		}

		// X axis: year ticks.
		ctx.strokeStyle = axis;
		ctx.fillStyle = tick;
		ctx.font = `11px ${font}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		const yAxis = TOP + rows.length * ROW_H;
		ctx.beginPath();
		ctx.moveTo(LEFT, yAxis + 0.5);
		ctx.lineTo(LEFT + plotW, yAxis + 0.5);
		ctx.stroke();
		for (let yr = Math.ceil(tMin); yr <= Math.floor(tMax); yr++) {
			const x = LEFT + ((yr - tMin) / span) * plotW;
			ctx.beginPath();
			ctx.moveTo(x, yAxis);
			ctx.lineTo(x, yAxis + 4);
			ctx.stroke();
			ctx.fillText(String(yr), x, yAxis + 6);
		}
	});

	function onMove(ev: MouseEvent) {
		if (!rows.length) return;
		const rect = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		const x = ev.clientX - rect.left;
		const y = ev.clientY - rect.top;
		const r = Math.floor((y - TOP) / ROW_H);
		if (r < 0 || r >= rows.length || x < LEFT) {
			hover = null;
			return;
		}
		const span = Math.max(1e-9, tMax - tMin);
		const t = tMin + ((x - LEFT) / (width - LEFT)) * span;
		const row = rows[r];
		let best = 0;
		let bestI = 0;
		for (let i = 0; i < row.t.length; i++) {
			if (Math.abs(row.t[i] - t) < Math.abs(row.t[bestI] - t)) bestI = i;
		}
		best = row.v[bestI] ?? 0;
		hover = { x, y, text: `${row.label} · ${row.t[bestI].toFixed(2)} · v ${best.toExponential(2)}` };
	}
</script>

<div class="waterfall" bind:this={wrap}>
	<canvas
		bind:this={canvas}
		onmousemove={onMove}
		onmouseleave={() => (hover = null)}
		aria-label="Sweep-velocity waterfall: rows are sweep sites sorted by peak-velocity year, colour is positive velocity"
	></canvas>
	{#if hover}
		<div class="tip" style="left: {hover.x + 8}px; top: {hover.y + 8}px">{hover.text}</div>
	{/if}
</div>

<style>
	.waterfall {
		position: relative;
		width: 100%;
	}
	.tip {
		position: absolute;
		pointer-events: none;
		background: var(--bg);
		border: 1px solid var(--rule);
		padding: 0.15rem 0.4rem;
		font-size: var(--text-md);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
</style>
