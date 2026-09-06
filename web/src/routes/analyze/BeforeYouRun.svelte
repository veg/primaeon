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

	LOOK. web/DESIGN.md §3 "Diagnostics strip and warnings table": no panel, no fills. The severity
	badges are plain text — a warning carries the orange square and warning text, a refusal is
	black, an info row is faint; "handled" rows are muted. The blocking message is a refusal: black
	with a black left rule. The prescreen is prose with its band label in 700 and no colour, since
	it is advisory and gates nothing.
-->
<script lang="ts">
	import type { Variant } from '$lib/api';
	import {
		PRESCREEN_BAND,
		formatSeconds,
		treePlanText,
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

		<p class="plan">
			<strong>Tree:</strong> {treePlanText(model.treePlan)}
			{#if model.saturatedPairs}
				<span class="saturated note--warn">{model.saturatedPairs.toLocaleString()} taxon pair{model.saturatedPairs === 1 ? '' : 's'} came back at the TN93 saturation sentinel.</span>
			{/if}
		</p>

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
					<caption><b>Checks.</b> Every finding of the diagnostics step, by severity; a handled row is a repair already applied.</caption>
					<thead>
						<tr><th>Severity</th><th>Check</th><th>Finding</th></tr>
					</thead>
					<tbody>
						{#each model.rows as row (row.code + row.message)}
							<tr class="row row--{row.severity}" class:row--handled={row.handled}>
								<td>
									<span class="badge badge--{row.severity}" class:sev--warn={row.severity === 'warn' && !row.handled}>{row.handled ? 'Handled' : severityLabel[row.severity]}</span>
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
			<p class="block notice--error" role="alert">
				<strong>Refused.</strong>
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
					<p class="muted">{PRESCREEN_BAND[prescreen.level].lead} {prescreen.caveat}</p>
					{#if prescreen.tree_source_caveat}
						<p class="muted">{prescreen.tree_source_caveat}</p>
					{/if}
				{:else if prescreen.status === 'cannot-assess'}
					<p class="prescreen__head"><strong>MEME hit-likelihood not assessed</strong></p>
					<p class="muted">{prescreen.detail}</p>
				{:else if prescreen.status === 'error'}
					<p class="muted">The hit-likelihood estimate could not be computed.</p>
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
					<span class="over note--warn">This exceeds the browser caps (codons ≤ 30,000; L·N² ≤ 2.5×10⁹); a server run is not available yet.</span>
				{/if}
			</p>
		{/if}
	{/if}
</section>

<style>
	.panel {
		border-top: 1px solid var(--rule);
		padding-top: var(--space-4);
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
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	p {
		margin: 0;
		font-size: var(--text-md);
	}
	.muted {
		color: var(--text-muted);
	}
	.linkbutton {
		background: none;
		border: 0;
		padding: 0;
		color: var(--link);
		text-decoration: underline;
		text-underline-offset: 0.16em;
		cursor: pointer;
		font-size: inherit;
	}
	.tablewrap {
		overflow-x: auto;
	}
	.warnings td:first-child {
		white-space: nowrap;
	}
	.row--handled {
		color: var(--text-muted);
	}
	.badge {
		display: inline-block;
		white-space: nowrap;
		font-size: var(--text-sm);
	}
	.badge--refuse {
		color: var(--text);
		font-weight: 700;
	}
	.badge--info {
		color: var(--text-faint);
	}
	.row--handled .badge {
		color: var(--text-muted);
		font-weight: 400;
	}
	.block {
		margin: 0;
	}
	.prescreen {
		display: grid;
		gap: var(--space-1);
	}
	.prescreen__head {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.over,
	.saturated {
		display: block;
		margin-top: var(--space-1);
	}
</style>
