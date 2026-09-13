<!--
	TrajectoryFigure.svelte — Figure 4: one smoothed selection trajectory per candidate codon, over
	the sampling window, with the confirmed sweeps drawn over the rest.

	WHY THIS FILE EXISTS. It is the reference's own panel of per-site curves in this product's idiom.
	Two things about it are easy to misread and are therefore stated in the caption rather than left
	to a legend (web/DESIGN.md §3 forbids the legend): the y axis is NOT a frequency — it is the
	attention-weighted fraction of sequences carrying a non-root residue, so it does not reach 1 and
	is not a count of sequences — and the codons that are not drawn are not drawn AT ZERO, they are
	absent, because an invariable codon has nothing to track and a flat one never passed the floor.

	INLINE SVG, TWO COLOURS, ONE CAP. A few hundred one-pixel polylines is a few hundred DOM nodes
	that stay selectable and need no redraw on a theme change. Past that a figure of overlapping grey
	lines stops being read as trajectories, so `trajectoryFigure` caps the uncalled ones (never the
	sweeps) and the caption says how many of how many are drawn whenever the cap bites.

	THE RUG IS WHERE THE DATA ACTUALLY ARE. Every tick under the axis is one dated sequence. A curve
	between two ticks is the Gaussian kernel, not an observation, and the caption says so, because
	the single most confident misreading of a smoothed trajectory is to take the smooth part for data.
-->
<script lang="ts">
	import { readsAs } from './dateReview';
	import type { TrajectoryFigureModel } from './temporal';
	import type { TimeUnits } from './types';

	interface Props {
		model: TrajectoryFigureModel;
		units: TimeUnits;
		unitLabel: string;
		bandwidth: number;
		invariable: number;
		codons: number;
		flat: number;
		selected: number | null;
		onSelect: (site: number) => void;
	}
	let { model, units, unitLabel, bandwidth, invariable, codons, flat, selected, onSelect }: Props = $props();

	const W = 900;
	const H = 300;
	const PAD_L = 62;
	const PAD_R = 14;
	const PAD_T = 12;
	const PAD_B = 40;

	const span = $derived(model.tMax - model.tMin || 1);
	const x = (v: number) => PAD_L + ((v - model.tMin) / span) * (W - PAD_L - PAD_R);
	const y = (v: number) => H - PAD_B - (v / model.yMax) * (H - PAD_T - PAD_B);
	const path = (values: number[]) => values.map((v, i) => `${x(model.time[i]).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

	/** Whole-unit boundaries inside the span, thinned so labels never overprint. */
	const ticks = $derived.by(() => {
		const step = Math.max(1, Math.ceil(span / 7));
		const out: number[] = [];
		for (let v = Math.ceil(model.tMin); v <= model.tMax; v += step) out.push(v);
		return out.length >= 2 ? out : [model.tMin, model.tMax];
	});
	const tickLabel = (v: number) => (units === 'years' ? String(Math.round(v)) : v.toLocaleString('en-US'));
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Selection trajectories by codon over the sampling window">
		<line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} class="axis" />
		<line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} class="axis" />
		<text x={PAD_L - 8} y={PAD_T + 4} class="tick" text-anchor="end">{model.yMax.toExponential(1)}</text>
		<text x={PAD_L - 8} y={H - PAD_B} class="tick" text-anchor="end">0</text>
		{#each ticks as t (t)}
			<line x1={x(t)} y1={H - PAD_B} x2={x(t)} y2={H - PAD_B + 5} class="axis" />
			<text x={x(t)} y={H - PAD_B + 20} class="tick" text-anchor="middle">{tickLabel(t)}</text>
		{/each}

		<!-- The rug: one tick per dated sequence, where the data actually are. -->
		{#each model.samples as s, i (i)}
			<line x1={x(s)} y1={H - PAD_B + 6} x2={x(s)} y2={H - PAD_B + 12} class="rug" />
		{/each}

		{#each model.background as line (line.site)}
			<polyline
				points={path(line.values)}
				class="line"
				class:line--on={selected === line.site}
				role="button"
				tabindex="-1"
				aria-label="Codon {line.label}"
				onclick={() => onSelect(line.site)}
				onkeydown={(e) => e.key === 'Enter' && onSelect(line.site)}
			>
				<title>{line.label}</title>
			</polyline>
		{/each}
		{#each model.called as line (line.site)}
			<polyline
				points={path(line.values)}
				class="line line--called"
				class:line--on={selected === line.site}
				role="button"
				tabindex="-1"
				aria-label="Codon {line.label}, confirmed sweep"
				onclick={() => onSelect(line.site)}
				onkeydown={(e) => e.key === 'Enter' && onSelect(line.site)}
			>
				<title>{line.label} — confirmed sweep</title>
			</polyline>
		{/each}
		<text x={PAD_L} y={H - 4} class="tick">{units === 'years' ? 'sampling date' : `sampling ${unitLabel}`}</text>
		<text x={14} y={PAD_T + 10} class="tick">attention-weighted fraction</text>
	</svg>
	<figcaption>
		<b>Selection trajectories.</b>
		Each line is one codon's root-anchored attention — the attention-weighted fraction of sequences
		carrying a residue other than the inferred root's — smoothed along the sampling dates by a
		Gaussian Nadaraya–Watson kernel of bandwidth {bandwidth.toPrecision(3)} {unitLabel}.
		<strong>The y axis is not a frequency</strong>: it is weighted by attention and normalised over sequences, so
		it is not a count and does not reach 1.
		{#if model.called_is_final}
			{model.called.length} of {model.candidates.toLocaleString('en-US')} candidate codons {model.called.length === 1
				? 'is a confirmed sweep and is'
				: 'are confirmed sweeps and are'} drawn in purple over the rest.
		{:else}
			None of the {model.candidates.toLocaleString('en-US')} candidates is drawn in purple: nothing has been
			called, because {model.uncalled_reason}. The curves themselves are final.
		{/if}{#if model.capped}
			{' '}Only the {model.background.length} strongest of the {model.candidates - model.called.length} uncalled
			candidates are drawn, by peak intensity; every confirmed sweep is drawn.{/if}
		The {invariable.toLocaleString('en-US')} invariable and {flat.toLocaleString('en-US')} flat codons of
		{codons.toLocaleString('en-US')} are <strong>not drawn at all</strong>, rather than drawn at zero. The ticks
		under the axis are the {model.samples.length} sampling dates themselves: a curve between two ticks is
		the kernel, not an observation. Click a line to select its row in the table below; the earliest and
		latest dates are {readsAs(model.tMin, units)} and {readsAs(model.tMax, units)}.
	</figcaption>
</figure>

<style>
	/**
	 * `app.css`'s `.numbered figcaption b::before` increments the FIGURE COUNTER, so a figcaption may
	 * hold exactly ONE `<b>` — its name — and every other emphasis inside it is a `<strong>`. Measured
	 * the hard way: three inline `<b>`s in one caption moved every figure number after it.
	 */
	figcaption strong {
		color: var(--text);
		font-weight: 700;
	}
	svg {
		display: block;
		max-width: 100%;
	}
	.axis {
		stroke: var(--plot-axis);
		stroke-width: 1;
	}
	.tick {
		fill: var(--plot-tick);
		font-size: 12px;
		font-family: var(--font-text);
	}
	.rug {
		stroke: var(--plot-threshold);
		stroke-width: 1;
	}
	.line {
		fill: none;
		stroke: var(--plot-uncalled);
		stroke-width: 1;
		cursor: pointer;
	}
	.line--called {
		stroke: var(--plot-called);
		stroke-width: 1.5;
	}
	.line--on {
		stroke: var(--text);
		stroke-width: 2;
	}
</style>
