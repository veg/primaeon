<!--
	OverviewStrip.svelte — the report's overview line: gene verdict, called sites, taxa, variant,
	surface, elapsed.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "overview strip (gene verdict, called sites, taxa used,
	variant, surface)". Phase 1's SummaryTiles showed one analysis; this line summarises the whole
	report and fills in as sections arrive — a tile whose section has not landed shows a dash and
	the phase it is waiting for, never a zero, so the row doubles as progress. The gene tile leads
	with the verdict phrase and carries `p_ACAT` (the exact statistic) after it; the neural head's
	`selection_probability`, when present, is the small print with its nondeterminism note
	(GeneCard.svelte says why). Called sites count under the ACTIVE call mode, derived from the
	rows the Sites section is showing, so the toggle and the tile agree.

	SET AS A LINE, NOT AS CARDS (web/DESIGN.md §3): six columns closed by a hairline, a 13 px label,
	a 16 px value with the number in bold, and a 13 px qualifier under it. Nothing is display size;
	the called count is the one purple value, because it is the one signal on the line. The
	`dl[aria-label="Report overview"]` and `.tile` hooks are read by the e2e and stay.
-->
<script lang="ts" module>
	/** `YYYY-MM-DD HH:mm`, local time: two runs on one evening must be told apart (DESIGN.md §3). */
	export function formatStamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	export const SURFACE_LABEL: Record<string, string> = {
		browser: 'this browser',
		'node-server': 'server',
		'mcp-stdio': 'MCP (stdio)',
		'mcp-http': 'MCP (remote)',
		'python-reference': 'Python reference'
	};
</script>

<script lang="ts">
	import type { ReportRecord } from '$lib/api';
	import type { SiteRow } from '$lib/results/derive';
	import { elapsedSeconds, formatSeconds } from '$lib/report/status';

	interface Props {
		record: ReportRecord;
		rows: SiteRow[] | null;
		modeLabel: string;
		live: boolean;
	}
	let { record, rows, modeLabel, live }: Props = $props();

	const gene = $derived(record.sections.gene);
	const sites = $derived(record.sections.sites);
	const called = $derived(rows ? rows.filter((r) => r.tier > 0).length : null);
	const variable = $derived(rows ? rows.filter((r) => r.isVariable).length : 0);
	const tier1 = $derived(rows ? rows.filter((r) => r.tier === 1).length : 0);
	const pre = $derived(record.provenance?.preprocessing ?? sites?.provenance?.preprocessing ?? null);
	const variant = $derived(record.provenance?.model_variant ?? sites?.provenance?.model_variant ?? record.options.variant);
	const hash = $derived(record.provenance?.artifact_sha256 ?? sites?.provenance?.artifact_sha256 ?? null);
	const surface = $derived(record.provenance?.surface ?? sites?.provenance?.surface ?? 'browser');
	const fmtP = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '—' : p < 1e-4 ? p.toExponential(1) : p.toFixed(3));
	const verdict = $derived.by(() => {
		const p = gene?.record.p_value_acat;
		if (p == null || !Number.isFinite(p)) return 'No verdict';
		return p <= 0.05 ? 'Episodic selection detected' : p <= 0.1 ? 'Suggestive' : 'No gene-wide signal';
	});
	const elapsed = $derived(elapsedSeconds(record));
</script>

<dl class="strip" aria-label="Report overview">
	<div class="tile">
		<dt>Gene verdict</dt>
		<dd>
			{#if gene}
				<strong>{verdict}, p<sub>ACAT</sub> {fmtP(gene.record.p_value_acat)}</strong>
				<span>
					{#if gene.record.selection_probability != null}
						head P(sel) {gene.record.selection_probability.toFixed(2)}, one seeded draw
					{:else}
						Cauchy-combined across the variable sites
					{/if}
				</span>
			{:else}
				<strong class="dash">—</strong>
				<span>{live ? 'waiting for the omnibus' : 'not in this run'}</span>
			{/if}
		</dd>
	</div>
	<div class="tile tile--accent">
		<dt>Called sites</dt>
		<dd>
			{#if called != null}
				<strong>{called.toLocaleString()}</strong> <span class="of">of {variable.toLocaleString()} variable</span>
				<span>{tier1} tier 1 · {modeLabel}</span>
			{:else}
				<strong class="dash">—</strong>
				<span>{live ? 'scoring sites' : 'not in this run'}</span>
			{/if}
		</dd>
	</div>
	<div class="tile">
		<dt>Taxa</dt>
		<dd>
			{#if pre}
				<strong>{pre.taxa_used.toLocaleString()}</strong>
				<span>of {pre.taxa_in_alignment.toLocaleString()} in the alignment{pre.pd_subsampled ? ', PD-subsampled' : ''}</span>
			{:else}
				<strong class="dash">—</strong>
				<span>{live ? 'preparing' : 'not recorded'}</span>
			{/if}
		</dd>
	</div>
	<div class="tile">
		<dt>Variant</dt>
		<dd>
			<strong>{variant}</strong>
			<span class="mono">{hash ? `sha256 ${hash.slice(0, 8)}…` : 'hash pending'}</span>
		</dd>
	</div>
	<div class="tile">
		<dt>Surface</dt>
		<dd>
			<strong>{SURFACE_LABEL[surface] ?? surface}</strong>
			<span>{record.runtime ? `${record.runtime.numThreads} ORT thread${record.runtime.numThreads === 1 ? '' : 's'}` : live ? 'running' : ''}</span>
		</dd>
	</div>
	<div class="tile">
		<dt>Elapsed</dt>
		<dd>
			{#if live && record.status.state === 'running'}
				<strong class="dash">—</strong>
				<span>{record.status.message ?? 'running'}</span>
			{:else}
				<strong>{formatSeconds(elapsed)}</strong>
				<span>{record.createdAtIso ? formatStamp(record.createdAtIso) : ''}</span>
			{/if}
		</dd>
	</div>
</dl>

<style>
	.strip {
		margin: 0 0 var(--space-4);
		display: grid;
		grid-template-columns: repeat(6, minmax(0, auto));
		gap: var(--space-5);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--hair);
	}
	.tile {
		min-width: 0;
	}
	dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin-bottom: 0.1rem;
	}
	dd {
		margin: 0;
		font-size: var(--text-base);
		line-height: 1.3;
	}
	dd strong {
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	dd strong sub {
		font-size: 0.7em;
	}
	dd > span {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	dd > .of {
		display: inline;
		font-size: var(--text-base);
		color: var(--text);
	}
	.tile--accent dd strong {
		color: var(--brand);
	}
	.dash {
		color: var(--text-faint);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	@media (max-width: 48em) {
		.strip {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	@media (max-width: 30em) {
		.strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
