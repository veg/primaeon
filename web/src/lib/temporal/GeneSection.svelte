<!--
	GeneSection.svelte — one gene's section of the temporal study: the four temporal panels, the
	sampling strip, and the per-site table, each a captioned figure.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the study is one page with a numbered section per gene
	(genes-as-sections). This is that section, in the report grammar (DESIGN.md §3): an h2 whose text
	is exactly the gene name (the CSS counter numbers it), a metadata line, then figures with captions
	BELOW that state what is drawn and what is deliberately not. The panels map to the engine guide's
	4-panel figure: waves (A), velocity waterfall (B), trajectories + prevalence (C), phase space (D).
	The wave caption carries the §4.1 caveat: these are data-driven modes, not Pango-lineage
	frequencies.
-->
<script lang="ts">
	import type { TemporalGeneRecord } from './types';
	import { WAVE_READING } from './types';
	import WaveModes from '$lib/viz/temporal/WaveModes.svelte';
	import VelocityWaterfall from '$lib/viz/temporal/VelocityWaterfall.svelte';
	import TrajectoryMap from '$lib/viz/temporal/TrajectoryMap.svelte';
	import PhaseSpace from '$lib/viz/temporal/PhaseSpace.svelte';
	import SamplingStrip from '$lib/viz/temporal/SamplingStrip.svelte';
	import SweepTable from './SweepTable.svelte';

	interface Props {
		record: TemporalGeneRecord;
	}
	let { record }: Props = $props();

	const s = $derived(record.summary);
	const hasCurves = $derived(record.curves.length > 0);
	const waveReading = WAVE_READING.map((w, i) => `W${i + 1} ${w}`).join('; ');
</script>

<section class="section" id="gene-{record.gene}">
	<div class="section__head">
		<h2>{record.gene}</h2>
		<span class="eyebrow">hyphaeon temporal · surrogate for episodic selection over time</span>
	</div>

	<p class="meta">
		{s.taxa_total.toLocaleString('en-US')} sequences · {s.codons_total} codons ({s.codons_variable} variable)
		· {s.t_min.toFixed(2)}–{s.t_max.toFixed(2)} ({s.timespan_years.toFixed(1)} y) · {s.confirmed_sweeps}
		confirmed and {s.rescued_sweeps} rescued sweeps
	</p>

	{#if record.sampling}
		<figure>
			<SamplingStrip sampling={record.sampling} />
			<figcaption>
				<b></b>Sampling density: number of sequences per calendar quarter for this region. Aggregate
				counts only — no per-sequence data is shown or shipped.
			</figcaption>
		</figure>
	{/if}

	<figure>
		<WaveModes waves={record.waves} variancePct={s.fpca_wave_variance_pct} />
		<figcaption>
			<b></b>Collective dynamic wave modes W₁–W₄(t) from the fPCA decomposition, with their percent
			variance. These are <em>data-driven</em> modes of coordinated temporal change, not named-lineage
			frequencies (this dataset carries no Pango annotation). They typically correspond to {waveReading}.
		</figcaption>
	</figure>

	{#if hasCurves}
		<figure>
			<VelocityWaterfall curves={record.curves} />
			<figcaption>
				<b></b>Positive sweep-velocity waterfall v<sub>s</sub>(t) across the sweep sites, one row per
				site, sorted top-to-bottom by peak-velocity year. Colour runs white → purple with velocity;
				horizontal bands mark sites that swept in the same window. Hover for the value.
			</figcaption>
		</figure>

		<figure>
			<TrajectoryMap curves={record.curves} field="a" />
			<figcaption>
				<b></b>Selection-intensity trajectories â<sub>s</sub>(t) for the sweep sites — the model's
				continuous positive-selection signal over calendar time. One line per site.
			</figcaption>
		</figure>

		<figure>
			<TrajectoryMap curves={record.curves} field="p" />
			<figcaption>
				<b></b>Genotype prevalence over time for the same sweep sites — the frequency of the derived
				residue in the sampled sequences, the counterpart to the selection trajectory above.
			</figcaption>
		</figure>
	{/if}

	<figure>
		<PhaseSpace sites={record.sites} />
		<figcaption>
			<b></b>Factor-loading phase space: each variable site by its projection onto the first two wave
			modes (L₁, L₂), coloured by classification. Sites in the same quadrant share a wave phase;
			confirmed and rescued sweeps are labelled.
		</figcaption>
	</figure>

	<SweepTable sites={record.sites} />
</section>

<style>
	.section {
		position: relative;
		margin-top: var(--space-10);
		padding-left: 2.5rem;
	}
	.section__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		border-bottom: 1px solid var(--rule);
		padding-bottom: var(--space-2);
		flex-wrap: wrap;
	}
	h2 {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0;
	}
	.eyebrow {
		font-size: 13px;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}
	.meta {
		color: var(--text-muted);
		font-size: var(--text-md);
		font-variant-numeric: tabular-nums;
		margin: var(--space-3) 0 var(--space-5);
	}
	figure {
		margin: 0 0 var(--space-8);
	}
	figcaption {
		color: var(--text-muted);
		font-size: var(--text-md);
		max-width: var(--measure);
		margin-top: var(--space-2);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
</style>
