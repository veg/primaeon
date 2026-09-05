/**
 * +page.server.ts (/mcp) — the page's build-time facts about the MCP server: version and tool
 * names from the `mcp/` workspace (./facts.server.ts says how and why). Prerendered, so this runs
 * once at build in Node and the client never sees the mcp/ sources.
 */

import { readMcpFacts, type McpFacts } from './facts.server';

export const prerender = true;

export async function load(): Promise<{ mcp: McpFacts }> {
	return { mcp: await readMcpFacts() };
}
