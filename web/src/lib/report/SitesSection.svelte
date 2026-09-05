<!--
	SitesSection.svelte — the Sites section of the report: the Phase 1 site-selection view (call-mode
	toggle, Manhattan with entropy overlays, ranked plot, table, site tree modal) over the `sites`
	section, with the row derivation owned by the parent so the overview strip counts the same
	calls.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "meme": every element Phase 1's ResultsView composed, minus
	its page heading and provenance panel, which the report now owns. The call mode is app-side
	state the reader switches; the rows for the active mode are derived in ReportView.svelte and
	passed down because two components read them (this section and OverviewStrip). The modal opens
	from this section, the epistasis network and the DMS heatmap alike, so `openSite` is also the
	parent's.
-->
<script lang="ts">
	import type { SitesSection } from '$lib/report/types';
	import type { CallMode, CallModeOption, SiteRow } from '$lib/results/derive';
	import type { SiteComposition } from '$lib/results/entropy';
	import ManhattanPlot from '$lib/viz/ManhattanPlot.svelte';
	import RankedSitesPlot from '$lib/viz/RankedSitesPlot.svelte';
	import SiteTable from '$lib/viz/SiteTable.svelte';

	interface Props {
		sites: SitesSection;
		rows: SiteRow[];
		modes: CallModeOption[];
		mode: CallMode;
		onMode: (m: CallMode) => void;
		compositions: SiteComposition[] | null;
		compositionMap: Map<number, SiteComposition> | null;
		hasAttribution: boolean;
		onSelect: (site: number) => void;
	}
	let { sites, rows, modes, mode, onMode, compositions, compositionMap, hasAttribution, onSelect }: Props = $props();

	const modeOption = $derived(modes.find((m) => m.id === mode) ?? modes[0]);
	const summary = $derived(sites.summary);
	const caveats = $derived.by(() => {
		const out: string[] = [];
		if (summary.matchedFromTree === false)
			out.push('No sequence name matched a tree label, so the tree contributed nothing: every pair of sequences was treated as equally related and these rankings come from the alignment alone.');
		if ((summary.duplicateSelections ?? 0) > 0)
			out.push(`${summary.duplicateSelections} taxon slots repeated the same sequence, which happens when a tree carries no usable branch lengths.`);
		if ((summary.mostNegativeDistance ?? 0) < -0.001)
			out.push(`The tree contains negative branch lengths (most negative pairwise distance ${summary.mostNegativeDistance!.toFixed(4)}); those distances were treated as zero.`);
		for (const w of summary.treeWarnings ?? []) out.push(w);
		return out;
	});
</script>

<p class="lede">
	The model ranks the sites of this alignment by how MEME-like their signal looks; MEME was not run.
	The predicted LRT orders sites <em>within this alignment</em> and is not calibrated to MEME's
	scale; p and q are that LRT pushed through MEME's mixture null and are conservative.
</p>

{#if caveats.length}
	<aside class="caveats" aria-label="What the model was given">
		<strong>What the model was given</strong>
		<ul>{#each caveats as c, i (i)}<li>{c}</li>{/each}</ul>
	</aside>
{/if}

<div class="modes-row">
	<div class="modes" role="radiogroup" aria-label="Call mode">
		{#each modes as m (m.id)}
			<button type="button" role="radio" aria-checked={mode === m.id} class:active={mode === m.id} onclick={() => onMode(m.id)}>{m.label}</button>
		{/each}
	</div>
	<p class="mode-description"><strong>{modeOption.tier1}</strong> is tier 1, <strong>{modeOption.tier2}</strong> tier 2. {modeOption.description}</p>
</div>

<h3>Along the sequence</h3>
{#if !compositions}
	<p class="note">This record does not carry the aligned sequences, so the entropy overlays are not available.</p>
{/if}
<ManhattanPlot {rows} {compositions} {onSelect} />

<h3>Ranked sites</h3>
<RankedSitesPlot {rows} />

<h3>Site table</h3>
<SiteTable {rows} compositions={compositionMap} {hasAttribution} {onSelect} />

<style>
	.lede {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
		max-width: var(--container-narrow);
	}
	.caveats {
		border: 1px solid var(--warn);
		background: var(--warn-soft);
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
	}
	.caveats strong {
		color: var(--warn);
	}
	.caveats ul {
		margin: var(--space-1) 0 0;
		padding-left: 1.2rem;
	}
	.modes-row {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		flex-wrap: wrap;
	}
	.modes {
		display: inline-flex;
		gap: 2px;
		background: var(--border);
		padding: 2px;
		border-radius: var(--radius);
	}
	.modes button {
		border: none;
		background: transparent;
		border-radius: 6px;
		padding: 0.35rem 0.8rem;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
	}
	.modes button.active {
		background: var(--surface);
		color: var(--brand);
		box-shadow: var(--shadow);
	}
	.mode-description {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
		flex: 1 1 20rem;
	}
	h3 {
		margin: var(--space-2) 0 0;
		font-size: var(--text-lg);
	}
	.note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-faint);
		font-style: italic;
	}
</style>
