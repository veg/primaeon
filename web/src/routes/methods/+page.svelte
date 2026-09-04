<!--
	+page.svelte (/methods) — one section per pillar, skeleton.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/methods — one page per pillar; caveats generated from
	caveats.json." Phase 0 lays down the headings and the one-line description of each pillar from
	PLAN.md §1 so the navigation is complete; the per-pillar text, the "before you run" checks
	(§4.3) and the caveats from web/caveats.json (built from model_eval in Phase 4) fill in later.
-->
<script lang="ts">
	const pillars = [
		{
			id: 'meme',
			command: 'hyphaeon meme',
			title: 'Site selection',
			summary:
				'Per-site MEME-style LRT, p-value under the MEME mixture null, Benjamini–Hochberg q, and an invariable flag; optional artefact filtering and per-taxon counterfactual attribution.',
			needs: 'lrt'
		},
		{
			id: 'busted',
			command: 'hyphaeon busted',
			title: 'Omnibus selection',
			summary:
				'Cauchy (ACAT) and Simes combination of site p-values, a neural gene-level LRT, selection probability, ω-class summary and synonymous rate variation.',
			needs: 'lrt + root_repr'
		},
		{
			id: 'epistasis',
			command: 'hyphaeon epistasis',
			title: 'Epistasis and sectors',
			summary:
				'Attribution vectors from root-to-leaf attention form a cosine co-selection network with t-test p, BH q and CESI; sectors by greedy modularity with spectral coherence and a Monte Carlo null.',
			needs: 'lrt + mean_root_attns'
		},
		{
			id: 'dms',
			command: 'hyphaeon dms',
			title: 'Digital deep mutational scan',
			summary:
				'Nineteen substitutions at every site, ΔLRT per mutant, and intrinsic plasticity per site.',
			needs: 'lrt (19 × L passes)'
		},
		{
			id: 'phenotype',
			command: 'hyphaeon phenotype',
			title: 'Phenotype association',
			summary:
				'Directional trait association per site with permutation p and BH q, PARS signatures, trait sectors, and gene-level Brownian-motion permulations.',
			needs: 'lrt + mean_root_attns'
		},
		{
			id: 'evaluate',
			command: 'hyphaeon evaluate',
			title: 'Evaluate against MEME',
			summary:
				'Concordance of a site-selection CSV with HyPhy MEME JSON: Pearson and Spearman, ROC-AUC, PPV and FPR at 0.05 and 0.10, confusion matrices.',
			needs: 'none'
		}
	];
</script>

<svelte:head>
	<title>Methods · HyphAeon</title>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">Methods</p>
	<h1>What each analysis computes</h1>
	<p class="intro">
		Six analyses, one model. All but <em>evaluate</em> run the network; the three tensors it emits
		(<code>lrt</code>, <code>mean_root_attns</code>, <code>root_repr</code>) decide which analyses an
		export unlocks. Detailed method text and the caveats measured in <code>model_eval</code> are
		filled in as each pillar lands.
	</p>

	<nav class="toc" aria-label="On this page">
		<ul>
			{#each pillars as p (p.id)}
				<li><a href="#{p.id}">{p.title}</a></li>
			{/each}
			<li><a href="#before-you-run">Before you run</a></li>
		</ul>
	</nav>

	{#each pillars as p (p.id)}
		<section id={p.id} class="pillar">
			<h2>{p.title}</h2>
			<p class="meta"><code>{p.command}</code> · model outputs needed: <code>{p.needs}</code></p>
			<p>{p.summary}</p>
			<p class="todo">Method details, measured behaviour and caveats: to be written.</p>
		</section>
	{/each}

	<section id="before-you-run" class="pillar">
		<h2>Before you run</h2>
		<p>
			One set of checks, run in the browser before the model and by the server's
			<code>/validate</code>, both producing the same warning codes: format and reading frame,
			unknown-codon fraction, identical sequences, taxa below three or above the cap, tree-to-alignment
			name matching, missing or saturated branch lengths, the patristic-distance rescale, the depth
			regime that suggests the viral variant, and a cost estimate.
		</p>
		<p class="todo">The check table and its codes are generated from the library once it ships them.</p>
	</section>
</div>

<style>
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-5);
	}
	.toc ul {
		list-style: none;
		padding: 0;
		margin: 0 0 var(--space-6);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		font-size: var(--text-sm);
	}
	.pillar {
		border-top: 1px solid var(--border);
		padding-top: var(--space-5);
		margin-bottom: var(--space-6);
	}
	.meta {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.todo {
		font-size: var(--text-sm);
		color: var(--text-faint);
		font-style: italic;
		margin: 0;
	}
</style>
