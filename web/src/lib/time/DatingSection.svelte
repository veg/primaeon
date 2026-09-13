<!--
	DatingSection.svelte — section 3 of `/time`: the root the reader chose, the one action that
	starts the estimate, and the estimate itself.

	WHY THIS FILE EXISTS. It is the surface of `runtime/src/dating/`, and its whole job is to make
	two distinctions impossible to miss.

	  1. AN ESTIMATE OR A REFUSAL, NEVER BOTH. The slot under the heading holds either a sentence
	     with the numbers in it, or a black `.notice--error` with one reason and one next action —
	     and when it holds a refusal the section renders nothing else. A grid of em dashes where the
	     numbers would be reads as a render failure, not as a decision, so there is no such state.
	  2. WHICH ESTIMATOR THIS IS. The eyebrow names the command, the first statement under the
	     figure says that no model is loaded on this page, and the estimator table lists the two
	     model-based estimators as ROWS saying what they need and why they are not built. A table
	     that quietly omitted them would let a reader think this is the whole pillar.

	IT MUST NOT CONTRADICT THE PREVIEW ABOVE IT. Section 2's clock preview is root-to-tip divergence
	on the READER'S TREE in tree units; this is TN93 divergence to a chosen root in substitutions per
	site. They measure different things and will disagree, so the preview's own ancestor tile becomes
	a cross-check line naming both numbers once a run exists (`ClockPreview.svelte`,
	`crossCheckSentence`), and `clockRegression.js` stays the independent check its header says it is.

	THE RUN IS AN EXPLICIT ACTION, not automatic, for two reasons the page states: the root is a
	choice the reader makes, and the distances are minutes rather than the sub-millisecond the rest
	of this page costs. It runs in a cancellable worker and the running state is web/DESIGN.md §3's
	one line — a square, the phase, the count — with no spinner and no bar.

	LOOK. web/DESIGN.md: one primary button per view and this is `/time`'s ("Estimate the ancestor
	date"; never labelled exactly "Run"), `dl.stats` with nothing at display size, the `<figure>`
	below the numbers, the `<caption>` above the table, refusals black and warnings orange-marked.
-->
<script lang="ts">
	import DatingFigure from './DatingFigure.svelte';
	import { ancestorWord, rootSentence, type DatingFigureModel, type DatingView } from './dating';
	import type { DatingResult, DatingRootChoice, TimeUnits } from './types';

	interface Props {
		view: DatingView | null;
		figure: DatingFigureModel | null;
		run: DatingResult | null;
		units: TimeUnits;
		/** False while section 1's gate is red; the section then explains rather than offers. */
		ready: boolean;
		gateReasons: string[];
		state: 'idle' | 'running';
		progress: string;
		taxa: string[];
		root: DatingRootChoice;
		rootTaxon: string | null;
		excludedCount: number;
		alignmentName: string | null;
		onRoot: (root: DatingRootChoice, taxon: string | null) => void;
		onRun: () => void;
		onCancel: () => void;
	}
	let {
		view,
		figure,
		run,
		units,
		ready,
		gateReasons,
		state,
		progress,
		taxa,
		root,
		rootTaxon,
		excludedCount,
		alignmentName,
		onRoot,
		onRun,
		onCancel
	}: Props = $props();

	const warnings = $derived(run?.warnings.filter((w) => w.severity === 'warn') ?? []);
	const notes = $derived(run?.warnings.filter((w) => w.severity === 'note') ?? []);
	const splinePreferred = $derived(Boolean(figure && figure.curve.length > 0));
	const rootLabel = $derived(run?.ok ? rootSentence(run) : 'the root');
	const label = $derived(
		excludedCount > 0
			? `Re-estimate without the ${excludedCount} excluded sequence${excludedCount === 1 ? '' : 's'}`
			: view
				? `Estimate the ${ancestorWord(units)} again`
				: `Estimate the ${ancestorWord(units)}`
	);
</script>

<div class="dating">
	{#if !ready}
		<p class="note">
			The dates are not ready yet, so there is nothing to fit a clock to.
			{#each gateReasons as reason, i (i)}<span class="gate__reason">{reason}</span>{/each}
		</p>
	{:else}
		<div class="controls">
			<label class="field">
				<span>Measure divergence to</span>
				<select
					value={root === 'taxon' ? `taxon:${rootTaxon ?? ''}` : root}
					onchange={(e) => {
						const v = (e.currentTarget as HTMLSelectElement).value;
						if (v.startsWith('taxon:')) onRoot('taxon', v.slice('taxon:'.length));
						else onRoot(v as DatingRootChoice, null);
					}}
				>
					<option value="consensus">a time-decay weighted consensus (the reference's default)</option>
					<option value="unweighted">an unweighted majority consensus</option>
					<option value="earliest">the earliest sequence</option>
					{#each taxa as name (name)}
						<option value={`taxon:${name}`}>{name}</option>
					{/each}
				</select>
			</label>
			{#if state === 'running'}
				<p class="running" role="status"><span class="mark--run"></span>{progress || 'Estimating…'}</p>
				<button type="button" class="button button--secondary" onclick={onCancel}>Cancel</button>
			{:else}
				<button type="button" class="button" onclick={onRun}>{label}</button>
			{/if}
		</div>
		<p class="hint">
			The root is a choice, not a datum: naming a sequence measures divergence to that sequence, naming
			none builds a consensus and measures to that, and a root a constant amount too deep moves the
			ancestor earlier by exactly that amount divided by the clock rate. No root is searched.
		</p>
	{/if}

	{#if view?.refusal}
		<p class="notice--error" role="alert">
			<strong>Refused.</strong>
			{view.refusal.reason}
			<span class="next">{view.refusal.next}</span>
		</p>
	{:else if view?.ok}
		<p class="verdict">{view.verdict}</p>
		<p class="note">
			{view.counts}
			{#if view.holdout}{' '}{view.holdout}{/if}
		</p>

		<dl class="stats">
			{#each view.stats as stat (stat.label)}
				<div>
					<dt>{stat.label}</dt>
					<dd><strong>{stat.value}</strong> <span class="qual">{stat.qualifier}</span></dd>
				</div>
			{/each}
		</dl>

		{#if figure}
			<DatingFigure
				model={figure}
				{units}
				{rootLabel}
				{splinePreferred}
				{alignmentName}
			/>
		{/if}

		{#if view.clockNote}
			<p class="note">{view.clockNote}</p>
		{/if}

		<div class="scroll">
			<table>
				<caption>
					<b>Every estimator this pillar has, and what each of them says here.</b>
					The first two ran; the rest did not, and the reason is in the row. Intervals are the
					fit's own — Fieller for the straight line, which is asymmetric on purpose — and the
					last row averages the models whose interval has a width, which is why it can disagree
					with the model the curvature test selected.
				</caption>
				<thead>
					<tr>
						<th scope="col">Estimator</th>
						<th scope="col" class="num">{ancestorWord(units)[0].toUpperCase() + ancestorWord(units).slice(1)}</th>
						<th scope="col">95 % interval</th>
						<th scope="col" class="num">Rate</th>
						<th scope="col" class="num">R²</th>
					</tr>
				</thead>
				<tbody>
					{#each view.estimators as row (row.name)}
						<tr>
							<td>{row.name}</td>
							{#if row.built}
								<td class="num">{row.date}</td>
								<td class="interval"
									>{row.interval}{#if row.note}<span class="qual">{row.note}</span>{/if}</td
								>
								<td class="num">{row.rate ?? '—'}</td>
								<td class="num">{row.r2 ?? '—'}</td>
							{:else}
								<td class="num faint">—</td>
								<td colspan="3" class="faint notbuilt">Not built. {row.note}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if warnings.length || notes.length}
			<details class="strip">
				<summary
					><b>What this estimate rests on.</b>
					{warnings.length} thing{warnings.length === 1 ? '' : 's'} that change how it should be read, and
					{notes.length} that cost nothing.</summary
				>
				<ul class="diags">
					{#each warnings as w (w.code)}
						<li class="note--warn"><span class="mono">{w.code}</span> {w.message}</li>
					{/each}
					{#each notes as w (w.code)}
						<li><span class="mono">{w.code}</span> {w.message}</li>
					{/each}
				</ul>
			</details>
		{/if}

		<div class="statements">
			<p class="note">
				<b>This is the tree-free least-squares estimator and nothing else.</b> No model is loaded on this
				page: the {ancestorWord(units)} above comes from TN93 distances to a root and a straight line through
				them, and the route requests no graph and no WebAssembly at all.
			</p>
			<p class="note">
				<b>The two model-based estimators are not built.</b> Both need a taxon-by-taxon attention matrix
				and per-taxon embeddings averaged inside the graph; this build's export emits the root token's
				attention row and the root token's vector — vectors where those are matrices. A new export means
				a new manifest hash, new fixtures and a re-baked gallery, which is why the table above states it
				in place rather than promising it.
			</p>
			<p class="note">
				<b>How much weight the number carries.</b> Ordinary least squares treats closely related sequences
				as independent observations, which they are not, so the interval above is narrower than the data
				deserve — and that narrowness is precisely what the unbuilt estimator exists to fix. On the HIV-1
				group M envelope set this pillar is benchmarked against, the published 1931.4 estimate lies
				outside it, and the 1927.6 [1916.4, 1938.7] the upstream guide quotes is the attention-based
				estimator, the one not built. Read the point estimate as an order-of-magnitude answer and the
				interval as optimistic.
			</p>
			<p class="note">
				<b>What the fit does not include.</b> There is no root search (the reference re-roots up to sixty
				candidate trees and a subtly wrong port of that yields plausible, wrong dates that never announce
				themselves, so it is declined rather than approximated); no leave-one-out and no jackknife; no
				power-law clock; and the spline's interval is not computed, for the reason given above. The
				interval quoted is Fieller's, which is asymmetric; the delta-method interval off the same fit is
				narrower.
			</p>
			<p class="note">
				<b>What this costs, and where the browser stops.</b> Divergence is measured to one root rather than
				between every pair, so the work is the number of sequences times the alignment width, not its
				square. Measured on the development machine, one thread, warm: 143 sequences × 2,943 nt takes
				about 30 ms, 1,500 of the same width about 0.16 s, and 3,000 about 0.28 s to a named sequence or
				0.54 s to a consensus this page has to build first. It runs in a cancellable worker even so,
				because those numbers are one machine's and because a run you cannot interrupt is a run you can
				only lose. The model-based estimators are the ones that would not fit in a tab, and this build
				does not have them.
			</p>
		</div>
	{/if}
</div>

<style>
	.dating {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.controls {
		display: flex;
		align-items: flex-end;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.field select {
		border: 1px solid var(--rule);
		border-radius: 0;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: var(--text-md);
		padding: 0.35rem 0.6rem;
		max-width: 32rem;
	}
	.running {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.gate__reason {
		display: block;
	}
	.verdict {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0;
		max-width: var(--measure);
	}
	.next {
		display: block;
		color: var(--text-muted);
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-4);
		margin: 0;
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.stats div {
		margin: 0;
	}
	.stats dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.stats dd {
		margin: 0;
		font-size: var(--text-base);
		overflow-wrap: anywhere;
	}
	.qual {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		min-width: 48rem;
		border-collapse: collapse;
		font-size: var(--text-md);
	}
	caption {
		caption-side: top;
		text-align: left;
		max-width: var(--measure);
		padding: 0 0 var(--space-2);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	caption :global(b) {
		color: var(--text);
		font-weight: 700;
	}
	thead tr {
		border-top: 1px solid var(--text);
		border-bottom: 1px solid var(--text);
	}
	th,
	td {
		text-align: left;
		vertical-align: top;
		padding: 0.4rem 0.75rem 0.4rem 0;
		border: 0;
	}
	th {
		font-weight: 700;
		color: var(--text);
	}
	th.num,
	td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	tbody tr {
		border-bottom: 1px solid var(--hair);
	}
	tbody tr:last-child {
		border-bottom: 1px solid var(--text);
	}
	.interval {
		max-width: 26rem;
	}
	.notbuilt {
		max-width: 40rem;
	}
	.faint {
		color: var(--text-faint);
	}
	.strip {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.strip summary {
		max-width: var(--measure);
	}
	.diags {
		margin: var(--space-2) 0 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.diags li {
		max-width: var(--measure);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.statements {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.statements .note {
		margin: 0;
	}
	.statements :global(b) {
		color: var(--text);
		font-weight: 700;
	}
	.hint {
		margin: 0;
		max-width: var(--measure);
	}
</style>
