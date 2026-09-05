<!--
	DmsSection.svelte — the digital DMS body: progress bar with Cancel while it runs, the heatmap
	filling progressively, the plasticity track, a click-a-site detail of the 19 deltas, and the
	"skipped: over budget" state.

	WHY THIS FILE EXISTS. PLAN.md §4.0 row 7: DMS is the expensive analysis, so it "runs last, in
	the background, filling the heatmap progressively, cancellable, capped by work; above the cap
	the report says so and offers the server". The section payload's `progress` (app-side) drives
	the bar; `cancelled` and `skipped` are the two ways it ends early, each with its own sentence.
	The detail table lists the 19 substitutions of the selected site sorted by ΔLRT, with the
	reference's per-site reductions (intrinsic plasticity = mean |Δ|, mean / max / min Δ, the
	baseline's Self–Liang p) beside them.
-->
<script lang="ts">
	import type { ReportRecord } from '$lib/api';
	import { dmsSkipped, type DmsSection } from '$lib/report/types';
	import DmsHeatmap from '$lib/viz/DmsHeatmap.svelte';

	interface Props {
		record: ReportRecord;
		dms: DmsSection;
		running: boolean;
		onCancel: (() => void) | null;
		onSelect: (site: number) => void;
	}
	let { record, dms, running, onCancel, onSelect }: Props = $props();

	let selected = $state<number | null>(null);
	const skipped = $derived(dmsSkipped(dms));
	const L = $derived(record.sections.sites?.sites.length ?? (dms.total_mutations ? Math.round(dms.total_mutations / 19) : dms.plasticity.length));
	const progress = $derived(dms.progress ?? { done: dms.plasticity.length, total: L });
	const pct = $derived(progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0);
	const detail = $derived(selected == null ? null : (dms.plasticity.find((p) => p.site === selected) ?? null));
	const deltas = $derived(detail ? Object.entries(detail.mutant_deltas).sort((a, b) => b[1] - a[1]) : []);
	const topSites = $derived([...dms.plasticity].sort((a, b) => b.intrinsic_plasticity - a.intrinsic_plasticity).slice(0, 8));
	const fmt = (v: number, dp = 3) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
</script>

{#if skipped}
	<div class="over" role="status">
		<p>
			<strong>Skipped: over the browser's work budget.</strong>
			{skipped.reason}
			{#if skipped.work > 0}
				The scan needs about {skipped.work.toExponential(2)} units of forward-pass work (19 · L · N²); this browser's cap is
				{skipped.budget.toExponential(2)}.
			{/if}
		</p>
		<p class="hint">
			Run it on the server: the same runtime under <code>onnxruntime-node</code> accepts inputs past the browser caps
			(PLAN.md §3.5), or reproduce it with the MCP call in the provenance section (<code>"dms": true</code>).
			The "Re-run with…" disclosure can also raise the budget for a machine that can take it.
		</p>
	</div>
{:else}
	<p class="lede">
		Every site of the focal taxon <span class="mono">{dms.focal_taxon || record.sections.sites?.alignment?.names[0] || 'taxa[0]'}</span> is
		substituted in silico by each of the 19 other residues (as their canonical codon) and re-scored; the cell is
		the change in predicted LRT. Positive means the substitution would <em>increase</em> the selection signal.
		{dms.total_mutations ? `${dms.total_mutations.toLocaleString()} mutants in total.` : ''}
	</p>

	{#if running || (progress.total > 0 && progress.done < progress.total && !dms.cancelled)}
		<div class="progress" role="group" aria-label="DMS progress">
			<progress max={Math.max(1, progress.total)} value={progress.done}></progress>
			<span class="mono">{progress.done.toLocaleString()} / {progress.total.toLocaleString()} sites ({pct}%)</span>
			{#if running && onCancel}
				<button type="button" class="button button--secondary" onclick={onCancel}>Cancel the scan</button>
			{/if}
		</div>
	{/if}
	{#if dms.cancelled}
		<p class="note note--warn">Cancelled after {dms.plasticity.length.toLocaleString()} of {L.toLocaleString()} sites; the heatmap shows what finished. Every other section is complete.</p>
	{:else if dms.capped}
		<p class="note note--warn">{dms.reason ?? 'Capped to fit the work budget'}: the sites with the highest LRT were swept first.</p>
	{/if}

	<DmsHeatmap plasticity={dms.plasticity} {L} {selected} onSelect={(s) => (selected = s)} />

	<div class="below">
		<div class="detail">
			<h3>{detail ? `Site ${detail.site} (${detail.wt_aa})` : 'Site detail'}</h3>
			{#if detail}
				<dl class="facts">
					<div><dt>Baseline LRT</dt><dd class="num">{fmt(detail.baseline_lrt)}</dd></div>
					<div><dt>p (Self–Liang)</dt><dd class="num">{detail.p_value < 1e-4 ? detail.p_value.toExponential(2) : fmt(detail.p_value, 4)}</dd></div>
					<div><dt>Intrinsic plasticity</dt><dd class="num">{fmt(detail.intrinsic_plasticity)}</dd></div>
					<div><dt>Mean Δ</dt><dd class="num">{fmt(detail.mean_delta_lrt)}</dd></div>
					<div><dt>Max Δ</dt><dd class="num">{fmt(detail.max_delta_lrt)}</dd></div>
					<div><dt>Min Δ</dt><dd class="num">{fmt(detail.min_delta_lrt)}</dd></div>
				</dl>
				<div class="scroll">
					<table class="deltas">
						<thead><tr><th>Substitution</th><th>ΔLRT</th><th></th></tr></thead>
						<tbody>
							{#each deltas as [aa, d] (aa)}
								<tr>
									<td class="mono">{detail.wt_aa}→{aa}</td>
									<td class="num">{fmt(d)}</td>
									<td class="barcell"><span class="bar" class:bar--neg={d < 0} style="width: {Math.min(100, (Math.abs(d) / Math.max(1e-9, Math.max(Math.abs(detail.max_delta_lrt), Math.abs(detail.min_delta_lrt)))) * 100)}%"></span></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="hint"><button type="button" class="link" onclick={() => onSelect(detail!.site)}>Open site {detail.site} in the tree</button></p>
			{:else}
				<p class="hint">Click a column of the heatmap, or a site below, to see its 19 substitutions.</p>
			{/if}
		</div>
		<div class="top">
			<h3>Most plastic sites</h3>
			{#if topSites.length}
				<ol>
					{#each topSites as p (p.site)}
						<li><button type="button" class="link mono" onclick={() => (selected = p.site)}>{p.wt_aa}{p.site}</button> <span class="num">{fmt(p.intrinsic_plasticity)}</span></li>
					{/each}
				</ol>
			{:else}
				<p class="hint">No site scored yet.</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.lede,
	.note,
	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.note--warn {
		color: var(--warn);
		background: var(--warn-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
	}
	.over {
		border: 1px solid var(--warn);
		background: var(--warn-soft);
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
	}
	.over p {
		margin: 0 0 var(--space-2);
	}
	.progress {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	progress {
		flex: 1 1 14rem;
		height: 0.6rem;
		accent-color: var(--brand);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.below {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: var(--space-4);
	}
	@media (max-width: 48rem) {
		.below {
			grid-template-columns: 1fr;
		}
	}
	h3 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
	}
	.facts {
		margin: 0 0 var(--space-3);
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: var(--space-2);
	}
	.facts div {
		display: flex;
		flex-direction: column;
	}
	dt {
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.scroll {
		max-height: 22rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.deltas {
		font-size: var(--text-sm);
	}
	.deltas th {
		position: sticky;
		top: 0;
		background: var(--bg-subtle);
	}
	.deltas td.num {
		text-align: right;
		width: 6rem;
	}
	.barcell {
		width: 40%;
	}
	.bar {
		display: block;
		height: 0.6rem;
		border-radius: 999px;
		background: var(--accent);
	}
	.bar--neg {
		background: #2166ac;
	}
	.top ol {
		margin: 0;
		padding-left: 1.2rem;
		font-size: var(--text-sm);
		display: grid;
		gap: 0.2rem;
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--link);
		text-decoration: underline;
	}
</style>
