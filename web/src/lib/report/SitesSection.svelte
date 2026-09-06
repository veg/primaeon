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

	THE LEDE STATES THE FINDING (web/DESIGN.md §5): how many codons vary, what the active cut is,
	and which sites it called, as links to their trees. The surrogate caveat follows as a plain
	note in the same voice; a fact about the input the model was given (no name matched the tree,
	negative branch lengths) is a warning and is set as one.
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

	const LISTED = 12;
	const modeOption = $derived(modes.find((m) => m.id === mode) ?? modes[0]);
	const summary = $derived(sites.summary);
	const variable = $derived(rows.filter((r) => r.isVariable).length);
	const called = $derived(rows.filter((r) => r.tier > 0).sort((a, b) => a.site - b.site));
	const taxa = $derived(summary.speciesUsed ?? sites.alignment?.names.length ?? null);
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
	{variable.toLocaleString()} of {rows.length.toLocaleString()} codons vary{taxa ? ` across the ${taxa.toLocaleString()} taxa` : ''}; the model scores
	those and leaves the rest unscored. Calls follow the “{modeOption.label}” rule: {modeOption.tier1} is tier 1, {modeOption.tier2} tier 2.
	{#if called.length === 0}
		No site is called at this cut.
	{:else}
		{called.length === 1 ? 'Site' : 'Sites'}
		{#each called.slice(0, LISTED) as r, i (r.site)}{i === 0 ? '' : i === called.length - 1 ? ' and ' : ', '}<button type="button" class="sitelink" onclick={() => onSelect(r.site)}>{r.refAa}{r.site}</button>{/each}{called.length > LISTED ? ` and ${(called.length - LISTED).toLocaleString()} more` : ''}
		{called.length === 1 ? 'is' : 'are'} called.
	{/if}
</p>

<p class="note">
	The predicted LRT ranks the sites of this alignment by how MEME-like their signal looks; MEME was not run. It orders
	sites within this alignment and is not calibrated to MEME's scale; p and q are that LRT pushed through MEME's mixture
	null and are conservative.
</p>

{#each caveats as c, i (i)}
	<p class="note note--warn"><strong>What the model was given.</strong> {c}</p>
{/each}

<div class="modes-row">
	<div class="modes" role="radiogroup" aria-label="Call mode">
		{#each modes as m (m.id)}
			<button type="button" role="radio" aria-checked={mode === m.id} class:active={mode === m.id} onclick={() => onMode(m.id)}>{m.label}</button>
		{/each}
	</div>
	<p class="note mode-description">{modeOption.description}</p>
</div>

{#if !compositions}
	<p class="note">This record does not carry the aligned sequences, so the entropy overlays are not available.</p>
{/if}
<ManhattanPlot {rows} {compositions} {onSelect} />

<RankedSitesPlot {rows} />

<SiteTable {rows} compositions={compositionMap} {hasAttribution} {onSelect} />

<style>
	.lede,
	.note {
		margin: 0;
	}
	.sitelink {
		all: unset;
		cursor: pointer;
		color: var(--brand);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
	}
	.sitelink:hover {
		text-decoration-thickness: 2px;
	}
	.sitelink:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.modes-row {
		display: flex;
		gap: var(--space-4);
		align-items: flex-start;
		flex-wrap: wrap;
	}
	.modes {
		display: inline-flex;
		border: 1px solid var(--rule);
		height: 2rem;
		flex: none;
	}
	.modes button {
		border: 0;
		background: transparent;
		padding: 0 0.8rem;
		font-size: var(--text-md);
		color: var(--text-muted);
		cursor: pointer;
		position: relative;
	}
	.modes button + button {
		border-left: 1px solid var(--rule);
	}
	.modes button.active {
		color: var(--text);
	}
	.modes button.active::after {
		content: '';
		position: absolute;
		left: 0.8rem;
		right: 0.8rem;
		bottom: 0.3rem;
		height: 2px;
		background: var(--text);
	}
	.mode-description {
		flex: 1 1 20rem;
		font-size: var(--text-sm);
	}
</style>
