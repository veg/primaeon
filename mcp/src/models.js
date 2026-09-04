/**
 * models.js — where the weights manifest and the bundled examples are found.
 *
 * WHY THIS FILE EXISTS
 *
 * list_models and the hyphaeon://models resource read veg/HyphAeon/models/manifest.json
 * (PLAN.md 3.3: one manifest, packaged into pip and npm from the same commit). In Phase 0 that
 * file does not exist yet — the export PR (PLAN.md 7.1) writes it — so every reader has to
 * tolerate its absence and say where it looked. The search order is:
 *
 *   1. HYPHAEON_MODELS_DIR (operator override);
 *   2. the sibling engine checkout, ../../HyphAeon/models relative to this package, which is the
 *      development layout PLAN.md Appendix A assumes (hyphaeon-app beside HyphAeon);
 *   3. node_modules/@veg/hyphaeon-js/models, where the published library will ship it
 *      (PLAN.md 5.5, "packaged into both the pip and npm artifacts").
 *
 * The same rule locates the examples directory (HYPHAEON_EXAMPLES_DIR, then the sibling
 * checkout's examples/) for hyphaeon://examples/{name}.
 *
 * Nothing here loads a model. It reads one JSON file and lists a directory.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_ENGINE = path.resolve(HERE, "..", "..", "..", "HyphAeon");

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

/**
 * @param {object} [env]
 * @returns {Promise<{available: boolean, path?: string, manifest?: object, searched: string[], variants: Array<object>}>}
 */
export async function readManifest(env = process.env) {
  const searched = modelsDirCandidates(env);
  for (const dir of searched) {
    const p = path.join(dir, "manifest.json");
    try {
      const text = await readFile(p, "utf8");
      const manifest = JSON.parse(text);
      return { available: true, path: p, manifest, searched, variants: manifestVariants(manifest) };
    } catch (err) {
      if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
        return {
          available: false,
          path: p,
          error: "manifest.json exists but could not be read: " + err.message,
          searched,
          variants: [...KNOWN_VARIANTS]
        };
      }
    }
  }
  return {
    available: false,
    searched,
    note:
      "No models/manifest.json found (it is written by `hyphaeon export-onnx`, PLAN.md 7.1). " +
      "Listing the variants the Python reference knows about instead.",
    variants: [...KNOWN_VARIANTS]
  };
}

function manifestVariants(manifest) {
  if (!manifest || typeof manifest.variants !== "object") return [...KNOWN_VARIANTS];
  return Object.entries(manifest.variants).map(([variant, v]) => {
    const known = KNOWN_VARIANTS.find((k) => k.variant === variant) || {};
    return Object.assign({ variant, default: variant === "general" }, known, v);
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

/**
 * Read one example by basename. Refuses path separators and anything outside the directory.
 */
export async function readExample(name, env = process.env) {
  if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".")) {
    const e = new Error("Example names are bare file names, e.g. Smc6.fasta.");
    e.code = "BAD_NAME";
    throw e;
  }
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
