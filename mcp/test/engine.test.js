/**
 * engine.test.js — the native pillars against the Python reference's e2e fixtures.
 *
 * WHY THIS FILE EXISTS
 *
 * PARITY.md (veg/HyphAeon) says how a surface is compared with `hyphaeon <cmd>`: site order and
 * `is_invariable` exact; `hyphaeon_lrt` within 1e-5 x max(1, |lrt|) (the graph class, PLAN.md
 * 5.4); `p_value` / `q_value` float32-equal to the reference functions evaluated on the
 * surface's OWN LRTs (cmd_meme writes both as float32; comparing to the file at 1e-9 would fail
 * on every site for a reason already reported under the LRT). The busted record's statistical
 * fields are exact functions of the site LRTs (sum class L x 1e-6, derived class 1e-6); the
 * neural fields are one seeded draw of an unseeded head and are not compared. The evaluate
 * report is a pure function of two texts and is compared at 1e-9.
 *
 * The LRT clause was blocked at phase-1a by MDS eigenvector signs (PHASE1.md gap 1); since
 * phase-2a both the reference and the library apply the canonical convention (MDS_SIGN.md), the
 * fixtures were regenerated under it, and test/data/python_mds.json holds the reference's
 * canonical z. The MDS check is therefore STRICT here: every column agrees at 1e-5 with no sign
 * allowance, and the LRT and busted clauses assert their classes outright — a sign disagreement
 * is now a defect, not a tolerance (PHASE2A.md gap 8: "drop the ctxt.skip").
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadAlignmentAndTree, memeSitePq } from "@veg/hyphaeon-js";
import { connect, parseText, example, examplesDir, HERE } from "./helpers.js";
import { mapOptions, referenceCommand, classifyEngineError, EngineError } from "../src/engine.js";
import { readManifest } from "../src/models.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const fixture = (name) => JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", name), "utf8"))[0];
const PY_MDS = JSON.parse(readFileSync(path.join(HERE, "data", "python_mds.json"), "utf8"));

/**
 * The library's MDS coordinates against the reference's canonical ones (test/data/python_mds.json):
 * per-column exact agreement (no sign allowance) at 1e-5, and which columns, if any, come out
 * with the opposite sign — which would now mean a broken convention on one side.
 */
function mdsAgreement(name, alignment, tree) {
  const py = PY_MDS.examples[name];
  expect(PY_MDS.mds_sign).toBe("canonical");
  const loaded = loadAlignmentAndTree(alignment, tree, { maxSpecies: null, pruneDuplicates: true });
  const N = loaded.N;
  const taxaMatch = JSON.stringify(loaded.taxa) === JSON.stringify(py.taxa);
  const flipped = [];
  let maxAbsDiff = 0;
  for (let k = 0; k < 4; k++) {
    let same = 0;
    let flip = 0;
    for (let i = 0; i < N; i++) {
      const a = loaded.z[i * 4 + k];
      const b = py.z[i][k];
      if (Math.abs(a - b) <= Math.abs(a + b)) same++;
      else flip++;
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(a - b));
    }
    if (flip > same) flipped.push(k);
  }
  return { flipped, taxaMatch, maxAbsDiff };
}

/** The Python interpreter behind HYPHAEON_PY_BIN (a console script's shebang), if any. */
function pythonFor(env = process.env) {
  const bin = env.HYPHAEON_PY_BIN;
  if (!bin || !existsSync(bin)) return null;
  const head = readFileSync(bin, "utf8").slice(0, 512);
  const m = /^#!\s*(\S+)/.exec(head);
  return m && /python/i.test(m[1]) && existsSync(m[1]) ? m[1] : null;
}

/** cmd_meme's p/q (float32 casts) from the reference's own stats.py on the given LRTs. */
function pythonMemePq(python, lrts, env = process.env) {
  const r = spawnSync(
    python,
    [
      "-c",
      "import sys, json, numpy as np\n" +
        "from hyphaeon.stats import pvals_from_lrt_meme, benjamini_hochberg\n" +
        "lrt = np.asarray(json.load(sys.stdin), dtype=np.float32)\n" +
        "p = pvals_from_lrt_meme(lrt).astype(np.float32)\n" +
        "q = benjamini_hochberg(p).astype(np.float32)\n" +
        "print(json.dumps({'p': [float(x) for x in p], 'q': [float(x) for x in q]}))"
    ],
    { input: JSON.stringify(Array.from(lrts)), encoding: "utf8", env: Object.assign({}, env, { HF_HUB_OFFLINE: "1" }), timeout: 60000 }
  );
  if (r.status !== 0) throw new Error("python stats failed: " + r.stderr);
  return JSON.parse(r.stdout);
}

function relDiff(got, ref) {
  return Math.abs(got - ref) / Math.max(1, Math.abs(ref));
}

describe("engine option mapping (no model)", () => {
  it("mirrors the CLI defaults: no taxon cap for meme, 512 for busted, flags one to one", () => {
    const meme = mapOptions("meme", { filter: true, filter_p_thresh: 0.02, attribute: true, attribution_min_lrt: 2, no_prune_duplicates: true, batch_size: 16, cpu: true });
    expect(meme.variant).toBe("general");
    expect(meme.runtime).toEqual({ maxSpecies: Infinity, pruneDuplicates: false, batchSize: 16, filter: true, filterPThresh: 0.02, attribute: true, attributionMinLrt: 2 });
    expect(meme.notApplied).toEqual([]);
    expect(mapOptions("meme", { max_species: 128, model_variant: "viral" }).runtime.maxSpecies).toBe(128);
    expect(mapOptions("meme", { model_variant: "viral" }).variant).toBe("viral");
    expect(mapOptions("meme", { min_patch_consec: 4 }).notApplied).toEqual(["min_patch_consec"]);
    expect(mapOptions("meme", { min_patch_consec: 3 }).notApplied).toEqual([]);
    const busted = mapOptions("busted", { gene: "Smc6" }, { defaultVariant: "viral", alignmentName: "Smc6.fasta", treeName: "Smc6.nwk" });
    expect(busted.runtime).toEqual({ gene: "Smc6", alignmentName: "Smc6.fasta", treeName: "Smc6.nwk" });
    expect(busted.variant).toBe("viral");
  });

  it("writes the reproduce-with-the-CLI line (with the MDS sign convention this surface computed)", () => {
    expect(referenceCommand("meme", { model_variant: "viral", filter: true, attribution_min_lrt: 2 }, { alignment: "a.fasta", tree: "t.nwk" })).toEqual([
      "hyphaeon", "meme", "-a", "a.fasta", "-t", "t.nwk", "--model-variant", "viral", "--cpu", "--filter", "--attribution-min-lrt", "2", "--mds-sign", "canonical", "-o", "<out.json>"
    ]);
    expect(referenceCommand("evaluate", { variable_only: true }, { prediction: "g.csv", meme_result: "g.MEME.json" })).toEqual([
      "hyphaeon", "evaluate", "--prediction", "g.csv", "--meme-result", "g.MEME.json", "--variable-only", "-o", "<out.json>", "--format", "json"
    ]);
  });

  it("classifies failures into the two classes", () => {
    expect(classifyEngineError(new Error("HyphAeon needs at least 3 sequences; this alignment has 2.")).kind).toBe("input");
    expect(classifyEngineError(new Error("No matching taxa between tree and alignment")).kind).toBe("input");
    const abort = new Error("HyphAeon run cancelled");
    abort.name = "AbortError";
    expect(classifyEngineError(abort).message).toMatch(/cancelled/);
    expect(classifyEngineError(new Error("HyphAeon model read failed: /x/general.onnx: ENOENT")).kind).toBe("server");
    expect(classifyEngineError(new EngineError("server", "x", { code: "MODELS_MISSING" })).code).toBe("MODELS_MISSING");
  });
});

describe("hyphaeon_meme in-process on bat_oas1 vs fixtures/e2e/meme_bat_oas1.json", () => {
  let ctx;
  let body;
  let alignment;
  let tree;
  const ref = fixture("meme_bat_oas1.json").outputs;

  beforeAll(async () => {
    ctx = await connect();
    alignment = await example("bat_oas1.fasta");
    tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, cpu: true } });
    if (res.isError) throw new Error("hyphaeon_meme failed: " + res.content[0].text);
    body = parseText(res);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("answers in the call with mcp-stdio provenance from the manifest's general graph", async () => {
    const manifest = await readManifest();
    expect(manifest.available).toBe(true);
    expect(body.analysis).toBe("meme");
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.provenance.engine).toBe("in-process");
    expect(body.provenance.model_variant).toBe("general");
    expect(body.provenance.artifact_sha256).toBe(manifest.manifest.variants.general.onnx_sha256);
    expect(body.provenance.artifact_verified).toBe(true);
    expect(body.provenance.hyphaeon_js_version).toBe("1.0.0");
    expect(body.provenance.reference_version).toBe("1.0.0");
    expect(body.provenance.is_surrogate).toBe(true);
    expect(body.provenance.surrogate_for).toBe("MEME");
    expect(body.provenance.reference_command.slice(0, 2)).toEqual(["hyphaeon", "meme"]);
    expect(body.provenance.preprocessing).toMatchObject({ taxa_in_alignment: 18, taxa_used: 18, distance_rescaled: true, tree_source: "user", branch_lengths_estimated: false, taxon_cap: null });
    expect(body.provenance.warnings.map((w) => w.code)).toContain("DISTANCE_RESCALED");
    expect(body.provenance.elapsed_sec).toBeGreaterThan(0);
    expect(body.provenance.options).toEqual({ cpu: true });
  });

  it("exact classes: the document shape, site order, taxa/codon counts and is_invariable", () => {
    expect(Object.keys(body).slice(0, 11)).toEqual(["analysis", "alignment", "tree", "taxa_count", "codon_count", "runtime_sec", "filter_enabled", "artifacts_masked", "attribution_enabled", "attributions", "sites"]);
    expect(body.taxa_count).toBe(ref.taxa_count);
    expect(body.codon_count).toBe(ref.codon_count);
    expect(body.filter_enabled).toBe(false);
    expect(body.attribution_enabled).toBe(false);
    expect(body.artifacts_masked).toEqual([]);
    expect(body.attributions).toEqual({});
    expect(body.sites).toHaveLength(ref.sites.length);
    expect(body.sites.map((s) => s.site)).toEqual(ref.sites.map((s) => s.site));
    expect(body.sites.map((s) => s.is_invariable)).toEqual(ref.sites.map((s) => s.is_invariable));
    for (const s of body.sites) {
      if (s.is_invariable) expect(s.hyphaeon_lrt).toBe(0);
      expect(typeof s.p_value).toBe("number");
      expect(typeof s.q_value).toBe("number");
      expect(s.isVariable).toBe(!s.is_invariable);
      expect(typeof s.call).toBe("string"); // the app's DM3 tier label (callModes.js), not a Python field
    }
    // Invariable sites never go through the graph: p is pvals_from_lrt_meme(0) as float32.
    const inv = body.sites.find((s) => s.is_invariable);
    const refInv = ref.sites.find((s) => s.is_invariable);
    expect(inv.p_value).toBe(refInv.p_value);
  });

  it("p and q are cmd_meme's float32 casts of the reference functions on this surface's LRTs", () => {
    const lrt = Float32Array.from(body.sites, (s) => s.hyphaeon_lrt);
    const python = pythonFor();
    let p;
    let q;
    if (python) {
      const py = pythonMemePq(python, lrt);
      p = py.p;
      q = py.q;
    } else {
      const js = memeSitePq(lrt);
      p = Array.from(js.pvals);
      q = Array.from(js.qvals);
    }
    for (let i = 0; i < lrt.length; i++) {
      expect(body.sites[i].p_value).toBe(Math.fround(body.sites[i].p_value));
      expect(body.sites[i].q_value).toBe(Math.fround(body.sites[i].q_value));
      expect(body.sites[i].p_value).toBe(Math.fround(p[i]));
      expect(body.sites[i].q_value).toBe(Math.fround(q[i]));
    }
    expect(python ? "python" : "library").toBeTruthy();
  });

  it("graph class: hyphaeon_lrt within 1e-5 x max(1, |lrt|) of `hyphaeon meme` (MDS signs canonical on both sides)", () => {
    let maxRel = 0;
    let maxAbs = 0;
    let worst = null;
    for (let i = 0; i < ref.sites.length; i++) {
      const got = body.sites[i].hyphaeon_lrt;
      const want = ref.sites[i].hyphaeon_lrt;
      const rel = relDiff(got, want);
      maxAbs = Math.max(maxAbs, Math.abs(got - want));
      if (rel > maxRel) {
        maxRel = rel;
        worst = { site: i + 1, got, want };
      }
    }
    const mds = mdsAgreement("bat_oas1", alignment, tree);
    expect(mds.taxaMatch).toBe(true);
    expect(mds.flipped, "MDS columns with the opposite sign to the reference's canonical z").toEqual([]);
    expect(mds.maxAbsDiff).toBeLessThanOrEqual(1e-5);
    console.log("[engine] bat_oas1 meme: max relative |dLRT| " + maxRel.toExponential(2) + " (abs " + maxAbs.toExponential(2) + ", site " + (worst && worst.site) + "); MDS max |dz| " + mds.maxAbsDiff.toExponential(2));
    expect(maxRel).toBeLessThanOrEqual(1e-5);
    expect(body.provenance.mds_sign).toBe("canonical");
  });

  it("refuses --mds-sign lapack in-process with an input-class error", async () => {
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, mds_sign: "lapack" } });
    expect(res.isError).toBe(true);
    const err = parseText(res);
    expect(err.kind).toBe("input");
    expect(err.error).toMatch(/canonical/);
    const okRes = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, mds_sign: "canonical", top: 1 } });
    expect(okRes.isError).toBeFalsy();
    expect(parseText(okRes).provenance.reference_command).toContain("--mds-sign");
  });

  it("refuses TN93 mode in-process with an input-class error and no model load", async () => {
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, use_tn93: true } });
    expect(res.isError).toBe(true);
    const err = parseText(res);
    expect(err.kind).toBe("input");
    expect(err.error).toMatch(/TN93/);
  });

  it("reports a topology-only tree as BRANCH_LENGTHS_MISSING in provenance when no estimator is available", async () => {
    const status = parseText(await ctx.client.callTool({ name: "list_models", arguments: {} }));
    const res = await ctx.client.callTool({
      name: "hyphaeon_meme",
      arguments: { alignment, tree: tree.replace(/:[0-9.eE+-]+/g, ""), top: 1 }
    });
    if (res.isError) throw new Error(res.content[0].text);
    const out = parseText(res);
    if (status.native.branch_length_estimator) {
      expect(out.provenance.preprocessing.branch_lengths_estimated).toBe(true);
      expect(out.provenance.preprocessing.tree_source).toBe("hyphy-hky85");
    } else {
      expect(out.provenance.preprocessing.branch_lengths_estimated).toBe(false);
      expect(out.provenance.preprocessing.branch_lengths_missing).toBe(true);
      expect(out.provenance.warnings.map((w) => w.code)).toContain("BRANCH_LENGTHS_MISSING");
    }
  });
});

describe("hyphaeon_busted in-process on Smc6 vs fixtures/e2e/busted_Smc6.json", () => {
  let ctx;
  let body;
  let alignment;
  let tree;
  const ref = fixture("busted_Smc6.json").outputs;

  beforeAll(async () => {
    ctx = await connect();
    alignment = await example("Smc6.fasta");
    tree = await example("Smc6.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_busted", arguments: { alignment, tree, gene: "Smc6", cpu: true, top: 5 } });
    if (res.isError) throw new Error("hyphaeon_busted failed: " + res.content[0].text);
    body = parseText(res);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("returns the cmd_busted record with mcp-stdio provenance and the neural-head disclosure", () => {
    expect(body.analysis).toBe("busted");
    expect(body.gene).toBe("Smc6");
    expect(body.taxa).toBe(ref.taxa);
    expect(body.sites).toBe(ref.sites);
    for (const k of ["p_value_acat", "p_value_simes", "omnibus_lrt", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "rate_distributions", "positive_selection_detected", "elapsed_seconds"]) {
      expect(body).toHaveProperty(k);
    }
    expect(body.rate_distributions.omega_1).toBe(0.1);
    expect(body.rate_distributions.omega_2).toBe(1.0);
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.provenance.surrogate_for).toBe("BUSTED");
    expect(body.provenance.neural_head.deterministic_upstream).toBe(false);
    expect(body.sites_detail).toHaveLength(5);
    expect(body.truncated.sites_detail.total).toBe(ref.sites);
    if (body.provenance.neural_head.enabled) {
      expect(body.selection_probability).toBeGreaterThanOrEqual(0);
      expect(body.selection_probability).toBeLessThanOrEqual(1);
      expect(typeof body.positive_selection_detected).toBe("boolean");
    } else {
      expect(body.selection_probability).toBeNull();
    }
  });

  it("statistical fields agree with `hyphaeon busted` at their classes (exact counts, 1e-6 derived, L x 1e-6 sums)", () => {
    const L = ref.sites;
    const diffs = {
      sig_sites_p05: Math.abs(body.sig_sites_p05 - ref.sig_sites_p05),
      sig_sites_p10: Math.abs(body.sig_sites_p10 - ref.sig_sites_p10),
      p_value_acat: Math.abs(body.p_value_acat - ref.p_value_acat),
      p_value_simes: Math.abs(body.p_value_simes - ref.p_value_simes),
      omnibus_lrt: Math.abs(body.omnibus_lrt - ref.omnibus_lrt),
      total_selection_energy: Math.abs(body.total_selection_energy - ref.total_selection_energy)
    };
    const mds = mdsAgreement("Smc6", alignment, tree);
    expect(mds.taxaMatch).toBe(true);
    expect(mds.flipped).toEqual([]);
    expect(mds.maxAbsDiff).toBeLessThanOrEqual(1e-5);
    console.log("[engine] Smc6 busted vs reference: " + JSON.stringify(diffs) + "; MDS max |dz| " + mds.maxAbsDiff.toExponential(2));
    expect(diffs.sig_sites_p05).toBe(0);
    expect(diffs.sig_sites_p10).toBe(0);
    expect(diffs.p_value_acat).toBeLessThanOrEqual(1e-6);
    expect(diffs.p_value_simes).toBeLessThanOrEqual(1e-6);
    expect(diffs.omnibus_lrt).toBeLessThanOrEqual(L * 1e-6);
    expect(diffs.total_selection_energy).toBeLessThanOrEqual(L * 1e-6);
  });
});

describe("hyphaeon_evaluate in-process vs fixtures/evaluation", () => {
  let ctx;
  const cases = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "evaluation", "evaluate_files.json"), "utf8"));
  const errors = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "evaluation", "evaluate_files_errors.json"), "utf8"));
  const input = (name) => readFileSync(path.join(ENGINE_ROOT, "fixtures", "evaluation", "inputs", name), "utf8");

  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  function expectClose(got, want, where) {
    if (typeof want === "number") {
      if (Number.isInteger(want) && Number.isInteger(got)) expect(got, where).toBe(want);
      else expect(Math.abs(got - want), where).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
    } else if (Array.isArray(want)) {
      expect(Array.isArray(got), where).toBe(true);
      expect(got.length, where).toBe(want.length);
      want.forEach((w, i) => expectClose(got[i], w, where + "[" + i + "]"));
    } else if (want && typeof want === "object") {
      for (const k of Object.keys(want)) expectClose(got[k], want[k], where + "." + k);
    } else {
      expect(got, where).toEqual(want);
    }
  }

  for (const c of cases) {
    it("reproduces " + c.name + " at 1e-9", async () => {
      const gene = c.inputs.prediction_file.replace(/\.csv$/, "");
      const res = await ctx.client.callTool({
        name: "hyphaeon_evaluate",
        arguments: {
          prediction: input(c.inputs.prediction_file),
          meme_result: input(c.inputs.meme_result_file),
          gene,
          variable_only: c.inputs.variable_only,
          allow_site_mismatch: c.inputs.allow_site_mismatch
        }
      });
      if (res.isError) throw new Error(res.content[0].text);
      const body = parseText(res);
      expect(body.provenance.surface).toBe("mcp-stdio");
      expect(body.provenance.is_surrogate).toBe(false);
      expect(body.provenance.reference_command[1]).toBe("evaluate");
      const { provenance, analysis, ...report } = body;
      expectClose(report, c.outputs.result, c.name);
    });
  }

  it("reports a strict site mismatch as an input error with evaluation.py's message", async () => {
    const c = errors.find((e) => e.name === "site_mismatch_strict");
    const res = await ctx.client.callTool({
      name: "hyphaeon_evaluate",
      arguments: { prediction: input(c.inputs.prediction_file), meme_result: input(c.inputs.meme_result_file), gene: "geneB" }
    });
    expect(res.isError).toBe(true);
    const err = parseText(res);
    expect(err.kind).toBe("input");
    expect(err.error).toContain(c.outputs.message);
  });
});
