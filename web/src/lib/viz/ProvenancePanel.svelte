<!--
	ProvenancePanel.svelte — what produced these numbers, and how to get them again.

	WHY THIS FILE EXISTS. PLAN.md §4.5, "Every page": the provenance block of §3.5 (surface,
	versions, variant, artifact hash, seed, preprocessing, warnings), the surrogate statement, the
	Datamonkey deep link for a real MEME run, the MCP reproduction snippet (§3.6) and the
	downloads. Everything shown is read from `record.provenance`; nothing is inferred, so a field
	the surface did not record prints as "not recorded" rather than a default.

	PHASE 2. The report page (lib/report/ProvenanceSection.svelte) reuses this panel for the whole
	report and passes `extraDownloads` (the report's JSON / CSV / GraphML / Newick, which replace
	the per-analysis buttons) and `snippet` (the `hyphaeon_analyze` call, which replaces the
	`hyphaeon_meme` one). Without those props the panel behaves as in Phase 1.

	SET AS A FACT LIST (web/DESIGN.md §3): one two-column `dl.facts` per group with muted labels,
	hashes in monospace, no cards, no badges. The surrogate statement is a sentence with the
	Datamonkey link in it, not an orange button; a warning row carries the orange square and a
	refusal is black.
-->
<script lang="ts" module>
	export interface ExtraDownload {
		label: string;
		title?: string;
		disabled?: boolean;
		run: () => Promise<void>;
	}
</script>
<script lang="ts">
	import { treeFreeLabel, treeSourceLabel } from '$lib/api';
	import type { MemeRecord } from '$lib/results/types';
	import { MCP_ADD_LINE, mcpSnippet } from '$lib/results/mcpSnippet';
	import { downloadText, fileStem, resultCsvText, resultJsonText } from '$lib/results/downloads';

	interface Props {
		record: MemeRecord;
		/** Report-level downloads; when given they replace the JSON/CSV/tree buttons below. */
		extraDownloads?: ExtraDownload[] | null;
		/** A snippet to show instead of the `hyphaeon_meme` one. */
		snippet?: string | null;
		snippetTool?: string;
	}
	let { record, extraDownloads = null, snippet: snippetOverride = null, snippetTool = 'hyphaeon_meme' }: Props = $props();

	const p = $derived(record.provenance);
	/** The engine writes a comma-joined list for a whole report; print it with spaces, as prose. */
	const surrogateFor = $derived.by(() => {
		const raw = p.surrogate_for as unknown;
		const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? 'MEME').split(',');
		return parts.map((s) => s.trim()).filter(Boolean).join(', ');
	});
	const surrogateMany = $derived(surrogateFor.includes(','));
	const pre = $derived(p.preprocessing);
	const snippet = $derived(snippetOverride ?? mcpSnippet(record));
	let busy = $state<string | null>(null);
	let downloadError = $state<string | null>(null);
	let copied = $state(false);

	const DATAMONKEY_MEME = 'https://www.datamonkey.org/meme';

	async function runExtra(d: ExtraDownload, i: number) {
		downloadError = null;
		busy = `extra-${i}`;
		try {
			await d.run();
		} catch (e) {
			downloadError = `Download failed: ${(e as Error).message}`;
		} finally {
			busy = null;
		}
	}

	async function download(kind: 'json' | 'csv' | 'tree') {
		downloadError = null;
		busy = kind;
		try {
			const stem = fileStem(record);
			if (kind === 'json') downloadText(`${stem}_hyphaeon_meme.json`, await resultJsonText(record), 'application/json');
			else if (kind === 'csv') downloadText(`${stem}_hyphaeon_meme.csv`, await resultCsvText(record), 'text/csv;charset=utf-8');
			else if (record.tree) downloadText(`${stem}_tree.nwk`, record.tree.trim() + '\n');
		} catch (e) {
			downloadError = `Download failed: ${(e as Error).message}`;
		} finally {
			busy = null;
		}
	}

	async function copySnippet() {
		try {
			await navigator.clipboard.writeText(snippet);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	const notRecorded = (v: unknown) => (v == null || v === '' ? 'not recorded' : String(v));
	const yesNo = (v: unknown) => (v == null ? 'not recorded' : v ? 'yes' : 'no');
	const notices = $derived(
		Object.entries(p.notices ?? {}).filter(([, v]) => v !== false && v != null && !(Array.isArray(v) && v.length === 0))
	);
	const stamp = (iso: string) => {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		const z = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
	};
</script>

<div class="prov">
	<p class="surrogate">
		Surrogate for {surrogateFor}: these numbers are the model's predictions of what {surrogateMany ? 'those analyses' : surrogateFor} would
		report; {surrogateMany ? 'none of them' : 'it'} was run. A real MEME run on the same alignment:
		<a href={DATAMONKEY_MEME} target="_blank" rel="noopener">open in Datamonkey</a>.
	</p>

	<div class="grid">
		<section>
			<h3>Run</h3>
			<dl class="facts">
				<dt>Surface</dt><dd>{p.surface}</dd>
				<dt>Model variant</dt><dd>{notRecorded(p.model_variant)}{p.model_version ? ` (${p.model_version})` : ''}</dd>
				<dt>Graph sha256</dt>
				<dd class="mono">{notRecorded(p.artifact_sha256)}{#if p.artifact_sha256}<span class="tag" class:tag--warn={p.artifact_verified === false}>, {p.artifact_verified === false ? 'unverified' : 'verified'}</span>{/if}</dd>
				<dt>hyphaeon-js</dt><dd>{notRecorded(p.hyphaeon_js_version)}</dd>
				<dt>Reference version</dt><dd>{notRecorded(p.reference_version)}</dd>
				{#each Object.entries(p.versions ?? {}) as [k, v] (k)}
					<dt>{k}</dt><dd>{notRecorded(v)}</dd>
				{/each}
				<dt>Seed</dt><dd>{p.seed == null ? 'none (site selection draws no random numbers)' : p.seed}</dd>
				<dt>Elapsed</dt><dd>{p.elapsed_sec == null ? 'not recorded' : `${p.elapsed_sec.toFixed(2)} s`}</dd>
				<dt>Schema</dt><dd>{p.schema_version}</dd>
				{#if record.created_at}<dt>Run at</dt><dd>{stamp(record.created_at)}</dd>{/if}
			</dl>
		</section>

		<section>
			<h3>Preprocessing</h3>
			<dl class="facts">
				<dt>Taxa</dt><dd>{pre.taxa_used} used of {pre.taxa_in_alignment}{pre.taxon_cap ? ` (cap ${pre.taxon_cap})` : ''}</dd>
				<dt>Reference sequence</dt><dd class="mono">{notRecorded(pre.reference_sequence)}</dd>
				<dt>Distances</dt>
				<dd>
					{pre.tree_source === 'tn93' ? treeFreeLabel((pre.tree_free as { reason?: string } | null | undefined)?.reason) : treeSourceLabel(pre.tree_source)}
					{#if typeof pre.tn93_saturated_pairs === 'number' && pre.tn93_saturated_pairs > 0}
						· {(pre.tn93_saturated_pairs as number).toLocaleString()} pair{pre.tn93_saturated_pairs === 1 ? '' : 's'} at the saturation sentinel
					{/if}
				</dd>
				{#if pre.display_tree_source}
					<dt>Tree drawn</dt><dd>{pre.display_tree_source === 'nj' ? 'neighbour-joining on the TN93 distances (display only)' : pre.display_tree_source === 'user-topology' ? 'your topology with unit branch lengths (display only; the model used TN93 distances)' : 'the tree the model was given'}</dd>
				{/if}
				<dt>Duplicates collapsed</dt><dd>{pre.duplicates_collapsed}</dd>
				<dt>PD subsampled</dt><dd>{yesNo(pre.pd_subsampled)}</dd>
				<dt>Distances rescaled (&gt; 10)</dt><dd>{yesNo(pre.distance_rescaled)}</dd>
				{#if pre.distances_clamped != null}<dt>Distances clamped</dt><dd>{pre.distances_clamped}</dd>{/if}
				<dt>Codons trimmed</dt><dd>{pre.codons_trimmed}</dd>
				<dt>Unknown codons</dt><dd>{(pre.unknown_codon_fraction * 100).toFixed(2)} %</dd>
				<dt>In-frame stops</dt><dd>{notRecorded(pre.in_frame_stops)}</dd>
				{#if pre.dropped_taxa?.length}
					<dt>Dropped taxa</dt><dd class="mono">{pre.dropped_taxa.join(', ')}</dd>
				{/if}
				{#each notices as [k, v] (k)}
					<dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
				{/each}
			</dl>
			{#if Object.keys(p.options ?? {}).length}
				<details>
					<summary>Options as submitted</summary>
					<pre>{JSON.stringify(p.options, null, 2)}</pre>
				</details>
			{/if}
		</section>
	</div>

	{#if p.warnings?.length}
		<section>
			<h3>Warnings</h3>
			<table class="warnings">
				<thead><tr><th>Severity</th><th>Code</th><th>Message</th></tr></thead>
				<tbody>
					{#each p.warnings as w, i (w.code + i)}
						<tr>
							<td><span class="sev" class:sev--warn={w.severity === 'warn'} class:sev--refuse={w.severity === 'error' || w.severity === 'refuse'}>{w.severity === 'error' || w.severity === 'refuse' ? 'refused' : w.severity === 'warn' ? 'warning' : 'note'}</span></td>
							<td class="mono">{w.code}</td>
							<td>{w.message}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}

	<section>
		<h3>Downloads</h3>
		<div class="downloads">
			{#if extraDownloads}
				{#each extraDownloads as d, i (d.label)}
					<button type="button" class="button button--secondary" disabled={busy !== null || d.disabled} title={d.title} onclick={() => runExtra(d, i)}>
						{busy === `extra-${i}` ? '…' : d.label}
					</button>
				{/each}
			{:else}
				<button type="button" class="button button--secondary" disabled={busy !== null} onclick={() => download('json')}>
					JSON ({busy === 'json' ? '…' : 'hyphaeon meme format'})
				</button>
				<button type="button" class="button button--secondary" disabled={busy !== null} onclick={() => download('csv')}>
					CSV ({busy === 'csv' ? '…' : 'site table'})
				</button>
				<button type="button" class="button button--secondary" disabled={busy !== null || !record.tree} onclick={() => download('tree')}
					title={record.tree ? 'The Newick tree the model was given' : 'This record has no tree'}>
					Tree (Newick)
				</button>
			{/if}
		</div>
		{#if downloadError}<p class="note note--danger"><strong>Download failed.</strong> {downloadError.replace(/^Download failed: /, '')}</p>{/if}
		<p class="hint">
			The site JSON and CSV are written by the same writers as <code>hyphaeon meme</code>, so they feed
			<code>hyphaeon evaluate</code> and the parity harness unchanged{#if extraDownloads}; the GraphML is <code>nx.write_graphml</code>'s layout over the co-selection edges{/if}.
		</p>
	</section>

	<section>
		<h3>Reproduce with MCP</h3>
		<p class="hint">
			Add the server once with <code>{MCP_ADD_LINE}</code>, then ask for this <code>{snippetTool}</code> call. The paths are
			placeholders: the stdio server reads local files, and this page never had a path to your file.
		</p>
		<div class="snippet">
			<pre><code>{snippet}</code></pre>
			<button type="button" class="button button--secondary copy" onclick={copySnippet}>{copied ? 'Copied' : 'Copy'}</button>
		</div>
	</section>
</div>

<style>
	.prov {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.surrogate {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: var(--space-5) var(--space-6);
	}
	h3 {
		margin: 0 0 var(--space-2);
	}
	.facts {
		margin: 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: var(--space-5);
		row-gap: 0.3rem;
		font-size: var(--text-md);
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.tag {
		font-family: var(--font-text);
		font-size: var(--text-md);
	}
	.tag--warn {
		color: var(--warn);
		font-weight: 700;
	}
	.tag--warn::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--warn-mark);
		margin: 0 0.5em 0 0.25em;
		vertical-align: 0.05em;
	}
	details {
		margin-top: var(--space-3);
		font-size: var(--text-md);
	}
	details pre {
		margin-top: var(--space-2);
	}
	.warnings th:first-child,
	.warnings td:first-child {
		width: 6rem;
	}
	.warnings td:nth-child(2) {
		white-space: nowrap;
	}
	.sev {
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
	.sev--refuse {
		color: var(--text);
		font-weight: 700;
	}
	.downloads {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.hint {
		margin: var(--space-3) 0 0;
	}
	.note {
		margin: var(--space-3) 0 0;
	}
	.snippet {
		position: relative;
	}
	.snippet pre {
		margin: 0;
		padding-right: 5rem;
	}
	.copy {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		padding: 0.15rem 0.6rem;
	}
</style>
