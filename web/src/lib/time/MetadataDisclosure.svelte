<!--
	MetadataDisclosure.svelte — the six controls that change what the table says: a metadata file,
	the two columns, the header fallback, a custom pattern, the archival-1959 rule and the time unit.

	WHY THIS FILE EXISTS, AND WHY IT IS A DISCLOSURE AND NOT A MODAL. Every control here re-derives
	the whole table synchronously, in memory, on the main thread — parsing is a handful of regular
	expressions per name, microseconds at 143 sequences and under a frame at 5,000 — so the reader
	changes a column and WATCHES THE TABLE CHANGE. A modal would hide the thing the control acts on,
	which is the one thing this page is for. (Measured: the whole ingest over the 143-name
	`korber_env_gp160` headers runs in well under a millisecond; revisit above 50,000 sequences.)

	THE METADATA FILE IS A PLAIN FILE INPUT, NOT A SECOND DASHED RECTANGLE (DESIGN.md §8): two drop
	targets on one page compete for the same "drop here" meaning.

	EVERY CONTROL STATES ITS DIVERGENCE FROM THE REFERENCE WHERE IT HAS ONE. The header fallback says
	that the command line would leave those sequences undated (`temporal.py:323` guards it with
	`len(dates) == 0`); the 1959 checkbox names the sequences it would claim and what they would
	become, so the rule is offered and never applied invisibly; and the two column selects show the
	guess's provenance, because a wrong guess there dates a whole dataset from a column of country
	codes.
-->
<script lang="ts">
	import type { TimeUnits } from './types';
	import { TIME_UNIT_OPTIONS } from './types';

	interface Props {
		metadataName: string | null;
		columns: string[];
		idColumn: string | null;
		idColumnSource: string | null;
		dateColumn: string | null;
		dateColumnSource: string | null;
		delimiterLabel: string | null;
		units: TimeUnits;
		unitsInferred: boolean;
		unitsEvidence: string | null;
		headerFallback: boolean;
		headerFallbackCount: number;
		archival1959: boolean;
		archival1959Candidates: string[];
		customPattern: string;
		patternError: string | null;
		patternMatches: number | null;
		total: number;
		onMetadataFile: (files: FileList | null) => void;
		onClearMetadata: () => void;
		onChange: (patch: {
			idColumn?: string | null;
			dateColumn?: string | null;
			units?: TimeUnits;
			headerFallback?: boolean;
			archival1959?: boolean;
			customPattern?: string;
		}) => void;
	}
	let {
		metadataName,
		columns,
		idColumn,
		idColumnSource,
		dateColumn,
		dateColumnSource,
		delimiterLabel,
		units,
		unitsInferred,
		unitsEvidence,
		headerFallback,
		headerFallbackCount,
		archival1959,
		archival1959Candidates,
		customPattern,
		patternError,
		patternMatches,
		total,
		onMetadataFile,
		onClearMetadata,
		onChange
	}: Props = $props();

	const SOURCE_WHY: Record<string, string> = {
		supplied: 'you chose it',
		temporal: 'matched the temporal pillar’s candidate list',
		dating: 'matched the dating pillar’s candidate list',
		contains_date: 'the only column whose name contains “date”',
		first_column: 'no name matched, so the first column',
		second_column: 'no name matched, so the second column',
		none: 'nothing matched'
	};
	const why = (source: string | null) => (source ? (SOURCE_WHY[source] ?? source) : '');
</script>

<details class="supply">
	<summary>Add dates from a file, a column or a pattern</summary>

	<div class="field">
		<label for="metadata-file">Metadata file</label>
		<input
			id="metadata-file"
			type="file"
			accept=".csv,.tsv,.txt,.tab,.json"
			onchange={(e) => onMetadataFile((e.currentTarget as HTMLInputElement).files)}
		/>
		{#if metadataName}
			<p class="hint">
				Reading <span class="mono">{metadataName}</span>{#if delimiterLabel}, {delimiterLabel}{/if}.
				<button type="button" class="linkish" onclick={onClearMetadata}>Remove it</button>
			</p>
		{:else}
			<p class="hint">A CSV or TSV with a name column and a date column, or a Nextstrain Auspice JSON.</p>
		{/if}
	</div>

	{#if columns.length > 0}
		<div class="field">
			<label for="id-column">Identifier column</label>
			<select id="id-column" value={idColumn ?? ''} onchange={(e) => onChange({ idColumn: (e.currentTarget as HTMLSelectElement).value || null })}>
				{#each columns as c (c)}<option value={c}>{c}</option>{/each}
			</select>
			<p class="hint">{why(idColumnSource)}</p>
		</div>
		<div class="field">
			<label for="date-column">Date column</label>
			<select id="date-column" value={dateColumn ?? ''} onchange={(e) => onChange({ dateColumn: (e.currentTarget as HTMLSelectElement).value || null })}>
				{#each columns as c (c)}<option value={c}>{c}</option>{/each}
			</select>
			<p class="hint">{why(dateColumnSource)}</p>
		</div>
	{/if}

	<div class="field">
		<label class="check">
			<input type="checkbox" checked={headerFallback} onchange={(e) => onChange({ headerFallback: (e.currentTarget as HTMLInputElement).checked })} />
			Fill sequences the table missed from their own headers
		</label>
		<p class="hint">
			{#if headerFallbackCount > 0}{headerFallbackCount} of {total} sequences are dated this way right now.
			{:else}No sequence needs it at the moment.{/if}
			The command line would leave them undated and drop them, because its fallback only runs when
			the table produced no dates at all (<span class="mono">temporal.py:323</span>). Rows filled this
			way read <em>header (fallback)</em> in the Source column.
		</p>
	</div>

	<div class="field">
		<label for="pattern">Pattern for your header convention</label>
		<input
			id="pattern"
			class="mono"
			type="text"
			spellcheck="false"
			value={customPattern}
			placeholder={'_(\\d{4}-\\d{2}-\\d{2})$'}
			oninput={(e) => onChange({ customPattern: (e.currentTarget as HTMLInputElement).value })}
		/>
		{#if patternError}
			<p class="hint hint--error">{patternError}</p>
		{:else if customPattern.trim() && patternMatches != null}
			<p class="hint">matches {patternMatches} of {total} names</p>
		{:else}
			<p class="hint">
				The date is taken from the first capturing group, so the part of the name that is the date must
				be in parentheses. Tried before the built-in rules.
			</p>
		{/if}
	</div>

	<div class="field">
		<label class="check">
			<input type="checkbox" checked={archival1959} onchange={(e) => onChange({ archival1959: (e.currentTarget as HTMLInputElement).checked })} />
			Date any name containing <span class="mono">Z59</span>, <span class="mono">ZR59</span> or
			<span class="mono">1959</span> to mid-1959
		</label>
		<p class="hint">
			{#if archival1959Candidates.length > 0}
				{archival1959Candidates.length} sequence{archival1959Candidates.length === 1 ? '' : 's'} would be
				affected: <span class="mono">{archival1959Candidates.slice(0, 3).join(', ')}</span>{archival1959Candidates.length > 3
					? ` and ${archival1959Candidates.length - 3} more`
					: ''}.
			{:else}
				No sequence in this alignment matches it.
			{/if}
			<span class="mono">hyphaeon dating</span> applies this before trying any pattern; it is a hard-coded
			calibration for one archival isolate, so it is off here unless you ask for it. Rows dated this way
			read <em>archival 1959 anchor</em> in the Rule column.
		</p>
	</div>

	<fieldset class="field">
		<legend>Time unit</legend>
		{#each TIME_UNIT_OPTIONS as opt (opt.value)}
			<label class="radio">
				<input type="radio" name="time-units" value={opt.value} checked={units === opt.value} onchange={() => onChange({ units: opt.value })} />
				{opt.label}
			</label>
		{/each}
		<p class="hint">
			{#if unitsInferred}Inferred: {unitsEvidence ?? 'from the values themselves'}.{:else}Chosen by you.{/if}
			The same name parses to a different number on a different axis, so this is never inferred silently.
		</p>
	</fieldset>
</details>

<style>
	.supply {
		margin: var(--space-4) 0;
	}
	.field {
		display: grid;
		gap: var(--space-1);
		margin: var(--space-4) 0;
		max-width: 34rem;
		border: 0;
		padding: 0;
	}
	.field > label:first-child,
	legend {
		font-size: var(--text-md);
		color: var(--text-muted);
		padding: 0;
	}
	.check,
	.radio {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: var(--text-md);
		color: var(--text);
	}
	.check input,
	.radio input {
		accent-color: var(--brand);
		margin: 0;
	}
	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.hint--error {
		color: var(--warn);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	input[type='text'] {
		width: 100%;
	}
	.linkish {
		all: unset;
		cursor: pointer;
		color: var(--link);
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.linkish:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
