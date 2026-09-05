<!--
	+page.svelte (/methods) — what each analysis computes, what it was validated against, and the
	measured behaviour of the model, one section per report section.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/methods — one page per pillar; caveats generated from
	caveats.json." D21 (§4.0) moved the surrogate framing off the landing page: it lives here, next
	to the numbers, as fact. The method text and validation notes are in ./pillars.ts (mirroring the
	Python reference function by function); every number about the model comes from
	web/caveats.json through $lib/caveats and is rendered by Caveats.svelte, so this file types no
	measurement. Section ids are the ReportRecord section names (sites, gene, epistasis,
	attribution, filter, dms, phenotype) plus diagnostics and evaluate, so the report can deep-link
	to /methods/#gene from the section it is qualifying.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import Caveats from '$lib/caveats/Caveats.svelte';
	import { latestCaveats } from '$lib/caveats';
	import { PILLARS } from './pillars';

	const set = latestCaveats();
	const card = set.model_card;
	const variants = Object.entries(card.variants);
</script>

<svelte:head>
	<title>Methods · HyphAeon</title>
	<meta
		name="description"
		content="What each HyphAeon analysis computes, what the port was validated against, and the measured behaviour of the model: calibration by regime, concordance with MEME, tree sensitivity, and the conventions that make results reproducible."
	/>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">Methods</p>
	<h1>What each analysis computes, and how far to read it</h1>
	<p class="intro">
		One upload runs every analysis below, in this order, and the report fills in as each finishes.
		Each section says what is computed, mirroring the reference implementation function by
		function, what this implementation was checked against, and what has been measured about the
		model's behaviour. Where a real HyPhy method exists, the section says how to run it.
	</p>

	<nav class="toc" aria-label="On this page">
		<ul>
			<li><a href="#model">The model</a></li>
			{#each PILLARS as p (p.id)}
				<li><a href="#{p.id}">{p.title}</a></li>
			{/each}
		</ul>
	</nav>

	<section id="model" class="pillar">
		<h2>The model</h2>
		<p>{card.what_it_is}</p>
		<p>
			It is a surrogate for {card.surrogate_for}: the training targets are MEME likelihood-ratio
			statistics, and it is evaluated against {card.evaluated_against}. The suite checkpoint has
			{card.parameters_suite.toLocaleString('en-US')} parameters across the backbone and the
			{card.heads.join(', ')} heads; the exported graphs take {card.inputs.join(', ')} and return
			{card.outputs.join(', ')}, which between them unlock every analysis on this page. The genetic
			code is {card.genetic_code}; the model accepts up to {card.taxon_cap} taxa and this application
			subsamples to {card.default_taxon_cap} by default. Random draws (the permutation nulls, the
			BUSTED head's missing parameters) come from {card.prng.algorithm} seeded with
			{card.prng.default_seed}; MDS eigenvector signs follow the {card.mds_sign} convention. Model
			version <code>{set.model_version}</code>, reference <code>{set.reference_version}</code>
			(<code>{set.reference_tag}</code>).
		</p>
		<div class="scroll">
			<table class="variants">
				<thead>
					<tr><th>Variant</th><th>Trained on</th><th>Regime</th><th>Graph</th></tr>
				</thead>
				<tbody>
					{#each variants as [name, v] (name)}
						<tr>
							<td><code>{name}</code></td>
							<td>{v.trained_on}</td>
							<td>{v.regime}</td>
							<td><code>{v.onnx_sha256_prefix}…</code>{#if v.busted_head_onnx_sha256_prefix} + head <code>{v.busted_head_onnx_sha256_prefix}…</code>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="fine">
			Every surface verifies the full hash of the graph it loads and records it, the variant, the
			seed and the surface in the result's provenance. Source: {set.sources[card.source]}.
		</p>
		<Caveats pillar="general" {set} heading="Measured behaviour, alignment-wide" />
	</section>

	{#each PILLARS as p (p.id)}
		<section id={p.id} class="pillar">
			<h2>{p.title}</h2>
			<dl class="meta">
				<dt>Mirrors</dt>
				<dd><code>{p.command}</code></dd>
				<dt>Model outputs</dt>
				<dd><code>{p.needs}</code></dd>
				<dt>In the browser</dt>
				<dd>{p.cost}</dd>
			</dl>
			{#if p.status}
				<p class="status">{p.status}</p>
			{/if}

			<h3>What is computed</h3>
			<p>{p.computed}</p>
			<p class="fields">
				<span class="fields__label">Result keys</span>
				{#each p.fields as f (f)}
					<code>{f}</code>
				{/each}
			</p>

			<h3>Validated against</h3>
			<p>{p.validated}</p>

			<Caveats pillar={p.id} {set} heading="Measured behaviour" />

			{#if p.real}
				<p class="real">
					<a class="button button--secondary" href={p.real.href} rel="noopener">Run {p.real.label}</a>
					<span>{p.real.note}</span>
				</p>
			{:else if p.id !== 'diagnostics'}
				<p class="fine">
					No HyPhy counterpart: this analysis is a property of the surrogate, not a prediction of
					another method.
				</p>
			{/if}
		</section>
	{/each}

	<section class="pillar">
		<h2>Reproducing a report</h2>
		<p>
			Every report carries a provenance block with the surface that computed it, the model
			version, variant and graph hash, the seed, the options as submitted, everything the
			diagnostics step did to the data, and the <code>hyphaeon</code> command line that
			reproduces the run with the Python reference. The same run is one tool call away in
			<a href="{base}/mcp/">Claude through MCP</a>, and the report's "Reproduce" panel prints
			that call.
		</p>
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
		margin-bottom: var(--space-8);
	}
	.pillar h3 {
		font-family: var(--font-text);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: var(--space-5) 0 var(--space-2);
	}
	.meta {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		margin: 0 0 var(--space-3);
		font-size: var(--text-sm);
	}
	.meta dt {
		color: var(--text-muted);
	}
	.meta dd {
		margin: 0;
	}
	.status {
		font-size: var(--text-sm);
		padding: var(--space-2) var(--space-3);
		border-left: 2px solid var(--accent);
		background: var(--accent-soft);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		align-items: baseline;
		font-size: var(--text-sm);
	}
	.fields__label {
		color: var(--text-muted);
		margin-right: var(--space-1);
	}
	.fields code {
		font-size: var(--text-xs);
	}
	.scroll {
		overflow-x: auto;
		margin-bottom: var(--space-3);
	}
	.variants {
		font-size: var(--text-sm);
		min-width: 36rem;
	}
	.fine {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.real {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: center;
		margin-top: var(--space-5);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.real span {
		flex: 1 1 20rem;
	}
</style>
