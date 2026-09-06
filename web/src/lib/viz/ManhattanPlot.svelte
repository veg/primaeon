<!--
	ManhattanPlot.svelte — Figure "Predicted LRT by codon site": the per-site canvas with its
	caption, the opt-in entropy overlays, a tooltip and a click.

	WHY THIS FILE EXISTS. The DOM half of axomeme3's Manhattan plot (index.html section 6): it owns
	the <canvas>, sizes it to its container at devicePixelRatio, resolves the app's colour tokens
	for manhattan.ts's draw function, hit-tests the mouse against the plotted stems, shows the
	tooltip (site, reference state, LRT, z / percentile, p / q, entropies, call) with the same
	edge-flipping placement, and reports a click as `onSelect(site)` so the page can open the site
	tree. Redraws on resize (ResizeObserver) and on a colour-scheme change (theme.ts).

	The figure is captioned below (DESIGN.md §3): what the stems are, what purple means, that
	invariable sites are left blank rather than drawn at zero, and that clicking a stem opens the
	site tree. The threshold rule is the ACTIVE call cut — the lowest LRT the mode called — derived
	from the rows so the plot explains the cut the table used, whichever mode the reader picked.

	The tooltip shows "not scored" for an invariable site instead of 0.00000: those zeros were set
	before the model was consulted (runtime/src/postprocess.js header).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { SiteRow } from '$lib/results/derive';
	import type { SiteComposition } from '$lib/results/entropy';
	import { drawManhattan, nearestPoint, type PlotColours, type PlotPoint } from './manhattan';
	import { activeCut } from './callCut';
	import { formatCount, onSchemeChange, siteLabel, token } from './theme';

	interface Props {
		rows: SiteRow[];
		compositions: SiteComposition[] | null;
		onSelect?: (site: number) => void;
		height?: number;
	}
	let { rows, compositions, onSelect, height = 260 }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let showEntropy = $state(false);
	let hovered = $state<PlotPoint | null>(null);
	let tooltipPos = $state({ left: 0, top: 0 });
	let points: PlotPoint[] = [];
	let tooltipEl = $state<HTMLDivElement | null>(null);

	const variable = $derived(rows.filter((r) => r.isVariable));
	const called = $derived(variable.filter((r) => r.tier > 0));
	const invariable = $derived(rows.length - variable.length);

	const threshold = $derived(activeCut(rows));

	const caption = $derived.by(() => {
		const parts: string[] = [];
		if (called.length === 0) {
			parts.push(
				`Grey stems are the ${formatCount(variable.length)} variable sites; none is called under the active mode, so no stem is purple and no threshold rule is drawn.`
			);
		} else {
			parts.push(
				`Grey stems are the ${formatCount(variable.length - called.length)} variable sites that were not called; purple stems mark the ${formatCount(called.length)} called ${called.length === 1 ? 'site' : 'sites'}, labelled with residue and codon number.`
			);
			if (threshold) parts.push(`The dashed rule is the active call threshold (${threshold.label}).`);
		}
		if (showEntropy && compositions)
			parts.push('The solid grey line is codon Shannon entropy and the dashed one amino-acid entropy, in bits on the right axis.');
		parts.push(
			invariable > 0
				? `Invariable sites (${formatCount(invariable)} of ${formatCount(rows.length)}) are not scored and are not drawn.`
				: 'Every site is variable, so every site is drawn.'
		);
		parts.push('Click a stem to open the site tree.');
		return parts.join(' ');
	});

	function colours(): PlotColours {
		return {
			axis: token('--plot-axis', container),
			tick: token('--plot-tick', container),
			called: token('--plot-called', container),
			uncalled: token('--plot-uncalled', container),
			threshold: token('--plot-threshold', container),
			entropy: token('--text-muted', container),
			highlight: token('--text', container)
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
			fontFamily: token('--font-text', container) || 'sans-serif',
			showEntropy: showEntropy && compositions !== null,
			threshold,
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
			// Placement as in axomeme3: right of the stem, flipped left when it would overflow.
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
		const offScheme = onSchemeChange(draw);
		draw();
		return () => {
			ro.disconnect();
			offScheme();
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

<figure class="plot">
	{#if compositions}
		<div class="toggles">
			<label class="toggle">
				<input type="checkbox" bind:checked={showEntropy} />
				Entropy overlays
			</label>
		</div>
	{/if}
	<div class="plot__canvas" bind:this={container} style:height="{height}px">
		<canvas
			bind:this={canvas}
			aria-label="Predicted LRT by codon site; click a stem to open the site tree"
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
				<div class="row"><span>Codon site</span><strong class="num">{siteLabel(r.refAa, r.site)}</strong></div>
				<div class="row">
					<span>Reference</span><span class="mono">{r.refCodon || '—'} {r.refAa || '?'}</span>
				</div>
				{#if r.isVariable}
					<div class="row"><span>Predicted LRT</span><span class="num">{fmt(r.lrt, 4)}</span></div>
					<div class="row">
						<span>z / percentile</span>
						<span class="num">{fmt(r.zScore, 2)} / {fmt(r.percentile, 1)}</span>
					</div>
					<div class="row"><span>p / q</span><span class="num">{fmt(r.p, 4)} / {fmt(r.q, 4)}</span></div>
				{:else}
					<div class="row"><span>Predicted LRT</span><span class="faint">not scored</span></div>
				{/if}
				{#if c}
					<div class="row">
						<span>Codon / AA entropy</span>
						<span class="num">{fmt(c.codonEntropy, 3)} / {fmt(c.aaEntropy, 3)} bits</span>
					</div>
				{/if}
				<div class="row row--call">
					<span>Call</span>
					<span class="call" class:call--on={r.tier > 0}>{r.tier > 0 ? r.call : r.isVariable ? '—' : 'not scored'}</span>
				</div>
				<div class="hint">Click to open the site tree</div>
			</div>
		{/if}
	</div>
	<figcaption><b>Predicted LRT by codon site.</b> {caption}</figcaption>
</figure>

<style>
	.plot {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.toggles {
		display: flex;
		gap: var(--space-4);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}
	.toggle input {
		accent-color: var(--brand);
		margin: 0;
	}
	.plot__canvas {
		position: relative;
		width: 100%;
	}
	canvas {
		display: block;
		outline: none;
	}
	canvas:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	figcaption {
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
	.tooltip {
		position: absolute;
		z-index: 2;
		pointer-events: none;
		min-width: 15rem;
		background: var(--bg);
		border: 1px solid var(--rule);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text);
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.row > span:first-child {
		color: var(--text-muted);
	}
	.row--call {
		margin-top: 0.3rem;
		border-top: 1px solid var(--hair);
		padding-top: 0.3rem;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.faint {
		color: var(--text-faint);
	}
	.call--on::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--brand);
		margin-right: 0.4em;
		vertical-align: 0.05em;
	}
	.hint {
		margin-top: 0.3rem;
		padding-top: 0.2rem;
		border-top: 1px solid var(--hair);
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
</style>
