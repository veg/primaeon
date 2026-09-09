<!--
	TemporalReport.svelte — the SARS-CoV-2 temporal-selection study as a paper: title, abstract,
	methods (with the Pango caveat), the genome-map overview, then a numbered section per gene.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §1/§5: /reports is one study, genes as sections, in the
	lab-notebook grammar (DESIGN.md). The CSS counter on `.report` numbers each gene section by
	`h2::before`, so the h2 text stays exactly the gene name (no number in markup). Figures and
	tables number continuously in DOM order. Nothing here computes — it renders the DAA-safe
	prebaked records the page loaded.
-->
<script lang="ts">
	import type { GenomeMap, TemporalGeneRecord, TemporalIndex } from './types';
	import GeneSection from './GeneSection.svelte';
	import GenomeMapView from '$lib/viz/temporal/GenomeMap.svelte';

	interface Props {
		index: TemporalIndex;
		genomeMap: GenomeMap;
		genes: TemporalGeneRecord[];
	}
	let { index, genomeMap, genes }: Props = $props();

	const runGenes = $derived(genomeMap.genes.filter((g) => g.run));
	const totalConfirmed = $derived(index.genes.reduce((a, g) => a + g.confirmed_sweeps, 0));
	const totalRescued = $derived(index.genes.reduce((a, g) => a + g.rescued_sweeps, 0));

	function scrollTo(gene: string) {
		document.getElementById(`gene-${gene}`)?.scrollIntoView({ behavior: 'smooth' });
	}
</script>

<article class="report">
	<header class="head">
		<h1>SARS-CoV-2 temporal selection</h1>
		<p class="byline">
			Continuous episodic-selection dynamics across {runGenes.length} coding regions ·
			<span class="mono">hyphaeon temporal</span>
			{#if index.partial}· <strong>partial build ({genes.length} of {runGenes.length} regions shown)</strong>{/if}
		</p>
		<hr class="rule" />
	</header>

	<section class="abstract">
		<p>
			Standard selection scans collapse an epidemic's whole history into one timeless tree. The
			HyphAeon temporal engine instead recovers the <em>kinematics</em> of positive selection: for
			each codon it fits a continuous selection trajectory over collection time, extracts the
			collective epidemic-wave modes by functional PCA, and cross-classifies each site against a
			static MEME baseline. Across the regions here it finds {totalConfirmed} confirmed and {totalRescued}
			rescued sweeps.
		</p>
		<p class="methods">
			<strong>What this shows.</strong> Every number is the aggregate, site-level result of a
			cluster run — no sequences, dates, or per-sequence data are shipped or shown (the inputs are
			GISAID DAA-restricted). The wave modes are <em>data-driven</em> modes of coordinated change,
			presented as the epidemic-turnover narrative; they are <em>not</em> named-lineage (Pango)
			frequencies, which this dataset cannot support. Each region is an independent temporal
			subsample, so counts are not comparable one-to-one across regions.
		</p>
	</section>

	<section class="overview">
		<h2 class="unnumbered">Genome overview</h2>
		<figure>
			<GenomeMapView map={genomeMap} onPick={scrollTo} />
			<figcaption>
				<b></b>Analysed regions on the SARS-CoV-2 reference ({genomeMap.reference}); bar height is the
				confirmed-sweep count. Faint regions were not run in this build (e.g. S, ORF1a, nsp2/nsp3),
				an honest view of coverage. Jump to a region below.
			</figcaption>
		</figure>
		<nav class="jump" aria-label="Regions">
			{#each index.genes as g (g.gene)}
				<button type="button" onclick={() => scrollTo(g.gene)}>{g.gene}</button>
			{/each}
		</nav>
	</section>

	{#each genes as record (record.gene)}
		<GeneSection {record} />
	{/each}
</article>

<style>
	.report {
		counter-reset: figure table;
		max-width: 72ch;
	}
	.head h1 {
		font-size: var(--text-xl);
		font-weight: 700;
		margin: 0 0 var(--space-2);
	}
	.byline {
		color: var(--text-muted);
		font-size: var(--text-md);
		margin: 0 0 var(--space-3);
	}
	.rule {
		border: none;
		border-top: 1px solid var(--text);
		margin: 0 0 var(--space-6);
	}
	.abstract p {
		max-width: var(--measure);
		margin: 0 0 var(--space-4);
	}
	.abstract .methods {
		color: var(--text-muted);
		font-size: var(--text-md);
	}
	.overview {
		margin-top: var(--space-8);
	}
	.overview h2.unnumbered {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0 0 var(--space-4);
	}
	.overview figure {
		margin: 0 0 var(--space-4);
	}
	figcaption {
		color: var(--text-muted);
		font-size: var(--text-md);
		max-width: var(--measure);
		margin-top: var(--space-2);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.jump button {
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--brand);
		background: none;
		border: none;
		padding: 0.1rem 0.3rem;
		cursor: pointer;
	}
	.jump button:hover {
		text-decoration: underline;
	}
	/* Number gene sections (figure/table counters continue across them). The counter lives here so
	   only gene sections increment it; the unnumbered overview h2 is excluded by class. */
	.report :global(.section) {
		counter-increment: section;
	}
	.report {
		counter-reset: section figure table;
	}
	.report :global(.section h2::before) {
		content: counter(section);
		color: var(--text-muted);
		font-weight: 400;
		position: absolute;
		left: 0;
	}
	.report :global(figcaption b::before) {
		counter-increment: figure;
		content: 'Figure ' counter(figure) '. ';
	}
	.report :global(caption b::before) {
		counter-increment: table;
		content: 'Table ' counter(table) '. ';
	}
</style>
