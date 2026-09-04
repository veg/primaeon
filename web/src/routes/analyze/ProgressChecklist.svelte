<!--
	ProgressChecklist.svelte — the six-step run checklist, each step with its measured time.

	WHY THIS FILE EXISTS. PLAN.md §4.2: "Progress is a step checklist like axomeme3's, each step
	marked with its measured time." axomeme3/index.html:1146-1151 draws six rows (decompress,
	tree, HyPhy, distances/MDS, inference, post-processing) with a circle that fills as a step
	completes; this is that list over `StepRecord[]` from lib/analyze/run.ts, with the elapsed
	milliseconds shown once a step is done, the runtime's batch counter shown on the inference
	step, and a skipped step (branch lengths already present) drawn dimmed rather than removed,
	so the list is always the same six lines and a reader can compare runs.
-->
<script lang="ts">
	import type { StepRecord } from '$lib/api';

	let { steps, cancel }: { steps: StepRecord[]; cancel?: () => void } = $props();

	function elapsed(ms: number | null): string {
		if (ms === null) return '';
		if (ms < 1000) return `${ms} ms`;
		return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
	}

	const total = $derived(steps.reduce((n, s) => n + (s.elapsedMs ?? 0), 0));
	const running = $derived(steps.some((s) => s.status === 'active'));
</script>

<section class="checklist" aria-live="polite" aria-label="Run progress">
	<ol>
		{#each steps as step (step.id)}
			<li class="step step--{step.status}">
				<span class="mark" aria-hidden="true"></span>
				<span class="body">
					<span class="label">{step.label}</span>
					{#if step.message}
						<span class="message">{step.message}</span>
					{/if}
					{#if step.status === 'active' && step.total && step.total > 1}
						<progress max={step.total} value={step.done ?? 0}></progress>
					{/if}
				</span>
				<span class="time">
					{#if step.status === 'done'}
						{elapsed(step.elapsedMs)}
					{:else if step.status === 'skipped'}
						skipped
					{:else if step.status === 'failed'}
						failed
					{:else if step.status === 'active'}
						…
					{/if}
				</span>
			</li>
		{/each}
	</ol>
	<div class="foot">
		<span class="total">{total > 0 ? `${elapsed(total)} so far` : ''}</span>
		{#if running && cancel}
			<button type="button" class="button button--secondary" onclick={cancel}>Cancel</button>
		{/if}
	</div>
</section>

<style>
	.checklist {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		padding: var(--space-4) var(--space-5);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
	.step {
		display: grid;
		grid-template-columns: 1.25rem 1fr auto;
		gap: var(--space-3);
		align-items: start;
		font-size: var(--text-sm);
	}
	.mark {
		width: 1rem;
		height: 1rem;
		margin-top: 0.2em;
		border-radius: 50%;
		border: 2px solid var(--border-strong);
		background: transparent;
	}
	.step--active .mark {
		border-color: var(--brand);
		background: var(--brand-soft);
		animation: pulse 1.2s ease-in-out infinite;
	}
	.step--done .mark {
		border-color: var(--ok);
		background: var(--ok);
	}
	.step--failed .mark {
		border-color: var(--danger);
		background: var(--danger);
	}
	.step--skipped {
		color: var(--text-faint);
	}
	.step--pending {
		color: var(--text-muted);
	}
	.body {
		display: grid;
		gap: 0.15rem;
	}
	.label {
		font-weight: 600;
	}
	.step--pending .label,
	.step--skipped .label {
		font-weight: 400;
	}
	.message {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}
	progress {
		width: 100%;
		max-width: 20rem;
		height: 0.4rem;
		accent-color: var(--brand);
	}
	.time {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
		padding-top: 0.2em;
	}
	.foot {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.45;
		}
	}
</style>
