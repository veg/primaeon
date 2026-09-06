<!--
	PhenotypePlot.svelte — the phenotype association plots: a picker, the Observable Plot SVG, and
	the reading of the chosen plot as its caption.

	WHY THIS FILE EXISTS. The same shape as RankedSitesPlot.svelte, for the same reasons: the plot
	specs are pure functions in phenotypePlots.ts (testable, and the place the reading of each plot
	is written down), this component owns only the container, the width and the redraw. Its rules
	are that file's too — nothing await inside the render, the container bound before the effect
	runs, and a redraw when the colour scheme changes (OS preference or `data-theme`) because the
	colours come from CSS tokens.

	COLOUR (DESIGN.md §3 "Phenotype plot and panel"). Two plot colours: called sites (q ≤ α, ρ > 0)
	in --plot-called, the rest in --plot-uncalled. A site whose q is small but whose ρ is negative
	is a finding about the background, not a call; it takes the muted grey, a shade darker than the
	uncalled grey and never a hue, and its class is printed in the tooltip. The selected option's
	description is the figure caption, so the picture is never without its reading.
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
	const current = $derived(options.find((o) => o.kind === kind));

	function render() {
		if (!container) return;
		container.innerHTML = '';
		if (sites.length === 0) return;
		const ctx = {
			called: token('--plot-called', container) || token('--brand', container),
			negative: token('--text-muted', container),
			neutral: token('--plot-uncalled', container) || token('--text-faint', container),
			gridColour: token('--plot-axis', container) || token('--text-faint', container),
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
		const mo = new MutationObserver(onScheme);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onScheme);
			mo.disconnect();
		};
	});
</script>

<div class="plot">
	<div class="plot__bar">
		<label>
			<span>Plot</span>
			<select bind:value={kind}>
				{#each options as option (option.kind)}
					<option value={option.kind}>{option.label}</option>
				{/each}
			</select>
		</label>
	</div>
	{#if sites.length === 0}
		<p class="plot__empty">No codon could be scored: every attribution row was empty, or no site had enough sequenced taxa.</p>
	{/if}
	<figure class="plot__figure">
		<div class="plot__canvas" bind:this={container}></div>
		{#if sites.length > 0 && current}
			<figcaption>
				<b>{current.label}.</b>
				{current.description}
				{#if kind !== 'pars'}
					Purple marks the sites at q ≤ {alpha} whose ρ is positive; dark grey marks a small q with a negative
					ρ, a finding about the background; light grey is everything else. Hover a stem for its numbers.
				{:else}
					Purple marks the called sites. Hover a point for its numbers.
				{/if}
			</figcaption>
		{/if}
	</figure>
</div>

<style>
	.plot {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.plot__bar {
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
		font: inherit;
		font-size: var(--text-md);
		color: var(--text);
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--rule);
		border-radius: 0;
		background: var(--bg);
	}
	select:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.plot__empty {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.plot__figure {
		margin: 0;
	}
	.plot__canvas {
		width: 100%;
		overflow-x: auto;
	}
	.plot__canvas :global(svg) {
		font-family: var(--font-text);
		font-size: var(--text-xs);
		color: var(--plot-tick);
		background: transparent;
	}
	/* The caption carries the encoding; Plot's own swatch legend and grid are not drawn. */
	.plot__canvas :global(figure > :not(svg)) {
		display: none;
	}
	.plot__canvas :global([aria-label='x-grid']),
	.plot__canvas :global([aria-label='y-grid']) {
		display: none;
	}
	.plot__canvas :global([aria-label='x-axis tick']),
	.plot__canvas :global([aria-label='y-axis tick']) {
		stroke: var(--plot-axis);
	}
	.plot__canvas :global([aria-label='x-axis tick label']),
	.plot__canvas :global([aria-label='y-axis tick label']),
	.plot__canvas :global([aria-label='x-axis label']),
	.plot__canvas :global([aria-label='y-axis label']) {
		fill: var(--plot-tick);
	}
	.plot__canvas :global([aria-label='tip']) {
		fill: var(--bg);
		stroke: var(--rule);
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
</style>
