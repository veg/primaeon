<!--
	ClassificationFigure.svelte — Figure 7: the cross-classification, drawn as the thing it is.

	WHY THIS FILE EXISTS. The reference's four-way label is an `if/else` ladder over two thresholds
	(temporal.py:700-716): the static scan's q ≤ 0.10 and the permutation p ≤ 0.05. Plotting the two
	evidence axes against each other and drawing both cuts as labelled rules makes the classification
	visible as the arithmetic it is, rather than as a word in a column a reader has to trust.

	THREE THINGS THE CAPTION MUST SAY, because each of them is a way to misread the picture:

	  THE THIRD GATE CANNOT BE DRAWN. A confirmation also requires the wave-alignment R² ≥ 0.35, and
	  R² is not on either axis. So an UNFILLED point above the horizontal rule is a codon that passed
	  the null and failed that gate; the count is given rather than left to be discovered.

	  ONLY THE CANDIDATES ARE HERE. Every codon that did not pass the sweep-energy floor has
	  `p_perm` fixed at exactly 1 by construction (temporal.py:645), so drawing them would pile
	  thousands of points on the y = 0 line and make the figure a picture of the floor.

	  THE Y AXIS HAS AN ARITHMETIC CEILING. A Monte-Carlo p cannot fall below 1/(B+1), so the points
	  along the top are at the RESOLUTION LIMIT of the null, not at infinite significance.
-->
<script lang="ts">
	import { num } from './dating';
	import type { ClassificationFigureModel } from './temporal';

	interface Props {
		model: ClassificationFigureModel;
		draws: number;
		selected: number | null;
		onSelect: (site: number) => void;
	}
	let { model, draws, selected, onSelect }: Props = $props();

	const W = 900;
	const H = 340;
	const PAD_L = 58;
	const PAD_R = 120;
	const PAD_T = 16;
	const PAD_B = 42;

	const x = (v: number) => PAD_L + (v / model.xMax) * (W - PAD_L - PAD_R);
	const y = (v: number) => H - PAD_B - (v / model.yMax) * (H - PAD_T - PAD_B);
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Temporal evidence against static evidence, for every candidate codon">
		<line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} class="axis" />
		<line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} class="axis" />

		<line x1={x(model.xCut)} y1={PAD_T} x2={x(model.xCut)} y2={H - PAD_B} class="cut" />
		<text x={x(model.xCut) + 4} y={PAD_T + 10} class="tick">q ≤ {model.qCut}</text>
		<line x1={PAD_L} y1={y(model.yCut)} x2={W - PAD_R} y2={y(model.yCut)} class="cut" />
		<text x={W - PAD_R - 4} y={y(model.yCut) - 5} class="tick" text-anchor="end">p ≤ {model.alpha}</text>

		<text x={x(model.xCut) + 6} y={PAD_T + 26} class="quadrant">Both agree</text>
		<text x={PAD_L + 6} y={PAD_T + 26} class="quadrant">Found only in time</text>
		<text x={x(model.xCut) + 6} y={H - PAD_B - 8} class="quadrant">Static only</text>
		<text x={PAD_L + 6} y={H - PAD_B - 8} class="quadrant">Neither</text>

		{#each model.points as p (p.site)}
			<circle
				cx={x(p.x)}
				cy={y(p.y)}
				r={p.sweep ? 3.5 : 2.5}
				class="dot"
				class:dot--called={p.sweep}
				class:dot--on={selected === p.site}
				role="button"
				tabindex="-1"
				aria-label="Codon {p.label}"
				onclick={() => onSelect(p.site)}
				onkeydown={(e) => e.key === 'Enter' && onSelect(p.site)}
			>
				<title>{p.label}{p.gateFailed ? ' — passed the null, failed the wave-alignment gate' : ''}</title>
			</circle>
			{#if p.sweep}
				<text x={x(p.x) + 5} y={y(p.y) - 5} class="mark-label">{p.label}</text>
			{/if}
		{/each}

		<text x={PAD_L} y={H - 6} class="tick">static evidence, −log₁₀ q</text>
		<text x={10} y={PAD_T + 8} class="tick">temporal, −log₁₀ p</text>
	</svg>
	<figcaption>
		<b>What the dates add to the ordinary scan.</b>
		One point per candidate codon, {model.candidates.toLocaleString('en-US')} of them: the static scan's
		evidence across, the date-shuffling null's up. The two dashed rules are the reference's own cuts
		(temporal.py:700-716) and the four cells they make are the four labels in the table's last column.
		Filled points are confirmed sweeps, labelled with residue and codon number.
		<strong>The third gate cannot be drawn</strong>: a confirmation also needs the wave-alignment R² ≥ {model.minR2},
		which is on neither axis, so
		{#if model.gateApplied}
			an unfilled point above the horizontal rule is a codon that passed the null and failed that
			gate — there {model.gateFailed === 1 ? 'is' : 'are'} {model.gateFailed} of them here.
		{:else}
			it was not applied at all on this run (the solitary regime), and every point above the
			horizontal rule is a confirmed sweep.
		{/if}
		<strong>Only the candidates are drawn.</strong> Every other codon has its permutation p fixed at exactly 1 by
		construction, so drawing them would pile them on the axis. The y axis has an arithmetic ceiling:
		p cannot fall below 1/({draws.toLocaleString('en-US')} + 1) = {num(model.gridStep, 5)}, so points
		along the top are at the resolution limit of the null, not at infinite significance. Click a point to
		select its row in the table below.
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
	.cut {
		stroke: var(--plot-threshold);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}
	.tick {
		fill: var(--plot-tick);
		font-size: 12px;
		font-family: var(--font-text);
	}
	.quadrant {
		fill: var(--plot-tick);
		font-size: 12px;
		font-family: var(--font-text);
	}
	.dot {
		fill: var(--plot-uncalled);
		cursor: pointer;
	}
	.dot--called {
		fill: var(--plot-called);
	}
	.dot--on {
		fill: var(--text);
	}
	.mark-label {
		fill: var(--plot-called);
		font-size: 12px;
		font-weight: 700;
		font-family: var(--font-text);
	}
</style>
