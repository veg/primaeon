/**
 * check-gallery-current.mjs — are the committed gallery records what this code bakes?
 *
 * WHY THIS FILE EXISTS. Pull requests build with `HYPHAEON_PREBAKE=skip` and serve the gallery
 * records committed to the repository, which is also what the deployment does. Something has to
 * prove those records still match what the code produces, and that is the `gallery` job in CI: it
 * rebakes, then runs this.
 *
 * WHY NOT `git diff --exit-code`. That was the first attempt and it failed immediately, on records
 * whose every number was identical. A rebake rewrites wall times, a timestamp, the Node version and
 * the thread count, so a plain diff reports six files and 124 lines whenever a rebake happens at
 * all — which is whenever a runtime source moved since the last bake, even by a change that cannot
 * touch a number. A check that cries wolf on its first run teaches everyone to ignore it.
 *
 * WHAT THIS COMPARES. Every committed record against the freshly baked one, with the volatile keys
 * below removed and every number compared at PLAN.md 5.4's graph class rather than exactly.
 *
 * WHY A TOLERANCE AND NOT EQUALITY. The second attempt compared numbers exactly and failed on CI
 * against records baked on a developer's machine: `hyphaeon_lrt` 2.7579092979431152 committed
 * against 2.757908582687378 baked, and four more like it. That is 2.6e-07 relative — the same
 * cross-platform float32 difference between macOS and Linux that mcp/test/phenotype.test.js already
 * documents for the sector coherence at 9.4e-08. It is not a stale record; it is the arithmetic.
 * So numbers are equal within 1e-5 of max(1, |value|), which is the class every other comparison in
 * this project uses for anything downstream of a forward pass, and everything else — a call, a
 * tier, a count, a taxon name — must still match exactly.
 *
 * USAGE: node scripts/check-gallery-current.mjs   (from web/, after a build that rebaked)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(fileURLToPath(import.meta.url), '..', '..');
const repo = resolve(web, '..');
const galleryDir = join(web, 'static', 'gallery');

/**
 * A key whose value changes on every bake and says nothing about the science. Two attempts at this
 * as a fixed list both missed one — first `elapsed_sec`, then the prebake stamp itself — so it is a
 * rule now: anything naming a duration, a moment, the machine, or the bookkeeping that decides
 * whether a rebake was needed.
 *
 * The stamp is deliberately here. It is a hash of the inputs the bake depended on, so it differs
 * exactly when a rebake happened, which is the condition that brought us here; whether the records
 * are CURRENT is decided by the numbers below it, not by the bookkeeping above them.
 */
function isVolatile(key) {
	if (/^(at|createdAt|created_at|createdAtIso|generated_at|generatedAt|timings|node|threads|commit|stamp)$/.test(key)) {
		return true;
	}
	// elapsed, elapsed_sec, elapsedMs, wall, wall_seconds, runtime_sec, duration_ms, ...
	return /^(elapsed|wall|runtime|duration)/.test(key) || /(_sec|_seconds|_ms|Ms|Sec|Seconds)$/.test(key);
}

/** The same object with every volatile key dropped, at any depth. */
function stripVolatile(value) {
	if (Array.isArray(value)) return value.map(stripVolatile);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (isVolatile(k)) continue;
			out[k] = stripVolatile(v);
		}
		return out;
	}
	return value;
}

/** PLAN.md 5.4's graph class: the tolerance for anything downstream of a forward pass. */
const GRAPH_TOL = 1e-5;

/** Two numbers are the same if they differ by less than the class allows. */
function sameNumber(a, b) {
	if (Number.isNaN(a) && Number.isNaN(b)) return true;
	if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
	return Math.abs(a - b) <= GRAPH_TOL * Math.max(1, Math.abs(b));
}

/** The first path where two stripped structures differ, or null. */
function firstDifference(a, b, path = '') {
	if (typeof a === 'number' && typeof b === 'number') {
		return sameNumber(a, b) ? null : { path: path || '(root)', committed: String(a), baked: String(b) };
	}
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		return JSON.stringify(a) === JSON.stringify(b)
			? null
			: { path: path || '(root)', committed: JSON.stringify(a), baked: JSON.stringify(b) };
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) {
		const found = firstDifference(a[k], b[k], `${path}.${k}`);
		if (found) return found;
	}
	return null;
}

const changed = execFileSync('git', ['diff', '--name-only', '--', 'web/static/gallery'], {
	cwd: repo,
	encoding: 'utf8'
})
	.split('\n')
	.map((s) => s.trim())
	.filter((s) => s.endsWith('.json'));

if (changed.length === 0) {
	console.log('[gallery] the committed records are byte-identical to a fresh bake.');
	process.exit(0);
}

const substantive = [];
for (const rel of changed) {
	const full = join(repo, rel);
	if (!existsSync(full)) {
		substantive.push({ file: rel, why: 'the bake removed a record that is committed' });
		continue;
	}
	const committed = JSON.parse(
		execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
	);
	const baked = JSON.parse(readFileSync(full, 'utf8'));
	const diff = firstDifference(stripVolatile(committed), stripVolatile(baked));
	if (diff) substantive.push({ file: rel, ...diff });
}

const timingOnly = changed.length - substantive.length;
if (substantive.length === 0) {
	console.log(
		`[gallery] ${timingOnly} record(s) differ in wall times, environment stamps or float noise ` +
			`below the graph class (${GRAPH_TOL} relative); every number that means something matches. ` +
			'The committed records are current.'
	);
	process.exit(0);
}

console.error(`[gallery] ${substantive.length} record(s) changed in substance:`);
for (const s of substantive) {
	console.error(`  ${relative('', s.file)}`);
	if (s.why) console.error(`    ${s.why}`);
	else console.error(`    first difference at ${s.path}: committed ${s.committed} -> baked ${s.baked}`);
}
console.error(
	'\nRun `npm run build` in web/ and commit web/static/gallery. If the change was not intended, ' +
		'something moved a number and that is the finding, not the stale record.'
);
process.exit(1);
