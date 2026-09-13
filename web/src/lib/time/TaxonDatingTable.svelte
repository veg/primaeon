<!--
	TaxonDatingTable.svelte — one row per sequence: its label, what the clock predicts for it, how
	far apart those are, and whether it was flagged or held out of the fit.

	WHY IT IS NOT AN OUTLIER TABLE. Measured on the flagship example, the outlier rule flags NOTHING:
	the largest |z| is 2.393 against a threshold of 2.5, and the one sequence every reader of that
	dataset looks at — the 1959 Léopoldville isolate — is a HOLDOUT, which `dating.py:3049` forbids
	flagging at all. An outliers-only table would therefore be blank on the page's own flagship
	dataset and would hide its headline result. So this is every sequence, sorted so that the flagged
	ones come first, then the ones held out, then by |z| descending.

	THE PREDICTED DATES DO NOT ALL COME FROM ONE MODEL, AND THIS TABLE SAYS SO. Under the selected
	spline, `predicted_date` is produced three ways — the root find on the curve, the curve's
	strictly linear arm below the first knot, and the ANCESTRAL straight line substituted by
	`dating.py:3026`'s bare `except` when the bracket is refused (118 / 12 / 12 rows on korber). The
	reference marks none of them; the runtime emits a `prediction_method` per row and the last column
	prints it.

	THIN BY DESIGN, like `DateReviewTable`: every decision — the ranks, the sort, the filter, the
	column text — is in `dating.ts` with a test, and this file renders what it is given.

	LOOK. web/DESIGN.md §3 "Tables" in full, and §8's two `/time` departures: rows are NOT controls
	(nothing happens on click, so no pointer cursor and no hover), and the row state is WORDS in
	their own column rather than the report's purple square. The one control is the exclusion
	checkbox, which takes `accent-color: var(--brand)`. The count line is `.table__foot`, NOT
	`.table .count`: that class is a page singleton and `e2e/time.spec.ts` asserts it with a strict
	locator in three places.
-->
<script lang="ts">
	import {
		filterTaxonRows,
		num,
		sci,
		sortTaxonRows,
		yr,
		type TaxonRowView,
		type TaxonSortKey
	} from './dating';
	import type { TimeUnits } from './types';

	interface Props {
		rows: TaxonRowView[];
		units: TimeUnits;
		/** The model whose coefficients produced `predicted_date`, named in the caption. */
		activeName: string;
		excluded: string[];
		onToggle: (taxon: string, on: boolean) => void;
		pageSize?: number;
	}
	let { rows, units, activeName, excluded, onToggle, pageSize = 25 }: Props = $props();

	let sortKey = $state<TaxonSortKey>('rank');
	let ascending = $state(true);
	let query = $state('');
	let flaggedOnly = $state(false);
	let page = $state(1);

	const filtered = $derived(sortTaxonRows(filterTaxonRows(rows, query, flaggedOnly), sortKey, ascending));
	const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
	const pageRows = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));
	const flagged = $derived(rows.filter((r) => r.is_outlier).length);
	const held = $derived(rows.filter((r) => r.is_holdout).length);
	const excludedSet = $derived(new Set(excluded));

	$effect(() => {
		void query;
		void flaggedOnly;
		page = 1;
	});
	$effect(() => {
		if (page > totalPages) page = totalPages;
	});

	const timeWord = $derived(units === 'years' ? 'years' : units === 'generations' ? 'generations' : units === 'days' ? 'days' : 'units');

	const columns: { key: TaxonSortKey; label: string; title: string; num?: boolean }[] = [
		{ key: 'rank', label: 'Order', title: 'Flagged first, then held out, then by |z| descending' },
		{ key: 'taxon', label: 'Sequence', title: 'taxon' },
		{ key: 'sampling_date', label: 'Date', title: 'sampling_date — the label you supplied', num: true },
		{ key: 'root_divergence', label: 'Divergence', title: 'root_divergence — TN93 distance to the root', num: true },
		{ key: 'fitted_divergence', label: 'Fitted', title: 'fitted_divergence — what the clock expects at that date', num: true },
		{ key: 'predicted_date', label: 'Predicted date', title: 'predicted_date — the clock inverted at this divergence', num: true },
		{ key: 'temporal_residual', label: 'Looks', title: 'temporal_residual — predicted minus label', num: true },
		{ key: 'divergence_residual', label: 'Residual', title: 'divergence_residual — divergence minus fitted', num: true },
		{ key: 'z_score', label: 'z', title: 'z_score — residual over the training residuals’ population s.d.', num: true },
		{ key: 'status', label: 'Status', title: 'is_outlier and is_holdout' }
	];

	function sortBy(key: TaxonSortKey) {
		if (sortKey === key) ascending = !ascending;
		else {
			sortKey = key;
			ascending = true;
		}
	}
</script>

<div class="table">
	<div class="table__bar">
		<input type="search" placeholder="Search sequence or status" bind:value={query} aria-label="Search dated sequences" />
		<label class="check">
			<input type="checkbox" bind:checked={flaggedOnly} />
			Flagged or held out only ({flagged + held})
		</label>
	</div>

	<div class="scroll">
		<table>
			<caption>
				<b>Every dated sequence, what the clock predicts for it, and how far that is from its label.</b>
				{rows.length} rows, {flagged} flagged and {held} held out of the fit. The column names are the
				engine's own <code>taxa_summary</code> fields — <code>sampling_date</code>,
				<code>root_divergence</code>, <code>fitted_divergence</code>, <code>predicted_date</code>,
				<code>temporal_residual</code>, <code>divergence_residual</code>, <code>z_score</code> — so a row
				here matches a row of the JSON download. <em>Looks</em> is the predicted date minus the label: a
				negative number means the sequence looks older than its date says. Predicted dates come from the
				{activeName === 'spline' ? 'spline the curvature test selected' : 'straight-line clock'}, and the
				last column says which arm of it produced each one. Flagged at |z| ≥ 2.5 on the divergence
				residual, where the scale is a plain population standard deviation of the training residuals, so
				several bad dates inflate their own denominator and mask one another; a held-out sequence is never
				flagged, whatever its residual.
			</caption>
			<thead>
				<tr>
					<th scope="col" class="pick"><span class="sr">Exclude from the fit</span></th>
					{#each columns as col, i (i)}
						<th scope="col" class:num={col.num} aria-sort={sortKey === col.key ? (ascending ? 'ascending' : 'descending') : 'none'}>
							<button type="button" class="sort" class:sort--on={sortKey === col.key} title={col.title} onclick={() => sortBy(col.key)}>
								{col.label}
								{#if sortKey === col.key}<span class="arrow">{ascending ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
					{/each}
					<th scope="col">From</th>
				</tr>
			</thead>
			<tbody>
				{#if pageRows.length === 0}
					<tr><td colspan="12" class="empty">No matching sequences.</td></tr>
				{/if}
				{#each pageRows as r (r.taxon)}
					<tr>
						<td class="pick">
							<input
								type="checkbox"
								checked={excludedSet.has(r.taxon)}
								aria-label={`Exclude ${r.taxon} from the fit`}
								onchange={(e) => onToggle(r.taxon, (e.currentTarget as HTMLInputElement).checked)}
							/>
						</td>
						<td class="mono" class:struck={excludedSet.has(r.taxon)}>{r.taxon}</td>
						<td class="num">{yr(r.sampling_date, 2)}</td>
						<td class="num">{sci(r.root_divergence)}</td>
						<td class="num">{sci(r.fitted_divergence)}</td>
						<td class="num">{yr(r.predicted_date)}</td>
						<td class="num">{num(r.temporal_residual, 2)}</td>
						<td class="num">{sci(r.divergence_residual, 2)}</td>
						<td class="num">{num(r.z_score, 2)}</td>
						<td class:warn={r.is_outlier} class:faint={r.is_holdout && !r.is_outlier}>{r.status}</td>
						<td class="faint from">{r.methodText}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="pager">
		<span class="table__foot">
			Showing {filtered.length === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)} of
			{filtered.length} sequences. <em>Looks</em> is in {timeWord}.
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
	.check input,
	.pick input {
		accent-color: var(--brand);
		margin: 0;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		min-width: 64rem;
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
	.pick {
		width: 2rem;
		padding-right: 0.5rem;
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
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.faint {
		color: var(--text-faint);
	}
	.from {
		font-size: var(--text-sm);
	}
	.warn {
		color: var(--warn);
		font-weight: 700;
	}
	.struck {
		text-decoration: line-through;
		color: var(--text-faint);
	}
	.empty {
		color: var(--text-faint);
		padding: var(--space-4) 0;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
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
