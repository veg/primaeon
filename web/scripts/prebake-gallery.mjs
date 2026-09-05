/**
 * prebake-gallery.mjs — run EVERY analysis on the bundled examples under Node and write the
 * reports the landing page's example chips open at /report/gallery/<name>/.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 / D21: the only user action is uploading a dataset, and one
 * report fills in as the analyses finish. The five README examples are the same product with the
 * work already done: §4.1 says "gallery reports are prebaked", and §6 takes the "prebake at build"
 * pattern from datamonkey-metrics, so that the first thing a visitor opens costs no model download
 * and no inference, and shows the numbers THIS build's runtime produces (not the Python reference's
 * stale example outputs, PLAN.md §2 item 9). The web `prebuild` step, after scripts/copy-assets.mjs
 * has vendored the graphs, therefore runs the runtime's `runEverything` — the orchestrator the
 * browser worker, the MCP's `hyphaeon_analyze` and the job server all wrap — on each example under
 * onnxruntime-node, and writes:
 *
 *   web/static/gallery/inputs/<name>.fasta|.nwk   the inputs, copied from HyphAeon/examples/
 *   web/static/gallery/<name>.json                 one ReportRecord (schema_version 2) per example
 *   web/static/gallery/index.json                  schema_version 3: per example the dimensions,
 *                                                  called sites, gene verdict, epistasis edge and
 *                                                  sector counts, DMS coverage and timings
 *
 * THE EXAMPLES come from web/src/lib/gallery/examples.json (the README table, shared with the
 * landing page). RHO is NEXUS with its tree embedded and is run with treeText null, as
 * `hyphaeon meme -a RHO.fasta` is. camelid.nwk and HIV1_RT.nwk carry no branch lengths, where
 * dataset.py:601-611 shells out to HyPhy's HKY85 fit; here that fit is HyPhy WASM 2.5.98 under
 * Node through runtime/src/hyphy (the same driver the browser's tree worker uses), run BEFORE
 * `runEverything` the way web/src/lib/analyze/run.ts runs it before inference, and the fitted tree
 * is what the orchestrator is given (`treeSource: 'hyphy-hky85'`). Which happened is written to
 * the index as `branch_length_method`, so nobody reads a default-length result as an estimated one.
 *
 * OPTIONS ARE THE APP'S DEFAULTS, on purpose (the report's "Re-run with…" starts from them):
 * variant `general` (D10), taxon cap 256 (manifest `default_taxon_cap`), duplicate pruning on,
 * percentile call mode, seed 42 (manifest `prng.default_seed`; `hyphaeon epistasis --seed`),
 * B = 1000 permutations for the sector null (the CLI's own default; PHASE2A.md measured ±0.03 of
 * Monte Carlo error on `p_perm` at that B — the report must not print it to three decimals), and
 * the digital DMS enabled under the runtime's default work budget. HIV1_RT (476 taxa) and RHO
 * (710) are Faith's-PD subsampled to 256 here where the reference fixtures ran uncapped, so a
 * parity comparison against fixtures/e2e/*_HIV1_RT.json / *_RHO.json is not meaningful for those
 * two; Smc6, bat_oas1 and camelid are under the cap and comparable.
 *
 * THE RECORD is the orchestrator's ReportRecord as returned, serialised (typed arrays → arrays,
 * Maps → objects), with the envelope fields web/src/lib/api.ts `ReportRecord` declares written
 * beside them (`id: gallery/<name>`, `createdAt`, `name`, `inputs` with sizes and hashes, `status`
 * done, `runtime`) so a gallery entry and a stored browser run read alike on the report page, plus
 * a `gallery` block with the catalogue row and the index summary. Two additions for the page:
 * `sections.sites.tree` (the Newick actually used) and `sections.sites.alignment` (the selected
 * taxa and sequences, for the site tree and the entropy overlays) are filled in when the runtime
 * did not already; a browser run keeps them the same way. The per-site attention and root_repr
 * matrices, and any `loaded` tensor bundle, are never written (nothing on the page reads them and
 * HIV1_RT's attention alone would be 1.5 MB). `inputs.alignmentText` is not written either — the
 * inputs are served beside the record and the report's re-run fetches them from there.
 *
 * SIZE. Each record must stay under ~3 MB (task rule; the page loads one per view). Measured
 * sizes are printed at the end of a run. Should a record exceed HYPHAEON_PREBAKE_SIZE_LIMIT_MB
 * (default 3), two reductions apply in order, each recorded in `prebake.storage` so the page can
 * say so: first, lossless, the DMS section's `selection_dms_plasticity` is dropped when it is a
 * copy of `plasticity` (the reference binds one list to both keys, so every DMS row is otherwise
 * stored twice; the page reads `plasticity`); then, if still over, the DMS `mutant_deltas` — 19
 * float32 ΔLRTs per site, the bulk of any record — are rounded to HYPHAEON_PREBAKE_DMS_DIGITS
 * significant digits (default 6; float32 carries ~7.2, so the heatmap loses nothing visible).
 * Nothing else is downsampled.
 *
 * PROVENANCE. `surface: "node-server"` (this is the Node runtime; PLAN.md §3.5's list has no
 * "build" surface) with `note: "prebaked at build"` added to the provenance so a reader of the
 * record knows it was not produced by a request.
 *
 * FRESHNESS. The full bake takes minutes (the DMS on the two 256-taxon examples dominates), and
 * `npm run build` must not pay that when nothing changed. Each entry records a `stamp`: sha256 over
 * the inputs, the graph hashes, the options, the library version, every source file under
 * runtime/src (the orchestrator, the pipelines, the HyPhy driver) and this script's version. A
 * matching stamp with the result file present is reused. HYPHAEON_PREBAKE=force (or --force)
 * rebakes everything; HYPHAEON_PREBAKE=skip writes nothing (a CI job without onnxruntime-node
 * bindings keeps the committed index); `--only <id>` restricts to one example. A machine where
 * onnxruntime-node cannot load (the 1.23.2 darwin/x64 pin under Rosetta, PHASE0.md item 7), or a checkout whose
 * runtime has no `runEverything` yet, gets a warning and whatever index already exists — or one
 * whose entries are all `status: "missing"` so the report route's prerender still has a document
 * to read — never a failed build.
 *
 * THREADS. onnxruntime-node's intra-op threads default to 1 in session-node.js (one worker among
 * many on a shared box). A build is alone on its machine, so this script asks for
 * min(8, availableParallelism) unless HYPHAEON_PREBAKE_THREADS says otherwise. Sessions are
 * released before exit (`releaseSessions`: onnxruntime-node 1.23.2 aborts at exit with a live
 * session, measured in PHASE1.md's integration notes).
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// -----------------------------------------------------------------------------------------------
// Paths and knobs
// -----------------------------------------------------------------------------------------------

/** Bump when the record or index shape written here changes; part of every entry's stamp. */
const SCRIPT_VERSION = 5;
/** Must equal `schema_version` in web/src/lib/gallery/types.ts `GalleryIndex`. */
const INDEX_SCHEMA_VERSION = 3;
/** The orchestrator contract's ReportRecord version. */
const REPORT_SCHEMA_VERSION = 2;

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const galleryDir = join(web, 'static', 'gallery');
const inputsDir = join(galleryDir, 'inputs');
const indexPath = join(galleryDir, 'index.json');
const cataloguePath = join(web, 'src', 'lib', 'gallery', 'examples.json');

const engineDir = process.env.HYPHAEON_ENGINE_DIR ?? resolve(repo, '..', 'HyphAeon');
const examplesDir = join(engineDir, 'examples');

const MODE = (process.env.HYPHAEON_PREBAKE ?? '').toLowerCase(); // '', 'skip', 'force'
const SURFACE = 'node-server';
const NOTE = 'prebaked at build';

/**
 * The app's defaults (see the header). `dms.workBudget` is null here and filled from the runtime's
 * `REPORT_DEFAULTS.dms.workBudget` once it is imported (`resolveOptions`), so the index records the
 * budget the bake was judged against and a budget change upstream changes the stamp.
 */
const OPTIONS = Object.freeze({
	variant: 'general',
	maxSpecies: 256,
	referenceSequence: null,
	callMode: 'percentile',
	seed: 42,
	dms: Object.freeze({ enabled: true, workBudget: null }),
	permutations: 1000,
	pruneDuplicates: true
});

/** OPTIONS with the runtime's own DMS budget filled in (runtime/src/analyze.js REPORT_DEFAULTS). */
function resolveOptions(runtime) {
	const budget = runtime?.REPORT_DEFAULTS?.dms?.workBudget ?? runtime?.DMS_WORK_BUDGET_DEFAULT ?? null;
	return { ...OPTIONS, dms: { enabled: true, ...(budget != null ? { workBudget: budget } : {}) } };
}

const SIZE_LIMIT_BYTES = Math.max(0.5, Number(process.env.HYPHAEON_PREBAKE_SIZE_LIMIT_MB) || 3) * 1024 * 1024;
const DMS_DIGITS = Math.max(3, Number(process.env.HYPHAEON_PREBAKE_DMS_DIGITS) || 6);

/** Keys never written: model-internal matrices and tensor bundles nothing on the page reads. */
const STRIPPED_KEYS = new Set(['attention', 'root_repr', 'mean_root_attns', 'leafAttributions', 'leaf_attributions', 'loaded']);

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const force = MODE === 'force' || argv.includes('--force');

const log = (tag, msg) => console.log(`[prebake-gallery] ${tag}: ${msg}`);
const warn = (tag, msg) => console.warn(`[prebake-gallery] ${tag}: WARNING ${msg}`);

// -----------------------------------------------------------------------------------------------
// The catalogue (web/src/lib/gallery/examples.json, shared with the landing page)
// -----------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, name: string, gene: string, description: string, regime: string,
 *   alignment: string, tree: string|null, format: 'fasta'|'nexus',
 *   paper: {taxa: number, codons: number}, reference_runtime_sec: number|null}} Dataset
 */

/** @type {Dataset[]} */
const DATASETS = JSON.parse(readFileSync(cataloguePath, 'utf8')).examples;

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readText = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

/**
 * Wall seconds of `hyphaeon meme` on each example as recorded when the e2e fixtures were generated
 * (<engine>/fixtures/manifest.json `e2e_wall_seconds`, torch on CPU). Read at bake time so the
 * index quotes the engine commit's own numbers; the catalogue's `reference_runtime_sec` (PLAN.md
 * §1) is the fallback when the fixtures are absent.
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
		const r = spawnSync('git', ['-C', engineDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
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

/** Every .js file under a directory, sorted, as repo-relative paths. */
function sourceFiles(dir) {
	const out = [];
	const walk = (d) => {
		let names;
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.bf')) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/**
 * Hash of every runtime source the baked numbers depend on: the orchestrator, the pipelines, the
 * session loaders, the HyPhy driver and its HBL scripts. When any changes, a stamp mismatch
 * rebakes; when only a page changes, nothing is rerun.
 */
function runtimeSourcesHash() {
	const h = createHash('sha256');
	for (const p of sourceFiles(join(repo, 'runtime', 'src'))) {
		h.update(relative(repo, p));
		h.update(readFileSync(p));
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

/** Read the existing index, or null when absent or of another schema. */
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
 * Re-derived on every write, including for entries reused by stamp, so a description edit never
 * needs a rebake.
 */
function catalogueFields(d, inputs, analyses) {
	return {
		id: d.id,
		name: d.name,
		gene: d.gene,
		description: d.description,
		regime: d.regime,
		alignment: d.alignment,
		tree: d.tree,
		format: d.format,
		paper: d.paper,
		reference_runtime_sec: REFERENCE_WALL[d.id] ?? d.reference_runtime_sec,
		inputs,
		tree_source: d.tree ? 'file' : 'embedded',
		analyses
	};
}

/** A `missing` entry: the catalogue row with no run behind it. */
function missingEntry(d, inputs, reason) {
	return {
		...catalogueFields(d, inputs, []),
		branch_lengths_estimated: false,
		branch_length_method: null,
		status: 'missing',
		error: reason,
		result: null,
		summary: null,
		prebake: null
	};
}

/** All entries as `missing` with one reason; used when nothing can be baked. */
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
 * The `sites` part of the index summary. The runtime's `summary` carries cli.py's own significance
 * counts (`sigSitesP05`, `fdrSitesQ10`, float32 comparisons as cmd_meme prints them) and the
 * percentile tier count (`calledSites`, top 5 % of variable sites under the default call mode);
 * they are used when present and recomputed from the site rows otherwise.
 */
function summariseSites(sites) {
	const rows = sites?.sites ?? [];
	if (rows.length === 0) return null;
	const variable = rows.filter((r) => !r.is_invariable);
	const s = sites.summary ?? {};
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
		variable_sites: variable.length,
		invariable_sites: rows.length - variable.length,
		max_lrt: rows.reduce((m, r) => Math.max(m, Number(r.hyphaeon_lrt) || 0), 0),
		called: { q_le_0_10: q10, q_le_0_05: q05, p_le_0_05: p05, top_5pct: top5 }
	};
}

/**
 * The gene verdict shown on a chip's overview is APP-SIDE: `selection` when the ACAT-combined p
 * (cli.py:486-505 `p_value_acat`, the statistical bridge) is ≤ 0.05, else `no-evidence`. The
 * neural head's `positive_selection_detected` is not used — it is one seeded draw of an unseeded,
 * incomplete head upstream (runtime/src/busted.js) and not reproducible against the reference.
 */
function summariseGene(gene) {
	const r = gene?.record;
	if (!r) return null;
	const pAcat = typeof r.p_value_acat === 'number' ? r.p_value_acat : null;
	return {
		verdict: pAcat === null ? null : pAcat <= 0.05 ? 'selection' : 'no-evidence',
		p_value_acat: pAcat,
		p_value_simes: typeof r.p_value_simes === 'number' ? r.p_value_simes : null,
		omnibus_lrt: typeof r.omnibus_lrt === 'number' ? r.omnibus_lrt : null,
		sig_sites_p05: Number.isInteger(r.sig_sites_p05) ? r.sig_sites_p05 : null,
		sig_sites_p10: Number.isInteger(r.sig_sites_p10) ? r.sig_sites_p10 : null
	};
}

function summariseEpistasis(epistasis, options) {
	if (!epistasis) return null;
	const edges = Array.isArray(epistasis.edges) ? epistasis.edges : (epistasis.coselection_edges ?? []);
	const sectors = Array.isArray(epistasis.sectors) ? epistasis.sectors : (epistasis.epistatic_sectors ?? []);
	return {
		edges: edges.length,
		sectors: sectors.length,
		significant_sectors: sectors.filter((s) => typeof s.p_perm === 'number' && s.p_perm <= 0.05).length,
		// runtime/src/epistasis.js records B under `permutations.n`; the CLI document has no such key.
		permutations: epistasis.permutations?.n ?? epistasis.n_permutations ?? options?.permutations ?? OPTIONS.permutations
	};
}

/**
 * runtime/src/dms.js's payload: `plasticity` so far, `progress {done, total}`, and the app-side
 * flags `skipped` (over the work budget: nothing ran), `capped` (the budget stopped a partial
 * sweep), `cancelled`, with `work` / `budget` beside them.
 */
function summariseDms(dms, codons, options) {
	if (!dms) return null;
	const swept = Array.isArray(dms.plasticity) ? dms.plasticity.length : (dms.progress?.done ?? 0);
	const total = dms.progress?.total ?? codons ?? swept;
	const cancelled = Boolean(dms.cancelled);
	const skipped = Boolean(dms.skipped);
	const capped = Boolean(dms.capped);
	return {
		sites_swept: swept,
		sites_total: total,
		coverage: total > 0 ? Number((swept / total).toFixed(4)) : 0,
		complete: !cancelled && !skipped && !capped && total > 0 && swept >= total,
		cancelled,
		skipped,
		capped,
		work: typeof dms.work === 'number' ? dms.work : null,
		work_budget: typeof dms.budget === 'number' ? dms.budget : (options?.dms?.workBudget ?? null)
	};
}

/** The index summary for one baked report (see web/src/lib/gallery/types.ts GallerySummary). */
function summarise(report, elapsedSec) {
	const sections = report.sections ?? {};
	const pre = report.provenance?.preprocessing ?? sections.sites?.provenance?.preprocessing ?? {};
	const rows = sections.sites?.sites ?? [];
	const codons =
		rows.length ||
		sections.gene?.record?.sites ||
		(sections.dms?.total_mutations ? sections.dms.total_mutations / 19 : null) ||
		null;
	const taxaUsed = pre.taxa_used ?? sections.sites?.summary?.speciesUsed ?? sections.gene?.record?.taxa ?? null;
	return {
		taxa_in_alignment: pre.taxa_in_alignment ?? sections.sites?.summary?.speciesInAlignment ?? taxaUsed,
		taxa_used: taxaUsed,
		codons,
		sites: summariseSites(sections.sites),
		gene: summariseGene(sections.gene),
		epistasis: summariseEpistasis(sections.epistasis, report.options),
		dms: summariseDms(sections.dms, codons, report.options),
		attributed_sites: sections.attribution ? Object.keys(sections.attribution.attributions ?? {}).length : null,
		artifacts_masked: sections.filter ? (sections.filter.artifacts_masked?.length ?? 0) : null,
		timings: report.timings ?? {},
		runtime_sec: Number(elapsedSec.toFixed(3))
	};
}

/**
 * JSON-safe copy of the report: typed arrays → arrays, Maps → objects, bigints → numbers, and the
 * STRIPPED_KEYS dropped wherever they occur. Returns the copy and the names actually stripped.
 */
function serialisable(report) {
	const stripped = new Set();
	const text = JSON.stringify(report, function replacer(k, v) {
		if (STRIPPED_KEYS.has(k) && v !== null && typeof v === 'object') {
			stripped.add(k);
			return undefined;
		}
		if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v);
		if (typeof v === 'bigint') return Number(v);
		if (v instanceof Map) return Object.fromEntries(v);
		if (typeof v === 'number' && !Number.isFinite(v)) return null;
		return v;
	});
	return { record: JSON.parse(text), stripped: [...stripped] };
}

/**
 * Drop `selection_dms_plasticity` from the DMS and epistasis sections when it is the same records
 * as `plasticity`. `run_digital_dms_analysis` binds ONE list to both keys (epistasis.py:766-767;
 * PHASE2A.md "Python quirks"), so the serialised record carries every DMS row twice; the page
 * reads `plasticity` (web/src/lib/report/types.ts). Lossless, and recorded in `prebake.storage`.
 */
function dropDmsAlias(record) {
	let dropped = 0;
	for (const section of [record.sections?.dms, record.sections?.epistasis]) {
		if (!section || !Array.isArray(section.selection_dms_plasticity)) continue;
		if (JSON.stringify(section.selection_dms_plasticity) !== JSON.stringify(section.plasticity ?? null)) continue;
		delete section.selection_dms_plasticity;
		dropped += 1;
	}
	return dropped;
}

/** Round every DMS `mutant_deltas` value to `digits` significant digits, in place; returns how many. */
function roundMutantDeltas(record, digits) {
	let n = 0;
	const lists = [record.sections?.dms?.plasticity, record.sections?.epistasis?.plasticity];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const row of list) {
			const deltas = row?.mutant_deltas;
			if (!deltas || typeof deltas !== 'object') continue;
			for (const [aa, v] of Object.entries(deltas)) {
				if (typeof v === 'number') {
					deltas[aa] = Number(v.toPrecision(digits));
					n += 1;
				}
			}
		}
	}
	return n;
}

/**
 * `extract_tree_from_string_or_file`'s first branch (dataset.py:161-212, tree.js extractTree) on
 * the TEXT: the Newick of a NEXUS `TREE name = (...);` command, HyPhy `{...}` tags and `[...]`
 * comments removed, or null. The library returns a parsed PhyloTree and has no Newick writer, and
 * the report page wants the string, so the string is taken from the same place the parser takes it.
 */
function embeddedNewick(text) {
	const m = /tree\s+[^=]+=\s*(\([^;]+;)/iu.exec(text);
	if (!m) return null;
	return m[1].replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '').trim();
}

/**
 * The selected taxa and their aligned sequences, in the order the model saw them, for the report's
 * entropy overlays, spark bars and site tree (results/types.ts AlignmentBlock). The taxa the model
 * saw are read from the runtime's provenance (`dropped_taxa` against the parsed names); the
 * sequences from the alignment text through the library's own parser.
 */
function alignmentBlock(lib, report, alignmentText) {
	const seqs = lib.parseAlignmentSequences(alignmentText);
	const pre = report.provenance?.preprocessing ?? report.sections?.sites?.provenance?.preprocessing;
	const dropped = new Set(pre?.dropped_taxa ?? []);
	const names = Array.from(seqs.keys()).filter((n) => !dropped.has(n));
	return { names, sequences: names.map((t) => seqs.get(t) ?? '') };
}

// -----------------------------------------------------------------------------------------------
// Runtime glue: models, the orchestrator, the HyPhy fit
// -----------------------------------------------------------------------------------------------

/** Where the graphs are: what copy-assets vendored into static/, else the engine checkout. */
function modelsDir() {
	for (const candidate of [join(web, 'static', 'models'), join(engineDir, 'models')]) {
		if (existsSync(join(candidate, 'manifest.json'))) return candidate;
	}
	return null;
}

/**
 * `runEverything` — from the runtime's main entry when it re-exports it, else from
 * runtime/src/analyze.js by file. Null when neither has it (the orchestrator has not landed in this
 * checkout), in which case the existing index is kept.
 */
async function loadOrchestrator(runtime) {
	if (typeof runtime?.runEverything === 'function') return { runEverything: runtime.runEverything, spec: '@veg/hyphaeon-runtime' };
	const file = join(repo, 'runtime', 'src', 'analyze.js');
	if (!existsSync(file)) return null;
	try {
		const mod = await import(pathToFileURL(file).href);
		if (typeof mod.runEverything === 'function') return { runEverything: mod.runEverything, spec: 'runtime/src/analyze.js' };
	} catch (err) {
		warn('runtime', `runtime/src/analyze.js failed to load: ${err?.message ?? err}`);
	}
	return null;
}

/**
 * HyPhy WASM under Node (runtime/src/hyphy/index.js `createHyPhy`), created lazily on the first
 * tree without branch lengths so the three examples with lengths never pay the ~5 MB load.
 * `fit(alignmentText, treeText)` runs axomeme3's HKY85 script (the model dataset.py:224-287 runs
 * through native HyPhy) and returns the fitted Newick.
 */
function lazyHyPhy() {
	let modPromise = null;
	let handle = null;
	return {
		async fit(alignmentText, treeText, label) {
			modPromise ??= import('@veg/hyphaeon-runtime/hyphy');
			const mod = await modPromise;
			if (!handle) {
				const t0 = performance.now();
				handle = await mod.createHyPhy();
				log('hyphy', `HyPhy WASM ${handle.version} loaded in ${secs(performance.now() - t0)}`);
			}
			const t0 = performance.now();
			log(label, 'tree has no branch lengths; fitting HKY85 in HyPhy WASM');
			const r = await handle.estimateBranchLengths(alignmentText, treeText);
			const fitted = r.result.trim();
			const elapsedSec = (performance.now() - t0) / 1000;
			log(label, `branch lengths fitted in ${elapsedSec.toFixed(1)} s`);
			return {
				treeText: fitted.endsWith(';') ? fitted : `${fitted};`,
				elapsedSec,
				hyphy: mod.HYPHY_VERSION_STRING ?? `HyPhy WASM ${handle.version}`
			};
		},
		spec: '@veg/hyphaeon-runtime/hyphy#createHyPhy'
	};
}

/** Whether a Newick text needs branch lengths fitted (dataset.py's `needs_branch_lengths` rule). */
function treeNeedsLengths(lib, treeText) {
	if (!treeText) return false;
	try {
		return lib.needsBranchLengths(lib.readNewick(treeText));
	} catch {
		return false;
	}
}

/**
 * The gallery record: the orchestrator's report, serialised, with the api.ts `ReportRecord`
 * envelope written beside it and the two page affordances filled in (see the header).
 */
function makeRecord(d, inputs, report, meta) {
	const createdAt = Date.now();
	const iso = new Date(createdAt).toISOString();
	const sections = { sites: null, gene: null, epistasis: null, attribution: null, filter: null, dms: null, phenotype: null, ...(report.sections ?? {}) };
	if (sections.sites && typeof sections.sites === 'object') {
		if (sections.sites.tree == null && meta.treeUsed) sections.sites.tree = meta.treeUsed;
		if (sections.sites.alignment == null && meta.alignment) sections.sites.alignment = meta.alignment;
	}
	const analyses = Object.entries(sections)
		.filter(([, v]) => v !== null && v !== undefined)
		.map(([k]) => k);
	const provenance = report.provenance ? { ...report.provenance } : null;
	if (provenance) {
		provenance.note ??= NOTE;
		provenance.preprocessing = { ...(provenance.preprocessing ?? {}) };
		if (meta.branchLengthMethod) provenance.preprocessing.branch_length_method = meta.branchLengthMethod;
		if (meta.estimation) {
			// The fit ran here, before the orchestrator saw the tree, so the runtime could only
			// record what it was given; the record says how the lengths were obtained.
			provenance.preprocessing.tree_source = 'hyphy-hky85';
			provenance.preprocessing.branch_lengths_estimated = true;
			provenance.preprocessing.branch_length_estimation = {
				by: 'prebake-gallery',
				method: 'hyphy-hky85',
				hyphy: meta.estimation.hyphy,
				elapsed_sec: Number(meta.estimation.elapsedSec.toFixed(3))
			};
		}
	}
	return {
		...report,
		schema_version: REPORT_SCHEMA_VERSION,
		kind: 'report',
		id: `gallery/${d.id}`,
		createdAt,
		createdAtIso: iso,
		created_at: iso,
		name: d.name,
		source: 'gallery',
		inputs: {
			...(report.inputs ?? {}),
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
			alignmentName: d.alignment,
			treeName: d.tree,
			demo: d.id,
			treeText: meta.treeUsed
		},
		options: report.options ?? { ...meta.options },
		diagnostics: report.diagnostics ?? null,
		sections,
		provenance,
		timings: report.timings ?? {},
		status: {
			state: 'done',
			phase: 'postprocess',
			done: 1,
			total: 1,
			message: NOTE,
			completed: analyses
		},
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
			summary: meta.summary,
			prebaked_at: iso
		}
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

	// --- runtime, orchestrator and model ---------------------------------------------------------
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
	const orchestrator = await loadOrchestrator(runtime);
	if (!orchestrator) {
		warn('runtime', 'the runtime has no runEverything (runtime/src/analyze.js); cannot bake');
		keepOrMissing('runEverything absent from the runtime');
		return;
	}
	log('runtime', `runEverything from ${orchestrator.spec}`);

	const threads = Math.max(1, Number(process.env.HYPHAEON_PREBAKE_THREADS) || Math.min(8, availableParallelism()));
	let sessions;
	const tLoad = performance.now();
	try {
		sessions = await runtime.createSession({
			modelsBase: models,
			variant: OPTIONS.variant,
			runtime: 'node',
			threads,
			bustedHead: true
		});
	} catch (err) {
		warn('session', `onnxruntime-node could not load the graphs from ${models}: ${err?.message ?? err}`);
		keepOrMissing(`session failed to load: ${err?.message ?? err}`);
		return;
	}
	const { manifest, variant, backbone, head } = sessions;
	log(
		'session',
		`${OPTIONS.variant} (${variant.onnxSha256.slice(0, 12)}…) + busted head (${(head?.sha256 ?? variant.bustedHeadSha256 ?? '').slice(0, 12)}…) ` +
			`loaded in ${secs(performance.now() - tLoad)}, ${threads} thread(s), verified=${backbone.verified}`
	);

	const lib = await import('@veg/hyphaeon-js');
	const hyphy = lazyHyPhy();
	const libVersion = sessions.libraryVersion ?? libraryVersion();
	const sourcesHash = runtimeSourcesHash();
	const options = resolveOptions(runtime);
	log('options', JSON.stringify(options));

	// --- each example ----------------------------------------------------------------------------
	const entries = [];
	const timings = [];
	const sizes = [];
	for (const d of DATASETS) {
		const inputs = inputsById[d.id];
		const previous = existing?.entries?.find((e) => e.id === d.id) ?? null;
		if (only && d.id !== only) {
			entries.push(
				previous
					? { ...previous, ...catalogueFields(d, inputs, previous.analyses ?? []) }
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
				model: { backbone: variant.onnxSha256, head: head?.sha256 ?? variant.bustedHeadSha256 ?? null },
				options,
				library: libVersion,
				runtime: sourcesHash,
				estimator: hyphy.spec
			})
		);
		const resultFile = `${d.id}.json`;
		if (!force && previous?.status === 'ok' && previous.prebake?.stamp === stamp && existsSync(join(galleryDir, resultFile))) {
			log(d.id, `up to date (stamp ${stamp.slice(0, 12)}…); reusing`);
			entries.push({ ...previous, ...catalogueFields(d, inputs, previous.analyses ?? []) });
			sizes.push({ id: d.id, bytes: statSync(join(galleryDir, resultFile)).size, reused: true });
			continue;
		}

		log(d.id, `running everything on ${d.paper.taxa} × ${d.paper.codons} (cap ${options.maxSpecies}, ${options.variant}, seed ${options.seed}, B ${options.permutations}, DMS budget ${options.dms.workBudget ?? 'runtime default'})…`);
		const t0 = performance.now();

		// The tree the orchestrator is given: the file's, or HyPhy's fit of it (see the header).
		let treeGiven = treeText;
		let treeSource = treeText === null ? 'embedded' : 'user';
		let estimation = null;
		try {
			if (treeNeedsLengths(lib, treeText)) {
				estimation = await hyphy.fit(alignmentText, treeText, d.id);
				treeGiven = estimation.treeText;
				treeSource = 'hyphy-hky85';
			}
		} catch (err) {
			const elapsed = (performance.now() - t0) / 1000;
			warn(d.id, `branch-length fit failed after ${elapsed.toFixed(1)} s: ${err?.stack ?? err}`);
			entries.push({ ...missingEntry(d, inputs, `HKY85 fit failed: ${err?.message ?? err}`), status: 'failed' });
			timings.push({ id: d.id, seconds: elapsed, status: 'failed' });
			continue;
		}

		// Progress: log every phase change, and inside the long phases every 10 % or 20 s.
		let lastPhase = null;
		let lastTick = 0;
		let lastPct = -1;
		const progress = (phase, done, total, message) => {
			const now = performance.now();
			if (phase !== lastPhase) {
				lastPhase = phase;
				lastTick = now;
				lastPct = -1;
				log(d.id, `  ${phase}: ${message ?? ''}`);
				return;
			}
			const pct = total > 0 ? Math.floor((100 * done) / total) : -1;
			if ((pct >= 0 && pct >= lastPct + 10 && pct < 100) || now - lastTick > 20_000) {
				lastPct = pct;
				lastTick = now;
				log(d.id, `  ${phase}: ${done}/${total}${message ? ` — ${message}` : ''}`);
			}
		};
		const sectionArrivals = [];
		const onSection = (name, payload, { final } = {}) => {
			if (final) {
				sectionArrivals.push({ name, at: Number(((performance.now() - t0) / 1000).toFixed(2)) });
				log(d.id, `  section ${name} ready at ${sectionArrivals.at(-1).at} s`);
			}
		};

		let report;
		try {
			report = await orchestrator.runEverything({
				alignmentText,
				treeText: treeGiven,
				inputs: { alignmentName: d.alignment, treeName: d.tree, demo: d.id },
				options: {
					...options,
					// Passed for the pipelines that read them (prepareRun: treeSource, pruneDuplicates,
					// alignmentName / treeName for the CLI document's file names); harmless otherwise.
					treeSource,
					alignmentName: d.alignment,
					treeName: d.tree ?? undefined
				},
				session: backbone,
				head,
				surface: SURFACE,
				progress,
				onSection
			});
		} catch (err) {
			const elapsed = (performance.now() - t0) / 1000;
			warn(d.id, `run failed after ${elapsed.toFixed(1)} s: ${err?.stack ?? err}`);
			entries.push({ ...missingEntry(d, inputs, String(err?.message ?? err)), status: 'failed' });
			timings.push({ id: d.id, seconds: elapsed, status: 'failed' });
			continue;
		}
		const elapsed = (performance.now() - t0) / 1000;

		// What happened to the tree, as recorded here and by the runtime.
		const pre = report.provenance?.preprocessing ?? {};
		const branchLengthsEstimated = estimation !== null || Boolean(pre.branch_lengths_estimated);
		const branchLengthMethod = branchLengthsEstimated ? 'hyphy-hky85' : pre.branch_lengths_missing ? 'library-default' : null;
		const treeUsed = treeGiven === null ? embeddedNewick(alignmentText) : treeGiven.trim();

		const summary = summarise(report, elapsed);
		let alignment = null;
		try {
			alignment = alignmentBlock(lib, report, alignmentText);
		} catch (err) {
			warn(d.id, `alignment block not recorded: ${err?.message ?? err}`);
		}
		const { record: safeReport, stripped } = serialisable(report);
		const record = makeRecord(d, inputs, safeReport, {
			options,
			alignmentText,
			treeText,
			treeUsed,
			treeSource,
			estimation,
			alignment,
			branchLengthsEstimated,
			branchLengthMethod,
			summary,
			threads,
			elapsedSec: elapsed
		});

		// Size discipline (see the header): lossless first (the duplicated DMS list), then rounding.
		const storage = {};
		let text = JSON.stringify(record) + '\n';
		if (Buffer.byteLength(text) > SIZE_LIMIT_BYTES) {
			const before = Buffer.byteLength(text);
			if (dropDmsAlias(record) > 0) {
				storage.dms_alias_dropped = true;
				text = JSON.stringify(record) + '\n';
				log(d.id, `record ${mb(before)} > ${mb(SIZE_LIMIT_BYTES)}: selection_dms_plasticity (a copy of plasticity) dropped → ${mb(Buffer.byteLength(text))}`);
			}
			if (Buffer.byteLength(text) > SIZE_LIMIT_BYTES) {
				const n = roundMutantDeltas(record, DMS_DIGITS);
				if (n > 0) {
					storage.dms_mutant_deltas_digits = DMS_DIGITS;
					text = JSON.stringify(record) + '\n';
					log(d.id, `still over: ${n} DMS deltas rounded to ${DMS_DIGITS} significant digits → ${mb(Buffer.byteLength(text))}`);
				}
			}
			if (Buffer.byteLength(text) > SIZE_LIMIT_BYTES) {
				warn(d.id, `record is ${mb(Buffer.byteLength(text))}, over the ${mb(SIZE_LIMIT_BYTES)} limit even after rounding`);
			}
		}
		if (stripped.length) storage.stripped = stripped;
		record.gallery.storage = storage;
		writeFileSync(join(galleryDir, resultFile), text);
		const bytes = Buffer.byteLength(text);
		sizes.push({ id: d.id, bytes, reused: false });

		const analyses = Object.entries(record.sections)
			.filter(([, v]) => v !== null && v !== undefined)
			.map(([k]) => k);
		entries.push({
			...catalogueFields(d, inputs, analyses),
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
				artifact_verified: Boolean(backbone.verified),
				stamp,
				storage,
				sections: sectionArrivals
			}
		});
		timings.push({ id: d.id, seconds: elapsed, status: 'ok', summary });
		const g = summary.gene;
		const e = summary.epistasis;
		const m = summary.dms;
		log(
			d.id,
			`done in ${elapsed.toFixed(1)} s — ${summary.taxa_used}/${summary.taxa_in_alignment} taxa × ${summary.codons} codons; ` +
				(summary.sites ? `sites q≤0.10: ${summary.sites.called.q_le_0_10}, p≤0.05: ${summary.sites.called.p_le_0_05}, top 5%: ${summary.sites.called.top_5pct}, max LRT ${summary.sites.max_lrt.toFixed(3)}; ` : 'no sites section; ') +
				(g ? `gene ${g.verdict} (p_ACAT ${g.p_value_acat?.toExponential(3)}); ` : 'no gene section; ') +
				(e ? `epistasis ${e.edges} edges, ${e.sectors} sectors (${e.significant_sectors} at p_perm≤0.05); ` : 'no epistasis section; ') +
				(m ? `DMS ${m.sites_swept}/${m.sites_total} sites (${(100 * m.coverage).toFixed(0)} %${m.cancelled ? ', cancelled' : ''}); ` : 'no DMS section; ') +
				`tree ${treeSource}${branchLengthMethod ? ` (${branchLengthMethod})` : ''}; record ${mb(bytes)}`
		);
	}

	writeIndex(entries, { manifest, variant, backbone, head }, { libVersion, options });

	if (timings.length) {
		console.log('\n[prebake-gallery] timings (wall seconds; per phase as the orchestrator measured them):');
		for (const t of timings) {
			const phases = t.summary?.timings
				? Object.entries(t.summary.timings)
						.map(([k, v]) => `${k} ${Number(v).toFixed(1)}`)
						.join(', ')
				: '';
			console.log(`  ${t.id.padEnd(10)} ${t.seconds.toFixed(1).padStart(7)} s  ${t.status}${phases ? `  [${phases}]` : ''}`);
		}
		console.log(`  total     ${timings.reduce((a, t) => a + t.seconds, 0).toFixed(1).padStart(7)} s`);
	}
	if (sizes.length) {
		console.log('\n[prebake-gallery] record sizes:');
		for (const s of sizes) console.log(`  ${s.id.padEnd(10)} ${mb(s.bytes).padStart(9)}${s.reused ? '  (reused)' : ''}`);
	}

	// onnxruntime-node 1.23.2 aborts at exit with a live session (PHASE1.md); release before the loop drains.
	try {
		const released = await nodeSession.releaseSessions();
		log('session', `released ${released} ORT session(s)`);
	} catch (err) {
		warn('session', `releaseSessions failed: ${err?.message ?? err}`);
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
			variant: OPTIONS.variant,
			artifact_sha256: model?.backbone?.sha256 ?? model?.variant?.onnxSha256 ?? null,
			busted_head_sha256: model?.head?.sha256 ?? model?.variant?.bustedHeadSha256 ?? null
		},
		options: meta?.options ?? { ...OPTIONS },
		entries
	};
	writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
	const ok = entries.filter((e) => e.status === 'ok').length;
	log('index', `wrote ${indexPath} (${ok}/${entries.length} entries with reports)`);
}

main().catch(async (err) => {
	// A prebake failure must not take the build down: the page still has an index to read.
	console.error(`[prebake-gallery] FAILED: ${err?.stack ?? err}`);
	if (!existsSync(indexPath)) {
		writeIndex(allMissing(Object.fromEntries(DATASETS.map((d) => [d.id, inputsBlock(d)])), String(err?.message ?? err)), null, null);
	}
	try {
		const nodeSession = await import('@veg/hyphaeon-runtime/node');
		await nodeSession.releaseSessions();
	} catch {
		// nothing loaded
	}
	process.exitCode = 0;
});
