<!--
	ClockPreview.svelte — divergence against sampling date, the fit, and the sequences whose dates do
	not fit it.

	WHY THIS FILE EXISTS. A reader who has just checked 143 dates wants to know whether they carry a
	clock signal, and the answer is one scatter and one line. It is a DIAGNOSTIC OF THE DATES, not a
	dating analysis, and every sentence on it is written so that it cannot be mistaken for one:
	`lib/time/clock.ts`'s header lists the four claims the preview must not make and this component
	prints them next to the numbers they qualify.

	WHAT IT WILL NOT SAY (root-to-tip specification §4.1): the words *dating*, *TMRCA*, *calibrated*,
	*confidence interval* and *molecular clock estimate* do not appear, and no download is named
	`dating.*`.

	LOOK. web/DESIGN.md: a `<figure>` with a numbered caption, hairline axes in `--plot-axis`, 12 px
	`--plot-tick` labels, no frame, no grid, no legend. Purple is the one place on this page it is
	earned — the flagged points and the fit line — because there the mark carries a fact about the
	data rather than decoration; everything else is grey. The outlier table follows §3's table rule.
-->
<script lang="ts">
	import type { ClockPreview } from './clock';
	import { rateSentence, verdict } from './clock';

	interface Props {
		preview: ClockPreview;
		treeName: string | null;
	}
	let { preview, treeName }: Props = $props();

	const W = 900;
	const H = 320;
	const PAD_L = 64;
	const PAD_R = 16;
	const PAD_T = 16;
	const PAD_B = 44;

	const fit = $derived(preview.fit);
	const bounds = $derived.by(() => {
		if (!preview.available || preview.points.length === 0) return null;
		const xs = preview.points.map((p) => p.time);
		const ys = preview.points.map((p) => p.divergence);
		const x0 = Math.min(...xs);
		const x1 = Math.max(...xs);
		const y0 = Math.min(0, Math.min(...ys));
		const y1 = Math.max(...ys);
		return {
			x: (v: number) => PAD_L + ((v - x0) / (x1 - x0 || 1)) * (W - PAD_L - PAD_R),
			y: (v: number) => H - PAD_B - ((v - y0) / (y1 - y0 || 1)) * (H - PAD_T - PAD_B),
			x0,
			x1,
			y0,
			y1
		};
	});

	const line = $derived.by(() => {
		if (!bounds || !fit || !fit.ok) return null;
		const at = (t: number) => fit.d0 + fit.mu * (t - fit.tRef);
		return {
			x1: bounds.x(bounds.x0),
			y1: bounds.y(at(bounds.x0)),
			x2: bounds.x(bounds.x1),
			y2: bounds.y(at(bounds.x1))
		};
	});

	const outliers = $derived(fit && fit.ok ? fit.rows.filter((r) => r.isOutlier) : []);
	const sig = (v: number, dp = 4) => (Number.isFinite(v) ? v.toPrecision(dp) : '—');
	const num = (v: number, dp = 3) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
	const timeWord = $derived(preview.units === 'years' ? 'year' : preview.units === 'generations' ? 'generation' : preview.units === 'days' ? 'day' : 'time unit');
	const ancestorWord = $derived(preview.units === 'years' ? 'ancestor date' : 'ancestor time');
</script>

<h3>Clock signal</h3>
<p class="note">
	A quick look at whether your dates carry a clock signal. This is a diagnostic of the dates, not a
	dating analysis.
</p>

{#if !preview.available}
	<p class="note note--muted">{preview.reason}</p>
{:else if fit && fit.ok}
	<p class="verdict">{verdict(preview)}</p>

	<figure>
		<svg viewBox="0 0 {W} {H}" width="100%" height={H} role="img" aria-label="Root-to-tip divergence against sampling date">
			<line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} class="axis" />
			<line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} class="axis" />
			{#if bounds}
				<text x={PAD_L} y={H - 10} class="tick">{bounds.x0.toFixed(2)}</text>
				<text x={W - PAD_R} y={H - 10} class="tick" text-anchor="end">{bounds.x1.toFixed(2)}</text>
				<text x={PAD_L - 8} y={H - PAD_B} class="tick" text-anchor="end">{sig(bounds.y0, 2)}</text>
				<text x={PAD_L - 8} y={PAD_T + 10} class="tick" text-anchor="end">{sig(bounds.y1, 2)}</text>
				<text x={(PAD_L + W - PAD_R) / 2} y={H - 10} class="tick" text-anchor="middle">sampling {preview.units === 'years' ? 'date' : preview.units}</text>
				{#if line}
					<line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} class="fitline" />
				{/if}
				{#each preview.points as p (p.taxon)}
					<circle cx={bounds.x(p.time)} cy={bounds.y(p.divergence)} r={p.outlier ? 3.5 : 2.5} class={p.outlier ? 'pt pt--flag' : 'pt'}>
						<title>{p.taxon}</title>
					</circle>
				{/each}
			{/if}
		</svg>
		<figcaption>
			<b>Divergence from the root against sampling date{treeName ? `, from ${treeName} as supplied` : ', from your tree as supplied'}.</b>
			One point per dated tip, {fit.n} of {fit.n + fit.nUndated}; the purple line is the centred
			least-squares fit and purple points are the {outliers.length} flagged at |z| ≥ 2.5. Rooted at
			the {preview.rootLabel}. No clock is fitted beyond this line, no root is searched, and no
			interval is drawn.
		</figcaption>
	</figure>

	<dl class="stats">
		<div>
			<dt>Rate</dt>
			<dd><strong>{sig(fit.mu)}</strong> <span class="qual">{rateSentence(preview)}, ± {sig(fit.seMu, 2)}</span></dd>
		</div>
		<div>
			<dt>{ancestorWord[0].toUpperCase() + ancestorWord.slice(1)}</dt>
			<dd>
				<strong>{Number.isFinite(fit.tMrca) ? num(fit.tMrca, 2) : '—'}</strong>
				<span class="qual">{Number.isFinite(fit.seMrca) ? `± ${num(fit.seMrca, 2)}` : 'not shown; see the line above'}</span>
			</dd>
		</div>
		<div>
			<dt>R²</dt>
			<dd><strong>{num(fit.r2)}</strong> <span class="qual">over {fit.n} dated tips</span></dd>
		</div>
		<div>
			<dt>Divergence at the mean date</dt>
			<dd><strong>{sig(fit.d0)}</strong> <span class="qual">at {num(fit.tRef, 2)}, ± {sig(fit.seD0, 2)}</span></dd>
		</div>
		<div>
			<dt>Residual RMSE</dt>
			<dd><strong>{sig(fit.rmse, 2)}</strong> <span class="qual">tree units</span></dd>
		</div>
		<div>
			<dt>Flagged</dt>
			<dd><strong>{outliers.length}</strong> <span class="qual">of {fit.n} at |z| ≥ 2.5</span></dd>
		</div>
	</dl>

	<p class="note">
		Branch lengths are taken from your tree. We cannot verify what they are in, so the rate is per
		tree unit per {timeWord}. Where the root sits is the largest single influence on the {ancestorWord}:
		the analysis searches for the root, this preview does not.
	</p>
	{#if preview.sensitivity}
		<p class="note" class:note--warn={preview.sensitivity.wide}>
			{#if preview.sensitivity.wide}<strong>Moving the root moves this estimate.</strong>{/if}
			Rooted at the {preview.sensitivity.values.map((v) => `${v.label} it is ${v.tMrca.toFixed(2)}`).join(', and at the ')} —
			a spread of {preview.sensitivity.spread.toFixed(2)} {timeWord}s.
		</p>
	{/if}
	<p class="note">
		Standard errors only, by the delta method. The analysis reports an exact interval, which is
		wider — and these standard errors themselves understate the real sampling error, because
		root-to-tip residuals share branches and least squares assumes they do not.
	</p>

	{#if outliers.length > 0}
		<div class="scroll">
			<table>
				<caption>
					<b>Sequences whose divergence does not fit their date.</b>
					{outliers.length} of {fit.n} dated tips, sorted by how far the fit puts them from their label.
					<em>Looks</em> is the fitted date minus the label: a negative number means the sequence looks
					older than its date says. Flagged at |z| ≥ 2.5 on the divergence residual, the same rule the
					analysis uses; the scale is a plain standard deviation, so several bad dates can mask one
					another.
				</caption>
				<thead>
					<tr>
						<th scope="col">Sequence</th>
						<th scope="col" class="num">Date</th>
						<th scope="col" class="num">Divergence</th>
						<th scope="col" class="num">Fitted</th>
						<th scope="col" class="num">Looks ({timeWord}s)</th>
						<th scope="col" class="num">z</th>
					</tr>
				</thead>
				<tbody>
					{#each outliers as r (r.taxon)}
						<tr>
							<td class="mono">{r.taxon}</td>
							<td class="num">{num(r.samplingDate, 2)}</td>
							<td class="num">{sig(r.rootDivergence, 3)}</td>
							<td class="num">{sig(r.fittedDivergence, 3)}</td>
							<td class="num">{num(r.temporalResidual, 2)}</td>
							<td class="num">{num(r.zScore, 2)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{:else}
	<p class="note note--muted">{preview.reason}</p>
{/if}

<style>
	h3 {
		margin: 0 0 var(--space-2);
	}
	.note--muted {
		color: var(--text-muted);
	}
	.verdict {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0 0 var(--space-4);
		max-width: var(--measure);
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
	.pt {
		fill: var(--plot-uncalled);
	}
	.pt--flag {
		fill: var(--plot-called);
	}
	.fitline {
		stroke: var(--plot-called);
		stroke-width: 1;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--space-4);
		margin: 0 0 var(--space-4);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.stats div {
		margin: 0;
	}
	.stats dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.stats dd {
		margin: 0;
		font-size: var(--text-base);
	}
	.stats dd strong {
		font-weight: 700;
	}
	.qual {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		min-width: 44rem;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.note {
		margin: 0 0 var(--space-4);
	}
</style>
