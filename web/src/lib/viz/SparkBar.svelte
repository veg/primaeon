<!--
	SparkBar.svelte — the amino-acid composition bar of one site.

	WHY THIS FILE EXISTS. axomeme3's site table drew, per row, a 60 px stacked bar of the amino
	acids present at the site (sorted by count) followed by the majority residue and its share
	(index.html renderTable, lines 4357-4382); the tree modal drew the same bar wider with a legend
	(lines 4025-4060). This is that bar as one component with a `wide` variant, so both places draw
	it from the same counts.

	The bar is GREY, not coloured by residue (DESIGN.md §4): the twenty-hue AA_COLORS ramp needed a
	legend to read and carried a third and fourth hue onto a page whose only colour means "called".
	Segments run from the majority residue in the darkest grey to the rarest in the lightest, with
	a hairline of background between them; the majority residue and its share are printed beside
	the bar, and the `title` and the wide variant's legend carry every residue letter, which is the
	information the colours needed a legend to explain.
-->
<script lang="ts">
	import { sortedComposition } from '$lib/results/entropy';

	interface Props {
		counts: ReadonlyMap<string, number>;
		total: number;
		wide?: boolean;
	}
	let { counts, total, wide = false }: Props = $props();

	const sorted = $derived(sortedComposition(counts));
	const title = $derived(
		sorted.map(([aa, n]) => `${aa}: ${n} (${((n / total) * 100).toFixed(0)}%)`).join(', ')
	);
	const shade = (i: number) => Math.min(i, 3);
</script>

{#if total > 0 && sorted.length > 0}
	<div class="spark" class:spark--wide={wide} {title}>
		<div class="bar">
			{#each sorted as [aa, n], i (aa)}
				<div class="seg seg--{shade(i)}" style:width="{(n / total) * 100}%"></div>
			{/each}
		</div>
		{#if wide}
			<div class="legend">
				{#each sorted as [aa, n], i (aa)}
					<span class="legend__item">
						<i class="seg--{shade(i)}"></i>
						<strong>{aa}</strong>
						<span>{((n / total) * 100).toFixed(0)} %</span>
					</span>
				{/each}
			</div>
		{:else}
			<span class="top">
				{sorted[0][0]}
				<span class="top__pct">{((sorted[0][1] / total) * 100).toFixed(0)} %</span>
			</span>
		{/if}
	</div>
{:else}
	<span class="none">—</span>
{/if}

<style>
	.spark {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 9rem;
	}
	.spark--wide {
		flex-direction: column;
		align-items: stretch;
		max-width: 28rem;
		gap: 0.4rem;
	}
	.bar {
		display: flex;
		gap: 1px;
		height: 8px;
		width: 60px;
		flex-shrink: 0;
	}
	.spark--wide .bar {
		width: 100%;
		height: 8px;
	}
	.seg {
		height: 100%;
	}
	.seg--0 {
		background: var(--text-faint);
	}
	.seg--1 {
		background: var(--plot-neutral);
	}
	.seg--2 {
		background: var(--rule);
	}
	.seg--3 {
		background: var(--hair);
	}
	.top {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: nowrap;
		color: var(--text);
	}
	.top__pct {
		color: var(--text-faint);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.75rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.legend__item {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.legend__item i {
		width: 0.5em;
		height: 0.5em;
		display: inline-block;
	}
	.legend__item strong {
		font-family: var(--font-mono);
		font-weight: 700;
		color: var(--text);
	}
	.none {
		color: var(--text-faint);
	}
</style>
