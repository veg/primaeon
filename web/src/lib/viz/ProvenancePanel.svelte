<!--
	ProvenancePanel.svelte — what produced these numbers, and how to get them again.

	WHY THIS FILE EXISTS. PLAN.md §4.5, "Every page": the provenance block of §3.5 (surface,
	versions, variant, artifact hash, seed, preprocessing, warnings), the surrogate badge, the
	Datamonkey deep link for a real MEME run, the MCP reproduction snippet (§3.6) and the
	downloads. Everything shown is read from `record.provenance`; nothing is inferred, so a field
	the surface did not record prints as "not recorded" rather than a default.
-->
<script lang="ts">
	import type { MemeRecord } from '$lib/results/types';
	import { MCP_ADD_LINE, mcpSnippet } from '$lib/results/mcpSnippet';
	import { downloadText, fileStem, resultCsvText, resultJsonText } from '$lib/results/downloads';

	interface Props {
		record: MemeRecord;
	}
	let { record }: Props = $props();

	const p = $derived(record.provenance);
	const pre = $derived(p.preprocessing);
	const snippet = $derived(mcpSnippet(record));
	let busy = $state<string | null>(null);
	let downloadError = $state<string | null>(null);
	let copied = $state(false);

	const DATAMONKEY_MEME = 'https://www.datamonkey.org/meme';

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
</script>

<div class="prov">
	<div class="prov__head">
		<span class="surrogate" title="These are the model's predictions of what MEME would report; MEME was not run.">
			Surrogate for {p.surrogate_for ?? 'MEME'}
		</span>
		<a class="button button--accent" href={DATAMONKEY_MEME} target="_blank" rel="noopener">
			Run full MEME on Datamonkey
		</a>
	</div>

	<div class="grid">
		<section>
			<h3>Run</h3>
			<dl>
				<div><dt>Surface</dt><dd>{p.surface}</dd></div>
				<div><dt>Model variant</dt><dd>{notRecorded(p.model_variant)}{p.model_version ? ` (${p.model_version})` : ''}</dd></div>
				<div>
					<dt>Graph sha256</dt>
					<dd class="mono hash">
						{notRecorded(p.artifact_sha256)}
						{#if p.artifact_sha256}<span class="tag" class:tag--ok={p.artifact_verified !== false}>{p.artifact_verified === false ? 'unverified' : 'verified'}</span>{/if}
					</dd>
				</div>
				<div><dt>hyphaeon-js</dt><dd>{notRecorded(p.hyphaeon_js_version)}</dd></div>
				<div><dt>Reference version</dt><dd>{notRecorded(p.reference_version)}</dd></div>
				{#each Object.entries(p.versions ?? {}) as [k, v] (k)}
					<div><dt>{k}</dt><dd>{notRecorded(v)}</dd></div>
				{/each}
				<div><dt>Seed</dt><dd>{p.seed == null ? 'none (site selection draws no random numbers)' : p.seed}</dd></div>
				<div><dt>Elapsed</dt><dd>{p.elapsed_sec == null ? 'not recorded' : `${p.elapsed_sec.toFixed(2)} s`}</dd></div>
				<div><dt>Schema</dt><dd>{p.schema_version}</dd></div>
				{#if record.created_at}<div><dt>Run at</dt><dd>{new Date(record.created_at).toLocaleString()}</dd></div>{/if}
			</dl>
		</section>

		<section>
			<h3>Preprocessing</h3>
			<dl>
				<div><dt>Taxa</dt><dd>{pre.taxa_used} used of {pre.taxa_in_alignment}{pre.taxon_cap ? ` (cap ${pre.taxon_cap})` : ''}</dd></div>
				<div><dt>Reference sequence</dt><dd class="mono">{notRecorded(pre.reference_sequence)}</dd></div>
				<div><dt>Tree source</dt><dd>{pre.tree_source}{pre.branch_lengths_estimated ? ', branch lengths estimated' : ''}</dd></div>
				<div><dt>Duplicates collapsed</dt><dd>{pre.duplicates_collapsed}</dd></div>
				<div><dt>PD subsampled</dt><dd>{yesNo(pre.pd_subsampled)}</dd></div>
				<div><dt>Distances rescaled (&gt; 10)</dt><dd>{yesNo(pre.distance_rescaled)}</dd></div>
				{#if pre.distances_clamped != null}<div><dt>Distances clamped</dt><dd>{pre.distances_clamped}</dd></div>{/if}
				<div><dt>Codons trimmed</dt><dd>{pre.codons_trimmed}</dd></div>
				<div><dt>Unknown codons</dt><dd>{(pre.unknown_codon_fraction * 100).toFixed(2)}%</dd></div>
				<div><dt>In-frame stops</dt><dd>{notRecorded(pre.in_frame_stops)}</dd></div>
				{#if pre.dropped_taxa?.length}
					<div><dt>Dropped taxa</dt><dd class="mono small">{pre.dropped_taxa.join(', ')}</dd></div>
				{/if}
				{#each notices as [k, v] (k)}
					<div><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>
				{/each}
			</dl>
			{#if Object.keys(p.options ?? {}).length}
				<details>
					<summary>Options as submitted</summary>
					<pre class="small">{JSON.stringify(p.options, null, 2)}</pre>
				</details>
			{/if}
		</section>
	</div>

	{#if p.warnings?.length}
		<section>
			<h3>Warnings</h3>
			<ul class="warnings">
				{#each p.warnings as w, i (w.code + i)}
					<li class="warning warning--{w.severity}">
						<code>{w.code}</code>
						<span>{w.message}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section>
		<h3>Downloads</h3>
		<div class="actions">
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
		</div>
		{#if downloadError}<p class="error">{downloadError}</p>{/if}
		<p class="hint">
			The JSON and CSV are written by the same writers as <code>hyphaeon meme</code>, so they feed
			<code>hyphaeon evaluate</code> and the parity harness unchanged.
		</p>
	</section>

	<section>
		<h3>Reproduce with MCP</h3>
		<p class="hint">
			Add the server once with <code>{MCP_ADD_LINE}</code>, then ask for this call. The paths are
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
	.prov__head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.surrogate {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--warn);
		background: var(--warn-soft);
		color: var(--warn);
		border-radius: 999px;
		padding: 0.25rem 0.8rem;
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: var(--space-5);
	}
	h3 {
		font-family: var(--font-text);
		font-weight: 600;
		font-size: var(--text-sm);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: var(--space-2);
	}
	dl {
		margin: 0;
		display: grid;
		gap: 0.25rem;
		font-size: var(--text-sm);
	}
	dl div {
		display: grid;
		grid-template-columns: 11rem 1fr;
		gap: var(--space-2);
		align-items: baseline;
	}
	dt {
		color: var(--text-faint);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.hash {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		flex-wrap: wrap;
	}
	.tag {
		border-radius: 999px;
		padding: 0 0.5rem;
		background: var(--warn-soft);
		color: var(--warn);
		font-family: var(--font-text);
		font-weight: 600;
	}
	.tag--ok {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.small {
		font-size: var(--text-xs);
	}
	details {
		margin-top: var(--space-2);
		font-size: var(--text-sm);
	}
	summary {
		cursor: pointer;
		color: var(--link);
	}
	.warnings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.warning {
		display: flex;
		gap: var(--space-3);
		align-items: baseline;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--bg-subtle);
		font-size: var(--text-sm);
	}
	.warning--warn {
		background: var(--warn-soft);
	}
	.warning--error {
		background: var(--danger-soft);
	}
	.warning code {
		white-space: nowrap;
		font-size: var(--text-xs);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.hint {
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
	}
	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.snippet {
		position: relative;
	}
	.snippet pre {
		margin: 0;
		font-size: var(--text-xs);
	}
	.copy {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		padding: 0.25rem 0.6rem;
	}
</style>
