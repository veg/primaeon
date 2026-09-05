<!--
	OverviewStrip.svelte — the report's headline row: gene verdict, called sites, taxa, variant,
	surface, elapsed.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "overview strip (gene verdict, called sites, taxa used,
	variant, surface)". Phase 1's SummaryTiles showed one analysis; this strip summarises the whole
	report and fills in as sections arrive — a tile whose section has not landed shows a dash and
	the phase it is waiting for, never a zero. The gene tile is `p_ACAT` (the exact statistic); the
	neural head's `selection_probability`, when present, is the small print with its
	nondeterminism flag (GeneCard.svelte says why). Called sites count under the ACTIVE call mode,
	derived from the rows the Sites section is showing, so the toggle and the tile agree.
-->
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
	const tier1 = $derived(rows ? rows.filter((r) => r.tier === 1).length : 0);
	const pre = $derived(record.provenance?.preprocessing ?? sites?.provenance?.preprocessing ?? null);
	const variant = $derived(record.provenance?.model_variant ?? sites?.provenance?.model_variant ?? record.options.variant);
	const hash = $derived(record.provenance?.artifact_sha256 ?? sites?.provenance?.artifact_sha256 ?? null);
	const surface = $derived(record.provenance?.surface ?? sites?.provenance?.surface ?? 'browser');
	const SURFACE_LABEL: Record<string, string> = {
		browser: 'this browser',
		'node-server': 'server',
		'mcp-stdio': 'MCP (stdio)',
		'mcp-http': 'MCP (remote)',
		'python-reference': 'Python reference'
	};
	const fmtP = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '—' : p < 1e-4 ? p.toExponential(1) : p.toFixed(3));
	const verdictTone = $derived.by(() => {
		const p = gene?.record.p_value_acat;
		if (p == null || !Number.isFinite(p)) return 'pending';
		return p <= 0.05 ? 'strong' : p <= 0.1 ? 'warn' : 'none';
	});
	const elapsed = $derived(elapsedSeconds(record));
</script>

<dl class="strip" aria-label="Report overview">
	<div class="tile tile--{verdictTone}">
		<dt>Gene verdict</dt>
		<dd>
			{#if gene}
				<strong>p<sub>ACAT</sub> {fmtP(gene.record.p_value_acat)}</strong>
				<span>
					{gene.record.p_value_acat <= 0.05 ? 'episodic selection detected' : gene.record.p_value_acat <= 0.1 ? 'suggestive' : 'no gene-wide signal'}
					{#if gene.record.selection_probability != null}
						· head P(sel) {gene.record.selection_probability.toFixed(2)}<abbr title="From the neural BUSTED head; not reproducible against the Python reference (see the gene card).">*</abbr>
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
				<strong>{called.toLocaleString()}</strong>
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
				<span>of {pre.taxa_in_alignment.toLocaleString()} in the alignment{pre.pd_subsampled ? ' · PD-subsampled' : ''}</span>
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
			<strong>{live && record.status.state === 'running' ? '…' : formatSeconds(elapsed)}</strong>
			<span>{record.status.state === 'running' ? (record.status.message ?? '') : record.createdAtIso ? new Date(record.createdAtIso).toLocaleString() : ''}</span>
		</dd>
	</div>
</dl>

<style>
	.strip {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: var(--space-3);
	}
	.tile {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		padding: var(--space-3) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.tile--accent {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.tile--strong {
		border-color: var(--tier-strong);
		background: var(--danger-soft);
	}
	.tile--warn {
		border-color: var(--warn);
		background: var(--warn-soft);
	}
	dt {
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	dd strong {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: var(--text-xl);
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	dd strong sub {
		font-size: 0.55em;
	}
	.dash {
		color: var(--text-faint);
	}
	dd span {
		font-size: var(--text-xs);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
	}
	abbr {
		text-decoration: none;
		color: var(--warn);
		cursor: help;
	}
</style>
