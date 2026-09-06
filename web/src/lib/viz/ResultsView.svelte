<!--
	ResultsView.svelte — the site-selection results page, from a MemeRecord.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/results/[local-id], /jobs/[id] — same results component";
	§4.5 lists what that component shows for `meme`. This is the composition: the summary tiles,
	the call-mode control that drives every call on the page, the Manhattan canvas with entropy
	overlays, the ranked-sites Observable Plot, the site table, the filter and attribution panels
	when the run had them, the provenance panel with downloads and the MCP snippet, and the site
	tree modal any site can open. The record's source (IndexedDB, gallery, server) is the route's
	concern; this component only ever sees a MemeRecord. The report (lib/report/ReportView.svelte)
	has since taken over the routes; this view keeps the Phase 1 composition for a bare record.

	Per-site compositions (entropy, spark bars) exist only when the record carries the selected
	taxa's sequences (`record.alignment`); without them the overlays and the composition column are
	absent and a note says why, rather than the plot pretending the entropy is zero.

	Set per DESIGN.md §3: no cards, numbered sections by CSS counter, a segmented call-mode control
	whose pressed item carries a 2 px underline, and the "what the model was given" caveats as one
	warning (orange square, lead phrase in the warning colour) rather than a tinted panel.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { MemeRecord } from '$lib/results/types';
	import { attributionMap, callModeOptions, defaultCallMode, deriveRows, type CallMode } from '$lib/results/derive';
	import { siteCompositions, type SiteComposition } from '$lib/results/entropy';
	import SummaryTiles from './SummaryTiles.svelte';
	import ManhattanPlot from './ManhattanPlot.svelte';
	import RankedSitesPlot from './RankedSitesPlot.svelte';
	import SiteTable from './SiteTable.svelte';
	import SiteTreeModal from './SiteTreeModal.svelte';
	import ProvenancePanel from './ProvenancePanel.svelte';
	import FilterPanel from './FilterPanel.svelte';
	import AttributionPanel from './AttributionPanel.svelte';

	interface Props {
		record: MemeRecord;
	}
	let { record }: Props = $props();

	const modes = $derived(callModeOptions(record));
	let mode = $state<CallMode>(untrack(() => defaultCallMode(record)));
	$effect(() => {
		// A record stored under a mode this build cannot show falls to the first available.
		if (!modes.some((m) => m.id === mode)) mode = modes[0].id;
	});
	const modeOption = $derived(modes.find((m) => m.id === mode) ?? modes[0]);
	const rows = $derived(deriveRows(record, mode));
	const compositions = $derived.by((): SiteComposition[] | null => {
		const a = record.alignment;
		if (!a || a.sequences.length === 0) return null;
		return siteCompositions(a.sequences, record.sites.length);
	});
	const compositionMap = $derived(compositions ? new Map(compositions.map((c) => [c.site, c])) : null);
	const attributions = $derived(attributionMap(record));
	const hasAttribution = $derived(attributions.size > 0);
	const summary = $derived(record.summary);

	let openSite = $state<number | null>(null);
	const openRow = $derived(openSite == null ? null : (rows.find((r) => r.site === openSite) ?? null));

	function select(site: number) {
		openSite = site;
	}

	// DM3's AxomemeResults "what the model was given" caveats, worth interrupting the reader for.
	const caveats = $derived.by(() => {
		const out: string[] = [];
		if (summary.matchedFromTree === false)
			out.push(
				'No sequence name matched a tree label, so the tree contributed nothing: every pair of sequences was treated as equally related and these rankings come from the alignment alone.'
			);
		if (summary.speciesUsed !== summary.speciesInAlignment)
			out.push(
				`${summary.speciesUsed} of ${summary.speciesInAlignment} sequences were used; the rest were not in the tree${summary.speciesUsed === 512 ? ', or fell outside the 512-taxon cap' : ''}.`
			);
		if ((summary.duplicateSelections ?? 0) > 0)
			out.push(`${summary.duplicateSelections} taxon slots repeated the same sequence, which happens when a tree carries no usable branch lengths.`);
		if ((summary.mostNegativeDistance ?? 0) < -0.001)
			out.push(`The tree contains negative branch lengths (most negative pairwise distance ${summary.mostNegativeDistance!.toFixed(4)}); those distances were treated as zero.`);
		for (const w of summary.treeWarnings ?? []) out.push(w);
		return out;
	});
</script>

<div class="results">
	<header class="head">
		<p class="eyebrow">Site selection · <code>hyphaeon meme</code>, surrogate for {record.surrogate_for}</p>
		<h1>{record.name ?? 'Results'}</h1>
		<p class="lede">
			A neural model ranks the sites of this alignment by how MEME-like their signal looks; MEME was not
			run. The predicted LRT orders sites <em>within this alignment</em> and is not calibrated to MEME's
			scale; the p and q columns are that LRT pushed through MEME's mixture null and are conservative.
		</p>
	</header>

	{#if caveats.length}
		<aside class="caveats" aria-label="What the model was given">
			<strong>What the model was given.</strong>
			<ul>{#each caveats as c, i (i)}<li>{c}</li>{/each}</ul>
		</aside>
	{/if}

	<SummaryTiles {record} {rows} modeLabel={modeOption.label} />

	<section class="section">
		<div class="section__head">
			<h2>Calls</h2>
			<div class="modes" role="radiogroup" aria-label="Call mode">
				{#each modes as m (m.id)}
					<button
						type="button"
						role="radio"
						aria-checked={mode === m.id}
						class:active={mode === m.id}
						onclick={() => (mode = m.id)}
					>
						{m.label}
					</button>
				{/each}
			</div>
		</div>
		<p class="mode-description">
			<strong>{modeOption.tier1}</strong> is tier 1, <strong>{modeOption.tier2}</strong> tier 2. {modeOption.description}
		</p>
	</section>

	<section class="section">
		<div class="section__head"><h2>Along the sequence</h2></div>
		{#if !compositions}
			<p class="note">This record does not carry the aligned sequences, so the entropy overlays are not available.</p>
		{/if}
		<ManhattanPlot {rows} {compositions} onSelect={select} />
	</section>

	<section class="section">
		<div class="section__head"><h2>Ranked sites</h2></div>
		<RankedSitesPlot {rows} />
	</section>

	<section class="section">
		<div class="section__head"><h2>Sites</h2></div>
		<SiteTable {rows} compositions={compositionMap} {hasAttribution} onSelect={select} />
	</section>

	{#if record.filter}
		<section class="section">
			<div class="section__head"><h2>Artefact filter</h2></div>
			<FilterPanel {record} filter={record.filter} />
		</section>
	{/if}

	{#if hasAttribution}
		<section class="section">
			<div class="section__head"><h2>Attribution</h2></div>
			<AttributionPanel {attributions} onSelect={select} />
		</section>
	{/if}

	<section class="section">
		<div class="section__head"><h2>Provenance</h2></div>
		<ProvenancePanel {record} />
	</section>
</div>

{#if openRow}
	<SiteTreeModal {record} row={openRow} composition={compositionMap?.get(openRow.site) ?? null} onClose={() => (openSite = null)} />
{/if}

<style>
	.results {
		display: flex;
		flex-direction: column;
		gap: var(--space-8);
		counter-reset: section figure table;
	}
	.head {
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--text);
	}
	.head .eyebrow {
		margin: 0 0 var(--space-2);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.head .eyebrow code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		background: none;
		padding: 0;
	}
	.head h1 {
		margin: 0 0 var(--space-3);
		font-size: var(--text-xl);
		font-weight: 700;
		line-height: var(--leading-tight);
		overflow-wrap: anywhere;
	}
	.lede {
		max-width: var(--measure);
		color: var(--text-muted);
		margin: 0;
	}
	.caveats {
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.caveats strong {
		color: var(--warn);
		font-weight: 700;
	}
	.caveats strong::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--warn-mark);
		margin-right: 0.45em;
		vertical-align: 0.05em;
	}
	.caveats ul {
		margin: var(--space-1) 0 0;
		padding-left: 1.2rem;
	}
	.section {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		position: relative;
		padding-left: 2.5rem;
	}
	.section__head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--rule);
	}
	.section__head h2 {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: var(--leading-tight);
	}
	.section__head h2::before {
		counter-increment: section;
		content: counter(section);
		position: absolute;
		left: 0;
		color: var(--text-muted);
		font-weight: 400;
	}
	.modes {
		display: inline-flex;
		border: 1px solid var(--rule);
	}
	.modes button {
		height: 32px;
		padding: 0 0.75rem;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		font-size: var(--text-md);
		color: var(--text-muted);
		cursor: pointer;
	}
	.modes button.active {
		color: var(--text);
		border-bottom-color: var(--text);
	}
	.modes button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.mode-description {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.mode-description strong {
		color: var(--text);
		font-weight: 700;
	}
	.note {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	@media (max-width: 640px) {
		.section {
			padding-left: 0;
		}
		.section__head h2::before {
			position: static;
			margin-right: 0.5em;
		}
	}
</style>
