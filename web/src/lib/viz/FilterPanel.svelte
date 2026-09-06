<!--
	FilterPanel.svelte — the artefact patches `--filter` masked, with an alignment snippet.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "masks ... when requested". A masked patch is a span of
	codons in one outlier taxon that the OCI screen (filter.py / cli.py cmd_meme --filter, see
	js/src/filter.js's header for the two variants) replaced with NNN before re-scoring. The
	reader needs to see what was masked to judge the call, so each patch lists its span, taxon,
	consecutive mismatches and OCI, and — when the record carries the sequences — the outlier's
	amino acids against the consensus over the span, before (observed) and after (NNN) masking.
	`outlier_aa_sequence` / `consensus_aa_sequence` are used when the richer record has them.

	Set as prose and a `dl` of before/after numbers (DESIGN.md §3): no boxes, the snippet in mono
	on `--surface-2`, the masked residues in the faint grey because a blanked codon is an absence,
	not a signal.
-->
<script lang="ts">
	import type { FilterBlock, MaskedPatch, MemeRecord } from '$lib/results/types';
	import { translateCodon } from '$lib/results/entropy';

	interface Props {
		record: MemeRecord;
		filter: FilterBlock;
	}
	let { record, filter }: Props = $props();

	function sequenceOf(taxon: string): string | null {
		const a = filter.raw_alignment ?? record.alignment;
		if (!a) return null;
		const i = a.names.indexOf(taxon);
		return i >= 0 ? a.sequences[i] : null;
	}

	/** Amino acids of `taxon` over the 1-indexed codon span [start, end]. */
	function aaSpan(taxon: string, start: number, end: number): string | null {
		const seq = sequenceOf(taxon);
		if (!seq) return null;
		let out = '';
		for (let s = start; s <= end; s++) out += translateCodon(seq.slice((s - 1) * 3, s * 3));
		return out;
	}

	/** Column consensus amino acid over the span, majority of translatable codons. */
	function consensusSpan(start: number, end: number): string | null {
		const a = filter.raw_alignment ?? record.alignment;
		if (!a) return null;
		let out = '';
		for (let s = start; s <= end; s++) {
			const counts = new Map<string, number>();
			for (const seq of a.sequences) {
				const aa = translateCodon(seq.slice((s - 1) * 3, s * 3));
				if (aa !== '?') counts.set(aa, (counts.get(aa) ?? 0) + 1);
			}
			let best = '-';
			let n = 0;
			for (const [aa, c] of counts) if (c > n || (c === n && aa < best)) (best = aa), (n = c);
			out += best;
		}
		return out;
	}

	function snippet(p: MaskedPatch) {
		const observed = p.outlier_aa_sequence ?? aaSpan(p.outlier_taxon, p.start, p.end);
		const consensus = p.consensus_aa_sequence ?? consensusSpan(p.start, p.end);
		const masked = observed ? 'X'.repeat(observed.length) : null;
		return { observed, consensus, masked };
	}

	const patches = $derived(filter.artifacts_masked ?? []);
	const fmt = (v: number | undefined, dp: number) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp));
</script>

<div class="filter">
	<p class="lede">
		The artefact filter was {filter.enabled ? 'on' : 'off'}.
		{#if patches.length === 0}
			No patch met the outlier-contamination rule, so no codon was masked and the scores above are
			the baseline scores.
		{:else}
			{patches.length} patch{patches.length === 1 ? ' was' : 'es were'} masked to NNN in the named taxon
			before the re-score whose numbers this page shows.
		{/if}
	</p>
	{#if filter.raw_metrics && filter.cleaned_metrics}
		<dl class="metrics" aria-label="Before and after masking">
			<div><dt>Sites at p ≤ 0.05</dt><dd>{filter.raw_metrics.sig_sites_p05} → {filter.cleaned_metrics.sig_sites_p05}</dd></div>
			<div><dt>Sites at q ≤ 0.10</dt><dd>{filter.raw_metrics.sig_sites_q10} → {filter.cleaned_metrics.sig_sites_q10}</dd></div>
			<div><dt>Mean LRT</dt><dd>{fmt(filter.raw_metrics.mean_lrt, 3)} → {fmt(filter.cleaned_metrics.mean_lrt, 3)}</dd></div>
			<div><dt>Cauchy combined p</dt><dd>{fmt(filter.raw_metrics.cct_p_value, 4)} → {fmt(filter.cleaned_metrics.cct_p_value, 4)}</dd></div>
		</dl>
		<p class="note">Before masking → after masking.</p>
	{/if}
	{#if patches.length}
		<ol class="patches">
			{#each patches as p (`${p.outlier_taxon}-${p.start}`)}
				{@const s = snippet(p)}
				<li class="patch">
					<p class="patch__head">
						<span>codons <span class="val">{p.start}–{p.end}</span> ({p.span})</span>
						<span>taxon <span class="val mono">{p.outlier_taxon}</span></span>
						<span><span class="val">{p.consecutive_mismatches}</span> consecutive mismatches</span>
						<span>OCI <span class="val">{fmt(p.oci, 3)}</span></span>
						{#if p.p_hypergeom != null}<span>p<sub>hyper</sub> <span class="val">{fmt(p.p_hypergeom, 4)}</span></span>{/if}
					</p>
					{#if s.observed && s.consensus}
						<pre class="snippet"><span class="lbl">consensus </span>{s.consensus}
<span class="lbl">before    </span>{s.observed}
<span class="lbl">after     </span><span class="masked">{s.masked}</span></pre>
					{:else}
						<p class="note">Sequences are not stored with this record, so the patch cannot be shown.</p>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	.filter {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.lede {
		margin: 0;
		font-size: var(--text-base);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.metrics {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: var(--space-3) var(--space-5);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.metrics div {
		display: flex;
		flex-direction: column;
	}
	.metrics dt {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.metrics dd {
		margin: 0;
		font-size: var(--text-base);
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.note {
		margin: calc(-1 * var(--space-2)) 0 0;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.patches {
		margin: 0;
		padding-left: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		color: var(--text-muted);
		font-size: var(--text-md);
	}
	.patch__head {
		margin: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.val {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.snippet {
		margin: var(--space-2) 0 0;
		padding: var(--space-2) var(--space-3);
		background: var(--surface-2);
		border: 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		line-height: 1.6;
		color: var(--text);
		overflow-x: auto;
	}
	.lbl {
		color: var(--text-faint);
	}
	.masked {
		color: var(--text-faint);
	}
	.patch .note {
		margin: var(--space-1) 0 0;
	}
</style>
