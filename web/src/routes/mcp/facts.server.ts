/**
 * facts.server.ts (/mcp) — the MCP server's version and tool list, read from the `mcp/` workspace
 * when the page is prerendered (./+page.server.ts calls `readMcpFacts` from its `load`; SvelteKit
 * allows no other export from a +page.server.ts, which is why the helpers live here, and the
 * `.server.ts` suffix keeps them out of any client bundle).
 *
 * WHY THIS FILE EXISTS. The /mcp page quotes the server: its version and the tools it registers.
 * Both were typed into the page by hand and both were wrong by Phase 3 integration (0.2.0 and a
 * "Python bridge" column, against a 0.4.0 server with every tool in-process). The site is fully
 * prerendered (routes/+layout.ts), so this load runs ONCE, at build, in Node, and the facts it
 * returns are baked into the page's data; nothing here runs in the browser and the client never
 * sees the mcp/ sources.
 *
 * HOW THE FACTS ARE READ. `mcp/package.json` is read as a file and `mcp/src/tools.js` is imported
 * by FILE URL at load time — a dynamic `import()` marked `@vite-ignore`, not a static `import`
 * from this file — for the reason CLAUDE.md gives for every Node import in this repository: a
 * static import would be bundled into the SvelteKit server chunk, where `engine.js`'s
 * `new URL('../package.json', import.meta.url)` no longer points at mcp/. At PRERENDER the built
 * server runs in plain Node, so the import is Node's own: the module keeps its `import.meta.url`
 * and resolves `@modelcontextprotocol/sdk` and `zod` from the workspace's node_modules exactly as
 * the server itself does. Under `vite dev` and vitest the module runner intercepts the import and
 * transforms the mcp/ graph instead — that works, and it prints two "dynamic import cannot be
 * analyzed" warnings for engine.js's own imports; measured, and harmless. (A `new Function('return
 * import(u)')` escape was tried to keep Node's import everywhere: vitest's vm has no dynamic-import
 * callback, so it throws there.) The repository root is found by walking up from the working
 * directory (`vite build`, `vite dev` and vitest all run from web/) to the directory that holds
 * `mcp/package.json`.
 *
 * A checkout without `mcp/` (the web workspace built alone) is not an error: the page then falls
 * back to the copy in ./tools.ts and the recorded transcript's version, and says which happened.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECORDED } from './transcript';
import { TOOL_ROWS } from './tools';

export interface McpFacts {
	/** `mcp/package.json` `version`. */
	version: string;
	/** `mcp/src/tools.js` TOOL_NAMES, in the server's registration order. */
	toolNames: string[];
	/** Where the two came from: the workspace at build, or this page's own fallback. */
	source: 'workspace' | 'fallback';
}

/** The repository root: the nearest ancestor of `from` holding `mcp/package.json`, or null. */
export function findRepoRoot(from: string = process.cwd()): string | null {
	let dir = resolve(from);
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, 'mcp', 'package.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** The version the transcript was recorded against: the last token of `RECORDED.server`. */
export function recordedVersion(): string {
	return RECORDED.server.split(/\s+/).pop() ?? '';
}

export async function readMcpFacts(root: string | null = findRepoRoot()): Promise<McpFacts> {
	if (!root) {
		return { version: recordedVersion(), toolNames: TOOL_ROWS.map((r) => r.name), source: 'fallback' };
	}
	const pkg = JSON.parse(readFileSync(join(root, 'mcp', 'package.json'), 'utf8')) as { version?: string };
	const toolsUrl = pathToFileURL(join(root, 'mcp', 'src', 'tools.js')).href;
	const tools = (await import(/* @vite-ignore */ toolsUrl)) as { TOOL_NAMES?: readonly string[] };
	if (!Array.isArray(tools.TOOL_NAMES) || tools.TOOL_NAMES.length === 0) {
		throw new Error(`mcp/src/tools.js exports no TOOL_NAMES (read from ${toolsUrl})`);
	}
	return { version: pkg.version ?? recordedVersion(), toolNames: [...tools.TOOL_NAMES], source: 'workspace' };
}
