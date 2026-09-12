<!--
	WaveFigure.svelte — Figure 6: the four collective wave modes, as four stacked small multiples.

	WHY FOUR PANELS AND NOT FOUR LINES ON ONE AXIS. web/DESIGN.md leaves exactly one signal colour
	and forbids a categorical palette (§4, the `SECTOR_PALETTE` deletion). Four coloured lines on one
	axis would need four hues and a legend; four panels need neither, and each panel can carry its
	own share of the variance as a label. NO PURPLE APPEARS IN THIS FIGURE: nothing in it is a call.

	THE TWO CAVEATS THE CAPTION CARRIES ARE NOT DECORATION.

	  THE SIGN IS A CONVENTION (D28). A wave and its negative describe the same mode. `hyphaeon
	  temporal` has no convention and writes its solver's raw signs; this page's canonical rule makes
	  the largest-magnitude element positive and applies it BEFORE the loadings are derived, so a
	  wave and its loading column always flip together. A command-line run may draw any of these
	  curves upside down, with the matching Wave column in the table negated, and nothing else
	  different — no singular value, no variance share, no R², no classification.

	  A NEAR-TIE IS A ROTATION, AND NO SIGN RULE FIXES IT. When two singular values are within 5 % of
	  the leading one, the pair spans a plane that can rotate freely: the SUM of their shares is a
	  property of the data and the split between them is not. Those panels are marked, and the
	  caption says to read them together or not at all. The threshold is the runtime's own, measured:
	  the acceptance run's four modes are separated by 0.097 / 0.311 / 0.108, twice clear of it.
-->
<script lang="ts">
	import { num } from './dating';
	import type { WaveFigureModel } from './temporal';
	import type { TimeUnits } from './types';

	interface Props {
		model: WaveFigureModel;
		units: TimeUnits;
		unitLabel: string;
		tMin: number;
		tMax: number;
	}
	let { model, units, unitLabel, tMin, tMax }: Props = $props();

	const W = 900;
	const PANEL = 74;
	const PAD_L = 20;
	const PAD_R = 14;
	const PAD_B = 30;
	const H = $derived(model.panels.length * PANEL + PAD_B);

	const span = $derived(tMax - tMin || 1);
	const x = (v: number) => PAD_L + ((v - tMin) / span) * (W - PAD_L - PAD_R);
	const amp = $derived.by(() => {
		let m = 0;
		for (const p of model.panels) for (const v of p.values) if (Math.abs(v) > m) m = Math.abs(v);
		return m > 0 ? m : 1;
	});
	const zero = (i: number) => i * PANEL + PANEL / 2;
	const path = (values: number[], i: number) =>
		values.map((v, t) => `${x(model.time[t]).toFixed(2)},${(zero(i) - (v / amp) * (PANEL / 2 - 10)).toFixed(2)}`).join(' ');

	const ticks = $derived.by(() => {
		const step = Math.max(1, Math.ceil(span / 7));
		const out: number[] = [];
		for (let v = Math.ceil(tMin); v <= tMax; v += step) out.push(v);
		return out.length >= 2 ? out : [tMin, tMax];
	});
	const tickLabel = (v: number) => (units === 'years' ? String(Math.round(v)) : v.toLocaleString('en-US'));
	const total = $derived(model.panels.reduce((a, p) => a + p.pct, 0));
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="The four collective wave modes over the sampling window">
		{#each model.panels as p, i (p.k)}
			<line x1={PAD_L} y1={zero(i)} x2={W - PAD_R} y2={zero(i)} class="axis" />
			<polyline points={path(p.values, i)} class="wave" />
			<text x={PAD_L} y={i * PANEL + 14} class="panel-label">
				Wave {p.k} · {num(p.pct, 1)} % of the variance{p.rankDeficient ? ' · no variance: an arbitrary direction' : ''}{p.nearDegenerate
					? ` · not separable from wave ${p.k + 1}`
					: ''}
			</text>
		{/each}
		<line x1={PAD_L} y1={H - PAD_B + 4} x2={W - PAD_R} y2={H - PAD_B + 4} class="axis" />
		{#each ticks as t (t)}
			<line x1={x(t)} y1={H - PAD_B + 4} x2={x(t)} y2={H - PAD_B + 9} class="axis" />
			<text x={x(t)} y={H - PAD_B + 24} class="tick" text-anchor="middle">{tickLabel(t)}</text>
		{/each}
	</svg>
	<figcaption>
		<b>Collective wave modes.</b>
		The {model.panels.length} leading right singular vectors of the standardised velocity matrix of the
		{model.sourceCount}
		{model.source === 'confirmed-sweeps' ? 'confirmed sweeps' : 'strongest candidate codons (fewer than four were confirmed, so the reference falls back to these)'},
		so they are shapes in time that many codons share — not codons. The percentages are shares of the
		variance of that matrix and are <strong>not p-values</strong>; they need not sum to 100, because the
		denominator is the whole spectrum ({num(total, 1)} % here). All four panels share one amplitude
		scale and one time axis, in {units === 'years' ? 'calendar years' : unitLabel}.
		<strong>A wave and its negative describe the same mode.</strong> The sign here is fixed by a convention this
		page states and the Python reference does not have ({model.sign}: the element of largest magnitude
		is made positive, applied before the loadings are derived). A curve in a command-line run may
		therefore be this one upside down, and the Wave column in the table below flips with it.
		{#if model.degeneratePairs.length}
			Waves {model.degeneratePairs.join(', ')} are separated by less than {model.gapThreshold} of the
			leading singular value: that pair can rotate into each other, so their combined share is
			meaningful and the split between them is not. Read them together or not at all.
		{:else}
			No two of these are close enough to rotate into each other (the smallest relative gap is
			{num(Math.min(...model.panels.map((p) => p.gap).filter((g) => Number.isFinite(g))), 3)}, against a
			threshold of {model.gapThreshold}), so each is individually a property of the data.
		{/if}
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
	.panel-label {
		fill: var(--text-muted);
		font-size: 13px;
		font-family: var(--font-text);
	}
	.wave {
		fill: none;
		stroke: var(--text);
		stroke-width: 1;
	}
</style>
