/**
 * manifest.js — the model manifest: which variants exist, what their artifacts hash to, and the
 * graph contract every session verifies before it scores anything.
 *
 * WHY THIS FILE EXISTS. PLAN.md §3.3: one `models/manifest.json` lives in veg/HyphAeon, is written
 * by `hyphaeon export-onnx` in the same commit as the graphs, and is packaged into both the pip and
 * the npm artifact; the web build copies it into static/. Every surface — browser, MCP, Node
 * server — verifies the sha256 of what it loads against this file and refuses to score on a
 * mismatch. This module is the ONE reader of that file, so the three surfaces cannot disagree about
 * what a variant is called, which file holds it, or which hash it must carry.
 *
 * The runtime hazard being closed is the one DM3's modelContract.js records: a swapped graph still
 * returns a plausible number per site. DM3 pinned a single hash in source
 * (VERIFIED_MODEL_SHA256 = de765904…ccda3, the v1 viral graph). Here the pin moves into data, per
 * variant, because there are now two variants (general / viral) plus a busted head, and a hash in
 * source would have to be edited three times per export.
 *
 * Expected shape (PLAN.md §3.3, abridged):
 *
 *   { "model_version": "v1",
 *     "variants": { "general": { "onnx_sha256": "…", "busted_head_onnx_sha256": "…", … },
 *                   "viral":   { "onnx_sha256": "de765904…", … } },
 *     "taxon_cap": 512, "default_taxon_cap": 256, "dropped_heads_policy": "omit",
 *     "onnx": { "opset": 17, "inputs": ["msa_codons","msa_aas","dist_matrix","mds_coords"],
 *               "outputs": ["lrt","mean_root_attns","root_repr"] },
 *     "prng": { "algorithm": "xoshiro256**", "default_seed": 42 } }
 *
 * File naming is `<variant>.onnx` beside the manifest (`general.onnx`, `viral.onnx`,
 * `busted_head.onnx`, `<variant>_taxa.onnx`), per the layout in PLAN.md §5.5. A variant may
 * override that with an explicit `onnx_file` / `busted_head_file` / `taxa_onnx_file`, which this
 * module honours so a renamed export does not need a code change.
 *
 * THE DATING GRAPH IS A THIRD ARTIFACT, AND IT IS OPTIONAL. `<variant>_taxa.onnx` emits the
 * taxon-by-taxon attention block and the per-taxon embeddings the dating pillar's two model-based
 * estimators need (`cross_attn_sum`, `taxa_repr_sum`). It is a SEPARATE file rather than two more
 * backbone outputs because onnxruntime does not prune a graph to the requested fetch list — see
 * feeds.js's header for the measurement — so folding the reductions into `general.onnx` would tax
 * every MEME, BUSTED, epistasis, DMS and phenotype site of every run for outputs only dating reads.
 * `taxa_onnx_sha256` is validated ONLY WHEN PRESENT, exactly as `busted_head_onnx_sha256` is: a
 * manifest without it means the dating graph was not built, `pickVariant` reports null, and the
 * model-based estimators must REFUSE rather than fall back to something else.
 *
 * `onnx.taxa_row_layers` and `onnx.embed_dim` are the dating graph's DIVISORS, not decoration:
 * `cross_attn_sum` is accumulated over the graph's row layers as well as over the call's sites, so
 * the caller divides it by `sites * taxa_row_layers` and `taxa_repr_sum` by `sites` alone
 * (splits.py:151-153). They live in the manifest rather than as a constant here because a
 * checkpoint of a different depth would otherwise be silently mis-scaled.
 *
 * ISOMORPHIC ON PURPOSE. The same module runs in a browser worker and under Node, so it has no
 * static import of any `node:` builtin: file reads and node:crypto are reached through dynamic
 * imports behind a runtime check, with the specifier held in a variable so a bundler does not try
 * to resolve them for the browser build. Web Crypto is used where it exists.
 */

/** The manifest's file name beside the graphs, and the default variant (PLAN.md D10). */
export const MANIFEST_FILE = 'manifest.json';
export const DEFAULT_VARIANT = 'general';

/**
 * The four graph inputs, in graph order. Same four as the v1 viral export DM3 verified
 * (modelContract.js INPUT_SPEC), so DM3's `validateInputBundle` and the handoff's trap list hold
 * unchanged. A manifest may restate them under `onnx.inputs`; a session checks the loaded graph
 * against whichever list applies.
 */
export const DEFAULT_INPUT_NAMES = Object.freeze([
	'msa_codons',
	'msa_aas',
	'dist_matrix',
	'mds_coords'
]);

/**
 * The outputs the new export declares (PLAN.md §3.4). `lrt` is the only one every graph must
 * carry — the v1 viral graph DM3 pinned returns `lrt` alone. The other two are read when present
 * and omitted when not (`dropped_heads_policy: "omit"`), never fabricated.
 */
export const DEFAULT_OUTPUT_NAMES = Object.freeze(['lrt', 'mean_root_attns', 'root_repr']);
export const REQUIRED_OUTPUT_NAMES = Object.freeze(['lrt']);

/**
 * The dating graph's outputs (`hyphaeon/export.py` TAXA_OUTPUT_NAMES, mirroring
 * `splits.py:131-149`). THESE MUST NEVER JOIN `DEFAULT_OUTPUT_NAMES`: that list is what `runSites`
 * fetches when a caller names no outputs, so adding them would make every meme run ask a graph that
 * does not have them, and — if the two artifacts were ever merged — copy an [N, N] matrix out per
 * batch for nothing. They are also BOTH required: `runTaxaSites` refuses a partial answer where
 * `runSites` omits a missing optional head, because a covariance kernel built from half a graph is
 * the plausible wrong number this pillar exists to avoid.
 */
export const TAXA_OUTPUT_NAMES = Object.freeze(['cross_attn_sum', 'taxa_repr_sum']);

/** The row-layer count and embedding width a manifest that predates the dating graph does not carry. */
const TAXA_ROW_LAYERS_FALLBACK = 6;
const EMBED_DIM_FALLBACK = 384;

const HEX64 = /^[0-9a-f]{64}$/;

/** Is this a well-formed lowercase hex sha256? */
export function isSha256Hex(value) {
	return typeof value === 'string' && HEX64.test(value);
}

/**
 * Validate a parsed manifest document and return it. Throws on anything a session could not act
 * on: no model_version, no variants, a variant without a well-formed `onnx_sha256`. Extra fields
 * pass through untouched — the manifest carries training provenance this module does not read.
 *
 * @param {object|string} doc parsed JSON, or the JSON text
 * @returns {object} the manifest
 */
export function parseManifest(doc) {
	const manifest = typeof doc === 'string' ? JSON.parse(doc) : doc;
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('manifest: not an object');
	}
	if (typeof manifest.model_version !== 'string' || !manifest.model_version) {
		throw new Error('manifest: model_version is missing');
	}
	const variants = manifest.variants;
	if (!variants || typeof variants !== 'object' || Object.keys(variants).length === 0) {
		throw new Error('manifest: no variants');
	}
	for (const [name, v] of Object.entries(variants)) {
		if (!v || typeof v !== 'object') throw new Error(`manifest: variant "${name}" is not an object`);
		if (!isSha256Hex(v.onnx_sha256)) {
			throw new Error(`manifest: variant "${name}" has no well-formed onnx_sha256`);
		}
		if (v.busted_head_onnx_sha256 != null && !isSha256Hex(v.busted_head_onnx_sha256)) {
			throw new Error(`manifest: variant "${name}" has a malformed busted_head_onnx_sha256`);
		}
		// Optional by construction: absent means "the dating graph was not built for this variant".
		// Present and malformed is a different thing entirely and must not be treated as absent.
		if (v.taxa_onnx_sha256 != null && !isSha256Hex(v.taxa_onnx_sha256)) {
			throw new Error(`manifest: variant "${name}" has a malformed taxa_onnx_sha256`);
		}
	}
	return manifest;
}

/** Running under Node (as opposed to a browser or a worker)? */
function isNode() {
	return typeof process !== 'undefined' && !!process.versions?.node;
}

/** Does a string name something fetch() should read rather than the file system? */
function looksLikeUrl(source) {
	if (/^(https?|blob|data):/i.test(source)) return true;
	// A root-relative or relative path in a browser is a URL on this origin; under Node it is a
	// file path.
	return !isNode();
}

/**
 * Load a manifest from a path (Node), a URL (browser, or an http(s) URL anywhere), a URL object,
 * or an already-parsed object.
 *
 * @param {string|URL|object} source
 * @param {{fetchImpl?: typeof fetch, readFileImpl?: (p: string) => Promise<string|Uint8Array>}} [options]
 *   test seams; production passes neither.
 * @returns {Promise<object>}
 */
export async function loadManifest(source, options = {}) {
	if (source && typeof source === 'object' && !(source instanceof URL)) {
		return parseManifest(source);
	}
	const spec = source instanceof URL ? source.href : String(source);
	if (options.readFileImpl || (!(source instanceof URL) && !looksLikeUrl(spec))) {
		const readFile = options.readFileImpl ?? (await nodeReadFile());
		const raw = await readFile(spec, 'utf8');
		return parseManifest(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
	}
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const response = await doFetch(spec);
	if (!response.ok) {
		throw new Error(`manifest fetch failed: ${response.status} ${response.statusText} (${spec})`);
	}
	return parseManifest(await response.text());
}

async function nodeReadFile() {
	const name = 'node:fs/promises';
	const fs = await import(/* @vite-ignore */ name);
	return fs.readFile;
}

/** Variant names, in manifest order. */
export function listVariants(manifest) {
	return Object.keys(manifest.variants);
}

/**
 * Select a variant and expose everything a session needs to load it.
 *
 * @param {object} manifest
 * @param {string} [name] default DEFAULT_VARIANT
 * @returns {{name: string, onnxSha256: string, bustedHeadSha256: string|null,
 *   taxaOnnxSha256: string|null, onnxFile: string, bustedHeadFile: string|null,
 *   taxaOnnxFile: string|null, trainedOn: string|undefined,
 *   regime: string|undefined, raw: object}}
 *   `taxaOnnxSha256` is null when this manifest declares no dating graph for the variant; the
 *   dating pass reports that as `DATING_MODEL_GRAPH_ABSENT` and runs the model-free estimators
 *   alone.
 */
export function pickVariant(manifest, name = DEFAULT_VARIANT) {
	const v = manifest.variants?.[name];
	if (!v) {
		throw new Error(
			`manifest: no variant "${name}" (available: ${listVariants(manifest).join(', ')})`
		);
	}
	return {
		name,
		onnxSha256: v.onnx_sha256,
		bustedHeadSha256: v.busted_head_onnx_sha256 ?? null,
		taxaOnnxSha256: v.taxa_onnx_sha256 ?? null,
		onnxFile: v.onnx_file ?? `${name}.onnx`,
		bustedHeadFile: v.busted_head_onnx_sha256 ? (v.busted_head_file ?? 'busted_head.onnx') : null,
		taxaOnnxFile: v.taxa_onnx_sha256 ? (v.taxa_onnx_file ?? `${name}_taxa.onnx`) : null,
		trainedOn: v.trained_on,
		regime: v.regime,
		raw: v
	};
}

/**
 * Join a base (directory path or URL prefix) and a file name without caring whether the base
 * carries a trailing slash. `modelLocation('/models', manifest, 'viral')` → '/models/viral.onnx'.
 */
export function modelLocation(base, manifest, variantName = DEFAULT_VARIANT) {
	const { onnxFile } = pickVariant(manifest, variantName);
	const prefix = String(base ?? '').replace(/\/+$/, '');
	return prefix ? `${prefix}/${onnxFile}` : onnxFile;
}

/** Graph input names: the manifest's `onnx.inputs` when stated, else the default four. */
export function inputNames(manifest) {
	const names = manifest?.onnx?.inputs;
	return Array.isArray(names) && names.length ? names.slice() : DEFAULT_INPUT_NAMES.slice();
}

/** Graph output names: the manifest's `onnx.outputs` when stated, else the default three. */
export function outputNames(manifest) {
	const names = manifest?.onnx?.outputs;
	return Array.isArray(names) && names.length ? names.slice() : DEFAULT_OUTPUT_NAMES.slice();
}

/** The dating graph's output names: `onnx.taxa_outputs` when stated, else the default two. */
export function taxaOutputNames(manifest) {
	const names = manifest?.onnx?.taxa_outputs;
	return Array.isArray(names) && names.length ? names.slice() : TAXA_OUTPUT_NAMES.slice();
}

/**
 * The two divisors the dating pass applies to the accumulated sums, and the embedding width it
 * checks the graph against. `onnx.taxa_row_layers` / `onnx.embed_dim` where the manifest states
 * them; otherwise the exported checkpoint's own 6 and 384, which is what every manifest written
 * before the dating graph existed describes.
 *
 * @returns {{rowLayers: number, embedDim: number, stated: boolean}}
 */
export function taxaGraphArch(manifest) {
	const rows = manifest?.onnx?.taxa_row_layers;
	const dim = manifest?.onnx?.embed_dim;
	const stated = Number.isInteger(rows) && rows > 0 && Number.isInteger(dim) && dim > 0;
	return {
		rowLayers: stated ? rows : TAXA_ROW_LAYERS_FALLBACK,
		embedDim: stated ? dim : EMBED_DIM_FALLBACK,
		stated
	};
}

/**
 * Hex sha256 of a buffer: Web Crypto where it exists, node:crypto under Node, null where neither
 * is available (a non-secure browser context). Null is REPORTED by callers, never treated as
 * verified.
 *
 * Digests a Uint8Array VIEW rather than the ArrayBuffer itself. `digest` accepts either per spec,
 * but an ArrayBuffer constructed in another realm fails the implementation's instanceof check —
 * which is what happens under jsdom, and equally for a buffer crossing a worker boundary.
 * Constructing the view here puts it in this module's realm. (DM3 session.js.)
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string|null>}
 */
export async function sha256Hex(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (typeof globalThis.crypto?.subtle?.digest === 'function') {
		const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
		return toHex(new Uint8Array(digest));
	}
	if (isNode()) {
		const name = 'node:crypto';
		const { createHash } = await import(/* @vite-ignore */ name);
		return createHash('sha256').update(view).digest('hex');
	}
	return null;
}

function toHex(u8) {
	let s = '';
	for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
	return s;
}

/**
 * The refusal every session raises on a mismatch. One wording, so a user or a log reader sees the
 * same message from the browser, the MCP and the server, and so the message says what to do
 * rather than only that it failed.
 */
export function hashMismatchError(label, expected, actual) {
	return new Error(
		`${label} hash mismatch.\n  expected ${expected}\n  got      ${actual}\n` +
			'The graph contract was verified against the artifact the manifest names. If the model was ' +
			'deliberately re-exported, regenerate models/manifest.json in the same commit; if it was not, ' +
			'the file served is not the file expected and must not be scored with.'
	);
}

/**
 * Compare bytes against an expected hash.
 *
 * @returns {Promise<{ok: boolean, verified: boolean, actual: string|null, expected: string}>}
 *   `verified` is false when no digest was available; `ok` is then true only because nothing
 *   contradicted the expectation — callers report that, they do not hide it.
 */
export async function verifySha256(bytes, expected) {
	const actual = await sha256Hex(bytes);
	if (actual === null) return { ok: true, verified: false, actual: null, expected };
	return { ok: actual === expected, verified: true, actual, expected };
}
