/**
 * models.js — where the weights manifest, the bundled examples and the prebaked gallery are found.
 *
 * WHY THIS FILE EXISTS
 *
 * The native tools (hyphaeon_meme, hyphaeon_busted) load an ONNX graph under Node, and the graph
 * they load is named by models/manifest.json (PLAN.md 3.3: one manifest, written by
 * `hyphaeon export-onnx`, packaged into pip and npm from the same commit). list_models and the
 * hyphaeon://models resource read the same file through the runtime's reader
 * (runtime/src/manifest.js `loadManifest`, which validates the shape and is the ONE reader every
 * surface shares), so the MCP cannot disagree with the browser about what a variant is called or
 * which hash it must carry. The search order is:
 *
 *   1. HYPHAEON_MODELS_DIR (operator override);
 *   2. web/static/models of this repository — the copies scripts/copy-assets.mjs makes at build,
 *      i.e. what the app ships;
 *   3. the sibling engine checkout, ../../HyphAeon/models relative to this package, the
 *      development layout PLAN.md Appendix A assumes (hyphaeon-app beside HyphAeon);
 *   4. node_modules/@veg/hyphaeon-js/models, where the published library will ship it
 *      (PLAN.md 5.5, "packaged into both the pip and npm artifacts").
 *
 * The same rule locates the examples directory (HYPHAEON_EXAMPLES_DIR, then the sibling checkout's
 * examples/) for hyphaeon://examples/{name}, and the gallery directory (HYPHAEON_GALLERY_DIR, then
 * web/static/gallery) whose index.json and per-example result documents
 * web/scripts/prebake-gallery.mjs writes (shape pinned in web/src/lib/gallery/types.ts) for
 * hyphaeon://gallery/{name}.
 *
 * Nothing here loads a model. It reads JSON files and lists directories.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, listVariants, pickVariant, MANIFEST_FILE } from "@veg/hyphaeon-runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..", "..");
const SIBLING_ENGINE = path.resolve(APP_ROOT, "..", "HyphAeon");
const WEB_STATIC = path.join(APP_ROOT, "web", "static");

/** What the Python reference knows about its variants (hyphaeon/weights.py:41-69, :72-76). */
export const KNOWN_VARIANTS = Object.freeze([
  {
    variant: "general",
    filename: "model.safetensors",
    description: "General model (trained on diverse alignments)",
    trained_on: "TOGA mammalian, 742 species",
    regime: "deep / cross-species",
    default: true
  },
  {
    variant: "viral",
    filename: "model.viral.safetensors",
    description: "viral variant",
    trained_on: "base + ~9,300 Datamonkey viral alignments",
    regime: "viral / shallow",
    default: false
  }
]);

export function modelsDirCandidates(env = process.env) {
  const out = [];
  if (env.HYPHAEON_MODELS_DIR) out.push(env.HYPHAEON_MODELS_DIR);
  out.push(path.join(WEB_STATIC, "models"));
  out.push(path.join(SIBLING_ENGINE, "models"));
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@veg/hyphaeon-js/package.json");
    out.push(path.join(path.dirname(pkgJson), "models"));
  } catch {
    // library not installed yet
  }
  return out;
}

export function examplesDirCandidates(env = process.env) {
  const out = [];
  if (env.HYPHAEON_EXAMPLES_DIR) out.push(env.HYPHAEON_EXAMPLES_DIR);
  out.push(path.join(SIBLING_ENGINE, "examples"));
  return out;
}

export function galleryDirCandidates(env = process.env) {
  const out = [];
  if (env.HYPHAEON_GALLERY_DIR) out.push(env.HYPHAEON_GALLERY_DIR);
  out.push(path.join(WEB_STATIC, "gallery"));
  return out;
}

/**
 * The first candidate directory holding a manifest the runtime accepts, with the parsed manifest.
 * A malformed manifest is reported, not skipped: a directory that carries a broken manifest.json
 * is a broken installation, and falling through to another copy would hide it.
 *
 * @param {object} [env]
 * @returns {Promise<{available: boolean, dir?: string, path?: string, manifest?: object, error?: string, searched: string[]}>}
 */
export async function resolveModels(env = process.env) {
  const searched = modelsDirCandidates(env);
  for (const dir of searched) {
    const p = path.join(dir, MANIFEST_FILE);
    let text;
    try {
      text = await readFile(p, "utf8");
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
      return { available: false, dir, path: p, error: "manifest.json could not be read: " + err.message, searched };
    }
    try {
      return { available: true, dir, path: p, manifest: await loadManifest(JSON.parse(text)), searched };
    } catch (err) {
      return { available: false, dir, path: p, error: "manifest.json is not a valid HyphAeon manifest: " + err.message, searched };
    }
  }
  return { available: false, searched };
}

/**
 * The view list_models and hyphaeon://models return.
 *
 * @param {object} [env]
 * @returns {Promise<{available: boolean, path?: string, dir?: string, manifest?: object, error?: string, note?: string, searched: string[], variants: Array<object>}>}
 */
export async function readManifest(env = process.env) {
  const resolved = await resolveModels(env);
  if (resolved.available) {
    return {
      available: true,
      path: resolved.path,
      dir: resolved.dir,
      manifest: resolved.manifest,
      searched: resolved.searched,
      variants: manifestVariants(resolved.manifest, resolved.dir)
    };
  }
  return Object.assign(
    { available: false, searched: resolved.searched, variants: [...KNOWN_VARIANTS] },
    resolved.error
      ? { path: resolved.path, error: resolved.error }
      : {
          note:
            "No models/manifest.json found (it is written by `hyphaeon export-onnx`, PLAN.md 7.1). " +
            "Listing the variants the Python reference knows about instead; the native tools cannot run."
        }
  );
}

function manifestVariants(manifest, dir) {
  return listVariants(manifest).map((variant) => {
    const picked = pickVariant(manifest, variant);
    const known = KNOWN_VARIANTS.find((k) => k.variant === variant) || {};
    return Object.assign({ variant, default: variant === "general" }, known, picked.raw, {
      onnx_file: picked.onnxFile,
      onnx_path: dir ? path.join(dir, picked.onnxFile) : null,
      busted_head_file: picked.bustedHeadFile,
      busted_head_path: dir && picked.bustedHeadFile ? path.join(dir, picked.bustedHeadFile) : null
    });
  });
}

const EXAMPLE_EXT = new Set([".fasta", ".fa", ".fna", ".nex", ".nwk", ".tree", ".json", ".csv"]);
export const MAX_EXAMPLE_BYTES = 2 * 1024 * 1024;

/**
 * List the example files that can be served (name, bytes, kind). Files above MAX_EXAMPLE_BYTES
 * are listed but marked too large.
 */
export async function listExamples(env = process.env) {
  for (const dir of examplesDirCandidates(env)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!EXAMPLE_EXT.has(ext)) continue;
      const st = await stat(path.join(dir, e.name));
      files.push({
        name: e.name,
        bytes: st.size,
        kind: [".nwk", ".tree"].includes(ext) ? "tree" : [".json", ".csv"].includes(ext) ? "result" : "alignment",
        servable: st.size <= MAX_EXAMPLE_BYTES
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dir, files };
  }
  return { dir: null, files: [] };
}

function bareName(name, what) {
  if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".")) {
    const e = new Error(what + " names are bare file names or ids, e.g. Smc6.fasta.");
    e.code = "BAD_NAME";
    throw e;
  }
  return name;
}

/**
 * Read one example by basename. Refuses path separators and anything outside the directory.
 */
export async function readExample(name, env = process.env) {
  bareName(name, "Example");
  const { dir, files } = await listExamples(env);
  if (!dir) {
    const e = new Error("No examples directory found (set HYPHAEON_EXAMPLES_DIR).");
    e.code = "NO_DIR";
    throw e;
  }
  const entry = files.find((f) => f.name === name);
  if (!entry) {
    const e = new Error("No example named '" + name + "'. Available: " + files.map((f) => f.name).join(", "));
    e.code = "NOT_FOUND";
    throw e;
  }
  if (!entry.servable) {
    const e = new Error("'" + name + "' is " + entry.bytes + " bytes, above the " + MAX_EXAMPLE_BYTES + "-byte resource cap.");
    e.code = "TOO_LARGE";
    throw e;
  }
  const text = await readFile(path.join(dir, name), "utf8");
  return { name, text, kind: entry.kind, bytes: entry.bytes };
}

// ── gallery ──────────────────────────────────────────────────────────────────

/** A prebaked result document may be large (HIV1_RT: 476 sites x 335 taxa of attention); cap it. */
export const MAX_GALLERY_BYTES = 16 * 1024 * 1024;

/**
 * The gallery index (web/static/gallery/index.json) and where it was found, or null when no
 * candidate directory holds one. Both index schemas are tolerated: v2 (Phase 1b, one prebaked
 * run per entry with `result` naming the record file) and the Phase 0 v1 listing (no records).
 *
 * @param {object} [env]
 * @returns {Promise<{dir: string, path: string, index: object}|null>}
 */
export async function readGalleryIndex(env = process.env) {
  for (const dir of galleryDirCandidates(env)) {
    const p = path.join(dir, "index.json");
    let text;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    try {
      return { dir, path: p, index: JSON.parse(text) };
    } catch (err) {
      const e = new Error("The gallery index at " + p + " is not valid JSON: " + err.message);
      e.code = "BAD_INDEX";
      throw e;
    }
  }
  return null;
}

/**
 * The gallery entries with a prebaked record on disk: `{id, name, result, bytes, entry}`.
 * Entries without a record (v1 index, a failed prebake) are listed with `result: null`.
 *
 * @param {object} [env]
 * @returns {Promise<{dir: string|null, schema_version: number|null, entries: Array<object>}>}
 */
export async function listGalleryRecords(env = process.env) {
  const found = await readGalleryIndex(env);
  if (!found) return { dir: null, schema_version: null, entries: [] };
  const raw = Array.isArray(found.index.entries) ? found.index.entries : [];
  const entries = [];
  for (const entry of raw) {
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id || id !== path.basename(id)) continue;
    let bytes = null;
    let result = typeof entry.result === "string" && entry.result === path.basename(entry.result) ? entry.result : null;
    if (result) {
      try {
        bytes = (await stat(path.join(found.dir, result))).size;
      } catch {
        result = null;
      }
    }
    entries.push({
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      status: entry.status || (result ? "ok" : "missing"),
      result,
      bytes,
      servable: result !== null && bytes <= MAX_GALLERY_BYTES,
      entry
    });
  }
  return { dir: found.dir, schema_version: found.index.schema_version ?? null, entries };
}

/**
 * Read one prebaked record by gallery id (the example's file stem, e.g. `bat_oas1`).
 *
 * @param {string} id
 * @param {object} [env]
 * @returns {Promise<{id: string, name: string, text: string, bytes: number, entry: object}>}
 */
export async function readGalleryRecord(id, env = process.env) {
  bareName(id, "Gallery");
  const { dir, entries } = await listGalleryRecords(env);
  if (!dir) {
    const e = new Error("No gallery found (web/static/gallery/index.json is written by web/scripts/prebake-gallery.mjs at build; set HYPHAEON_GALLERY_DIR to point at one).");
    e.code = "NO_DIR";
    throw e;
  }
  const entry = entries.find((g) => g.id === id);
  if (!entry) {
    const e = new Error("No gallery entry '" + id + "'. Available: " + entries.map((g) => g.id).join(", "));
    e.code = "NOT_FOUND";
    throw e;
  }
  if (!entry.result) {
    const e = new Error("Gallery entry '" + id + "' has no prebaked record (status " + entry.status + (entry.entry.error ? ": " + entry.entry.error : "") + ").");
    e.code = "NO_RECORD";
    throw e;
  }
  if (!entry.servable) {
    const e = new Error("'" + entry.result + "' is " + entry.bytes + " bytes, above the " + MAX_GALLERY_BYTES + "-byte resource cap.");
    e.code = "TOO_LARGE";
    throw e;
  }
  const text = await readFile(path.join(dir, entry.result), "utf8");
  return { id, name: entry.name, text, bytes: entry.bytes, entry: entry.entry };
}
