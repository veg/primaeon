<!--
	GeneReport.svelte — one region's full temporal report (the page at /reports/<gene>/).

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5 (revised): each gene is its own page so the browser lays
	out one region at a time. This is the paper for a single region — a back link to the study index,
	the title, and the region's panels + table (GeneSection). The CSS counter for figures/tables
	lives here so numbering restarts per page; the section counter numbers the single GeneSection.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { TemporalGeneRecord } from './types';
	import GeneSection from './GeneSection.svelte';

	interface Props {
		record: TemporalGeneRecord;
	}
	let { record }: Props = $props();
</script>

<article class="report">
	<nav class="back"><a href="{base}/reports/">← SARS-CoV-2 temporal selection</a></nav>
	<h1>{record.gene}</h1>
	<GeneSection {record} headless />
</article>

<style>
	.report {
		counter-reset: section figure table;
		max-width: 72ch;
	}
	.back {
		font-size: var(--text-md);
		margin-bottom: var(--space-3);
	}
	.back a {
		color: var(--brand);
	}
	h1 {
		font-size: var(--text-xl);
		font-weight: 700;
		margin: 0 0 var(--space-4);
	}
	/* Figures/tables number continuously down this one region's page. */
	.report :global(figcaption b::before) {
		counter-increment: figure;
		content: 'Figure ' counter(figure) '. ';
	}
	.report :global(caption b::before) {
		counter-increment: table;
		content: 'Table ' counter(table) '. ';
	}
</style>
