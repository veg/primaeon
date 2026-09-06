<!--
	SiteTable.svelte — the per-site table: sortable, searchable, 25 rows a page, captioned.

	WHY THIS FILE EXISTS. The table of axomeme3 (index.html section 7: reference state, composition
	bar, variable flag, log LRT, LRT, local z, local percentile, call; sort by any column, search,
	pagination) merged with what DM3's AxomemeVisualization added (a "called sites only" filter,
	"not scored" for invariable rows instead of zeros) and what the reference adds (p, q, and the
	attribution columns when the run was attributed). A row click opens the site tree, as in
	axomeme3. Sorting puts NaN last and is stable across pages; changing the search or the mode
	resets to page 1, because a page number is a position inside one particular list.

	Set as a journal table (DESIGN.md §3 "Tables", "The call column"): a caption above saying what
	the rows are and how the columns were computed, three black rules, hairline body rows, and in
	the Call column one glyph for "called" — the 0.5 em purple square the Manhattan track and the
	network also use — followed by the mode's own label. Sort is shown by underlining the active
	head cell. `.table .count` prints "N of M sites" exactly as before; the e2e reads it.
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
	const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(0)} %`);

	const columns: { key: keyof SiteRow; label: string; title?: string; num?: boolean }[] = $derived([
		{ key: 'site', label: 'Site', num: true },
		{ key: 'refAa', label: 'Reference', title: 'Reference codon and amino acid' },
		{ key: 'isVariable', label: 'Variable' },
		{ key: 'logLrt', label: 'log LRT', title: 'log1p of the predicted LRT', num: true },
		{ key: 'lrt', label: 'LRT', title: 'Predicted MEME-style LRT (uncalibrated)', num: true },
		{ key: 'zScore', label: 'z', title: 'Standard deviations from this alignment’s mean over variable sites', num: true },
		{ key: 'percentile', label: 'Percentile', title: 'Percentile rank among this alignment’s variable sites', num: true },
		{ key: 'p', label: 'p', title: 'MEME mixture p-value of the predicted LRT', num: true },
		{ key: 'q', label: 'q', title: 'Benjamini–Hochberg q', num: true },
		{ key: 'call', label: 'Call' }
	]);
	const sortLabel = $derived(columns.find((c) => c.key === sortKey)?.label ?? String(sortKey));
	const scored = $derived(rows.filter((r) => r.isVariable).length);

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
			placeholder="Search site, codon, residue, call, taxon"
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
			<caption>
				<b>Sites of this alignment.</b>
				One row per codon, {scored} of {rows.length} scored, sorted by {sortLabel}
				{ascending ? 'ascending' : 'descending'}. LRT is the model’s predicted MEME-style LRT, uncalibrated;
				log LRT is log1p of it; z and percentile are local to this alignment’s variable sites; p is the MEME
				mixture p of the LRT and q its Benjamini–Hochberg q; Call is the active mode’s grade. Invariable sites
				are not scored.{#if hasAttribution}{' '}Driver taxon, % signal and epoch come from the attribution run.{/if}
				{' '}Click a row to open the site tree.
			</caption>
			<thead>
				<tr>
					{#each columns as col (col.key)}
						<th
							scope="col"
							class:num={col.num}
							aria-sort={sortKey === col.key ? (ascending ? 'ascending' : 'descending') : 'none'}
						>
							<button type="button" class="sort" class:sort--on={sortKey === col.key} title={col.title} onclick={() => sortBy(col.key)}>
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
						<th scope="col" class="num" title="Share of the site’s signal the top driver explains">% signal</th>
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
						<td class="num site">{r.site}</td>
						<td><span class="mono">{r.refCodon || '---'}</span> {r.refAa || '?'}</td>
						{#if compositions}
							<td>{#if comp}<SparkBar counts={comp.aaCounts} total={comp.total} />{:else}—{/if}</td>
						{/if}
						<td>{#if r.isVariable}yes{:else}<span class="faint">no</span>{/if}</td>
						{#if r.isVariable}
							<td class="num">{fmt(r.logLrt, 4)}</td>
							<td class="num">{fmt(r.lrt, 4)}</td>
							<td class="num">{fmt(r.zScore, 3)}</td>
							<td class="num">{fmt(r.percentile, 2)}</td>
							<td class="num">{fmt(r.p, 4)}</td>
							<td class="num">{fmt(r.q, 4)}</td>
							<td class="call" class:call--on={r.tier > 0}><span class="badge badge--tier{r.tier}">{r.tier > 0 ? r.call : '—'}</span></td>
						{:else}
							<td class="num faint">—</td>
							<td class="num faint">—</td>
							<td class="num faint">—</td>
							<td class="num faint">—</td>
							<td class="num faint">—</td>
							<td class="num faint">—</td>
							<td class="call faint">not scored</td>
						{/if}
						{#if hasAttribution}
							<td class="mono">{r.topDriver ?? '—'}{#if r.topMutation}&nbsp;<span class="faint">{r.topMutation}</span>{/if}</td>
							<td class="num">{pct(r.attribution?.driving_species?.[0]?.pct_signal_explained)}</td>
							<td class="epoch">{r.epoch ?? '—'}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="pager">
		<span class="table__foot">
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
		font-size: var(--text-md);
	}
	input[type='search'] {
		flex: 1 1 16rem;
		max-width: 26rem;
		padding: 0.35rem 0.6rem;
		border: 1px solid var(--rule);
		border-radius: 0;
		background: var(--bg);
		color: var(--text);
		font-size: var(--text-md);
		-webkit-appearance: none;
		appearance: none;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--text-muted);
	}
	.check input {
		accent-color: var(--brand);
		margin: 0;
	}
	.count {
		margin-left: auto;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		min-width: 60rem;
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
		vertical-align: middle;
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
	.sort {
		all: unset;
		cursor: pointer;
		font: inherit;
		color: inherit;
		display: inline-flex;
		gap: 0.3rem;
		align-items: baseline;
	}
	.sort:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.sort--on {
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.arrow {
		font-size: 0.6em;
		color: var(--text-faint);
	}
	.row {
		cursor: pointer;
	}
	.row:hover,
	.row:focus-visible {
		background: var(--surface-2);
	}
	.row:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.row--unscored {
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.faint {
		color: var(--text-faint);
	}
	.empty {
		color: var(--text-faint);
		padding: var(--space-4) 0;
	}
	.epoch {
		font-size: var(--text-sm);
	}
	.call {
		color: var(--text);
	}
	.call--on::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--brand);
		margin-right: 0.45em;
		vertical-align: 0.05em;
	}
	.badge {
		font-weight: 400;
		white-space: nowrap;
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
		padding: 0.25rem 0.6rem;
		font-size: var(--text-sm);
	}
	.pager__page {
		padding-inline: var(--space-2);
	}
</style>
