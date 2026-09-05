<!--
	Caveats.svelte — the caveats of one pillar, rendered from web/caveats.json.

	WHY THIS FILE EXISTS. The methods page shows each pillar's measured behaviour under its method
	text, and the report shows the same caveats beside the numbers they qualify (PLAN.md §4.5). One
	component renders them so both places agree on what a caveat looks like: a plain statement
	with its numbers, an expandable table when the source has one, the action when there is one,
	and the source line. This is documentation of measured behaviour, not a warning banner, so it
	uses the text tokens, a hairline, and no warning colour.

	Props: `pillar` selects the caveats; `set` defaults to the newest model version in the file
	(the report passes caveatsForModel(provenance.model_version) when it has one); `heading`
	prints a small heading above the list; `compact` collapses detail and tables behind the
	headline for use inside a report section.
-->
<script lang="ts">
	import {
		caveatsFor,
		latestCaveats,
		sourceLabel,
		tableFor,
		type CaveatSet,
		type PillarKey
	} from './index';

	interface Props {
		pillar: PillarKey;
		set?: CaveatSet;
		heading?: string | null;
		compact?: boolean;
	}

	let { pillar, set = latestCaveats(), heading = null, compact = false }: Props = $props();

	const items = $derived(caveatsFor(pillar, set));
</script>

{#if items.length > 0}
	<section class="caveats" class:caveats--compact={compact} aria-label="Measured behaviour">
		{#if heading}
			<h3>{heading}</h3>
		{/if}
		<ol>
			{#each items as c (c.id)}
				{@const table = tableFor(c, set)}
				<li id="caveat-{pillar}-{c.id}">
					{#if compact}
						<details>
							<summary>{c.headline}</summary>
							<p class="detail">{c.detail}</p>
							{#if c.numbers}
								<dl class="numbers">
									{#each c.numbers as n (n.label)}
										<dt>{n.label}</dt>
										<dd>{n.value}</dd>
									{/each}
								</dl>
							{/if}
							{#if c.action}<p class="action">{c.action}</p>{/if}
							<p class="source">Source: {sourceLabel(c, set)}</p>
						</details>
					{:else}
						<p class="headline">{c.headline}</p>
						<p class="detail">{c.detail}</p>
						{#if c.numbers}
							<dl class="numbers">
								{#each c.numbers as n (n.label)}
									<dt>{n.label}</dt>
									<dd>{n.value}</dd>
								{/each}
							</dl>
						{/if}
						{#if table}
							<details class="table">
								<summary>{table.title}</summary>
								<div class="scroll">
									<table>
										<thead>
											<tr>
												{#each table.columns as col (col)}
													<th>{col}</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each table.rows as row, i (i)}
												<tr>
													{#each row as cell, j (j)}
														<td class:cell--pass={cell === 'PASSED'} class:cell--fail={cell === 'FAILED'}>{cell}</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
								{#if table.note}<p class="note">{table.note}</p>{/if}
							</details>
						{/if}
						{#if c.action}<p class="action">{c.action}</p>{/if}
						<p class="source">Source: {sourceLabel(c, set)}</p>
					{/if}
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.caveats h3 {
		font-family: var(--font-text);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0 0 var(--space-3);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-4);
	}
	li {
		border-left: 2px solid var(--border-strong);
		padding-left: var(--space-4);
	}
	.headline {
		font-weight: 600;
		margin: 0 0 var(--space-1);
	}
	.detail {
		margin: 0 0 var(--space-2);
		color: var(--text);
	}
	.numbers {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-1) var(--space-4);
		margin: 0 0 var(--space-2);
		font-size: var(--text-sm);
	}
	.numbers dt {
		color: var(--text-muted);
	}
	.numbers dd {
		margin: 0;
		font-family: var(--font-mono);
		text-align: right;
		white-space: nowrap;
	}
	.action {
		margin: 0 0 var(--space-2);
		font-size: var(--text-sm);
	}
	.action::before {
		content: 'Do: ';
		font-weight: 600;
		color: var(--accent-strong);
	}
	.source {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-faint);
	}
	details {
		margin: 0 0 var(--space-2);
	}
	summary {
		cursor: pointer;
		font-size: var(--text-sm);
		color: var(--link);
	}
	.caveats--compact summary {
		color: var(--text);
		font-weight: 600;
		font-size: var(--text-base);
	}
	.caveats--compact details > :not(summary) {
		margin-top: var(--space-2);
	}
	.scroll {
		overflow-x: auto;
		margin-top: var(--space-2);
	}
	table {
		font-size: var(--text-sm);
		min-width: 32rem;
	}
	td,
	th {
		white-space: nowrap;
	}
	td {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	td:first-child {
		font-family: var(--font-text);
		font-size: var(--text-sm);
	}
	.cell--pass {
		color: var(--ok);
	}
	.cell--fail {
		color: var(--danger);
	}
	.note {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
</style>
