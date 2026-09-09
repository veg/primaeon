<!--
	WaveModes.svelte — Panel A: the four collective fPCA dynamic wave modes W_1..W_4(t).

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §4/§5: these modes are our substitute for Nextstrain's
	named-variant frequency stream — the epidemic-turnover narrative — because this data has no
	Pango annotation (§4.1). The panel draws the four modes over calendar time with their percent
	variance; the caption states the canonical wave reading AND that these are data-driven modes,
	not lineage frequencies. Observable Plot, tokens from theme.ts, same render-from-effect pattern
	as RankedSitesPlot (no await inside the effect).
-->
<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { onMount } from 'svelte';
	import type { TemporalWaves } from '$lib/temporal/types';
	import { onSchemeChange, token } from '../theme';

	interface Props {
		waves: TemporalWaves;
		variancePct: number[];
	}
	let { waves, variancePct }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(760);

	// One long/tidy row set: {t, mode, value}. Modes labelled with their variance %.
	const modeLabel = (k: number) => `W${k + 1} — ${variancePct[k]?.toFixed(1) ?? '?'}%`;
	const data = $derived.by(() => {
		const rows: { t: number; mode: string; value: number }[] = [];
		for (let k = 0; k < waves.W.length; k++) {
			const series = waves.W[k];
			for (let i = 0; i < waves.t.length; i++) {
				const v = series[i];
				if (v === null) continue;
				rows.push({ t: waves.t[i], mode: modeLabel(k), value: v });
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
				marginLeft: 48,
				marginBottom: 34,
				style: { fontFamily: token('--font-text', container), color: tick },
				x: { label: 'Collection year', tickFormat: 'd', grid: false },
				y: { label: 'Wave amplitude', grid: true },
				color: { legend: true, scheme: 'Dark2' },
				marks: [
					Plot.ruleY([0], { stroke: axis, strokeWidth: 1 }),
					Plot.line(data, { x: 't', y: 'value', stroke: 'mode', strokeWidth: 1.5 })
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

<div class="wave" bind:this={container}></div>

<style>
	.wave {
		width: 100%;
	}
</style>
