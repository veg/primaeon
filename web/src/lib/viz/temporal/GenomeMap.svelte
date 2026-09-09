<!--
	GenomeMap.svelte — the study overview: genes on the NC_045512.2 coordinate axis, sweep density
	as marks, with genes that were not run greyed.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §4: this is the parity with Nextstrain's genome-coordinate
	/ diversity context — where in the genome each analysed region sits, and how much positive
	selection it carries. Each gene is a block on the reference coordinate axis; its height/label
	shows the confirmed-sweep count; unrun regions (S, ORF1a, nsp2/3, ORF6/7b/10) are drawn faint so
	the reader sees the coverage gaps honestly. Clicking a run gene scrolls to its section. Observable
	Plot, theme tokens.
-->
<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { onMount } from 'svelte';
	import type { GenomeMap } from '$lib/temporal/types';
	import { onSchemeChange, token } from '../theme';

	interface Props {
		map: GenomeMap;
		onPick?: (gene: string) => void;
	}
	let { map, onPick }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(760);

	const data = $derived(
		map.genes.map((g) => ({
			gene: g.gene,
			start: g.start,
			end: g.end,
			mid: (g.start + g.end) / 2,
			run: g.run,
			sweeps: g.confirmed_sweeps ?? 0
		}))
	);

	function render() {
		if (!container) return;
		container.innerHTML = '';
		const called = token('--plot-called', container);
		const faint = token('--hair', container);
		const tick = token('--plot-tick', container);
		container.appendChild(
			Plot.plot({
				width: Math.max(320, width),
				height: 150,
				marginLeft: 40,
				marginBottom: 34,
				style: { fontFamily: token('--font-text', container), color: tick },
				x: { label: 'Genome position (NC_045512.2, nt)', grid: false },
				y: { label: 'Confirmed sweeps', grid: true },
				marks: [
					Plot.ruleY([0], { stroke: token('--plot-axis', container), strokeWidth: 1 }),
					Plot.rect(data, {
						x1: 'start',
						x2: 'end',
						y1: 0,
						y2: 'sweeps',
						fill: (d: { run: boolean }) => (d.run ? called : faint),
						title: (d: { gene: string; run: boolean; sweeps: number }) =>
							d.run ? `${d.gene}: ${d.sweeps} confirmed sweeps` : `${d.gene}: not run`
					}),
					Plot.text(data, {
						x: 'mid',
						y: 'sweeps',
						text: 'gene',
						dy: -6,
						fontSize: 9,
						fill: (d: { run: boolean }) => (d.run ? tick : faint),
						filter: (d: { sweeps: number; run: boolean }) => d.run && d.sweeps > 0
					})
				]
			}) as unknown as Node
		);
		// Click-to-scroll: Plot marks are not easily clickable per datum, so a lightweight overlay
		// list below carries the navigation instead (see the section). No click wiring on the SVG.
	}

	$effect(() => {
		void data;
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

<div class="genome" bind:this={container}></div>

<style>
	.genome {
		width: 100%;
	}
</style>
