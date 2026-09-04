<!--
	+page.svelte (/results/[...id]) — load one record and hand it to ResultsView.

	WHY THIS FILE EXISTS. The route's only jobs are to fetch the record (results/load.ts decides
	between IndexedDB and the gallery from the id) and to say clearly when there is none: a gallery
	name that does not exist, a local id that is not in THIS browser's store (results never leave
	the browser, so a link pasted elsewhere finds nothing), or a build without the store. The
	viewer itself is ResultsView, shared with server jobs later.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { loadRecord, RecordNotFound } from '$lib/results/load';
	import type { MemeRecord } from '$lib/results/types';
	import ResultsView from '$lib/viz/ResultsView.svelte';

	let { data } = $props();

	let record = $state<MemeRecord | null>(null);
	let error = $state<{ message: string; source: string } | null>(null);
	let loading = $state(true);

	$effect(() => {
		const id = data.recordId;
		loading = true;
		record = null;
		error = null;
		loadRecord(id)
			.then((r) => {
				record = r;
			})
			.catch((e: unknown) => {
				error =
					e instanceof RecordNotFound
						? { message: e.message, source: e.source }
						: { message: e instanceof Error ? e.message : String(e), source: 'error' };
			})
			.finally(() => {
				loading = false;
			});
	});
</script>

<svelte:head>
	<title>{record?.name ? `${record.name} · Results` : 'Results'} · HyphAeon</title>
</svelte:head>

<div class="container">
	{#if loading}
		<p class="status" aria-live="polite">Loading result…</p>
	{:else if error}
		<div class="missing" role="alert">
			<p class="eyebrow">Results</p>
			<h1>No result to show</h1>
			<p>{error.message}</p>
			{#if error.source === 'local'}
				<p class="hint">
					Results from a browser run are stored only in the browser that ran them and never uploaded, so
					a results link opened elsewhere finds nothing. Re-run the analysis here, or open one of the
					bundled examples.
				</p>
			{/if}
			<p>
				<a class="button" href="{base}/analyze/">Analyze an alignment</a>
				<a class="button button--secondary" href="{base}/gallery/">Gallery</a>
			</p>
		</div>
	{:else if record}
		<ResultsView {record} />
	{/if}
</div>

<style>
	.status {
		color: var(--text-muted);
	}
	.missing {
		max-width: var(--container-narrow);
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.missing p:last-child {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
