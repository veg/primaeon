/**
 * mcp.ts — the "reproduce this report with MCP" snippet, now on `hyphaeon_analyze`.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "The MCP mirrors the product with a `hyphaeon_analyze` tool
 * that runs everything and returns the report"; §3.6: the results page shows the `claude mcp add`
 * line and a reproduction snippet. Phase 1's snippet (lib/results/mcpSnippet.ts) called
 * `hyphaeon_meme` with that tool's option names; the report calls `hyphaeon_analyze` with the
 * report's options under the CLI's names (`model_variant`, `max_species`, `seed`,
 * `n_permutations`, `dms`), because one report is one tool call. Paths are placeholders for the
 * same reason as before: the stdio server reads local files and this page never had a path.
 */

import type { ReportRecord } from '$lib/api';

export const MCP_ADD_LINE = 'claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp';

/** The `hyphaeon_analyze` arguments that reproduce this report's run. */
export function analyzeToolArguments(record: ReportRecord): Record<string, unknown> {
	const o = record.options;
	const args: Record<string, unknown> = {
		alignment: `file:///path/to/${record.inputs.alignmentName || 'alignment.fasta'}`
	};
	// D22: a tree with branch lengths is named as a file; a tree-free run is `--use-tn93`, which is
	// the reference's own flag for the path it took. A record from before Phase 3 may carry an
	// estimated-tree source, whose tree was a download of that report and not an input here, so it
	// reproduces as tree-free too.
	const src = record.inputs.treeSource as string;
	if (src === 'user') args.tree = `file:///path/to/${record.inputs.treeName ?? 'tree.nwk'}`;
	else if (src !== 'embedded') args.use_tn93 = true;
	args.model_variant = o.variant;
	args.max_species = o.maxSpecies;
	if (o.referenceSequence) args.reference_sequence = o.referenceSequence;
	args.call_mode = o.callMode;
	args.seed = o.seed;
	args.n_permutations = o.permutations;
	args.dms = o.dms.enabled;
	return args;
}

export function analyzeSnippet(record: ReportRecord): string {
	const call = { tool: 'hyphaeon_analyze', arguments: analyzeToolArguments(record) };
	return `${MCP_ADD_LINE}\n\n${JSON.stringify(call, null, 2)}`;
}
