<!--
	DataStrip.svelte — the "what we did to your data" line under the overview: diagnostics counted
	by severity in words, the automatic repairs named, the tree source, expandable to the full
	warnings table.

	WHY THIS FILE EXISTS. PLAN.md §4.0: "The pre-run 'Before you run' panel becomes a compact 'what
	we did to your data' strip at the top of the report, expandable to the full warnings table."
	The diagnosis stored with the record is the library's `diagnose()` output the run started from;
	lib/diagnostics/panel.ts turns it into the same PanelModel the pre-run panel shows, and the
	strip prints its rows: counts by severity (handled codes counted as repairs) in the one-line
	summary, and the rows themselves — severity, code, message — in the table the disclosure opens.
	The preprocessing facts the provenance block records (duplicates collapsed, PD cap, tree
	source, rescaling) are the "did".

	THE TREE SOURCE IS ALWAYS ON THE STRIP (D22), not only when something was done to it. Whether the
	model was given a tree's branch lengths or pairwise TN93 distances is the single fact that most
	changes how the rest of the report should be read, and under D22 it is decided silently by
	whether the input had usable lengths — so it is stated in the line the reader sees first, with
	the library's own reason and, when the distances were computed, how many taxon pairs came back
	at the saturation sentinel.

	SET AS A SENTENCE (web/DESIGN.md §3): a `details.strip` whose summary is the sentence, no panel,
	no badges; counts take the warning colour only when warnings exist, and a refusal is black.
	`.strip .tree` keeps its exact text — the e2e asserts it verbatim.
-->
<script lang="ts">
	import type { DiagnosisSnapshot, ReportRecord } from '$lib/api';
	import { treeFreeLabel, treeSourceLabel } from '$lib/api';
	import { panelModel, saturatedPairs } from '$lib/diagnostics/panel';

	interface Props {
		record: ReportRecord;
	}
	let { record }: Props = $props();

	/**
	 * The page stores the library's `diagnose()` snapshot ({ok, warnings, summary}); the runtime's
	 * orchestrator (gallery / server records) writes {taxa_in_alignment, taxa_used, codon_count,
	 * preprocessing, warnings, refused}. Both carry the same `warnings[]`; the second is lifted into
	 * the first's shape so the panel model reads either.
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
	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	const SEVERITY_LABEL: Record<string, string> = { refuse: 'refused', warn: 'warning', info: 'note' };
</script>

<details class="strip">
	<summary>
		<strong>What we did to your data.</strong>
		{#if hasDiagnosis}
			{#if counts.refuse}<span class="refuse">{plural(counts.refuse, 'refusal')}</span>, {/if}{#if counts.warn}<span class="warnline">{plural(counts.warn, 'warning')}</span>{:else}no warnings{/if},
			{counts.info ? plural(counts.info, 'note') : 'no notes'}{#if counts.handled}, {plural(counts.handled, 'check')} handled{/if}{#if !rows.length}, no findings{/if}.
		{:else}
			No diagnostics stored with this record.
		{/if}
		Distances: <span class="tree" title="How the model got its distances (PLAN.md D22)">{treeLine}</span>.
		{#if saturated}
			<span class="warnline">{plural(saturated, 'taxon pair', 'taxon pairs')} at the TN93 saturation sentinel.</span>
		{/if}
		{#if repairs.length}
			Repairs: {repairs.join(', ')}.
		{:else if pre}
			No automatic repairs were needed.
		{/if}
		{#if pre?.reference_sequence}Reference {pre.reference_sequence}.{/if}
		{#if model?.regime}{model.regime}{/if}
	</summary>
	{#if hasDiagnosis}
		{#if rows.length}
			<table class="checks">
				<thead><tr><th>Severity</th><th>Code</th><th>Message</th></tr></thead>
				<tbody>
					{#each rows as r, i (r.code + i)}
						<tr>
							<td><span class="sev" class:sev--warn={r.severity === 'warn' && !r.handled} class:sev--refuse={r.severity === 'refuse'}>{r.handled ? 'handled' : SEVERITY_LABEL[r.severity] ?? r.severity}</span></td>
							<td class="mono">{r.code}</td>
							<td>{r.message}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="note">No findings.</p>
		{/if}
	{/if}
</details>

<style>
	.strip {
		font-size: var(--text-md);
		color: var(--text-muted);
		margin: 0 0 var(--space-8);
		max-width: none;
	}
	summary {
		color: var(--text-muted);
		max-width: var(--measure);
	}
	summary strong {
		color: var(--text);
	}
	.tree {
		color: var(--text);
	}
	.refuse {
		color: var(--text);
		font-weight: 700;
	}
	.warnline {
		color: var(--warn);
	}
	.warnline::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--warn-mark);
		margin-right: 0.4em;
		vertical-align: 0.05em;
	}
	.checks {
		margin-top: var(--space-3);
		max-width: 60rem;
	}
	.checks th:first-child,
	.checks td:first-child {
		width: 6rem;
	}
	.checks td:nth-child(2) {
		white-space: nowrap;
	}
	.sev {
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
	.sev--refuse {
		color: var(--text);
		font-weight: 700;
	}
	.note {
		margin: var(--space-3) 0 0;
	}
</style>
