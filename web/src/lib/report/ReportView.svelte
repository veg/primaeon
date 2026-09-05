<!--
	ReportView.svelte — the one report: overview strip, the data strip, and the sections in PLAN.md
	§4.0's order, each rendering the moment its payload exists.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "Each section below is a section of the single report,
	rendered as soon as its analysis finishes; the page never waits for the slowest one." The
	record may be live (a `$state` proxy from lib/report/run.svelte.ts that the worker is still
	filling) or loaded from a store; this component reads it the same way either time and derives
	per-section status from lib/report/status.ts. Three pieces of app-side state live here because
	more than one section reads them: the call mode (Sites and the overview strip count the same
	calls), the open site (the tree modal opens from the Sites table, the network and the DMS
	heatmap), and the masked/unmasked toggle (the filter section flips which site rows the Sites
	section shows).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import type { ReportRecord } from '$lib/api';
	import type { LiveJob, LoadedState, ReportSource } from './load';
	import { SECTION_TITLE, allSectionStatuses, PHASE_LABEL } from './status';
	import type { FilterBlock, MemeRecord } from '$lib/results/types';
	import { attributionMap, callModeOptions, defaultCallMode, deriveRows, type CallMode } from '$lib/results/derive';
	import { siteCompositions, type SiteComposition } from '$lib/results/entropy';
	import OverviewStrip from '$lib/viz/OverviewStrip.svelte';
	import GeneCard from '$lib/viz/GeneCard.svelte';
	import AttributionPanel from '$lib/viz/AttributionPanel.svelte';
	import FilterPanel from '$lib/viz/FilterPanel.svelte';
	import SiteTreeModal from '$lib/viz/SiteTreeModal.svelte';
	import { displayTree } from './displayTree';
	import { sitesWithAlignment } from './alignmentBlock';
	import Section from './Section.svelte';
	import DataStrip from './DataStrip.svelte';
	import SitesSection from './SitesSection.svelte';
	import EpistasisSection from './EpistasisSection.svelte';
	import DmsSection from './DmsSection.svelte';
	import PhenotypeSection from './PhenotypeSection.svelte';
	import ProvenanceSection from './ProvenanceSection.svelte';
	import RerunDisclosure from './RerunDisclosure.svelte';

	interface Props {
		record: ReportRecord;
		source: ReportSource;
		runState: LoadedState;
		job: LiveJob | null;
	}
	let { record, source, runState, job }: Props = $props();

	const live = $derived(job != null);
	const running = $derived(runState === 'running');
	const statuses = $derived(allSectionStatuses(record, runState));
	const status = (name: string) => statuses.find((s) => s.name === name)!;

	// ---- sites view state ------------------------------------------------------------------------
	// The sites section WITH the taxa and sequences the model saw: stored on the section by the
	// gallery prebake and the server, derived from `inputs.alignmentText` for a browser run
	// (lib/report/alignmentBlock.ts). Every site view below reads this one, so a report the reader
	// just ran draws its site trees and entropy overlays exactly as a prebaked one does.
	const sites = $derived(sitesWithAlignment(record));
	const filter = $derived(record.sections.filter);
	let useCleaned = $state(false);
	const cleanedSites = $derived(filter?.cleaned?.sites ?? null);
	const sitesForView = $derived.by((): MemeRecord | null => {
		if (!sites) return null;
		if (useCleaned && cleanedSites) return { ...sites, sites: cleanedSites };
		return sites;
	});
	const modes = $derived(callModeOptions(sites));
	let mode = $state<CallMode>(untrack(() => defaultCallMode(record.sections.sites)));
	$effect(() => {
		if (!modes.some((m) => m.id === mode)) mode = modes[0].id;
	});
	const modeOption = $derived(modes.find((m) => m.id === mode) ?? modes[0]);
	const rows = $derived(sitesForView ? deriveRows(sitesForView, mode) : null);
	const compositions = $derived.by((): SiteComposition[] | null => {
		const a = sites?.alignment;
		if (!sites || !a || a.sequences.length === 0) return null;
		return siteCompositions(a.sequences, sites.sites.length);
	});
	const compositionMap = $derived(compositions ? new Map(compositions.map((c) => [c.site, c])) : null);
	const attributions = $derived.by(() => {
		const out = new Map<number, import('$lib/results/types').AttributionRecord>();
		const a = record.sections.attribution?.attributions;
		if (a) for (const [k, v] of Object.entries(a)) out.set(Number(k), v);
		if (sites) for (const [k, v] of attributionMap(sites)) if (!out.has(k)) out.set(k, v);
		return out;
	});
	const hasAttribution = $derived(attributions.size > 0);
	const filterBlock = $derived.by((): FilterBlock | null => {
		if (!filter) return null;
		return {
			enabled: filter.filter_enabled,
			artifacts_masked: filter.artifacts_masked ?? [],
			masked_codon_ranges_1idx_by_taxon: filter.masked_codon_ranges_1idx_by_taxon,
			raw_metrics: filter.raw_metrics,
			cleaned_metrics: filter.cleaned_metrics
		};
	});

	let openSite = $state<number | null>(null);
	const openRow = $derived(openSite == null || !rows ? null : (rows.find((r) => r.site === openSite) ?? null));
	function select(site: number) {
		openSite = site;
		if (sites && !rows?.some((r) => r.site === site)) openSite = null;
	}

	const phaseLabel = $derived(record.status.phase ? (PHASE_LABEL[record.status.phase] ?? record.status.phase) : 'starting');
	const SOURCE_LABEL: Record<ReportSource, string> = { live: 'running in this browser', local: 'stored in this browser', gallery: 'bundled example, prebaked at build', job: 'server job' };
</script>

<div class="report">
	<header class="head">
		<div>
			<p class="eyebrow">Report · {SOURCE_LABEL[source]}</p>
			<h1>{record.name}</h1>
		</div>
		{#if running}
			<div class="runbar" role="status" aria-live="polite">
				<span class="dot" aria-hidden="true"></span>
				<span class="runbar__text">{phaseLabel}{record.status.message ? ` — ${record.status.message}` : ''}</span>
				{#if record.status.total > 1}
					<progress max={record.status.total} value={record.status.done}></progress>
				{/if}
				{#if job}
					<button type="button" class="button button--secondary" onclick={() => job?.cancel()}>Cancel run</button>
				{/if}
			</div>
		{:else if runState === 'interrupted'}
			<p class="banner banner--warn">This run was interrupted before it finished; the sections below are what had completed. Re-run it from the disclosure at the foot of the page.</p>
		{:else if runState === 'failed'}
			<p class="banner banner--danger">The run failed: {record.status.error ?? 'no message'}.</p>
		{:else if runState === 'cancelled'}
			<p class="banner">The run was cancelled; the sections below are what had completed.</p>
		{/if}
	</header>

	<OverviewStrip {record} {rows} modeLabel={modeOption.label} {live} />
	<DataStrip {record} />

	<Section id="sites" title={SECTION_TITLE.sites} eyebrow="Site selection · surrogate for MEME · hyphaeon meme" status={status('sites')}>
		{#snippet actions()}
			{#if cleanedSites}
				<label class="toggle"><input type="checkbox" bind:checked={useCleaned} /> view masked (re-scored) sites</label>
			{/if}
		{/snippet}
		{#if sitesForView && rows}
			<SitesSection sites={sitesForView} {rows} {modes} {mode} onMode={(m) => (mode = m)} {compositions} {compositionMap} {hasAttribution} onSelect={select} />
		{/if}
	</Section>

	<Section id="gene" title={SECTION_TITLE.gene} eyebrow="Gene-level omnibus · surrogate for BUSTED · hyphaeon busted" status={status('gene')}>
		{#if record.sections.gene}
			<GeneCard gene={record.sections.gene} />
		{/if}
	</Section>

	<Section id="epistasis" title={SECTION_TITLE.epistasis} eyebrow="Co-selection network and sectors · hyphaeon epistasis" status={status('epistasis')}>
		{#if record.sections.epistasis}
			<EpistasisSection {record} epistasis={record.sections.epistasis} onSelect={select} />
		{/if}
	</Section>

	<Section id="attribution" title={SECTION_TITLE.attribution} eyebrow="Per-taxon counterfactual attribution on called sites · hyphaeon meme --attribute" status={status('attribution')}>
		{#if record.sections.attribution}
			{#if attributions.size}
				<AttributionPanel {attributions} onSelect={select} />
			{:else}
				<p class="note">No site reached the attribution gate (LRT ≥ 3.84), so no driver was attributed.</p>
			{/if}
		{/if}
	</Section>

	<Section id="filter" title={SECTION_TITLE.filter} eyebrow="Outlier-contamination screen · hyphaeon meme --filter" status={status('filter')}>
		{#snippet actions()}
			{#if cleanedSites}
				<label class="toggle"><input type="checkbox" bind:checked={useCleaned} /> view masked sites in the Sites section</label>
			{/if}
		{/snippet}
		{#if filter && filterBlock}
			<p class="lede">
				<strong>{filter.artifacts_masked.length}</strong> suspicious patch{filter.artifacts_masked.length === 1 ? '' : 'es'}
				{filter.artifacts_masked.length ? 'were masked to NNN and the alignment re-scored; toggle above to view the re-scored sites.' : 'found; nothing was masked and the sites shown are the baseline scores.'}
			</p>
			{#if sites}
				<FilterPanel record={sites} filter={filterBlock} />
			{/if}
		{/if}
	</Section>

	<Section id="dms" title={SECTION_TITLE.dms} eyebrow="In-silico saturation scan · hyphaeon dms" status={status('dms')}>
		{#if record.sections.dms}
			<DmsSection {record} dms={record.sections.dms} running={running && record.status.phase === 'dms'} onCancel={job ? () => job?.cancelDms() : null} onSelect={select} />
		{/if}
	</Section>

	<Section id="phenotype" title={SECTION_TITLE.phenotype} eyebrow="PhyloWAS · hyphaeon phenotype · on demand" status={status('phenotype')}>
		<PhenotypeSection {record} {base} owned={source === 'live' || source === 'local'} onSelect={select} />
	</Section>

	<Section id="provenance" title="Data and provenance" eyebrow="What produced these numbers, and how to get them again" status={{ name: 'phenotype', state: 'done', phase: null, reason: null }}>
		<ProvenanceSection {record} />
	</Section>

	<RerunDisclosure {record} />
</div>

{#if openRow && sitesForView}
	<SiteTreeModal
		record={sitesForView}
		row={openRow}
		composition={compositionMap?.get(openRow.site) ?? null}
		tree={displayTree(record)}
		onClose={() => (openSite = null)}
	/>
{/if}

<style>
	.report {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.head h1 {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.runbar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		border: 1px solid var(--brand);
		background: var(--brand-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
		max-width: 34rem;
	}
	.runbar progress {
		width: 8rem;
		height: 0.5rem;
		accent-color: var(--brand);
	}
	.runbar__text {
		flex: 1 1 12rem;
	}
	.dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--brand);
		animation: pulse 1.2s ease-in-out infinite;
		flex: none;
	}
	.banner {
		margin: 0;
		font-size: var(--text-sm);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		background: var(--bg-subtle);
		max-width: 34rem;
	}
	.banner--warn {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.banner--danger {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.toggle {
		display: inline-flex;
		gap: var(--space-2);
		align-items: center;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.lede,
	.note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
