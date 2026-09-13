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
