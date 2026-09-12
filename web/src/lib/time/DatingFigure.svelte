<!--
	DatingFigure.svelte — TN93 divergence from the root against sampling date, the line that was
	fitted through it, and where that line puts the common ancestor.

	WHY THIS FILE EXISTS. The estimate is an extrapolation: the ancestor sits sixty to a hundred and
	forty years to the LEFT of every sequence on the flagship example, and no table makes that
	visible. Drawing the interval as a bracket on the time axis, inside the same x domain as the
	data, is the one picture that says how far outside the data the answer lies — which is the whole
	reason the section quotes an interval rather than a number.

	IT DRAWS NO ARITHMETIC. Every coordinate comes from `dating.ts`'s `figureModel`, and the curve
	is the ACTIVE model's own `fitted_divergence` column sorted by time, not a re-evaluation of the
	spline basis: a second implementation of `compute_rcs_basis` on the page could disagree with the
	column the table prints, and this one cannot.

	LOOK. web/DESIGN.md §3: a `<figure>` with a numbered caption below, 1 px `--plot-axis` axes,
	12 px `--plot-tick` labels, no frame, no grid, no legend, no motion. Purple is earned twice —
	the fitted line and the flagged points — and once more for the ancestor mark, which carries the
	fact the whole section is about. DESIGN.md §8 records that this section adds those marks to the
	page's purple budget. A held-out sequence is an OPEN circle, not a colour: it is out of the fit,
	which is a different statement from being flagged, and the two must not look alike.
-->
<script lang="ts">
	import { axisWord, sci, yr, type DatingFigureModel } from './dating';
	import type { TimeUnits } from './types';

	interface Props {
		model: DatingFigureModel;
		units: TimeUnits;
		/** Named in the caption, because divergence is measured to it. */
		rootLabel: string;
		/** Drawn dashed when the curvature test preferred it; named in the caption either way. */
		splinePreferred: boolean;
		alignmentName: string | null;
	}
	let { model, units, rootLabel, splinePreferred, alignmentName }: Props = $props();

	const W = 900;
	const H = 340;
	const PAD_L = 68;
	const PAD_R = 16;
	const PAD_T = 16;
	const PAD_B = 48;

	const x = (v: number) => PAD_L + ((v - model.domain.x0) / (model.domain.x1 - model.domain.x0 || 1)) * (W - PAD_L - PAD_R);
	const y = (v: number) => H - PAD_B - ((v - model.domain.y0) / (model.domain.y1 - model.domain.y0 || 1)) * (H - PAD_T - PAD_B);

	const curvePath = $derived(model.curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' '));
	const holdouts = $derived(model.points.filter((p) => p.holdout).length);
	const flagged = $derived(model.points.filter((p) => p.outlier).length);
	const baseline = $derived(y(0));
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" width="100%" height={H} role="img" aria-label="TN93 divergence from the root against sampling date">
		<line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} class="axis" />
		<line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} class="axis" />

		<text x={PAD_L} y={H - 12} class="tick">{yr(model.domain.x0)}</text>
		<text x={W - PAD_R} y={H - 12} class="tick" text-anchor="end">{yr(model.domain.x1)}</text>
		<text x={(PAD_L + W - PAD_R) / 2} y={H - 12} class="tick" text-anchor="middle">{axisWord(units)}</text>
		<text x={PAD_L - 8} y={H - PAD_B} class="tick" text-anchor="end">0</text>
		<text x={PAD_L - 8} y={PAD_T + 10} class="tick" text-anchor="end">{sci(model.domain.y1, 2)}</text>

		{#if model.line}
			<line x1={x(model.line.x1)} y1={y(model.line.y1)} x2={x(model.line.x2)} y2={y(model.line.y2)} class="fitline" />
		{/if}
		{#if curvePath}
			<path d={curvePath} class="curve" fill="none" />
		{/if}

		{#each model.points as p (p.taxon)}
			<circle
				cx={x(p.time)}
				cy={y(p.divergence)}
				r={p.outlier ? 3.5 : 2.5}
				class="pt"
				class:pt--flag={p.outlier}
				class:pt--holdout={p.holdout && !p.outlier}
			>
				<title>{p.taxon} · {yr(p.time)} · {sci(p.divergence, 3)}</title>
			</circle>
		{/each}

		{#if model.ancestor}
			<!-- The interval as a hairline bracket on the time axis; an open left end means the lower
			     bound is not finite (Fieller's g ≥ 1) and is never drawn as if it were. -->
			<line x1={x(model.ancestor.low)} y1={baseline} x2={x(model.ancestor.high)} y2={baseline} class="bracket" />
			{#if !model.ancestor.openLow}
				<line x1={x(model.ancestor.low)} y1={baseline - 4} x2={x(model.ancestor.low)} y2={baseline + 4} class="bracket" />
			{/if}
			<line x1={x(model.ancestor.high)} y1={baseline - 4} x2={x(model.ancestor.high)} y2={baseline + 4} class="bracket" />
			<circle cx={x(model.ancestor.t)} cy={baseline} r="3.5" class="ancestor">
				<title>ancestor {yr(model.ancestor.t)}</title>
			</circle>
			<text x={x(model.ancestor.t)} y={baseline - 10} class="tick tick--mark" text-anchor="middle">{yr(model.ancestor.t)}</text>
		{/if}
	</svg>
	<figcaption>
		<b>Divergence from the root against sampling date{alignmentName ? `, ${alignmentName}` : ''}.</b>
		One point per dated sequence, {model.points.length} in all; the vertical axis is TN93 distance to
		{rootLabel}. The purple line is the centred least-squares fit and the purple mark on the time axis
		is the ancestor it implies, with its 95 % interval as the hairline bracket around
		it{#if model.ancestor?.openLow}, whose left end is open because the interval has no lower bound{/if}.
		{#if holdouts > 0}
			{holdouts}
			{holdouts === 1 ? 'open circle marks a sequence' : 'open circles mark sequences'} held out of the fit.
		{/if}
		{#if flagged > 0}
			{flagged}
			{flagged === 1 ? 'filled purple point marks a sequence' : 'filled purple points mark the sequences'} flagged at |z| ≥ 2.5.
		{/if}
		{#if splinePreferred}
			The dashed grey line is the curved clock the curvature test preferred, drawn through its own fitted
			values.
		{:else}
			No curved clock is drawn: the curvature test did not prefer one.
		{/if}
		No root is searched, no bootstrap cloud is drawn, and the curved clock carries no interval.
	</figcaption>
</figure>

<style>
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
	.tick--mark {
		fill: var(--plot-called);
		font-weight: 700;
	}
	.pt {
		fill: var(--plot-uncalled);
	}
	.pt--flag {
		fill: var(--plot-called);
	}
	.pt--holdout {
		fill: none;
		stroke: var(--plot-uncalled);
		stroke-width: 1;
	}
	.fitline {
		stroke: var(--plot-called);
		stroke-width: 1;
	}
	.curve {
		stroke: var(--plot-axis);
		stroke-width: 1;
		stroke-dasharray: 4 3;
	}
	.bracket {
		stroke: var(--plot-called);
		stroke-width: 1;
	}
	.ancestor {
		fill: var(--plot-called);
	}
	figcaption {
		max-width: var(--measure);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	figcaption :global(b) {
		color: var(--text);
		font-weight: 700;
	}
</style>
