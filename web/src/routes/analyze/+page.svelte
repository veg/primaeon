<!--
	+page.svelte (/analyze) — upload → diagnostics → options → run in workers → persist → results.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "Upload → diagnostics → analysis picker → options → run.
	Everything runs here." Phase 0 built the upload card with Run disabled; Phase 1b wires the
	rest: the library's parser names the sequences (prep worker), the "Before you run" panel
	re-runs `diagnose` and the prescreen on every input change (debounced), the tree tools and the
	inference run in workers (lib/analyze/run.ts), the record is stored in IndexedDB
	(lib/storage/results.ts) and the page navigates to /results/<id>/.

	CONSTANTS. Max species default 256, hard max 512, minimum 3: PLAN.md §3.3 manifest
	(`taxon_cap`, `default_taxon_cap`) and §4.3 (taxa < 3 refused, issue #7). Variant default
	`general` (D10); the diagnostics' suggestion is FOLLOWED automatically until the user picks a
	variant by hand (`variantTouched`), because §2 hard truth 6 says the choice must be visible
	and suggested, not silently made. Call mode default `percentile` (runtime callModes.js: the
	model is a ranker; the reference's q-based call usually reports nothing).

	DEMOS. `?demo=<id>` (the gallery's "run in browser" link) or the buttons load
	static/gallery/inputs/<id>.{fasta,nwk}; the record remembers the demo id.

	DEBOUNCE. 400 ms after the last change to the alignment, the tree or the taxon cap; a
	sequence number discards a diagnosis that arrives for stale inputs.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { CallMode, DiagnosisSnapshot, RunOptions, StepRecord, Variant } from '$lib/api';
	import { resultsPath } from '$lib/api';
	import { DEMOS, chooseReference, loadDemo, readText } from '$lib/analyze/inputs';
	import { freshSteps, runAnalysis } from '$lib/analyze/run';
	import { hasEmbeddedTree, sequenceNames, sniffFormat } from '$lib/analyze/sniff';
	import { panelModel, type PanelModel, type PrescreenResult } from '$lib/diagnostics/panel';
	import { isAvailable as storageAvailable } from '$lib/storage/results';
	import { prepClient, workersAvailable } from '$lib/workers/clients';
	import BeforeYouRun from './BeforeYouRun.svelte';
	import ProgressChecklist from './ProgressChecklist.svelte';

	const MAX_SPECIES_DEFAULT = 256;
	const MAX_SPECIES_HARD = 512;
	const MIN_SPECIES = 3;
	const DEBOUNCE_MS = 400;

	// ---- inputs ----------------------------------------------------------------------------------
	let alignmentText = $state('');
	let alignmentName = $state<string | null>(null);
	let treeText = $state('');
	let treeName = $state<string | null>(null);
	let demoId = $state<string | null>(null);
	let alignmentDragging = $state(false);
	let treeDragging = $state(false);
	let loadError = $state<string | null>(null);

	// ---- options ---------------------------------------------------------------------------------
	let reference = $state('');
	let referenceTouched = $state(false);
	let maxSpecies = $state(MAX_SPECIES_DEFAULT);
	let variant = $state<Variant>('general');
	let variantTouched = $state(false);
	let callMode = $state<CallMode>('percentile');
	let filter = $state(false);
	let attribute = $state(false);

	// ---- diagnostics -----------------------------------------------------------------------------
	let diagnosis = $state<DiagnosisSnapshot | null>(null);
	let prescreen = $state<PrescreenResult | null>(null);
	let libraryNames = $state<string[]>([]);
	let diagnosisPending = $state(false);
	let diagnosisError = $state<string | null>(null);
	let diagnosisSeq = 0;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// ---- run -------------------------------------------------------------------------------------
	let running = $state(false);
	let steps = $state<StepRecord[]>(freshSteps());
	let runError = $state<string | null>(null);
	let controller: AbortController | null = null;
	let browserReady = $state(false);

	const sniffedNames = $derived(sequenceNames(alignmentText));
	const names = $derived(libraryNames.length ? libraryNames : sniffedNames);
	const format = $derived(sniffFormat(alignmentText));
	const embeddedSniffed = $derived(hasEmbeddedTree(alignmentText));
	const hasAlignment = $derived(alignmentText.trim().length > 0);
	const treeToolsAvailable = $derived(browserReady);
	const model = $derived<PanelModel | null>(panelModel(diagnosis, treeToolsAvailable));
	const embeddedTree = $derived(diagnosis?.summary.treeSource === 'embedded');
	const branchLengthsMissing = $derived(Boolean(diagnosis?.warnings.some((w) => w.code === 'BRANCH_LENGTHS_MISSING')));
	const canRun = $derived(browserReady && !running && !diagnosisPending && model !== null && model.canRun);
	const runDisabledReason = $derived(
		!browserReady
			? 'Web Workers and IndexedDB are required; this browser has neither.'
			: !hasAlignment
				? 'Load an alignment first.'
				: diagnosisPending
					? 'Checking the inputs…'
					: model && !model.canRun
						? (model.blocking[0]?.message ?? 'The inputs were refused.')
						: null
	);

	onMount(() => {
		browserReady = workersAvailable() && storageAvailable();
		const demo = page.url.searchParams.get('demo');
		if (demo) void useDemo(demo);
	});

	// Keep the reference valid as the alignment changes; default per DM3's heuristic.
	$effect(() => {
		if (names.length === 0) {
			reference = '';
			referenceTouched = false;
		} else if (!referenceTouched || !names.includes(reference)) {
			reference = chooseReference(names) ?? names[0];
		}
	});

	// Follow the diagnostics' variant suggestion until the user picks one.
	$effect(() => {
		if (!variantTouched && model) variant = model.suggestedVariant;
	});

	// Re-diagnose on every input change, debounced.
	$effect(() => {
		const a = alignmentText;
		const t = treeText;
		const cap = maxSpecies;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (!a.trim()) {
			diagnosis = null;
			prescreen = null;
			libraryNames = [];
			diagnosisPending = false;
			return;
		}
		diagnosisPending = true;
		debounceTimer = setTimeout(() => void diagnose(a, t, cap), DEBOUNCE_MS);
		return () => {
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});

	async function diagnose(a: string, t: string, cap: number) {
		if (!workersAvailable()) {
			diagnosisPending = false;
			return;
		}
		const seq = ++diagnosisSeq;
		diagnosisError = null;
		try {
			const response = await prepClient().call({
				alignmentText: a,
				treeText: t.trim() ? t : null,
				maxSpecies: cap,
				treeSource: t.trim() ? 'user' : 'unknown',
				prescreen: true
			});
			if (seq !== diagnosisSeq) return;
			diagnosis = response.diagnosis;
			prescreen = response.prescreen;
			libraryNames = response.names;
		} catch (err) {
			if (seq !== diagnosisSeq) return;
			diagnosisError = err instanceof Error ? err.message : String(err);
			diagnosis = null;
			prescreen = null;
		} finally {
			if (seq === diagnosisSeq) diagnosisPending = false;
		}
	}

	async function acceptFile(file: File | undefined, target: 'alignment' | 'tree') {
		if (!file) return;
		loadError = null;
		try {
			const text = await readText(file);
			if (target === 'alignment') {
				alignmentText = text;
				alignmentName = file.name;
				demoId = null;
			} else {
				treeText = text;
				treeName = file.name;
			}
		} catch (err) {
			loadError = `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	function onDrop(event: DragEvent, target: 'alignment' | 'tree') {
		event.preventDefault();
		alignmentDragging = false;
		treeDragging = false;
		void acceptFile(event.dataTransfer?.files?.[0], target);
	}

	function onPick(event: Event, target: 'alignment' | 'tree') {
		const input = event.currentTarget as HTMLInputElement;
		void acceptFile(input.files?.[0], target);
		input.value = '';
	}

	async function useDemo(id: string) {
		loadError = null;
		try {
			const demo = await loadDemo(id, base);
			alignmentText = demo.alignmentText;
			alignmentName = demo.alignmentName;
			treeText = demo.treeText ?? '';
			treeName = demo.treeName;
			demoId = demo.id;
			variantTouched = false;
			referenceTouched = false;
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	function clampSpecies() {
		if (!Number.isFinite(maxSpecies)) maxSpecies = MAX_SPECIES_DEFAULT;
		maxSpecies = Math.min(MAX_SPECIES_HARD, Math.max(MIN_SPECIES, Math.round(maxSpecies)));
	}

	async function run() {
		if (!canRun || !diagnosis) return;
		running = true;
		runError = null;
		steps = freshSteps();
		controller = new AbortController();
		const options: RunOptions = {
			variant,
			maxSpecies,
			referenceSequence: reference || null,
			callMode,
			filter,
			attribute
		};
		try {
			const record = await runAnalysis({
				alignmentText,
				alignmentName: alignmentName ?? `pasted.${format === 'unknown' ? 'txt' : format}`,
				treeText: treeText.trim() ? treeText : null,
				treeName,
				embeddedTree,
				branchLengthsMissing,
				options,
				// A $state proxy cannot be structured-cloned into IndexedDB; store the plain snapshot.
				diagnosis: $state.snapshot(diagnosis),
				demo: demoId ?? undefined,
				base,
				signal: controller.signal,
				onSteps: (s) => (steps = s)
			});
			await goto(`${base}${resultsPath(record.id)}`);
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				runError = 'Run cancelled.';
			} else {
				runError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			running = false;
			controller = null;
		}
	}

	function cancel() {
		controller?.abort();
	}
</script>

<svelte:head>
	<title>Analyze · HyphAeon</title>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">Analyze</p>
	<h1>Upload an alignment</h1>
	<p class="intro">
		A codon alignment in FASTA, NEXUS or PHYLIP (optionally gzipped), and a Newick tree if you have
		one. Without a tree, one is inferred here; without branch lengths, they are fitted here. The
		file never leaves this page.
	</p>

	<div class="demos" aria-label="Bundled examples">
		<span class="demos__label">Try an example:</span>
		{#each DEMOS as demo (demo.id)}
			<button
				type="button"
				class="chip"
				class:chip--active={demoId === demo.id}
				title={demo.note}
				disabled={running}
				onclick={() => useDemo(demo.id)}
			>
				{demo.label}
			</button>
		{/each}
	</div>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{/if}

	<form class="card" onsubmit={(e) => { e.preventDefault(); void run(); }}>
		<!-- Alignment -->
		<fieldset disabled={running}>
			<legend>Alignment</legend>
			<div
				class="dropzone"
				class:dropzone--active={alignmentDragging}
				role="group"
				aria-label="Alignment drop zone"
				ondragover={(e) => {
					e.preventDefault();
					alignmentDragging = true;
				}}
				ondragleave={() => (alignmentDragging = false)}
				ondrop={(e) => onDrop(e, 'alignment')}
			>
				<p>
					Drop a file here, or
					<label class="filelabel">
						choose one
						<input
							type="file"
							accept=".fasta,.fa,.fna,.nex,.nexus,.phy,.phylip,.txt,.gz"
							onchange={(e) => onPick(e, 'alignment')}
						/>
					</label>
				</p>
				{#if alignmentName}
					<p class="filename"><code>{alignmentName}</code></p>
				{/if}
			</div>
			<label class="field">
				<span>Or paste it</span>
				<textarea
					bind:value={alignmentText}
					rows="6"
					spellcheck="false"
					placeholder=">hg38&#10;ATGGCC...&#10;>panTro4&#10;ATGGCC..."
					oninput={() => {
						alignmentName = null;
						demoId = null;
					}}
				></textarea>
			</label>
			{#if hasAlignment}
				<p class="summary" aria-live="polite">
					{#if format === 'unknown' && names.length === 0}
						Format not recognised from the first line. Expected FASTA (<code>&gt;</code>), NEXUS
						(<code>#NEXUS</code>) or PHYLIP (<code>ntaxa nsites</code>).
					{:else}
						{format === 'unknown' ? 'Alignment' : format.toUpperCase()} · {names.length} sequence{names.length === 1 ? '' : 's'}
						{#if diagnosis?.summary.codons}
							· {(diagnosis.summary.codons as number).toLocaleString()} codons
						{/if}
						{#if embeddedTree || embeddedSniffed}
							· embedded tree found
						{/if}
					{/if}
				</p>
			{/if}
		</fieldset>

		<!-- Tree -->
		<fieldset disabled={running}>
			<legend>Tree <span class="optional">optional</span></legend>
			{#if embeddedTree || embeddedSniffed}
				<p class="hint">The alignment carries a tree; a file here overrides it.</p>
			{/if}
			<div
				class="dropzone dropzone--compact"
				class:dropzone--active={treeDragging}
				role="group"
				aria-label="Tree drop zone"
				ondragover={(e) => {
					e.preventDefault();
					treeDragging = true;
				}}
				ondragleave={() => (treeDragging = false)}
				ondrop={(e) => onDrop(e, 'tree')}
			>
				<p>
					Drop a Newick file, or
					<label class="filelabel">
						choose one
						<input
							type="file"
							accept=".nwk,.newick,.tre,.tree,.txt,.gz"
							onchange={(e) => onPick(e, 'tree')}
						/>
					</label>
				</p>
				{#if treeName}
					<p class="filename"><code>{treeName}</code></p>
				{/if}
			</div>
			<label class="field">
				<span>Or paste Newick</span>
				<textarea
					bind:value={treeText}
					rows="2"
					spellcheck="false"
					placeholder="((hg38:0.01,panTro4:0.01):0.02,...);"
					oninput={() => (treeName = null)}
				></textarea>
			</label>
		</fieldset>

		<!-- Before you run -->
		{#if hasAlignment}
			<BeforeYouRun
				{model}
				{prescreen}
				pending={diagnosisPending}
				{variant}
				onVariant={(v) => {
					variant = v;
					variantTouched = true;
				}}
			/>
			{#if diagnosisError}
				<p class="error" role="alert">Diagnostics failed: {diagnosisError}</p>
			{/if}
		{/if}

		<!-- Options -->
		<fieldset class="options" disabled={running}>
			<legend>Options</legend>

			<label class="field">
				<span>Reference sequence</span>
				<select
					bind:value={reference}
					disabled={names.length === 0}
					onchange={() => (referenceTouched = true)}
				>
					{#if names.length === 0}
						<option value="">Load an alignment first</option>
					{:else}
						{#each names as name (name)}
							<option value={name}>{name}</option>
						{/each}
					{/if}
				</select>
				<small>Site coordinates and the codon column are reported in this sequence's frame.</small>
			</label>

			<label class="field">
				<span>Max species</span>
				<input
					type="number"
					bind:value={maxSpecies}
					min={MIN_SPECIES}
					max={MAX_SPECIES_HARD}
					step="1"
					onchange={clampSpecies}
				/>
				<small>
					Default {MAX_SPECIES_DEFAULT}, hard maximum {MAX_SPECIES_HARD}. Larger alignments are
					reduced by Faith's phylogenetic diversity after identical sequences are collapsed.
				</small>
			</label>

			<div class="field" role="radiogroup" aria-labelledby="variant-label">
				<span id="variant-label">Model variant</span>
				<label class="radio">
					<input type="radio" name="variant" value="general" bind:group={variant} onchange={() => (variantTouched = true)} />
					<span><strong>General</strong> — trained on 742 mammalian species; deep, cross-species trees.</span>
				</label>
				<label class="radio">
					<input type="radio" name="variant" value="viral" bind:group={variant} onchange={() => (variantTouched = true)} />
					<span><strong>Viral</strong> — fine-tuned on ~9,300 viral alignments; shallow trees.</span>
				</label>
				<small>
					{#if model}
						Suggested from the tree depth: <strong>{model.suggestedVariant}</strong>{#if !variantTouched}&nbsp;(followed automatically until you choose){/if}.
					{:else}
						The diagnostics suggest a variant from the tree depth once an alignment is loaded.
					{/if}
				</small>
			</div>

			<div class="field" role="radiogroup" aria-labelledby="callmode-label">
				<span id="callmode-label">Call mode</span>
				<label class="radio">
					<input type="radio" name="callmode" value="percentile" bind:group={callMode} />
					<span><strong>Percentile</strong> (default) — the top 2% of this alignment's variable sites as Tier 1, the next 3% as Tier 2; a ranking, always non-empty.</span>
				</label>
				<label class="radio">
					<input type="radio" name="callmode" value="zscore" bind:group={callMode} />
					<span><strong>Z-score</strong> — Z ≥ 2.5 / 2.0 above the alignment's own mean predicted LRT.</span>
				</label>
				<label class="radio">
					<input type="radio" name="callmode" value="pvalue" bind:group={callMode} />
					<span><strong>p-value / q</strong> — the reference's fixed LRT gates (4.45 / 3.12); usually reports nothing.</span>
				</label>
			</div>

			<div class="field">
				<span>Extras</span>
				<label class="check">
					<input type="checkbox" bind:checked={filter} />
					<span><strong>Filter</strong> — <code>--filter</code>: screen for alignment artifacts (outlier patches), mask them and re-score.</span>
				</label>
				<label class="check">
					<input type="checkbox" bind:checked={attribute} />
					<span><strong>Attribute</strong> — <code>--attribute</code>: per-taxon counterfactual ΔLRT on sites with LRT ≥ 3.84 (one extra pass per taxon per site).</span>
				</label>
			</div>
		</fieldset>

		<div class="run">
			<button class="button" type="submit" disabled={!canRun} aria-describedby="run-note">
				{running ? 'Running…' : 'Run'}
			</button>
			<p id="run-note" class="hint">
				{#if runDisabledReason && !running}
					{runDisabledReason}
				{:else if running}
					Runs in Web Workers on this machine; the page stays usable. Cancel stops between batches.
				{:else}
					Runs in Web Workers on this machine; nothing is uploaded. The result is stored in this browser's IndexedDB.
				{/if}
			</p>
		</div>

		{#if running || steps.some((s) => s.status !== 'pending')}
			<ProgressChecklist {steps} cancel={running ? cancel : undefined} />
		{/if}
		{#if runError}
			<p class="error" role="alert">{runError}</p>
		{/if}
	</form>
</div>

<style>
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-4);
	}

	.demos {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-5);
		font-size: var(--text-sm);
	}
	.demos__label {
		color: var(--text-muted);
	}
	.chip {
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		border-radius: 999px;
		padding: 0.25rem 0.8rem;
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
	}
	.chip:hover {
		border-color: var(--brand);
		color: var(--brand);
	}
	.chip--active {
		background: var(--brand-soft);
		border-color: var(--brand);
		color: var(--brand);
	}
	.chip:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.error {
		color: var(--danger);
		background: var(--danger-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
	}

	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
		padding: var(--space-5);
		display: grid;
		gap: var(--space-5);
	}

	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
		display: grid;
		gap: var(--space-3);
	}
	legend {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		padding: 0;
		margin-bottom: var(--space-2);
	}
	.optional {
		font-family: var(--font-text);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-left: var(--space-2);
	}

	.dropzone {
		border: 2px dashed var(--border-strong);
		border-radius: var(--radius);
		padding: var(--space-5);
		text-align: center;
		color: var(--text-muted);
		background: var(--bg-subtle);
		transition:
			border-color 120ms ease,
			background 120ms ease;
	}
	.dropzone--compact {
		padding: var(--space-3);
	}
	.dropzone--active {
		border-color: var(--brand);
		background: var(--brand-soft);
	}
	.dropzone p {
		margin: 0;
	}
	.filename {
		margin-top: var(--space-2) !important;
	}
	.filelabel {
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
	}
	.filelabel input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		overflow: hidden;
	}

	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field > span {
		font-weight: 600;
		font-size: var(--text-sm);
	}
	.field small {
		color: var(--text-faint);
		font-size: var(--text-xs);
	}
	textarea,
	select,
	input[type='number'] {
		width: 100%;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		padding: var(--space-2) var(--space-3);
	}
	textarea {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		resize: vertical;
	}
	input[type='number'] {
		max-width: 8rem;
	}

	.options {
		gap: var(--space-4);
	}
	.radio,
	.check {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.radio input,
	.check input {
		margin-top: 0.3em;
	}

	.summary,
	.hint {
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: 0;
	}

	.run {
		display: flex;
		gap: var(--space-4);
		align-items: flex-start;
		flex-wrap: wrap;
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
	}
	.run .hint {
		flex: 1 1 18rem;
	}
</style>
