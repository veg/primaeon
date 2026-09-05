/**
 * check-caveats.mjs — validate web/caveats.json against the model manifest before a build.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 has the methods page generate its caveats from
 * web/caveats.json, and the caveats are numbers about one specific model. Two things can go stale
 * silently: the model behind the numbers (a new manifest ships with a new model_version, the site
 * keeps quoting the old FPR table) and the file itself (a caveat points at a table that was
 * renamed, a pillar key has a typo, a source string is missing, so a section renders empty). This
 * script fails the build on both, and is appended to web's `prebuild` after copy-assets.mjs has
 * put the manifest under static/models/, so the manifest it reads is the one the site serves.
 *
 * WHAT IT CHECKS
 *   1. The manifest's model_version is a key of caveats.json and the block agrees with itself and
 *      with the manifest: model_version, reference_version, taxon caps, PRNG, the input/output
 *      names, the variants and their artifact-hash prefixes (a prefix, so the file stays readable;
 *      the full hash is verified at load time by the runtime).
 *   2. Every caveat has a unique kebab-case id, a non-empty set of known pillar keys, a headline,
 *      a detail, and a `source` that resolves in `sources`; `table` resolves in `tables`;
 *      `numbers` are {label, value} strings.
 *   3. Every table has a title, columns, rows of the same width, and a resolving source.
 *   4. Every pillar the methods page renders has at least one caveat, so no section is empty.
 *   5. No AI attribution strings anywhere in the file (repository rule).
 *
 * MANIFEST LOCATION. HYPHAEON_MANIFEST if set; else web/static/models/manifest.json (written by
 * ../scripts/copy-assets.mjs); else <HYPHAEON_ENGINE_DIR or ../HyphAeon>/models/manifest.json.
 * A machine with no manifest at all (the HYPHAEON_PREBAKE=skip build) gets a warning and the
 * structural checks only; a mismatch is always an error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const caveatsPath = join(web, 'caveats.json');

/** The pillar keys web/src/lib/caveats/index.ts exports; kept in step by index.test.ts. */
const PILLARS = [
	'general',
	'diagnostics',
	'sites',
	'gene',
	'epistasis',
	'attribution',
	'filter',
	'dms',
	'phenotype',
	'evaluate'
];
/** Pillars that get their own section on /methods and therefore must not render empty. */
const RENDERED = PILLARS.filter((p) => p !== 'general');

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function manifestPath() {
	const candidates = [
		process.env.HYPHAEON_MANIFEST,
		join(web, 'static', 'models', 'manifest.json'),
		join(process.env.HYPHAEON_ENGINE_DIR ?? resolve(repo, '..', 'HyphAeon'), 'models', 'manifest.json')
	].filter(Boolean);
	return candidates.find((p) => existsSync(p)) ?? null;
}

function sameSet(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	const sb = new Set(b);
	return a.every((x) => sb.has(x));
}

// ── 0. parse ────────────────────────────────────────────────────────────────

let file;
try {
	file = readJson(caveatsPath);
} catch (err) {
	console.error(`[check-caveats] ${relative(repo, caveatsPath)} does not parse: ${err.message}`);
	process.exit(1);
}
if (file.schema_version !== 1) fail(`schema_version must be 1, got ${JSON.stringify(file.schema_version)}`);

const blocks = Object.entries(file).filter(([k, v]) => !k.startsWith('_') && k !== 'schema_version' && v && typeof v === 'object');
if (blocks.length === 0) fail('no model_version block (expected a key such as "v1")');

// ── 1. manifest agreement ───────────────────────────────────────────────────

const mpath = manifestPath();
let manifest = null;
if (!mpath) {
	warn('no manifest.json found (static/models, HYPHAEON_ENGINE_DIR, HYPHAEON_MANIFEST); skipping the model_version comparison');
} else {
	manifest = readJson(mpath);
	const version = manifest.model_version;
	const block = file[version];
	if (!block) {
		fail(`manifest ${relative(repo, mpath)} is model_version "${version}" but caveats.json has no "${version}" block (has: ${blocks.map(([k]) => k).join(', ')})`);
	} else {
		if (block.model_version !== version) fail(`"${version}".model_version is "${block.model_version}"`);
		if (block.reference_version !== manifest.reference_version) {
			fail(`"${version}".reference_version "${block.reference_version}" != manifest reference_version "${manifest.reference_version}"`);
		}
		const card = block.model_card ?? {};
		if (card.taxon_cap !== manifest.taxon_cap) fail(`model_card.taxon_cap ${card.taxon_cap} != manifest ${manifest.taxon_cap}`);
		if (card.default_taxon_cap !== manifest.default_taxon_cap) {
			fail(`model_card.default_taxon_cap ${card.default_taxon_cap} != manifest ${manifest.default_taxon_cap}`);
		}
		if (manifest.prng) {
			if (card.prng?.algorithm !== manifest.prng.algorithm) fail(`model_card.prng.algorithm != manifest (${manifest.prng.algorithm})`);
			if (card.prng?.default_seed !== manifest.prng.default_seed) fail(`model_card.prng.default_seed != manifest (${manifest.prng.default_seed})`);
		}
		if (manifest.onnx) {
			if (!sameSet(card.inputs, manifest.onnx.inputs)) fail(`model_card.inputs != manifest onnx.inputs (${manifest.onnx.inputs.join(', ')})`);
			if (!sameSet(card.outputs, manifest.onnx.outputs)) fail(`model_card.outputs != manifest onnx.outputs (${manifest.onnx.outputs.join(', ')})`);
		}
		const mv = manifest.variants ?? {};
		const cv = card.variants ?? {};
		for (const name of Object.keys(mv)) {
			const v = cv[name];
			if (!v) {
				fail(`manifest variant "${name}" has no model_card.variants entry`);
				continue;
			}
			if (v.trained_on !== mv[name].trained_on) fail(`variants.${name}.trained_on differs from the manifest`);
			if (v.regime !== mv[name].regime) fail(`variants.${name}.regime differs from the manifest`);
			if (typeof v.onnx_sha256_prefix !== 'string' || v.onnx_sha256_prefix.length < 8) {
				fail(`variants.${name}.onnx_sha256_prefix must be at least 8 hex characters`);
			} else if (!String(mv[name].onnx_sha256).startsWith(v.onnx_sha256_prefix)) {
				fail(`variants.${name}.onnx_sha256_prefix ${v.onnx_sha256_prefix} is not a prefix of the manifest's ${mv[name].onnx_sha256}`);
			}
			if (mv[name].busted_head_onnx_sha256) {
				const p = v.busted_head_onnx_sha256_prefix;
				if (typeof p !== 'string' || !mv[name].busted_head_onnx_sha256.startsWith(p)) {
					fail(`variants.${name}.busted_head_onnx_sha256_prefix is missing or not a prefix of ${mv[name].busted_head_onnx_sha256}`);
				}
			}
		}
		for (const name of Object.keys(cv)) if (!mv[name]) fail(`model_card.variants.${name} is not in the manifest`);
	}
}

// ── 2-5. structure of every block ───────────────────────────────────────────

for (const [key, block] of blocks) {
	const where = (s) => `"${key}": ${s}`;
	const sources = block.sources ?? {};
	const tables = block.tables ?? {};
	const usedSources = new Set();
	if (typeof block.model_version !== 'string') fail(where('model_version missing'));
	if (typeof block.reference_version !== 'string') fail(where('reference_version missing'));
	if (typeof block.reference_tag !== 'string') fail(where('reference_tag missing'));
	if (Object.keys(sources).length === 0) fail(where('sources is empty'));
	if (!block.model_card || typeof block.model_card !== 'object') fail(where('model_card missing'));
	else if (!sources[block.model_card.source]) fail(where(`model_card.source "${block.model_card.source}" is not a key of sources`));
	else usedSources.add(block.model_card.source);

	if (!Array.isArray(block.caveats) || block.caveats.length === 0) {
		fail(where('caveats must be a non-empty array'));
		continue;
	}
	const ids = new Set();
	const perPillar = Object.fromEntries(PILLARS.map((p) => [p, 0]));
	block.caveats.forEach((c, i) => {
		const at = (s) => where(`caveats[${i}]${c && c.id ? ` (${c.id})` : ''}: ${s}`);
		if (!c || typeof c !== 'object') return fail(at('not an object'));
		if (typeof c.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) fail(at('id must be kebab-case'));
		else if (ids.has(c.id)) fail(at('duplicate id'));
		else ids.add(c.id);
		if (!Array.isArray(c.pillars) || c.pillars.length === 0) fail(at('pillars must be a non-empty array'));
		else {
			for (const p of c.pillars) {
				if (!PILLARS.includes(p)) fail(at(`unknown pillar "${p}" (known: ${PILLARS.join(', ')})`));
				else perPillar[p] += 1;
			}
		}
		for (const f of ['headline', 'detail']) {
			if (typeof c[f] !== 'string' || !c[f].trim()) fail(at(`${f} must be a non-empty string`));
		}
		if (typeof c.source !== 'string' || !sources[c.source]) fail(at(`source "${c.source}" is not a key of sources`));
		else usedSources.add(c.source);
		if (c.table !== undefined && !tables[c.table]) fail(at(`table "${c.table}" is not a key of tables`));
		if (c.action !== undefined && typeof c.action !== 'string') fail(at('action must be a string'));
		if (c.numbers !== undefined) {
			if (!Array.isArray(c.numbers)) fail(at('numbers must be an array'));
			else {
				c.numbers.forEach((n, j) => {
					if (!n || typeof n.label !== 'string' || typeof n.value !== 'string') fail(at(`numbers[${j}] must be {label, value} strings`));
				});
			}
		}
	});
	for (const p of RENDERED) if (perPillar[p] === 0) fail(where(`pillar "${p}" has no caveat and would render an empty section`));

	for (const [name, t] of Object.entries(tables)) {
		const at = (s) => where(`tables.${name}: ${s}`);
		if (typeof t.title !== 'string' || !t.title.trim()) fail(at('title missing'));
		if (!Array.isArray(t.columns) || t.columns.length === 0) fail(at('columns missing'));
		if (!Array.isArray(t.rows) || t.rows.length === 0) fail(at('rows missing'));
		else if (Array.isArray(t.columns)) {
			t.rows.forEach((r, j) => {
				if (!Array.isArray(r) || r.length !== t.columns.length) fail(at(`rows[${j}] has ${Array.isArray(r) ? r.length : 'no'} cells, columns has ${t.columns.length}`));
				else r.forEach((cell, k) => typeof cell !== 'string' && fail(at(`rows[${j}][${k}] must be a string`)));
			});
		}
		if (typeof t.source !== 'string' || !sources[t.source]) fail(at(`source "${t.source}" is not a key of sources`));
		else usedSources.add(t.source);
		if (t.note !== undefined && typeof t.note !== 'string') fail(at('note must be a string'));
	}
	for (const s of Object.keys(sources)) if (!usedSources.has(s)) warn(where(`source "${s}" is never referenced`));
}

// ── hygiene ─────────────────────────────────────────────────────────────────

const text = readFileSync(caveatsPath, 'utf8');
if (/claude|anthropic|co-authored|generated with/i.test(text)) fail('attribution string found in caveats.json');

// ── report ──────────────────────────────────────────────────────────────────

for (const w of warnings) console.warn(`[check-caveats] warning: ${w}`);
if (errors.length) {
	for (const e of errors) console.error(`[check-caveats] ${e}`);
	console.error(`[check-caveats] ${errors.length} error(s) in ${relative(repo, caveatsPath)}`);
	process.exit(1);
}
const summary = blocks
	.map(([k, b]) => `${k}: ${b.caveats.length} caveats, ${Object.keys(b.tables ?? {}).length} tables`)
	.join('; ');
const against = manifest
	? `manifest ${relative(repo, mpath)} (model_version ${manifest.model_version}, reference ${manifest.reference_version})`
	: 'no manifest';
console.log(`[check-caveats] ok — ${summary}; ${against}`);
