<!--
	SweepTable.svelte — the per-site temporal table: classification, statistics, and wave loadings.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the numbers behind the panels, as a captioned table in
	the report's grammar (DESIGN.md §3 "Tables"): 14 px, collapsed, head between two --text rules,
	body rows on --hair, tabular numerals, mono site labels, no zebra. Sweep sites (confirmed or
	rescued) get the purple called-square that means "called" everywhere on the site; every other
	classification is plain. Sorted by peak date so the table reads in the same chronological order
	as the waterfall. Scientific notation is set with a real superscript per the design.
-->
<script lang="ts">
	import type { TemporalSite } from '$lib/temporal/types';
	import { CLASSIFICATION_LABELS } from '$lib/temporal/types';

	interface Props {
		sites: TemporalSite[];
	}
	let { sites }: Props = $props();

	// Sweep sites first (chronological), then the rest by site.
	const rows = $derived.by(() => {
		const sweeps = sites
			.filter((s) => s.is_confirmed_sweep || s.is_rescued_sweep)
			.sort((a, b) => (a.peak_date ?? 0) - (b.peak_date ?? 0));
		const others = sites
			.filter((s) => !(s.is_confirmed_sweep || s.is_rescued_sweep))
			.sort((a, b) => a.site - b.site);
		return [...sweeps, ...others];
	});
	const sweepCount = $derived(sites.filter((s) => s.is_confirmed_sweep || s.is_rescued_sweep).length);

	function fmt(v: number | null, dp = 3): string {
		if (v === null || !Number.isFinite(v)) return '—';
		return v.toFixed(dp);
	}
	function fmtDate(v: number | null): string {
		return v === null || !Number.isFinite(v) ? '—' : v.toFixed(2);
	}
</script>

<figure class="wrap">
	<table>
		<caption>
			<b></b>Per-site temporal metrics for the {sites.length} variable codons, sweep sites (confirmed
			or rescued, {sweepCount} of them) first and then in chronological peak-date order. A purple square
			marks a sweep site. <span class="mono">q</span> columns are FDR-adjusted; R² is the fPCA dynamic-alignment
			fit; L₁–L₄ are the wave loadings.
		</caption>
		<thead>
			<tr>
				<th class="call" aria-label="Sweep"></th>
				<th>Mutation</th>
				<th>Classification</th>
				<th class="num">LRT</th>
				<th class="num">q<sub>static</sub></th>
				<th class="num">q<sub>perm</sub></th>
				<th class="num">R²</th>
				<th class="num">Peak</th>
				<th class="num">Peak â</th>
				<th class="num">L₁</th>
				<th class="num">L₂</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as s (s.site)}
				<tr>
					<td class="call">
						{#if s.is_confirmed_sweep || s.is_rescued_sweep}<span class="sq" aria-label="sweep"></span
							>{:else}—{/if}
					</td>
					<td class="mono">{s.mutation_label}</td>
					<td>{CLASSIFICATION_LABELS[s.classification] ?? s.classification}</td>
					<td class="num">{fmt(s.lrt)}</td>
					<td class="num">{fmt(s.q_static)}</td>
					<td class="num">{fmt(s.q_perm)}</td>
					<td class="num">{fmt(s.r2_fpca)}</td>
					<td class="num">{fmtDate(s.peak_date)}</td>
					<td class="num">{fmt(s.peak_intensity)}</td>
					<td class="num">{fmt(s.wave_loadings[0], 2)}</td>
					<td class="num">{fmt(s.wave_loadings[1], 2)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
	.wrap {
		margin: 0;
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: var(--text-md);
	}
	caption {
		caption-side: top;
		text-align: left;
		color: var(--text-muted);
		max-width: var(--measure);
		margin-bottom: var(--space-3);
	}
	caption b {
		color: var(--text);
		font-weight: 700;
	}
	thead th {
		border-top: 1px solid var(--text);
		border-bottom: 1px solid var(--text);
		color: var(--text);
		font-weight: 700;
		text-align: left;
		padding: 0.4rem 0.75rem 0.4rem 0;
		white-space: nowrap;
	}
	tbody td {
		border-bottom: 1px solid var(--hair);
		padding: 0.4rem 0.75rem 0.4rem 0;
	}
	tbody tr:last-child td {
		border-bottom: 1px solid var(--text);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.call {
		width: 1.5rem;
	}
	.sq {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--brand);
	}
</style>
