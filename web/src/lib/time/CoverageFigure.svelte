<!--
	CoverageFigure.svelte — one tick per dated sequence on a single time axis.

	WHY THIS FILE EXISTS. The date table answers "what did you read"; this answers "where are they",
	which is a different question and the one that shows a reader at a glance that their 2009
	epidemic sample is really four clusters, or that a third of the span carries two sequences.

	WHY IT IS A NEW FIGURE KIND. web/DESIGN.md §3 specifies the Manhattan, ranked, network, DMS,
	sector and phenotype plots; a one-dimensional sampling timeline is none of them, so the treatment
	is recorded in DESIGN.md §8: a 1 px `--plot-axis` rule spanning min to max, one 6 px
	`--text-muted` tick per sequence, OPEN ticks in `--plot-uncalled` where the date carries an
	imputed component, 12 px `--plot-tick` labels at the two ends and at year boundaries, no frame,
	no grid, no legend and NO COLOUR — this page has no called sites, so it has no purple.

	INLINE SVG, NOT CANVAS. A few hundred ticks is a few hundred DOM nodes, the marks stay
	selectable and the figure needs no redraw on a theme change (every stroke reads a token).
-->
<script lang="ts">
	import type { ReviewRow } from './dateReview';
	import type { TimeUnits } from './types';

	interface Props {
		rows: ReviewRow[];
		units: TimeUnits;
		span: { min: number; max: number; span: number } | null;
	}
	let { rows, units, span }: Props = $props();

	const W = 900;
	const H = 84;
	const PAD = 24;

	const dated = $derived(rows.filter((r) => r.value != null && Number.isFinite(r.value)));
	const imputed = $derived(dated.filter((r) => r.imputed).length);

	const scale = $derived.by(() => {
		if (!span || !(span.span > 0)) return null;
		return (v: number) => PAD + ((v - span.min) / span.span) * (W - 2 * PAD);
	});

	/** Whole-unit boundaries inside the span, thinned so labels never overprint. */
	const ticks = $derived.by(() => {
		if (!span || !(span.span > 0)) return [] as number[];
		const step = Math.max(1, Math.ceil(span.span / 8));
		const out: number[] = [];
		for (let v = Math.ceil(span.min); v <= span.max; v += step) out.push(v);
		return out;
	});

	const unitWord = $derived(units === 'years' ? 'years' : units === 'generations' ? 'generations' : units === 'days' ? 'days' : 'time units');
	const label = (v: number) => (units === 'years' ? String(Math.round(v)) : v.toLocaleString('en-US'));
</script>

<figure>
	{#if scale}
		<svg viewBox="0 0 {W} {H}" width="100%" height={H} role="img" aria-label="Sampling dates, one tick per sequence">
			<line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} class="axis" />
			{#each ticks as t (t)}
				<line x1={scale(t)} y1={H / 2 + 10} x2={scale(t)} y2={H / 2 + 15} class="axis" />
				<text x={scale(t)} y={H / 2 + 28} class="tick" text-anchor="middle">{label(t)}</text>
			{/each}
			{#each dated as r (r.taxon)}
				<line
					x1={scale(r.value as number)}
					y1={H / 2 - 12}
					x2={scale(r.value as number)}
					y2={H / 2}
					class={r.imputed ? 'mark mark--imputed' : 'mark'}
				/>
			{/each}
		</svg>
	{:else}
		<p class="note">Every dated sequence carries the same time coordinate, so there is no axis to draw.</p>
	{/if}
	<figcaption>
		<b>Sampling dates.</b>
		One tick per dated sequence, {dated.length} of {rows.length}, over {span ? `${span.min.toFixed(2)} to ${span.max.toFixed(2)}` : 'no span'}
		({span ? span.span.toFixed(2) : '0'} {unitWord}).{#if imputed}
			{' '}Open ticks are the {imputed} date{imputed === 1 ? '' : 's'} with a month or day the parser
			invented rather than read.{/if}
		{' '}Nothing here is an estimate; this is the axis your dates actually cover.
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
	.mark {
		stroke: var(--text-muted);
		stroke-width: 1;
	}
	.mark--imputed {
		stroke: var(--plot-uncalled);
	}
	.tick {
		fill: var(--plot-tick);
		font-size: 12px;
		font-family: var(--font-text);
	}
	.note {
		margin: 0 0 var(--space-2);
		color: var(--text-muted);
		font-size: var(--text-md);
	}
</style>
