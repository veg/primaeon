<!--
	PhaseSpace.svelte — Panel D: factor-loading phase space L_{s,1} vs L_{s,2}.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the engine guide's Panel D — each variable site placed
	by its projection onto the first two fPCA wave modes, so sites cooperating in the primary wave
	transition (upper-right) separate from anti-phase / competing ones. Coloured by classification.
	Observable Plot, theme tokens, render-from-effect.
-->
<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { onMount } from 'svelte';
	import type { TemporalSite } from '$lib/temporal/types';
	import { CLASSIFICATION_LABELS } from '$lib/temporal/types';
	import { onSchemeChange, token } from '../theme';

	interface Props {
		sites: TemporalSite[];
	}
	let { sites }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(760);

	const data = $derived.by(() =>
		sites
			.filter((s) => s.wave_loadings[0] !== null && s.wave_loadings[1] !== null)
			.map((s) => ({
				l1: s.wave_loadings[0] as number,
				l2: s.wave_loadings[1] as number,
				label: s.mutation_label,
				klass: CLASSIFICATION_LABELS[s.classification] ?? s.classification
			}))
	);

	function render() {
		if (!container) return;
		container.innerHTML = '';
		const axis = token('--plot-axis', container);
		const tick = token('--plot-tick', container);
		container.appendChild(
			Plot.plot({
				width: Math.max(320, width),
				height: 320,
				marginLeft: 52,
				marginBottom: 40,
				style: { fontFamily: token('--font-text', container), color: tick },
				x: { label: 'Wave 1 loading (L₁)', grid: true },
				y: { label: 'Wave 2 loading (L₂)', grid: true },
				color: { legend: true, scheme: 'Dark2' },
				marks: [
					Plot.ruleX([0], { stroke: axis, strokeWidth: 1 }),
					Plot.ruleY([0], { stroke: axis, strokeWidth: 1 }),
					Plot.dot(data, { x: 'l1', y: 'l2', stroke: 'klass', r: 3.5, strokeWidth: 1.25 }),
					Plot.text(data, {
						x: 'l1',
						y: 'l2',
						text: 'label',
						dy: -8,
						fontSize: 9,
						fill: tick,
						filter: (d: { klass: string }) =>
							d.klass === CLASSIFICATION_LABELS.CONFIRMED_SWEEP || d.klass === CLASSIFICATION_LABELS.RESCUED_SWEEP
					})
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

<div class="phase" bind:this={container}></div>

<style>
	.phase {
		width: 100%;
	}
</style>
