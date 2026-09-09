<!--
	+page.svelte (/reports) — the SARS-CoV-2 temporal-selection study.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §1: a read-only "Reports" tab publishing the
	`hyphaeon temporal` run as a lab-notebook study. The route loads the DAA-safe prebaked records
	(+page.ts) and hands them to TemporalReport; there is no in-browser computation. Prerendered by
	adapter-static via the root +layout.ts.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import TemporalReport from '$lib/temporal/TemporalReport.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>SARS-CoV-2 temporal selection · Reports · PrimAeon</title>
</svelte:head>

<div class="container">
	{#if data.genes.length === 0}
		<p class="empty">
			No temporal records are built yet. Run the prebake with the study data available, or see
			<a href="{base}/methods/">Methods</a>.
		</p>
	{:else}
		<TemporalReport index={data.index} genomeMap={data.genomeMap} genes={data.genes} />
	{/if}
</div>

<style>
	.empty {
		color: var(--text-muted);
	}
</style>
