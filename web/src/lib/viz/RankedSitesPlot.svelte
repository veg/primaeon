<!--
	RankedSitesPlot.svelte — the Observable Plot views of the scored sites, with a picker, as a
	captioned figure.

	WHY THIS FILE EXISTS. The plot half of DM3's AxomemeVisualization (hyphy-scope/src/lib/
	AxomemeVisualization.svelte, the `renderPlot` block): a select over the available plot options
	and the SVG Plot appended into a container. The selected option's description is the figure
	caption (DESIGN.md §3 "Ranked plot"), and the active call cut is drawn as a labelled dashed rule
	so the plot names the rule the table used. Colours come from the app's tokens (theme.ts) and
	the plot follows the container's width and the colour scheme.

	NOTHING IN renderPlot AWAITS, for the reason the original documents: it runs from an effect, and
	an `await tick()` inside it re-entered the effect without bound and killed the renderer. The
	container is bound before the effect runs, and the guard covers the case where it is not.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { SiteRow } from '$lib/results/derive';
	import { NEUTRAL_CALL } from '$lib/results/derive';
	import { activeCut } from './callCut';
	import { createPlot, getPlotDescription, getPlotOptions, scoredRows } from './rankedPlots';
	import { onSchemeChange, tierPalette, token } from './theme';

	interface Props {
		rows: SiteRow[];
	}
	let { rows }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let plotType = $state('Ranked sites');
	let width = $state(800);

	const options = $derived(getPlotOptions().filter((o) => o.available(rows)));
	const description = $derived(getPlotDescription(plotType));
	const scoredCount = $derived(scoredRows(rows).length);
	const cut = $derived(activeCut(rows));
	const caption = $derived.by(() => {
		if (scoredCount === 0) return 'No scored sites: every site is invariable, so there is nothing to rank.';
		const rule = cut
			? ` The dashed rule is the active call threshold (${cut.label}).`
			: ' No site is called under the active mode, so no threshold rule is drawn.';
		return description + rule;
	});

	function renderPlot() {
		if (!container) return;
		container.innerHTML = '';
		if (scoredCount === 0) return;
		try {
			container.appendChild(
				createPlot(plotType, rows, {
					palette: tierPalette(container),
					neutralLabel: NEUTRAL_CALL,
					gridColour: token('--plot-axis', container),
					tickColour: token('--plot-tick', container),
					thresholdColour: token('--plot-threshold', container),
					fontFamily: token('--font-text', container),
					threshold: cut,
					width: Math.max(320, width)
				}) as unknown as Node
			);
		} catch (e) {
			container.textContent = `Could not render this plot: ${(e as Error).message}`;
		}
	}

	$effect(() => {
		void rows;
		void plotType;
		void width;
		renderPlot();
	});

	onMount(() => {
		const ro = new ResizeObserver((entries) => {
			const w = Math.floor(entries[0]?.contentRect.width ?? 800);
			if (w > 0 && w !== width) width = w;
		});
		if (container) ro.observe(container);
		const offScheme = onSchemeChange(renderPlot);
		return () => {
			ro.disconnect();
			offScheme();
		};
	});
</script>

<figure class="ranked">
	<div class="ranked__bar">
		<label>
			Plot
			<select bind:value={plotType}>
				{#each options as option (option.label)}
					<option value={option.label}>{option.label}</option>
				{/each}
			</select>
		</label>
	</div>
	<div class="ranked__plot" bind:this={container}></div>
	<figcaption><b>{plotType}.</b> {caption}</figcaption>
</figure>

<style>
	.ranked {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.ranked__bar {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-md);
		color: var(--text-muted);
		white-space: nowrap;
	}
	select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--rule);
		border-radius: 0;
		background: var(--bg);
		color: var(--text);
		font-size: var(--text-md);
	}
	.ranked__plot {
		width: 100%;
		overflow-x: auto;
	}
	.ranked__plot :global(svg) {
		font-family: var(--font-text);
		background: transparent;
	}
	.ranked__plot :global([aria-label='tip']) {
		fill: var(--bg);
		stroke: var(--rule);
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
</style>
