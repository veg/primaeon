<!--
	PhenotypePlot.svelte — the phenotype association plots: a picker, the description of what is
	being shown, and the Observable Plot SVG.

	WHY THIS FILE EXISTS. The same shape as RankedSitesPlot.svelte, for the same reasons: the plot
	specs are pure functions in phenotypePlots.ts (testable, and the place the reading of each plot
	is written down), this component owns only the container, the width and the redraw. Its rules
	are that file's too — nothing await inside the render, the container bound before the effect
	runs, and a redraw when the colour scheme changes because the colours come from CSS tokens.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { PhenotypeSiteRecord } from '$lib/report/types';
	import { PHENOTYPE_PLOTS, createParsPlot, createPhenotypePlot, type PhenotypePlotKind } from './phenotypePlots';
	import { token } from './theme';

	interface Props {
		sites: PhenotypeSiteRecord[];
		alpha: number;
		codonCount: number;
	}
	let { sites, alpha, codonCount }: Props = $props();

	type Kind = PhenotypePlotKind | 'pars';
	let kind = $state<Kind>('association');
	let container = $state<HTMLDivElement | null>(null);
	let width = $state(800);

	const options = $derived([
		...PHENOTYPE_PLOTS.map((o) => ({ kind: o.kind as Kind, label: o.label, description: o.description })),
		{
			kind: 'pars' as Kind,
			label: 'Foreground vs background residue',
			description:
				'The derived residue’s frequency in the two groups at every scored codon. Points above the diagonal carry it more often in the foreground; the PARS signature is the strongest of them.'
		}
	]);
	const description = $derived(options.find((o) => o.kind === kind)?.description ?? '');

	function render() {
		if (!container) return;
		container.innerHTML = '';
		if (sites.length === 0) return;
		const ctx = {
			called: token('--tier-strong', container),
			negative: token('--brand', container),
			neutral: token('--tier-none', container),
			gridColour: token('--border', container),
			width: Math.max(320, width),
			alpha,
			codonCount
		};
		try {
			const plot = kind === 'pars' ? createParsPlot(sites, ctx) : createPhenotypePlot(kind, sites, ctx);
			container.appendChild(plot as unknown as Node);
		} catch (e) {
			container.textContent = `Could not render this plot: ${(e as Error).message}`;
		}
	}

	$effect(() => {
		void sites;
		void kind;
		void width;
		void alpha;
		render();
	});

	onMount(() => {
		const ro = new ResizeObserver((entries) => {
			const w = Math.floor(entries[0]?.contentRect.width ?? 800);
			if (w > 0 && w !== width) width = w;
		});
		if (container) ro.observe(container);
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onScheme = () => render();
		mq.addEventListener('change', onScheme);
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onScheme);
		};
	});
</script>

<div class="plot">
	<div class="plot__bar">
		<label>
			Plot
			<select bind:value={kind}>
				{#each options as option (option.kind)}
					<option value={option.kind}>{option.label}</option>
				{/each}
			</select>
		</label>
		<p class="plot__description">{description}</p>
	</div>
	{#if sites.length === 0}
		<p class="plot__empty">No codon could be scored: every attribution row was empty, or no site had enough sequenced taxa.</p>
	{/if}
	<div class="plot__canvas" bind:this={container}></div>
</div>

<style>
	.plot {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.plot__bar {
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
	.plot__description {
		margin: 0;
		flex: 1 1 22rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.plot__empty {
		color: var(--text-faint);
		font-style: italic;
	}
	.plot__canvas {
		width: 100%;
		overflow-x: auto;
	}
	.plot__canvas :global(svg) {
		font-family: var(--font-text);
		color: var(--text);
		background: transparent;
	}
	.plot__canvas :global([aria-label='tip']) {
		fill: var(--surface);
	}
</style>
