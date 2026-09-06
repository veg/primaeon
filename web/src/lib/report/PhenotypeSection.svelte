<!--
	PhenotypeSection.svelte — the phenotype pillar, live: describe a trait, run it, read the result.

	WHY THIS FILE EXISTS. PLAN.md §4.0 row 8 (D21): every other section of the report runs unasked,
	and this one cannot, because the trait belongs to the reader. Until Phase 3 this slot held an
	offer with a disabled form; the pillar is now ported (js/src/phenotype.js) and runs in the same
	worker, on the same graph, as the rest of the report, so the slot holds the analysis.

	FOUR WAYS TO DESCRIBE A TRAIT, WHICH ARE THE REFERENCE'S THREE. `resolve_phenotype_vector` takes
	a preset, an inline foreground, or a table (phenotype.py:121-274), and this panel adds no fourth
	source: picking tips on the tree BUILDS an inline foreground of exact names, which is what a
	reader would otherwise have typed. The tabs are ordered by how likely they are to be right for a
	dataset that just finished running — a preset that matches these taxa first, the tree next.

	PRESETS ARE FILTERED BY THIS DATASET. Only presets whose species actually match a taxon here are
	offered, with the match count, because a preset that matches nothing is not a choice. The
	matching is the library's own (lib/report/phenotype.svelte.ts `presetMatches`), quirks included.

	THE GLOB WARNING IS NOT PEDANTRY. The reference tries each inline pattern as a REGULAR EXPRESSION
	before it tries the glob (phenotype.py:249-256), so `pan*` is `pa` followed by zero or more `n`
	and it matches `papAnu`. A reader typing shell globs will silently select the wrong taxa, so the
	panel says so as soon as one is typed and shows the names the pattern actually matched.

	PERMULATIONS NEED A TREE WITH BRANCH LENGTHS, and a tree-free report has none — the tree beside
	it is a display-only tree (the uploaded topology with unit lengths, or NJ on the TN93 distances), and a Brownian-motion null
	drawn from that would test the distances against themselves. The control is disabled with that
	sentence rather than hidden, so the absence is legible.

	RESULTS ARE NOT PART OF THE ORCHESTRATOR'S RECORD until they exist: the section is written to
	IndexedDB when the report is one this browser owns, and kept for the visit when it is a gallery
	or server record the reader does not own.
-->
<script lang="ts">
	import type { PhenotypeRunOptions, ReportRecord, TraitKind, TraitSpec } from '$lib/api';
	import { PHENOTYPE_DEFAULTS } from '$lib/api';
	import { isFailedSection, isPhenotypeRecord, type PhenotypeSection } from './types';
	import {
		PERMULATIONS_UNAVAILABLE,
		looksLikeGlob,
		permulationsAvailable,
		persistPhenotype,
		phenotypeBlockedReason,
		phenotypeInputs,
		presetMatches,
		previewTrait,
		runReportPhenotype,
		type PresetMatch,
		type TraitPreview
	} from './phenotype.svelte';
	import { displayTree } from './displayTree';
	import { downloadText, phenotypeCsvText, phenotypeJsonText, reportStem } from './downloads';
	import PhenotypeGeneCard from '$lib/viz/PhenotypeGeneCard.svelte';
	import PhenotypePlot from '$lib/viz/PhenotypePlot.svelte';
	import SectorPanel from '$lib/viz/SectorPanel.svelte';
	import TreePicker from '$lib/viz/TreePicker.svelte';

	interface Props {
		record: ReportRecord;
		base: string;
		/** True when the record lives in this browser's IndexedDB, so a result can be stored with it. */
		owned: boolean;
		onSelect?: (site: number) => void;
	}
	let { record, base, owned, onSelect }: Props = $props();

	const MAX_THREADS = 16;
	const TOP_SITES = 25;

	const inputs = $derived(phenotypeInputs(record));
	const blocked = $derived(phenotypeBlockedReason(record));
	const taxa = $derived(inputs?.taxa ?? []);
	const tree = $derived(displayTree(record));
	const permsOk = $derived(permulationsAvailable(record));

	// ---- the trait -------------------------------------------------------------------------------
	let kind = $state<TraitKind | 'tree'>('preset');
	let preset = $state('');
	let foreground = $state('');
	let picked = $state<string[]>([]);
	let csvText = $state('');
	let csvName = $state('');
	let speciesCol = $state('');
	let traitCol = $state('');
	let continuous = $state(false);
	let csvColumns = $state<string[]>([]);
	let csvError = $state<string | null>(null);

	let presets = $state<PresetMatch[]>([]);
	let presetsLoaded = $state(false);
	$effect(() => {
		const names = taxa;
		if (names.length === 0) return;
		let live = true;
		void presetMatches(names).then((found) => {
			if (!live) return;
			presets = found;
			presetsLoaded = true;
			if (!preset && found.length) preset = found[0].key;
		});
		return () => {
			live = false;
		};
	});

	/** The panel's four tabs collapsed onto the library's three sources (see the header). */
	const trait = $derived.by((): TraitSpec => {
		switch (kind) {
			case 'preset':
				return { kind: 'preset', preset };
			case 'tree':
				return { kind: 'list', foreground: picked.join(',') };
			case 'list':
				return { kind: 'list', foreground, continuous: false };
			case 'csv':
				return {
					kind: 'csv',
					phenotypeCsv: csvText,
					phenotypeFile: csvName || 'phenotype.csv',
					speciesCol: speciesCol || null,
					traitCol: traitCol || null,
					continuous
				};
		}
	});

	const glob = $derived(kind === 'list' && looksLikeGlob(foreground));

	let preview = $state<TraitPreview | null>(null);
	let previewSeq = 0;
	$effect(() => {
		const names = taxa;
		const spec = trait;
		if (names.length === 0) {
			preview = null;
			return;
		}
		const seq = ++previewSeq;
		void previewTrait(names, spec).then((p) => {
			if (seq === previewSeq) preview = p;
		});
	});

	async function onCsv(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		csvError = null;
		try {
			csvText = await file.text();
			csvName = file.name;
			const sep = /\.(tsv|tab)$/i.test(file.name) ? '\t' : ',';
			const { parsePhenotypeTable } = await import('@veg/hyphaeon-js');
			csvColumns = parsePhenotypeTable(csvText, sep).columns;
			speciesCol = '';
			traitCol = '';
		} catch (err) {
			csvError = err instanceof Error ? err.message : String(err);
			csvColumns = [];
		}
	}

	// ---- options ---------------------------------------------------------------------------------
	let permulations = $state(PHENOTYPE_DEFAULTS.permulations);
	let alpha = $state(PHENOTYPE_DEFAULTS.alpha);
	let seed = $state(PHENOTYPE_DEFAULTS.seed);

	// ---- the run ---------------------------------------------------------------------------------
	let running = $state(false);
	let progress = $state<string | null>(null);
	let error = $state<string | null>(null);
	let controller: AbortController | null = null;
	let stored = $state<boolean | null>(null);

	const section = $derived.by((): PhenotypeSection | null => {
		const payload = record.sections.phenotype;
		return isPhenotypeRecord(payload) ? payload : null;
	});
	const failure = $derived(isFailedSection(record.sections.phenotype) ? record.sections.phenotype.error : null);
	const usedAlpha = $derived(section?.options?.alpha ?? alpha);

	async function run() {
		if (running || !preview?.ok) return;
		running = true;
		error = null;
		progress = 'Starting…';
		controller = new AbortController();
		const options: Partial<PhenotypeRunOptions> = { permulations: permsOk ? permulations : 0, alpha, seed };
		try {
			const hardwareConcurrency = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? null) : null;
			const result = await runReportPhenotype({
				record,
				trait,
				options,
				base,
				numThreads: Math.max(1, Math.min(MAX_THREADS, hardwareConcurrency ?? 1)),
				signal: controller.signal,
				onProgress: (message) => (progress = message)
			});
			record.sections.phenotype = result;
			if (!record.status.completed.includes('phenotype')) {
				record.status.completed = [...record.status.completed, 'phenotype'];
			}
			stored = owned ? await persistPhenotype(record, result) : false;
		} catch (err) {
			error = err instanceof Error && err.name === 'AbortError' ? 'Cancelled.' : err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
			progress = null;
			controller = null;
		}
	}

	function clear() {
		record.sections.phenotype = null;
		record.status.completed = record.status.completed.filter((n) => n !== 'phenotype');
		stored = null;
		if (owned) void persistPhenotype(record, null);
	}

	const stem = $derived(reportStem(record));
	const topSites = $derived(section ? section.sites.slice(0, TOP_SITES) : []);
	const fmt = (v: number | null | undefined, dp = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp));
	const fmtP = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '—' : p < 1e-4 ? p.toExponential(2) : p.toFixed(4));
</script>

{#if blocked}
	<p class="note note--warn">{blocked}</p>
{:else}
	<div class="pheno">
		<p class="lede">
			Mark the foreground taxa and each codon's attribution over taxa (the same forward pass that scored the
			sites) is compared with the trait vector: a directional association per codon, a Benjamini–Hochberg q, a
			PARS signature, trait sectors, and a gene-level verdict. This is <code>hyphaeon phenotype</code>, run here on demand.
		</p>

		<div class="tabs" role="tablist" aria-label="How to describe the trait">
			<button type="button" role="tab" aria-selected={kind === 'preset'} class:active={kind === 'preset'} onclick={() => (kind = 'preset')} disabled={presetsLoaded && presets.length === 0}>
				Preset{#if presetsLoaded && presets.length}{' '}<span class="pill">{presets.length}</span>{/if}
			</button>
			<button type="button" role="tab" aria-selected={kind === 'tree'} class:active={kind === 'tree'} onclick={() => (kind = 'tree')} disabled={!tree.newick}>Pick on the tree</button>
			<button type="button" role="tab" aria-selected={kind === 'list'} class:active={kind === 'list'} onclick={() => (kind = 'list')}>Paste a list</button>
			<button type="button" role="tab" aria-selected={kind === 'csv'} class:active={kind === 'csv'} onclick={() => (kind = 'csv')}>Trait table</button>
		</div>

		<div class="panel">
			{#if kind === 'preset'}
				{#if !presetsLoaded}
					<p class="hint">Matching the curated presets against this alignment's taxa…</p>
				{:else if presets.length === 0}
					<p class="hint">None of the eight curated presets matches a taxon in this alignment. Pick the foreground on the tree, paste a list, or upload a trait table.</p>
				{:else}
					<ul class="presets">
						{#each presets as p (p.key)}
							<li>
								<label class="preset" class:preset--on={preset === p.key}>
									<input type="radio" name="preset" value={p.key} bind:group={preset} />
									<span class="preset__body">
										<span class="preset__title">{p.title}<span class="count">{p.matched} of {taxa.length} taxa</span></span>
										<span class="preset__desc">{p.description}</span>
									</span>
								</label>
							</li>
						{/each}
					</ul>
					<p class="hint">
						The counts are the reference's own matching: each preset pattern is a glob against the lower-cased
						taxon name, and for a bare name also a substring test (phenotype.py:229-232).
					</p>
				{/if}
			{:else if kind === 'tree'}
				{#if tree.newick}
					{#if tree.source === 'user-topology'}
						<p class="hint tree-caption">
							<strong>This is your uploaded topology, drawn for display only</strong> — {tree.label.replace(/^Display only — /, '')}
						</p>
					{/if}
					<TreePicker newick={tree.newick} {taxa} selected={picked} treeSource={tree.source} onChange={(names) => (picked = names)} />
				{:else}
					<p class="hint">This report carries no tree to pick on.</p>
				{/if}
			{:else if kind === 'list'}
				<label class="field">
					<span>Foreground taxa or patterns</span>
					<textarea rows="3" bind:value={foreground} spellcheck="false" placeholder={taxa.slice(0, 3).join(',') || 'turTru,balMus,orcOrc'}></textarea>
					<small>Separated by commas, or by <code>|</code> when there is no comma. Names need not be exact: each is tried as a pattern.</small>
				</label>
				{#if glob}
					<p class="note note--warn">
						<strong>That looks like a shell glob, and the reference will read it as a regular expression.</strong>
						<code>resolve_phenotype_vector</code> runs <code>re.search</code> before it tries <code>fnmatch</code>
						(phenotype.py:249-256), so <code>pan*</code> is “<code>pa</code> then zero or more <code>n</code>” and matches
						<code>papAnu</code>. Check the matched taxa below before running; a prefix without the star matches by
						substring anyway.
					</p>
				{/if}
			{:else}
				<label class="field">
					<span>Trait table (CSV or TSV)</span>
					<input type="file" accept=".csv,.tsv,.tab,.txt" onchange={onCsv} />
					{#if csvName}<small>{csvName} · {csvColumns.length} column{csvColumns.length === 1 ? '' : 's'}</small>{/if}
				</label>
				{#if csvError}<p class="note note--warn">{csvError}</p>{/if}
				{#if csvColumns.length}
					<div class="cols">
						<label class="field">
							<span>Species column</span>
							<select bind:value={speciesCol}>
								<option value="">the reference's guess</option>
								{#each csvColumns as c (c)}<option value={c}>{c}</option>{/each}
							</select>
						</label>
						<label class="field">
							<span>Trait column</span>
							<select bind:value={traitCol}>
								<option value="">the first non-species column</option>
								{#each csvColumns as c (c)}<option value={c}>{c}</option>{/each}
							</select>
						</label>
						<label class="check"><input type="checkbox" bind:checked={continuous} /> Continuous trait (z-scored, no foreground split)</label>
					</div>
					<p class="hint">
						In discrete mode the reference compares <code>str(value)</code> against
						<code>1 / true / yes / case / foreground / target / positive</code>, so a column with one blank cell
						becomes floats, renders as <code>"1.0"</code>, matches nothing and puts every taxon in the background.
						The match count below is the check for that.
					</p>
				{/if}
			{/if}
		</div>

		{#if preview}
			<div class="preview" class:preview--ok={preview.ok} aria-live="polite">
				{#if preview.error}
					<p class="preview__line">Could not resolve the trait: {preview.error}</p>
				{:else if preview.ok}
					<p class="preview__line">
						<strong>{preview.mode === 'continuous' ? `${preview.foreground.length} taxa with a value` : `${preview.foregroundCount} foreground taxa`}</strong>
						of {taxa.length}. <span class="muted">{preview.description}</span>
					</p>
					<p class="preview__taxa mono">{preview.foreground.slice(0, 40).join(' · ')}{preview.foreground.length > 40 ? ` … +${preview.foreground.length - 40}` : ''}</p>
				{:else}
					<p class="preview__line">No taxon matched yet, so there is nothing to test.</p>
				{/if}
			</div>
		{/if}

		<div class="options">
			<label class="field field--narrow">
				<span>BH level α</span>
				<input type="number" min="0.001" max="0.5" step="0.005" bind:value={alpha} />
			</label>
			<label class="field field--narrow">
				<span>Seed</span>
				<input type="number" min="0" step="1" bind:value={seed} />
			</label>
			<label class="field field--narrow" class:disabled={!permsOk}>
				<span>Permulations B</span>
				<input type="number" min="0" max="10000" step="100" bind:value={permulations} disabled={!permsOk} />
			</label>
			<p class="hint hint--perm">
				{#if permsOk}
					Brownian-motion permulations on the tree give the gene a second, empirical p; they cost two L × B matrices,
					so start at a few hundred in a browser. B = 0 skips them and the length-adjusted extreme-value p stands alone.
				{:else}
					{PERMULATIONS_UNAVAILABLE}
				{/if}
			</p>
		</div>

		<div class="run">
			<button type="button" class="button" onclick={run} disabled={running || !preview?.ok}>
				{running ? (progress ?? 'Running…') : section ? 'Run again' : 'Run phenotype association'}
			</button>
			{#if running}
				<button type="button" class="button button--secondary" onclick={() => controller?.abort()}>Cancel</button>
			{/if}
			{#if section && !running}
				<button type="button" class="linkbutton" onclick={clear}>Clear the result</button>
			{/if}
			<span class="hint">
				Runs in this browser on the model already loaded for this report; seconds for a gene of this size.
			</span>
		</div>

		{#if error}<p class="note note--danger" role="alert"><strong>{error === 'Cancelled.' ? 'Cancelled.' : 'The run failed.'}</strong> {error === 'Cancelled.' ? 'Nothing was stored; run it again when ready.' : error}</p>{/if}
		{#if failure && !section}<p class="note note--danger"><strong>The phenotype run failed.</strong> {failure}</p>{/if}

		{#if section}
			<hr />
			<div class="result">
				<p class="lede">
					<strong>{section.phenotype_meta.description || 'Trait'}</strong> ·
					{section.phenotype_meta.mode === 'continuous'
						? 'continuous trait'
						: `${section.phenotype_meta.foreground_count} foreground / ${section.phenotype_meta.background_count} background taxa`}
					· {section.sites.length.toLocaleString()} codons scored of {section.codon_count.toLocaleString()}
					{#if section.elapsed_sec}· {section.elapsed_sec.toFixed(1)} s{/if}
					{#if stored === false}<span class="muted"> · not stored: this report is not one this browser owns</span>{/if}
				</p>

				<PhenotypeGeneCard record={section} permulationsNote={permsOk ? null : PERMULATIONS_UNAVAILABLE} />

				<h3>Association along the gene</h3>
				<PhenotypePlot sites={section.sites} alpha={usedAlpha} codonCount={section.codon_count} />

				<h3>PARS signature</h3>
				<p class="pars mono">{section.compact_pars_signature}</p>
				<p class="hint">
					The phenotype-associated residue signature: the first fifteen sites in score order that also reach
					ρ ≥ 0.40 and score ≥ 0.50, written as reference-residue, codon, derived residue. An empty
					<code>[]</code> means no site cleared that bracket — which is a statement about the bracket, not about
					the calls in the table below.
				</p>

				<h3>Top sites</h3>
				<div class="tablewrap">
					<table>
						<caption><b></b>Trait-associated codons, the first {Math.min(TOP_SITES, section.sites.length)} of {section.sites.length.toLocaleString()} in the reference's own order (by score, descending). ρ is the directional association, q its Benjamini–Hochberg adjustment; a purple square marks a codon at q ≤ {usedAlpha} with ρ &gt; 0. Foreground and background are the residue's frequency in each group. Click a codon to open its tree.</caption>
						<thead>
							<tr>
								<th>Codon</th><th>Change</th><th class="num">ρ</th><th class="num">Score</th><th class="num">LRT</th><th class="num">p</th><th class="num">q</th><th class="num">Foreground</th><th class="num">Background</th>
							</tr>
						</thead>
						<tbody>
							{#each topSites as row (row.site)}
								{@const called = (row.q_value ?? 1) <= usedAlpha && row.association_rho > 0}
								<tr class:called>
									<td class="call" class:call--on={called}><button type="button" class="linkbutton" onclick={() => onSelect?.(row.site)}>{row.site}</button></td>
									<td class="mono">{row.ref_aa}→{row.derived_aa}</td>
									<td class="num">{fmt(row.association_rho)}</td>
									<td class="num">{fmt(row.score)}</td>
									<td class="num">{fmt(row.hyphaeon_lrt, 2)}</td>
									<td class="num">{fmtP(row.p_value)}</td>
									<td class="num">{fmtP(row.q_value)}</td>
									<td class="num">{row.foreground_freq_pct.toFixed(0)} %</td>
									<td class="num">{row.background_freq_pct.toFixed(0)} %</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="table__foot">
					Only codons the pillar could score appear (a non-empty attribution row and at least
					{section.options?.minTaxa ?? PHENOTYPE_DEFAULTS.minTaxaPerSite} sequenced taxa). Showing {Math.min(TOP_SITES, section.sites.length)} of {section.sites.length.toLocaleString()}; the CSV below has them all.
				</p>

				<h3>Trait sectors</h3>
				{#if section.trait_sectors.length}
					<p class="hint">
						The sector miner run on the called sites only, with looser gates than the epistasis pillar's
						(clique ≥ 2, coherence ≥ 0.45): groups of trait-associated codons whose attribution rows share one
						axis. {section.coselection_pairs_count.toLocaleString()} co-selection pair{section.coselection_pairs_count === 1 ? '' : 's'} fed it.
					</p>
					<SectorPanel
						sectors={section.trait_sectors}
						permutations={section.sector_permutations?.n ?? section.options?.nPermutations ?? null}
						seed={section.sector_permutations?.seed ?? section.options?.seed ?? null}
						{onSelect}
					/>
				{:else}
					<p class="hint">
						No trait sector: {section.significant_sites_count} called site{section.significant_sites_count === 1 ? '' : 's'} and
						{section.coselection_pairs_count} co-selection pair{section.coselection_pairs_count === 1 ? '' : 's'} produced no
						community of two or more codons reaching coherence 0.45.
					</p>
				{/if}

				<div class="downloads">
					<button type="button" class="button button--secondary" onclick={() => downloadText(`${stem}_hyphaeon_phenotype.json`, phenotypeJsonText(section), 'application/json')}>
						Phenotype (JSON)
					</button>
					<button type="button" class="button button--secondary" onclick={() => downloadText(`${stem}_hyphaeon_phenotype.csv`, phenotypeCsvText(section), 'text/csv;charset=utf-8')}>
						Sites (CSV)
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.pheno {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.lede,
	.hint,
	.note {
		margin: 0;
	}
	.tabs {
		display: flex;
		gap: var(--space-5);
		border-bottom: 1px solid var(--hair);
		flex-wrap: wrap;
	}
	.tabs button {
		border: 0;
		background: transparent;
		padding: 0 0 var(--space-2);
		margin-bottom: -1px;
		font-size: var(--text-md);
		color: var(--text-muted);
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	.tabs button.active {
		color: var(--text);
		border-bottom-color: var(--text);
	}
	.tabs button:disabled {
		color: var(--text-faint);
		cursor: default;
	}
	.pill {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.presets {
		list-style: none;
		margin: 0;
		padding: 0;
		max-width: var(--measure);
	}
	.presets li + li {
		border-top: 1px solid var(--hair);
	}
	.preset {
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		padding: var(--space-2) 0;
		cursor: pointer;
		font-size: var(--text-md);
	}
	.preset input {
		margin-top: 0.25rem;
	}
	.preset__body {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.preset__title {
		color: var(--text);
	}
	.preset--on .preset__title {
		font-weight: 700;
	}
	.count {
		display: block;
		font-weight: 400;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.preset__desc {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.field {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-md);
	}
	.field > span {
		color: var(--text);
	}
	.field small {
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
	.field--narrow {
		max-width: 8rem;
	}
	.field.disabled > span {
		color: var(--text-faint);
	}
	textarea,
	select,
	input[type='number'] {
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	.cols {
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.check {
		display: inline-flex;
		gap: var(--space-2);
		align-items: center;
		font-size: var(--text-md);
		cursor: pointer;
	}
	.preview {
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.preview__line {
		margin: 0;
	}
	.preview__line strong {
		color: var(--text);
	}
	.preview__taxa {
		margin: 0.2rem 0 0;
		font-size: var(--text-sm);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--text-faint);
	}
	.options {
		display: flex;
		gap: var(--space-5);
		flex-wrap: wrap;
		align-items: flex-start;
	}
	.hint--perm {
		flex: 1 1 20rem;
	}
	.run {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		flex-wrap: wrap;
	}
	.run .hint {
		flex: 1 1 14rem;
	}
	.linkbutton {
		all: unset;
		cursor: pointer;
		color: var(--brand);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
		font-size: inherit;
	}
	.linkbutton:hover {
		text-decoration-thickness: 2px;
	}
	.linkbutton:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	hr {
		margin: var(--space-4) 0 0;
	}
	.result {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.result .lede {
		color: var(--text-muted);
		font-size: var(--text-md);
		max-width: none;
	}
	.result .lede strong {
		color: var(--text);
	}
	h3 {
		margin: var(--space-2) 0 0;
	}
	.pars {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.tablewrap {
		overflow-x: auto;
	}
	th,
	td {
		white-space: nowrap;
	}
	.call--on::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--brand);
		margin-right: 0.45em;
		vertical-align: 0.05em;
	}
	.table__foot {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.downloads {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
</style>
