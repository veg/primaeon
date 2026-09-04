<!--
	ManhattanPlot.svelte — the per-site canvas plot with entropy overlays, tooltip and click.

	WHY THIS FILE EXISTS. The DOM half of axomeme3's Manhattan plot (index.html section 6): it owns
	the <canvas>, sizes it to its container at devicePixelRatio, resolves the app's colour tokens
	for manhattan.ts's draw function, hit-tests the mouse against the plotted points (12 px), shows
	the tooltip axomeme3 showed (site, reference state, LRT, z / percentile, entropies, call) with
	the same edge-flipping placement, and reports a click as `onSelect(site)` so the page can open
	the site tree. Redraws on resize (ResizeObserver) and on colour-scheme change.

	The tooltip shows "not scored" for an invariable site instead of 0.00000: those zeros were set
	before the model was consulted (runtime/src/postprocess.js header).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { SiteRow } from '$lib/results/derive';
	import type { SiteComposition } from '$lib/results/entropy';
	import { drawManhattan, nearestPoint, type PlotColours, type PlotPoint } from './manhattan';
	import { token } from './theme';

	interface Props {
		rows: SiteRow[];
		compositions: SiteComposition[] | null;
		onSelect?: (site: number) => void;
		height?: number;
	}
	let { rows, compositions, onSelect, height = 360 }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let showEntropy = $state(true);
	let hovered = $state<PlotPoint | null>(null);
	let tooltipPos = $state({ left: 0, top: 0 });
	let points: PlotPoint[] = [];
	let tooltipEl = $state<HTMLDivElement | null>(null);

	function colours(): PlotColours {
		return {
			background: token('--surface', container),
			grid: token('--border', container),
			axisText: token('--text-muted', container),
			tier1: token('--tier-strong', container),
			tier2: token('--tier-moderate', container),
			variable: token('--brand', container),
			invariable: token('--tier-none', container),
			codonEntropy: token('--brand', container),
			aaEntropy: token('--ok', container),
			label: token('--text', container)
		};
	}

	function draw() {
		if (!canvas || !container) return;
		const width = container.clientWidth;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.floor(width * dpr));
		canvas.height = Math.max(1, Math.floor(height * dpr));
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		points = drawManhattan(ctx, rows, showEntropy ? compositions : null, {
			width,
			height,
			dpr,
			colours: colours(),
			fontFamily: token('--font-mono', container) || 'monospace',
			showEntropy: showEntropy && compositions !== null,
			highlight: hovered?.row.site ?? null
		});
	}

	function localPoint(e: MouseEvent): { x: number; y: number } {
		const rect = canvas!.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	function onMove(e: MouseEvent) {
		const { x, y } = localPoint(e);
		const hit = nearestPoint(points, x, y);
		if (hit?.row.site !== hovered?.row.site) {
			hovered = hit;
			draw();
		}
		if (hit && container) {
			// Placement as in axomeme3: right of the point, flipped left when it would overflow.
			const w = tooltipEl?.offsetWidth ?? 220;
			const h = tooltipEl?.offsetHeight ?? 150;
			const cw = container.clientWidth;
			const ch = container.clientHeight;
			let left = hit.x + 15;
			if (left + w > cw - 10) left = hit.x - w - 15;
			if (left < 10) left = 10;
			let top = hit.y - 10;
			if (top + h > ch - 10) top = ch - h - 10;
			if (top < 10) top = 10;
			tooltipPos = { left, top };
		}
	}

	function onLeave() {
		if (hovered) {
			hovered = null;
			draw();
		}
	}

	function onClick(e: MouseEvent) {
		const { x, y } = localPoint(e);
		const hit = nearestPoint(points, x, y);
		if (hit) onSelect?.(hit.row.site);
	}

	function onKey(e: KeyboardEvent) {
		if ((e.key === 'Enter' || e.key === ' ') && hovered) {
			e.preventDefault();
			onSelect?.(hovered.row.site);
		}
	}

	onMount(() => {
		const ro = new ResizeObserver(() => draw());
		if (container) ro.observe(container);
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onScheme = () => draw();
		mq.addEventListener('change', onScheme);
		draw();
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onScheme);
		};
	});

	$effect(() => {
		// Redraw when the data or the overlay toggle changes.
		void rows;
		void compositions;
		void showEntropy;
		draw();
	});

	const fmt = (v: number, dp: number) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
</script>

<div class="plot">
	<div class="plot__bar">
		<div class="legend" aria-label="Legend">
			<span class="legend__item"><i class="dot dot--tier1"></i> Tier 1</span>
			<span class="legend__item"><i class="dot dot--tier2"></i> Tier 2</span>
			<span class="legend__item"><i class="dot dot--variable"></i> Scored, neutral</span>
			<span class="legend__item"><i class="dot dot--invariable"></i> Not scored (invariable)</span>
			{#if compositions}
				<span class="legend__item"><i class="swatch swatch--codon"></i> Codon entropy</span>
				<span class="legend__item"><i class="swatch swatch--aa"></i> Amino-acid entropy</span>
			{/if}
		</div>
		{#if compositions}
			<label class="toggle">
				<input type="checkbox" bind:checked={showEntropy} />
				Entropy overlays
			</label>
		{/if}
	</div>
	<div class="plot__canvas" bind:this={container} style:height="{height}px">
		<canvas
			bind:this={canvas}
			aria-label="Predicted LRT by codon site; click a point to open the site tree"
			tabindex="0"
			onmousemove={onMove}
			onmouseleave={onLeave}
			onclick={onClick}
			onkeydown={onKey}
			style:cursor={hovered ? 'pointer' : 'default'}
		></canvas>
		{#if hovered}
			{@const r = hovered.row}
			{@const c = hovered.composition}
			<div
				class="tooltip"
				bind:this={tooltipEl}
				style:left="{tooltipPos.left}px"
				style:top="{tooltipPos.top}px"
				role="tooltip"
			>
				<div class="row"><span>Codon site</span><strong class="mono site">{r.site}</strong></div>
				<div class="row">
					<span>Reference</span><span class="mono">{r.refCodon || '—'} ({r.refAa || '?'})</span>
				</div>
				{#if r.isVariable}
					<div class="row"><span>Predicted LRT</span><span class="mono">{fmt(r.lrt, 5)}</span></div>
					<div class="row">
						<span>Z / percentile</span>
						<span class="mono">{fmt(r.zScore, 2)} / {fmt(r.percentile, 1)}%</span>
					</div>
					<div class="row"><span>p / q</span><span class="mono">{fmt(r.p, 4)} / {fmt(r.q, 4)}</span></div>
				{:else}
					<div class="row"><span>Predicted LRT</span><span class="muted">not scored</span></div>
				{/if}
				{#if c}
					<div class="row">
						<span>Codon / AA entropy</span>
						<span class="mono">{fmt(c.codonEntropy, 3)} / {fmt(c.aaEntropy, 3)} bits</span>
					</div>
				{/if}
				<div class="row row--call">
					<span>Call</span>
					<span class="badge badge--tier{r.tier}">{r.call}</span>
				</div>
				<div class="hint">Click to view the site tree</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.plot {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.plot__bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.legend {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.legend__item {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		display: inline-block;
	}
	.dot--tier1 {
		background: var(--tier-strong);
	}
	.dot--tier2 {
		background: var(--tier-moderate);
	}
	.dot--variable {
		background: var(--brand);
	}
	.dot--invariable {
		background: var(--tier-none);
		opacity: 0.6;
	}
	.swatch {
		width: 0.9rem;
		height: 0.5rem;
		display: inline-block;
		border-radius: 2px;
	}
	.swatch--codon {
		background: color-mix(in srgb, var(--brand) 35%, transparent);
		border-bottom: 2px solid var(--brand);
	}
	.swatch--aa {
		background: color-mix(in srgb, var(--ok) 35%, transparent);
		border-bottom: 2px solid var(--ok);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}
	.plot__canvas {
		position: relative;
		width: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--surface);
	}
	canvas {
		display: block;
		outline: none;
	}
	canvas:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus);
	}
	.tooltip {
		position: absolute;
		z-index: 2;
		pointer-events: none;
		min-width: 15rem;
		background: var(--surface-raised);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-xs);
		color: var(--text);
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 0.1rem 0;
	}
	.row > span:first-child {
		color: var(--text-muted);
	}
	.row--call {
		margin-top: 0.3rem;
		border-top: 1px solid var(--border);
		padding-top: 0.3rem;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.site {
		color: var(--brand);
	}
	.muted {
		color: var(--text-faint);
		font-style: italic;
	}
	.hint {
		margin-top: 0.3rem;
		padding-top: 0.2rem;
		border-top: 1px dotted var(--border);
		text-align: center;
		color: var(--text-faint);
		font-style: italic;
	}
	.badge {
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
		font-weight: 600;
		background: var(--bg-subtle);
		color: var(--text-muted);
	}
	.badge--tier1 {
		background: var(--danger-soft);
		color: var(--tier-strong);
	}
	.badge--tier2 {
		background: var(--accent-soft);
		color: var(--accent-strong);
	}
</style>
