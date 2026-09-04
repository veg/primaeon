/**
 * prebake-gallery.mjs — run site selection on the bundled examples under Node and write the
 * results the /gallery page and /results/gallery/<name>/ serve as static files.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 gives /gallery "bundled examples with prebaked results", and
 * §6 takes the "prebake at build" pattern from datamonkey-metrics: the results a visitor opens
 * first must cost no model download and no inference, and they must be the numbers THIS build's
 * runtime produces (not the Python reference's stale example outputs, PLAN.md §2 item 9). So the
 * web `prebuild` step, after scripts/copy-assets.mjs has vendored the graphs, scores the five
 * examples through the same `runMeme` the browser worker and the MCP use, under onnxruntime-node,
 * and writes:
 *
 *   web/static/gallery/inputs/<name>.fasta|.nwk   the inputs, copied from HyphAeon/examples/
 *   web/static/gallery/<name>.json                 one result record per example
 *   web/static/gallery/index.json                  the cards: dimensions, runtime, called counts
 *
 * THE FIVE EXAMPLES are the README's table (veg/HyphAeon@phase-1a README.md, "Bundled examples"),
 * whose one-line descriptions the cards quote verbatim: Smc6, bat_oas1, camelid, HIV1_RT, RHO. RHO
 * is NEXUS with its tree embedded and is run with treeText null, as `hyphaeon meme -a RHO.fasta`
 * is (fixtures/e2e/meme_RHO.json argv). camelid.nwk and HIV1_RT.nwk carry no branch lengths
 * (PHASE1A.md gap 1); dataset.py:601-611 would call HyPhy's HKY85 fit there. The runtime's
 * `runMeme` takes that call as `options.estimateTree`; this script supplies the runtime's HyPhy
 * module (runtime/src/hyphy, HyPhy WASM under Node) when it is present and otherwise passes no
 * hook, so the library takes the reference's "HyPhy not found" branch (1e-3 / 1e-4 defaults).
 * Which happened is read back from `provenance.preprocessing` (`tree_source`,
 * `branch_lengths_estimated`, `branch_lengths_missing`) and written to the index as
 * `branch_length_method`, so nobody reads a default-length result as an estimated one.
 *
 * OPTIONS ARE THE APP'S DEFAULTS, on purpose: variant `general` (D10), taxon cap 256
 * (manifest `default_taxon_cap`), duplicate pruning on (the CLI's default). That means HIV1_RT
 * (476 taxa) and RHO (710) are Faith's-PD subsampled to 256 here where the reference fixtures ran
 * uncapped (475 and 655 taxa); the cards say "256 of 476 taxa" for that reason, and a parity
 * comparison against fixtures/e2e/meme_HIV1_RT.json is not meaningful for those two. Smc6,
 * bat_oas1 and camelid are under the cap and comparable.
 *
 * PROVENANCE. `surface: "node-server"` (this is the Node runtime, PLAN.md §3.5's list has no
 * "build" surface) with `note: "prebaked at build"` so a reader of the record knows it was not
 * produced by a request. THE RECORD SHAPE is what web/src/lib/results/load.ts reads for a
 * `gallery/<name>` id: the analysis document itself (results/types.ts `MemeRecord`: `sites`,
 * `summary`, `provenance`, plus `tree` — the Newick actually used — and `alignment` — the selected
 * taxa and sequences, for the site tree and the entropy overlays) at the TOP level of the file,
 * with the ResultRecord envelope fields of web/src/lib/api.ts (`inputs` with sizes and hashes,
 * `options`, `steps` with per-phase milliseconds, `runtime`, `createdAt`) written beside them
 * under their api.ts names, so a gallery entry and a stored browser run read alike on the results
 * page. The per-site attention and root_repr matrices are not requested (site selection does not
 * read them); the runtime's typed arrays become plain arrays and its Maps plain objects.
 *
 * FRESHNESS. Scoring the capped examples takes tens of seconds, and `npm run build` must not pay
 * that when nothing changed. Each entry records a `stamp`: sha256 over the inputs, the graph
 * hash, the options, the library version, the runtime's pipeline sources (and its HyPhy module)
 * and this script's version. A matching stamp with the result file present is reused.
 * HYPHAEON_PREBAKE=force (or --force) rebakes everything; HYPHAEON_PREBAKE=skip writes nothing (a
 * CI job without onnxruntime-node bindings keeps the committed index); `--only <id>` restricts to
 * one example. A machine where onnxruntime-node cannot load (PHASE0.md item 7: the 1.23.2 pin and
 * Rosetta) gets a warning and whatever index already exists — or one whose entries are all
 * `status: "missing"` so the /gallery prerender still has a document to read — never a failed
 * build.
 *
 * THREADS. onnxruntime-node's intra-op threads default to 1 in session-node.js (one worker among
 * many on a shared box). A build is alone on its machine, so this script asks for
 * min(8, availableParallelism) unless HYPHAEON_PREBAKE_THREADS says otherwise. The timings
 * printed at the end of a run are recorded per entry in index.json `summary.runtime_sec`.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// -----------------------------------------------------------------------------------------------
// Paths and knobs
// -----------------------------------------------------------------------------------------------

/** Bump when the record or index shape written here changes; part of every entry's stamp. */
const SCRIPT_VERSION = 4;
/** Must equal `schema_version` in web/src/lib/gallery/types.ts. */
const INDEX_SCHEMA_VERSION = 2;

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const galleryDir = join(web, 'static', 'gallery');
const inputsDir = join(galleryDir, 'inputs');
const indexPath = join(galleryDir, 'index.json');

const engineDir = process.env.HYPHAEON_ENGINE_DIR ?? resolve(repo, '..', 'HyphAeon');
const examplesDir = join(engineDir, 'examples');

const MODE = (process.env.HYPHAEON_PREBAKE ?? '').toLowerCase(); // '', 'skip', 'force'
const VARIANT = 'general';
const MAX_SPECIES = 256;
const PRUNE_DUPLICATES = true;
const SURFACE = 'node-server';
const NOTE = 'prebaked at build';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const force = MODE === 'force' || argv.includes('--force');

const log = (tag, msg) => console.log(`[prebake-gallery] ${tag}: ${msg}`);
const warn = (tag, msg) => console.warn(`[prebake-gallery] ${tag}: WARNING ${msg}`);

// -----------------------------------------------------------------------------------------------
// The catalogue. Descriptions are the README table's, verbatim.
// -----------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, name: string, gene: string, description: string, regime: string,
 *   alignment: string, tree: string|null, format: 'fasta'|'nexus',
 *   paper: {taxa: number, codons: number}, referenceRuntimeSec: number|null}} Dataset
 */

/** @type {Dataset[]} */
const DATASETS = [
	{
		id: 'Smc6',
		name: 'Smc6',
		gene: 'Structural maintenance of chromosomes 6',
		description: 'Primate Smc6 structural maintenance of chromosomes (antiviral host restriction).',
		regime: 'Primates · cross-species',
		alignment: 'Smc6.fasta',
		tree: 'Smc6.nwk',
		format: 'fasta',
		paper: { taxa: 20, codons: 1097 },
		referenceRuntimeSec: 3.5
	},
	{
		id: 'bat_oas1',
		name: 'Bat OAS1',
		gene: "2'-5'-oligoadenylate synthetase 1",
		description: "Chiropteran OAS1 2'-5'-oligoadenylate synthetase (innate immunity escape).",
		regime: 'Bats · cross-species',
		alignment: 'bat_oas1.fasta',
		tree: 'bat_oas1.nwk',
		format: 'fasta',
		paper: { taxa: 18, codons: 351 },
		referenceRuntimeSec: 1.7
	},
	{
		id: 'camelid',
		name: 'Camelid VHH',
		gene: 'Single-domain antibody heavy-chain variable domain',
		description: 'Camelid single-domain antibody heavy-chain variable domain (antigenic diversity).',
		regime: 'Camelids · antibody repertoire',
		alignment: 'camelid.fasta',
		tree: 'camelid.nwk',
		format: 'fasta',
		paper: { taxa: 212, codons: 96 },
		referenceRuntimeSec: 4.0
	},
	{
		id: 'HIV1_RT',
		name: 'HIV-1 RT',
		gene: 'Reverse transcriptase polymerase domain',
		description: 'Retroviral Reverse Transcriptase polymerase domain (drug resistance & epistasis).',
		regime: 'HIV-1 · within-host viral',
		alignment: 'HIV1_RT.fasta',
		tree: 'HIV1_RT.nwk',
		format: 'fasta',
		paper: { taxa: 476, codons: 335 },
		referenceRuntimeSec: 17.3
	},
	{
		id: 'RHO',
		name: 'Rhodopsin',
		gene: 'Rhodopsin visual pigment',
		description: 'Mammalian Rhodopsin visual pigments (deep-sea diving sensory adaptation).',
		regime: 'Mammals · cross-species, embedded tree',
		alignment: 'RHO.fasta',
		tree: null,
		format: 'nexus',
		paper: { taxa: 710, codons: 349 },
		referenceRuntimeSec: null
	}
];

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readText = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Wall seconds of `hyphaeon meme` on each example as recorded when the e2e fixtures were generated
 * (<engine>/fixtures/manifest.json `e2e_wall_seconds`, torch on CPU, the machine of PLAN.md §1's
 * table). Read at bake time so the cards quote the engine commit's own numbers; the catalogue's
 * `referenceRuntimeSec` (PLAN.md §1) is the fallback when the fixtures are absent.
 */
function referenceWallSeconds() {
	const p = join(engineDir, 'fixtures', 'manifest.json');
	if (!existsSync(p)) return {};
	try {
		const wall = readJson(p).e2e_wall_seconds ?? {};
		const out = {};
		for (const d of DATASETS) {
			const v = wall[`meme_${d.id}`];
			if (typeof v === 'number') out[d.id] = v;
		}
		return out;
	} catch {
		return {};
	}
}

const REFERENCE_WALL = referenceWallSeconds();

/** Short commit of the engine checkout, for the index; null when git is unavailable. */
function engineCommit() {
	try {
		const r = spawnSync('git', ['-C', engineDir, 'rev-parse', '--short', 'HEAD'], {
			encoding: 'utf8'
		});
		if (r.status === 0) return r.stdout.trim() || null;
	} catch {
		// fall through
	}
	return null;
}

/** The library's version, from its package.json, resolved the way the runtime resolves it. */
function libraryVersion() {
	for (const candidate of [
		join(repo, 'node_modules', '@veg', 'hyphaeon-js', 'package.json'),
		join(engineDir, 'js', 'package.json')
	]) {
		if (existsSync(candidate)) {
			try {
				return readJson(candidate).version ?? null;
			} catch {
				// try the next
			}
		}
	}
	return null;
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir).filter((f) => f.endsWith('.js'));
	} catch {
		return [];
	}
}

/**
 * Hash of the runtime sources whose behaviour the baked numbers depend on. When the pipeline
 * changes, a stamp mismatch rebakes; when only the page changes, nothing is rerun.
 */
function runtimeSourcesHash() {
	const dir = join(repo, 'runtime', 'src');
	const files = [
		'pipeline.js',
		'predict.js',
		'postprocess.js',
		'callModes.js',
		'feeds.js',
		'session-node.js',
		'createSession.js',
		'manifest.js'
	];
	const h = createHash('sha256');
	for (const f of files) {
		const p = join(dir, f);
		h.update(f);
		h.update(existsSync(p) ? readFileSync(p) : '');
	}
	// The HyPhy module, when it exists, decides the branch lengths of two examples.
	const hyphyDir = join(dir, 'hyphy');
	for (const f of readdirSafe(hyphyDir)) {
		h.update(f);
		h.update(readFileSync(join(hyphyDir, f)));
	}
	return h.digest('hex');
}

/** Copy the example inputs into static/gallery/inputs/, so the site serves them. */
function copyInputs() {
	mkdirSync(inputsDir, { recursive: true });
	let copied = 0;
	for (const d of DATASETS) {
		for (const f of [d.alignment, d.tree]) {
			if (!f) continue;
			const src = join(examplesDir, f);
			const dest = join(inputsDir, f);
			if (existsSync(src)) {
				if (!existsSync(dest) || sha256(readFileSync(src)) !== sha256(readFileSync(dest))) {
					copyFileSync(src, dest);
					copied += 1;
				}
			} else if (!existsSync(dest)) {
				warn('inputs', `${src} does not exist and ${dest} is absent; ${d.id} cannot be baked`);
			}
		}
	}
	log('inputs', `${copied} file(s) copied from ${examplesDir} (rest unchanged)`);
}

/** Read the existing index, or null. */
function readExistingIndex() {
	if (!existsSync(indexPath)) return null;
	try {
		const doc = readJson(indexPath);
		return doc && doc.schema_version === INDEX_SCHEMA_VERSION ? doc : null;
	} catch {
		return null;
	}
}

function inputsBlock(d) {
	const alignmentPath = join(inputsDir, d.alignment);
	const treePath = d.tree ? join(inputsDir, d.tree) : null;
	return {
		alignment: d.alignment,
		tree: d.tree,
		format: d.format,
		alignment_sha256: existsSync(alignmentPath) ? sha256(readFileSync(alignmentPath)) : null,
		tree_sha256: treePath && existsSync(treePath) ? sha256(readFileSync(treePath)) : null
	};
}

/**
 * The fields of an entry that come from the catalogue and the inputs rather than from a run.
 * Re-derived on every write, including for entries reused by stamp, so a description edit or a
 * new catalogue field never needs a rebake. `analyses` lists the pillars a prebaked result
 * exists for (the results route's `entries()` prerenders `/results/gallery/<id>/` for `meme`).
 */
function catalogueFields(d, inputs, hasResult) {
	return {
		id: d.id,
		name: d.name,
		gene: d.gene,
		description: d.description,
		regime: d.regime,
		paper: d.paper,
		reference_runtime_sec: REFERENCE_WALL[d.id] ?? d.referenceRuntimeSec,
		inputs,
		tree_source: d.tree ? 'file' : 'embedded',
		analyses: hasResult ? ['meme'] : []
	};
}

/** A `missing` entry: the catalogue row with no run behind it. */
function missingEntry(d, inputs, reason) {
	return {
		...catalogueFields(d, inputs, false),
		branch_lengths_estimated: false,
		branch_length_method: null,
		status: 'missing',
		error: reason,
		result: null,
		summary: null,
		prebake: null
	};
}

/** All five entries as `missing` with one reason; used when nothing can be baked. */
function allMissing(inputsById, reason) {
	return DATASETS.map((d) => missingEntry(d, inputsById[d.id], reason));
}

/** pandas `rank(pct=True) * 100` with average ties, as runtime/src/postprocess.js computes it. */
function percentileRanks(values) {
	const n = values.length;
	const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
	const ranks = new Float64Array(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
		const avg = (i + 1 + (j + 1)) / 2;
		for (let k = i; k <= j; k++) ranks[order[k]] = avg;
		i = j + 1;
	}
	for (let k = 0; k < n; k++) ranks[k] = (ranks[k] / n) * 100;
	return ranks;
}

/**
 * The numbers a card shows. The runtime's `summary` carries cli.py's own significance counts
 * (`sigSitesP05`, `fdrSitesQ10`, float32 comparisons as cmd_meme prints them) and the percentile
 * tier count (`calledSites`, top 5 % of variable sites under the default call mode); they are
 * used when present and recomputed from the site rows otherwise.
 */
function summarise(result, elapsedSec) {
	const rows = result.sites;
	const variable = rows.filter((r) => !r.is_invariable);
	const s = result.summary ?? {};
	const pre = result.provenance?.preprocessing ?? {};
	const count = (pred) => rows.filter(pred).length;
	const q10 = Number.isInteger(s.fdrSitesQ10) ? s.fdrSitesQ10 : count((r) => r.q_value <= Math.fround(0.1));
	const q05 = Number.isInteger(s.fdrSitesQ05) ? s.fdrSitesQ05 : count((r) => r.q_value <= Math.fround(0.05));
	const p05 = Number.isInteger(s.sigSitesP05) ? s.sigSitesP05 : count((r) => r.p_value <= Math.fround(0.05));
	let top5;
	if (Number.isInteger(s.calledSites) && (s.callMode ?? 'percentile') === 'percentile') {
		top5 = s.calledSites;
	} else {
		const pct = percentileRanks(variable.map((r) => r.hyphaeon_lrt));
		top5 = Array.from(pct).filter((x) => x >= 95).length;
	}
	return {
		taxa_in_alignment: pre.taxa_in_alignment ?? s.speciesInAlignment ?? null,
		taxa_used: pre.taxa_used ?? s.speciesUsed ?? result.taxa_count ?? null,
		codons: rows.length,
		variable_sites: variable.length,
		invariable_sites: rows.length - variable.length,
		max_lrt: rows.reduce((m, r) => Math.max(m, Number(r.hyphaeon_lrt) || 0), 0),
		called: { q_le_0_10: q10, q_le_0_05: q05, p_le_0_05: p05, top_5pct: top5 },
		runtime_sec: Number(elapsedSec.toFixed(3))
	};
}

/**
 * Drop the per-site matrices from a runMeme result and turn typed arrays into plain arrays and
 * Maps into objects so JSON.stringify keeps them. `loaded` is non-enumerable on the result and
 * therefore never serialised.
 */
function serialisable(result) {
	const out = { ...result };
	delete out.attention;
	delete out.root_repr;
	return JSON.parse(
		JSON.stringify(out, (_k, v) => {
			if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v);
			if (typeof v === 'bigint') return Number(v);
			if (v instanceof Map) return Object.fromEntries(v);
			return v;
		})
	);
}

/**
 * `extract_tree_from_string_or_file`'s first branch (dataset.py:161-212, tree.js extractTree) on
 * the TEXT: the Newick of a NEXUS `TREE name = (...);` command, HyPhy `{...}` tags and `[...]`
 * comments removed, or null. The library returns a parsed PhyloTree and has no Newick writer, and
 * the results page wants the string, so the string is taken from the same place the parser takes
 * it.
 */
function embeddedNewick(text) {
	const m = /tree\s+[^=]+=\s*(\([^;]+;)/iu.exec(text);
	if (!m) return null;
	return m[1].replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '').trim();
}

/**
 * The selected taxa and their aligned sequences, in the order the model saw them, for the
 * results page's entropy overlays, spark bars and site tree (results/types.ts AlignmentBlock).
 * `result.loaded` is the library's LoadedAlignment the run used (non-enumerable on the result).
 */
function alignmentBlock(lib, result, alignmentText) {
	const taxa = result.loaded?.taxa;
	if (!Array.isArray(taxa)) return null;
	const seqs = lib.parseAlignmentSequences(alignmentText);
	return { names: taxa, sequences: taxa.map((t) => seqs.get(t) ?? '') };
}

// -----------------------------------------------------------------------------------------------
// Runtime glue: models, the HyPhy estimator, the record
// -----------------------------------------------------------------------------------------------

/** Where the graphs are: what copy-assets vendored into static/, else the engine checkout. */
function modelsDir() {
	for (const candidate of [join(web, 'static', 'models'), join(engineDir, 'models')]) {
		if (existsSync(join(candidate, 'manifest.json'))) return candidate;
	}
	return null;
}

/**
 * The runtime's HyPhy branch-length estimator (runtime/src/hyphy/index.js): `createHyPhy()`
 * loads HyPhy WASM 2.5.98 from runtime/vendor/hyphy/<version>/ under Node and returns a handle
 * whose `estimateBranchLengths(alignmentFasta, newick)` runs axomeme3's HKY85 script (the same
 * model dataset.py:224-287 runs through native HyPhy) and resolves `{result: newick}`. The
 * handle is created lazily, on the first tree that needs it, so the three examples with branch
 * lengths never pay the ~5 MB load. Looked up by the package export first, then by file, so
 * this script does not pin the module's final path; a module exporting a plain
 * `estimateBranchLengths(alignmentText, treeText)` function is accepted too. Returns null when
 * absent, in which case `runMeme` takes the reference's "HyPhy not found" branch.
 */
async function loadBranchLengthEstimator() {
	const candidates = [
		'@veg/hyphaeon-runtime/hyphy',
		pathToFileURL(join(repo, 'runtime', 'src', 'hyphy', 'index.js')).href
	];
	for (const spec of candidates) {
		let mod;
		try {
			mod = await import(spec);
		} catch (err) {
			const notFound =
				err?.code === 'ERR_MODULE_NOT_FOUND' ||
				err?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ||
				/Cannot find (module|package)/.test(String(err?.message));
			if (!notFound) warn('hyphy', `${spec} failed to load: ${err?.message ?? err}`);
			continue;
		}
		if (typeof mod.createHyPhy === 'function') {
			let handle = null;
			const fn = async (alignmentText, treeText) => {
				if (!handle) {
					const t0 = performance.now();
					handle = await mod.createHyPhy();
					log('hyphy', `HyPhy WASM ${handle.version} loaded in ${secs(performance.now() - t0)}`);
				}
				const r = await handle.estimateBranchLengths(alignmentText, treeText);
				return {
					treeText: r.result,
					source: 'hyphy-hky85',
					hyphy: mod.HYPHY_VERSION_STRING ?? `HyPhy WASM ${handle.version}`,
					elapsedMs: r.elapsedMs
				};
			};
			log('hyphy', `branch-length estimator: createHyPhy from ${spec}`);
			return { fn, spec: `${spec}#createHyPhy` };
		}
		const fn = mod.estimateBranchLengths ?? mod.default?.estimateBranchLengths;
		if (typeof fn === 'function') {
			log('hyphy', `branch-length estimator: ${spec}`);
			return { fn, spec };
		}
	}
	return null;
}

/**
 * `runMeme`'s `options.estimateTree(alignmentText, treeText)` over the estimator, recording the
 * text it produced. The estimator's own signature is the tree-tools agent's; the shapes it is most
 * likely to return — a string, `{treeText}`, `{newick}`, `{tree}` — are all accepted and passed on
 * as `{treeText, source: 'hyphy-hky85'}`, which is what `prepareRun` records.
 */
function estimateTreeHook(estimator, d, capture) {
	return async (alignmentText, treeText) => {
		const t0 = performance.now();
		log(d.id, 'tree has no branch lengths; fitting HKY85 through the runtime HyPhy module');
		let out;
		try {
			out = await estimator.fn(alignmentText, treeText, {
				surface: SURFACE,
				hyphyDir: join(web, 'static', 'wasm', 'hyphy'),
				label: d.id
			});
		} catch (err) {
			try {
				out = await estimator.fn({ alignmentText, treeText });
			} catch (err2) {
				throw new Error(`branch-length estimation failed: ${err?.message ?? err} / ${err2?.message ?? err2}`);
			}
		}
		const text =
			typeof out === 'string' ? out : (out?.treeText ?? out?.newick ?? out?.tree ?? out?.text ?? null);
		if (typeof text !== 'string' || !text.trim()) {
			throw new Error('branch-length estimator returned no tree text');
		}
		const source = (typeof out === 'object' && (out?.source ?? out?.treeSource)) || 'hyphy-hky85';
		capture.treeText = text.trim();
		capture.source = String(source);
		capture.elapsedSec = (performance.now() - t0) / 1000;
		capture.details =
			typeof out === 'object' && out
				? Object.fromEntries(
						Object.entries(out).filter(
							([k, v]) => !['treeText', 'newick', 'tree', 'text'].includes(k) && typeof v !== 'function'
						)
					)
				: null;
		log(d.id, `branch lengths fitted (${capture.source}) in ${capture.elapsedSec.toFixed(1)} s`);
		return { treeText: capture.treeText, source: capture.source };
	};
}

/**
 * The gallery record: the runtime's result IS the document (see the header), with `tree` and
 * `alignment` added for the results page and the api.ts envelope fields beside it.
 */
function makeRecord(d, inputs, result, options, meta) {
	const createdAt = Date.now();
	const iso = new Date(createdAt).toISOString();
	return {
		// ResultRecord envelope (web/src/lib/api.ts), flattened.
		id: `gallery/${d.id}`,
		createdAt,
		createdAtIso: iso,
		created_at: iso,
		name: d.name,
		source: 'gallery',
		inputs: {
			alignment: {
				name: d.alignment,
				size: Buffer.byteLength(meta.alignmentText, 'utf8'),
				sha256: inputs.alignment_sha256,
				path: `inputs/${d.alignment}`,
				format: d.format
			},
			tree: d.tree
				? {
						name: d.tree,
						size: Buffer.byteLength(meta.treeText ?? '', 'utf8'),
						sha256: inputs.tree_sha256,
						path: `inputs/${d.tree}`
					}
				: null,
			treeSource: meta.treeSource,
			demo: d.id
		},
		options: {
			variant: options.variant,
			maxSpecies: options.maxSpecies,
			referenceSequence: null,
			callMode: 'percentile',
			filter: false,
			attribute: false,
			pruneDuplicates: options.pruneDuplicates
		},
		steps: meta.steps,
		diagnostics: null,
		runtime: {
			numThreads: meta.threads,
			crossOriginIsolated: false,
			hardwareConcurrency: availableParallelism(),
			wallMs: Math.round(meta.elapsedSec * 1000),
			surface: SURFACE,
			node: process.version
		},
		gallery: {
			gene: d.gene,
			description: d.description,
			regime: d.regime,
			paper: d.paper,
			tree_source: d.tree ? 'file' : 'embedded',
			branch_lengths_estimated: meta.branchLengthsEstimated,
			branch_length_method: meta.branchLengthMethod,
			summary: meta.summary
		},
		// MemeRecord (results/types.ts): the runtime's result, plus the tree and alignment it used.
		...result,
		method: result.method ?? 'meme',
		tree: meta.treeUsed,
		alignment: meta.alignment
	};
}

// -----------------------------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------------------------

async function main() {
	mkdirSync(galleryDir, { recursive: true });
	copyInputs();

	const existing = readExistingIndex();
	const inputsById = Object.fromEntries(DATASETS.map((d) => [d.id, inputsBlock(d)]));
	const keepOrMissing = (reason) => {
		if (!existing) writeIndex(allMissing(inputsById, reason), null, null);
		else log('index', `keeping the existing index (${reason})`);
	};

	if (MODE === 'skip') {
		log('mode', 'HYPHAEON_PREBAKE=skip: not scoring');
		keepOrMissing('prebake skipped');
		return;
	}

	// --- runtime and model -------------------------------------------------------------------
	const models = modelsDir();
	if (!models) {
		warn('models', 'no models/manifest.json under web/static/models or the engine checkout; cannot bake');
		keepOrMissing('no model manifest');
		return;
	}

	let runtime;
	let nodeSession;
	try {
		runtime = await import('@veg/hyphaeon-runtime');
		nodeSession = await import('@veg/hyphaeon-runtime/node');
	} catch (err) {
		warn('runtime', `@veg/hyphaeon-runtime could not be imported (${err?.message ?? err}); cannot bake`);
		keepOrMissing(`runtime unavailable: ${err?.message ?? err}`);
		return;
	}
	const { runMeme, loadManifest, pickVariant, modelLocation } = runtime;
	if (typeof runMeme !== 'function') {
		warn('runtime', 'runtime exports no runMeme; cannot bake');
		keepOrMissing('runMeme absent from the runtime');
		return;
	}

	const manifest = await loadManifest(join(models, 'manifest.json'));
	const variant = pickVariant(manifest, VARIANT);
	const modelPath = modelLocation(models, manifest, VARIANT);
	const threads = Math.max(
		1,
		Number(process.env.HYPHAEON_PREBAKE_THREADS) || Math.min(8, availableParallelism())
	);

	let session;
	const tLoad = performance.now();
	try {
		session = await nodeSession.loadSession({
			modelPath,
			expectedSha256: variant.onnxSha256,
			threads
		});
	} catch (err) {
		warn('session', `onnxruntime-node could not load ${modelPath}: ${err?.message ?? err}`);
		keepOrMissing(`session failed to load: ${err?.message ?? err}`);
		return;
	}
	log(
		'session',
		`${VARIANT} (${variant.onnxSha256.slice(0, 12)}…) loaded in ${secs(performance.now() - tLoad)}, ${threads} thread(s), verified=${session.verified}`
	);

	const lib = await import('@veg/hyphaeon-js');
	const estimator = await loadBranchLengthEstimator();
	if (!estimator) {
		log('hyphy', 'no runtime branch-length estimator found; trees without lengths take the library defaults');
	}

	const libVersion = libraryVersion();
	const sourcesHash = runtimeSourcesHash();
	const options = { variant: VARIANT, maxSpecies: MAX_SPECIES, pruneDuplicates: PRUNE_DUPLICATES };

	// --- each example --------------------------------------------------------------------------
	const entries = [];
	const timings = [];
	for (const d of DATASETS) {
		const inputs = inputsById[d.id];
		const previous = existing?.entries?.find((e) => e.id === d.id) ?? null;
		if (only && d.id !== only) {
			entries.push(
				previous
					? { ...previous, ...catalogueFields(d, inputs, previous.status === 'ok') }
					: missingEntry(d, inputs, `skipped by --only ${only}`)
			);
			continue;
		}
		const alignmentPath = join(inputsDir, d.alignment);
		if (!existsSync(alignmentPath)) {
			entries.push(missingEntry(d, inputs, `${d.alignment} not found`));
			continue;
		}
		const alignmentText = readText(alignmentPath);
		const treeText = d.tree ? readText(join(inputsDir, d.tree)) : null;

		const stamp = sha256(
			JSON.stringify({
				script: SCRIPT_VERSION,
				inputs,
				model: variant.onnxSha256,
				options,
				library: libVersion,
				runtime: sourcesHash,
				estimator: estimator?.spec ?? null
			})
		);
		const resultFile = `${d.id}.json`;
		if (
			!force &&
			previous?.status === 'ok' &&
			previous.prebake?.stamp === stamp &&
			existsSync(join(galleryDir, resultFile))
		) {
			log(d.id, `up to date (stamp ${stamp.slice(0, 12)}…); reusing`);
			entries.push({ ...previous, ...catalogueFields(d, inputs, true) });
			continue;
		}

		log(d.id, `scoring ${d.paper.taxa} × ${d.paper.codons} (cap ${MAX_SPECIES}, ${VARIANT})…`);
		const t0 = performance.now();
		const estimation = { treeText: null, source: null, elapsedSec: null, details: null };
		/** StepRecord[] (api.ts): one per pipeline phase, with wall milliseconds. */
		const steps = [];
		let lastPhase = null;
		let phaseStart = t0;
		const progress = (phase, done, total, message) => {
			if (phase !== lastPhase) {
				const t = performance.now();
				const prev = steps[steps.length - 1];
				if (prev && prev.id === lastPhase && prev.status === 'active') {
					prev.status = 'done';
					prev.elapsedMs = Math.round(t - phaseStart);
				}
				phaseStart = t;
				lastPhase = phase;
				steps.push({ id: phase, label: phase, status: 'active', message, elapsedMs: null, done, total });
				log(d.id, `  ${phase}: ${message}`);
			} else if (phase === 'infer' && total > 0 && done === total) {
				log(d.id, `  infer: ${done}/${total}`);
			}
			const cur = steps[steps.length - 1];
			if (cur && cur.id === phase) {
				cur.message = message;
				cur.done = done;
				cur.total = total;
			}
		};

		let result;
		try {
			result = await runMeme({
				alignmentText,
				treeText,
				options: {
					maxSpecies: MAX_SPECIES,
					pruneDuplicates: PRUNE_DUPLICATES,
					alignmentName: d.alignment,
					treeName: d.tree ?? undefined,
					...(estimator ? { estimateTree: estimateTreeHook(estimator, d, estimation) } : {})
				},
				session,
				surface: SURFACE,
				provenance: {
					model_version: manifest.model_version ?? null,
					model_variant: VARIANT,
					artifact_sha256: session.sha256 ?? variant.onnxSha256,
					hyphaeon_js_version: libVersion,
					reference_version: manifest.reference_version ?? null,
					seed: manifest.prng?.default_seed ?? null
				},
				progress
			});
		} catch (err) {
			const elapsed = (performance.now() - t0) / 1000;
			warn(d.id, `run failed after ${elapsed.toFixed(1)} s: ${err?.stack ?? err}`);
			entries.push({ ...missingEntry(d, inputs, String(err?.message ?? err)), status: 'failed' });
			timings.push({ id: d.id, seconds: elapsed, status: 'failed' });
			continue;
		}
		const elapsed = (performance.now() - t0) / 1000;
		{
			const last = steps[steps.length - 1];
			if (last && last.status === 'active') {
				last.status = 'done';
				last.elapsedMs = Math.round(performance.now() - phaseStart);
			}
		}
		if (estimation.treeText) {
			steps.splice(steps.findIndex((s) => s.id === 'infer'), 0, {
				id: 'branch-lengths',
				label: 'Branch lengths (HyPhy HKY85)',
				status: 'done',
				message: estimation.source,
				elapsedMs: Math.round((estimation.elapsedSec ?? 0) * 1000)
			});
		}

		// What happened to the tree, as the runtime recorded it.
		const pre = result.provenance?.preprocessing ?? {};
		const treeSource = pre.tree_source ?? (treeText === null ? 'embedded' : 'user');
		const branchLengthsEstimated = Boolean(pre.branch_lengths_estimated);
		const branchLengthMethod = branchLengthsEstimated
			? 'hyphy-hky85'
			: pre.branch_lengths_missing
				? 'library-default'
				: null;
		const treeUsed =
			estimation.treeText ?? (treeText === null ? embeddedNewick(alignmentText) : treeText.trim());

		// Provenance the pipeline cannot know: that this run was a build step, and the estimator's
		// own report. Added, never overwritten.
		result.provenance ??= {};
		result.provenance.note ??= NOTE;
		result.provenance.preprocessing ??= {};
		if (branchLengthMethod) result.provenance.preprocessing.branch_length_method = branchLengthMethod;
		if (estimation.details) result.provenance.preprocessing.branch_length_estimation = estimation.details;

		const summary = summarise(result, elapsed);
		let alignment = null;
		try {
			alignment = alignmentBlock(lib, result, alignmentText);
		} catch (err) {
			warn(d.id, `alignment block not recorded: ${err?.message ?? err}`);
		}
		const record = makeRecord(d, inputs, serialisable(result), options, {
			alignmentText,
			treeText,
			treeUsed,
			treeSource,
			alignment,
			branchLengthsEstimated,
			branchLengthMethod,
			summary,
			steps,
			threads,
			elapsedSec: elapsed
		});
		writeFileSync(join(galleryDir, resultFile), JSON.stringify(record) + '\n');

		entries.push({
			...catalogueFields(d, inputs, true),
			branch_lengths_estimated: branchLengthsEstimated,
			branch_length_method: branchLengthMethod,
			status: 'ok',
			result: resultFile,
			summary,
			prebake: {
				at: new Date().toISOString(),
				surface: SURFACE,
				node: process.version,
				threads,
				artifact_verified: Boolean(session.verified),
				stamp
			}
		});
		timings.push({ id: d.id, seconds: elapsed, status: 'ok', summary });
		log(
			d.id,
			`done in ${elapsed.toFixed(1)} s — ${summary.taxa_used}/${summary.taxa_in_alignment} taxa × ${summary.codons} codons, ` +
				`${summary.variable_sites} variable, q≤0.10: ${summary.called.q_le_0_10}, p≤0.05: ${summary.called.p_le_0_05}, ` +
				`top 5%: ${summary.called.top_5pct}, max LRT ${summary.max_lrt.toFixed(3)}, tree ${treeSource}` +
				(branchLengthMethod ? ` (${branchLengthMethod})` : '')
		);
	}

	writeIndex(entries, { manifest, variant, session }, { libVersion, options });

	if (timings.length) {
		console.log('\n[prebake-gallery] timings:');
		for (const t of timings) {
			console.log(`  ${t.id.padEnd(10)} ${t.seconds.toFixed(1).padStart(7)} s  ${t.status}`);
		}
		console.log(`  total     ${timings.reduce((a, t) => a + t.seconds, 0).toFixed(1).padStart(7)} s`);
	}
}

function writeIndex(entries, model, meta) {
	const index = {
		schema_version: INDEX_SCHEMA_VERSION,
		generated_at: new Date().toISOString(),
		engine: {
			commit: engineCommit(),
			reference_version: model?.manifest?.reference_version ?? null,
			hyphaeon_js_version: meta?.libVersion ?? libraryVersion()
		},
		model: {
			model_version: model?.manifest?.model_version ?? null,
			variant: VARIANT,
			artifact_sha256: model?.session?.sha256 ?? model?.variant?.onnxSha256 ?? null
		},
		options: meta?.options ?? { variant: VARIANT, maxSpecies: MAX_SPECIES, pruneDuplicates: PRUNE_DUPLICATES },
		entries
	};
	writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
	const ok = entries.filter((e) => e.status === 'ok').length;
	log('index', `wrote ${indexPath} (${ok}/${entries.length} entries with results)`);
}

main().catch((err) => {
	// A prebake failure must not take the build down: the page still has an index to read.
	console.error(`[prebake-gallery] FAILED: ${err?.stack ?? err}`);
	if (!existsSync(indexPath)) {
		writeIndex(
			allMissing(Object.fromEntries(DATASETS.map((d) => [d.id, inputsBlock(d)])), String(err?.message ?? err)),
			null,
			null
		);
	}
	process.exitCode = 0;
});
