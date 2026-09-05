<!--
	SectorPanel.svelte — the epistatic sectors: spectral coherence against its null, p_perm with
	B and the Monte Carlo caveat, the isotropic baseline, and the reference bands as text.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "sector panel with coherence, p_perm, null bands and the
	paper's reference ranges". Each sector is one card: the coherence λ₁/Tr drawn on a 0–1 track
	against the null's mean and 95th percentile and the isotropic baseline 1/K, so the eye sees
	whether the observed value clears the null before reading the number. `p_perm` is printed to
	the precision B affords — PHASE2A measured about ±0.03 absolute at the CLI's B = 1,000 on each
	side independently, so "p_perm = 0.093" to three decimals is noise; the card prints two
	decimals with the B and the ± beside it, and says which seed drew the null. The reference
	bands are text because the paper's Table S3 is not bundled with the engine: what is stated is
	what the README defines (isotropic baseline 1/K, min coherence 0.50, the null's 95th
	percentile) and the reader is pointed to the table for the curated sectors' ranges.
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
	const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;
	const fmt = (v: number, dp = 3) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
</script>

<div class="sectors">
	{#if sectors.length === 0}
		<p class="empty">No sector: no community of ≥ 3 connected sites reached coherence ≥ 0.50 after eigenvector pruning.</p>
	{:else}
		<ol class="list">
			{#each sectors as s (s.sector_id)}
				{@const err = mcError(s.p_perm, permutations)}
				<li class="card">
					<header>
						<h3>Sector {s.sector_id} <span class="size">{s.size} sites</span></h3>
						<p class="sig mono">{s.consensus_signature}</p>
					</header>
					<div class="track" role="img" aria-label="coherence {fmt(s.spectral_coherence)} against null mean {fmt(s.null_coherence_mean)}, 95th percentile {fmt(s.null_coherence_95)}, isotropic baseline {fmt(s.isotropic_baseline)}">
						<span class="band" style="left: {pct(Math.max(0, s.null_coherence_mean - s.null_coherence_std))}; width: {pct(2 * s.null_coherence_std)}" title="null mean ± 1 sd"></span>
						<span class="mark mark--iso" style="left: {pct(s.isotropic_baseline)}" title="isotropic baseline 1/K = {fmt(s.isotropic_baseline)}"></span>
						<span class="mark mark--null" style="left: {pct(s.null_coherence_mean)}" title="null mean {fmt(s.null_coherence_mean)}"></span>
						<span class="mark mark--p95" style="left: {pct(s.null_coherence_95)}" title="null 95th percentile {fmt(s.null_coherence_95)}"></span>
						<span class="mark mark--obs" style="left: {pct(s.spectral_coherence)}" title="observed coherence {fmt(s.spectral_coherence)}"></span>
					</div>
					<dl class="facts">
						<div><dt>Spectral coherence</dt><dd class="num">{fmt(s.spectral_coherence)}</dd><dd class="sub">λ₁ / Tr over the sector's attribution rows</dd></div>
						<div>
							<dt>p<sub>perm</sub></dt>
							<dd class="num">{permutations ? s.p_perm.toFixed(2) : fmt(s.p_perm)}{#if err != null}<span class="pm"> ± {err.toFixed(2)}</span>{/if}</dd>
							<dd class="sub">{permutations ? `B = ${permutations.toLocaleString()}` : 'B not recorded'}{seed != null ? `, seed ${seed}` : ''}; Monte Carlo error on each side</dd>
						</div>
						<div><dt>Null</dt><dd class="num">{fmt(s.null_coherence_mean)} <span class="pm">± {fmt(s.null_coherence_std)}</span></dd><dd class="sub">mean ± sd · 95th percentile {fmt(s.null_coherence_95)}</dd></div>
						<div><dt>Isotropic baseline</dt><dd class="num">{fmt(s.isotropic_baseline)}</dd><dd class="sub">1/K for K = {s.size}</dd></div>
						<div><dt>Mean LRT</dt><dd class="num">{fmt(s.mean_lrt)}</dd><dd class="sub">{s.shared_taxa} shared taxa</dd></div>
					</dl>
					<p class="sites">
						Sites:
						{#each s.sites as site, i (site)}
							<button type="button" class="link mono" onclick={() => onSelect?.(site)}>{site}</button>{i < s.sites.length - 1 ? ', ' : ''}
						{/each}
					</p>
				</li>
			{/each}
		</ol>
	{/if}
	<aside class="bands">
		<strong>Reading the numbers.</strong>
		Coherence is λ₁/Tr of the sector's attribution matrix: 1/K (the isotropic baseline, drawn as the
		left tick) means K unrelated sites, 1.0 means one shared axis. A sector is kept at coherence ≥ 0.50
		(<code>--min-coherence</code>); its p<sub>perm</sub> is the share of B random K-site subsets whose
		coherence reached the observed value, so a value at or below 1/B is "none of B". At B = 1,000 the
		reference and the port each carry about ±0.03 of Monte Carlo error on p<sub>perm</sub> and ±5% on the
		null moments (PHASE2A); B = 10,000 is the setting the parity class was written for and the
		"Re-run with…" disclosure sets it. The paper's Table S3 lists the coherence and p<sub>perm</sub> of
		its curated sectors; compare a sector here against that table and against its own null's 95th
		percentile (the right tick), not against a fixed cut-off.
	</aside>
</div>

<style>
	.sectors {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: var(--space-3);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	header h3 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.size {
		font-family: var(--font-text);
		font-size: var(--text-xs);
		color: var(--text-muted);
		margin-left: var(--space-2);
	}
	.sig {
		margin: 0.15rem 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.track {
		position: relative;
		height: 1.1rem;
		background: linear-gradient(to right, var(--bg-subtle), var(--border));
		border-radius: 999px;
		margin: var(--space-1) 0.5rem;
	}
	.band {
		position: absolute;
		top: 0.2rem;
		height: 0.7rem;
		background: var(--text-faint);
		opacity: 0.35;
		border-radius: 999px;
	}
	.mark {
		position: absolute;
		top: -0.2rem;
		width: 2px;
		height: 1.5rem;
		transform: translateX(-1px);
		background: var(--text-muted);
	}
	.mark--iso {
		background: var(--text-faint);
		border-left: 1px dashed var(--text-faint);
		width: 0;
	}
	.mark--p95 {
		background: var(--warn);
	}
	.mark--obs {
		background: var(--accent);
		width: 4px;
		transform: translateX(-2px);
		border-radius: 2px;
	}
	.facts {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-2);
	}
	.facts div {
		display: flex;
		flex-direction: column;
	}
	dt {
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.pm {
		color: var(--text-faint);
		font-size: var(--text-xs);
	}
	.sub {
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
	.sites {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--link);
		text-decoration: underline;
	}
	.bands {
		font-size: var(--text-sm);
		color: var(--text-muted);
		border-left: 3px solid var(--border-strong);
		padding-left: var(--space-3);
	}
	.empty {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
