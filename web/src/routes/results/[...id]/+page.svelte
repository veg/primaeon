<!--
	+page.svelte (/results/[...id]) — redirect a Phase 1 results link to its report, on mount;
	`/results/local/` with no id has nowhere to go and says so.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';

	let { data } = $props();

	onMount(() => {
		if (data.target) void goto(data.target, { replaceState: true });
	});
</script>

<svelte:head>
	<title>Results · PrimAeon</title>
</svelte:head>

<div class="container container--narrow">
	{#if data.target}
		<p class="status">Redirecting to the report…</p>
	{:else}
	<p class="eyebrow">Results</p>
	<h1>Results moved to the report</h1>
	<p>Every analysis now lands in one report at <code>/report/</code>. Open a report from a link that carries its id, or start one from the landing page.</p>
	<p><a class="button" href="{base}/">Analyze an alignment</a></p>
	{/if}
</div>
