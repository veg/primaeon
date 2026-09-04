<!--
	AttributionPanel.svelte — per-site counterfactual attribution: driver taxon, share, epoch.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "attribution when requested". `hyphaeon meme --attribute`
	(attribution.py) reverts each non-consensus taxon to the consensus codon at every attributed
	site, re-scores, and reports the drop in LRT (ΔLRT), the share of the site's signal that drop
	explains, the taxon's patristic depth, and from those an evolutionary epoch and adaptation
	mode. This panel lists the attributed sites with those fields and expands one site to its full
	driver table. The columns are the record's fields; nothing is recomputed here.
-->
<script lang="ts">
	import type { AttributionRecord } from '$lib/results/types';

	interface Props {
		attributions: Map<number, AttributionRecord>;
		onSelect?: (site: number) => void;
	}
	let { attributions, onSelect }: Props = $props();

	let open = $state<number | null>(null);
	const sites = $derived([...attributions.entries()].sort((a, b) => b[1].predicted_lrt - a[1].predicted_lrt));
	const fmt = (v: number, dp: number) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
</script>

<div class="attr">
	<p class="lede">
		{sites.length} site{sites.length === 1 ? '' : 's'} attributed. For each, the taxa whose reversion to the
		consensus codon lowers the predicted LRT the most, the share of the signal each explains, and the
		epoch inferred from their depth in the tree.
	</p>
	<div class="scroll">
		<table>
			<thead>
				<tr>
					<th>Site</th>
					<th>Consensus</th>
					<th>LRT</th>
					<th>Top driver</th>
					<th>Mutation</th>
					<th>% signal</th>
					<th>ΔLRT</th>
					<th>Mutated taxa</th>
					<th>Epoch</th>
					<th>Mode</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each sites as [site, rec] (site)}
					{@const top = rec.driving_species[0]}
					<tr>
						<td><button type="button" class="link" onclick={() => onSelect?.(site)}>{site}</button></td>
						<td class="mono">{rec.consensus_codon} ({rec.consensus_aa})</td>
						<td class="num">{fmt(rec.predicted_lrt, 3)}</td>
						<td class="mono">{top?.taxon ?? '—'}</td>
						<td class="mono">{top ? `${rec.consensus_aa}→${top.observed_aa}` : '—'}</td>
						<td class="num">{top ? `${fmt(top.pct_signal_explained, 1)}%` : '—'}</td>
						<td class="num">{top ? fmt(top.delta_lrt, 3) : '—'}</td>
						<td class="num">{rec.num_mutated_taxa}</td>
						<td class="small">{rec.when_selection_occurred.evolutionary_epoch}</td>
						<td class="small">{rec.when_selection_occurred.mode_of_adaptation}</td>
						<td>
							<button type="button" class="link" onclick={() => (open = open === site ? null : site)}>
								{open === site ? 'hide' : `all ${rec.driving_species.length}`}
							</button>
						</td>
					</tr>
					{#if open === site}
						<tr class="detail">
							<td colspan="11">
								<table class="inner">
									<thead>
										<tr><th>Taxon</th><th>Observed</th><th>ΔLRT</th><th>% signal</th><th>Mean patristic depth</th></tr>
									</thead>
									<tbody>
										{#each rec.driving_species as d (d.taxon)}
											<tr>
												<td class="mono">{d.taxon}</td>
												<td class="mono">{d.observed_codon} ({d.observed_aa})</td>
												<td class="num">{fmt(d.delta_lrt, 3)}</td>
												<td class="num">{fmt(d.pct_signal_explained, 1)}%</td>
												<td class="num">{fmt(d.mean_patristic_depth, 3)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
								<p class="small muted">
									Weighted patristic depth {fmt(rec.when_selection_occurred.weighted_patristic_depth, 3)},
									tree depth ratio {fmt(rec.when_selection_occurred.tree_depth_ratio, 3)}.
								</p>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.attr {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.lede {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.scroll {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	table {
		font-size: var(--text-sm);
		min-width: 56rem;
	}
	th {
		white-space: nowrap;
		background: var(--bg-subtle);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.small {
		font-size: var(--text-xs);
	}
	.muted {
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--link);
		text-decoration: underline;
		font-family: var(--font-mono);
	}
	.detail td {
		background: var(--bg-subtle);
	}
	.inner {
		min-width: 0;
		margin: 0;
	}
	.inner th {
		background: transparent;
	}
</style>
