<!--
	GeneCard.svelte — the gene-level verdict: `p_ACAT`, `p_Simes`, the omnibus LRT, the significant
	site counts, and the neural head's fields under their caveat.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "busted — Gene card with p_ACAT, p_Simes, selection
	probability, ω-class bars, SRV". The statistical fields are exact functions of the site LRTs
	(cli.py:469-505) and are the verdict; the neural fields (`selection_probability`,
	`predicted_gene_lrt`, `synonymous_rate_variation`, `omega_3`, `proportion_*`) come from
	`busted_head.onnx`, ONE seeded draw of a head whose 11 parameters are missing upstream
	(runtime/src/busted.js header; `provenance.neural_head.deterministic_upstream: false`), so they
	sit under their own heading with a plain caveat — a fact in the same voice as the results, not
	a warning (DESIGN.md §3 "Warnings and refusals") — and never drive the headline. The ω-class bar
	draws `rate_distributions` when the proportions exist, in greys: the proportions are the
	information, and three hues would have needed a legend to say which is which.

	The verdict is one sentence at heading size; `dl.stats`' first `dd.num` is p_ACAT, which the
	e2e reads at four decimals.
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
		if (!Number.isFinite(p)) return { label: 'No verdict', text: 'The Cauchy combination over the variable sites could not be computed.' };
		if (p <= 0.05) return { label: 'Evidence of episodic selection', text: `The Cauchy-combined p over the variable sites is ${fmtP(p)}, at or below 0.05.` };
		if (p <= 0.1) return { label: 'Weak evidence', text: `The Cauchy-combined p over the variable sites is ${fmtP(p)}: suggestive, not significant at 0.05.` };
		return { label: 'No gene-wide signal', text: `The Cauchy-combined p over the variable sites is ${fmtP(p)}; the evidence across sites does not reach 0.05.` };
	});
	const omegaClasses = $derived.by(() => {
		const d = r.rate_distributions;
		if (!d) return [];
		return [
			{ k: 'ω₁', i: 1, omega: d.omega_1, prop: d.proportion_1 },
			{ k: 'ω₂', i: 2, omega: d.omega_2, prop: d.proportion_2 },
			{ k: 'ω₃', i: 3, omega: d.omega_3, prop: d.proportion_3 }
		];
	});
	const hasProportions = $derived(omegaClasses.some((c) => c.prop != null && Number.isFinite(c.prop)));
	const headRan = $derived(r.selection_probability != null || r.predicted_gene_lrt != null);
</script>

<div class="gene">
	<p class="verdict">{verdict.label}.</p>
	<p class="verdict__text">{verdict.text}</p>

	<dl class="stats">
		<div><dt>p<sub>ACAT</sub></dt><dd class="num">{fmtP(r.p_value_acat)}</dd><dd class="sub">Cauchy combination over variable sites</dd></div>
		<div><dt>p<sub>Simes</sub></dt><dd class="num">{fmtP(r.p_value_simes)}</dd><dd class="sub">Simes over all sites</dd></div>
		<div><dt>Omnibus LRT</dt><dd class="num">{fmt(r.omnibus_lrt, 3)}</dd><dd class="sub">from p<sub>ACAT</sub>, 2 d.f.</dd></div>
		<div><dt>Total selection energy</dt><dd class="num">{fmt(r.total_selection_energy, 1)}</dd><dd class="sub">Σ predicted LRT</dd></div>
		<div><dt>Sites at p ≤ 0.05</dt><dd class="num">{r.sig_sites_p05}</dd><dd class="sub">{r.sig_sites_p10} at p ≤ 0.10 · {gene.statistics?.numVariable ?? '—'} variable of {r.sites}</dd></div>
	</dl>

	<h3>Neural head</h3>
	<p class="note">
		Selection probability, predicted gene LRT and synonymous rate variation come from one seeded draw of
		the neural head (<code>busted_head.onnx</code>) and are not reproducible against the Python reference;
		they never drive the verdict above.
		{#if gene.neural_head?.artifact_sha256}Head sha256 <code>{gene.neural_head.artifact_sha256.slice(0, 12)}…</code>.{/if}
	</p>
	{#if headRan}
		<dl class="stats">
			<div><dt>Selection probability</dt><dd class="num">{fmt(r.selection_probability, 3)}</dd><dd class="sub">{r.positive_selection_detected == null ? '' : r.positive_selection_detected ? 'head says: positive selection' : 'head says: no positive selection'}</dd></div>
			<div><dt>Predicted gene LRT</dt><dd class="num">{fmt(r.predicted_gene_lrt, 3)}</dd></div>
			<div><dt>Synonymous rate variation</dt><dd class="num">{fmt(r.synonymous_rate_variation, 3)}</dd></div>
		</dl>
		{#if hasProportions}
			<div class="omega" aria-label="omega class proportions">
				<div class="omega__bar">
					{#each omegaClasses as c (c.k)}
						{#if c.prop != null && Number.isFinite(c.prop)}
							<span class="omega__seg omega__seg--{c.i}" style="flex: {Math.max(0.01, c.prop)}" title="{c.k} = {fmt(c.omega, 3)}, proportion {fmt(c.prop, 3)}"></span>
						{/if}
					{/each}
				</div>
				<ul class="omega__legend">
					{#each omegaClasses as c (c.k)}
						<li><i class="omega__seg--{c.i}"></i>{c.k} = {fmt(c.omega, 3)}{c.prop != null ? ` · ${(c.prop * 100).toFixed(0)} %` : ''}</li>
					{/each}
				</ul>
			</div>
		{:else}
			<p class="note">ω classes: ω₁ = {fmt(r.rate_distributions?.omega_1, 2)}, ω₂ = {fmt(r.rate_distributions?.omega_2, 2)}, ω₃ = {fmt(r.rate_distributions?.omega_3, 2)}; proportions not reported.</p>
		{/if}
	{:else}
		<p class="note">The head did not run for this record; the fields are null, as the reference fixtures hold them.</p>
	{/if}
</div>

<style>
	.gene {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.verdict {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: var(--leading-tight);
		color: var(--text);
	}
	.verdict__text {
		margin: calc(-1 * var(--space-2)) 0 0;
		font-size: var(--text-base);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.stats {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: var(--space-3) var(--space-5);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.stats div {
		display: flex;
		flex-direction: column;
	}
	dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.num {
		font-size: var(--text-base);
		font-variant-numeric: tabular-nums;
		text-align: left;
		color: var(--text);
	}
	.sub {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	h3 {
		margin: var(--space-2) 0 0;
		font-size: var(--text-base);
		font-weight: 700;
	}
	.note {
		margin: calc(-1 * var(--space-2)) 0 0;
		color: var(--text-muted);
		font-size: var(--text-md);
		max-width: var(--measure);
	}
	code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		background: none;
		padding: 0;
	}
	.omega {
		display: grid;
		gap: var(--space-2);
		max-width: var(--measure);
	}
	.omega__bar {
		display: flex;
		gap: 1px;
		height: 8px;
	}
	.omega__seg--1 {
		background: var(--text-faint);
	}
	.omega__seg--2 {
		background: var(--plot-neutral);
	}
	.omega__seg--3 {
		background: var(--rule);
	}
	.omega__legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-sm);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.omega__legend i {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		margin-right: 0.4em;
	}
</style>
