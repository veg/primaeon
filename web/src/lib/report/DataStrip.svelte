<!--
	DataStrip.svelte — the compact "what we did to your data" line under the overview: diagnostics
	counted by severity, the automatic repairs named, expandable to Phase 1's full "Before you run"
	table.

	WHY THIS FILE EXISTS. PLAN.md §4.0: "The pre-run 'Before you run' panel becomes a compact 'what
	we did to your data' strip at the top of the report, expandable to the full warnings table."
	The diagnosis stored with the record is the library's `diagnose()` output the run started from;
	lib/diagnostics/panel.ts turns it into the same PanelModel the pre-run panel showed, and
	BeforeYouRun.svelte (routes/analyze) renders it unchanged inside the disclosure — one
	implementation of the table, two places it appears. The strip itself is derived here: counts
	by severity (handled codes counted as repairs), plus the preprocessing facts the provenance
	block records (duplicates collapsed, PD cap, tree source, rescaling), which are the "did".

	THE TREE SOURCE IS ALWAYS ON THE STRIP (D22), not only when something was done to it. Whether the
	model was given a tree's branch lengths or pairwise TN93 distances is the single fact that most
	changes how the rest of the report should be read, and under D22 it is decided silently by
	whether the input had usable lengths — so it is stated in the line the reader sees first, with
	the library's own reason and, when the distances were computed, how many taxon pairs came back
	at the saturation sentinel.
-->
<script lang="ts">
	import type { DiagnosisSnapshot, ReportRecord } from '$lib/api';
	import { treeFreeLabel, treeSourceLabel } from '$lib/api';
	import { panelModel, saturatedPairs } from '$lib/diagnostics/panel';
	import BeforeYouRun from '../../routes/analyze/BeforeYouRun.svelte';

	interface Props {
		record: ReportRecord;
	}
	let { record }: Props = $props();

	let open = $state(false);
	/**
	 * The page stores the library's `diagnose()` snapshot ({ok, warnings, summary}); the runtime's
	 * orchestrator (gallery / server records) writes {taxa_in_alignment, taxa_used, codon_count,
	 * preprocessing, warnings, refused}. Both carry the same `warnings[]`; the second is lifted into
	 * the first's shape so BeforeYouRun renders either.
	 */
	function toSnapshot(d: unknown): DiagnosisSnapshot | null {
		if (!d || typeof d !== 'object') return null;
		const o = d as Record<string, unknown>;
		if (!Array.isArray(o.warnings)) return null;
		if (typeof o.ok === 'boolean' && o.summary && typeof o.summary === 'object') return o as unknown as DiagnosisSnapshot;
		const pre = (o.preprocessing as Record<string, unknown> | undefined) ?? {};
		return {
			ok: !o.refused,
			warnings: o.warnings as DiagnosisSnapshot['warnings'],
			summary: {
				taxa: o.taxa_in_alignment,
				taxaUsed: o.taxa_used,
				codons: o.codon_count,
				treeSource: pre.tree_source ?? record.inputs.treeSource,
				...pre
			}
		};
	}
	const snapshot = $derived(toSnapshot(record.diagnostics));
	const model = $derived(panelModel(snapshot));
	const rows = $derived(model?.rows ?? []);
	const counts = $derived.by(() => {
		const c = { refuse: 0, warn: 0, info: 0, handled: 0 };
		for (const r of rows) {
			if (r.handled) c.handled++;
			else c[r.severity]++;
		}
		return c;
	});
	const pre = $derived(record.provenance?.preprocessing ?? record.sections.sites?.provenance?.preprocessing ?? null);
	/** The run's own tree source when it recorded one, else the source the inputs were planned with. */
	const treeSource = $derived((pre?.tree_source as string | undefined) ?? record.inputs.treeSource);
	// runtime/src/pipeline.js writes `tree_free: {reason, taxa_order}` (null when a tree was used);
	// the pre-run diagnosis is the fallback for a record that predates it.
	const treeFreeReason = $derived(
		((pre?.tree_free as { reason?: string } | null | undefined)?.reason ?? null) ??
			(model?.treePlan.kind === 'tree-free' ? model.treePlan.reason : null)
	);
	const treeLine = $derived(treeSource === 'tn93' ? treeFreeLabel(treeFreeReason) : treeSourceLabel(treeSource));
	const saturated = $derived(
		(typeof pre?.tn93_saturated_pairs === 'number' ? (pre.tn93_saturated_pairs as number) : null) ?? saturatedPairs(snapshot)
	);
	const repairs = $derived.by(() => {
		const out: string[] = [];
		if (!pre) return out;
		if (pre.duplicates_collapsed > 0) out.push(`${pre.duplicates_collapsed} duplicate sequence${pre.duplicates_collapsed === 1 ? '' : 's'} collapsed`);
		if (pre.pd_subsampled) out.push(`Faith's-PD cap to ${pre.taxa_used} taxa`);
		if (pre.distance_rescaled) out.push('patristic distances rescaled (max > 10)');
		if (pre.codons_trimmed > 0) out.push(`${pre.codons_trimmed} trailing nucleotide${pre.codons_trimmed === 1 ? '' : 's'} trimmed`);
		if (pre.dropped_taxa?.length) out.push(`${pre.dropped_taxa.length} taxa without a tree tip dropped`);
		return out;
	});
	const hasDiagnosis = $derived(snapshot != null);
</script>

<div class="strip" class:strip--open={open}>
	<div class="line">
		<span class="label">What we did to your data</span>
		{#if hasDiagnosis}
			<span class="counts">
				{#if counts.refuse}<span class="badge badge--refuse">{counts.refuse} refuse</span>{/if}
				{#if counts.warn}<span class="badge badge--warn">{counts.warn} warning{counts.warn === 1 ? '' : 's'}</span>{/if}
				{#if counts.info}<span class="badge badge--info">{counts.info} note{counts.info === 1 ? '' : 's'}</span>{/if}
				{#if counts.handled}<span class="badge badge--ok">{counts.handled} handled</span>{/if}
				{#if !rows.length}<span class="badge badge--ok">no findings</span>{/if}
			</span>
		{:else}
			<span class="muted">No diagnostics stored with this record.</span>
		{/if}
		<span class="tree" title="How the model got its distances (PLAN.md D22)">{treeLine}</span>
		{#if saturated}
			<span class="badge badge--warn">{saturated.toLocaleString()} saturated pair{saturated === 1 ? '' : 's'}</span>
		{/if}
		{#if repairs.length}
			<span class="repairs">{repairs.join(' · ')}</span>
		{:else if pre}
			<span class="muted">No automatic repairs were needed.</span>
		{/if}
		{#if hasDiagnosis}
			<button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
				{open ? 'Hide the checks' : 'Show all checks'}
			</button>
		{/if}
	</div>
	{#if open && hasDiagnosis}
		<div class="full">
			<BeforeYouRun {model} prescreen={null} pending={false} variant={record.options.variant} onVariant={() => {}} />
		</div>
	{/if}
</div>

<style>
	.strip {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-raised);
		padding: var(--space-2) var(--space-4);
		font-size: var(--text-sm);
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.label {
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.counts {
		display: inline-flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.badge {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		font-weight: 600;
		font-size: var(--text-xs);
		white-space: nowrap;
	}
	.badge--refuse {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.badge--warn {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.badge--info {
		background: var(--bg-subtle);
		color: var(--text-muted);
	}
	.badge--ok {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.repairs {
		color: var(--text);
	}
	.tree {
		color: var(--text);
		font-weight: 600;
	}
	.muted {
		color: var(--text-faint);
	}
	.toggle {
		margin-left: auto;
		background: none;
		border: 0;
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
		font-size: var(--text-sm);
		padding: 0;
	}
	.full {
		margin-top: var(--space-3);
	}
</style>
