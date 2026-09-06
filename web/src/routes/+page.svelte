<!--
	+page.svelte (/) — the landing page is the drop zone.

	WHY THIS FILE EXISTS. PLAN.md §4.0 / D21 (2026-09-05): the only thing the interface asks for is a
	dataset. Dropping or pasting an alignment (optionally with a Newick tree) starts every analysis;
	there is no picker and no options form. The caveats about the model (its relation to MEME,
	regime dependence) belong in the report and on the methods page, next to the numbers they
	qualify, not here. This page therefore carries one sentence and the inputs.

	HANDOFF. The pipeline, workers and diagnostics live on the analyze route. This page reads the
	dropped files as text, parks them in sessionStorage under HANDOFF_KEY, and navigates to
	/analyze/?autorun=1, which loads the handoff and runs as soon as diagnostics allow (see
	analyze/+page.svelte).

	EXAMPLES. The five links are the README's bundled datasets (lib/gallery/examples.json). Each
	opens its PREBAKED report at /report/gallery/<id>/ — every analysis already run at build time by
	web/scripts/prebake-gallery.mjs — so an example is instant and costs no model download; the
	link's title is the README table's one-line description of the dataset. PLAN.md §4.1 folds the
	Phase 1 /gallery cards into these links; /gallery/ now redirects here.

	DELIVERY. This route must request nothing beyond its own HTML, CSS, JS and favicon: no model, no
	ORT WASM, no workers (PLAN.md §4.4). ../../e2e/smoke.spec.ts asserts it.

	LOOK. web/DESIGN.md §3 "Landing": h1, one sentence, a dashed hairline rectangle, a disclosure for
	pasting, and the examples as one sentence of links. Nothing is centred and nothing is filled.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { readText } from '$lib/analyze/inputs';
	import catalogue from '$lib/gallery/examples.json';
	import type { GalleryExample } from '$lib/gallery/types';

	const EXAMPLES: readonly GalleryExample[] = catalogue.examples as GalleryExample[];

	const HANDOFF_KEY = 'hyphaeon:handoff';
	const TREE_EXT = /\.(nwk|newick|tree|tre|nex|nexus)$/i;

	let dragging = $state(false);
	let pasted = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	type Handoff = {
		alignmentText: string;
		alignmentName: string | null;
		treeText: string | null;
		treeName: string | null;
	};

	async function start(handoff: Handoff) {
		try {
			sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
		} catch {
			error = 'This browser blocks session storage, so the file cannot be handed to the analysis page.';
			return;
		}
		await goto(`${base}/analyze/?autorun=1`);
	}

	async function acceptFiles(list: FileList | File[] | null | undefined) {
		if (!list || list.length === 0) return;
		error = null;
		busy = true;
		try {
			const files = Array.from(list).slice(0, 2);
			// One or two files: the Newick-looking one is the tree, the other is the alignment.
			// A NEXUS file can carry both, so it only counts as a tree when a second file exists.
			let alignment: File | undefined;
			let tree: File | undefined;
			if (files.length === 1) {
				alignment = files[0];
			} else {
				tree = files.find((f) => TREE_EXT.test(f.name) && !/\.(nex|nexus)$/i.test(f.name)) ?? files.find((f) => TREE_EXT.test(f.name));
				alignment = files.find((f) => f !== tree);
			}
			if (!alignment) throw new Error('Drop an alignment file (FASTA, NEXUS or PHYLIP).');
			const alignmentText = await readText(alignment);
			const treeText = tree ? await readText(tree) : null;
			await start({ alignmentText, alignmentName: alignment.name, treeText, treeName: tree?.name ?? null });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		void acceptFiles(event.dataTransfer?.files);
	}

	function onPick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void acceptFiles(input.files);
		input.value = '';
	}

	async function startPasted() {
		if (!pasted.trim()) return;
		await start({ alignmentText: pasted, alignmentName: null, treeText: null, treeName: null });
	}

	/** The prebaked report for an example (api.ts `reportPath('gallery/<id>')`, spelled out to keep this route light). */
	function reportHref(example: GalleryExample): string {
		return `${base}/report/gallery/${encodeURIComponent(example.id)}/`;
	}
</script>

<svelte:head>
	<title>HyphAeon</title>
	<meta
		name="description"
		content="Drop a codon alignment. HyphAeon predicts episodic selection per site, a gene-level verdict, epistatic sectors and a digital deep mutational scan, in your browser, in seconds."
	/>
</svelte:head>

<section class="hero container container--narrow">
	<h1>HyphAeon</h1>
	<p class="lede">Drop a codon alignment. Every analysis runs here, in seconds, and nothing leaves your browser.</p>

	<label
		class="dropzone"
		class:dropzone--active={dragging}
		class:dropzone--busy={busy}
		ondragover={(e) => { e.preventDefault(); dragging = true; }}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		<input type="file" multiple accept=".fasta,.fa,.fna,.aln,.nex,.nexus,.phy,.phylip,.gz,.nwk,.newick,.tree,.tre" onchange={onPick} disabled={busy} />
		<span class="dropzone__title">{busy ? 'Reading…' : 'Drop your alignment here'}</span>
		<span class="dropzone__hint">FASTA, NEXUS or PHYLIP, optionally gzipped. Add a Newick tree if you have one; otherwise one is built here. Or <u>choose files</u>.</span>
	</label>

	<details class="paste">
		<summary>Or paste sequences</summary>
		<textarea bind:value={pasted} rows="6" spellcheck="false" placeholder={'>hg38\nATGGCC...\n>panTro4\nATGGCC...'}></textarea>
		<button class="button" type="button" onclick={startPasted} disabled={!pasted.trim() || busy}>Analyze</button>
	</details>

	{#if error}
		<p class="error notice--error" role="alert"><strong>Not accepted.</strong> {error}</p>
	{/if}

	<p class="examples">
		<span class="examples__label">Or try an example:</span>
		{#each EXAMPLES as example (example.id)}
			<a class="chip" href={reportHref(example)} title={example.description}>{example.name}</a>
		{/each}
	</p>
</section>

<style>
	.hero {
		margin-bottom: var(--space-8);
	}
	h1 {
		margin-bottom: var(--space-2);
	}
	.lede {
		font-size: var(--text-base);
		color: var(--text-muted);
		margin-bottom: var(--space-6);
	}

	.dropzone {
		position: relative;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		text-align: left;
		padding: var(--space-6) var(--space-5);
		border: 1px dashed var(--rule);
		cursor: pointer;
	}
	.dropzone:hover,
	.dropzone--active {
		border-color: var(--text);
	}
	.dropzone--busy {
		opacity: 0.45;
		cursor: progress;
	}
	.dropzone input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.dropzone__title {
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: var(--leading-tight);
	}
	.dropzone__hint {
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.dropzone__hint u {
		color: var(--text);
		text-underline-offset: 0.16em;
	}

	.paste {
		margin-top: var(--space-4);
	}
	.paste textarea {
		display: block;
		width: 100%;
		margin: var(--space-3) 0;
		resize: vertical;
	}

	.error {
		margin-top: var(--space-4);
		font-size: var(--text-md);
	}

	.examples {
		margin-top: var(--space-6);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.examples__label {
		margin-right: var(--space-1);
	}
	.chip {
		white-space: nowrap;
	}
	.chip + .chip::before {
		content: '·';
		color: var(--text-faint);
		margin: 0 var(--space-2);
		text-decoration: none;
		display: inline-block;
	}
</style>
