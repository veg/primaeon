<!--
	SamplingStrip.svelte — aggregate sequences-per-quarter, the sampling-density context.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §4: Nextstrain shows sampling over time (tips per period);
	this is the DAA-safe equivalent — COUNTS per calendar quarter from the prebake's binned dates,
	never a strain or a per-sequence date. A small bar strip on the same calendar-year axis as the
	trajectories, so a reader can see which waves the sampling actually covered. Observable Plot,
	theme tokens.
-->
<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { onMount } from 'svelte';
	import type { TemporalSampling } from '$lib/temporal/types';
	import { onSchemeChange, token } from '../theme';

	interface Props {
		sampling: TemporalSampling;
	}
	let { sampling }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(760);

	function render() {
		if (!container) return;
		container.innerHTML = '';
		container.appendChild(
			Plot.plot({
				width: Math.max(320, width),
				height: 120,
				marginLeft: 52,
				marginBottom: 30,
				style: { fontFamily: token('--font-text', container), color: token('--plot-tick', container) },
				x: { label: 'Collection year', tickFormat: 'd' },
				y: { label: 'Sequences', grid: true },
				marks: [
					Plot.rectY(sampling.bins, {
						x: 't',
						y: 'n',
						interval: 0.25,
						fill: token('--plot-uncalled', container)
					}),
					Plot.ruleY([0], { stroke: token('--plot-axis', container), strokeWidth: 1 })
				]
			}) as unknown as Node
		);
	}

	$effect(() => {
		void sampling;
		void width;
		render();
	});

	onMount(() => {
		const ro = new ResizeObserver((entries) => {
			const w = Math.floor(entries[0]?.contentRect.width ?? 760);
			if (w > 0 && w !== width) width = w;
		});
		if (container) ro.observe(container);
		const off = onSchemeChange(render);
		return () => {
			ro.disconnect();
			off();
		};
	});
</script>

<div class="sampling" bind:this={container}></div>

<style>
	.sampling {
		width: 100%;
	}
</style>
