<!--
	FilterPanel.svelte — the artefact patches `--filter` masked, with an alignment snippet.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "masks ... when requested". A masked patch is a span of
	codons in one outlier taxon that the OCI screen (filter.py / cli.py cmd_meme --filter, see
	js/src/filter.js's header for the two variants) replaced with NNN before re-scoring. The
	reader needs to see what was masked to judge the call, so each patch lists its span, taxon,
	consecutive mismatches and OCI, and — when the record carries the sequences — the outlier's
	amino acids against the consensus over the span, before (observed) and after (NNN) masking.
	`outlier_aa_sequence` / `consensus_aa_sequence` are used when the richer record has them.
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
		Artefact filter <strong>{filter.enabled ? 'on' : 'off'}</strong>:
		{#if patches.length === 0}
			no patch met the outlier-contamination rule, so no codon was masked and the scores above are
			the baseline scores.
		{:else}
			{patches.length} patch{patches.length === 1 ? '' : 'es'} masked to NNN in the named taxon
			before the re-score whose numbers this page shows.
		{/if}
	</p>
	{#if filter.raw_metrics && filter.cleaned_metrics}
		<dl class="metrics">
			<div><dt>Sites at p ≤ 0.05</dt><dd>{filter.raw_metrics.sig_sites_p05} → {filter.cleaned_metrics.sig_sites_p05}</dd></div>
			<div><dt>Sites at q ≤ 0.10</dt><dd>{filter.raw_metrics.sig_sites_q10} → {filter.cleaned_metrics.sig_sites_q10}</dd></div>
			<div><dt>Mean LRT</dt><dd>{fmt(filter.raw_metrics.mean_lrt, 3)} → {fmt(filter.cleaned_metrics.mean_lrt, 3)}</dd></div>
			<div><dt>Cauchy combined p</dt><dd>{fmt(filter.raw_metrics.cct_p_value, 4)} → {fmt(filter.cleaned_metrics.cct_p_value, 4)}</dd></div>
		</dl>
	{/if}
	{#if patches.length}
		<ol class="patches">
			{#each patches as p, i (`${p.outlier_taxon}-${p.start}`)}
				{@const s = snippet(p)}
				<li class="patch">
					<div class="patch__head">
						<span class="mono">codons {p.start}–{p.end}</span>
						<span>{p.span} codons</span>
						<span>taxon <span class="mono">{p.outlier_taxon}</span></span>
						<span>{p.consecutive_mismatches} consecutive mismatches</span>
						<span>OCI {fmt(p.oci, 3)}</span>
						{#if p.p_hypergeom != null}<span>p<sub>hyper</sub> {fmt(p.p_hypergeom, 4)}</span>{/if}
					</div>
					{#if s.observed && s.consensus}
						<pre class="snippet"><span class="lbl">consensus </span>{s.consensus}
<span class="lbl">before    </span>{s.observed}
<span class="lbl">after     </span><span class="masked">{s.masked}</span></pre>
					{:else}
						<p class="none">Sequences are not stored with this record, so the patch cannot be shown.</p>
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
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.metrics {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-2);
		font-size: var(--text-sm);
	}
	.metrics div {
		display: flex;
		flex-direction: column;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.metrics dt {
		color: var(--text-faint);
		font-size: var(--text-xs);
	}
	.metrics dd {
		margin: 0;
		font-family: var(--font-mono);
	}
	.patches {
		margin: 0;
		padding-left: 1.2rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.patch__head {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
		color: var(--text);
	}
	.snippet {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
	}
	.lbl {
		color: var(--text-faint);
		letter-spacing: 0;
	}
	.masked {
		color: var(--tier-strong);
	}
	.none {
		margin: var(--space-1) 0 0;
		font-size: var(--text-xs);
		color: var(--text-faint);
		font-style: italic;
	}
</style>
