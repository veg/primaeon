<!--
	+page.svelte (/gallery) — the bundled examples as cards.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "Six bundled examples with prebaked results." Five ship an
	alignment (Smc6, bat OAS1, camelid, HIV-1 RT, rhodopsin with its embedded tree); three more
	(β-globin, rbcL, REDIC1) ship epistasis results without an alignment and are marked "results
	only". Data comes from static/gallery/index.json via +page.ts. Opening a result and re-running an
	example in the browser are Phase 1; the cards say so rather than pretending.
-->
<script lang="ts">
	import type { GalleryEntry, Pillar } from '$lib/gallery/types';

	let { data } = $props();

	const PILLAR_LABEL: Record<Pillar, string> = {
		meme: 'Site selection',
		busted: 'Omnibus',
		epistasis: 'Epistasis',
		dms: 'Digital DMS',
		phenotype: 'Phenotype'
	};

	function dims(entry: GalleryEntry): string {
		if (entry.taxa === null || entry.codons === null) return 'dimensions not recorded';
		return `${entry.taxa.toLocaleString()} taxa × ${entry.codons.toLocaleString()} codons`;
	}

	function treeLabel(entry: GalleryEntry): string {
		switch (entry.tree) {
			case 'file':
				return 'Newick tree bundled';
			case 'embedded':
				return 'tree embedded in the NEXUS file';
			case 'none':
				return 'no alignment or tree bundled';
		}
	}
</script>

<svelte:head>
	<title>Gallery · HyphAeon</title>
</svelte:head>

<div class="container">
	<p class="eyebrow">Gallery</p>
	<h1>Bundled examples</h1>
	<p class="intro">
		The datasets that ship with <code>veg/HyphAeon</code> (commit
		<code>{data.index.engine_commit}</code>), with the reference implementation's results. Each
		full example can be re-run in this browser once the pipeline lands; each result will open in
		the same viewer the analyzer uses.
	</p>

	<ul class="grid" aria-label="Examples">
		{#each data.index.entries as entry (entry.id)}
			<li class="card" class:card--results-only={entry.kind === 'results-only'}>
				<div class="card__head">
					<h2>{entry.name}</h2>
					{#if entry.kind === 'results-only'}
						<span class="badge">results only</span>
					{/if}
				</div>
				<p class="gene">{entry.gene}</p>
				<p class="description">{entry.description}</p>
				<dl class="facts">
					<div>
						<dt>Size</dt>
						<dd>{dims(entry)}</dd>
					</div>
					<div>
						<dt>Tree</dt>
						<dd>{treeLabel(entry)}</dd>
					</div>
					{#if entry.reference_seconds}
						<div>
							<dt>Reference CPU time</dt>
							<dd>
								{Object.entries(entry.reference_seconds)
									.map(([pillar, s]) => `${PILLAR_LABEL[pillar as Pillar]} ${s}s`)
									.join(' · ')}
							</dd>
						</div>
					{/if}
				</dl>
				<ul class="chips" aria-label="Prebaked results">
					{#each entry.analyses as pillar (pillar)}
						<li class="chip chip--{pillar}">{PILLAR_LABEL[pillar]}</li>
					{/each}
				</ul>
				<div class="card__actions">
					<button class="button button--secondary" type="button" disabled>
						View results
					</button>
					{#if entry.kind === 'full'}
						<button class="button button--secondary" type="button" disabled>
							Run in browser
						</button>
					{/if}
				</div>
				<p class="soon">Viewer and in-browser runs arrive in Phase 1.</p>
			</li>
		{/each}
	</ul>
</div>

<style>
	.intro {
		color: var(--text-muted);
		max-width: var(--container-narrow);
		margin-bottom: var(--space-6);
	}

	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
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
	.card--results-only {
		background: var(--bg-subtle);
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
		color: var(--accent-strong);
		background: var(--accent-soft);
		border-radius: 999px;
		padding: 0.1rem 0.6rem;
		white-space: nowrap;
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
		grid-template-columns: 9rem 1fr;
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

	.chips {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.chip {
		font-size: var(--text-xs);
		font-weight: 600;
		border-radius: 999px;
		padding: 0.15rem 0.6rem;
		background: var(--brand-soft);
		color: var(--brand);
	}

	.card__actions {
		margin-top: auto;
		padding-top: var(--space-3);
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.soon {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
</style>
