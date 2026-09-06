<!--
	DmsSection.svelte — the digital DMS body: progress with Cancel while it runs, the heatmap
	filling progressively, the plasticity track, a click-a-site detail of the 19 deltas, and the
	"skipped: over budget" state.

	WHY THIS FILE EXISTS. PLAN.md §4.0 row 7: DMS is the expensive analysis, so it "runs last, in
	the background, filling the heatmap progressively, cancellable, capped by work; above the cap
	the report says so and offers the server". The section payload's `progress` (app-side) drives
	the bar; `cancelled` and `skipped` are the two ways it ends early, each with its own sentence.
	The detail table lists the 19 substitutions of the selected site sorted by ΔLRT, with the
	reference's per-site reductions (intrinsic plasticity = mean |Δ|, mean / max / min Δ, the
	baseline's Self–Liang p) beside them.

	The native `<progress>` stays (it carries a real value; the e2e reads `#dms progress`), drawn
	2 px tall in the brand colour. A cancelled scan is a genuine warning — the scan is incomplete —
	and keeps `.note--warn`; a skipped scan is a fact and is set as a plain note (web/DESIGN.md §3).
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
	const scale = $derived(detail ? Math.max(1e-9, Math.abs(detail.max_delta_lrt), Math.abs(detail.min_delta_lrt)) : 1);
	const topSites = $derived([...dms.plasticity].sort((a, b) => b.intrinsic_plasticity - a.intrinsic_plasticity).slice(0, 8));
	const fmt = (v: number, dp = 3) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
	const fmtSigned = (v: number, dp = 3) => (Number.isFinite(v) ? (v > 0 ? `+${v.toFixed(dp)}` : v.toFixed(dp)) : '—');
</script>

{#if skipped}
	<p class="note" role="status">
		<strong>Skipped: over the browser's work budget.</strong>
		{skipped.reason}
		{#if skipped.work > 0}
			The scan needs about {skipped.work.toExponential(2)} units of forward-pass work (19 · L · N²); this browser's cap is
			{skipped.budget.toExponential(2)}.
		{/if}
	</p>
	<p class="note">
		Run it on the server: the same runtime under <code>onnxruntime-node</code> accepts inputs past the browser caps
		(PLAN.md §3.5), or reproduce it with the MCP call in the provenance section (<code>"dms": true</code>).
		The "Re-run with…" disclosure can also raise the budget for a machine that can take it.
	</p>
{:else}
	<p class="lede">
		Every site of the focal taxon <span class="mono">{dms.focal_taxon || record.sections.sites?.alignment?.names[0] || 'taxa[0]'}</span> is
		substituted in silico by each of the 19 other residues (as their canonical codon) and re-scored; the cell is
		the change in predicted LRT. Positive means the substitution would increase the selection signal.
		{dms.total_mutations ? `${dms.total_mutations.toLocaleString()} mutants in total.` : ''}
	</p>

	{#if running || (progress.total > 0 && progress.done < progress.total && !dms.cancelled)}
		<div class="progress" role="group" aria-label="DMS progress">
			<progress max={Math.max(1, progress.total)} value={progress.done}></progress>
			<span class="progress__text"><span class="mark--run" aria-hidden="true"></span>Running: {progress.done.toLocaleString()} of {progress.total.toLocaleString()} sites ({pct} %).</span>
			{#if running && onCancel}
				<button type="button" class="button button--secondary" onclick={onCancel}>Cancel the scan</button>
			{/if}
		</div>
	{/if}
	{#if dms.cancelled}
		<p class="note note--warn"><strong>Cancelled after {dms.plasticity.length.toLocaleString()} of {L.toLocaleString()} sites.</strong> The heatmap shows what finished; every other section is complete.</p>
	{:else if dms.capped}
		<p class="note note--warn"><strong>{dms.reason ?? 'Capped to fit the work budget'}.</strong> The sites with the highest LRT were swept first.</p>
	{/if}

	<DmsHeatmap plasticity={dms.plasticity} {L} {selected} onSelect={(s) => (selected = s)} />

	<div class="below">
		<div class="detail">
			<h3>{detail ? `Site ${detail.site} (${detail.wt_aa})` : 'Site detail'}</h3>
			{#if detail}
				<dl class="facts">
					<dt>Baseline LRT</dt><dd class="num">{fmt(detail.baseline_lrt)}</dd>
					<dt>p (Self–Liang)</dt><dd class="num">{detail.p_value < 1e-4 ? detail.p_value.toExponential(2) : fmt(detail.p_value, 4)}</dd>
					<dt>Intrinsic plasticity</dt><dd class="num">{fmt(detail.intrinsic_plasticity)}</dd>
					<dt>Mean Δ</dt><dd class="num">{fmtSigned(detail.mean_delta_lrt)}</dd>
					<dt>Max Δ</dt><dd class="num">{fmtSigned(detail.max_delta_lrt)}</dd>
					<dt>Min Δ</dt><dd class="num">{fmtSigned(detail.min_delta_lrt)}</dd>
				</dl>
				<table class="deltas">
					<caption><b></b>The 19 substitutions at site {detail.site}, by ΔLRT (mutant − baseline), largest first. The bar is |Δ| against the site's largest |Δ|; purple bars are positive, grey negative.</caption>
					<thead><tr><th>Substitution</th><th class="num">ΔLRT</th><th><span class="visually-hidden">Magnitude</span></th></tr></thead>
					<tbody>
						{#each deltas as [aa, d] (aa)}
							<tr>
								<td class="mono">{detail.wt_aa}→{aa}</td>
								<td class="num">{fmtSigned(d)}</td>
								<td class="barcell"><span class="bar" class:bar--neg={d < 0} style="width: {Math.min(100, (Math.abs(d) / scale) * 100)}%"></span></td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="hint"><button type="button" class="link" onclick={() => onSelect(detail!.site)}>Open site {detail.site} in the tree</button></p>
			{:else}
				<p class="hint">Click a column of the heatmap, or a site in the list, to see its 19 substitutions.</p>
			{/if}
		</div>
		<div class="top">
			<h3>Most plastic sites</h3>
			{#if topSites.length}
				<ol>
					{#each topSites as p (p.site)}
						<li><button type="button" class="link" onclick={() => (selected = p.site)}>{p.wt_aa}{p.site}</button> <span class="num">{fmt(p.intrinsic_plasticity)}</span></li>
					{/each}
				</ol>
				<p class="hint">Intrinsic plasticity is the mean |ΔLRT| over a site's 19 substitutions.</p>
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
	}
	.progress {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	progress {
		flex: 1 1 14rem;
		height: 2px;
		accent-color: var(--brand);
		background: var(--hair);
		border: 0;
	}
	progress::-webkit-progress-bar {
		background: var(--hair);
	}
	progress::-webkit-progress-value {
		background: var(--brand);
	}
	progress::-moz-progress-bar {
		background: var(--brand);
	}
	.progress .button {
		padding: 0.15rem 0.6rem;
	}
	.below {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: var(--space-6);
	}
	@media (max-width: 48em) {
		.below {
			grid-template-columns: 1fr;
		}
	}
	h3 {
		margin: 0 0 var(--space-3);
	}
	.facts {
		margin: 0 0 var(--space-4);
		display: grid;
		grid-template-columns: max-content max-content;
		column-gap: var(--space-5);
		row-gap: 0.2rem;
		font-size: var(--text-md);
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		text-align: right;
	}
	.deltas {
		margin-bottom: var(--space-3);
	}
	.deltas td.num {
		width: 6rem;
	}
	.barcell {
		width: 40%;
		vertical-align: middle;
	}
	.bar {
		display: block;
		height: 0.4rem;
		background: var(--dms-positive);
	}
	.bar--neg {
		background: var(--dms-negative);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.top ol {
		margin: 0 0 var(--space-3);
		padding-left: 1.2rem;
		font-size: var(--text-md);
		display: grid;
		gap: 0.2rem;
	}
	.top li {
		max-width: 12rem;
	}
	.top li .num {
		float: right;
		color: var(--text-muted);
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--brand);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
	}
	.link:hover {
		text-decoration-thickness: 2px;
	}
	.link:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
</style>
