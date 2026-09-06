<!--
	SummaryTiles.svelte — the headline numbers of a site-selection result.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "summary tiles": codon sites, taxa used / in the alignment,
	sites called under the ACTIVE call mode (the count changes with the toggle, so it is derived
	from the rows, not read from the record), the model variant with the short hash of the graph
	that produced the numbers, and the surface. The pattern is DM3's AxomemeVisualization summary
	strip (hyphy-scope, `.axomeme-summary`), with the two provenance tiles added because a surrogate
	result without its graph hash and surface cannot be reproduced (PLAN.md §3.5).

	Set as one line closed by a hairline, like the report's overview (web/DESIGN.md §3): no cards,
	no fills; the called count is the one purple value.
-->
<script lang="ts">
	import type { MemeRecord } from '$lib/results/types';
	import type { SiteRow } from '$lib/results/derive';

	interface Props {
		record: MemeRecord;
		rows: SiteRow[];
		modeLabel: string;
	}
	let { record, rows, modeLabel }: Props = $props();

	const called = $derived(rows.filter((r) => r.tier > 0).length);
	const tier1 = $derived(rows.filter((r) => r.tier === 1).length);
	const scored = $derived(rows.filter((r) => r.isVariable).length);
	const pre = $derived(record.provenance.preprocessing);
	const hash = $derived(record.provenance.artifact_sha256 ? record.provenance.artifact_sha256.slice(0, 8) : null);
	const SURFACE_LABEL: Record<string, string> = {
		browser: 'this browser',
		'node-server': 'server job',
		'mcp-stdio': 'MCP (stdio)',
		'mcp-http': 'MCP (remote)',
		'python-reference': 'Python reference'
	};
</script>

<dl class="tiles">
	<div class="tile">
		<dt>Codon sites</dt>
		<dd><strong>{record.sites.length.toLocaleString()}</strong><span>{scored.toLocaleString()} scored</span></dd>
	</div>
	<div class="tile">
		<dt>Taxa</dt>
		<dd>
			<strong>{pre.taxa_used.toLocaleString()}</strong>
			<span>of {pre.taxa_in_alignment.toLocaleString()} in the alignment</span>
		</dd>
	</div>
	<div class="tile tile--accent">
		<dt>Called sites</dt>
		<dd>
			<strong>{called.toLocaleString()}</strong>
			<span>{tier1} tier 1 · {modeLabel}</span>
		</dd>
	</div>
	<div class="tile">
		<dt>Model</dt>
		<dd>
			<strong>{record.provenance.model_variant ?? 'unknown variant'}</strong>
			<span class="mono">{hash ? `sha256 ${hash}…` : 'hash not recorded'}{record.provenance.model_version ? ` · ${record.provenance.model_version}` : ''}</span>
		</dd>
	</div>
	<div class="tile">
		<dt>Surface</dt>
		<dd>
			<strong>{SURFACE_LABEL[record.provenance.surface] ?? record.provenance.surface}</strong>
			<span>{record.provenance.elapsed_sec != null ? `${record.provenance.elapsed_sec.toFixed(1)} s` : 'time not recorded'}</span>
		</dd>
	</div>
</dl>

<style>
	.tiles {
		margin: 0 0 var(--space-4);
		display: grid;
		grid-template-columns: repeat(5, minmax(0, auto));
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
	}
	dd span {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.tile--accent dd strong {
		color: var(--brand);
	}
	.mono {
		font-family: var(--font-mono);
	}
	@media (max-width: 48em) {
		.tiles {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
