/**
 * dating.test.js — hyphaeon_dating, the molecular clock.
 *
 * WHY THIS FILE EXISTS
 *
 * There is no `dating` comparator in `scripts/parity.py` and no `fixtures/dating/` to compare
 * against, so this file cannot be the per-pillar fixture parity file `phenotype.test.js` is. What
 * it CAN pin, and what matters most for a surface, is everything the tool promises about itself:
 *
 *   - that the default path runs NO MODEL, and that the model path is a DIFFERENT ANSWER rather
 *     than a better one (the twelve-year t_mrca gap this file measures for itself);
 *   - that every refusal in `runtime/src/dating/codes.js` DATING_REFUSALS and in the date layer
 *     comes back as `kind: "input"` with its own code — a refusal is RETURNED by `runDating`, not
 *     thrown, so an unguarded wrapper would resolve the call as a SUCCESS whose body says nothing
 *     ran, with a full provenance block and no isError;
 *   - that `reference_command` is the three-field object and that `reproduces` is false when the
 *     dates came from headers, with the reason named;
 *   - that the two date gates refuse before a run rather than after it.
 *
 * The numbers the port itself produces are checked against the reference in
 * `runtime/test/dating-port.test.js`; this file checks the SURFACE.
 *
 * EXAMPLES. korber_env_gp160.fasta (143 sequences, 981 codons) is the right one: it is the only
 * bundled example that exercises an undated sequence, imputation, the archival-1959 offer and an
 * explicit root taxon at once, and it is fast — measured in this session at 85 ms model-free
 * through the runtime and 75 ms through the tool.
 *
 * THE SLOW BLOCK. `use_model: true` runs one forward pass over EVERY codon through
 * `<variant>_taxa.onnx`: measured at 10.0 s end to end through the tool on this machine at 4
 * threads, which is 99% of this file's wall clock. It is behind HYPHAEON_SKIP_SLOW_TESTS the way
 * `phenotype.test.js`'s full-alignment comparison is, so it still runs on main, nightly, and for
 * anyone who types `npm test`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example, TEST_THREADS } from "./helpers.js";
import { DATING_REFUSALS, datingHeadline } from "@veg/hyphaeon-runtime/dating";
import { ANALYZE_INLINE_MAX_BYTES } from "../src/caps.js";

const SKIP_SLOW = process.env.HYPHAEON_SKIP_SLOW_TESTS === "1";
if (SKIP_SLOW) console.warn("[slow tests skipped] HYPHAEON_SKIP_SLOW_TESTS=1 — hyphaeon_dating's model pass did not run.");

describe("hyphaeon_dating: the model-free clock, and what it refuses", () => {
  let ctx;
  let korber;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    korber = await example("korber_env_gp160.fasta");
    // See temporal.test.js: vitest.config.js's hookTimeout is 30 s and loading a session under
    // full-suite contention has measured well past it.
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  const call = async (args) => {
    const res = await ctx.client.callTool({ name: "hyphaeon_dating", arguments: args });
    return { body: parseText(res), isError: res.isError === true };
  };

  it("korber: fits a clock over the 142 dated sequences and reports the estimator it used", async () => {
    const t0 = Date.now();
    const { body, isError } = await call({ alignment: korber, root_taxon: "CONSENSUS", drop_undated: true });
    const ms = Date.now() - t0;
    expect(isError).toBe(false);
    expect(body.analysis).toBe("dating");
    expect(body.ok).toBe(true);

    const record = body.record;
    // 142, not 143: the file holds 143 sequences, CONSENSUS is the root and one sequence
    // (CONSENSUS itself) carries no date, so the regression is over 142 points. That the two
    // numbers differ is the thing `hyphaeon_dates` exists to make visible before the run.
    expect(record.taxa_count).toBe(142);
    expect(body.taxa_summary).toHaveLength(142);
    // D34: this pillar takes no tree on any surface, and the record says so in its own field.
    expect(record.tree).toBeNull();
    expect(record.distance_mode).toBe("tn93");
    expect(body.honesty.distance_mode).toBe("tn93");
    expect(body.honesty.distance_mode_reason).toMatch(/no dating graph|auto/);
    expect(body.honesty.model_pass).toBe(false);
    expect(record.t_mrca).toBeGreaterThan(1900);
    expect(record.t_mrca).toBeLessThan(1960);
    expect(record.mu).toBeGreaterThan(0);
    expect(record.timespan[0]).toBeCloseTo(1959.5, 2);
    expect(["ols", "spline", "pgls", "ensemble"]).toContain(record.active_model);

    // `prediction_method` is OURS — the reference emits no such column, and three different models
    // land in one column upstream (measured there: 12 of 142 rows from an ancestral linear inverse,
    // 12 from the spline's linear arm, 118 from the root find). Every row must carry one.
    for (const row of body.taxa_summary) expect(typeof row.prediction_method, row.taxon).toBe("string");
    const methods = new Set(body.taxa_summary.map((r) => r.prediction_method));
    expect(methods.size).toBeGreaterThanOrEqual(1);
    for (const m of methods) expect(["ols", "spline", "linear_arm", "linear_fallback", "none"]).toContain(m);

    // The date review travels with the numbers: this clock was fitted to a set the caller can see.
    expect(body.date_review.coverage.dated).toBe(142);
    expect(body.date_review.by_rule.korber_isolate).toBe(142);
    expect(body.provenance.preprocessing.date_gate.applied).toContain("DATES_UNDATED_PRESENT");

    console.log("[dating] korber model-free through the tool: " + ms + " ms, t_mrca " + record.t_mrca.toFixed(2) + ", mu " + record.mu.toExponential(3) + ", active " + record.active_model);
  });

  it("reference_command is {command, reproduces, caveats}, and reproduces is FALSE on header dates", async () => {
    const { body } = await call({ alignment: korber, root_taxon: "CONSENSUS", drop_undated: true });
    const ref = body.provenance.reference_command;
    // NOT the argv array the other six pillars carry. A bare string here would promise a
    // reproduction this pillar cannot give.
    expect(Array.isArray(ref)).toBe(false);
    expect(typeof ref.command).toBe("string");
    expect(typeof ref.reproduces).toBe("boolean");
    expect(Array.isArray(ref.caveats)).toBe(true);

    expect(ref.command).toMatch(/^hyphaeon dating /);
    // D34: always --no-tree, never a default. Printed without it the line would ask for patristic
    // distances the run never computed and, with no tree to find, would not run at all.
    expect(ref.command).toMatch(/--no-tree/);
    expect(ref.command).toMatch(/--distance-mode tn93/);
    expect(ref.command).toMatch(/--root-taxon CONSENSUS/);
    expect(ref.command).toMatch(/--method ols/);
    expect(ref.command).not.toMatch(/--loocv|--bootstrap|--clock-model power/);

    // The dates came from the sequence headers, read by a wider parser than the reference's, so
    // the printed line does NOT reproduce this run and says which caveat is the reason.
    expect(ref.reproduces).toBe(false);
    expect(ref.caveats.join(" ")).toMatch(/korber_isolate/);
    expect(ref.caveats.join(" ")).toMatch(/two-column CSV|`-d`/);
    // Caveat zero is on every run, whatever `reproduces` says.
    expect(ref.caveats[0]).toMatch(/does not make the two files diff clean/);

    // What this build does not estimate is quoted rather than flagged.
    const names = body.honesty.estimators_not_built.map((e) => e.name);
    expect(names).toContain("Power-law clock");
    expect(names).toContain("Leave-one-out / jackknife");
    expect(names).toContain("Attention PGLS");
    expect(names).toContain("Latent root search");
    expect(ref.caveats.join(" ")).toMatch(/Power-law clock/);
  });

  it("says which fit it may be quoted on, and says it in the browser's own words", async () => {
    // PHASE 6 REVIEW. The `/time` route does not headline `record.t_mrca` — `datingHeadline`
    // (runtime/src/dating/headline.js) refuses a fit whose `ci_mrca` is a point estimate `[x, x]`,
    // which every spline fit is upstream, and attaches a refutation to a fit whose clock slope is
    // not distinguishable from zero. The MCP had NO equivalent: `summary.t_mrca` and
    // `record.t_mrca` were the only doors, and both are `active_model`'s. This asserts the rule
    // reaches the wire, and that it is the SAME function rather than a second implementation.
    const { body } = await call({ alignment: korber, root_taxon: "CONSENSUS", drop_undated: true });
    const expected = datingHeadline(body.record);
    expect(expected).toBeTruthy();

    for (const head of [body.honesty.headline, body.summary && body.summary.headline].filter(Boolean)) {
      expect(head.key).toBe(expected.key);
      expect(head.active_model).toBe(expected.activeKey);
      expect(head.departed).toBe(expected.departed);
      expect(head.quotable).toBe(expected.quotable);
      expect(head.refutation).toBe(expected.refutation);
      // The date on the block is the QUOTED fit's, which is the record's own top-level number only
      // when the two agree.
      expect(head.t_mrca).toBe(expected.model.t_mrca);
      if (!head.departed) expect(head.t_mrca).toBe(body.record.t_mrca);
    }

    // And where they disagree the reproduction line says so, because `out.json` carries the other
    // number: a reader diffing the file against what the tool told them must find both named.
    const caveats = body.provenance.reference_command.caveats.join(" ");
    if (body.honesty.headline.departed) expect(caveats).toMatch(/different numbers from the same run/);
    if (!body.honesty.headline.quotable) expect(caveats).toMatch(/not a finding/);
  });

  it("prints -d and drops the header caveat when the dates came from a metadata table", async () => {
    const alignment = await example("H5N1_HA_geo.fasta");
    const metadata = await example("H5N1_HA_metadata.csv");
    const { body, isError } = await call({ alignment, dates_file: metadata, dates_file_name: "H5N1_HA_metadata.csv" });
    expect(isError).toBe(false);
    const ref = body.provenance.reference_command;
    expect(ref.command).toMatch(/-d H5N1_HA_metadata\.csv/);
    expect(ref.caveats.join(" ")).not.toMatch(/korber_isolate/);
    expect(body.date_review.source).toBe("table");
    // Nothing undated here, so no gate was needed and none was applied.
    expect(body.provenance.preprocessing.date_gate.applied).toEqual([]);
  });

  it("refuses BOTH date gates before anything runs, with the code and the override named", async () => {
    // Undated sequences: korber leaves one, and without drop_undated the run is refused rather
    // than quietly fitted to 142 of 143.
    const undated = await call({ alignment: korber, root_taxon: "CONSENSUS" });
    expect(undated.isError).toBe(true);
    expect(undated.body.kind).toBe("input");
    expect(undated.body.code).toBe("DATES_UNDATED_PRESENT");
    expect(undated.body.hint).toMatch(/drop_undated/);
    // The refusal carries the review, so a client is handed the rule table rather than told to
    // go and ask for it.
    expect(undated.body.date_review.coverage.undated).toBe(1);
    expect(undated.body.date_headline).toMatch(/142 of 143/);

    // Bare numbers: H1N1 under a forced non-calendar unit.
    const h1n1 = await example("H1N1_2009_pandemic.fasta");
    const bare = await call({ alignment: h1n1, time_units: "generations" });
    expect(bare.isError).toBe(true);
    expect(bare.body.kind).toBe("input");
    expect(bare.body.code).toBe("DATES_BARE_NUMBER_MAJORITY");
    expect(bare.body.hint).toMatch(/accept_bare_numbers/);
    expect(bare.body.blocking.map((b) => b.code)).toContain("DATES_BARE_NUMBER_MAJORITY");
  });

  it("classifies a RETURNED refusal as an input error with its own code, not as a completed run", async () => {
    // `runDating` returns `{ok: false, refusal, warnings}` and never throws. An unguarded wrapper
    // resolves that as a SUCCESS whose body is `{ok: false, record: null}` with a full provenance
    // block and no isError — a client reads "the analysis ran" and finds nulls. These two cases
    // reach the two refusals a small synthetic alignment can produce.

    // Every sequence carries the same date: a clock is a slope, and there is no time axis.
    const flat =
      ">s1_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCC\n" +
      ">s2_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n" +
      ">s3_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCA\n" +
      ">s4_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCT\n";
    const noSpan = await call({ alignment: flat });
    expect(noSpan.isError).toBe(true);
    expect(noSpan.body.kind).toBe("input");
    // The date layer gets there first on this input, which is the cheaper refusal and the same
    // fact; either code is about the caller's metadata and neither is a server fault.
    expect(["DATES_NO_SPAN", DATING_REFUSALS.NO_TIME_SPAN]).toContain(noSpan.body.code);
    expect(noSpan.body.hint).toMatch(/time axis|different times/);

    // Too few dated: three sequences, one dated.
    const sparse =
      ">alpha_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCC\n" +
      ">beta\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n" +
      ">gamma\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCA\n";
    const few = await call({ alignment: sparse, drop_undated: true });
    expect(few.isError).toBe(true);
    expect(few.body.kind).toBe("input");
    expect(["DATES_TOO_FEW", "DATES_NO_SPAN", DATING_REFUSALS.TOO_FEW_DATED]).toContain(few.body.code);
    // NEVER the server class: the generic server hint would tell a caller with a metadata problem
    // to report it to the operator, which is the Phase 3 TN93 mistake repeated.
    expect(few.body.hint || "").not.toMatch(/report it to the operator/);
  });

  it("refuses an option the port does not implement, as an INPUT error rather than a server fault", async () => {
    // `runDating` THROWS a RangeError for these, and none of their messages matched INPUT_PATTERNS
    // before Phase 6 — so they fell through to the server class and told a caller with a typo that
    // "nothing about the submitted data will change this; report it to the operator".

    // `latent` without the model pass: the estimator was not supplied, so there is nothing to run.
    const latent = await call({ alignment: korber, drop_undated: true, distance_mode: "latent" });
    expect(latent.isError).toBe(true);
    expect(latent.body.kind).toBe("input");
    expect(latent.body.error).toMatch(/distanceMode|latent|neural/i);

    // An interval method the schema refuses outright, before the engine is reached at all.
    const badCi = await ctx.client.callTool({ name: "hyphaeon_dating", arguments: { alignment: korber, drop_undated: true, ci_method: "jackknife" } });
    expect(badCi.isError).toBe(true);
  });

  it("`top` slices the per-taxon table in the reference's own order, and the summary ranks the outliers", async () => {
    const { body } = await call({ alignment: korber, root_taxon: "CONSENSUS", drop_undated: true, top: 5 });
    expect(body.taxa_summary).toHaveLength(5);
    expect(body.truncated.taxa_summary).toEqual({ returned: 5, total: 142, ranked_by: "input order" });

    const summary = await call({ alignment: korber, root_taxon: "CONSENSUS", drop_undated: true, summary_only: true });
    expect(summary.body.summary.taxa_summary_rows).toBe(142);
    // The READER's order lives in the summary, so a truncated table never has to pretend to be it.
    expect(summary.body.summary.top_outliers.length).toBeGreaterThan(0);
    expect(summary.body.summary.top_outliers.length).toBeLessThanOrEqual(10);
    expect(summary.body.summary.t_mrca).toBeCloseTo(body.record.t_mrca, 6);
    // The honesty block survives summary_only: t_mrca without its distance mode is not an answer.
    expect(summary.body.summary.honesty.distance_mode).toBe("tn93");
  });
});

describe.skipIf(SKIP_SLOW)("hyphaeon_dating with the second ONNX artifact", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("use_model switches the estimator and the answer, and says so on the record", async () => {
    const korber = await example("korber_env_gp160.fasta");
    const args = { alignment: korber, root_taxon: "CONSENSUS", drop_undated: true, summary_only: true };

    const free = parseText(await ctx.client.callTool({ name: "hyphaeon_dating", arguments: args }));
    const t0 = Date.now();
    const withModel = parseText(await ctx.client.callTool({ name: "hyphaeon_dating", arguments: { ...args, use_model: true } }));
    const ms = Date.now() - t0;

    expect(free.summary.distance_mode).toBe("tn93");
    expect(withModel.summary.distance_mode).toBe("latent");
    expect(withModel.summary.honesty.model_pass).toBe(true);
    expect(withModel.summary.honesty.distance_mode_reason).toMatch(/auto/);

    // THE POINT OF THE DEFAULT. The same sequences and the same dates give two different ancestor
    // dates, which is why `use_model` is an explicit request and never an availability accident.
    const gap = Math.abs(free.summary.t_mrca - withModel.summary.t_mrca);
    expect(gap).toBeGreaterThan(1);
    console.log(
      "[dating] korber: model-free t_mrca " + free.summary.t_mrca.toFixed(2) + " vs latent " + withModel.summary.t_mrca.toFixed(2) +
        " (" + gap.toFixed(2) + " years apart); model pass " + ms + " ms at " + TEST_THREADS + " threads"
    );

    // With the graph, the two estimators that need it are no longer "not built".
    const names = withModel.summary.honesty.estimators_not_built.map((e) => e.name);
    expect(names).not.toContain("Attention PGLS");
    expect(names).not.toContain("Latent root search");
    expect(names).toContain("Power-law clock");
    // And the reproduction line asks the reference for both halves.
    expect(withModel.provenance.reference_command.command).toMatch(/--method all/);
    expect(withModel.provenance.reference_command.command).toMatch(/--distance-mode latent/);
  });
});

describe("hyphaeon_dating: what shaping keeps, and the size a tool result may be", () => {
  let ctx;
  let korber;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    korber = await example("korber_env_gp160.fasta");
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  const call = async (args) => {
    const res = await ctx.client.callTool({ name: "hyphaeon_dating", arguments: args });
    return { body: parseText(res), isError: res.isError === true, bytes: Buffer.byteLength(res.content[0].text) };
  };

  /**
   * A synthetic dated set. The per-taxon table is O(taxa) and its width does not depend on the
   * codon count, so 300 codons at the taxon ceiling is the cheapest way to measure the envelope.
   */
  function synth(n, codons) {
    const bases = "ACGT";
    let rng = 12345;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const root = Array.from({ length: codons * 3 }, () => bases[Math.floor(rand() * 4)]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = [...root];
      const nmut = 5 + Math.floor(rand() * 40);
      for (let m = 0; m < nmut; m++) s[Math.floor(rand() * s.length)] = bases[Math.floor(rand() * 4)];
      const year = 1990 + Math.floor(rand() * 30);
      const month = 1 + Math.floor(rand() * 12);
      const day = 1 + Math.floor(rand() * 28);
      out.push(">seq" + String(i).padStart(4, "0") + "_" + year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0") + "\n" + s.join(""));
    }
    return out.join("\n") + "\n";
  }

  it("`distance_mode: latent` without use_model is refused with a CODE and the two arguments a caller has", async () => {
    // PHASE 6 REVIEW, M5. It used to come back as the runtime's own RangeError — "distanceMode
    // 'latent' needs the dating graph: pass `neural`, the object runDatingModelPass returns" — with
    // no `code` and a hint about the alignment's reading frame. `neural` is an internal argument of
    // a function the caller cannot call.
    const res = await call({ alignment: korber, drop_undated: true, distance_mode: "latent" });
    expect(res.isError).toBe(true);
    expect(res.body.kind).toBe("input");
    expect(res.body.code).toBe("DATING_LATENT_NEEDS_MODEL");
    expect(res.body.error).not.toMatch(/runDatingModelPass|`neural`/);
    expect(res.body.hint).toMatch(/use_model: true/);
    expect(res.body.hint).toMatch(/distance_mode/);
    expect(res.body.hint).not.toMatch(/in frame|reading frame/);

    // The two ways through it are the two the hint names, and neither is silently substituted.
    const tn93 = await call({ alignment: korber, drop_undated: true, distance_mode: "tn93" });
    expect(tn93.isError).toBe(false);
    expect(tn93.body.summary === undefined ? tn93.body.record.distance_mode : tn93.body.summary.distance_mode).toBe("tn93");
  });

  it("summary_only keeps `ok` and the honesty block: shaping may drop rows, never the qualifications", async () => {
    // PHASE 6 REVIEW, M6a. summary_only came back as [analysis, summary, collections, provenance]:
    // a client reading `body.ok` to see whether the run happened found nothing at all.
    const whole = await call({ alignment: korber, drop_undated: true });
    const summary = await call({ alignment: korber, drop_undated: true, summary_only: true });
    expect(whole.body.ok).toBe(true);
    expect(summary.body.ok).toBe(true);
    expect(summary.body.honesty).toBeTruthy();
    expect(summary.body.honesty.distance_mode).toBe(whole.body.honesty.distance_mode);
    expect(summary.body.honesty.reference_command.reproduces).toBe(whole.body.honesty.reference_command.reproduces);
    // The block a summary block must stand alone with is still there too.
    expect(summary.body.summary.honesty.distance_mode).toBe("tn93");
    expect(summary.bytes).toBeLessThan(whole.bytes);
    console.log("[dating] korber: whole " + whole.bytes + " B, summary_only " + summary.bytes + " B");
  });

  it("a result at the taxon ceiling is bounded, and says what it cut and how to get the rest", async () => {
    // PHASE 6 REVIEW, M6c. Measured before the bound: 1,000 taxa x 300 codons answered with
    // 750,846 bytes inline, of which the per-taxon table was 366,524 TWICE — `taxa_summary` and
    // `record.taxa_summary` are the same rows — so `top: 50` still returned 402,728 B.
    const alignment = synth(1000, 300);
    const res = await call({ alignment });
    expect(res.isError).toBe(false);
    expect(res.bytes).toBeLessThanOrEqual(ANALYZE_INLINE_MAX_BYTES);

    // THE CUT IS SAID, NOT DONE QUIETLY: both halves of it.
    expect(res.body.inline_bound.limit_bytes).toBe(ANALYZE_INLINE_MAX_BYTES);
    expect(res.body.inline_bound.was_bytes).toBeGreaterThan(ANALYZE_INLINE_MAX_BYTES);
    expect(res.body.record.taxa_summary.omitted).toBe(true);
    expect(res.body.record.taxa_summary.rows).toBe(1000);
    expect(res.body.truncated.taxa_summary.total).toBe(1000);
    expect(res.body.truncated.taxa_summary.returned).toBe(res.body.taxa_summary.length);
    expect(res.body.truncated.taxa_summary.note).toMatch(/summary_only|top:/);

    // The numbers themselves are untouched: this is an envelope, not an analysis change.
    expect(res.body.ok).toBe(true);
    expect(res.body.record.taxa_count).toBe(1000);
    expect(Number.isFinite(res.body.record.t_mrca)).toBe(true);
    // The rows a reader looks at first survive whatever the cut did.
    const summary = await call({ alignment, summary_only: true });
    expect(summary.bytes).toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
    expect(summary.body.summary.top_outliers.length).toBe(10);
    expect(summary.body.summary.taxa_summary_rows).toBe(1000);
    console.log(
      "[dating] 1,000 taxa x 300 codons: " + res.body.inline_bound.was_bytes + " B unbounded -> " + res.bytes + " B (" +
        res.body.truncated.taxa_summary.returned + " of 1000 rows); summary_only " + summary.bytes + " B"
    );

    // A SMALL RESULT IS NOT TOUCHED. The bound fires on size, not on the analysis.
    const small = await call({ alignment: korber, drop_undated: true });
    expect(small.body.inline_bound).toBeUndefined();
    expect(small.body.truncated).toBeUndefined();
    expect(Array.isArray(small.body.record.taxa_summary)).toBe(true);
  }, 300000);
});
