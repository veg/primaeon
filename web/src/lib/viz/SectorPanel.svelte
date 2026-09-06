<!--
	SectorPanel.svelte — the epistatic sectors: spectral coherence against its null, p_perm with
	B and the Monte Carlo caveat, the isotropic baseline, and the reference bands as text.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "sector panel with coherence, p_perm, null bands and the
	paper's reference ranges". Each sector is one block: an h3, the consensus signature, a
	two-column list of the numbers, and the coherence λ₁/Tr drawn on a 0–1 track against the
	null's mean ± 2 s.d., its 95th percentile and the isotropic baseline 1/K, so the eye sees
	whether the observed value clears the null before reading the number. `p_perm` is printed to
	the precision B affords — PHASE2A measured about ±0.03 absolute at the CLI's B = 1,000 on each
	side independently, so "p_perm = 0.093" to three decimals is noise; the block prints two
	decimals with the B and the ± beside it, and says which seed drew the null. The reference
	bands are text because the paper's Table S3 is not bundled with the engine: what is stated is
	what the README defines (isotropic baseline 1/K, min coherence 0.50, the null's 95th
	percentile) and the reader is pointed to the table for the curated sectors' ranges.

	SETTING (DESIGN.md §3 "Sector panel"). No cards. The observed value is the one purple mark —
	the same "signal against its null" the rest of the report uses purple for; everything else on
	the track is a grey. The signature is `p.sig`, not `p.pars`: the phenotype section already has a
	`p.pars` the e2e locates in strict mode, and this panel is mounted inside that section too.
-->
<script lang="ts">
	import type { EpistaticSector } from '$lib/report/types';

	interface Props {
		sectors: EpistaticSector[];
		permutations: number | null;
		seed: number | null;
		onSelect?: (site: number) => void;
	}
	let { sectors, permutations, seed, onSelect }: Props = $props();

	/** Monte Carlo half-width 3·√(p(1−p)/B) (PLAN.md §5.4's statistical class), ≈ ±0.03 at B = 1,000. */
	function mcError(p: number, B: number | null): number | null {
		if (!B || B <= 0) return null;
		const q = Math.min(Math.max(p, 1 / B), 1 - 1 / B);
		return 3 * Math.sqrt((q * (1 - q)) / B);
	}
	const clamp = (v: number) => Math.max(0, Math.min(1, v));
	const pct = (v: number) => `${clamp(v) * 100}%`;
	const fmt = (v: number, dp = 3) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
</script>

<div class="sectors">
	{#if sectors.length === 0}
		<p class="empty">No sector: no community of ≥ 3 connected sites reached coherence ≥ 0.50 after eigenvector pruning.</p>
	{:else}
		<ol class="list">
			{#each sectors as s (s.sector_id)}
				{@const err = mcError(s.p_perm, permutations)}
				{@const lo = clamp(s.null_coherence_mean - 2 * s.null_coherence_std)}
				{@const hi = clamp(s.null_coherence_mean + 2 * s.null_coherence_std)}
				<li class="sector">
					<h3>Sector {s.sector_id} <span class="size">{s.size} sites</span></h3>
					<p class="sig mono">{s.consensus_signature}</p>
					<div class="body">
						<dl class="facts">
							<dt>Sites</dt>
							<dd class="sites">
								{#each s.sites as site, i (site)}
									<button type="button" class="link" onclick={() => onSelect?.(site)}>{site}</button>{i < s.sites.length - 1 ? ', ' : ''}
								{/each}
							</dd>
							<dt>Spectral coherence</dt>
							<dd><span class="num">{fmt(s.spectral_coherence)}</span> <span class="sub">λ₁ / Tr over the sector's attribution rows</span></dd>
							<dt>Null coherence</dt>
							<dd><span class="num">{fmt(s.null_coherence_mean)} ± {fmt(s.null_coherence_std)}</span> <span class="sub">mean ± s.d.; 95th percentile {fmt(s.null_coherence_95)}</span></dd>
							<dt>Isotropic baseline</dt>
							<dd><span class="num">{fmt(s.isotropic_baseline)}</span> <span class="sub">1/K for K = {s.size}</span></dd>
							<dt>p<sub>perm</sub></dt>
							<dd>
								<span class="num">{permutations ? s.p_perm.toFixed(2) : fmt(s.p_perm)}{#if err != null}&nbsp;±&nbsp;{err.toFixed(2)}{/if}</span>
								<span class="sub">{permutations ? `B = ${permutations.toLocaleString()}` : 'B not recorded'}{seed != null ? `, seed ${seed}` : ''}; Monte Carlo error on each side</span>
							</dd>
							<dt>Mean LRT</dt>
							<dd><span class="num">{fmt(s.mean_lrt)}</span></dd>
							<dt>Shared taxa</dt>
							<dd><span class="num">{s.shared_taxa}</span></dd>
						</dl>
						<figure class="coherence">
							<div
								class="track"
								role="img"
								aria-label="coherence {fmt(s.spectral_coherence)} against null mean {fmt(s.null_coherence_mean)}, 95th percentile {fmt(s.null_coherence_95)}, isotropic baseline {fmt(s.isotropic_baseline)}"
							>
								<span class="band" style="left: {pct(lo)}; width: {pct(hi - lo)}" title="null mean ± 2 s.d."></span>
								<span class="axis"></span>
								<span class="mark mark--iso" style="left: {pct(s.isotropic_baseline)}" title="isotropic baseline 1/K = {fmt(s.isotropic_baseline)}"></span>
								<span class="mark mark--p95" style="left: {pct(s.null_coherence_95)}" title="null 95th percentile {fmt(s.null_coherence_95)}"></span>
								<span class="mark mark--obs" style="left: {pct(s.spectral_coherence)}" title="observed coherence {fmt(s.spectral_coherence)}"></span>
								<span class="end end--0">0</span>
								<span class="end end--1">1</span>
							</div>
							<figcaption>
								<b>Sector {s.sector_id} coherence.</b>
								The purple bar is the observed λ₁/Tr on a 0–1 line; the grey band is the permutation null's mean
								± 2 s.d., the dashed tick its 95th percentile, the solid tick the isotropic baseline 1/K.
							</figcaption>
						</figure>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
	<p class="note bands">
		<strong>Reading the numbers.</strong>
		Coherence is λ₁/Tr of the sector's attribution matrix: 1/K (the isotropic baseline, the solid tick)
		means K unrelated sites, 1.0 means one shared axis. A sector is kept at coherence ≥ 0.50
		(<code>--min-coherence</code>); its p<sub>perm</sub> is the share of B random K-site subsets whose
		coherence reached the observed value, so a value at or below 1/B is "none of B". At B = 1,000 the
		reference and the port each carry about ±0.03 of Monte Carlo error on p<sub>perm</sub> and ±5% on the
		null moments (PHASE2A); B = 10,000 is the setting the parity class was written for and the
		"Re-run with…" disclosure sets it. The paper's Table S3 lists the coherence and p<sub>perm</sub> of
		its curated sectors; compare a sector here against that table and against its own null's 95th
		percentile (the dashed tick), not against a fixed cut-off.
	</p>
</div>

<style>
	.sectors {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.sector {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	h3 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 700;
		line-height: var(--leading-tight);
		color: var(--text);
	}
	.size {
		font-weight: 400;
		font-size: var(--text-sm);
		color: var(--text-faint);
		margin-left: var(--space-2);
	}
	.sig {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.body {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(14rem, 2fr);
		gap: var(--space-3) var(--space-6);
		align-items: start;
	}
	@media (max-width: 640px) {
		.body {
			grid-template-columns: 1fr;
		}
	}
	.facts {
		margin: 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: var(--space-4);
		row-gap: 0;
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
		padding: var(--space-1) 0;
	}
	dt {
		color: var(--text-muted);
		padding: 0.15rem 0;
	}
	dd {
		margin: 0;
		padding: 0.15rem 0;
		color: var(--text);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.sub {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--brand);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
		font-variant-numeric: tabular-nums;
	}
	.link:hover {
		text-decoration-thickness: 2px;
	}
	.link:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.coherence {
		margin: 0;
	}
	.track {
		position: relative;
		height: 2.25rem;
		margin: 0 0 var(--space-2);
	}
	.axis {
		position: absolute;
		left: 0;
		right: 0;
		top: 1rem;
		height: 1px;
		background: var(--plot-axis);
	}
	.band {
		position: absolute;
		top: 0.55rem;
		height: 0.9rem;
		background: var(--plot-null-band);
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.mark {
		position: absolute;
		top: 0.35rem;
		height: 1.3rem;
		width: 0;
		border-left: 1px solid var(--plot-threshold);
	}
	.mark--p95 {
		border-left-style: dashed;
	}
	.mark--obs {
		top: 0.2rem;
		height: 1.6rem;
		border: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--plot-called);
	}
	.end {
		position: absolute;
		top: 1.4rem;
		font-size: var(--text-xs);
		color: var(--plot-tick);
		line-height: 1;
	}
	.end--0 {
		left: 0;
	}
	.end--1 {
		right: 0;
	}
	figcaption {
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
	.bands {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	.bands strong {
		color: var(--text);
		font-weight: 700;
	}
	.bands code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.empty {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
</style>
