<!--
	PhenotypeGeneCard.svelte — the gene-level half of `hyphaeon phenotype`: spectral energy, the norm
	ratio, the strongest association, the length-adjusted extreme-value p, and the permulation p when
	there was a tree to draw one from.

	WHY THIS FILE EXISTS. PLAN.md §4.5 asks the phenotype section for a "gene-level card", and the
	record's gene-level fields are five numbers that mean nothing without their definitions
	(phenotype.py:412-539). They are stated here beside each number rather than in a paragraph
	underneath, the way GeneCard.svelte states p_ACAT and the omnibus LRT, because the numbers are
	the thing a reader will quote:

	  spectral_energy      ‖A · ŷ‖: the length of the whole attribution matrix's projection onto the
	                       unit trait vector. It grows with the gene, so it is not comparable across
	                       genes on its own.
	  norm_spectral_ratio  that length over the matrix's Frobenius norm — the share of the total
	                       attribution that lies along the trait, on 0..1, and the comparable one.
	  max_assoc            the largest per-site association ρ.
	  p_evd_length_adjusted the probability that ANY of L independent sites would reach max_assoc
	                       against a random unit trait vector in N dimensions: a Gumbel correction
	                       for having taken a maximum over the gene, from a null whose standard
	                       error is 1/√max(10, N). It is the gene-level p that always exists.
	  gene_p_value_perm    the empirical p from Brownian-motion permulations of the trait on the
	                       tree — the one that needs a tree with branch lengths, and the reason a
	                       tree-free report shows a sentence here instead of a number.

	THE COMPOSITE IS DELIBERATELY NOT THE HEADLINE. `dual_track_composite` is max(score_track_a / 10,
	score_track_b), which puts a p_evd of 1e-10 on the same 0..1 scale as a ratio of 1; it is a
	convenience of the reference's ranking, not a test, so it sits with its two tracks under the
	numbers that have definitions.
-->
<script lang="ts">
	import type { PhenotypeSection } from '$lib/report/types';

	interface Props {
		record: PhenotypeSection;
		/** Fallback sentence for a record whose runtime did not record why permulations were skipped. */
		permulationsNote?: string | null;
	}
	let { record, permulationsNote = null }: Props = $props();

	const fmt = (v: number | null | undefined, dp = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp));
	const fmtP = (p: number | null | undefined) => {
		if (p == null || !Number.isFinite(p)) return '—';
		if (p < 1e-4) return p.toExponential(2);
		return p.toFixed(4);
	};
	const permRan = $derived(record.permulations_count > 0 && record.gene_p_value_perm != null);

	/**
	 * Why there is no empirical p. The runtime records it (`permulations.reason` /
	 * `.detail`, runtime/src/phenotype.js `PERMULATION_SKIP_REASONS`); the fallbacks cover a record
	 * written by a surface that did not, and the `not-requested` case is phrased as the choice it
	 * is rather than as a failure.
	 */
	const skipped = $derived.by((): string | null => {
		if (permRan) return null;
		const p = record.permulations;
		if (p?.reason === 'not-requested') {
			return 'B was 0, so no permulations were drawn: the gene-level statement here is the length-adjusted extreme-value p above. Set B above zero before running to add an empirical one.';
		}
		if (p?.detail) return p.detail;
		if (p?.reason === 'failed') return 'The permulation draw failed, so the association p-values are the parametric t-test ones.';
		return permulationsNote;
	});
	const verdict = $derived.by(() => {
		const p = record.p_evd_length_adjusted;
		const calls = record.significant_sites_count;
		if (!Number.isFinite(p)) return { tone: 'muted', label: 'No gene-level verdict', text: 'The extreme-value p could not be computed.' };
		if (p <= 0.05 && calls > 0) {
			return {
				tone: 'strong',
				label: 'The selection signal tracks the trait',
				text: `The strongest association (ρ = ${fmt(record.max_assoc)}) is above what a random trait vector would reach over ${record.codon_count.toLocaleString()} codons (p_evd = ${fmtP(p)}), and ${calls} site${calls === 1 ? '' : 's'} clear${calls === 1 ? 's' : ''} the BH level.`
			};
		}
		if (p <= 0.05) {
			return {
				tone: 'warn',
				label: 'Gene-level signal without called sites',
				text: `p_evd = ${fmtP(p)} on the gene, but no individual codon survives the multiple-testing correction. Read the ranking, not a site.`
			};
		}
		return {
			tone: 'muted',
			label: 'No gene-level association',
			text: `The strongest association (ρ = ${fmt(record.max_assoc)}) is within what a random trait vector reaches over ${record.codon_count.toLocaleString()} codons (p_evd = ${fmtP(p)}).`
		};
	});
</script>

<div class="card">
	<div class="verdict verdict--{verdict.tone}">
		<p class="verdict__label">{verdict.label}</p>
		<p class="verdict__text">{verdict.text}</p>
	</div>

	<dl class="stats">
		<div>
			<dt>p<sub>EVD</sub>, length-adjusted</dt>
			<dd class="num">{fmtP(record.p_evd_length_adjusted)}</dd>
			<dd class="sub">max ρ against a random unit trait over {record.codon_count.toLocaleString()} codons</dd>
		</div>
		<div>
			<dt>Max association</dt>
			<dd class="num">{fmt(record.max_assoc)}</dd>
			<dd class="sub">the largest per-site ρ</dd>
		</div>
		<div>
			<dt>Norm spectral ratio</dt>
			<dd class="num">{fmt(record.norm_spectral_ratio, 4)}</dd>
			<dd class="sub">share of the attribution lying along the trait (0–1)</dd>
		</div>
		<div>
			<dt>Spectral energy</dt>
			<dd class="num">{fmt(record.spectral_energy, 4)}</dd>
			<dd class="sub">‖A · ŷ‖; grows with the gene, so read the ratio beside it</dd>
		</div>
		<div>
			<dt>Called sites</dt>
			<dd class="num">{record.significant_sites_count}</dd>
			<dd class="sub">q ≤ α with ρ &gt; 0, of {record.sites.length.toLocaleString()} scored</dd>
		</div>
		<div class:muted={!permRan}>
			<dt>Permulation p</dt>
			<dd class="num">{permRan ? fmtP(record.gene_p_value_perm) : '—'}</dd>
			<dd class="sub">
				{#if permRan}
					{record.permulations_count.toLocaleString()} Brownian-motion permulations on the tree
				{:else if record.permulations?.reason === 'not-requested'}
					not requested (B = 0)
				{:else}
					permulations did not run
				{/if}
			</dd>
		</div>
	</dl>

	{#if skipped}
		<p class="note">{skipped}</p>
	{/if}

	<details class="tracks">
		<summary>Dual-track composite <span class="mono">{fmt(record.dual_track_composite, 3)}</span></summary>
		<p class="hint">
			max(track A / 10, track B), where track A is −log₁₀ p<sub>EVD</sub> = <span class="mono">{fmt(record.score_track_a, 3)}</span>
			and track B is the norm spectral ratio = <span class="mono">{fmt(record.score_track_b, 4)}</span>. The division by ten puts a
			p<sub>EVD</sub> of 1e-10 on the same 0–1 scale as a ratio of 1. It is the reference's ranking convenience, not a test:
			quote the two tracks, not their maximum.
		</p>
	</details>
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.verdict {
		border-left: 4px solid var(--border-strong);
		padding: var(--space-2) var(--space-4);
		background: var(--bg-subtle);
		border-radius: 0 var(--radius) var(--radius) 0;
	}
	.verdict--strong {
		border-color: var(--tier-strong);
		background: var(--danger-soft);
	}
	.verdict--warn {
		border-color: var(--warn);
		background: var(--warn-soft);
	}
	.verdict__label {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-lg);
	}
	.verdict__text {
		margin: 0.15rem 0 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.stats {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--space-3);
	}
	.stats div {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		display: flex;
		flex-direction: column;
	}
	.stats div.muted {
		border-style: dashed;
		color: var(--text-muted);
	}
	dt {
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.num {
		font-family: var(--font-mono);
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
	}
	.sub {
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
	.note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
		border-left: 2px solid var(--border-strong);
		padding-left: var(--space-3);
	}
	.tracks {
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
	}
	.tracks summary {
		cursor: pointer;
		font-weight: 600;
	}
	.hint {
		margin: var(--space-2) 0 0;
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
</style>
