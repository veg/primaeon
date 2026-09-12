<!--
	+page.svelte (/time) — read the dates out of a dated dataset, show what was read and how, and
	say whether the dates carry a clock signal.

	WHY THIS ROUTE EXISTS. A dated dataset fails quietly upstream, in four ways this page exists to
	make visible: metadata names are compared to sequence names with nothing but a `strip()`, so a
	table keyed on accessions matches zero rows and the reference reports that by reporting nothing;
	a table covering 80 % of the taxa leaves the rest undated, because the header fallback is guarded
	by `len(dates) == 0` (temporal.py:323); a masked or partial date has its month silently set to
	June and its day to the 15th; and the same header parses to a different number depending on a
	time unit nobody was asked about. Every one of those is a row, a count and a sentence here.

	IT IS NOT A SECTION OF THE REPORT (PLAN-TEMPORAL D23) and it is not in the primary navigation:
	`e2e/smoke.spec.ts` fixes that to Methods, Evaluate, MCP. It is reached by one sentence on the
	landing page and one on /analyze.

	IT RUNS NOTHING AND IT SAYS SO. Neither time-aware analysis is ported yet. Section 3 states that
	in the present tense rather than promising a date — web/DESIGN.md §5 forbids "coming soon" — and
	the page's one gate unlocks two downloads and a stored flag, not a run.

	EVERYTHING IS SYNCHRONOUS AND ON THE MAIN THREAD. The ingest is string work over text already in
	memory; at 143 sequences it is well under a millisecond and the reader sees the table re-sort
	under the control they just changed, which is the whole point. No worker is started, no model is
	loaded, nothing goes off-origin.

	LOOK. web/DESIGN.md: `--container` (an eight-column table needs the report's measure), three
	sections numbered by the `.numbered` CSS counter in app.css, a `<figure>` with a numbered caption
	per plot, a `<caption>` above each table, the warning treatment for what changes the answer and
	the black refusal treatment for a file that will not read. Purple appears on links and on the two
	marks in the clock figure that carry a fact, and nowhere else.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { goto, replaceState } from '$app/navigation';
	import { archival1959Candidates, compileDateRegex, ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
	import DropZone from '$lib/analyze/DropZone.svelte';
	import { digest, readText } from '$lib/analyze/inputs';
	import { setHandoff, takeHandoff } from '$lib/handoff';
	import { clockPreview } from '$lib/time/clock';
	import {
		diagnosis,
		pageState,
		readyGate,
		reviewRows,
		spanSentence,
		unmatchedMetadataLine,
		bareNumberDates,
		bareNumbersDominate,
		type DateIngestLike,
		type ReviewRow
	} from '$lib/time/dateReview';
	import { DATES_CSV_COLUMNS, datesCsv, datesJson, saveText } from '$lib/time/downloads';
	import { buildRecord, fromStored } from '$lib/time/record';
	import { alignmentHeaders, classifyDropped, isDateSource } from '$lib/time/sources';
	import type { TimeSetOptions, TimeSetRecord, TimeUnits } from '$lib/time/types';
	import DateReviewTable from '$lib/time/DateReviewTable.svelte';
	import CoverageFigure from '$lib/time/CoverageFigure.svelte';
	import ClockPreview from '$lib/time/ClockPreview.svelte';
	import MetadataDisclosure from '$lib/time/MetadataDisclosure.svelte';
	import {
		SAVE_INTERVAL_MS,
		isAvailable as storageAvailable,
		getTimeSet,
		saveTimeSet
	} from '$lib/storage/timesets';
	import type { InputDigest } from '$lib/api';

	let { data } = $props();

	// ---- inputs ----------------------------------------------------------------------------------
	let alignmentText = $state('');
	let alignmentName = $state<string | null>(null);
	let alignmentDigest = $state<InputDigest | null>(null);
	let treeText = $state<string | null>(null);
	let treeName = $state<string | null>(null);
	let metadataText = $state<string | null>(null);
	let metadataName = $state<string | null>(null);
	let metadataDigest = $state<InputDigest | null>(null);

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let storageNote = $state<string | null>(null);

	// ---- what the reader set ---------------------------------------------------------------------
	let units = $state<TimeUnits | null>(null); // null = let the layer infer and say so
	let idColumn = $state<string | null>(null);
	let dateColumn = $state<string | null>(null);
	let headerFallback = $state(true);
	let archival1959 = $state(false);
	let customPattern = $state('');
	let dropUndated = $state(false);
	// Set only by the tick below: the reader confirming that bare numbers in names really are the
	// time coordinate they chose. Cleared whenever the units change, because the claim is about them.
	let acceptBareNumbers = $state(false);

	let recordId = $state<string | null>(null);
	let visibleRows = $state<ReviewRow[]>([]);

	// ---- derived: the whole review, re-derived on every edit --------------------------------------
	const names = $derived(alignmentText ? alignmentHeaders(alignmentText) : null);
	const taxa = $derived(alignmentText ? taxaForDates(alignmentText) : []);

	const pattern = $derived(customPattern.trim() ? compileDateRegex(customPattern.trim()) : null);
	const patternError = $derived(pattern && !pattern.valid ? (pattern.error ?? 'That pattern could not be used.') : null);

	const ingest = $derived.by((): DateIngestLike | null => {
		if (!alignmentText || taxa.length === 0) return null;
		try {
			return ingestDates({
				taxa,
				headerOf: names?.headerOf ?? null,
				source: metadataText,
				sourceName: metadataName ?? undefined,
				timeUnits: units,
				strainCol: idColumn,
				dateCol: dateColumn,
				dateRegex: pattern && pattern.valid ? customPattern.trim() : null,
				archival1959,
				headerFallback
			}) as unknown as DateIngestLike;
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
			return null;
		}
	});

	const tableLoaded = $derived(Boolean(metadataText));
	const rows = $derived(ingest ? reviewRows(ingest, tableLoaded) : []);
	const gate = $derived(readyGate(ingest, dropUndated, acceptBareNumbers));
	const viewState = $derived(pageState(ingest, failure, dropUndated, acceptBareNumbers));
	const strip = $derived(ingest ? diagnosis(ingest) : null);
	const unmatched = $derived(ingest ? unmatchedMetadataLine(ingest, metadataName) : null);
	const anchors = $derived(taxa.length ? archival1959Candidates(taxa) : []);
	const preview = $derived(clockPreview({ treeText, ingest }));

	const tableInfo = $derived(
		(ingest?.table ?? null) as {
			columns?: string[];
			strain_col?: string | null;
			strain_col_source?: string | null;
			date_col?: string | null;
			date_col_source?: string | null;
			delimiter?: string;
			delimiter_source?: string;
			rows_read?: number;
			numeric_names?: number;
		} | null
	);
	const delimiterLabel = $derived.by(() => {
		if (!tableInfo?.delimiter) return null;
		const named =
			tableInfo.delimiter === '\t' ? 'tab-separated' : tableInfo.delimiter === ',' ? 'comma-separated' : `separated by “${tableInfo.delimiter}”`;
		return tableInfo.delimiter_source === 'sniffed' ? `${named} (read from the file, not its name)` : named;
	});

	const refusals = $derived(ingest ? ingest.warnings.filter((w) => w.severity === 'refuse') : []);
	const warnings = $derived(ingest ? ingest.warnings.filter((w) => w.severity !== 'refuse') : []);

	const unitsEvidence = $derived.by(() => {
		const e = ingest?.time_units_evidence as
			{ reason?: string; yearsDated?: number; nonCalendarDated?: number; column?: string | null } | undefined;
		if (!e) return null;
		if (e.reason === 'column_name' && e.column) return `the date column is named “${e.column}”`;
		if (typeof e.yearsDated === 'number' && typeof e.nonCalendarDated === 'number') {
			return `read as years, ${e.yearsDated} of ${taxa.length} dated; read as generations, ${e.nonCalendarDated}`;
		}
		return null;
	});

	const headerFallbackCount = $derived(
		ingest && tableLoaded ? ingest.rows.filter((r) => r.source === 'header').length : (ingest?.coverage.from_header ?? 0)
	);

	// ---- reading files ---------------------------------------------------------------------------
	async function acceptFiles(list: FileList | File[] | null | undefined) {
		if (!list || list.length === 0) return;
		failure = null;
		busy = true;
		try {
			for (const file of Array.from(list).slice(0, 4)) {
				const text = await readText(file);
				const kind = classifyDropped(text, file.name);
				if (kind === 'alignment') {
					alignmentText = text;
					alignmentName = file.name;
					alignmentDigest = await digest(file.name, text);
				} else if (kind === 'tree') {
					treeText = text;
					treeName = file.name;
				} else if (isDateSource(kind)) {
					metadataText = text;
					metadataName = file.name;
					metadataDigest = await digest(file.name, text);
					idColumn = null;
					dateColumn = null;
				} else if (kind === 'beast') {
					failure = `${file.name} is a BEAST XML file. The reference reads taxon dates from one; PrimAeon does not yet. Export the taxon dates as a two-column CSV, or supply the alignment with dated headers.`;
				} else {
					failure = `${file.name} is not an alignment, a Newick tree, a delimited table or a Nextstrain JSON, so nothing could be read from it.`;
				}
			}
			if (!alignmentText) {
				failure = failure ?? 'Drop an alignment (FASTA, NEXUS or PHYLIP) — the review is one row per sequence in it.';
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onMetadataFile(files: FileList | null) {
		if (!files || files.length === 0) return;
		void acceptFiles(files);
	}

	function clearMetadata() {
		metadataText = null;
		metadataName = null;
		metadataDigest = null;
		idColumn = null;
		dateColumn = null;
	}

	function applyChange(patch: {
		idColumn?: string | null;
		dateColumn?: string | null;
		units?: TimeUnits;
		headerFallback?: boolean;
		archival1959?: boolean;
		customPattern?: string;
	}) {
		if ('idColumn' in patch) idColumn = patch.idColumn ?? null;
		if ('dateColumn' in patch) dateColumn = patch.dateColumn ?? null;
		if (patch.units) units = patch.units;
		if ('headerFallback' in patch) headerFallback = patch.headerFallback!;
		if ('archival1959' in patch) archival1959 = patch.archival1959!;
		if ('customPattern' in patch) customPattern = patch.customPattern!;
	}

	// ---- the record ------------------------------------------------------------------------------
	function options(): TimeSetOptions {
		return {
			units: ingest?.time_units ?? 'years',
			unitsInferred: ingest?.time_units_source === 'inferred',
			headerFallback,
			archival1959,
			customPattern: customPattern.trim() || null,
			idColumn: tableInfo?.strain_col ?? idColumn,
			dateColumn: tableInfo?.date_col ?? dateColumn,
			delimiter: tableInfo?.delimiter ?? null,
			dropUndated,
			rootMode: 'midpoint',
			outgroup: null
		};
	}

	function currentRecord() {
		if (!ingest) return null;
		return buildRecord({
			id: recordId ?? undefined,
			inputs: {
				alignmentName,
				alignmentText,
				alignmentDigest,
				treeName,
				treeText,
				metadataName,
				metadataText,
				metadataDigest
			},
			options: options(),
			ingest,
			ready: gate.ready
		});
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		// Track what the reader can see change, then write at the store's own cadence.
		void ingest;
		void dropUndated;
		if (!ingest || !storageAvailable()) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const record = currentRecord();
			if (!record) return;
			if (!recordId) {
				recordId = record.id;
				try {
					replaceState(`${base}/time/?id=${record.id}`, {});
				} catch {
					// A prerendered shell opened without the router: the review still works, the URL
					// simply does not carry the id.
				}
			}
			// $state.snapshot: the record is assembled from runes, and IndexedDB cannot clone a Proxy.
			// This is the call site because the rune only exists in compiled Svelte files.
			saveTimeSet($state.snapshot({ ...record, id: recordId }) as TimeSetRecord).catch((err) => {
				storageNote = err instanceof Error ? err.message : String(err);
			});
		}, SAVE_INTERVAL_MS);
		return () => {
			if (saveTimer) clearTimeout(saveTimer);
		};
	});

	onMount(() => {
		const handoff = takeHandoff();
		if (handoff) {
			alignmentText = handoff.alignmentText;
			alignmentName = handoff.alignmentName;
			treeText = handoff.treeText;
			treeName = handoff.treeName;
			metadataText = handoff.metadataText ?? null;
			metadataName = handoff.metadataName ?? null;
			void (async () => {
				if (handoff.alignmentText) alignmentDigest = await digest(handoff.alignmentName ?? 'alignment', handoff.alignmentText);
			})();
			return;
		}
		const id = data.timeSetId;
		if (!id || !storageAvailable()) return;
		void (async () => {
			const stored = fromStored(await getTimeSet(id));
			if (!stored) return;
			recordId = stored.id;
			alignmentText = stored.inputs.alignmentText;
			alignmentName = stored.inputs.alignmentName;
			alignmentDigest = stored.inputs.alignmentDigest;
			treeText = stored.inputs.treeText;
			treeName = stored.inputs.treeName;
			metadataText = stored.inputs.metadataText;
			metadataName = stored.inputs.metadataName;
			metadataDigest = stored.inputs.metadataDigest;
			units = stored.options.unitsInferred ? null : stored.options.units;
			idColumn = stored.options.idColumn;
			dateColumn = stored.options.dateColumn;
			headerFallback = stored.options.headerFallback;
			archival1959 = stored.options.archival1959;
			customPattern = stored.options.customPattern ?? '';
			dropUndated = stored.options.dropUndated;
		})();
	});

	// ---- downloads and the hand-off back ---------------------------------------------------------
	function downloadCsv() {
		saveText('dates.csv', datesCsv(visibleRows.length ? visibleRows : rows), 'text/csv');
	}
	function downloadJson() {
		const record = currentRecord();
		if (record) saveText('dates.json', datesJson(record), 'application/json');
	}
	async function runSelection() {
		setHandoff({ alignmentText, alignmentName, treeText, treeName, metadataText, metadataName });
		await goto(`${base}/analyze/?autorun=1`);
	}
</script>

<svelte:head>
	<title>Dates — PrimAeon</title>
	<meta
		name="description"
		content="Review the sampling dates of a dated alignment before anything is run: which rule read each date, what was imputed, which metadata rows matched no sequence, and whether the dates carry a clock signal."
	/>
</svelte:head>

<article class="timepage numbered container">
	<header class="head">
		<h1>Dates</h1>
		<p class="meta">
			<span>{alignmentName ?? 'no alignment loaded'}</span>
			{#if treeName}<span>{treeName}</span>{/if}
			{#if metadataName}<span>{metadataName}</span>{/if}
			{#if ingest}<span>{ingest.coverage.taxa_total} sequences</span><span>{ingest.coverage.dated} dated</span
				><span>{ingest.time_units}</span>{/if}
		</p>
	</header>

	<section class="section" id="dates" aria-labelledby="dates-title">
		<header class="section__head">
			<h2 id="dates-title">Dates</h2>
			<p class="eyebrow">read by <code>@veg/hyphaeon-js</code>, the reference's own parsers</p>
		</header>

		<div class="review" data-state={viewState}>
			{#snippet dropHint()}
				FASTA, NEXUS or PHYLIP, optionally gzipped. Add a metadata CSV/TSV or a Nextstrain JSON if your
				dates are not in the headers, and a Newick tree with branch lengths if you have one. Or <u>choose files</u>.
			{/snippet}
			<DropZone
				title="Drop dated sequences here"
				hint={dropHint}
				accept=".fasta,.fa,.fna,.aln,.nex,.nexus,.phy,.phylip,.gz,.nwk,.newick,.tree,.tre,.csv,.tsv,.txt,.tab,.json"
				multiple
				{busy}
				onFiles={(files) => void acceptFiles(files)}
			/>

			{#if failure}
				<p class="notice--error" role="alert"><strong>Refused.</strong> {failure}</p>
			{/if}

			{#if ingest}
				{#each refusals as w (w.code)}
					<p class="notice--error" role="alert"><strong>Refused.</strong> {w.message}</p>
				{/each}

				{#if strip}
					<details class="strip">
						<summary><b>What we read from your files.</b> {strip.sentence}</summary>
						<table>
							<caption><b>Everything the date layer reported.</b> One row per diagnostic, in its own report order; severity is the same three-value scale the analysis report uses.</caption>
							<thead>
								<tr><th scope="col">Severity</th><th scope="col">Code</th><th scope="col">Message</th></tr>
							</thead>
							<tbody>
								{#each [...refusals, ...warnings] as w (w.code)}
									<tr>
										<td class="sev" class:sev--warn={w.severity === 'warn'}>{w.severity}</td>
										<td class="mono">{w.code}</td>
										<td>{w.message}</td>
									</tr>
								{/each}
								{#if refusals.length + warnings.length === 0}
									<tr><td colspan="3" class="faint">Nothing to report.</td></tr>
								{/if}
							</tbody>
						</table>
					</details>
				{/if}

				<MetadataDisclosure
					{metadataName}
					columns={tableInfo?.columns ?? []}
					idColumn={tableInfo?.strain_col ?? idColumn}
					idColumnSource={tableInfo?.strain_col_source ?? null}
					dateColumn={tableInfo?.date_col ?? dateColumn}
					dateColumnSource={tableInfo?.date_col_source ?? null}
					{delimiterLabel}
					units={ingest.time_units}
					unitsInferred={ingest.time_units_source === 'inferred'}
					{unitsEvidence}
					{headerFallback}
					{headerFallbackCount}
					{archival1959}
					archival1959Candidates={anchors}
					{customPattern}
					{patternError}
					patternMatches={(ingest.regex as { matched?: number } | null)?.matched ?? null}
					total={ingest.coverage.taxa_total}
					{onMetadataFile}
					onClearMetadata={clearMetadata}
					onChange={applyChange}
				/>

				<DateReviewTable rows={rows} tableName={metadataName} units={ingest.time_units} onVisible={(r) => (visibleRows = r)} />

				{#if unmatched}
					<p class="note note--warn">
						<strong>{unmatched.lead}</strong>, {unmatched.rest}
						<span class="mono">{unmatched.names.join(', ')}</span>{#if unmatched.more.length}
							<!-- The rest, behind a disclosure, because the first five are the diagnosis. -->
							<details class="more"><summary>and {unmatched.more.length} more</summary><span class="mono">{unmatched.more.join(', ')}</span></details>
						{/if}
						{#if (tableInfo?.numeric_names ?? 0) > 0}
							{tableInfo?.numeric_names} name{tableInfo?.numeric_names === 1 ? ' was' : 's were'} read as numbers
							(“12345” became “12345.0”); quote that column or export it as text.
						{/if}
					</p>
				{/if}

				<p class="gate">
					{#if gate.ready}
						These dates are ready to use: {ingest.coverage.dated} of {ingest.coverage.taxa_total} sequences
						dated, spanning {spanSentence(ingest.span, ingest.time_units)}.
					{:else}
						{#each gate.reasons as reason, i (i)}<span class="gate__reason">{reason}</span>{/each}
					{/if}
				</p>
				{#if bareNumbersDominate(ingest)}
					<label class="check">
						<input type="checkbox" bind:checked={acceptBareNumbers} />
						Those {bareNumberDates(ingest)} bare numbers really are {ingest.time_units}
					</label>
					<p class="hint">
						The rule that read them takes the first number in a name, whatever it means: an accession
						or an isolate index reads the same as a generation.
					</p>
				{/if}
				{#if ingest.coverage.undated > 0}
					<label class="check">
						<input type="checkbox" bind:checked={dropUndated} />
						Continue without the {ingest.coverage.undated} undated sequence{ingest.coverage.undated === 1 ? '' : 's'}
					</label>
					<p class="hint">
						The command line drops them silently; this page will record that it dropped them.
					</p>
				{/if}
			{:else if !failure}
				<p class="note">Nothing is loaded yet. Drop an alignment above and every sequence in it appears below, dated or not.</p>
			{/if}
		</div>
	</section>

	<section class="section" id="coverage" aria-labelledby="coverage-title">
		<header class="section__head">
			<h2 id="coverage-title">Coverage</h2>
			<p class="eyebrow">where the dates sit, and whether they carry a clock</p>
		</header>
		{#if ingest && ingest.coverage.dated > 0}
			<CoverageFigure rows={rows} units={ingest.time_units} span={ingest.span} />
			<ClockPreview preview={preview} {treeName} />
		{:else}
			<p class="note">No sequence carries a date yet, so there is nothing to place on a time axis.</p>
		{/if}
	</section>

	<section class="section" id="data" aria-labelledby="data-title">
		<header class="section__head">
			<h2 id="data-title">Data and provenance</h2>
			<p class="eyebrow">what this page did, and what it did not do</p>
		</header>

		{#if ingest}
			<dl class="facts">
				<div><dt>Alignment</dt><dd>{alignmentName ?? 'pasted'} · {ingest.coverage.taxa_total} sequences{#if alignmentDigest?.sha256}<span class="qual mono">sha256 {alignmentDigest.sha256.slice(0, 12)}…</span>{/if}</dd></div>
				<div><dt>Dates from</dt><dd>{ingest.sources_used.join(', ') || 'nothing'}</dd></div>
				<div><dt>Time unit</dt><dd>{ingest.time_units} ({ingest.time_units_source})</dd></div>
				<div><dt>Name matching</dt><dd>{ingest.match_tier ?? 'not used'}{#if ingest.match_tier && ingest.match_tier !== 'exact'}<span class="qual">weaker than an exact comparison; every row says which tier matched it</span>{/if}</dd></div>
				<div><dt>Archival 1959 rule</dt><dd>{archival1959 ? 'applied' : 'off'}{#if anchors.length}<span class="qual">{anchors.length} sequence{anchors.length === 1 ? '' : 's'} would be affected</span>{/if}</dd></div>
				<div><dt>Tree</dt><dd>{treeName ?? 'none supplied'}{#if !preview.available}<span class="qual">no clock preview: {preview.code}</span>{/if}</dd></div>
			</dl>

			<div class="downloads">
				<button type="button" class="button button--secondary" onclick={downloadCsv} disabled={!gate.ready}>Dates (CSV)</button>
				<button type="button" class="button button--secondary" onclick={downloadJson} disabled={!gate.ready}>Dates (JSON)</button>
				<button type="button" class="button button--secondary" onclick={runSelection}>Run the selection report on this alignment</button>
			</div>
			<p class="hint downloads__note">
				Both files are PrimAeon's own: the CSV carries the columns <span class="mono">{DATES_CSV_COLUMNS.join(', ')}</span>,
				one row per sequence in the order the table is showing them, and the JSON carries a
				<span class="mono">{'{sequence: date}'}</span> map beside every option that produced it. Whether
				<span class="mono">hyphaeon dating</span> accepts a dates file, and in what shape, is not something
				this build has verified, so neither file claims to be a command-line input.
			</p>
			{#if storageNote}
				<p class="note note--warn"><strong>This review was not saved.</strong> {storageNote}</p>
			{/if}
		{/if}

		<p class="note">
			This page reads dates and shows what it read. The clock-rate estimate, the ancestor date and
			the per-sequence outlier table read this same table and are not built yet;
			<span class="mono">hyphaeon dating</span> computes them today at the command line.
		</p>
	</section>
</article>

<style>
	.timepage {
		margin-bottom: var(--space-10);
	}
	.head {
		border-bottom: 1px solid var(--text);
		padding-bottom: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.head h1 {
		margin: 0 0 var(--space-1);
	}
	.meta {
		margin: 0;
		max-width: none;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.meta span + span::before {
		content: '\00b7';
		margin: 0 0.5rem;
		color: var(--text-faint);
	}
	.section {
		position: relative;
		padding-left: 2.5rem;
		margin-bottom: var(--space-10);
	}
	.section__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		border-bottom: 1px solid var(--rule);
		padding-bottom: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.section__head h2 {
		margin: 0;
	}
	.section__head h2::before {
		counter-increment: section;
		content: counter(section);
		position: absolute;
		left: 0;
		color: var(--text-muted);
		font-weight: 400;
	}
	.section__head .eyebrow {
		margin: 0 0 0 auto;
		font-size: var(--text-sm);
	}
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.strip {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.strip summary {
		max-width: var(--measure);
	}
	.strip table {
		margin-top: var(--space-3);
	}
	.sev {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.gate {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.gate__reason {
		display: block;
	}
	.check {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: var(--text-md);
	}
	.check input {
		accent-color: var(--brand);
		margin: 0;
	}
	.hint {
		margin: 0;
	}
	.more {
		display: inline;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-4);
		margin: 0 0 var(--space-5);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.facts div {
		margin: 0;
	}
	.facts dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	.qual {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.downloads__note {
		margin-bottom: var(--space-4);
	}
	.downloads {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.faint {
		color: var(--text-faint);
	}
	@media (max-width: 40em) {
		.section {
			padding-left: 2rem;
		}
	}
</style>
