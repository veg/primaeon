<!--
	DatingSection.svelte — section 3 of `/time`: the root the reader chose, the one action that
	starts the estimate, and the estimate itself.

	WHY THIS FILE EXISTS. It is the surface of `runtime/src/dating/`, and its whole job is to make
	three distinctions impossible to miss.

	  1. AN ESTIMATE OR A REFUSAL, NEVER BOTH. The slot under the heading holds either a sentence
	     with the numbers in it, or a black `.notice--error` with one reason and one next action —
	     and when it holds a refusal the section renders nothing else. A grid of em dashes where the
	     numbers would be reads as a render failure, not as a decision, so there is no such state.
	  2. WHICH ESTIMATOR THIS IS. Every fit the reference runs is a row of one table, with its own
	     date, its own interval and its own rate; the ones this build does not run are rows too,
	     saying what they need. A table that quietly omitted them would let a reader think this is
	     the whole pillar.
	  3. WHAT DIVERGENCE MEANS IN THIS RUN — phase 4's addition, and the one a reader is most likely
	     to be caught by. With the model on and `--distance-mode auto`, the y axis is no longer a
	     sequence distance: it is the distance to a root the model placed in its own representation
	     space, and EVERY estimator including the ordinary one is fitted against it. The ordinary
	     fit's ancestor date therefore moves when the model is switched on, with nothing about that
	     estimator having changed. `divergence` is the sentence that says so, it sits directly under
	     the verdict, and `modeShift` states the size of the move when the reader has made both runs.

	THE THREE ESTIMATES ARE SHOWN, NOT AVERAGED. The reference's record carries an `ensemble` block
	that reads each deliberately skewed Fieller interval as a symmetric Gaussian one and averages
	whichever fits happen to have an interval with width — so it can silently exclude the very model
	the selector chose. It is one row of the table with that stated, and `agreement` is the paragraph
	that does the work instead: the span between the fits, in this run's own numbers, and the cause.

	IT MUST NOT CONTRADICT THE PREVIEW ABOVE IT. Section 2's clock preview is root-to-tip divergence
	on the READER'S TREE in tree units; this is TN93 divergence to a chosen root in substitutions per
	site. They measure different things and will disagree, so the preview's own ancestor tile becomes
	a cross-check line naming both numbers once a run exists (`ClockPreview.svelte`,
	`crossCheckSentence`), and `clockRegression.js` stays the independent check its header says it is.

	THE RUN IS AN EXPLICIT ACTION, not automatic, for two reasons the page states: the root is a
	choice the reader makes, and the distances are minutes rather than the sub-millisecond the rest
	of this page costs. It runs in a cancellable worker and the running state is web/DESIGN.md §3's
	one line — a square, the phase, the count — with no spinner and no bar.

	THE MODEL RUN IS A SECOND ACTION, AND THE ONLY THING ON THIS ROUTE THAT LOADS A GRAPH. It is
	secondary, it is offered with its cost in the sentence beside it (a 7.3 MB download and a second
	forward pass over every codon, against a third of a second and nothing downloaded for the default
	estimate), and where it cannot be offered the block says which of the three reasons it is —
	no graph in this build, too many sequences, or no Web Workers — rather than showing a control
	that will fail. It produces a DIFFERENT record, not more fields on the same one, which is why it
	is a button and not a checkbox.

	LOOK. web/DESIGN.md: one primary button per view and this is `/time`'s ("Estimate the ancestor
	date"; never labelled exactly "Run"), the model run beside it as `.button--secondary`, `dl.stats`
	with nothing at display size, the `<figure>` below the numbers, the `<caption>` above each table,
	refusals black and warnings orange-marked.
-->
<script lang="ts">
	import DatingFigure from './DatingFigure.svelte';
	import { ancestorWord, num, rootSentence, sci, yr, type DatingFigureModel, type DatingView, type ModelOffer } from './dating';
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
		/** Whether the model-based half can be offered at all, and the reason when it cannot. */
		offer: ModelOffer;
		/** Whether this build ships a dating graph, read once from the manifest by the page. */
		modelProbe: 'idle' | 'checking' | 'ready' | 'absent' | 'failed';
		modelGraph: { variant: string; file: string; sha256: string } | null;
		modelProbeNote: string | null;
		/** One sentence when the reader's last two runs measured divergence differently. */
		modeShift: string | null;
		/** `--distance-mode`, bound: `auto` is the reference's default and resolves to the latent root. */
		distanceMode: 'auto' | 'tn93';
		onRoot: (root: DatingRootChoice, taxon: string | null) => void;
		onRun: () => void;
		onRunModel: () => void;
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
		offer,
		modelProbe,
		modelGraph,
		modelProbeNote,
		modeShift,
		distanceMode = $bindable('auto'),
		onRoot,
		onRun,
		onRunModel,
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
	/**
	 * The model button is offered only when the manifest actually declares a graph. `checking` and
	 * `idle` hold it back rather than showing a control that would fail; `absent` and `failed` are
	 * said in words instead, which is the whole difference between a refusal and a dead button.
	 */
	const canRunModel = $derived(offer.available && modelProbe === 'ready' && modelGraph != null);
	const modelLabel = $derived(view?.modelRan ? 'Estimate with the model again' : 'Estimate with the model as well');
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
					aria-label="Root for divergence"
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

		<div class="model" data-state={canRunModel ? 'ready' : modelProbe}>
			<p class="note">
				<b>{offer.available ? 'The two model-based estimators.' : 'The two model-based estimators are not offered here.'}</b>
				{offer.reason}
			</p>
			{#if canRunModel && modelGraph}
				<p class="hint">{offer.cost}</p>
				<div class="controls">
					<label class="field">
						<span>Measure divergence with</span>
						<select aria-label="Divergence with the model" bind:value={distanceMode} disabled={state === 'running'}>
							<option value="auto">the model's latent root (the reference's default)</option>
							<option value="tn93">TN93 distances, and the model for the covariance only</option>
						</select>
					</label>
					<button type="button" class="button button--secondary" onclick={onRunModel} disabled={state === 'running'}>
						{modelLabel}
					</button>
				</div>
				<p class="hint">
					Under the first option every estimator — the ordinary one included — is fitted against the
					distance to a root the model places in its own representation space, so the ancestor date
					changes even though the ordinary fit's arithmetic does not. Under the second, divergence stays
					a TN93 distance and only the generalised fit's error covariance comes from the model. Both are
					the reference's; neither is more correct.
				</p>
				<p class="hint mono">{modelGraph.file} · sha256 {modelGraph.sha256.slice(0, 12)}…</p>
			{:else if modelProbe === 'absent'}
				<p class="note">
					<b>Not in this build.</b>
					<span class="mono">models/manifest.json</span> declares no
					<span class="mono">taxa_onnx_sha256</span>, so there is no dating graph to load. They need a
					taxon-by-taxon attention matrix and per-taxon embeddings averaged inside the graph; the backbone
					emits the root token's attention row and the root token's vector, which are vectors where those
					are matrices, and neither is derivable from the other.
				</p>
			{:else if modelProbe === 'failed'}
				<p class="note note--warn">
					<b>The manifest could not be read</b>, so this page cannot say whether a dating graph exists:
					{modelProbeNote}. The estimate above is unaffected — it reads no manifest.
				</p>
			{/if}
		</div>
	{/if}

	{#if view?.refusal}
		<p class="notice--error" role="alert">
			<strong>Refused.</strong>
			{view.refusal.reason}
			<span class="next">{view.refusal.next}</span>
		</p>
	{:else if view?.ok}
		<p class="verdict">{view.verdict}</p>
		<p class="note divergence" class:note--warn={view.distanceMode === 'latent'}>{view.divergence}</p>
		{#if modeShift}
			<p class="note note--warn">{modeShift}</p>
		{/if}
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
				distanceMode={view.distanceMode}
			/>
		{/if}

		{#if view.agreement}
			<p class="note agreement">{view.agreement}</p>
		{/if}

		{#if view.clockNote}
			<p class="note">{view.clockNote}</p>
		{/if}

		<div class="scroll">
			<table>
				<caption>
					<b>Every estimator this pillar has, and what each of them says here.</b>
					The built ones ran; any row marked "Not built" did not, and the reason is in the row.
					Intervals are each fit's own — Fieller, which is asymmetric on purpose — and the last row
					averages only the models whose interval has a width, which is why it can disagree with the
					model the reference selected and can exclude that model entirely. The
					{view.headline === 'pgls' ? 'generalised fit' : view.headline === 'spline' ? 'spline' : 'straight line'}
					is the row the numbers above come from.
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

		{#if view.latent}
			<div class="scroll">
				<table>
					<caption>
						<b>The root the model placed, and the sequences it is made of.</b>
						The root is a weighted average of your sequences in the model's representation space, chosen
						by 250 gradient steps so that distance to it correlates with {units === 'years'
							? 'sampling date'
							: `sampling ${units}`}; α = {sci(view.latent.alpha)} rescales one unit of that space to
						substitutions per site, fitted as a no-intercept slope against the observed pairwise
						differences. The weights below are a softmax over every sequence and sum to 1 across all of
						them; the reference lists the largest and stops at the first below 1 %, so these
						{view.latent.anchors.length} are what it reports, not what it used. Correlation R =
						{num(view.latent.r, 3)}.
					</caption>
					<thead>
						<tr>
							<th scope="col">Sequence</th>
							<th scope="col" class="num">Weight</th>
							<th scope="col" class="num">{units === 'years' ? 'Date' : 'Time'}</th>
						</tr>
					</thead>
					<tbody>
						{#each view.latent.anchors as a (a.taxon)}
							<tr>
								<td class="mono">{a.taxon}</td>
								<td class="num">{num(a.weight, 4)}</td>
								<td class="num">{yr(a.date)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

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
			{#if view.modelRan}
				<p class="note">
					<b>Three fits, one dataset, and the page does not pick an average.</b> The ordinary fit treats
					closely related sequences as independent observations, which they are not; the generalised fit
					is the same line with an error covariance built from the model's own cross-taxa attention and
					per-taxon embeddings, so shared ancestry is not counted twice; the spline asks whether the rate
					is constant. They are answering slightly different questions, which is why the table shows all
					three and the paragraph above says which one the reference selected and why.
				</p>
				<p class="note">
					<b>What the model contributed, exactly.</b> A second forward pass over every codon through
					<span class="mono">{'<variant>_taxa.onnx'}</span>, a graph exported for this pillar alone. It
					emits the taxon-by-taxon attention block and the per-taxon embeddings, both averaged over heads,
					layers and sites inside the graph — the unreduced tensor would be 12.6 MB per site — and from
					those two matrices come the error covariance and, under the default distance mode, the latent
					root itself. The pass reads every site, invariable ones included, with no taxon cap and no
					duplicate pruning, which is what the reference's dating pass reads and is not what the selection
					report reads.
				</p>
			{:else}
				<p class="note">
					<b>This is the tree-free least-squares estimator, and it loaded nothing.</b> The
					{ancestorWord(units)} above comes from TN93 distances to a root and a straight line through
					them; this run requested no graph and no WebAssembly at all. The two model-based estimators are
					rows in the table above saying what they need — the offer beside the button is where they are
					run from.
				</p>
			{/if}
			<p class="note">
				<b>How much weight the number carries.</b> An ordinary fit's interval is narrower than the data
				deserve, because the sequences are not independent observations — and correcting exactly that is
				what the generalised fit is for. On the HIV-1 group M envelope set this pillar is benchmarked
				against, the published 1931.4 estimate lies outside the ordinary fit's interval. Read a point
				estimate here as an order-of-magnitude answer and any single interval as optimistic.
			</p>
			<p class="note">
				<b>What the fit does not include.</b> There is no root search (the reference re-roots up to sixty
				candidate trees and a subtly wrong port of that yields plausible, wrong dates that never announce
				themselves, so it is declined rather than approximated); no leave-one-out and no jackknife; no
				power-law clock; no site bootstrap; and the spline's interval is not computed, for the reason
				given above. The interval quoted is Fieller's, which is asymmetric; the delta-method interval off
				the same fit is narrower. Nothing on this path draws a random number, so two runs of it agree bit
				for bit.
			</p>
			<p class="note">
				<b>What this costs, and where the browser stops.</b> The default estimate measures divergence to
				one root rather than between every pair, so the work is the number of sequences times the
				alignment width, not its square: measured on the development machine, one thread, warm, 143
				sequences × 2,943 nt takes about 30 ms, 1,500 of the same width about 0.16 s, and 3,000 about
				0.28 s. The model pass is the expensive half — 7.3 s for 143 × 981 codons at four threads after a
				7.3 MB download — and it is refused above 1,500 dated sequences, where the reference quietly falls
				back to the ordinary fit instead. Both run in a cancellable worker.
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
	/**
	 * The model offer: one hairline above it and nothing else. It is a second action on the same
	 * section, not a panel — a box or a tint would make it read as a different kind of thing, and
	 * web/DESIGN.md has neither.
	 */
	.model {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--hair);
	}
	.model .note,
	.model .hint {
		margin: 0;
	}
	.model :global(b) {
		color: var(--text);
		font-weight: 700;
	}
	.divergence,
	.agreement {
		margin: 0;
		max-width: var(--measure);
	}
</style>
