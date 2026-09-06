<!--
	+page.svelte (/analyze) — the hand-off between the drop zone and the report: diagnose, decide
	how the tree is handled, start `runEverything` in the analyze worker, navigate to /report/<id>/.

	WHY THIS FILE EXISTS. PLAN.md §4.0 / D21: the only user action is uploading a dataset, so this
	route has no analysis picker and no options form on the way to results. It receives the inputs
	(the landing page's sessionStorage hand-off with `?autorun=1`, or `?demo=<id>&autorun=1`), runs
	the library's `diagnose()` in the prep worker, follows the diagnostics' variant suggestion, then
	calls `startReport()` (lib/report/run.svelte.ts), which creates the record in IndexedDB and
	starts the ONE analyze worker that hosts the whole orchestrator, and navigates to the report
	while it runs. The report page shows the sections streaming in; nothing waits here except the
	few seconds of diagnostics.

	NOTHING IS DONE TO THE TREE HERE ANY MORE (D22). Phase 1 and 2 ran a second WebAssembly engine
	between the diagnosis and the run to fit branch lengths or build a tree, and that was the one
	step on this page that took real time. A tree with branch lengths is now used as given, and
	anything else goes tree-free: the library takes pairwise TN93 distances into the MDS inside
	`loadAlignmentAndTree`. `planTree()` is the whole of what is left — a pure decision, reported in
	the status line so the reader sees which path their dataset took.

	THE MANUAL FORM IS A FALLBACK. It appears only when autorun cannot proceed: the diagnosis
	refuses the inputs (too few taxa, frameshift, unmatched tree), the hand-off is missing, or a
	visitor arrives with nothing. It shows the inputs, the full "Before you run" table and the two
	settings that can unblock a refusal (taxon cap, reference sequence) plus the variant; every other
	setting lives on the report's "Re-run with…" disclosure. Defaults: taxon cap 256 (manifest
	`default_taxon_cap`), seed 42, B = 1,000 (the CLI's), DMS on within the browser work budget.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { DiagnosisSnapshot, ReportOptions, Variant } from '$lib/api';
	import { reportPath } from '$lib/api';
	import { DEMOS, chooseReference, loadDemo, readText } from '$lib/analyze/inputs';
	import { hasEmbeddedTree, sequenceNames, sniffFormat } from '$lib/analyze/sniff';
	import { panelModel, treePlanText, type PanelModel, type PrescreenResult } from '$lib/diagnostics/panel';
	import { planTree, startReport } from '$lib/report/run.svelte';
	import { DEFAULT_DMS_WORK_BUDGET, DEFAULT_PERMUTATIONS, DEFAULT_SEED, isAvailable as storageAvailable } from '$lib/storage/reports';
	import { prepClient, workersAvailable } from '$lib/workers/clients';
	import BeforeYouRun from './BeforeYouRun.svelte';

	const MAX_SPECIES_DEFAULT = 256;
	const MAX_SPECIES_HARD = 512;
	const MIN_SPECIES = 3;
	const DEBOUNCE_MS = 400;
	const HANDOFF_KEY = 'hyphaeon:handoff';

	// ---- inputs ----------------------------------------------------------------------------------
	let alignmentText = $state('');
	let alignmentName = $state<string | null>(null);
	let treeText = $state('');
	let treeName = $state<string | null>(null);
	let demoId = $state<string | null>(null);
	let loadError = $state<string | null>(null);

	// ---- settings that can unblock a refusal -----------------------------------------------------
	let reference = $state('');
	let referenceTouched = $state(false);
	let maxSpecies = $state(MAX_SPECIES_DEFAULT);
	let variant = $state<Variant>('general');
	let variantTouched = $state(false);

	// ---- diagnostics -----------------------------------------------------------------------------
	let diagnosis = $state<DiagnosisSnapshot | null>(null);
	let prescreen = $state<PrescreenResult | null>(null);
	let libraryNames = $state<string[]>([]);
	let diagnosisPending = $state(false);
	let diagnosisError = $state<string | null>(null);
	let diagnosisSeq = 0;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// ---- starting --------------------------------------------------------------------------------
	let starting = $state(false);
	let startMessage = $state<string | null>(null);
	let startError = $state<string | null>(null);
	let controller: AbortController | null = null;
	let browserReady = $state(false);

	// ---- autorun ---------------------------------------------------------------------------------
	let autorun = $state(false);
	let autorunFired = false;

	const sniffedNames = $derived(sequenceNames(alignmentText));
	const names = $derived(libraryNames.length ? libraryNames : sniffedNames);
	const format = $derived(sniffFormat(alignmentText));
	const embeddedSniffed = $derived(hasEmbeddedTree(alignmentText));
	const hasAlignment = $derived(alignmentText.trim().length > 0);
	const model = $derived<PanelModel | null>(panelModel(diagnosis));
	const embeddedTree = $derived(diagnosis?.summary.treeSource === 'embedded');
	const treeFree = $derived(model?.treePlan.kind === 'tree-free');
	const treeFreeReason = $derived(model?.treePlan.kind === 'tree-free' ? model.treePlan.reason : null);
	const canRun = $derived(browserReady && !starting && !diagnosisPending && model !== null && model.canRun);
	const refused = $derived(diagnosis !== null && !diagnosisPending && model !== null && !model.canRun);
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
		const params = page.url.searchParams;
		autorun = params.get('autorun') === '1';
		const demo = params.get('demo');
		if (demo) void useDemo(demo);
		else if (autorun) loadHandoff();
	});

	function loadHandoff() {
		let raw: string | null = null;
		try {
			raw = sessionStorage.getItem(HANDOFF_KEY);
			sessionStorage.removeItem(HANDOFF_KEY);
		} catch {
			raw = null;
		}
		if (!raw) {
			autorun = false;
			return;
		}
		try {
			const h = JSON.parse(raw) as { alignmentText?: string; alignmentName?: string | null; treeText?: string | null; treeName?: string | null };
			alignmentText = h.alignmentText ?? '';
			alignmentName = h.alignmentName ?? null;
			treeText = h.treeText ?? '';
			treeName = h.treeName ?? null;
			demoId = null;
		} catch {
			autorun = false;
			loadError = 'The handed-over file could not be read; upload it again.';
		}
	}

	// Autorun: start as soon as the diagnosis allows. Drop to the form only on a real refusal or
	// when this browser cannot run at all; a pending diagnosis must NOT cancel.
	$effect(() => {
		if (!autorun) return;
		if (!browserReady) {
			autorun = false;
			return;
		}
		if (refused) {
			autorun = false;
			return;
		}
		if (!autorunFired && canRun) {
			autorunFired = true;
			void run();
		}
	});

	$effect(() => {
		if (names.length === 0) {
			reference = '';
			referenceTouched = false;
		} else if (!referenceTouched || !names.includes(reference)) {
			reference = chooseReference(names) ?? names[0];
		}
	});

	$effect(() => {
		if (!variantTouched && model) variant = model.suggestedVariant;
	});

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
			autorun = false;
		}
	}

	function clampSpecies() {
		if (!Number.isFinite(maxSpecies)) maxSpecies = MAX_SPECIES_DEFAULT;
		maxSpecies = Math.min(MAX_SPECIES_HARD, Math.max(MIN_SPECIES, Math.round(maxSpecies)));
	}

	async function run() {
		if (!canRun || !diagnosis) return;
		starting = true;
		startError = null;
		controller = new AbortController();
		const options: ReportOptions = {
			variant,
			maxSpecies,
			referenceSequence: reference || null,
			callMode: 'percentile',
			seed: DEFAULT_SEED,
			dms: { enabled: true, workBudget: DEFAULT_DMS_WORK_BUDGET },
			permutations: DEFAULT_PERMUTATIONS
		};
		try {
			const tree = planTree({
				treeText: treeText.trim() ? treeText : null,
				embeddedTree,
				treeFree,
				treeFreeReason
			});
			startMessage = 'Starting the report…';
			const id = await startReport({
				alignmentText,
				alignmentName: alignmentName ?? `pasted.${format === 'unknown' ? 'txt' : format}`,
				uploadedTreeText: treeText.trim() ? treeText : null,
				treeName,
				tree,
				options,
				// A $state proxy cannot be structured-cloned into IndexedDB; store the plain snapshot.
				diagnosis: $state.snapshot(diagnosis),
				demo: demoId ?? undefined,
				base
			});
			await goto(`${base}${reportPath(id)}`);
		} catch (err) {
			startError = err instanceof Error && err.name === 'AbortError' ? 'Cancelled.' : err instanceof Error ? err.message : String(err);
			autorun = false;
		} finally {
			starting = false;
			controller = null;
			startMessage = null;
		}
	}

	function cancel() {
		controller?.abort();
	}
</script>

<svelte:head>
	<title>Analyzing · HyphAeon</title>
</svelte:head>

<div class="container container--narrow">
	{#if autorun}
		<p class="eyebrow">Analyzing</p>
		<h1>{alignmentName ?? demoId ?? 'Your alignment'}</h1>
		<p class="intro" aria-live="polite">
			{#if starting}{startMessage ?? 'Starting…'}{:else if diagnosisPending || !diagnosis}Checking the inputs…{:else}Starting…{/if}
		</p>
		{#if model && !diagnosisPending}
			<p class="treeplan" aria-live="polite">{treePlanText(model.treePlan)}</p>
		{/if}
		<p class="live">
			<span class="mark--run" aria-hidden="true"></span>
			<span>Every analysis runs in this browser; the report opens as soon as the inputs are ready and fills in section by section.</span>
			{#if starting}<button type="button" class="button button--secondary" onclick={cancel}>Cancel</button>{/if}
		</p>
		{#if hasAlignment && diagnosis}
			<BeforeYouRun {model} {prescreen} pending={diagnosisPending} {variant} onVariant={(v) => { variant = v; variantTouched = true; }} />
		{/if}
	{:else}
		<p class="eyebrow">Analyze</p>
		<h1>{refused ? 'The inputs need a change' : 'Upload an alignment'}</h1>
		<p class="intro">
			{#if refused}
				The checks below refused this dataset as it stands. Adjust the inputs or the two settings that can
				unblock it, and run again; everything else is set from the diagnostics and can be changed on the report.
			{:else}
				The landing page is the usual way in: drop a file there and everything runs. This form is the fallback
				for when the diagnostics refuse a dataset, or to paste one by hand.
			{/if}
		</p>

		<p class="demos" aria-label="Bundled examples">
			<span class="demos__label">Or try an example:</span>
			{#each DEMOS as demo (demo.id)}
				<button type="button" class="chip" class:chip--active={demoId === demo.id} title={demo.note} disabled={starting} onclick={() => useDemo(demo.id)}>{demo.label}</button>
			{/each}
		</p>

		{#if loadError}<p class="error notice--error" role="alert"><strong>Not accepted.</strong> {loadError}</p>{/if}

		<form class="card" onsubmit={(e) => { e.preventDefault(); void run(); }}>
			<fieldset disabled={starting}>
				<legend>Alignment</legend>
				<p class="pick">
					<label class="filelabel">Choose a file<input type="file" accept=".fasta,.fa,.fna,.nex,.nexus,.phy,.phylip,.txt,.gz" onchange={(e) => onPick(e, 'alignment')} /></label>
					{#if alignmentName}<code>{alignmentName}</code>{/if}
				</p>
				<label class="field">
					<span>Or paste it</span>
					<textarea bind:value={alignmentText} rows="6" spellcheck="false" placeholder=">hg38&#10;ATGGCC...&#10;>panTro4&#10;ATGGCC..." oninput={() => { alignmentName = null; demoId = null; }}></textarea>
				</label>
				{#if hasAlignment}
					<p class="summary" aria-live="polite">
						{#if format === 'unknown' && names.length === 0}
							Format not recognised from the first line. Expected FASTA (<code>&gt;</code>), NEXUS (<code>#NEXUS</code>) or PHYLIP (<code>ntaxa nsites</code>).
						{:else}
							{format === 'unknown' ? 'Alignment' : format.toUpperCase()} · {names.length} sequence{names.length === 1 ? '' : 's'}
							{#if diagnosis?.summary.codons}· {(diagnosis.summary.codons as number).toLocaleString()} codons{/if}
							{#if embeddedTree || embeddedSniffed}· embedded tree found{/if}
						{/if}
					</p>
				{/if}
			</fieldset>

			<fieldset disabled={starting}>
				<legend>Tree <span class="optional">(optional)</span></legend>
				{#if embeddedTree || embeddedSniffed}<p class="hint">The alignment carries a tree; a file here overrides it.</p>{/if}
				<p class="pick">
					<label class="filelabel">Choose a Newick file<input type="file" accept=".nwk,.newick,.tre,.tree,.txt,.gz" onchange={(e) => onPick(e, 'tree')} /></label>
					{#if treeName}<code>{treeName}</code>{/if}
				</p>
				<label class="field">
					<span>Or paste Newick</span>
					<textarea bind:value={treeText} rows="2" spellcheck="false" placeholder="((hg38:0.01,panTro4:0.01):0.02,...);" oninput={() => (treeName = null)}></textarea>
				</label>
			</fieldset>

			{#if hasAlignment}
				<BeforeYouRun {model} {prescreen} pending={diagnosisPending} {variant} onVariant={(v) => { variant = v; variantTouched = true; }} />
				{#if diagnosisError}<p class="error notice--error" role="alert"><strong>Diagnostics failed.</strong> {diagnosisError}</p>{/if}
			{/if}

			<fieldset class="options" disabled={starting}>
				<legend>Settings that can unblock a refusal</legend>
				<label class="field">
					<span>Reference sequence</span>
					<select bind:value={reference} disabled={names.length === 0} onchange={() => (referenceTouched = true)}>
						{#if names.length === 0}<option value="">Load an alignment first</option>{:else}{#each names as name (name)}<option value={name}>{name}</option>{/each}{/if}
					</select>
				</label>
				<label class="field">
					<span>Taxon cap</span>
					<input type="number" bind:value={maxSpecies} min={MIN_SPECIES} max={MAX_SPECIES_HARD} step="1" onchange={clampSpecies} />
					<small>Default {MAX_SPECIES_DEFAULT}, hard maximum {MAX_SPECIES_HARD}; larger alignments are reduced by Faith's PD.</small>
				</label>
				<div class="field" role="radiogroup" aria-labelledby="variant-label">
					<span id="variant-label">Model variant</span>
					<label class="radio"><input type="radio" name="variant" value="general" bind:group={variant} onchange={() => (variantTouched = true)} /> <span><strong>General</strong> — deep, cross-species trees</span></label>
					<label class="radio"><input type="radio" name="variant" value="viral" bind:group={variant} onchange={() => (variantTouched = true)} /> <span><strong>Viral</strong> — shallow trees</span></label>
					<small>{#if model}Suggested from the tree depth: <strong>{model.suggestedVariant}</strong>{#if !variantTouched}&nbsp;(followed until you choose){/if}.{:else}Suggested from the tree depth once an alignment is loaded.{/if}</small>
				</div>
				<p class="hint">Seed, permutations, call mode and the digital DMS budget are set on the report's "Re-run with…" disclosure.</p>
			</fieldset>

			<div class="run">
				<button class="button" type="submit" disabled={!canRun}>{starting ? (startMessage ?? 'Starting…') : 'Run everything'}</button>
				<p class="hint">
					{#if runDisabledReason && !starting}{runDisabledReason}{:else}Runs in Web Workers on this machine; nothing is uploaded. The report is stored in this browser.{/if}
				</p>
				{#if starting}<button type="button" class="button button--secondary" onclick={cancel}>Cancel</button>{/if}
			</div>
			{#if startError}<p class="error notice--error" role="alert"><strong>The run did not start.</strong> {startError}</p>{/if}
		</form>
	{/if}
</div>

<style>
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-4);
	}
	.treeplan {
		color: var(--text-muted);
		font-size: var(--text-md);
		margin: calc(-1 * var(--space-3)) 0 var(--space-4);
	}
	.live {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-md);
		color: var(--text-muted);
		margin-bottom: var(--space-6);
		max-width: none;
	}
	.live .mark--run {
		flex: none;
		margin: 0;
	}
	.demos {
		margin-bottom: var(--space-6);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.chip {
		background: none;
		border: 0;
		padding: 0;
		color: var(--link);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
		font-size: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.chip:hover {
		text-decoration-thickness: 2px;
	}
	.chip + .chip::before {
		content: '·';
		color: var(--text-faint);
		margin: 0 var(--space-2);
		display: inline-block;
		text-decoration: none;
	}
	.chip--active {
		color: var(--text);
		font-weight: 700;
		text-decoration: none;
	}
	.chip:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.error {
		font-size: var(--text-md);
		margin: 0 0 var(--space-4);
	}
	.card {
		display: grid;
		gap: var(--space-6);
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
		width: 100%;
		font-size: var(--text-base);
		font-weight: 700;
		padding: 0 0 var(--space-2);
		margin-bottom: var(--space-3);
		border-bottom: 1px solid var(--rule);
	}
	.optional {
		font-size: var(--text-sm);
		font-weight: 400;
		color: var(--text-faint);
		margin-left: var(--space-1);
	}
	.pick {
		margin: 0;
		display: flex;
		gap: var(--space-3);
		align-items: center;
		font-size: var(--text-md);
	}
	.filelabel {
		color: var(--link);
		text-decoration: underline;
		text-underline-offset: 0.16em;
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
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.field small {
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
	textarea,
	select,
	input[type='number'] {
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	input[type='number'] {
		max-width: 8rem;
	}
	.options {
		gap: var(--space-4);
	}
	.radio {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-size: var(--text-md);
		font-weight: 400;
	}
	.summary,
	.hint {
		font-size: var(--text-md);
		color: var(--text-muted);
		margin: 0;
	}
	.run {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		flex-wrap: wrap;
		border-top: 1px solid var(--rule);
		padding-top: var(--space-4);
	}
	.run .hint {
		flex: 1 1 18rem;
	}
</style>
