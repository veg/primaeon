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
  });

  it("serves caveats keyed by model_version with the model_eval numbers", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://caveats" });
    const caveats = JSON.parse(res.contents[0].text);
    expect(caveats.v1.model_version).toBe("v1");
    expect(caveats.v1.model_eval.calibration.results.find((r) => r.config === "large_deep").fpr_alpha_005).toBe("~36%");
    expect(caveats.v1.model_eval.concordance.results.find((r) => r.dataset === "bat_oas1").spearman_rho).toBe(0.27);
    expect(caveats.v1.model_card.variants.viral.spearman_vs_meme_unseen_viral).toBe(0.43);
  });

  it("serves the requirements with the validation codes and the engine split", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://methods/requirements" });
    const body = JSON.parse(res.contents[0].text);
    expect(Object.keys(body.pillars).sort()).toEqual(["busted", "dms", "epistasis", "evaluate", "meme", "phenotype"]);
    expect(body.pillars.meme.options.model_variant.cli).toBe("--model-variant");
    expect(body.pillars.meme.engine).toBe("in-process");
    expect(body.pillars.epistasis.engine).toBe("python-reference");
    expect(body.validation_codes).toEqual(CODES);
    expect(body.validation_codes).toHaveProperty("BRANCH_LENGTHS_MISSING");
    expect(body.validation_codes).toHaveProperty("DISTANCE_RESCALED");
    expect(body.caps.work.sync_max).toBe(2.5e9);
    expect(body.provenance.native.analyses).toEqual(["meme", "busted", "evaluate"]);
    expect(body.provenance.bridged.analyses).toEqual(["epistasis", "dms", "phenotype"]);
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
