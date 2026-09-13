<!--
	VelocityFigure.svelte — Figure 5: a waterfall of sweep velocities, one row per confirmed sweep,
	ordered by peak date.

	WHY THIS FILE EXISTS. It is the reference's own panel A in this product's idiom, and it answers a
	different question from Figure 4: not "how high did this codon's signal get" but "WHEN did it
	move". Ordering the rows by peak date rather than by strength is what makes the figure readable
	as a chronology — and it is the same order the table's default sort uses, so the two read
	together.

	THREE THINGS THE CAPTION MUST SAY, because each is a real misreading:
	  - velocity is the POSITIVE PART of the time derivative, so a trajectory that falls contributes
	    zero and a codon can have a large trajectory and no velocity at all;
	  - the peak date is a GRID POINT, so its resolution is the span divided by (grid points − 1);
	  - candidates that were tested and not confirmed are not here — they are in Figure 4.

	WHY IT HAS A FALLBACK. When nothing is confirmed the figure draws the strongest candidates
	instead and says so. The alternative — rendering a note in place of the figure — would move every
	figure number after it between two runs of the same page, and web/DESIGN.md numbers figures by a
	CSS counter over DOM order.

	EACH ROW IS SCALED TO ITS OWN MAXIMUM. The rows differ by orders of magnitude in height (the
	energies run from 1e-5 upward), so a shared y scale would draw one ridge and twenty three flat
	lines. The height carries no quantity here; the table's Height column does, and the caption says
	which.
-->
<script lang="ts">
	import { readsAs } from './dateReview';
	import type { VelocityFigureModel } from './temporal';
	import type { TimeUnits } from './types';

	interface Props {
		model: VelocityFigureModel;
		units: TimeUnits;
		unitLabel: string;
		timePoints: number;
		selected: number | null;
		onSelect: (site: number) => void;
	}
	let { model, units, unitLabel, timePoints, selected, onSelect }: Props = $props();

	const W = 900;
	const PAD_L = 92;
	const PAD_R = 14;
	const PAD_T = 10;
	const PAD_B = 36;
	const ROW = 22;
	const RIDGE = 16;
	const H = $derived(PAD_T + model.rows.length * ROW + PAD_B);

	const span = $derived(model.tMax - model.tMin || 1);
	const x = (v: number) => PAD_L + ((v - model.tMin) / span) * (W - PAD_L - PAD_R);
	const baseline = (i: number) => PAD_T + i * ROW + ROW - 4;

	function ridge(values: number[], max: number, i: number): string {
		const b = baseline(i);
		const pts = values.map((v, t) => `${x(model.time[t]).toFixed(2)},${(b - (Math.max(0, v) / max) * RIDGE).toFixed(2)}`);
		return `${x(model.time[0]).toFixed(2)},${b} ${pts.join(' ')} ${x(model.time[values.length - 1]).toFixed(2)},${b}`;
	}

	const ticks = $derived.by(() => {
		const step = Math.max(1, Math.ceil(span / 7));
		const out: number[] = [];
		for (let v = Math.ceil(model.tMin); v <= model.tMax; v += step) out.push(v);
		return out.length >= 2 ? out : [model.tMin, model.tMax];
	});
	const tickLabel = (v: number) => (units === 'years' ? String(Math.round(v)) : v.toLocaleString('en-US'));
	const resolution = $derived(timePoints > 1 ? span / (timePoints - 1) : span);
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Sweep velocities by codon, ordered by peak date">
		{#each model.rows as r, i (r.site)}
			<line x1={PAD_L} y1={baseline(i)} x2={W - PAD_R} y2={baseline(i)} class="axis" />
			<polygon
				points={ridge(r.values, r.max, i)}
				class="ridge"
				class:ridge--plain={model.source !== 'sweeps'}
				class:ridge--on={selected === r.site}
				role="button"
				tabindex="-1"
				aria-label="Codon {r.label}"
				onclick={() => onSelect(r.site)}
				onkeydown={(e) => e.key === 'Enter' && onSelect(r.site)}
			>
				<title>{r.label} — peak {readsAs(r.peakDate, units)}</title>
			</polygon>
			<circle cx={x(model.time[r.peakIndex])} cy={baseline(i) - RIDGE} r="3" class="peak" class:peak--plain={model.source !== 'sweeps'} />
			{#if r.halfEnd > r.halfStart}
				<line x1={x(r.halfStart)} y1={baseline(i) + 3} x2={x(r.halfEnd)} y2={baseline(i) + 3} class="fwhm" />
			{/if}
			<text x={PAD_L - 8} y={baseline(i)} class="label" class:label--plain={model.source !== 'sweeps'} text-anchor="end">{r.label}</text>
		{/each}
		<line x1={PAD_L} y1={H - PAD_B + 6} x2={W - PAD_R} y2={H - PAD_B + 6} class="axis" />
		{#each ticks as t (t)}
			<line x1={x(t)} y1={H - PAD_B + 6} x2={x(t)} y2={H - PAD_B + 11} class="axis" />
			<text x={x(t)} y={H - PAD_B + 26} class="tick" text-anchor="middle">{tickLabel(t)}</text>
		{/each}
	</svg>
	<figcaption>
		<b>Sweep velocities, by peak date.</b>
		One row per {model.source === 'sweeps' ? 'confirmed sweep' : 'candidate codon'}, ordered by
		{model.source === 'sweeps'
			? 'peak date, not by strength'
			: model.source === 'candidates'
				? 'peak intensity, because no codon was confirmed'
				: `peak intensity: nothing has been called, because ${model.uncalled_reason}`}.
		The ridge is the <strong>positive part</strong> of the time derivative of that codon's trajectory, so a
		trajectory that falls contributes exactly zero and a codon can have a large trajectory and no
		velocity at all. The dot is the peak and the rule beneath it the full width at half that height.
		<strong>Each row is scaled to its own maximum</strong> — the energies differ by orders of magnitude, so a
		shared scale would draw one ridge and {model.rows.length - 1} flat lines; the table's Height column
		carries the quantity. The peak date is a grid point, so its resolution is
		{resolution.toPrecision(2)} {unitLabel} at {timePoints.toLocaleString('en-US')} points.
		{#if model.capped}The {model.rows.length} earliest of {model.total} are drawn.{:else}All {model.rows.length} are drawn.{/if}
		{#if model.source === 'sweeps'}Candidates that were tested and not confirmed are not here; they are in Figure 4.{/if}
		Click a ridge to select its row in the table below.
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
	.label {
		fill: var(--plot-called);
		font-size: 12px;
		font-weight: 700;
		font-family: var(--font-text);
	}
	.ridge {
		fill: var(--plot-called);
		stroke: none;
		cursor: pointer;
	}
	/* The fallback set is NOT a called set, so it may not borrow the purple (web/DESIGN.md §4). */
	.ridge--plain {
		fill: var(--plot-uncalled);
	}
	.ridge--on {
		fill: var(--text);
	}
	.peak {
		fill: var(--plot-called);
	}
	.peak--plain {
		fill: var(--plot-uncalled);
	}
	.label--plain {
		fill: var(--plot-tick);
		font-weight: 400;
	}
	.fwhm {
		stroke: var(--plot-threshold);
		stroke-width: 1;
	}
</style>
