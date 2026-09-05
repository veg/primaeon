<!--
	+page.svelte (/report/[...id]) — load one report and hand it to ReportView.

	WHY THIS FILE EXISTS. The route's jobs are to resolve the id to a record (lib/report/load.ts
	decides between the live job, IndexedDB, the gallery and the server), to keep a server job's
	status current over SSE until its result exists, and to say clearly when there is nothing to
	show: an unknown example, a local id not in THIS browser (reports never leave the browser), or
	an expired job. The report itself is ReportView, shared by every source.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { untrack } from 'svelte';
	import ReportView from '$lib/report/ReportView.svelte';
	import { JOB_PREFIX, ReportNotFound, loadReport, watchJob, type LoadedReport } from '$lib/report/load';

	let { data } = $props();

	let loaded = $state<LoadedReport | null>(null);
	let error = $state<{ message: string; source: string } | null>(null);
	let loading = $state(true);

	$effect(() => {
		const id = data.reportId;
		loading = true;
		loaded = null;
		error = null;
		let stopWatch: (() => void) | null = null;
		let cancelled = false;
		const fetchIt = () =>
			loadReport(id)
				.then((r) => {
					if (cancelled) return;
					loaded = r;
					if (r.source === 'job' && r.record.status.state === 'running' && !stopWatch) {
						stopWatch = watchJob(id.slice(JOB_PREFIX.length), {
							onProgress: (p) => {
								if (loaded && p) loaded.record.status = { ...loaded.record.status, phase: p.phase as never, done: p.done, total: p.total, message: p.message };
							},
							onDone: () => {
								stopWatch?.();
								stopWatch = null;
								void fetchIt();
							}
						});
					}
				})
				.catch((e: unknown) => {
					if (cancelled) return;
					error = e instanceof ReportNotFound ? { message: e.message, source: e.source } : { message: e instanceof Error ? e.message : String(e), source: 'error' };
				})
				.finally(() => {
					if (!cancelled) loading = false;
				});
		// Untracked: loadReport reads the live job's `record.status` synchronously (load.ts), and a
		// tracked read there would re-run this effect - and remount the whole report - on every
		// progress tick. The effect depends on the id alone.
		void untrack(() => fetchIt());
		return () => {
			cancelled = true;
			stopWatch?.();
		};
	});

	// A live job's state changes as it runs; mirror it so ReportView's `state` prop follows.
	const runState = $derived(loaded ? (loaded.job ? loaded.record.status.state : loaded.state) : 'done');
</script>

<svelte:head>
	<title>{loaded?.record.name ? `${loaded.record.name} · Report` : 'Report'} · HyphAeon</title>
</svelte:head>

<div class="container">
	{#if loading}
		<p class="status" aria-live="polite">Loading report…</p>
	{:else if error}
		<div class="missing" role="alert">
			<p class="eyebrow">Report</p>
			<h1>No report to show</h1>
			<p>{error.message}</p>
			{#if error.source === 'local'}
				<p class="hint">
					Reports from a browser run are stored only in the browser that ran them and never uploaded, so a
					report link opened elsewhere finds nothing. Drop the alignment on the landing page to run it here, or
					open one of the bundled examples.
				</p>
			{/if}
			<p class="actions">
				<a class="button" href="{base}/">Analyze an alignment</a>
				<a class="button button--secondary" href="{base}/report/gallery/Smc6/">Open an example</a>
			</p>
		</div>
	{:else if loaded}
		<ReportView record={loaded.record} source={loaded.source} {runState} job={loaded.job} />
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
	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
