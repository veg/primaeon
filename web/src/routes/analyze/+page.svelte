<!--
	+page.svelte (/analyze) — the upload card, with the pipeline still to come.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "Upload → diagnostics → analysis picker → options → run."
	Phase 0 delivers the first box: an alignment by drag-and-drop, file picker or paste (gzip
	inflated with pako); an optional tree the same way; a reference-sequence select; the taxon cap;
	and the model variant. The Run button is disabled on purpose and says why: preprocessing, MDS,
	ORT inference and post-processing arrive in Phase 1 through `@veg/hyphaeon-runtime`.

	CONSTANTS. Max species default 256, hard max 512, minimum 3: PLAN.md §3.3 manifest
	(`taxon_cap`, `default_taxon_cap`) and §4.3 (taxa < 3 refused, issue #7). Variant default
	`general`: D10, with `viral` suggested by the diagnostics once they exist.

	REFERENCE SEQUENCE. Defaults to the first sequence. DM3's `chooseReference` heuristic (hg / hg38
	/ human first, then the first sequence) comes with the library's parser in Phase 1; TODO(phase1)
	replace `sequenceNames` with the parsed alignment's taxa and apply that heuristic.
-->
<script lang="ts">
	import {
		approximateCodonLength,
		hasEmbeddedTree,
		looksLikeGzip,
		sequenceNames,
		sniffFormat
	} from '$lib/analyze/sniff';

	const MAX_SPECIES_DEFAULT = 256;
	const MAX_SPECIES_HARD = 512;
	const MIN_SPECIES = 3;

	let alignmentText = $state('');
	let alignmentName = $state<string | null>(null);
	let treeText = $state('');
	let treeName = $state<string | null>(null);
	let reference = $state('');
	let maxSpecies = $state(MAX_SPECIES_DEFAULT);
	let variant = $state<'general' | 'viral'>('general');
	let alignmentDragging = $state(false);
	let treeDragging = $state(false);
	let loadError = $state<string | null>(null);

	const names = $derived(sequenceNames(alignmentText));
	const format = $derived(sniffFormat(alignmentText));
	const embeddedTree = $derived(hasEmbeddedTree(alignmentText));
	const codons = $derived(approximateCodonLength(alignmentText));

	$effect(() => {
		// Keep the reference valid as the alignment changes; default to the first sequence.
		if (names.length === 0) {
			reference = '';
		} else if (!names.includes(reference)) {
			reference = names[0];
		}
	});

	/** Read a File as text, inflating it first when it is gzipped. */
	async function readFile(file: File): Promise<string> {
		const buffer = new Uint8Array(await file.arrayBuffer());
		if (looksLikeGzip(buffer)) {
			const pako = await import('pako');
			return pako.ungzip(buffer, { to: 'string' });
		}
		return new TextDecoder().decode(buffer);
	}

	async function acceptFile(file: File | undefined, target: 'alignment' | 'tree') {
		if (!file) return;
		loadError = null;
		try {
			const text = await readFile(file);
			if (target === 'alignment') {
				alignmentText = text;
				alignmentName = file.name;
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

	function clampSpecies() {
		if (!Number.isFinite(maxSpecies)) maxSpecies = MAX_SPECIES_DEFAULT;
		maxSpecies = Math.min(MAX_SPECIES_HARD, Math.max(MIN_SPECIES, Math.round(maxSpecies)));
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
		one. Without a tree, one is estimated here; without branch lengths, they are fitted here. The
		file never leaves this page.
	</p>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{/if}

	<form class="card" onsubmit={(e) => e.preventDefault()}>
		<!-- Alignment -->
		<fieldset>
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
					oninput={() => (alignmentName = null)}
				></textarea>
			</label>
			{#if alignmentText.trim()}
				<p class="summary" aria-live="polite">
					{#if format === 'unknown'}
						Format not recognised from the first line. Expected FASTA (<code>&gt;</code>), NEXUS
						(<code>#NEXUS</code>) or PHYLIP (<code>ntaxa nsites</code>).
					{:else}
						{format.toUpperCase()} · {names.length} sequence{names.length === 1 ? '' : 's'}
						{#if codons !== null}
							· about {codons.toLocaleString()} codons
						{/if}
						{#if embeddedTree}
							· embedded tree found
						{/if}
					{/if}
				</p>
			{/if}
		</fieldset>

		<!-- Tree -->
		<fieldset>
			<legend>Tree <span class="optional">optional</span></legend>
			{#if embeddedTree}
				<p class="hint">
					The alignment carries a TREES block; a file here overrides it.
				</p>
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

		<!-- Options -->
		<fieldset class="options">
			<legend>Options</legend>

			<label class="field">
				<span>Reference sequence</span>
				<select bind:value={reference} disabled={names.length === 0}>
					{#if names.length === 0}
						<option value="">Load an alignment first</option>
					{:else}
						{#each names as name (name)}
							<option value={name}>{name}</option>
						{/each}
					{/if}
				</select>
				<small>Site coordinates are reported in this sequence's frame, gaps skipped.</small>
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
					reduced by Faith's phylogenetic diversity, keeping the reference.
				</small>
			</label>

			<div class="field" role="radiogroup" aria-labelledby="variant-label">
				<span id="variant-label">Model variant</span>
				<label class="radio">
					<input type="radio" name="variant" value="general" bind:group={variant} />
					<span><strong>General</strong> — trained on 742 mammalian species; deep, cross-species trees.</span>
				</label>
				<label class="radio">
					<input type="radio" name="variant" value="viral" bind:group={variant} />
					<span><strong>Viral</strong> — fine-tuned on ~9,300 viral alignments; shallow trees.</span>
				</label>
				<small>The diagnostics will suggest a variant from tree depth once they land.</small>
			</div>
		</fieldset>

		<div class="run">
			<button class="button" type="submit" disabled aria-describedby="run-note">Run</button>
			<p id="run-note" class="hint">
				Not yet: the in-browser pipeline (preprocessing, MDS, ONNX inference, post-processing)
				lands in Phase 1 through <code>@veg/hyphaeon-runtime</code>. The inputs above are held in
				this page only.
			</p>
		</div>
	</form>
</div>

<style>
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-5);
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
		transition: border-color 120ms ease, background 120ms ease;
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
	.radio {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.radio input {
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
