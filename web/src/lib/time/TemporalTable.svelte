<!--
	TemporalTable.svelte — the per-codon table of section 5: eleven columns by default, every codon
	behind a toggle, and the call column in this product's one glyph.

	WHY IT SHOWS THE CANDIDATES AND NOT EVERY CODON. A 4,384-row table of which 4,138 rows are
	constant by construction is not a table. The default is the stage-one candidate set — the codons
	that passed the sweep-energy floor and were therefore worth testing — with "All codons" and
	"Confirmed sweeps" beside it, and the foot line saying how many of how many are shown. The
	DOWNLOAD takes the opposite convention (every codon, in site order, as `hyphaeon temporal` writes
	it), and the download note says so; both are right and only one of them can be the file.

	WHY `.table__foot` AND NOT `.table .count`. `.table .count` is a page singleton whose exact text
	the e2e reads once per page (web/DESIGN.md §6), and section 1's date table already owns it here.

	THE CALL COLUMN IS DESIGN.md §3's, EXACTLY: a 0.5 em purple square then the grade in `--text` at
	400 — never purple text as well as a purple square — an em dash where nothing was called, and
	`--text-faint` words where nothing was measured. A candidate whose null never ran reads
	"not tested", never "not a sweep": the difference between a claim and its absence is the whole
	reason the runtime keeps NaN where the reference writes 1.0.

	BORDERLINE IS A FACT, NOT A HEDGE. A permutation p within three Monte-Carlo standard errors of
	the cut would land on either side of it depending on which shuffles were drawn, and this page's
	generator is not the reference's. Those rows carry the word; `temporal.ts` computes the band.
-->
<script lang="ts">
	import { num, sci } from './dating';
	import {
		energyText,
		pText,
		peakDateText,
		siteRows,
		sortRows,
		TEMPORAL_PAGE_SIZE,
		widthText,
		type TemporalRecord,
		type TemporalSiteRow,
		type TemporalSortKey
	} from './temporal';
	import type { TimeUnits } from './types';

	interface Props {
		record: TemporalRecord;
		units: TimeUnits;
		unitLabel: string;
		selected: number | null;
		onSelect: (site: number) => void;
		onDownload: () => void;
	}
	let { record, units, unitLabel, selected, onSelect, onDownload }: Props = $props();

	let which = $state<'candidates' | 'all' | 'sweeps'>('candidates');
	let everyColumn = $state(false);
	let sortKey = $state<TemporalSortKey>('default');
	let ascending = $state(true);
	let page = $state(1);

	const all = $derived(siteRows(record, which));
	const rows = $derived(sortRows(all, sortKey, ascending));
	const totalPages = $derived(Math.max(1, Math.ceil(rows.length / TEMPORAL_PAGE_SIZE)));
	const pageRows = $derived(rows.slice((Math.min(page, totalPages) - 1) * TEMPORAL_PAGE_SIZE, Math.min(page, totalPages) * TEMPORAL_PAGE_SIZE));
	const tested = $derived(record.permutations?.tested ?? false);
	const sweeps = $derived(record.confirmed_sweeps);

	/** Selecting a codon from a figure pulls it into view rather than leaving it three pages away. */
	$effect(() => {
		if (selected == null) return;
		const at = rows.findIndex((r) => r.site === selected);
		if (at >= 0) page = Math.floor(at / TEMPORAL_PAGE_SIZE) + 1;
	});

	function sortBy(key: TemporalSortKey) {
		if (sortKey === key) ascending = !ascending;
		else {
			sortKey = key;
			ascending = key === 'site' || key === 'peakDate' || key === 'pPerm' || key === 'qStatic';
		}
		page = 1;
	}

	function show(kind: 'candidates' | 'all' | 'sweeps') {
		which = kind;
		page = 1;
	}

	const columns: Array<{ key: TemporalSortKey | null; label: string; num: boolean; title: string }> = [
		{ key: 'site', label: 'Site', num: true, title: 'Codon index in the uploaded alignment' },
		{ key: null, label: 'Change', num: false, title: 'Root residue, codon number, commonest other residue' },
		{ key: null, label: 'Call', num: false, title: 'What the dates alone say' },
		{ key: null, label: 'vs. static scan', num: false, title: 'What the dates add to the ordinary scan' },
		{ key: 'peakDate', label: 'Peak', num: true, title: 'Grid point at which the velocity is largest' },
		{ key: 'fwhm', label: 'Width', num: true, title: 'Full width at half the peak height' },
		{ key: 'peakIntensity', label: 'Height', num: true, title: 'Peak velocity' },
		{ key: 'lrt', label: 'LRT', num: true, title: 'The static scan’s likelihood-ratio statistic' },
		{ key: 'qStatic', label: 'q static', num: true, title: 'Benjamini-Hochberg over the variable codons' },
		{ key: 'pPerm', label: 'p perm', num: true, title: 'Date-shuffling null' },
		{ key: 'wave1', label: 'Wave 1', num: true, title: 'Loading on the first collective mode; signed by convention' }
	];
</script>

<div class="table">
	<div class="table__bar">
		<div class="toggle-group" role="group" aria-label="Which codons">
			<button type="button" class="toggle" aria-pressed={which === 'candidates'} onclick={() => show('candidates')}>Candidates</button>
			<button type="button" class="toggle" aria-pressed={which === 'all'} onclick={() => show('all')}>All codons</button>
			<button type="button" class="toggle" aria-pressed={which === 'sweeps'} onclick={() => show('sweeps')}>Confirmed sweeps</button>
		</div>
		<button type="button" class="toggle toggle--wide" aria-pressed={everyColumn} onclick={() => (everyColumn = !everyColumn)}>
			Show every column
		</button>
	</div>

	<div class="scroll">
		<table>
			<caption>
				<b>Every candidate codon, and what the dates say about it.</b>
				{rows.length.toLocaleString('en-US')} of {record.codons_total.toLocaleString('en-US')} codons, in
				{sortKey === 'default'
					? 'the default order: confirmed sweeps first by peak date, then the rest by permutation p'
					: 'the order of the column you sorted by'}. <em>Site</em> is the codon index in the alignment
				you uploaded, not in any reference numbering. <em>Change</em> is the engine's own
				<code>mutation_label</code>: the inferred root residue, the codon number, and the commonest
				other residue among the dated sequences. <em>Peak</em>, <em>Width</em> and <em>Height</em> are
				<code>peak_date</code>, <code>fwhm_years</code> and <code>peak_intensity</code>, so a row here
				can be matched to a row of the CSV. Three things this table inherits from the reference and
				does not hide: an invariable codon still carries an LRT and a static p but its q is forced to
				exactly 1; a codon with no signal at all reports its peak as the first grid point, because the
				reference takes the argmax of a row of zeros, and this table renders that as an em dash;
				and <code>mean_intensity</code> — behind "Show every column" — is the mean of the
				<em>velocity</em>, not of the intensity, despite its name (temporal.py:786).
				{#if !tested}
					The permutation columns read “not tested”: no shuffle was drawn, so no codon here is
					confirmed or ruled out.
				{/if}
			</caption>
			<thead>
				<tr>
					{#each columns as col (col.label)}
						<th scope="col" class:num={col.num} aria-sort={col.key && sortKey === col.key ? (ascending ? 'ascending' : 'descending') : 'none'}>
							{#if col.key}
								<button type="button" class="sort" class:sort--on={sortKey === col.key} title={col.title} onclick={() => sortBy(col.key!)}>
									{col.label}{#if sortKey === col.key}<span class="arrow">{ascending ? '▲' : '▼'}</span>{/if}
								</button>
							{:else}
								{col.label}
							{/if}
						</th>
					{/each}
					{#if everyColumn}
						<th scope="col">Domain</th>
						<th scope="col" class="num">Area</th>
						<th scope="col" class="num">Mean velocity</th>
						<th scope="col" class="num">Half start</th>
						<th scope="col" class="num">Half end</th>
						<th scope="col" class="num">p static</th>
						<th scope="col" class="num">q perm</th>
						<th scope="col" class="num">R²</th>
						<th scope="col" class="num">Wave 2</th>
						<th scope="col" class="num">Wave 3</th>
						<th scope="col" class="num">Wave 4</th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#if pageRows.length === 0}
					<tr><td colspan={everyColumn ? 22 : 11} class="empty">No codon to show.</td></tr>
				{/if}
				{#each pageRows as r (r.site)}
					<tr class:row--on={selected === r.site} onclick={() => onSelect(r.site)}>
						<td class="num">{r.site}</td>
						<td class="mono">{r.label}</td>
						<td class="call" class:call--on={r.call === 'swept'} class:faint={r.call === 'not-scored' || r.call === 'not-tested'}>
							{#if r.call === 'tested'}—{:else}{r.callWord}{/if}
						</td>
						<td class:faint={r.call === 'not-scored' || r.call === 'not-tested'}>{r.crossWord}</td>
						<td class="num" class:faint={r.peakAtFirst}>{peakDateText(r, units)}</td>
						<td class="num">{widthText(r.fwhm, unitLabel)}</td>
						<td class="num">{energyText(r.peakIntensity)}</td>
						<td class="num" class:faint={!r.scored}>{r.scored ? num(r.lrt, 4) : 'not scored'}</td>
						<td class="num">{pText(r.qStatic)}</td>
						<td class="num" class:faint={!Number.isFinite(r.pPerm) || !r.isCandidate}>
							{#if !r.isCandidate}—{:else if !Number.isFinite(r.pPerm)}not tested{:else}{pText(r.pPerm)}{#if r.borderline}<span class="qual">borderline</span>{/if}{/if}
						</td>
						<td class="num">{sci(r.waves[0], 3)}</td>
						{#if everyColumn}
							<td>{r.domain}</td>
							<td class="num">{energyText(r.auc)}</td>
							<td class="num">{energyText(r.meanIntensity)}</td>
							<td class="num" class:faint={r.fwhm === 0}>{r.fwhm === 0 ? '—' : num(r.tHalfStart, 3)}</td>
							<td class="num" class:faint={r.fwhm === 0}>{r.fwhm === 0 ? '—' : num(r.tHalfEnd, 3)}</td>
							<td class="num" class:faint={!r.scored}>{r.scored ? pText(r.pStatic) : '—'}</td>
							<td class="num" class:faint={!r.isCandidate || !Number.isFinite(r.qPerm)}>{r.isCandidate ? pText(r.qPerm) : '—'}</td>
							<td class="num" class:faint={!r.isCandidate}>{r.isCandidate ? num(r.r2, 4) : '—'}</td>
							<td class="num">{sci(r.waves[1], 3)}</td>
							<td class="num">{sci(r.waves[2], 3)}</td>
							<td class="num">{sci(r.waves[3], 3)}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="pager">
		<span class="table__foot">
			Showing {rows.length === 0 ? 0 : (Math.min(page, totalPages) - 1) * TEMPORAL_PAGE_SIZE + 1}–{Math.min(
				Math.min(page, totalPages) * TEMPORAL_PAGE_SIZE,
				rows.length
			)}
			of {rows.length.toLocaleString('en-US')}
			{which === 'all' ? 'codons' : which === 'sweeps' ? 'confirmed sweeps' : 'candidates'} —
			{record.stage1_candidates.toLocaleString('en-US')} of {record.codons_total.toLocaleString('en-US')} codons passed the
			sweep-energy floor and {sweeps.toLocaleString('en-US')} of those {sweeps === 1 ? 'is a' : 'are'} confirmed
			{sweeps === 1 ? 'sweep' : 'sweeps'}.
			<button type="button" class="link" onclick={onDownload}>Sites (CSV)</button>
		</span>
		<div class="pager__buttons">
			<button type="button" class="button button--secondary" disabled={page <= 1} onclick={() => (page = 1)}>«</button>
			<button type="button" class="button button--secondary" disabled={page <= 1} onclick={() => page--}>Previous</button>
			<span class="pager__page">Page {Math.min(page, totalPages)} of {totalPages}</span>
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
	.toggle-group {
		display: inline-flex;
		border: 1px solid var(--rule);
	}
	.toggle {
		appearance: none;
		background: transparent;
		border: 0;
		border-right: 1px solid var(--rule);
		color: var(--text);
		font: inherit;
		font-size: var(--text-md);
		height: 32px;
		padding: 0 0.75rem;
		cursor: pointer;
	}
	.toggle:last-child {
		border-right: 0;
	}
	.toggle[aria-pressed='true'] {
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 0.3em;
		text-decoration-color: var(--text);
	}
	.toggle--wide {
		border: 1px solid var(--rule);
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
	}
	th {
		font-weight: 700;
		color: var(--text);
		white-space: nowrap;
	}
	th.num,
	td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	tbody tr {
		border-bottom: 1px solid var(--hair);
		cursor: pointer;
	}
	tbody tr:hover {
		background: var(--surface-2);
	}
	tbody tr:last-child {
		border-bottom: 1px solid var(--text);
	}
	.row--on {
		background: var(--surface-2);
	}
	/* web/DESIGN.md §3: the square is the glyph, the words are the grade; never both in purple. */
	.call--on::before {
		content: '';
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		background: var(--brand);
		margin-right: 0.5em;
		vertical-align: 0.05em;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.faint {
		color: var(--text-faint);
	}
	.qual {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.empty {
		color: var(--text-faint);
	}
	.sort {
		appearance: none;
		background: none;
		border: 0;
		padding: 0;
		margin: 0;
		font: inherit;
		font-weight: 700;
		color: var(--text);
		cursor: pointer;
	}
	.sort--on {
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.arrow {
		margin-left: 0.25em;
		font-size: var(--text-xs);
	}
	.pager {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.table__foot {
		font-size: var(--text-sm);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.pager__buttons {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.pager__page {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.link {
		appearance: none;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--brand);
		text-decoration: underline;
		text-underline-offset: 0.16em;
		cursor: pointer;
	}
</style>
