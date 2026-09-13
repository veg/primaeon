/**
 * fixtures.ts — the engine's shipped example files, for the `/time` unit tests.
 *
 * WHY THIS FILE EXISTS. Three of the tests in this directory are only worth writing against real
 * data: the flagship HIV example whose 143 LANL names no reference pillar but `dating` can read,
 * the H5N1 pair whose metadata table and headers agree exactly (the control), and the same pair
 * with the table rewritten accession-style (the trap). Loading them in one place keeps each test a
 * list of assertions, and `available()` lets the suite skip loudly rather than fail when the engine
 * is not checked out beside this repository.
 *
 * `HYPHAEON_ENGINE_DIR` overrides the default sibling path, exactly as the runtime and e2e suites
 * resolve it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const ENGINE = resolve(process.env.HYPHAEON_ENGINE_DIR ?? resolve(HERE, '../../../../../HyphAeon'));
export const EXAMPLES = resolve(ENGINE, 'examples');

export function available(): boolean {
	return existsSync(resolve(EXAMPLES, 'korber_env_gp160.fasta'));
}

export function example(name: string): string {
	return readFileSync(resolve(EXAMPLES, name), 'utf8');
}

export const FIXTURES = resolve(ENGINE, 'fixtures');

/** True when the engine's per-function fixture directory is checked out beside this repository. */
export function fixturesAvailable(): boolean {
	return existsSync(resolve(FIXTURES, 'dating'));
}

/**
 * One of the engine's `fixtures/<module>/<function>.json` documents, with `±Infinity` and `NaN`
 * revived. `gen_fixtures.py` writes them as the STRINGS `"-Infinity"`, `"Infinity"` and `"NaN"`
 * because JSON has no literal for them, and a view model that received the string would render it
 * verbatim — which on this pillar means printing `-Infinity` as an interval bound, exactly the
 * thing `intervalText` exists to prevent. Reviving at the boundary keeps every consumer honest.
 */
export function fixtureJson<T = unknown>(relative: string): T {
	return revive(JSON.parse(readFileSync(resolve(FIXTURES, relative), 'utf8'))) as T;
}

function revive(value: unknown): unknown {
	if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
	if (value === 'Infinity') return Number.POSITIVE_INFINITY;
	if (value === 'NaN') return Number.NaN;
	if (Array.isArray(value)) return value.map(revive);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = revive(v);
		return out;
	}
	return value;
}
