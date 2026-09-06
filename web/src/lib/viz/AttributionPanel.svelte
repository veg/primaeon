<!--
	AttributionPanel.svelte — per-site counterfactual attribution: driver taxon, share, epoch.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "attribution when requested". `hyphaeon meme --attribute`
	(attribution.py) reverts each non-consensus taxon to the consensus codon at every attributed
	site, re-scores, and reports the drop in LRT (ΔLRT), the share of the site's signal that drop
	explains, the taxon's patristic depth, and from those an evolutionary epoch and adaptation
	mode. This panel lists the attributed sites with those fields, as a captioned journal table
	(DESIGN.md §3 "Tables"), and expands one site to its full driver table. The columns are the
	record's fields; nothing is recomputed here. Site numbers are links because they open the
	site tree.
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
			<caption>
				<b>Attributed sites.</b>
				{sites.length} site{sites.length === 1 ? '' : 's'}, ordered by predicted LRT. Top driver is the taxon
				whose reversion to the consensus codon lowers the LRT most; ΔLRT is that drop and % signal the share
				of the site’s LRT it explains; epoch and mode follow from the drivers’ patristic depth. Click a site
				number to open its tree; “all N” lists every driver.
			</caption>
			<thead>
				<tr>
					<th class="num">Site</th>
					<th>Consensus</th>
					<th class="num">LRT</th>
					<th>Top driver</th>
					<th>Mutation</th>
					<th class="num">% signal</th>
					<th class="num">ΔLRT</th>
					<th class="num">Mutated taxa</th>
					<th>Epoch</th>
					<th>Mode</th>
					<th>Drivers</th>
				</tr>
			</thead>
			<tbody>
				{#each sites as [site, rec] (site)}
					{@const top = rec.driving_species[0]}
					<tr>
						<td class="num"><button type="button" class="link" onclick={() => onSelect?.(site)}>{site}</button></td>
						<td><span class="mono">{rec.consensus_codon}</span> {rec.consensus_aa}</td>
						<td class="num">{fmt(rec.predicted_lrt, 3)}</td>
						<td class="mono">{top?.taxon ?? '—'}</td>
						<td class="mono">{top ? `${rec.consensus_aa}→${top.observed_aa}` : '—'}</td>
						<td class="num">{top ? `${fmt(top.pct_signal_explained, 1)} %` : '—'}</td>
						<td class="num">{top ? fmt(top.delta_lrt, 3) : '—'}</td>
						<td class="num">{rec.num_mutated_taxa}</td>
						<td class="small">{rec.when_selection_occurred.evolutionary_epoch}</td>
						<td class="small">{rec.when_selection_occurred.mode_of_adaptation}</td>
						<td>
							<button type="button" class="link" aria-expanded={open === site} onclick={() => (open = open === site ? null : site)}>
								{open === site ? 'hide' : `all ${rec.driving_species.length}`}
							</button>
						</td>
					</tr>
					{#if open === site}
						<tr class="detail">
							<td colspan="11">
								<table class="inner">
									<thead>
										<tr><th>Taxon</th><th>Observed</th><th class="num">ΔLRT</th><th class="num">% signal</th><th class="num">Mean patristic depth</th></tr>
									</thead>
									<tbody>
										{#each rec.driving_species as d (d.taxon)}
											<tr>
												<td class="mono">{d.taxon}</td>
												<td><span class="mono">{d.observed_codon}</span> {d.observed_aa}</td>
												<td class="num">{fmt(d.delta_lrt, 3)}</td>
												<td class="num">{fmt(d.pct_signal_explained, 1)} %</td>
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
		font-size: var(--text-base);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		min-width: 56rem;
		border-collapse: collapse;
		font-size: var(--text-md);
		line-height: var(--leading-normal);
	}
	caption {
		caption-side: top;
		text-align: left;
		max-width: var(--measure);
		padding: 0 0 var(--space-2);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	caption b {
		color: var(--text);
		font-weight: 700;
	}
	thead tr {
		border-top: 1px solid var(--text);
		border-bottom: 1px solid var(--text);
	}
	th,
	td {
		text-align: left;
		vertical-align: top;
		padding: 0.4rem 0.75rem 0.4rem 0;
		border: 0;
		white-space: nowrap;
	}
	th {
		font-weight: 700;
		color: var(--text);
	}
	tbody tr {
		border-bottom: 1px solid var(--hair);
	}
	tbody tr:last-child {
		border-bottom: 1px solid var(--text);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.small {
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
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
	.detail > td {
		padding: var(--space-2) 0 var(--space-3) var(--space-5);
		white-space: normal;
	}
	.inner {
		min-width: 0;
		width: auto;
		margin: 0;
	}
	.inner thead tr {
		border-top: 0;
		border-bottom: 1px solid var(--hair);
	}
	.inner tbody tr:last-child {
		border-bottom: 1px solid var(--hair);
	}
</style>
