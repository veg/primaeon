<!--
	TemporalReport.svelte — the SARS-CoV-2 temporal-selection study INDEX: title, abstract, methods
	(with the Pango caveat), the genome-map overview, and a card per gene linking to its own page.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §1/§5 (revised): /reports is one study, but rendering all
	22 genes' panels and per-site tables on a single page produced a ~326,000 px page the browser
	could not handle. So the study is now an index — the overview plus a catalogue — and each gene's
	full report lives at /reports/<gene>/ (GeneReport). Nothing here computes; it renders the DAA-safe
	index the page loaded.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { GenomeMap, TemporalIndex } from './types';
	import GenomeMapView from '$lib/viz/temporal/GenomeMap.svelte';

	interface Props {
		index: TemporalIndex;
		genomeMap: GenomeMap;
	}
	let { index, genomeMap }: Props = $props();

	const runGenes = $derived(genomeMap.genes.filter((g) => g.run));
	const totalConfirmed = $derived(index.genes.reduce((a, g) => a + g.confirmed_sweeps, 0));
	const totalRescued = $derived(index.genes.reduce((a, g) => a + g.rescued_sweeps, 0));
	// Order the catalogue by genome position so it reads 5'→3' like the map.
	const cards = $derived(
		[...index.genes].sort((a, b) => (a.coords?.[0] ?? 0) - (b.coords?.[0] ?? 0))
	);

	function go(gene: string) {
		window.location.href = `${base}/reports/${encodeURIComponent(gene)}/`;
	}
</script>

<article class="report">
	<header class="head">
		<h1>SARS-CoV-2 temporal selection</h1>
		<p class="byline">
			Continuous episodic-selection dynamics across {runGenes.length} coding regions ·
			<span class="mono">hyphaeon temporal</span>
			{#if index.partial}· <strong>partial build ({index.genes.length} of {runGenes.length} regions)</strong>{/if}
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
			rescued sweeps. Open a region for its trajectories, velocity waterfall, wave modes, and
			per-site table.
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
		<h2>Genome overview</h2>
		<figure>
			<GenomeMapView map={genomeMap} onPick={go} />
			<figcaption>
				<b></b>Analysed regions on the SARS-CoV-2 reference ({genomeMap.reference}); bar height is the
				confirmed-sweep count. Faint regions were not run in this build (e.g. ORF1a, ORF6/7b/10), an
				honest view of coverage.
			</figcaption>
		</figure>
	</section>

	<section class="catalogue">
		<h2>Regions</h2>
		<ul class="grid">
			{#each cards as g (g.gene)}
				<li>
					<a href="{base}/reports/{g.gene}/">
						<span class="name">{g.gene}</span>
						<span class="stat">{g.confirmed_sweeps} confirmed · {g.rescued_sweeps} rescued</span>
						<span class="sub"
							>{g.taxa_total.toLocaleString('en-US')} seqs · {g.codons_variable} variable codons</span
						>
					</a>
				</li>
			{/each}
		</ul>
	</section>
</article>

<style>
	.report {
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
	.mono {
		font-family: var(--font-mono);
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
	section {
		margin-top: var(--space-8);
	}
	h2 {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0 0 var(--space-4);
	}
	figure {
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
	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 1px;
		background: var(--hair);
		border: 1px solid var(--hair);
	}
	.grid li {
		background: var(--bg);
	}
	.grid a {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: var(--space-3) var(--space-4);
		text-decoration: none;
		color: var(--text);
	}
	.grid a:hover {
		background: var(--surface-2);
	}
	.name {
		font-weight: 700;
		color: var(--brand);
	}
	.stat {
		font-size: var(--text-md);
		font-variant-numeric: tabular-nums;
	}
	.sub {
		font-size: 13px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
