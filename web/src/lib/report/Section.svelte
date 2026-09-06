<!--
	Section.svelte — the shell every report section renders in: a numbered heading, a run-in naming
	the CLI command it mirrors and what it is a surrogate for, and — while the payload is absent —
	one line that names the phase, or a one-line explanation when the section will not arrive.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "a section not yet present shows a compact skeleton with its
	phase name". Seven sections share the same states (lib/report/status.ts); rendering them here
	once keeps each section component about its content. The children snippet is rendered only when
	the section's payload is present (`done`, `partial`, `cancelled`); the shell decides nothing else.

	THE NUMBER IS GENERATED CONTENT (web/DESIGN.md §3). The report is a fixed sequence of analyses,
	so its sections are numbered in run order — but by a CSS counter on `h2::before`, never by
	markup: the e2e asserts `h2` text equals SECTION_TITLE[name] exactly, and generated content is
	not in textContent. The counter is reset on `.report` (ReportView.svelte).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SectionStatus } from './status';
	import { PHASE_LABEL } from './status';

	interface Props {
		id: string;
		title: string;
		/** The CLI command this section mirrors, set in monospace at the right of the heading. */
		command?: string;
		/** What the command is a surrogate for, or a short note; follows the command after a comma. */
		eyebrow?: string;
		status: SectionStatus;
		/** Shown at the right of the heading (a toggle, a download). */
		actions?: Snippet;
		children?: Snippet;
	}
	let { id, title, command, eyebrow, status, actions, children }: Props = $props();

	const showBody = $derived(status.state === 'done' || status.state === 'partial' || status.state === 'cancelled');
	const phaseLabel = $derived(status.phase ? (PHASE_LABEL[status.phase] ?? status.phase) : null);
</script>

<section class="section" {id} aria-labelledby="{id}-title" data-state={status.state}>
	<header class="section__head">
		<h2 id="{id}-title">{title}</h2>
		{#if command || eyebrow}
			<p class="eyebrow">{#if command}<code>{command}</code>{/if}{#if command && eyebrow}{', '}{/if}{eyebrow ?? ''}</p>
		{/if}
		{#if actions && showBody}
			<div class="section__actions">{@render actions()}</div>
		{/if}
	</header>

	<div class="section__body">
		{#if showBody}
			{@render children?.()}
		{:else if status.state === 'running'}
			<p class="skeleton" role="status" aria-live="polite"><span class="mark--run" aria-hidden="true"></span>Running: {phaseLabel ?? 'working'}.</p>
		{:else if status.state === 'pending'}
			<p class="skeleton" role="status"><span class="mark--wait" aria-hidden="true"></span>Waiting for the <em>{phaseLabel ?? 'previous'}</em> phase.</p>
		{:else if status.state === 'skipped'}
			<p class="note">Skipped. {status.reason}</p>
		{:else if status.state === 'interrupted'}
			<p class="note">This run was interrupted (the page was closed or reloaded) before the {phaseLabel ?? ''} phase finished. Re-run it from the disclosure at the foot of the report.</p>
		{:else if status.state === 'failed'}
			<p class="note note--danger"><strong>The run failed</strong> before this section: {status.reason ?? 'no message'}.</p>
		{:else if status.state === 'cancelled'}
			<p class="note">Cancelled before this section ran.</p>
		{:else}
			<p class="note">Not part of this run.</p>
		{/if}
	</div>
</section>

<style>
	.section {
		scroll-margin-top: var(--space-6);
		padding-left: 2.5rem;
		position: relative;
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
		font-size: var(--text-lg);
		font-weight: 700;
	}
	/* The section number: a hanging figure in the 2.5rem column at the left of the heading. */
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
		color: var(--text-muted);
		white-space: nowrap;
	}
	.section__head .eyebrow code {
		font-size: var(--text-sm);
	}
	.section__actions {
		display: flex;
		gap: var(--space-4);
		align-items: baseline;
		flex-wrap: wrap;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.section__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.skeleton {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.note {
		margin: 0;
	}
	@media (prefers-reduced-motion: no-preference) {
		.section__body > :global(*) {
			animation: fade 120ms ease-out;
		}
	}
	@media (max-width: 40em) {
		.section {
			padding-left: 2rem;
		}
	}
</style>
