<!--
	Section.svelte — the shell every report section renders in: a heading, an eyebrow naming the
	pillar and the CLI command it mirrors, and — while the payload is absent — a compact skeleton
	that names the phase, or a one-line explanation when the section will not arrive.

	WHY THIS FILE EXISTS. PLAN.md §4.5: "a section not yet present shows a compact skeleton with its
	phase name". Seven sections share the same states (lib/report/status.ts); rendering them here
	once keeps each section component about its content. The children snippet is rendered only when
	the section's payload is present (`done`, `partial`, `cancelled`); the shell decides nothing else.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SectionStatus } from './status';
	import { PHASE_LABEL } from './status';

	interface Props {
		id: string;
		title: string;
		eyebrow?: string;
		status: SectionStatus;
		/** Shown at the right of the heading (a toggle, a download). */
		actions?: Snippet;
		children?: Snippet;
	}
	let { id, title, eyebrow, status, actions, children }: Props = $props();

	const showBody = $derived(status.state === 'done' || status.state === 'partial' || status.state === 'cancelled');
	const phaseLabel = $derived(status.phase ? (PHASE_LABEL[status.phase] ?? status.phase) : null);
</script>

<section class="section" {id} aria-labelledby="{id}-title" data-state={status.state}>
	<header class="section__head">
		<div>
			{#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
			<h2 id="{id}-title">{title}</h2>
		</div>
		{#if actions && showBody}
			<div class="section__actions">{@render actions()}</div>
		{/if}
	</header>

	{#if showBody}
		{@render children?.()}
	{:else if status.state === 'running'}
		<div class="skeleton skeleton--live" role="status" aria-live="polite">
			<span class="dot" aria-hidden="true"></span>
			<span>Running: {phaseLabel ?? 'working'}…</span>
			<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
		</div>
	{:else if status.state === 'pending'}
		<div class="skeleton" role="status">
			<span class="dot dot--idle" aria-hidden="true"></span>
			<span>Waiting for the <em>{phaseLabel ?? 'previous'}</em> phase.</span>
			<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
		</div>
	{:else if status.state === 'skipped'}
		<p class="note note--warn">Skipped. {status.reason}</p>
	{:else if status.state === 'interrupted'}
		<p class="note">This run was interrupted (the page was closed or reloaded) before the {phaseLabel ?? ''} phase finished. Re-run it from the disclosure at the foot of the report.</p>
	{:else if status.state === 'failed'}
		<p class="note note--danger">The run failed before this section: {status.reason ?? 'no message'}.</p>
	{:else if status.state === 'cancelled'}
		<p class="note">Cancelled before this section ran.</p>
	{:else}
		<p class="note">Not part of this run.</p>
	{/if}
</section>

<style>
	.section {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
		padding: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		scroll-margin-top: var(--space-6);
	}
	.section__head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.section__head h2 {
		margin: 0;
	}
	.section__head .eyebrow {
		margin-bottom: 0.2rem;
	}
	.section__actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		flex-wrap: wrap;
	}
	.skeleton {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--text-muted);
		font-size: var(--text-sm);
		padding: var(--space-3) var(--space-4);
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		background: var(--bg-subtle);
	}
	.dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--brand);
		flex: none;
		animation: pulse 1.2s ease-in-out infinite;
	}
	.dot--idle {
		background: var(--border-strong);
		animation: none;
	}
	.bars {
		margin-left: auto;
		display: flex;
		gap: 0.35rem;
	}
	.bars i {
		display: block;
		width: 3.2rem;
		height: 0.55rem;
		border-radius: 999px;
		background: var(--border);
	}
	.skeleton--live .bars i {
		animation: shimmer 1.4s ease-in-out infinite;
	}
	.skeleton--live .bars i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.skeleton--live .bars i:nth-child(3) {
		animation-delay: 0.4s;
	}
	.note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.note--warn {
		color: var(--warn);
		background: var(--warn-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
	}
	.note--danger {
		color: var(--danger);
		background: var(--danger-soft);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	@keyframes shimmer {
		0%,
		100% {
			opacity: 0.5;
		}
		50% {
			opacity: 1;
		}
	}
</style>
