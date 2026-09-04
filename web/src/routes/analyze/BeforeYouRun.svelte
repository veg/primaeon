<!--
	BeforeYouRun.svelte — the pre-run panel: the diagnostics table with severities, the regime
	line, the variant suggestion, the tree plan, the prescreen band, and the cost estimate.

	WHY THIS FILE EXISTS. PLAN.md §4.3 lists the checks and their outcomes; the library computes
	them (`diagnose`, in the prep worker) and lib/diagnostics/panel.ts decides what they mean for
	the app (which refusals block, which the tree tools handle, which variant to suggest). This
	component only renders that model. Two rules from the plan are visible in the markup: a
	refuse-severity row that the runtime cannot recover from is shown with the reason the Run
	button is disabled, and the MEME hit-likelihood prescreen is an ADVISORY band — it says what
	similar alignments did in full MEME runs and never gates anything (runtime/src/prescreen).
-->
<script lang="ts">
	import type { Variant } from '$lib/api';
	import {
		PRESCREEN_BAND,
		formatSeconds,
		type PanelModel,
		type PrescreenResult
	} from '$lib/diagnostics/panel';

	let {
		model,
		prescreen,
		pending,
		variant,
		onVariant
	}: {
		model: PanelModel | null;
		prescreen: PrescreenResult | null;
		/** True while a diagnosis is being recomputed (inputs changed). */
		pending: boolean;
		variant: Variant;
		onVariant: (v: Variant) => void;
	} = $props();

	const severityLabel: Record<string, string> = { refuse: 'Refuse', warn: 'Warn', info: 'Info' };

	function treePlanText(m: PanelModel): string {
		switch (m.treePlan.kind) {
			case 'user':
				return 'Uploaded tree with branch lengths.';
			case 'embedded':
				return 'Tree embedded in the alignment, with branch lengths.';
			case 'estimate-branch-lengths':
				return 'The tree has no branch lengths: HKY85 lengths will be fitted in HyPhy WASM before scoring.';
			case 'infer':
				return 'No tree supplied: a neighbour-joining tree (TN93 distances) will be inferred in HyPhy WASM.';
			default:
				return 'No usable tree.';
		}
	}

	function bytesMb(b: number): string {
		return `${(b / 1e6).toFixed(0)} MB`;
	}
</script>

<section class="panel" aria-labelledby="byr-title" aria-busy={pending}>
	<div class="panel__head">
		<h2 id="byr-title">Before you run</h2>
		{#if pending}
			<span class="pending">checking…</span>
		{/if}
	</div>

	{#if !model}
		<p class="muted">Load an alignment to see the checks.</p>
	{:else}
		{#if model.regime}
			<p class="regime"><strong>Regime:</strong> {model.regime}</p>
		{/if}

		<p class="plan"><strong>Tree:</strong> {treePlanText(model)}</p>

		<p class="suggestion">
			<strong>Variant:</strong>
			the diagnostics suggest <em>{model.suggestedVariant}</em>{#if model.suggestionReason}&nbsp;({model.suggestionReason}){/if}.
			{#if variant !== model.suggestedVariant}
				You have <em>{variant}</em> selected.
				<button type="button" class="linkbutton" onclick={() => onVariant(model!.suggestedVariant)}>
					Use {model.suggestedVariant}
				</button>
			{/if}
		</p>

		{#if model.rows.length}
			<div class="tablewrap">
				<table class="warnings">
					<thead>
						<tr><th>Severity</th><th>Check</th><th>Finding</th></tr>
					</thead>
					<tbody>
						{#each model.rows as row (row.code + row.message)}
							<tr class="row row--{row.severity}" class:row--handled={row.handled}>
								<td>
									<span class="badge badge--{row.severity}">{row.handled ? 'Handled' : severityLabel[row.severity]}</span>
								</td>
								<td><code>{row.code}</code></td>
								<td>{row.message}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="muted">No findings.</p>
		{/if}

		{#if model.blocking.length}
			<p class="block" role="alert">
				<strong>Run is disabled:</strong>
				{model.blocking.map((b) => b.message).join(' ')}
			</p>
		{/if}

		{#if prescreen && prescreen.status !== 'not-applicable'}
			<div class="prescreen prescreen--{prescreen.level ?? prescreen.status}">
				{#if prescreen.status === 'ok' && prescreen.level}
					<p class="prescreen__head">
						<strong>{PRESCREEN_BAND[prescreen.level].label}</strong>
						<span class="muted">(advisory; MEME hit-likelihood {prescreen.hit_probability !== null ? (prescreen.hit_probability * 100).toFixed(0) + '%' : ''})</span>
					</p>
					<p class="muted small">{PRESCREEN_BAND[prescreen.level].lead} {prescreen.caveat}</p>
					{#if prescreen.tree_source_caveat}
						<p class="muted small">{prescreen.tree_source_caveat}</p>
					{/if}
				{:else if prescreen.status === 'cannot-assess'}
					<p class="prescreen__head"><strong>MEME hit-likelihood not assessed</strong></p>
					<p class="muted small">{prescreen.detail}</p>
				{:else if prescreen.status === 'error'}
					<p class="muted small">The hit-likelihood estimate could not be computed.</p>
				{/if}
			</div>
		{/if}

		{#if model.cost}
			<p class="cost">
				<strong>Cost here:</strong>
				{model.cost.L.toLocaleString()} codons × {model.cost.N} taxa — about
				{formatSeconds(model.cost.secondsLow)}–{formatSeconds(model.cost.secondsHigh)} of scoring in this browser,
				plus {bytesMb(model.cost.firstRunDownloadBytes)} of model and runtime on the first run.
				{#if model.cost.exceedsCaps.codons || model.cost.exceedsCaps.work}
					<span class="over">This exceeds the browser caps (codons ≤ 30,000; L·N² ≤ 2.5×10⁹); a server run is not available yet.</span>
				{/if}
			</p>
		{/if}
	{/if}
</section>

<style>
	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface-raised);
		padding: var(--space-4) var(--space-5);
		display: grid;
		gap: var(--space-3);
	}
	.panel__head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	.panel__head h2 {
		margin: 0;
	}
	.pending {
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
	p {
		margin: 0;
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: var(--text-xs);
	}
	.linkbutton {
		background: none;
		border: 0;
		padding: 0;
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
		font-size: inherit;
	}
	.tablewrap {
		overflow-x: auto;
	}
	.warnings {
		font-size: var(--text-xs);
	}
	.warnings th,
	.warnings td {
		padding: var(--space-1) var(--space-2);
	}
	.row--handled {
		color: var(--text-muted);
	}
	.badge {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-weight: 600;
		font-size: 0.7rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
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
	.row--handled .badge {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.block {
		color: var(--danger);
		background: var(--danger-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
	}
	.prescreen {
		border-left: 3px solid var(--border-strong);
		padding-left: var(--space-3);
		display: grid;
		gap: var(--space-1);
	}
	.prescreen--likely {
		border-color: var(--ok);
	}
	.prescreen--uncertain {
		border-color: var(--warn);
	}
	.prescreen--unlikely {
		border-color: var(--danger);
	}
	.prescreen__head {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.over {
		display: block;
		color: var(--warn);
	}
</style>
