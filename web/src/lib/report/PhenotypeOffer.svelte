<!--
	PhenotypeOffer.svelte — the phenotype section as an offer, not an analysis.

	WHY THIS FILE EXISTS. PLAN.md §4.0 row 8: "Phenotype (PhyloWAS) needs a trait, so it cannot run
	unasked: the report offers 'Have a phenotype? Mark foreground taxa on the tree or paste a list'
	… and runs on demand." The pillar's port is Phase 3 (PHASE2A gaps: phenotype.py and the
	permulations are the uncovered fixtures), so the panel renders the offer with the foreground
	picker disabled and says when it lands, rather than a form that does nothing. The taxa list is
	shown so a reader can see what a foreground set would be picked from.
-->
<script lang="ts">
	import type { ReportRecord } from '$lib/api';

	interface Props {
		record: ReportRecord;
	}
	let { record }: Props = $props();

	const taxa = $derived(record.sections.sites?.alignment?.names ?? []);
</script>

<div class="offer">
	<p class="lede">
		<strong>Have a phenotype?</strong> Mark the foreground taxa on the tree or paste a list of names (or a
		continuous trait as a CSV) and HyphAeon tests, site by site, whether the selection signal tracks the trait
		— phylogenetically corrected, with permulations for the null, trait sectors, and a gene-level card.
	</p>
	<div class="form" aria-disabled="true">
		<label class="field">
			<span>Foreground taxa</span>
			<textarea rows="3" disabled placeholder={taxa.slice(0, 3).join('\n') || 'taxon_1\ntaxon_2'}></textarea>
		</label>
		<div class="actions">
			<button type="button" class="button" disabled title="Phenotype association lands in Phase 3">Pick on the tree</button>
			<button type="button" class="button button--secondary" disabled title="Phenotype association lands in Phase 3">Run phenotype association</button>
		</div>
	</div>
	<p class="hint">
		Phenotype association (<code>hyphaeon phenotype</code>) lands in Phase 3 of the plan; the picker is disabled until
		the pillar's port is in the library. Presets appear here when the taxa match a preset's species.
		{#if taxa.length}This alignment has {taxa.length} taxa to choose from.{/if}
	</p>
</div>

<style>
	.offer {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.lede,
	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.form {
		display: grid;
		gap: var(--space-3);
		opacity: 0.7;
	}
	.field {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	textarea {
		width: 100%;
		max-width: 28rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		padding: var(--space-2) var(--space-3);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
