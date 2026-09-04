import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect } from "./helpers.js";
import { CODES } from "../src/validate.js";

describe("resources", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("lists the static resources and the example template", async () => {
    const { resources } = await ctx.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("hyphaeon://models");
    expect(uris).toContain("hyphaeon://methods/requirements");
    expect(uris).toContain("hyphaeon://caveats");
    expect(uris).toContain("hyphaeon://examples/Smc6.fasta");
    const { resourceTemplates } = await ctx.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("hyphaeon://examples/{name}");
  });

  it("serves caveats keyed by model_version with the model_eval numbers", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://caveats" });
    const caveats = JSON.parse(res.contents[0].text);
    expect(caveats.v1.model_version).toBe("v1");
    expect(caveats.v1.model_eval.calibration.results.find((r) => r.config === "large_deep").fpr_alpha_005).toBe("~36%");
    expect(caveats.v1.model_eval.concordance.results.find((r) => r.dataset === "bat_oas1").spearman_rho).toBe(0.27);
    expect(caveats.v1.model_card.variants.viral.spearman_vs_meme_unseen_viral).toBe(0.43);
  });

  it("serves the requirements with the validation codes", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://methods/requirements" });
    const body = JSON.parse(res.contents[0].text);
    expect(Object.keys(body.pillars).sort()).toEqual(["busted", "dms", "epistasis", "evaluate", "meme", "phenotype"]);
    expect(body.pillars.meme.options.model_variant.cli).toBe("--model-variant");
    expect(body.validation_codes).toEqual(CODES);
    expect(body.caps.work.sync_max).toBe(2.5e9);
  });

  it("serves an example by name and refuses traversal", async () => {
    const ok = await ctx.client.readResource({ uri: "hyphaeon://examples/bat_oas1.nwk" });
    expect(ok.contents[0].text.trim().startsWith("(")).toBe(true);
    const bad = await ctx.client.readResource({ uri: "hyphaeon://examples/..%2Fmodel_config.json" });
    expect(bad.contents[0].text).toMatch(/^Error/);
    const missing = await ctx.client.readResource({ uri: "hyphaeon://examples/nope.fasta" });
    expect(missing.contents[0].text).toMatch(/No example named/);
  });

  it("serves the models view", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://models" });
    const body = JSON.parse(res.contents[0].text);
    expect(body).toHaveProperty("available");
    expect(body.variants.map((v) => v.variant)).toContain("viral");
  });
});
