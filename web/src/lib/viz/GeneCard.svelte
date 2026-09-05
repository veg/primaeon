<!--
	GeneCard.svelte — the gene-level verdict: `p_ACAT`, `p_Simes`, the omnibus LRT, the significant
	site counts, and the neural head's fields under the nondeterminism note.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "busted — Gene card with p_ACAT, p_Simes, selection
	probability, ω-class bars, SRV". The statistical fields are exact functions of the site LRTs
	(cli.py:469-505) and are the verdict; the neural fields (`selection_probability`,
	`predicted_gene_lrt`, `synonymous_rate_variation`, `omega_3`, `proportion_*`) come from
	`busted_head.onnx`, ONE seeded draw of a head whose 11 parameters are missing upstream
	(runtime/src/busted.js header; `provenance.neural_head.deterministic_upstream: false`), so they
	are shown in their own box, labelled "not reproducible against the Python reference", and never
	drive the headline. The ω-class bars draw `rate_distributions` when the proportions exist.
-->
<script lang="ts">
	import type { GeneSection } from '$lib/report/types';

	interface Props {
		gene: GeneSection;
	}
	let { gene }: Props = $props();

	const r = $derived(gene.record);
	const fmtP = (p: number | null | undefined) => {
		if (p == null || !Number.isFinite(p)) return '—';
		if (p < 1e-4) return p.toExponential(2);
		return p.toFixed(4);
	};
	const fmt = (v: number | null | undefined, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp));
	const verdict = $derived.by(() => {
		const p = r.p_value_acat;
		if (!Number.isFinite(p)) return { label: 'No verdict', tone: 'muted', text: 'p_ACAT could not be computed.' };
		if (p <= 0.05) return { label: 'Evidence of episodic selection', tone: 'strong', text: `Cauchy-combined p over the variable sites is ${fmtP(p)} (≤ 0.05).` };
		if (p <= 0.1) return { label: 'Weak evidence', tone: 'warn', text: `p_ACAT ${fmtP(p)}: suggestive, not significant at 0.05.` };
		return { label: 'No gene-wide signal', tone: 'muted', text: `p_ACAT ${fmtP(p)}: the combined evidence across sites does not reach 0.05.` };
	});
	const omegaClasses = $derived.by(() => {
		const d = r.rate_distributions;
		if (!d) return [];
		const rows = [
			{ k: 'ω₁', omega: d.omega_1, prop: d.proportion_1 },
			{ k: 'ω₂', omega: d.omega_2, prop: d.proportion_2 },
			{ k: 'ω₃', omega: d.omega_3, prop: d.proportion_3 }
		];
		return rows;
	});
	const hasProportions = $derived(omegaClasses.some((c) => c.prop != null && Number.isFinite(c.prop)));
	const headRan = $derived(r.selection_probability != null || r.predicted_gene_lrt != null);
</script>

<div class="gene">
	<div class="verdict verdict--{verdict.tone}">
		<p class="verdict__label">{verdict.label}</p>
		<p class="verdict__text">{verdict.text}</p>
	</div>

	<dl class="stats">
		<div><dt>p<sub>ACAT</sub></dt><dd class="num">{fmtP(r.p_value_acat)}</dd><dd class="sub">Cauchy combination over variable sites</dd></div>
		<div><dt>p<sub>Simes</sub></dt><dd class="num">{fmtP(r.p_value_simes)}</dd><dd class="sub">Simes over all sites</dd></div>
		<div><dt>Omnibus LRT</dt><dd class="num">{fmt(r.omnibus_lrt, 3)}</dd><dd class="sub">from p<sub>ACAT</sub>, 2 d.f.</dd></div>
		<div><dt>Total selection energy</dt><dd class="num">{fmt(r.total_selection_energy, 1)}</dd><dd class="sub">Σ predicted LRT</dd></div>
		<div><dt>Sites at p ≤ 0.05</dt><dd class="num">{r.sig_sites_p05}</dd><dd class="sub">{r.sig_sites_p10} at p ≤ 0.10 · {gene.statistics?.numVariable ?? '—'} variable of {r.sites}</dd></div>
	</dl>

	<details class="neural" open={headRan}>
		<summary>
			Neural head
			<span class="tag">nondeterministic upstream</span>
		</summary>
		<p class="hint">
			These fields come from <code>busted_head.onnx</code>, one seeded draw of a head whose parameters are
			missing from the reference checkpoint; the Python CLI draws new ones on every run, so they are not
			reproducible against it and do not drive the verdict above (runtime/src/busted.js).
			{#if gene.neural_head?.artifact_sha256}Head sha256 <code>{gene.neural_head.artifact_sha256.slice(0, 12)}…</code>.{/if}
		</p>
		{#if headRan}
			<dl class="stats stats--neural">
				<div><dt>Selection probability</dt><dd class="num">{fmt(r.selection_probability, 3)}</dd><dd class="sub">{r.positive_selection_detected == null ? '' : r.positive_selection_detected ? 'head says: positive selection' : 'head says: no positive selection'}</dd></div>
				<div><dt>Predicted gene LRT</dt><dd class="num">{fmt(r.predicted_gene_lrt, 3)}</dd></div>
				<div><dt>Synonymous rate variation</dt><dd class="num">{fmt(r.synonymous_rate_variation, 3)}</dd></div>
			</dl>
			{#if hasProportions}
				<div class="omega" aria-label="omega class proportions">
					<div class="omega__bar">
						{#each omegaClasses as c (c.k)}
							{#if c.prop != null && Number.isFinite(c.prop)}
								<span class="omega__seg omega__seg--{c.k === 'ω₁' ? 1 : c.k === 'ω₂' ? 2 : 3}" style="flex: {Math.max(0.01, c.prop)}" title="{c.k} = {fmt(c.omega, 3)}, proportion {fmt(c.prop, 3)}"></span>
							{/if}
						{/each}
					</div>
					<ul class="omega__legend">
						{#each omegaClasses as c (c.k)}
							<li><span class="swatch swatch--{c.k === 'ω₁' ? 1 : c.k === 'ω₂' ? 2 : 3}"></span>{c.k} = {fmt(c.omega, 3)}{c.prop != null ? ` · ${(c.prop * 100).toFixed(0)}%` : ''}</li>
						{/each}
					</ul>
				</div>
			{:else}
				<p class="hint">ω classes: ω₁ = {fmt(r.rate_distributions?.omega_1, 2)}, ω₂ = {fmt(r.rate_distributions?.omega_2, 2)}, ω₃ = {fmt(r.rate_distributions?.omega_3, 2)}; proportions not reported.</p>
			{/if}
		{:else}
			<p class="hint">The head did not run for this record; the fields are null, as the reference fixtures hold them.</p>
		{/if}
	</details>
</div>

<style>
	.gene {
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
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: var(--space-3);
	}
	.stats div {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		display: flex;
		flex-direction: column;
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
	.neural {
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
	}
	.neural summary {
		cursor: pointer;
		font-weight: 600;
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.tag {
		border-radius: 999px;
		padding: 0 0.6rem;
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--text-xs);
		font-weight: 600;
	}
	.hint {
		margin: var(--space-2) 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.stats--neural {
		margin-top: var(--space-2);
	}
	.omega {
		margin-top: var(--space-3);
		display: grid;
		gap: var(--space-2);
	}
	.omega__bar {
		display: flex;
		height: 0.9rem;
		border-radius: 999px;
		overflow: hidden;
		background: var(--border);
	}
	.omega__seg--1,
	.swatch--1 {
		background: var(--tier-none);
	}
	.omega__seg--2,
	.swatch--2 {
		background: var(--brand);
	}
	.omega__seg--3,
	.swatch--3 {
		background: var(--accent);
	}
	.omega__legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--text-muted);
		font-family: var(--font-mono);
	}
	.swatch {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		margin-right: 0.35rem;
		vertical-align: -1px;
	}
</style>
