<!--
	PairTable.svelte — the co-selection edges as a sortable table with the Python key names.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "pair table". The columns are `hyphaeon epistasis`'s edge
	record verbatim (compute_branch_coselection_network: site_u, site_v, ref_u, ref_v, lrt_u,
	lrt_v, similarity, shared_taxa, p_val, fdr_q, cesi) so a reader can match a row to the JSON or
	the GraphML. `shared_branches` and `hyper_p` duplicate `shared_taxa` and `p_val`
	(PHASE2A: names left from a hypergeometric formulation; there is no branch projection) and are
	not shown twice. Default order is CESI descending, the reference's own sort.
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
	const fmt = (v: number, c: { dp?: number; sci?: boolean }) => (c.sci ? (v === 0 ? '0' : v.toExponential(2)) : c.dp != null ? v.toFixed(c.dp) : String(v));
</script>

{#if edges.length === 0}
	<p class="empty">No edges.</p>
{:else}
	<div class="scroll">
		<table>
			<thead>
				<tr>
					{#each COLUMNS as c (c.key)}
						<th scope="col" aria-sort={sortKey === c.key ? (ascending ? 'ascending' : 'descending') : 'none'}>
							<button type="button" onclick={() => sortBy(c.key)}>{c.label}{sortKey === c.key ? (ascending ? ' ▲' : ' ▼') : ''}</button>
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
							<td class="num">{fmt(e[c.key] as number, c)}</td>
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
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	table {
		font-size: var(--text-sm);
		min-width: 46rem;
	}
	th {
		white-space: nowrap;
		background: var(--bg-subtle);
		padding: 0;
	}
	th button {
		all: unset;
		display: block;
		width: 100%;
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		font-family: var(--font-mono);
		font-weight: 600;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	th button:hover {
		color: var(--text);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--link);
		text-decoration: underline;
		font-family: var(--font-mono);
	}
	.empty {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
