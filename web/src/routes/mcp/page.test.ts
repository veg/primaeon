/**
 * page.test.ts (/mcp) — the page's facts about the MCP server against the server itself.
 *
 * WHY THIS FILE EXISTS. The /mcp page went a full release stale between Phase 1 and Phase 3
 * (PHASE3.md, integration changes): 0.2.0 where the package said 0.4.0, and a "Python bridge"
 * column after the bridge was deleted. ./facts.server.ts now reads the version and the tool names
 * from the `mcp/` workspace at build; this test pins the rest — that the page has copy for every
 * tool the server registers and for nothing else, that the recorded transcript names the version
 * the package ships (a bump without a re-recording is a page quoting numbers from an older
 * server), and that nothing on the page still speaks of a bridge as live.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, readMcpFacts, recordedVersion } from './facts.server';
import { TOOL_ROWS, toolTable } from './tools';
import { RECORDED, TRANSCRIPT } from './transcript';

const root = findRepoRoot();

describe.skipIf(!root)('/mcp against the mcp/ workspace', () => {
	it('reads the version and the tool names from mcp/, not from this page', async () => {
		const facts = await readMcpFacts(root);
		expect(facts.source).toBe('workspace');
		const pkg = JSON.parse(readFileSync(join(root!, 'mcp', 'package.json'), 'utf8')) as { version: string };
		expect(facts.version).toBe(pkg.version);
		expect(facts.toolNames.length).toBeGreaterThan(0);
		expect(facts.toolNames).toContain('hyphaeon_analyze');
		expect(facts.toolNames).toContain('hyphaeon_phenotype');
	});

	it('has one row of copy per registered tool and no row for a tool the server dropped', async () => {
		const { toolNames } = await readMcpFacts(root);
		const table = toolTable(toolNames);
		expect(table.undescribed, `tools registered by mcp/src/tools.js without copy in routes/mcp/tools.ts: ${table.undescribed.join(', ')}`).toEqual([]);
		expect(table.stale, `rows in routes/mcp/tools.ts for tools the server no longer registers: ${table.stale.join(', ')}`).toEqual([]);
		expect(table.rows.map((r) => r.name).sort()).toEqual([...toolNames].sort());
		expect(table.rows[0].name).toBe('hyphaeon_analyze');
	});

	it('records the transcript against the version the package ships', async () => {
		const { version } = await readMcpFacts(root);
		expect(recordedVersion(), `${RECORDED.server} was recorded against an older server; re-record the transcript`).toBe(version);
		expect(RECORDED.server).toBe(`@veg/hyphaeon-mcp ${version}`);
	});
});

describe('/mcp copy', () => {
	it('names every tool the transcript calls', () => {
		const described = new Set(TOOL_ROWS.map((r) => r.name));
		for (const turn of TRANSCRIPT) if (turn.role === 'tool') expect(described, turn.tool).toContain(turn.tool);
	});
	it('says every analysis tool is in-process: phenotype included, and no bridge anywhere', () => {
		const phenotype = TOOL_ROWS.find((r) => r.name === 'hyphaeon_phenotype')!;
		expect(phenotype.kind).toBe('analysis');
		for (const row of TOOL_ROWS) {
			expect(`${row.returns} ${row.note ?? ''}`).not.toMatch(/bridge|python/i);
			expect(row).not.toHaveProperty('runs');
		}
		expect(TOOL_ROWS.filter((r) => r.kind === 'analysis').map((r) => r.name)).toEqual([
			'hyphaeon_analyze',
			'hyphaeon_validate',
			'hyphaeon_meme',
			'hyphaeon_busted',
			'hyphaeon_epistasis',
			'hyphaeon_dms',
			'hyphaeon_phenotype',
			'hyphaeon_evaluate'
		]);
	});
	it('falls back to its own copy when built without the mcp/ workspace', async () => {
		const facts = await readMcpFacts(null);
		expect(facts.source).toBe('fallback');
		expect(facts.version).toBe(recordedVersion());
		expect(facts.toolNames).toEqual(TOOL_ROWS.map((r) => r.name));
	});
});
