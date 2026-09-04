<!--
	SiteTable.svelte — the per-site table: sortable, searchable, 25 rows a page.

	WHY THIS FILE EXISTS. The table of axomeme3 (index.html section 7: reference state, composition
	spark bar, variable flag, log LRT, LRT, local z, local percentile, call; sort by any column,
	search, pagination) merged with what DM3's AxomemeVisualization added (a "called sites only"
	filter, "not scored" for invariable rows instead of zeros) and what the reference adds
	(p, q, and the attribution columns when the run was attributed). A row click opens the site
	tree, as in axomeme3. Sorting puts NaN last and is stable across pages; changing the search or
	the mode resets to page 1, because a page number is a position inside one particular list.
-->
<script lang="ts">
	import type { SiteRow } from '$lib/results/derive';
	import { compareRows } from '$lib/results/derive';
	import type { SiteComposition } from '$lib/results/entropy';
	import SparkBar from './SparkBar.svelte';

	interface Props {
		rows: SiteRow[];
		compositions: Map<number, SiteComposition> | null;
		hasAttribution: boolean;
		onSelect?: (site: number) => void;
		pageSize?: number;
	}
	let { rows, compositions, hasAttribution, onSelect, pageSize = 25 }: Props = $props();

	let sortKey = $state<keyof SiteRow>('lrt');
	let ascending = $state(false);
	let query = $state('');
	let onlyCalled = $state(false);
	let page = $state(1);

	const called = $derived(rows.filter((r) => r.tier > 0));
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		let data = onlyCalled && called.length > 0 ? called : rows;
		if (q) {
			data = data.filter(
				(r) =>
					String(r.site).includes(q) ||
					r.refCodon.toLowerCase().includes(q) ||
					r.refAa.toLowerCase().includes(q) ||
					r.call.toLowerCase().includes(q) ||
					(r.topDriver ?? '').toLowerCase().includes(q) ||
					(r.epoch ?? '').toLowerCase().includes(q)
			);
		}
		return [...data].sort((a, b) => compareRows(a, b, sortKey, ascending) || a.site - b.site);
	});
	const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
	const pageRows = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

	$effect(() => {
		void query;
		void onlyCalled;
		page = 1;
	});
	$effect(() => {
		if (page > totalPages) page = totalPages;
	});

	function sortBy(key: keyof SiteRow) {
		if (sortKey === key) ascending = !ascending;
		else {
			sortKey = key;
			ascending = key === 'site' || key === 'p' || key === 'q';
		}
	}

	const fmt = (v: number, dp: number) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
	const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(0)}%`);

	const columns: { key: keyof SiteRow; label: string; title?: string }[] = $derived([
		{ key: 'site', label: 'Site' },
		{ key: 'refAa', label: 'Reference', title: 'Reference amino acid [codon]' },
		{ key: 'isVariable', label: 'Variable' },
		{ key: 'logLrt', label: 'log LRT', title: 'log1p of the predicted LRT' },
		{ key: 'lrt', label: 'LRT', title: 'Predicted MEME-style LRT (uncalibrated)' },
		{ key: 'zScore', label: 'Local z', title: 'Standard deviations from this alignment’s mean over variable sites' },
		{ key: 'percentile', label: 'Local %ile', title: 'Percentile rank among this alignment’s variable sites' },
		{ key: 'p', label: 'p', title: 'MEME mixture p-value of the predicted LRT' },
		{ key: 'q', label: 'q', title: 'Benjamini–Hochberg q' },
		{ key: 'call', label: 'Call' }
	]);

	function rowKey(e: KeyboardEvent, site: number) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect?.(site);
		}
	}
</script>

<div class="table">
	<div class="table__bar">
		<input
			type="search"
			placeholder="Search site, codon, residue, call, taxon…"
			bind:value={query}
			aria-label="Search sites"
		/>
		<label class="check">
			<input type="checkbox" bind:checked={onlyCalled} disabled={called.length === 0} />
			Called sites only ({called.length})
		</label>
		<span class="count">{filtered.length} of {rows.length} sites</span>
	</div>

	<div class="scroll">
		<table>
			<thead>
				<tr>
					{#each columns as col (col.key)}
						<th
							scope="col"
							aria-sort={sortKey === col.key ? (ascending ? 'ascending' : 'descending') : 'none'}
						>
							<button type="button" class="sort" title={col.title} onclick={() => sortBy(col.key)}>
								{col.label}
								{#if sortKey === col.key}<span class="arrow">{ascending ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						{#if col.key === 'refAa' && compositions}
							<th scope="col" title="Amino-acid composition across the taxa the model saw">Composition</th>
						{/if}
					{/each}
					{#if hasAttribution}
						<th scope="col">Driver taxon</th>
						<th scope="col" title="Share of the site’s signal the top driver explains">% signal</th>
						<th scope="col">Epoch</th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#if pageRows.length === 0}
					<tr><td colspan="14" class="empty">No matching sites.</td></tr>
				{/if}
				{#each pageRows as r (r.site)}
					{@const comp = compositions?.get(r.site)}
					<tr
						class="row"
						class:row--unscored={!r.isVariable}
						tabindex="0"
						title="Open the site tree for site {r.site}"
						onclick={() => onSelect?.(r.site)}
						onkeydown={(e) => rowKey(e, r.site)}
					>
						<td class="mono site">{r.site}</td>
						<td class="mono">{r.refAa || '?'} <span class="codon">[{r.refCodon || '---'}]</span></td>
						{#if compositions}
							<td>{#if comp}<SparkBar counts={comp.aaCounts} total={comp.total} />{:else}–{/if}</td>
						{/if}
						<td>{#if r.isVariable}<span class="yes">✓</span>{:else}<span class="no">–</span>{/if}</td>
						{#if r.isVariable}
							<td class="num">{fmt(r.logLrt, 4)}</td>
							<td class="num strong">{fmt(r.lrt, 4)}</td>
							<td class="num">{fmt(r.zScore, 3)}</td>
							<td class="num">{fmt(r.percentile, 2)}%</td>
							<td class="num">{fmt(r.p, 4)}</td>
							<td class="num">{fmt(r.q, 4)}</td>
							<td><span class="badge badge--tier{r.tier}">{r.call}</span></td>
						{:else}
							<td colspan="7" class="unscored">not scored — invariable site</td>
						{/if}
						{#if hasAttribution}
							<td class="mono">{r.topDriver ?? '—'}{#if r.topMutation}&nbsp;<span class="codon">{r.topMutation}</span>{/if}</td>
							<td class="num">{pct(r.attribution?.driving_species?.[0]?.pct_signal_explained)}</td>
							<td class="epoch">{r.epoch ?? '—'}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="pager">
		<span>
			Showing {filtered.length === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)}
			of {filtered.length}
		</span>
		<div class="pager__buttons">
			<button type="button" class="button button--secondary" disabled={page <= 1} onclick={() => (page = 1)}>«</button>
			<button type="button" class="button button--secondary" disabled={page <= 1} onclick={() => page--}>Previous</button>
			<span class="pager__page">Page {page} of {totalPages}</span>
			<button type="button" class="button button--secondary" disabled={page >= totalPages} onclick={() => page++}>Next</button>
			<button type="button" class="button button--secondary" disabled={page >= totalPages} onclick={() => (page = totalPages)}>»</button>
		</div>
	</div>
</div>

<style>
	.table {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.table__bar {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	input[type='search'] {
		flex: 1 1 16rem;
		max-width: 26rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.count {
		margin-left: auto;
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
	.scroll {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	table {
		font-size: var(--text-sm);
		min-width: 60rem;
	}
	th {
		white-space: nowrap;
		background: var(--bg-subtle);
		position: sticky;
		top: 0;
	}
	.sort {
		all: unset;
		cursor: pointer;
		font: inherit;
		color: inherit;
		display: inline-flex;
		gap: 0.3rem;
		align-items: center;
	}
	.sort:hover {
		color: var(--text);
	}
	.arrow {
		font-size: 0.65em;
	}
	.row {
		cursor: pointer;
	}
	.row:hover,
	.row:focus-visible {
		background: var(--brand-soft);
	}
	.row--unscored {
		color: var(--text-muted);
	}
	td {
		padding-block: 0.4rem;
		vertical-align: middle;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.site {
		font-weight: 600;
		color: var(--brand);
	}
	.codon {
		color: var(--text-faint);
		font-size: var(--text-xs);
	}
	.num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.strong {
		font-weight: 600;
	}
	.yes {
		color: var(--ok);
	}
	.no {
		color: var(--text-faint);
	}
	.unscored {
		color: var(--text-faint);
		font-style: italic;
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: var(--space-5);
	}
	.epoch {
		font-size: var(--text-xs);
	}
	.badge {
		border-radius: 999px;
		padding: 0.05rem 0.55rem;
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
		background: var(--bg-subtle);
		color: var(--text-muted);
	}
	.badge--tier1 {
		background: var(--danger-soft);
		color: var(--tier-strong);
	}
	.badge--tier2 {
		background: var(--accent-soft);
		color: var(--accent-strong);
	}
	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.pager__buttons {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.pager__buttons .button {
		padding: 0.3rem 0.7rem;
	}
	.pager__page {
		padding-inline: var(--space-2);
	}
</style>
