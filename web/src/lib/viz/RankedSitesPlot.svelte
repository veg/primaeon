<!--
	RankedSitesPlot.svelte — the Observable Plot views of the scored sites, with a picker.

	WHY THIS FILE EXISTS. The plot half of DM3's AxomemeVisualization (hyphy-scope/src/lib/
	AxomemeVisualization.svelte, the `renderPlot` block): a select over the available plot options,
	the option's description under it, and the SVG Plot appended into a container. Colours come
	from the app's tokens (theme.ts) and the plot follows the container's width.

	NOTHING IN renderPlot AWAITS, for the reason the original documents: it runs from an effect, and
	an `await tick()` inside it re-entered the effect without bound and killed the renderer. The
	container is bound before the effect runs, and the guard covers the case where it is not.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { SiteRow } from '$lib/results/derive';
	import { NEUTRAL_CALL } from '$lib/results/derive';
	import { createPlot, getPlotDescription, getPlotOptions, scoredRows } from './rankedPlots';
	import { tierPalette, token } from './theme';

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

	function renderPlot() {
		if (!container) return;
		container.innerHTML = '';
		if (scoredCount === 0) return;
		try {
			container.appendChild(
				createPlot(plotType, rows, {
					palette: tierPalette(container),
					neutralLabel: NEUTRAL_CALL,
					gridColour: token('--border', container),
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
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onScheme = () => renderPlot();
		mq.addEventListener('change', onScheme);
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onScheme);
		};
	});
</script>

<div class="ranked">
	<div class="ranked__bar">
		<label>
			Plot
			<select bind:value={plotType}>
				{#each options as option (option.label)}
					<option value={option.label}>{option.label}</option>
				{/each}
			</select>
		</label>
		<p class="ranked__description">{description}</p>
	</div>
	{#if scoredCount === 0}
		<p class="ranked__empty">No scored sites: every site is invariable, so there is nothing to rank.</p>
	{/if}
	<div class="ranked__plot" bind:this={container}></div>
</div>

<style>
	.ranked {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.ranked__bar {
		display: flex;
		align-items: flex-start;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
	}
	select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.ranked__description {
		margin: 0;
		flex: 1 1 20rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.ranked__empty {
		color: var(--text-faint);
		font-style: italic;
	}
	.ranked__plot {
		width: 100%;
		overflow-x: auto;
	}
	.ranked__plot :global(svg) {
		font-family: var(--font-text);
		color: var(--text);
		background: transparent;
	}
	.ranked__plot :global([aria-label='tip']) {
		fill: var(--surface);
	}
</style>
