<!--
	DateReviewTable.svelte — one row per alignment sequence: its date, where the date came from,
	which rule read it, what was invented, and how its name was matched.

	WHY THIS FILE EXISTS. This table IS the page. The three reference pillars read a date and say
	nothing about how; a dataset whose metadata names correspond to no sequence produces zero dates
	and no message at all. Every column here exists because the library reports the field and a
	reader needs it to decide whether to trust the number.

	THIN BY DESIGN. `web/` has no component-test harness, so every decision — the ranks, the sort,
	the search, the paging, the column text — lives in `dateReview.ts` with a test, and this file
	renders what it is given. Verified: nothing here computes a date.

	LOOK. web/DESIGN.md §3 "Tables", in full: 14 px, no zebra, no vertical rules, no background,
	head between two black rules, body on hairlines, last row closed by black, `<caption>` above,
	one `.table__foot` line under, the wide body scrolling inside `.scroll`. Two deliberate
	departures from the site table, each recorded in DESIGN.md §8:
	  (a) ROWS ARE NOT CONTROLS. Nothing happens on click in this phase, so there is no
	      `cursor: pointer` and no `--surface-2` hover — a hover that promises an action there is
	      not is a lie.
	  (b) NO ROW GLYPH. The 0.5 em purple square means "called" site-wide and this page has no
	      called sites, so the four row conditions are WORDS in their own columns: `--text-faint`
	      for the benign ones and `--warn` as text colour only for the two that change the answer.
	      143 orange squares down a column would be an alarm, not information.
-->
<script lang="ts">
	import {
		countSentence,
		filterReviewRows,
		formatValue,
		sortReviewRows,
		type ReviewRow,
		type RowFilter,
		type SortKey
	} from './dateReview';

	interface Props {
		rows: ReviewRow[];
		tableName: string | null;
		units: string;
		pageSize?: number;
		/** Handed back so the CSV download writes exactly what the reader is looking at. */
		onVisible?: (rows: ReviewRow[]) => void;
	}
	let { rows, tableName, units, pageSize = 25, onVisible }: Props = $props();

	let sortKey = $state<SortKey>('review');
	let ascending = $state(true);
	let query = $state('');
	let only = $state<RowFilter>('all');
	let page = $state(1);

	const filtered = $derived(sortReviewRows(filterReviewRows(rows, query, only), sortKey, ascending));
	const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
	const pageRows = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

	$effect(() => {
		void query;
		void only;
		page = 1;
	});
	$effect(() => {
		if (page > totalPages) page = totalPages;
	});
	$effect(() => {
		onVisible?.(filtered);
	});

	const columns: { key: SortKey; label: string; title: string; num?: boolean }[] = [
		{ key: 'review', label: 'Review order', title: 'Undated first, then wrongly matched, then imputed, then clean' },
		{ key: 'taxon', label: 'Sequence', title: 'The identifier the library indexes by' },
		{ key: 'value', label: 'Date', title: 'Decimal time coordinate', num: true },
		{ key: 'readsAs', label: 'Reads as', title: 'The value rendered the way a person reads it' },
		{ key: 'source', label: 'Source', title: 'Where this date came from' },
		{ key: 'rule', label: 'Rule', title: 'Which library rule read it' },
		{ key: 'raw', label: 'Read from', title: 'The exact substring or cell the rule consumed' },
		{ key: 'imputed', label: 'Imputed', title: 'What the parser invented rather than read' },
		{ key: 'match', label: 'Name match', title: 'How this sequence was matched to a metadata row' }
	];

	function sortBy(key: SortKey) {
		if (sortKey === key) ascending = !ascending;
		else {
			sortKey = key;
			ascending = true;
		}
	}
</script>

<div class="table">
	<div class="table__bar">
		<input
			type="search"
			placeholder="Search name, date, rule, source"
			bind:value={query}
			aria-label="Search sequences"
		/>
		<label class="check">
			<input type="checkbox" checked={only === 'undated'} onchange={(e) => (only = (e.currentTarget as HTMLInputElement).checked ? 'undated' : 'all')} />
			Undated only ({rows.filter((r) => r.rank === 0).length})
		</label>
		<label class="check">
			<input type="checkbox" checked={only === 'imputed'} onchange={(e) => (only = (e.currentTarget as HTMLInputElement).checked ? 'imputed' : 'all')} />
			Imputed only ({rows.filter((r) => r.imputed).length})
		</label>
		<span class="count">{countSentence(filtered.length, rows.length)}</span>
	</div>

	<div class="scroll">
		<table>
			<caption>
				<b>Every sequence in this alignment, and the date read for it.</b>
				One row per sequence, {rows.filter((r) => r.rank !== 0).length} of {rows.length} dated, in review
				order: undated first, then sequences whose name was matched by something weaker than an exact
				comparison, then dates with an imputed component, then the rest. <em>Date</em> is the decimal
				time coordinate the library returned and <em>Reads as</em> renders it on the {units} axis;
				<em>Rule</em>, <em>Read from</em> and <em>Imputed</em> are the library's own
				<code>rule</code>, <code>matched</code> and <code>imputations</code> fields, so a row here can
				be matched to a row of the JSON download.{#if tableName}
					{' '}<em>Name match</em> says how the sequence was matched to a row of {tableName}.{/if}
			</caption>
			<thead>
				<tr>
					{#each columns as col, i (i)}
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
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if pageRows.length === 0}
					<tr><td colspan="9" class="empty">No matching sequences.</td></tr>
				{/if}
				{#each pageRows as r (r.taxon)}
					<tr class:row--undated={r.rank === 0}>
						<td class="num faint">{r.index + 1}</td>
						<td class="mono">{r.taxon}</td>
						<td class="num" class:faint={r.value == null}>{formatValue(r.value)}</td>
						<td class:faint={r.readsAs === '—'}>{r.readsAs}</td>
						<td class="muted">{r.sourceText}</td>
						<td class="faint rule">{r.ruleText}</td>
						<td class="mono readfrom" title={r.raw ?? ''}>{r.matched ?? r.raw ?? '—'}</td>
						<td class:warn={r.imputedText !== '—'} class:faint={r.imputedText === '—'}>{r.imputedText}</td>
						<td
							class:warn={r.matchText !== 'exact' && r.matchText !== '—'}
							class:faint={r.matchText === '—'}>{r.matchText}</td
						>
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
		min-width: 58rem;
		border-collapse: collapse;
		font-size: var(--text-md);
	}
	caption {
		caption-side: top;
		text-align: left;
		max-width: var(--measure);
		padding: 0 0 var(--space-2);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	caption :global(b) {
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
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	/* A free-text column that can run to 60 characters: DESIGN.md §8 records the truncation, which
	   is the site's only one. The whole string stays in `title=` and in the CSV download. */
	.readfrom {
		max-width: 22ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.muted {
		color: var(--text-muted);
	}
	.faint {
		color: var(--text-faint);
	}
	.rule {
		font-size: var(--text-sm);
	}
	.warn {
		color: var(--warn);
	}
	.row--undated td:nth-child(2) {
		color: var(--text);
	}
	.empty {
		color: var(--text-faint);
		padding: var(--space-4) 0;
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
