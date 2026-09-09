<!--
	TrajectoryMap.svelte — Panel C: selection trajectories â_s(t) for the sweep sites, with the
	genotype-prevalence curves as the frequency counterpart.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §4: this is the parity with Nextstrain's "colour by
	genotype" — the frequency of a mutation over time — paired with the model's selection-intensity
	trajectory for the same site. Two facets on a shared calendar-time axis: intensity (â_s) and
	prevalence. One line per sweep site, coloured by site; sweep sites are what the prebake kept
	curves for. Observable Plot, theme tokens, render-from-effect (no await), matching
	RankedSitesPlot.
-->
<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { onMount } from 'svelte';
	import type { TemporalCurve } from '$lib/temporal/types';
	import { onSchemeChange, token } from '../theme';

	interface Props {
		curves: TemporalCurve[];
		/** 'a' = selection intensity â_s(t); 'p' = genotype prevalence. */
		field: 'a' | 'p';
	}
	let { curves, field }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(760);

	const yLabel = $derived(field === 'a' ? 'Selection intensity â(t)' : 'Genotype prevalence');
	const data = $derived.by(() => {
		const rows: { t: number; value: number; site: string }[] = [];
		for (const c of curves) {
			const series = c[field];
			for (let i = 0; i < c.t.length; i++) {
				const v = series[i];
				if (v === null || !Number.isFinite(v)) continue;
				rows.push({ t: c.t[i], value: v, site: c.mutation_label });
			}
		}
		return rows;
	});

	function render() {
		if (!container) return;
		container.innerHTML = '';
		const axis = token('--plot-axis', container);
		const tick = token('--plot-tick', container);
		container.appendChild(
			Plot.plot({
				width: Math.max(320, width),
				height: 300,
				marginLeft: 52,
				marginBottom: 34,
				style: { fontFamily: token('--font-text', container), color: tick },
				x: { label: 'Collection year', tickFormat: 'd' },
				y: { label: yLabel, grid: true },
				color: { legend: true, scheme: 'Tableau10' },
				marks: [
					Plot.ruleY([0], { stroke: axis, strokeWidth: 1 }),
					Plot.line(data, { x: 't', y: 'value', stroke: 'site', strokeWidth: 1.25 })
				]
			}) as unknown as Node
		);
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

<div class="traj" bind:this={container}></div>

<style>
	.traj {
		width: 100%;
	}
</style>
