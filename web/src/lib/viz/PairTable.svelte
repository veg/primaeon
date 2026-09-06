<!--
	PairTable.svelte — the co-selection edges as a sortable table with the Python key names.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "pair table". The columns are `hyphaeon epistasis`'s edge
	record verbatim (compute_branch_coselection_network: site_u, site_v, ref_u, ref_v, lrt_u,
	lrt_v, similarity, shared_taxa, p_val, fdr_q, cesi) so a reader can match a row to the JSON or
	the GraphML. `shared_branches` and `hyper_p` duplicate `shared_taxa` and `p_val`
	(PHASE2A: names left from a hypergeometric formulation; there is no branch projection) and are
	not shown twice. Default order is CESI descending, the reference's own sort.

	SETTING (DESIGN.md §3 "Tables"). A caption above, three black rules (top of head, bottom of
	head, under the last row), hairlines between rows, no zebra, no side borders. The sort is shown
	by underlining the active head cell; the arrow beside it gives the direction. Scientific
	notation is set as a mantissa and a real superscript exponent rather than `1.01e-5`.
-->
<script lang="ts">
	import type { EpistasisEdge } from '$lib/report/types';

	interface Props {
		edges: EpistasisEdge[];
		onSelect?: (site: number) => void;
	}
	let { edges, onSelect }: Props = $props();

	type Key = 'site_u' | 'site_v' | 'lrt_u' | 'lrt_v' | 'similarity' | 'shared_taxa' | 'p_val' | 'fdr_q' | 'cesi';
	let sortKey = $state<Key>('cesi');
	let ascending = $state(false);

	const COLUMNS: Array<{ key: Key; label: string; dp?: number; sci?: boolean }> = [
		{ key: 'site_u', label: 'site_u' },
		{ key: 'site_v', label: 'site_v' },
		{ key: 'lrt_u', label: 'lrt_u', dp: 3 },
		{ key: 'lrt_v', label: 'lrt_v', dp: 3 },
		{ key: 'similarity', label: 'similarity', dp: 4 },
		{ key: 'shared_taxa', label: 'shared_taxa' },
		{ key: 'p_val', label: 'p_val', sci: true },
		{ key: 'fdr_q', label: 'fdr_q', sci: true },
		{ key: 'cesi', label: 'cesi', dp: 3 }
	];

	const sorted = $derived.by(() => {
		const out = [...edges];
		out.sort((a, b) => {
			const d = (a[sortKey] as number) - (b[sortKey] as number);
			return ascending ? d : -d;
		});
		return out;
	});

	function sortBy(k: Key) {
		if (sortKey === k) ascending = !ascending;
		else {
			sortKey = k;
			ascending = k === 'site_u' || k === 'site_v' || k === 'p_val' || k === 'fdr_q';
		}
	}
	/** Mantissa and exponent of a p-value, for `m × 10<sup>e</sup>`; `null` exponent means print `m` alone. */
	function sci(v: number): { m: string; e: string | null } {
		if (v === 0) return { m: '0', e: null };
		if (v >= 0.001) return { m: v.toFixed(3), e: null };
		const [m, e] = v.toExponential(2).split('e');
		return { m, e: e.replace('-', '−').replace('+', '') };
	}
	const fmt = (v: number, c: { dp?: number }) => (c.dp != null ? v.toFixed(c.dp) : String(v));
</script>

{#if edges.length === 0}
	<p class="empty">No edges.</p>
{:else}
	<div class="scroll">
		<table>
			<caption>
				<b>Co-selection pairs.</b>
				One row per edge kept by <code>hyphaeon epistasis</code>, {edges.length} in all, in CESI order; the column
				names are the engine's, so a row can be matched to the JSON or the GraphML. Click a column head to
				sort by it and a site to open its tree.
			</caption>
			<thead>
				<tr>
					{#each COLUMNS as c (c.key)}
						<th scope="col" class:num={c.key !== 'site_u' && c.key !== 'site_v'} aria-sort={sortKey === c.key ? (ascending ? 'ascending' : 'descending') : 'none'}>
							<button type="button" class="sort" class:sort--on={sortKey === c.key} onclick={() => sortBy(c.key)}>
								{c.label}{#if sortKey === c.key}<span class="arrow" aria-hidden="true">{ascending ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as e (`${e.site_u}-${e.site_v}`)}
					<tr>
						<td class="mono"><button type="button" class="link" onclick={() => onSelect?.(e.site_u)}>{e.ref_u}{e.site_u}</button></td>
						<td class="mono"><button type="button" class="link" onclick={() => onSelect?.(e.site_v)}>{e.ref_v}{e.site_v}</button></td>
						{#each COLUMNS.slice(2) as c (c.key)}
							{#if c.sci}
								{@const s = sci(e[c.key] as number)}
								<td class="num">{s.m}{#if s.e != null}&nbsp;×&nbsp;10<sup>{s.e}</sup>{/if}</td>
							{:else}
								<td class="num">{fmt(e[c.key] as number, c)}</td>
							{/if}
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		min-width: 46rem;
		border-collapse: collapse;
		font-size: var(--text-md);
		line-height: var(--leading-normal);
	}
	caption {
		caption-side: top;
		text-align: left;
		max-width: var(--measure);
		margin: 0 0 var(--space-3);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	caption b {
		color: var(--text);
		font-weight: 700;
	}
	caption code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	thead tr {
		border-top: 1px solid var(--text);
		border-bottom: 1px solid var(--text);
	}
	tbody tr {
		border-bottom: 1px solid var(--hair);
	}
	tbody tr:last-child {
		border-bottom: 1px solid var(--text);
	}
	th,
	td {
		padding: 0.4rem 0.75rem 0.4rem 0;
		text-align: left;
		vertical-align: baseline;
	}
	th {
		white-space: nowrap;
		font-weight: 700;
		color: var(--text);
	}
	th.num,
	td.num {
		text-align: right;
	}
	th:last-child,
	td:last-child {
		padding-right: 0;
	}
	.sort {
		all: unset;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--text);
	}
	.sort:hover,
	.sort--on {
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.sort:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.arrow {
		margin-left: 0.3em;
		font-size: 0.6em;
		color: var(--text-muted);
		vertical-align: 0.15em;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	sup {
		font-size: 0.75em;
		line-height: 0;
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--brand);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.link:hover {
		text-decoration-thickness: 2px;
	}
	.link:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.empty {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
</style>
