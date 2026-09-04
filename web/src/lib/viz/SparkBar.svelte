<!--
	SparkBar.svelte — the amino-acid composition bar of one site.

	WHY THIS FILE EXISTS. axomeme3's site table drew, per row, a 60 px stacked bar of the amino
	acids present at the site (sorted by count, coloured by AA_COLORS) followed by the majority
	residue and its share (index.html renderTable, lines 4357-4382); the tree modal drew the same
	bar wider with a legend (lines 4025-4060). This is that bar as one component with a `wide`
	variant, so both places draw it from the same counts.
-->
<script lang="ts">
	import { aaColor, sortedComposition } from '$lib/results/entropy';

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
</script>

{#if total > 0 && sorted.length > 0}
	<div class="spark" class:spark--wide={wide} {title}>
		<div class="bar">
			{#each sorted as [aa, n] (aa)}
				<div class="seg" style:width="{(n / total) * 100}%" style:background={aaColor(aa)}></div>
			{/each}
		</div>
		{#if wide}
			<div class="legend">
				{#each sorted as [aa, n] (aa)}
					<span class="legend__item">
						<i style:background={aaColor(aa)}></i>
						<strong>{aa}</strong>
						<span>({((n / total) * 100).toFixed(0)}%)</span>
					</span>
				{/each}
			</div>
		{:else}
			<span class="top">
				{sorted[0][0]}
				<span class="top__pct">{((sorted[0][1] / total) * 100).toFixed(0)}%</span>
			</span>
		{/if}
	</div>
{:else}
	<span class="none">–</span>
{/if}

<style>
	.spark {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 8.5rem;
	}
	.spark--wide {
		flex-direction: column;
		align-items: stretch;
		max-width: 28rem;
		gap: 0.35rem;
	}
	.bar {
		display: flex;
		height: 10px;
		width: 60px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		flex-shrink: 0;
	}
	.spark--wide .bar {
		width: 100%;
		height: 8px;
		border-radius: 999px;
	}
	.seg {
		height: 100%;
	}
	.top {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
	}
	.top__pct {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.7rem;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.75rem;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.legend__item {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.legend__item i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	.legend__item strong {
		font-family: var(--font-mono);
		color: var(--text);
	}
	.none {
		color: var(--text-faint);
	}
</style>
