<!--
	ProvenanceSection.svelte — "Data and provenance": Phase 1's provenance panel over the report's
	provenance block, the report-level downloads (JSON, CSV, GraphML, Newick), and the MCP snippet
	on `hyphaeon_analyze`.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "Every page — provenance panel with surface and seed,
	warnings, surrogate badge, variant + hash, the Datamonkey deep link, and the MCP reproduction
	snippet". ProvenancePanel.svelte renders all of that from a MemeRecord-shaped provenance; the
	report hands it the `sites` section (whose provenance block is the run's) with the record's
	own provenance merged over it when the orchestrator wrote one, replaces its per-analysis
	downloads with the report's (lib/report/downloads.ts), and replaces the `hyphaeon_meme`
	snippet with the `hyphaeon_analyze` one (lib/report/mcp.ts). Timings per phase are the
	report's own and are printed here as one line of small print (web/DESIGN.md §3, Progress).
-->
<script lang="ts">
	import type { ReportRecord } from '$lib/api';
	import type { MemeRecord } from '$lib/results/types';
	import ProvenancePanel, { type ExtraDownload } from '$lib/viz/ProvenancePanel.svelte';
	import { analyzeSnippet } from './mcp';
	import { downloadText, graphmlText, newickText, reportJsonText, reportStem, sitesCsvText, sitesJsonText } from './downloads';
	import { PHASE_LABEL, formatSeconds } from './status';

	interface Props {
		record: ReportRecord;
	}
	let { record }: Props = $props();

	/** A MemeRecord-shaped view for the panel: the sites section, or a shell around the record's provenance. */
	const panelRecord = $derived.by((): MemeRecord | null => {
		const sites = record.sections.sites;
		const prov = record.provenance ?? sites?.provenance ?? null;
		if (!prov) return null;
		if (sites) return { ...sites, provenance: { ...sites.provenance, ...prov }, name: record.name, created_at: record.createdAtIso || sites.created_at };
		return {
			schema_version: 2,
			method: 'meme',
			is_surrogate: true,
			surrogate_for: prov.surrogate_for ?? 'MEME',
			sites: [],
			summary: { totalSites: 0, variableSites: 0, speciesUsed: prov.preprocessing?.taxa_used ?? 0, speciesInAlignment: prov.preprocessing?.taxa_in_alignment ?? 0 },
			provenance: prov,
			name: record.name,
			created_at: record.createdAtIso || undefined,
			tree: record.inputs.treeText ?? null
		};
	});

	const stem = $derived(reportStem(record));
	const downloads = $derived<ExtraDownload[]>([
		{ label: 'Report (JSON)', title: 'The whole record, input texts removed', run: async () => downloadText(`${stem}_hyphaeon_report.json`, reportJsonText(record), 'application/json') },
		{
			label: 'Sites (hyphaeon meme JSON)',
			disabled: !record.sections.sites,
			run: async () => {
				const t = await sitesJsonText(record);
				if (t) downloadText(`${stem}_hyphaeon_meme.json`, t, 'application/json');
			}
		},
		{
			label: 'Sites (CSV)',
			disabled: !record.sections.sites,
			run: async () => {
				const t = await sitesCsvText(record);
				if (t) downloadText(`${stem}_hyphaeon_meme.csv`, t, 'text/csv;charset=utf-8');
			}
		},
		{
			label: 'Network (GraphML)',
			disabled: !record.sections.epistasis?.edges?.length,
			title: record.sections.epistasis?.edges?.length ? 'nx.write_graphml over the co-selection edges (cli.py:821-833)' : 'No edges in this report',
			run: async () => {
				const t = await graphmlText(record);
				if (t) downloadText(`${stem}_coselection.graphml`, t, 'application/xml');
			}
		},
		{
			label: 'Tree (Newick)',
			disabled: !newickText(record),
			run: async () => {
				const t = newickText(record);
				if (t) downloadText(`${stem}_tree.nwk`, t);
			}
		}
	]);
	const snippet = $derived(analyzeSnippet(record));
	const timings = $derived(Object.entries(record.timings).filter(([, v]) => v != null && Number.isFinite(v as number)));
	const sectionsRun = $derived(record.status.completed?.length ? record.status.completed.join(', ') : null);
</script>

{#if timings.length || sectionsRun}
	<p class="timings" aria-label="Phase timings">
		{#if sectionsRun}Sections run: {sectionsRun}.{/if}
		{#if timings.length}
			Wall time by phase:
			{#each timings as [phase, sec], i (phase)}{i ? '; ' : ' '}{PHASE_LABEL[phase] ?? phase} {formatSeconds(sec as number)}{/each}.
		{/if}
	</p>
{/if}

{#if panelRecord}
	<ProvenancePanel record={panelRecord} {snippet} extraDownloads={downloads} snippetTool="hyphaeon_analyze" />
{:else}
	<p class="note">No provenance block has been written yet; it arrives with the first section.</p>
{/if}

<style>
	.timings {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-faint);
		max-width: none;
	}
	.note {
		margin: 0;
	}
</style>
