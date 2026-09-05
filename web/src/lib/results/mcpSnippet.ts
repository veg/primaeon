/**
 * mcpSnippet.ts — the "reproduce this with MCP" text on the results page.
 *
 * WHY THIS FILE EXISTS. PLAN.md §3.6: "the web app's results page shows the `claude mcp add` line
 * and a 'reproduce this with MCP' snippet". The install line is the one on /mcp (mcp/README and
 * mcp/src/server.js: `claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp`); the tool call is
 * `hyphaeon_meme` with the option names of mcp/src/tools.js's input schema, which mirror the CLI
 * flags one-to-one (`model_variant`, `max_species`, `filter`, `filter_p_thresh`, `attribute`,
 * `attribution_min_lrt`, `no_prune_duplicates`). The browser's option names (runtime/src/
 * pipeline.js `options`: camelCase) are mapped here; unknown options are carried through in
 * snake_case so a new runtime option still appears rather than vanishing.
 *
 * Alignment and tree are file paths because the stdio MCP accepts `file://` (PLAN.md §3.6) and a
 * transcript should not carry the sequences; the names are the ones the record has.
 */

import type { MemeRecord } from './types';

export const MCP_ADD_LINE = 'claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp';

const OPTION_NAMES: Record<string, string> = {
	maxSpecies: 'max_species',
	max_species: 'max_species',
	modelVariant: 'model_variant',
	variant: 'model_variant',
	filter: 'filter',
	filterPThresh: 'filter_p_thresh',
	filter_p_thresh: 'filter_p_thresh',
	minPatchConsec: 'min_patch_consec',
	attribute: 'attribute',
	attributionMinLrt: 'attribution_min_lrt',
	attribution_min_lrt: 'attribution_min_lrt',
	pruneDuplicates: 'prune_duplicates',
	no_prune_duplicates: 'no_prune_duplicates',
	batchSize: 'batch_size',
	useTn93: 'use_tn93'
};

/** Options the MCP schema does not take; browser-only presentation or bookkeeping. */
const DROP = new Set([
	'callMode',
	'calling',
	'referenceSequence',
	'treeSource',
	'batchBudgetBytes',
	'numThreads',
	'signal',
	// Names the analyze flow records for display; the tool takes paths, not names.
	'alignmentName',
	'treeName'
]);

function snake(name: string): string {
	return name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** The `hyphaeon_meme` arguments that reproduce this record's run. */
export function mcpToolArguments(record: MemeRecord): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	args.alignment = `file:///path/to/${record.name ?? 'alignment.fasta'}`;
	const treeSource = record.provenance?.preprocessing?.tree_source;
	// D22: 'user' is the only source with a tree FILE to name; everything else is tree-free
	// (`--use-tn93`) or the alignment's own embedded tree.
	if (treeSource === 'user') {
		args.tree = 'file:///path/to/tree.nwk';
	} else if (treeSource === 'tn93' || treeSource === 'nj') {
		args.use_tn93 = true;
	}
	const variant = record.provenance?.model_variant;
	if (variant) args.model_variant = variant;
	const cap = record.provenance?.preprocessing?.taxon_cap;
	if (typeof cap === 'number') args.max_species = cap;

	for (const [key, value] of Object.entries(record.provenance?.options ?? {})) {
		if (DROP.has(key) || value === undefined || value === null || typeof value === 'function') continue;
		const name = OPTION_NAMES[key] ?? snake(key);
		if (name === 'prune_duplicates') {
			if (value === false) args.no_prune_duplicates = true;
			continue;
		}
		if (name === 'model_variant' && args.model_variant) continue;
		if (name === 'max_species' && args.max_species !== undefined) continue;
		args[name] = value;
	}
	if (record.filter?.enabled) args.filter = true;
	if (record.attributions && Object.keys(record.attributions).length > 0) args.attribute = true;
	return args;
}

/** The whole snippet: install line, then the tool call as Claude Code would issue it. */
export function mcpSnippet(record: MemeRecord): string {
	const call = { tool: 'hyphaeon_meme', arguments: mcpToolArguments(record) };
	return `${MCP_ADD_LINE}\n\n${JSON.stringify(call, null, 2)}`;
}
