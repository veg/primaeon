<!--
	ReportView.svelte — the one report: title line and metadata, overview line, the data strip, and
	the numbered sections in PLAN.md §4.0's order, each rendering the moment its payload exists.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "Each section below is a section of the single report,
	rendered as soon as its analysis finishes; the page never waits for the slowest one." The
	record may be live (a `$state` proxy from lib/report/run.svelte.ts that the worker is still
	filling) or loaded from a store; this component reads it the same way either time and derives
	per-section status from lib/report/status.ts. Three pieces of app-side state live here because
	more than one section reads them: the call mode (Sites and the overview strip count the same
	calls), the open site (the tree modal opens from the Sites table, the network and the DMS
	heatmap), and the masked/unmasked toggle (the filter section flips which site rows the Sites
	section shows).

	SET LIKE A RESULTS SECTION (web/DESIGN.md §1, §3). One left-aligned column; a title, a metadata
	line and a black rule; sections, figures and tables numbered by CSS counters that are reset
	here — so the numbers are in DOM order, stable across a streaming run (every section is mounted
	from the first paint) and never in the markup the e2e reads.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import type { ReportRecord } from '$lib/api';
	import type { LiveJob, LoadedState, ReportSource } from './load';
	import { SECTION_TITLE, allSectionStatuses, PHASE_LABEL, elapsedSeconds, formatSeconds } from './status';
	import type { FilterBlock, MemeRecord } from '$lib/results/types';
	import { attributionMap, callModeOptions, defaultCallMode, deriveRows, type CallMode } from '$lib/results/derive';
	import { siteCompositions, type SiteComposition } from '$lib/results/entropy';
	import OverviewStrip, { formatStamp, SURFACE_LABEL } from '$lib/viz/OverviewStrip.svelte';
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
	// The sites called at the active cut, so the network fills the same nodes the track and the table mark.
	const calledSites = $derived(rows ? rows.filter((r) => r.tier > 0).map((r) => r.site) : null);
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

	// ---- the title line --------------------------------------------------------------------------
	const phaseLabel = $derived(record.status.phase ? (PHASE_LABEL[record.status.phase] ?? record.status.phase) : 'starting');
	const SOURCE_LABEL: Record<ReportSource, string> = { live: 'running in this browser', local: 'stored in this browser', gallery: 'bundled example, prebaked at build', job: 'server job' };
	const pre = $derived(record.provenance?.preprocessing ?? record.sections.sites?.provenance?.preprocessing ?? null);
	const codons = $derived.by((): number | null => {
		if (record.sections.sites) return record.sections.sites.sites.length;
		const d = record.diagnostics as unknown as { summary?: { codons?: number }; codon_count?: number } | null;
		return d?.summary?.codons ?? d?.codon_count ?? null;
	});
	const variant = $derived(record.provenance?.model_variant ?? record.sections.sites?.provenance?.model_variant ?? record.options.variant);
	const surface = $derived(record.provenance?.surface ?? record.sections.sites?.provenance?.surface ?? 'browser');
	const elapsed = $derived(elapsedSeconds(record));
	/** The metadata line: what was run, on what, with which settings, and when. */
	const meta = $derived.by((): string[] => {
		const out: string[] = [];
		out.push(record.inputs.treeName ? `${record.inputs.alignmentName}, ${record.inputs.treeName}` : record.inputs.alignmentName);
		if (pre) out.push(`${pre.taxa_used.toLocaleString()} of ${pre.taxa_in_alignment.toLocaleString()} taxa`);
		if (codons != null) out.push(`${codons.toLocaleString()} codons`);
		if (pre?.reference_sequence) out.push(`reference ${pre.reference_sequence}`);
		out.push(`model ${variant}`);
		out.push(`seed ${record.options.seed}`);
		out.push(running ? SURFACE_LABEL[surface] ?? surface : `${SURFACE_LABEL[surface] ?? surface}, ${formatSeconds(elapsed)}`);
		if (record.createdAtIso) out.push(formatStamp(record.createdAtIso));
		return out;
	});
	/** Phases already timed, printed as a run-in beside the running line. */
	const timed = $derived(
		Object.entries(record.timings)
			.filter(([k, v]) => k !== 'total' && v != null && Number.isFinite(v as number))
			.map(([k, v]) => `${PHASE_LABEL[k] ?? k} ${formatSeconds(v as number)}`)
	);
</script>

<article class="report">
	<header class="head">
		<p class="eyebrow">Report · {SOURCE_LABEL[source]}</p>
		<h1>{record.name}</h1>
		<p class="meta">{#each meta as m, i (i)}<span>{m}</span>{/each}</p>
	</header>

	{#if running}
		<p class="runbar" role="status" aria-live="polite">
			<span class="mark--run" aria-hidden="true"></span>Running: {phaseLabel}{record.status.message ? `, ${record.status.message}` : ''}{#if record.status.total > 1}, {record.status.done.toLocaleString()} of {record.status.total.toLocaleString()}{/if}.
			{#if timed.length}<span class="runbar__timed">{timed.join(' · ')}</span>{/if}
			{#if job}
				<button type="button" class="button button--secondary" onclick={() => job?.cancel()}>Cancel run</button>
			{/if}
		</p>
	{:else if runState === 'interrupted'}
		<p class="banner banner--warn"><strong>This run was interrupted</strong> before it finished; the sections below are what had completed. Re-run it from the disclosure at the foot of the page.</p>
	{:else if runState === 'failed'}
		<p class="banner banner--danger"><strong>The run failed.</strong> {record.status.error ?? 'No message was recorded.'}</p>
	{:else if runState === 'cancelled'}
		<p class="banner">The run was cancelled; the sections below are what had completed.</p>
	{/if}

	<OverviewStrip {record} {rows} modeLabel={modeOption.label} {live} />
	<DataStrip {record} />

	<Section id="sites" title={SECTION_TITLE.sites} command="hyphaeon meme" eyebrow="surrogate for MEME" status={status('sites')}>
		{#snippet actions()}
			{#if cleanedSites}
				<label class="toggle"><input type="checkbox" bind:checked={useCleaned} /> view masked (re-scored) sites</label>
			{/if}
		{/snippet}
		{#if sitesForView && rows}
			<SitesSection sites={sitesForView} {rows} {modes} {mode} onMode={(m) => (mode = m)} {compositions} {compositionMap} {hasAttribution} onSelect={select} />
		{/if}
	</Section>

	<Section id="gene" title={SECTION_TITLE.gene} command="hyphaeon busted" eyebrow="surrogate for BUSTED" status={status('gene')}>
		{#if record.sections.gene}
			<GeneCard gene={record.sections.gene} />
		{/if}
	</Section>

	<Section id="epistasis" title={SECTION_TITLE.epistasis} command="hyphaeon epistasis" eyebrow="co-selection network and sectors" status={status('epistasis')}>
		{#if record.sections.epistasis}
			<EpistasisSection {record} epistasis={record.sections.epistasis} called={calledSites} onSelect={select} />
		{/if}
	</Section>

	<Section id="attribution" title={SECTION_TITLE.attribution} command="hyphaeon meme --attribute" eyebrow="per-taxon counterfactual attribution on called sites" status={status('attribution')}>
		{#if record.sections.attribution}
			{#if attributions.size}
				<AttributionPanel {attributions} onSelect={select} />
			{:else}
				<p class="note">No site reached the attribution gate (LRT ≥ 3.84), so no driver was attributed.</p>
			{/if}
		{/if}
	</Section>

	<Section id="filter" title={SECTION_TITLE.filter} command="hyphaeon meme --filter" eyebrow="outlier-contamination screen" status={status('filter')}>
		{#snippet actions()}
			{#if cleanedSites}
				<label class="toggle"><input type="checkbox" bind:checked={useCleaned} /> view masked sites in the Sites section</label>
			{/if}
		{/snippet}
		{#if filter && filterBlock}
			{#if sites}
				<FilterPanel record={sites} filter={filterBlock} />
			{/if}
		{/if}
	</Section>

	<Section id="dms" title={SECTION_TITLE.dms} command="hyphaeon dms" eyebrow="in-silico saturation scan" status={status('dms')}>
		{#if record.sections.dms}
			<DmsSection {record} dms={record.sections.dms} running={running && record.status.phase === 'dms'} onCancel={job ? () => job?.cancelDms() : null} onSelect={select} />
		{/if}
	</Section>

	<Section id="phenotype" title={SECTION_TITLE.phenotype} command="hyphaeon phenotype" eyebrow="PhyloWAS, on demand" status={status('phenotype')}>
		<PhenotypeSection {record} {base} owned={source === 'live' || source === 'local'} onSelect={select} />
	</Section>

	<Section id="provenance" title="Data and provenance" eyebrow="what produced these numbers, and how to get them again" status={{ name: 'phenotype', state: 'done', phase: null, reason: null }}>
		<ProvenanceSection {record} />
		<RerunDisclosure {record} />
	</Section>
</article>

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
		counter-reset: section figure table;
	}
	/* Figures and tables number continuously through the report, in DOM order (DESIGN.md §3). */
	.report :global(figcaption b::before) {
		counter-increment: figure;
		content: 'Figure ' counter(figure) '. ';
	}
	.report :global(caption b::before) {
		counter-increment: table;
		content: 'Table ' counter(table) '. ';
	}
	.head {
		border-bottom: 1px solid var(--text);
		padding-bottom: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.head .eyebrow {
		margin: 0 0 var(--space-2);
	}
	.head h1 {
		margin: 0 0 var(--space-1);
		overflow-wrap: anywhere;
	}
	.meta {
		margin: 0;
		max-width: none;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.meta span + span::before {
		content: '\00b7';
		margin: 0 0.5rem;
		color: var(--text-faint);
	}
	.runbar {
		margin: 0 0 var(--space-5);
		max-width: none;
		font-size: var(--text-md);
		color: var(--text-muted);
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.runbar__timed {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.runbar .button {
		margin-left: auto;
		padding: 0.15rem 0.6rem;
	}
	.toggle {
		display: inline-flex;
		gap: var(--space-2);
		align-items: center;
		font-size: var(--text-md);
		color: var(--text-muted);
		cursor: pointer;
	}
	.note {
		margin: 0;
	}
</style>
