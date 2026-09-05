/**
 * tools.ts — what the /mcp page says each MCP tool returns, keyed by the tool's name.
 *
 * WHY THIS FILE EXISTS. The tool NAMES are the server's (`mcp/src/tools.js` TOOL_NAMES), read at
 * build by ./+page.server.ts; the one-line descriptions are page copy and live here, in a module
 * with no Svelte in it, so ./page.test.ts can hold the two against each other: every tool the
 * server registers has a row, and no row describes a tool the server no longer has. Phase 3
 * integration found this page a release behind (it still marked three tools "Python bridge" and
 * quoted 0.2.0); with the names imported and the descriptions pinned, the next drift is a failing
 * test rather than a stale page.
 *
 * There is no "runs" column any more. Every analysis tool has run in-process since Phase 3
 * (PLAN.md D16; mcp/src/caps.js NATIVE_ANALYSES), so a column that said so on every row carried
 * no information, and the "bridged" value it existed to show has no producer.
 */

export interface ToolRow {
	name: string;
	returns: string;
	note?: string;
	/** Analysis tools run the model; control tools manage jobs and answer about the engine. */
	kind: 'analysis' | 'control';
}

/** The page's copy per tool. The ORDER here is the page's: hyphaeon_analyze first (it is the product). */
export const TOOL_ROWS: readonly ToolRow[] = [
	{
		name: 'hyphaeon_analyze',
		kind: 'analysis',
		returns:
			'The whole report: diagnostics, sites, gene, epistasis and sectors, attribution, filter, DMS (progressive, capped), phenotype when a trait is given, provenance and timings, in the schema the web report reads.',
		note: 'The same options as the report\'s "Re-run with": model_variant, max_species, reference_sequence, call_mode, seed, permutations, dms; plus phenotype / phenotype_file for the trait, and use_tn93 (a tree is optional).'
	},
	{ name: 'hyphaeon_validate', kind: 'analysis', returns: 'Diagnostics with the same warning codes as the browser, the run mode (inline or job) and a cost estimate.' },
	{ name: 'hyphaeon_meme', kind: 'analysis', returns: 'Per-site LRT, p, q, invariable flag and the report\'s rank columns; --filter and --attribute as options.' },
	{ name: 'hyphaeon_busted', kind: 'analysis', returns: 'p_ACAT, p_Simes, omnibus LRT, selection energy, significant-site counts, and the neural head\'s fields.' },
	{ name: 'hyphaeon_epistasis', kind: 'analysis', returns: 'Co-selection edges with CESI and q, sectors with coherence and p_perm, optional per-sector DMS, GraphML.' },
	{ name: 'hyphaeon_dms', kind: 'analysis', returns: '19-substitution scan per site with intrinsic plasticity and the ΔLRT map.' },
	{
		name: 'hyphaeon_phenotype',
		kind: 'analysis',
		returns: 'Trait association per site, PARS signature, trait sectors, permulation p.',
		note: 'The trait is a preset, a foreground list or pattern, or an inline trait table (phenotype_file); permulations need a tree with branch lengths.'
	},
	{ name: 'hyphaeon_evaluate', kind: 'analysis', returns: 'Concordance of a meme CSV with a HyPhy MEME JSON: correlations, ROC-AUC, PPV, FPR, confusion matrices.' },
	{ name: 'job_status', kind: 'control', returns: 'Phase, progress and warnings of a queued run.' },
	{ name: 'get_results', kind: 'control', returns: 'A completed job\'s result, shaped with fields, top or summary_only.' },
	{ name: 'cancel_job', kind: 'control', returns: 'Cancels a queued or running job.' },
	{ name: 'list_models', kind: 'control', returns: 'The weights manifest and the engine\'s status.' }
];

/**
 * The rows for the tools the server actually registers, in this page's order, plus the names the
 * page has no copy for (rendered with a placeholder so a new tool is never silently omitted).
 */
export function toolTable(serverToolNames: readonly string[]): { rows: ToolRow[]; undescribed: string[]; stale: string[] } {
	const registered = new Set(serverToolNames);
	const rows = TOOL_ROWS.filter((r) => registered.has(r.name));
	const described = new Set(TOOL_ROWS.map((r) => r.name));
	const undescribed = serverToolNames.filter((n) => !described.has(n));
	const stale = TOOL_ROWS.filter((r) => !registered.has(r.name)).map((r) => r.name);
	for (const name of undescribed) rows.push({ name, kind: name.startsWith('hyphaeon_') ? 'analysis' : 'control', returns: 'Registered by the server; see its tool description.' });
	return { rows, undescribed, stale };
}
