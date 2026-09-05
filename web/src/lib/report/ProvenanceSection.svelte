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
	report's own and are listed here.
-->
<script lang="ts">
	import type { ReportRecord } from '$lib/api';
	import type { MemeRecord } from '$lib/results/types';
	import ProvenancePanel, { type ExtraDownload } from '$lib/viz/ProvenancePanel.svelte';
	import { analyzeSnippet } from './mcp';
	import { downloadText, graphmlText, newickText, reportJsonText, reportStem, sitesCsvText, sitesJsonText } from './downloads';
	import { PHASE_LABEL } from './status';

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
</script>

{#if timings.length}
	<dl class="timings" aria-label="Phase timings">
		{#each timings as [phase, sec] (phase)}
			<div><dt>{PHASE_LABEL[phase] ?? phase}</dt><dd class="mono">{(sec as number).toFixed(sec! < 10 ? 2 : 1)} s</dd></div>
		{/each}
	</dl>
{/if}

{#if panelRecord}
	<ProvenancePanel record={panelRecord} {snippet} extraDownloads={downloads} snippetTool="hyphaeon_analyze" />
{:else}
	<p class="note">No provenance block has been written yet; it arrives with the first section.</p>
{/if}

<style>
	.timings {
		margin: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-sm);
	}
	.timings div {
		display: flex;
		gap: var(--space-2);
		align-items: baseline;
	}
	.timings dt {
		color: var(--text-faint);
	}
	.timings dd {
		margin: 0;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
