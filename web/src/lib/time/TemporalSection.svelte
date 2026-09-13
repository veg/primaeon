<!--
	TemporalSection.svelte — section 5 of `/time`: the one action that starts temporal selection, what
	it costs before a reader waits for it, and the four figures and the table it lands as.

	WHY THIS FILE EXISTS. It is the surface of `runtime/src/temporal/`, and it is in one of four
	states at any moment — blocked, offered, running, landed — with no fifth state in which it renders
	an empty panel. web/DESIGN.md §3's phenotype rule applies unchanged: before a run this section is
	a few sentences and a button, not a grid of em dashes.

	THE OFFER STATES ITS COST IN ARITHMETIC A READER CAN CHECK. Four numbers multiplied, with both
	unknowable ones replaced by their ceilings and labelled as ceilings, and the one time figure in it
	attributed to the machine that measured it. The moment stage one lands, that paragraph is replaced
	by what the run actually cost. A number measured somewhere else, printed as though it were about
	the reader's machine, is precisely the kind of quiet claim this whole route exists to stop making.

	THE SECTION STREAMS IN THREE PAYLOADS and they are deliberately not the same kind of thing:

	  1. everything DETERMINISTIC — trajectories, velocities, peaks, widths, areas, the candidate set,
	     the static LRT and its p and q. Figures 4 and 5 land here, and the table with its permutation
	     columns reading "not tested".
	  2. the NULL, per chunk, as a native `<progress>` with a real value and a Stop button.
	  3. the WAVE MODES and both classification columns. Figures 6 and 7 land here.

	WHILE THE SECOND PAYLOAD IS ARRIVING, THIS SECTION CLAIMS NOTHING IT CANNOT YET KNOW. The per-chunk
	payload replaces the two permutation columns and nothing downstream of them, so every label, sweep
	count and classification on screen would be the scored payload's zeros — and `permutations.tested`
	is already true after the first chunk. So the lede takes a fourth form, the sweep count stays an em
	dash with the draw count beside it, the call columns keep reading "not tested", and Figures 6 and 7
	say why they are not drawn yet instead of drawing an unfinished computation. `nullInFlight`
	(temporal.ts) is the one test all of that goes through, and it reads the record's own `stage`, not
	the draw count: a STOPPED null lands complete, with fewer draws, and its labels are final.

	WHAT SURVIVES A STOP IS THE POINT OF THAT SPLIT. Stopping the null keeps every number upstream of
	the shuffle and gives back p-values on a coarser grid — `(1 + exceedances) / (draws + 1)` at the
	achieved count, which is the reference's own estimator, not an approximation of it. Stopping
	during the model pass keeps nothing, because there is nothing yet; the button says which it is.

	AND A STOP HAS A THIRD OUTCOME, which is why the null has FOUR states here and not three
	(`nullState`). The cooperative cancel is what gives back the coarser grid; when the worker does
	not answer it within the client's grace it is TERMINATED, and the page is left holding a record
	whose null is mid-flight and is now never going to finish. `routes/time/+page.svelte` marks that
	record `stage: 'stopped'` and this section then says the run ended rather than that it is still
	running: a skipped, abandoned or never-started null is not a running one, and none of the notes
	below may tell that reader to wait.

	AND THE DOWNLOAD LINE DOES NOT MAKE ITS OWN CLAIM. "Byte for byte" is a claim about the FORMAT
	only — measured on H1N1, 1 of 4,384 rows of the sites summary is byte-identical to a command-line
	run of the same analysis — and the runtime's `temporalDownloadNotes` is where that qualifier
	lives. This section introduces the files and then prints those notes; it does not restate them,
	because the restatement was wrong and sat in the same paragraph as the correction.

	THE THREE SENTENCES A READER COMPARING THIS WITH A COMMAND-LINE RUN MUST SEE — the generator
	behind the permutation p, the convention behind a wave's sign, and the dates our layer can read
	that the reference's cannot — are `honestyNotes()` in `temporal.ts`, printed as prose in the same
	voice as the results (web/DESIGN.md §5: a caveat is a fact, not an alarm), with only the two that
	change what a comparison MEANS taking the warning mark.

	LOOK. One primary button, and it is never labelled exactly "Run" (§6); `<figure>` with the caption
	below and `<caption>` above the table; the native `<progress>` at 2 px with `accent-color:
	var(--brand)` because it carries a real value; refusals black, warnings orange-marked; no card, no
	tint, no second hue.
-->
<script lang="ts">
	import ClassificationFigure from './ClassificationFigure.svelte';
	import TemporalTable from './TemporalTable.svelte';
	import TrajectoryFigure from './TrajectoryFigure.svelte';
	import VelocityFigure from './VelocityFigure.svelte';
	import WaveFigure from './WaveFigure.svelte';
	import { num, sci } from './dating';
	import {
		classificationFigure,
		costMeasured,
		costSentences,
		duration,
		honestyNotes,
		ledeSentence,
		nullInFlight,
		nullState,
		remainingSeconds,
		trajectoryFigure,
		velocityFigure,
		waveFigure,
		TEMPORAL_MAX_SPECIES,
		type TemporalGate,
		type TemporalRecord
	} from './temporal';
	import type { TimeUnits } from './types';

	interface Props {
		gate: TemporalGate;
		record: TemporalRecord | null;
		refusal: { code: string; message: string } | null;
		failure: string | null;
		runState: 'idle' | 'running';
		progress: { phase: string; done: number; total: number; message: string };
		/** Codons this alignment can hold, read off its first sequence; null when unreadable. */
		codons: number | null;
		dated: number;
		units: TimeUnits;
		taxa: string[];
		/** The run's own reference command, computed in the worker (see protocol.ts). */
		reference: { command: string; reproduces: boolean; caveats: string[] } | null;
		downloadNotes: string[];
		workersAvailable: boolean;
		draws: number | null;
		timePoints: number;
		rootTaxon: string | null;
		scoreInvariable: boolean;
		onRun: () => void;
		onCancel: () => void;
		onDownload: (which: 'sites' | 'curves' | 'waves' | 'summary') => void;
	}
	let {
		gate,
		record,
		refusal,
		failure,
		runState,
		progress,
		codons,
		dated,
		units,
		taxa,
		reference,
		downloadNotes,
		workersAvailable,
		draws = $bindable(null),
		timePoints = $bindable(250),
		rootTaxon = $bindable(null),
		scoreInvariable = $bindable(true),
		onRun,
		onCancel,
		onDownload
	}: Props = $props();

	let selected = $state<number | null>(null);

	const unitLabel = $derived(
		record?.regime.unit_label ?? (units === 'years' ? 'yrs' : units === 'generations' ? 'gen' : units === 'days' ? 'days' : 'units')
	);
	const drawsForCost = $derived(draws ?? 1000);
	/** What the MODEL pass sees: every sequence in the file, not just the dated ones, under the cap. */
	const sequencesForCost = $derived(taxa.length ? Math.min(taxa.length, TEMPORAL_MAX_SPECIES) : null);
	const cost = $derived(
		costSentences({ codons, sequences: sequencesForCost, dated, timePoints, draws: drawsForCost, scoreInvariable })
	);
	const inNull = $derived(runState === 'running' && progress.phase === 'temporal-null');
	const pct = $derived(progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0);
	const left = $derived(
		record?.permutations
			? remainingSeconds(record.permutations.ms_per_draw, progress.done, progress.total, record.permutations.chunks)
			: null
	);
	const perm = $derived(record?.permutations ?? null);
	// `permutations.tested` is deliberately NOT held here any more. It is true one chunk into the
	// null and stays true on a record whose worker was terminated, so every cell that once read it
	// claimed a finding that had not been computed; `nulls` below is what this section switches on.
	/**
	 * The null has drawn something and the labels downstream of it are NOT yet computed. Everything
	 * that would otherwise print a call, a sweep count or a classification reads this first: see
	 * `nullInFlight` in temporal.ts for why `tested` alone states a completed finding one chunk in.
	 */
	const inFlight = $derived(record ? nullInFlight(record) : false);
	/**
	 * FOUR states, not three (`nullState`). A null that was declined over the work budget, stopped
	 * before its first draw, or abandoned when its worker was terminated is NOT a running one, and
	 * the notes that stand in for Figures 6 and 7 may not tell that reader to wait.
	 */
	const nulls = $derived(record ? nullState(record) : 'not-started');
	const flat = $derived(record ? record.codons_variable - record.stage1_candidates : 0);
	const trajectory = $derived(record ? trajectoryFigure(record) : null);
	const velocity = $derived(record ? velocityFigure(record) : null);
	const waves = $derived(record ? waveFigure(record) : null);
	const classification = $derived(record ? classificationFigure(record) : null);
	const notes = $derived(record ? honestyNotes(record) : []);
	const diagnostics = $derived(record ? record.warnings.filter((w) => w.severity !== 'refuse') : []);
	const label = $derived(record ? 'Run temporal selection again' : 'Run temporal selection');
</script>

<div class="temporal" data-state={refusal || failure ? 'refused' : !gate.ok ? 'blocked' : runState === 'running' ? 'running' : record ? 'landed' : 'offered'}>
	{#if !gate.ok}
		<p class="note">
			Temporal selection is not offered yet, because it would be a run on dates that are not settled.
			{#each gate.reasons as reason, i (i)}<span class="gate__reason">{reason}</span>{/each}
		</p>
	{:else}
		{#if !record}
			<p class="lede">
				Temporal selection asks a different question from the ancestor date: not <em>when</em> this
				gene's ancestor lived, but <em>which codons were under selection when</em>. Every codon is
				scored once by the model, its per-sequence attention is anchored to a root sequence and
				smoothed along the sampling dates, and the codons whose signal actually moves are tested
				against a null that shuffles those dates.
			</p>
			<p class="note"><b>What it will cost.</b> {cost[0]}</p>
			<p class="note">{cost[1]}</p>
			<p class="note">{cost[2]}</p>
		{/if}

		<details class="settings">
			<summary>Settings, and where they differ from the command line.</summary>
			<div class="fields">
				<label class="field">
					<span>Shuffles (<code>-B</code>)</span>
					<select
						aria-label="Shuffles"
						value={draws === null ? 'auto' : String(draws)}
						disabled={runState === 'running'}
						onchange={(e) => {
							const v = (e.currentTarget as HTMLSelectElement).value;
							draws = v === 'auto' ? null : Number(v);
						}}
					>
						<option value="auto">refine from 200 to 1,000 as the budget allows</option>
						<option value="200">200</option>
						<option value="500">500</option>
						<option value="1000">1,000 — the command line's own default</option>
					</select>
				</label>
				<label class="field">
					<span>Grid points (<code>--time-points</code>)</span>
					<select aria-label="Grid points" bind:value={timePoints} disabled={runState === 'running'}>
						<option value={60}>60</option>
						<option value={120}>120</option>
						<option value={250}>250 — the command line's own default</option>
					</select>
				</label>
				<label class="field">
					<span>Root sequence (<code>--root-taxon</code>)</span>
					<select
						aria-label="Root sequence"
						value={rootTaxon ?? ''}
						disabled={runState === 'running'}
						onchange={(e) => {
							const v = (e.currentTarget as HTMLSelectElement).value;
							rootTaxon = v === '' ? null : v;
						}}
					>
						<option value="">the consensus of the earliest samples (the reference's default)</option>
						{#each taxa as name (name)}
							<option value={name}>{name}</option>
						{/each}
					</select>
				</label>
			</div>
			<label class="check">
				<input type="checkbox" bind:checked={scoreInvariable} disabled={runState === 'running'} />
				Score the invariable codons too, as <code>hyphaeon temporal</code> does
			</label>
			<p class="hint">
				<b>Shuffles.</b> At 200 the smallest p this test can report is 1/201 = 0.00498 and a p near the
				0.05 cut carries a standard error of about 0.015; at 1,000 it is 0.0069. Fewer draws do not bias
				the answer, they blur the cut. <b>Grid points.</b> The peak date is a grid point, so its
				resolution is the span divided by the number of points less one. <b>Bandwidth</b> is the
				reference's own rule and is not exposed: 5 % of the span, clamped to [0.05, 2.0] years, printed
				with the result. <b>Root.</b> Naming no sequence takes the consensus of the earliest 5 % of
				them, which is at least 3 and at most 25 — so it is 3 for anything under 60 sequences and 25 for
				anything over 500; that is the reference's own rule, replicated. Naming one instead reproduces an
				upstream bug worth knowing about: a gap in the named sequence is read as alanine
				(temporal.py:355), which gives codons that do not vary at all real trajectories and wrong
				labels, so this page scores every codon whenever a root is named. <b>Invariable codons.</b>
				Skipping them saves most of the model pass and changes no trajectory — under a consensus root
				their attribution is identically zero — but their static LRT and p-value then come back empty,
				and the sites file stops being a clean diff against <code>hyphaeon temporal</code>.
				<b>Not exposed, and printed as facts:</b> the permutation cut α = 0.05, the wave-alignment gate
				R² ≥ 0.35, the static FDR cut q ≤ 0.10, and the seed, 42.
			</p>
		</details>

		<div class="controls">
			{#if runState === 'running'}
				{#if inNull}
					<div class="progress" role="group" aria-label="Null progress">
						<progress max={Math.max(1, progress.total)} value={progress.done}></progress>
						<span class="progress__text">
							<span class="mark--run" aria-hidden="true"></span>Running: {progress.done.toLocaleString('en-US')} of
							{progress.total.toLocaleString('en-US')} shuffles ({pct} %).{#if left !== null}
								{' '}{duration(left)} left.{/if}
						</span>
						<button type="button" class="button button--secondary" onclick={onCancel}>Stop the null</button>
					</div>
				{:else}
					<p class="running" role="status"><span class="mark--run" aria-hidden="true"></span>{progress.message || 'Running…'}</p>
					<button type="button" class="button button--secondary" onclick={onCancel}>Stop</button>
				{/if}
			{:else if workersAvailable}
				<button type="button" class="button" onclick={onRun}>{label}</button>
			{:else}
				<p class="note">This browser has no Web Workers, so nothing can be run here.</p>
			{/if}
		</div>
	{/if}

	{#if failure}
		<p class="notice--error" role="alert"><strong>The run failed.</strong> {failure}</p>
	{:else if refusal}
		<p class="notice--error" role="alert"><strong>Refused.</strong> {refusal.message}</p>
	{/if}

	{#if record && trajectory && velocity}
		<p class="lede verdict">{ledeSentence(record, units)}</p>
		<p class="note measured"><b>{inFlight ? 'What it has cost so far.' : 'What it cost.'}</b> {costMeasured(record)}</p>

		{#if perm?.cancelled}
			<p class="note note--warn">
				<strong>Stopped after {perm.completed.toLocaleString('en-US')} of {perm.requested.toLocaleString('en-US')} shuffles.</strong>
				{#if perm.completed > 0}
					The trajectories, velocities and candidate list are complete, and the p-values below are the
					same estimator on a coarser grid — (1 + exceedances) / ({perm.completed.toLocaleString('en-US')} + 1),
					so the smallest value it can report is {num(perm.grid_step, 5)}. Run it again to refine them.
				{:else}
					The trajectories, velocities and candidate list are complete; no codon was confirmed or ruled
					out, because that needs at least one shuffle. Run it again to finish the test.
				{/if}
			</p>
		{:else if perm?.skipped}
			<p class="note note--warn"><strong>The null was not run.</strong> {perm.reason}</p>
		{:else if record.stage === 'stopped'}
			<p class="note note--warn">
				<!--
					Two stops, as in `uncalledBecause`: the terminate usually lands mid-null, but it can
					also land after the scored payload and before the first shuffle, and that reader must
					not be told shuffles were being drawn.
				-->
				{#if (perm?.completed ?? 0) > 0}
					<strong>This run was stopped while the null was being drawn.</strong>
				{:else}
					<strong>This run was stopped before the null drew a single shuffle.</strong>
				{/if}
				It did not come back in time to be asked for what it had, so the worker was ended and the
				calls, the sweep counts and the wave modes were never computed. Everything upstream of the
				shuffle — the trajectories, velocities, peaks, widths, areas, the candidate list and the
				static scan — is on this page and is final. Run it again to test them.
			</p>
		{/if}
		{#if record.escape_hatch_used}
			<p class="note note--warn">
				<strong>No codon cleared the thresholds, so the codons called below are a fallback selection.</strong>
				The reference falls back to candidates with p ≤ 0.10 <em>or</em> a static LRT ≥ 3.84 when nothing
				passes (temporal.py:692-693) and records that in none of its output files. This page records it.
			</p>
		{/if}

		<dl class="stats">
			<div><dt>Sequences dated</dt><dd><strong>{record.taxa_timestamped.toLocaleString('en-US')}</strong> <span class="qual">of {record.taxa_total.toLocaleString('en-US')} the model kept</span></dd></div>
			<div><dt>Span</dt><dd><strong>{num(record.timespan_years, 3)} {unitLabel}</strong> <span class="qual">{num(record.t_min, 4)} to {num(record.t_max, 4)}</span></dd></div>
			<div><dt>Bandwidth</dt><dd><strong>{record.bandwidth_years.toPrecision(3)} {unitLabel}</strong> <span class="qual">5 % of the span, clamped</span></dd></div>
			<div><dt>Candidates</dt><dd><strong>{record.stage1_candidates.toLocaleString('en-US')}</strong> <span class="qual">peak ≥ {sci(record.floors.tau_peak, 2)}, area ≥ {sci(record.floors.tau_auc, 2)}</span></dd></div>
			<div>
				<dt>Confirmed sweeps</dt>
				<dd>
					<!--
						THE COUNT IS A NUMBER IN ONE OF THE FOUR STATES AND AN EM DASH IN THE OTHER THREE, and
						`nulls` is what it switches on rather than `tested`. A run whose worker was terminated
						mid-null carries `tested: true` with `confirmed_sweeps` still the scored payload's zero,
						so keying this cell on `tested` printed a hard 0 and "0 also called by the static scan"
						for a run that never computed either.
					-->
					<strong>{nulls === 'finished' ? record.confirmed_sweeps.toLocaleString('en-US') : '—'}</strong>
					<span class="qual">
						{#if nulls === 'running'}
							the null is {perm!.completed.toLocaleString('en-US')} of {perm!.requested.toLocaleString('en-US')} shuffles through
						{:else if nulls === 'finished'}
							{record.concordant_sweeps} also called by the static scan
						{:else if perm?.skipped}
							the null was declined before it started, as over the work budget
						{:else if nulls === 'stopped'}
							this run ended before the null did, and the calls are computed only at the end
						{:else}
							the null has not been drawn
						{/if}
					</span>
				</dd>
			</div>
			<div><dt>Static scan</dt><dd><strong>{record.sig_static_q10.toLocaleString('en-US')}</strong> <span class="qual">codons at q ≤ {record.floors.q_static_cut}, over {record.codons_variable.toLocaleString('en-US')} variable ones</span></dd></div>
		</dl>

		<TrajectoryFigure
			model={trajectory}
			{units}
			{unitLabel}
			bandwidth={record.bandwidth_years}
			invariable={record.codons_invariable}
			codons={record.codons_total}
			{flat}
			{selected}
			onSelect={(s) => (selected = s)}
		/>
		<VelocityFigure model={velocity} {units} {unitLabel} timePoints={record.grid.time_points} {selected} onSelect={(s) => (selected = s)} />

		{#if waves}
			<WaveFigure model={waves} {units} {unitLabel} tMin={record.t_min} tMax={record.t_max} />
		{:else if nulls === 'running'}
			<p class="note">
				The wave modes are not drawn yet: the decomposition runs over the confirmed sweeps — or, if
				fewer than four codons are confirmed, over the strongest codons by peak intensity — and which
				of those happens is decided by the shuffles now being drawn. It lands with them.
			</p>
		{:else if nulls === 'stopped'}
			<p class="note">
				The wave modes were never extracted: the decomposition runs once, at the end of the run, and
				this run ended before it. Figures 4 and 5 above are final; run it again to get them.
			</p>
		{:else}
			<p class="note">
				No wave mode could be extracted: the decomposition needs at least one codon past the
				sweep-energy floor, and this run has none.
			</p>
		{/if}

		{#if classification}
			<ClassificationFigure model={classification} draws={perm?.completed ?? 0} {selected} onSelect={(s) => (selected = s)} />
		{:else if nulls === 'running'}
			<p class="note">
				The cross-classification is not drawn yet: one axis of it is the permutation p, which is still
				falling towards its final value at every candidate, and the four labels it partitions are
				computed once the shuffles finish — as are the wave modes the note above is standing in for.
				The two figures above are complete.
			</p>
		{:else if perm?.skipped}
			<p class="note">
				The cross-classification was never computed: one axis of it is the permutation p, and this
				run declined to draw the null at all. The two figures above are final, and the note above
				says why it was declined.
			</p>
		{:else if nulls === 'stopped'}
			<p class="note">
				The cross-classification was never computed: one axis of it is the permutation p, and this run
				ended before the labels it partitions were assigned. The two figures above are final.
			</p>
		{:else}
			<p class="note">
				The cross-classification cannot be drawn: it plots the date-shuffling null's evidence against
				the static scan's, and no shuffle was drawn. Figures 4 and 5 above are final, and so are the
				wave modes if this run had enough candidates to extract them.
			</p>
		{/if}

		<TemporalTable record={record} {units} {unitLabel} {selected} onSelect={(s) => (selected = s)} onDownload={() => onDownload('sites')} />

		<div class="statements">
			{#each notes as note (note.id)}
				<p class="note" class:note--warn={note.warn}><strong>{note.lead}</strong> {note.rest}</p>
			{/each}
		</div>

		{#if diagnostics.length}
			<details class="strip">
				<summary>
					<b>What this run did to your data, and what it could not say.</b>
					{diagnostics.length} note{diagnostics.length === 1 ? '' : 's'} from the pillar itself, in its own report order.
				</summary>
				<ul class="diags">
					{#each diagnostics as w (w.code)}
						<li class:warn={w.severity === 'warn'}>
							<span class="mono">{w.code}</span>
							{w.message}
						</li>
					{/each}
				</ul>
			</details>
		{/if}

		<div class="downloads">
			<button type="button" class="button button--secondary" onclick={() => onDownload('sites')}>Sites (CSV)</button>
			<button type="button" class="button button--secondary" onclick={() => onDownload('curves')}>Curves (CSV)</button>
			<button type="button" class="button button--secondary" onclick={() => onDownload('waves')}>Waves (CSV)</button>
			<button type="button" class="button button--secondary" onclick={() => onDownload('summary')}>Summary (JSON)</button>
		</div>
		<p class="hint downloads__note">
			These are the four files <code>hyphaeon temporal -o temporal</code> writes, with the same names,
			the same columns and the same rounding, written by the runtime's own writers.
			{#if downloadNotes.length}
				How far that likeness goes — and where it stops — is the runtime's to say, and it says it
				here:{#each downloadNotes as note, i (i)}{' '}{note}{/each}
			{:else}
				They hold what this page holds, which is a run that has not finished; the notes saying how far
				that likeness goes arrive with the completed record.
			{/if}
		</p>

		{#if reference}
			<p class="hint">This run at the command line:</p>
			<pre class="snippet">{reference.command}</pre>
			{#if !reference.reproduces}
				<p class="note note--warn"><strong>That command will not reproduce this run.</strong> {reference.caveats[0]}</p>
			{/if}
			{#each reference.caveats.slice(reference.reproduces ? 0 : 1) as caveat, i (i)}
				<p class="hint">{caveat}</p>
			{/each}
		{/if}
	{/if}
</div>

<style>
	.temporal {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.gate__reason {
		display: block;
	}
	.lede,
	.note,
	.hint {
		margin: 0;
	}
	.verdict {
		font-size: var(--text-lg);
		font-weight: 700;
		max-width: var(--measure);
	}
	.settings {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.settings summary {
		max-width: var(--measure);
		cursor: pointer;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		margin: var(--space-3) 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-md);
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
	.check {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: var(--text-md);
		margin-bottom: var(--space-3);
	}
	.check input {
		accent-color: var(--brand);
		margin: 0;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.running {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.progress {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.progress progress {
		width: 18rem;
		height: 2px;
		accent-color: var(--brand);
		border-radius: 0;
	}
	.progress .button {
		padding: 0.15rem 0.6rem;
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
	.statements {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.statements :global(strong) {
		color: var(--text);
		font-weight: 700;
	}
	.statements .note--warn :global(strong) {
		color: var(--warn);
	}
	.strip {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.strip summary {
		max-width: var(--measure);
		cursor: pointer;
	}
	.strip :global(b) {
		color: var(--text);
		font-weight: 700;
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
	.diags li.warn {
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-faint);
		margin-right: 0.5em;
	}
	.downloads {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.downloads__note {
		max-width: var(--measure);
	}
	.snippet {
		background: var(--surface-2);
		border-radius: 0;
		padding: var(--space-3);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		overflow-x: auto;
		margin: 0;
	}
</style>
