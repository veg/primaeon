import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect } from "./helpers.js";
import { CODES } from "../src/validate.js";
import { listGalleryRecords, readGalleryIndex } from "../src/models.js";

describe("resources", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("lists the static resources and the two templates", async () => {
    const { resources } = await ctx.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("hyphaeon://models");
    expect(uris).toContain("hyphaeon://methods/requirements");
    expect(uris).toContain("hyphaeon://caveats");
    expect(uris).toContain("hyphaeon://gallery");
    expect(uris).toContain("hyphaeon://examples/Smc6.fasta");
    const { resourceTemplates } = await ctx.client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain("hyphaeon://examples/{name}");
    expect(templates).toContain("hyphaeon://gallery/{name}");
    expect(templates).toContain("hyphaeon://report/{id}");
    expect(templates).toContain("hyphaeon://temporal/{id}");
    // No report has been run in this server: nothing is listed, and reads explain themselves.
    expect(uris.filter((u) => u.startsWith("hyphaeon://report/"))).toEqual([]);
    const none = await ctx.client.readResource({ uri: "hyphaeon://report/" + "a".repeat(32) });
    expect(none.contents[0].mimeType).toBe("text/plain");
    expect(none.contents[0].text).toMatch(/^Error: no job/);
    const bad = await ctx.client.readResource({ uri: "hyphaeon://report/not-an-id" });
    expect(bad.contents[0].text).toMatch(/^Error: a report id is the 32-hex job_id/);
    // The temporal template behaves the same way, and says so in its own words rather than the
    // report's — a client that read "report" here would go looking for sections that do not exist.
    expect(uris.filter((u) => u.startsWith("hyphaeon://temporal/"))).toEqual([]);
    const noRun = await ctx.client.readResource({ uri: "hyphaeon://temporal/" + "b".repeat(32) });
    expect(noRun.contents[0].mimeType).toBe("text/plain");
    expect(noRun.contents[0].text).toMatch(/^Error: no job/);
    const badRun = await ctx.client.readResource({ uri: "hyphaeon://temporal/not-an-id" });
    expect(badRun.contents[0].text).toMatch(/^Error: a temporal id is the 32-hex job_id/);
  });

  it("serves caveats keyed by model_version with the model_eval numbers", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://caveats" });
    const caveats = JSON.parse(res.contents[0].text);
    expect(caveats.v1.model_version).toBe("v1");
    expect(caveats.v1.model_eval.calibration.results.find((r) => r.config === "large_deep").fpr_alpha_005).toBe("~36%");
    expect(caveats.v1.model_eval.concordance.results.find((r) => r.dataset === "bat_oas1").spearman_rho).toBe(0.27);
    expect(caveats.v1.model_card.variants.viral.spearman_vs_meme_unseen_viral).toBe(0.43);
  });

  it("serves the requirements with the validation codes; every pillar in-process, no tree required", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://methods/requirements" });
    const body = JSON.parse(res.contents[0].text);
    expect(Object.keys(body.pillars).sort()).toEqual(["analyze", "busted", "dates", "dating", "dms", "epistasis", "evaluate", "meme", "phenotype", "temporal"]);
    expect(body.pillars.meme.options.model_variant.cli).toBe("--model-variant");
    for (const name of Object.keys(body.pillars)) {
      // The two time pillars qualify the word: `dates` runs no model at all and `dating` runs one
      // only when asked, and the requirements resource has to say so rather than claim parity with
      // the pillars whose every run loads a graph.
      expect(body.pillars[name].engine, name).toMatch(/^in-process/);
      // D22: no pillar requires a tree.
      expect(body.pillars[name].requires_tree, name).toBe(false);
    }
    expect(body.pillars.analyze.sections_in_order[0]).toBe("diagnostics");
    expect(body.pillars.epistasis.options.seed.cli).toBe("--seed");
    expect(body.pillars.meme.options.mds_sign.default).toBe("canonical");
    // The tree rule says what happens without one, and names TN93 rather than an estimator.
    expect(body.pillars.meme.tree).toMatch(/OPTIONAL/);
    expect(body.pillars.meme.tree).toMatch(/Tamura-Nei 93/);
    expect(body.pillars.meme.tree).not.toMatch(/HKY85/);
    // Phase 6, the contract sentences the requirements resource must keep.
    expect(body.pillars.dates.engine).toMatch(/NO MODEL/);
    expect(body.pillars.dates.beast_xml).toMatch(/REFUSED/);
    expect(body.pillars.dates.name_matching.tiers).not.toContain("substring");
    expect(body.pillars.dating.tree).toMatch(/NONE, on any surface/);
    expect(body.pillars.dating.estimator_note).toMatch(/MODEL-FREE BY DEFAULT/);
    expect(body.pillars.dating.reference_command).toMatch(/OBJECT/);
    expect(body.pillars.temporal.always_a_job).toMatch(/NEVER returned inline/);
    expect(body.pillars.temporal.sections.names).toEqual(body.caps.temporal.sections);
    expect(body.pillars.temporal.honesty.null_state).toMatch(/not-started \| running \| finished \| stopped/);
    expect(body.pillars.temporal.honesty.p_perm_fill).toMatch(/NOT a measurement/);
    expect(body.pillars.temporal.honesty.wave_variance).toMatch(/MOVE WITH THE NULL/);
    expect(body.pillars.temporal.honesty.upstream_bugs_replicated.length).toBeGreaterThanOrEqual(4);
    expect(body.caps.taxa.dating_model_max).toBe(1500);
    expect(body.caps.temporal.always_a_job).toBe(true);
    // The date layer's whole vocabulary is published, refusals included.
    for (const code of ["DATES_NONE", "DATES_TOO_FEW", "DATES_NO_SPAN", "DATES_BEAST_XML_UNSUPPORTED", "DATES_BARE_NUMBER_MAJORITY", "DATES_UNDATED_PRESENT"]) {
      expect(body.validation_codes, code).toHaveProperty(code);
    }
    expect(body.pillars.phenotype.trait).toMatch(/preset/);
    expect(body.pillars.phenotype.permulations_need_a_tree).toMatch(/tree-free/);
    expect(body.pillars.analyze.options.phenotype.note).toMatch(/report-pass/);
    expect(body.report_sections).toEqual(["diagnostics", "sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype", "provenance", "timings"]);
    expect(body.validation_codes).toEqual(CODES);
    expect(body.validation_codes).toHaveProperty("TREE_FREE_TN93");
    expect(body.validation_codes).toHaveProperty("TN93_SATURATED_PAIRS");
    expect(body.validation_codes).toHaveProperty("DISTANCE_RESCALED");
    expect(body.validation_codes).not.toHaveProperty("BRANCH_LENGTHS_MISSING");
    expect(body.validation_codes).not.toHaveProperty("TREE_MISSING");
    expect(body.caps.work.sync_max).toBe(2.5e9);
    expect(body.caps.analyze.wait_default_sec).toBe(120);
    expect(body.provenance.native.analyses).toEqual(["meme", "busted", "epistasis", "dms", "phenotype", "evaluate", "analyze", "dates", "dating", "temporal"]);
    expect(body.provenance.bridged.analyses).toEqual([]);
    expect(body.provenance.bridged.note).toMatch(/no Python/i);
  });

  it("serves an example by name and refuses traversal", async () => {
    const ok = await ctx.client.readResource({ uri: "hyphaeon://examples/bat_oas1.nwk" });
    expect(ok.contents[0].text.trim().startsWith("(")).toBe(true);
    const bad = await ctx.client.readResource({ uri: "hyphaeon://examples/..%2Fmodel_config.json" });
    expect(bad.contents[0].text).toMatch(/^Error/);
    const missing = await ctx.client.readResource({ uri: "hyphaeon://examples/nope.fasta" });
    expect(missing.contents[0].text).toMatch(/No example named/);
  });

  it("serves the models view read through the runtime's manifest reader", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://models" });
    const body = JSON.parse(res.contents[0].text);
    expect(body.available).toBe(true);
    expect(body.manifest.onnx.outputs).toEqual(["lrt", "mean_root_attns", "root_repr"]);
    expect(body.variants.map((v) => v.variant)).toEqual(["general", "viral"]);
    expect(body.variants[0].onnx_path).toMatch(/general\.onnx$/);
    expect(body.dir).toMatch(/models$/);
  });

  it("serves the gallery index and the prebaked records that exist, and a clear error for the rest", async () => {
    const index = await ctx.client.readResource({ uri: "hyphaeon://gallery" });
    const body = JSON.parse(index.contents[0].text);
    const found = await readGalleryIndex();
    if (!found) {
      expect(body.available).toBe(false);
      return;
    }
    expect(Array.isArray(body.entries)).toBe(true);
    expect(Array.isArray(body.records)).toBe(true);
    const { entries } = await listGalleryRecords();
    const withRecord = entries.filter((e) => e.servable);
    const { resourceTemplates } = await ctx.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("hyphaeon://gallery/{name}");
    if (withRecord.length) {
      const rec = await ctx.client.readResource({ uri: "hyphaeon://gallery/" + withRecord[0].id });
      expect(rec.contents[0].mimeType).toBe("application/json");
      const doc = JSON.parse(rec.contents[0].text);
      expect(typeof doc).toBe("object");
      const { resources } = await ctx.client.listResources();
      expect(resources.map((r) => r.uri)).toContain("hyphaeon://gallery/" + withRecord[0].id);
    }
    const missing = await ctx.client.readResource({ uri: "hyphaeon://gallery/not-an-example" });
    expect(missing.contents[0].text).toMatch(/^Error: No gallery entry/);
    const bad = await ctx.client.readResource({ uri: "hyphaeon://gallery/..%2Findex.json" });
    expect(bad.contents[0].text).toMatch(/^Error/);
    const noRecord = entries.find((e) => !e.result);
    if (noRecord) {
      const r = await ctx.client.readResource({ uri: "hyphaeon://gallery/" + noRecord.id });
      expect(r.contents[0].text).toMatch(/^Error: Gallery entry .* has no prebaked record/);
    }
  });
});
