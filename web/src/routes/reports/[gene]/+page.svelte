<!--
	+page.svelte (/reports/[gene]) — one region's temporal report.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5 (revised): each region is its own page (GeneReport) so
	the browser lays out one at a time. Data comes from +page.ts; no computation here.
-->
<script lang="ts">
	import GeneReport from '$lib/temporal/GeneReport.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.record.gene} · SARS-CoV-2 temporal selection · PrimAeon</title>
</svelte:head>

<div class="container">
	<GeneReport record={data.record} />
</div>
