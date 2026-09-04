<!--
	+page.svelte (/gallery) — the bundled examples as cards, each opening its prebaked result.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/gallery — bundled examples with prebaked results." The
	cards come from static/gallery/index.json, which web/scripts/prebake-gallery.mjs writes at build
	by running site selection on the five README examples through this build's runtime under Node
	(see that script's header for the options and the provenance). A card shows the paper's one-line
	description, the dimensions the model actually saw (after duplicate pruning and the 256-taxon
	cap), the prebake's wall time beside the Python reference's, and the called counts; "View
	results" links to /results/gallery/<name>/, which the results page serves from the record beside
	the index. The inputs are linked as files so a reader can run the same example in the analyzer
	or the CLI.

	Called counts are shown three ways on purpose (PLAN.md §2 items 2 and 7, D11): q ≤ 0.10 is the
	reference CLI's own summary line, p ≤ 0.05 is the raw mixture test, and "top 5 %" is the app's
	default percentile tier — a rank, which always calls a fixed share of the variable sites. Showing
	a rank next to a test is what keeps the rank from reading as a finding.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { GalleryEntry } from '$lib/gallery/types';

	let { data } = $props();

	const entries = $derived(data.index.entries);
	const baked = $derived(entries.filter((e) => e.status === 'ok').length);

	const fmt = (n: number | null | undefined): string =>
		n === null || n === undefined ? '—' : n.toLocaleString();

	function resultsHref(entry: GalleryEntry): string {
		return `${base}/results/gallery/${encodeURIComponent(entry.id)}/`;
	}

	function inputHref(file: string): string {
		return `${base}/gallery/inputs/${file}`;
	}

	function taxaLine(entry: GalleryEntry): string {
		const s = entry.summary;
		if (!s) return `${fmt(entry.paper.taxa)} taxa`;
		if (s.taxa_used === s.taxa_in_alignment) return `${fmt(s.taxa_used)} taxa`;
		return `${fmt(s.taxa_used)} of ${fmt(s.taxa_in_alignment)} taxa`;
	}

	function treeLine(entry: GalleryEntry): string {
		const source = entry.tree_source === 'embedded' ? 'embedded in the NEXUS file' : 'Newick file';
		if (entry.branch_lengths_estimated) return `${source}; branch lengths fitted (HKY85)`;
		if (entry.branch_length_method === 'library-default') {
			return `${source}; no branch lengths — library defaults`;
		}
		return `${source}, with branch lengths`;
	}

	function runtimeLine(entry: GalleryEntry): string {
		const parts: string[] = [];
		if (entry.summary) {
			const threads = entry.prebake?.threads;
			parts.push(
				`${entry.summary.runtime_sec.toFixed(1)} s here` +
					(threads ? ` (Node, ${threads} thread${threads === 1 ? '' : 's'})` : '')
			);
		}
		if (entry.reference_runtime_sec !== null) {
			parts.push(`${entry.reference_runtime_sec.toFixed(1)} s Python reference (torch, CPU)`);
		}
		return parts.join(' · ') || '—';
	}

	function shortHash(hash: string | null): string {
		return hash ? `${hash.slice(0, 12)}…` : 'unverified';
	}
</script>

<svelte:head>
	<title>Gallery · HyphAeon</title>
	<meta
		name="description"
		content="The five example datasets that ship with HyphAeon, scored at build time with the app's own runtime, ready to open."
	/>
</svelte:head>

<div class="container">
	<p class="eyebrow">Gallery</p>
	<h1>Bundled examples</h1>
	<p class="intro">
		The five datasets from the HyphAeon paper, scored at build time with this site's own runtime
		— the same <code>runMeme</code> the analyzer runs in your browser — under Node with the
		<code>{data.index.model.variant}</code> model and a {data.index.options.maxSpecies}-taxon cap.
		Each card opens the same results view a local run gets. These are the surrogate's
		predictions of MEME, not MEME; the results page says how to run the real thing.
	</p>

	<p class="provenance">
		{#if data.index.engine.commit}
			Engine <code>veg/HyphAeon@{data.index.engine.commit}</code>
		{/if}
		{#if data.index.engine.hyphaeon_js_version}
			· library <code>{data.index.engine.hyphaeon_js_version}</code>
		{/if}
		{#if data.index.model.model_version}
			· model <code>{data.index.model.model_version}/{data.index.model.variant}</code>
			<code class="hash" title={data.index.model.artifact_sha256 ?? ''}
				>{shortHash(data.index.model.artifact_sha256)}</code
			>
		{/if}
		· baked {new Date(data.index.generated_at).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		})}
		· {baked} of {entries.length} with results
	</p>

	<ul class="grid" aria-label="Examples">
		{#each entries as entry (entry.id)}
			<li class="card" class:card--unavailable={entry.status !== 'ok'}>
				<p class="card__regime">{entry.regime}</p>
				<div class="card__head">
					<h2>{entry.name}</h2>
					{#if entry.status === 'failed'}
						<span class="badge badge--danger">run failed</span>
					{:else if entry.status === 'missing'}
						<span class="badge">not baked</span>
					{/if}
				</div>
				<p class="gene">{entry.gene}</p>
				<p class="description">{entry.description}</p>

				<dl class="facts">
					<div>
						<dt>Alignment</dt>
						<dd>
							{taxaLine(entry)} × {fmt(entry.summary?.codons ?? entry.paper.codons)} codons
							{#if entry.summary}
								<span class="faint">· {fmt(entry.summary.variable_sites)} variable</span>
							{/if}
						</dd>
					</div>
					<div>
						<dt>Tree</dt>
						<dd>{treeLine(entry)}</dd>
					</div>
					<div>
						<dt>Runtime</dt>
						<dd>{runtimeLine(entry)}</dd>
					</div>
				</dl>

				{#if entry.summary}
					<dl class="stats" aria-label="Called sites">
						<div class="stat stat--test">
							<dt>q ≤ 0.10</dt>
							<dd>{fmt(entry.summary.called.q_le_0_10)}</dd>
						</div>
						<div class="stat stat--test">
							<dt>p ≤ 0.05</dt>
							<dd>{fmt(entry.summary.called.p_le_0_05)}</dd>
						</div>
						<div class="stat stat--rank">
							<dt>Top 5 %</dt>
							<dd>{fmt(entry.summary.called.top_5pct)}</dd>
						</div>
						<div class="stat">
							<dt>Max LRT</dt>
							<dd>{entry.summary.max_lrt.toFixed(2)}</dd>
						</div>
					</dl>
				{:else if entry.error}
					<p class="error">{entry.error}</p>
				{/if}

				<div class="card__actions">
					{#if entry.status === 'ok'}
						<a class="button" href={resultsHref(entry)}>View results</a>
					{:else}
						<span class="button" aria-disabled="true">View results</span>
					{/if}
					<span class="downloads">
						<a href={inputHref(entry.inputs.alignment)} download>{entry.inputs.alignment}</a>
						{#if entry.inputs.tree}
							· <a href={inputHref(entry.inputs.tree)} download>{entry.inputs.tree}</a>
						{/if}
					</span>
				</div>
			</li>
		{/each}
	</ul>

	<p class="footnote">
		"Top 5 %" is the app's default percentile tier: it always calls a fixed share of the variable
		sites, whether or not any is under selection. q ≤ 0.10 and p ≤ 0.05 are the MEME-mixture
		test the reference CLI reports; treat all three as a ranking to confirm with MEME on
		Datamonkey.
	</p>
</div>

<style>
	.intro {
		color: var(--text-muted);
		max-width: var(--container-narrow);
		margin-bottom: var(--space-3);
	}
	.provenance {
		font-size: var(--text-xs);
		color: var(--text-faint);
		margin-bottom: var(--space-6);
	}
	.provenance .hash {
		margin-left: var(--space-1);
	}

	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
		gap: var(--space-4);
	}

	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
		padding: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.card--unavailable {
		background: var(--bg-subtle);
	}
	.card__regime {
		margin: 0;
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent-strong);
	}
	.card__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.card h2 {
		margin: 0;
	}
	.badge {
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.1rem 0.6rem;
		white-space: nowrap;
	}
	.badge--danger {
		color: var(--danger);
		background: var(--danger-soft);
		border-color: transparent;
	}
	.gene {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.description {
		margin: var(--space-1) 0 0;
	}

	.facts {
		margin: var(--space-2) 0 0;
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm);
	}
	.facts div {
		display: grid;
		grid-template-columns: 6.5rem 1fr;
		gap: var(--space-2);
	}
	.facts dt {
		color: var(--text-faint);
	}
	.facts dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.faint {
		color: var(--text-faint);
	}

	.stats {
		margin: var(--space-3) 0 0;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-2);
	}
	.stat {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-raised);
	}
	.stat dt {
		font-size: var(--text-xs);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.stat dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-lg);
		line-height: 1.2;
	}
	.stat--test {
		border-top: 3px solid var(--brand);
	}
	.stat--rank {
		border-top: 3px solid var(--accent);
	}

	.card__actions {
		margin-top: auto;
		padding-top: var(--space-4);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.downloads {
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		color: var(--text-faint);
	}
	.error {
		margin: var(--space-2) 0 0;
		font-size: var(--text-sm);
		color: var(--danger);
	}

	.footnote {
		margin-top: var(--space-6);
		max-width: var(--container-narrow);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}

	@media (max-width: 40rem) {
		.stats {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
