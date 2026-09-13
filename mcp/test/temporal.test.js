/**
 * temporal.test.js — hyphaeon_temporal, the selection pillar and its permutation null.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 5's review found the browser failing honesty twice on this pillar, and both failures are
 * surface failures rather than arithmetic ones: a partial null reported as a finished negative
 * result, and a reproduction command printed without the reason it cannot reproduce. Neither shows
 * up in a fixture comparison. So this file pins the SURFACE — the size rule, the section
 * vocabulary, the four null states, the p_perm fill, the wave-share conditioning, and the refusals
 * — and leaves the numbers to `runtime/test/temporal-port.test.js`, which compares the port against
 * `fixtures/temporal/acceptance/`.
 *
 * THE EXAMPLE. H5N1_HA_geo.fasta + H5N1_HA.nwk + H5N1_HA_metadata.csv is the cheapest honest end to
 * end run in the repository: measured in this session, 98 sequences x 566 codons through
 * general.onnx at 4 threads is 4,065 ms for the whole pillar WITH the reference's own full
 * 1,000-draw null inside its work budget, and it exercises the metadata-table date path, the tree
 * path, duplicate collapse, tied dates, the near-degenerate wave flag and the sign convention in
 * one run. H1N1 at the CLI's defaults is 24.8 s and 7.2 MB, which is the right acceptance test and
 * the wrong unit test.
 *
 * THE SLOW BLOCK. The full-grid run (the reference's own `--time-points 250` and `-B 1000`) is
 * behind HYPHAEON_SKIP_SLOW_TESTS, as `phenotype.test.js`'s full-alignment comparison is. The fast
 * blocks use a coarser grid and fewer draws, which changes nothing this file asserts: every
 * assertion here is about shape, state and wording, and the two that are about SIZE are checked at
 * the grid they were measured at.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example, TEST_THREADS } from "./helpers.js";
import { TEMPORAL_REFUSALS, TEMPORAL_THRESHOLDS } from "@veg/hyphaeon-runtime/temporal";
import { ANALYZE_INLINE_MAX_BYTES } from "../src/caps.js";
import { TEMPORAL_CURVES_MAX_POINTS, TEMPORAL_MIN_DATED_TAXA, TEMPORAL_SECTIONS, TIME_REFUSAL_HINTS } from "../src/time.js";

const SKIP_SLOW = process.env.HYPHAEON_SKIP_SLOW_TESTS === "1";
if (SKIP_SLOW) console.warn("[slow tests skipped] HYPHAEON_SKIP_SLOW_TESTS=1 — the full-grid temporal run did not run.");

/** The fast settings: the same analysis at a coarser grid and a shorter null. */
const FAST = { time_points: 60, n_permutations: 200 };

describe("hyphaeon_temporal: the job rule, the sections, and the null's four states", () => {
  let ctx;
  let inputs;
  let first;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    inputs = {
      alignment: await example("H5N1_HA_geo.fasta"),
      tree: await example("H5N1_HA.nwk"),
      dates_file: await example("H5N1_HA_metadata.csv"),
      dates_file_name: "H5N1_HA_metadata.csv"
    };
    const t0 = Date.now();
    first = parseText(await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, ...FAST } }));
    console.log(
      "[temporal] H5N1 (98 x 566) at time_points " + FAST.time_points + ", B " + FAST.n_permutations + ": " + (Date.now() - t0) +
        " ms at " + TEST_THREADS + " threads; " + first.summary.stage1_candidates + " candidates, " + first.summary.confirmed_sweeps + " confirmed"
    );
    // 900 s, not vitest.config.js's 30 s hookTimeout: this hook runs the whole pillar, and under
    // full-suite contention on this machine the same run measured 63.7 s against 3.0 s alone.
    // phenotype.test.js's own hook carries the same number for the same reason.
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  const section = async (name, extra = {}) => {
    const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: first.job_id, section: name, ...extra } });
    return { body: parseText(res), isError: res.isError === true, bytes: Buffer.byteLength(res.content[0].text) };
  };

  it("always a job, and the reply is the summary — never the record", async () => {
    expect(first.analysis).toBe("temporal");
    expect(first.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.status).toBe("completed");
    expect(first.stage).toBe("complete");
    expect(first.sections).toEqual([...TEMPORAL_SECTIONS]);
    // THE RECORD IS NOT IN THE REPLY. `record` never appears at the top level, and what does appear
    // is inside the same envelope every other tool's inline answer has to fit.
    expect(first.record).toBeUndefined();
    expect(first.summary.codons_total).toBe(566);
    expect(first.summary.taxa_timestamped).toBeGreaterThan(90);
    const bytes = Buffer.byteLength(JSON.stringify(first));
    expect(bytes).toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
    console.log("[temporal] job reply " + bytes + " B against the " + ANALYZE_INLINE_MAX_BYTES + " B inline limit");
  });

  it("serves every section, and none of them is over the inline limit", async () => {
    const sizes = {};
    for (const name of TEMPORAL_SECTIONS) {
      const { body, isError, bytes } = await section(name);
      expect(isError, name).toBe(false);
      expect(body.section, name).toBe(name);
      expect(body.analysis, name).toBe("temporal");
      // EVERY SECTION CARRIES THE HONESTY BLOCK. A caller that pages one section must not have to
      // fetch another to learn whether its numbers are final.
      expect(body.honesty, name).toBeTruthy();
      expect(body.honesty.null_state, name).toBeTruthy();
      expect(bytes, name + " is " + bytes + " B").toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
      sizes[name] = bytes;
    }
    console.log("[temporal] section sizes (bytes): " + Object.entries(sizes).map(([k, v]) => k + " " + v).join(", "));
  });

  it("a `sites` list handed to a section that is not about codons is reported, not dropped", async () => {
    // PHASE 6 REVIEW, M6b's other half: `sites` is applied by `sites` and `curves` and by nothing
    // else, and a caller who passes it elsewhere must be told so rather than handed a body that
    // looks like an answer to the question it asked.
    const waves = await section("waves", { sites: [1, 2, 3] });
    expect(waves.isError).toBe(false);
    expect(waves.body.ignored.sites).toMatch(/`sites` and `curves`/);
    const rows = await section("sites", { sites: [1, 2, 3] });
    expect(rows.body.ignored).toBeUndefined();
  });

  it("an unknown section is an input error naming the vocabulary, not a silent empty body", async () => {
    const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: first.job_id, section: "gene" } });
    expect(res.isError).toBe(true);
    const body = parseText(res);
    expect(body.kind).toBe("input");
    expect(body.sections).toEqual([...TEMPORAL_SECTIONS]);
  });

  it("`sites` defaults to the candidates, ranked, and says so; `sites=[...]` names codons", async () => {
    const all = await section("sites");
    expect(all.body.rows.length).toBeGreaterThan(0);
    expect(all.body.rows_available).toBe(first.summary.stage1_candidates);
    expect(all.body.selection).toMatch(/stage-one candidate/);
    // NOT a default of every codon: `p_perm` at a non-candidate is the reference's assumed 1.0.
    expect(all.body.rows_available).toBeLessThan(all.body.codons_total);
    // Ranked strongest first, so a truncated view keeps the strongest rather than the first codons.
    const peaks = all.body.rows.map((r) => r.peak_intensity);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThanOrEqual(peaks[i - 1] + 1e-12);

    const named = await section("sites", { sites: [1, 2, 3] });
    expect(named.body.rows.map((r) => r.site)).toEqual([1, 2, 3]);
    expect(named.body.selection).toMatch(/codons you named/);

    const bad = await section("sites", { sites: [99999] });
    expect(bad.isError).toBe(true);
    expect(bad.body.kind).toBe("input");
    expect(bad.body.error).toMatch(/out of range 1\.\.566/);
  });

  it("`curves` is budgeted in numbers, truncates with the ranking named, and flags the duplicated column", async () => {
    const curves = await section("curves");
    expect(curves.body.time_points).toBe(FAST.time_points);
    expect(curves.body.time).toHaveLength(FAST.time_points);
    expect(curves.body.curves[0].prevalence).toHaveLength(FAST.time_points);
    expect(curves.body.curves[0].velocity).toHaveLength(FAST.time_points);
    // The truncation says what it kept and by what key — a slice with a false `ranked_by` label
    // would be a plausible object that is not the analysis.
    expect(curves.body.curves_available).toBe(first.summary.stage1_candidates);
    if (curves.body.curves_returned < curves.body.curves_available) {
      expect(curves.body.truncated.curves.ranked_by).toBe("peak_intensity");
      expect(curves.body.truncated.note).toMatch(/budgeted in NUMBERS/);
    }
    // UPSTREAM BUG, REPLICATED AND FLAGGED: the reference's CSV writes one array into two
    // differently named columns (temporal.py:807-808). The section says so rather than shipping
    // two names for one quantity.
    expect(curves.body.duplicate_column_note).toMatch(/selection_intensity/);
    expect(curves.body.duplicate_column_note).toMatch(/one quantity here, not two/);

    const named = await section("curves", { sites: [10, 20] });
    expect(named.body.curves.map((c) => c.site)).toEqual([10, 20]);
    expect(named.body.curves_returned).toBe(2);
  });

  it("the null that COMPLETED is `finished`, and nothing is uncalled", async () => {
    const perm = await section("permutations");
    expect(perm.body.permutations.requested).toBe(FAST.n_permutations);
    expect(perm.body.permutations.completed).toBe(FAST.n_permutations);
    expect(perm.body.permutations.cancelled).toBe(false);
    expect(perm.body.permutations.skipped).toBe(false);
    expect(perm.body.permutations.tested).toBe(true);
    expect(perm.body.permutations.rng).toBe("xoshiro256**");

    const h = perm.body.honesty;
    expect(h.null_state).toBe("finished");
    expect(h.calls_are_final).toBe(true);
    // `uncalledBecause` is null exactly when there IS a result to print instead of a reason.
    expect(h.uncalled_because).toBeNull();
    expect(h.wave_columns_pending).toBe(false);
  });

  it("a null DECLINED over budget is `stopped`, not `running`, and every other column still exists", async () => {
    // Over the work budget the null withholds the null and NOTHING ELSE: trajectories, velocities,
    // peaks, widths, areas, candidates and wave modes are all still computed, and the four-way
    // classification degrades to three. Saying "has not finished" about this run would be false —
    // nothing is coming — and that is the state the browser used to render forever.
    const skipped = parseText(
      await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, ...FAST, perm_work_budget: 1 } })
    );
    expect(skipped.stage).toBe("complete");
    const h = skipped.honesty;
    expect(h.permutations.skipped).toBe(true);
    expect(h.permutations.completed).toBe(0);
    expect(h.null_state).toBe("stopped");
    expect(h.calls_are_final).toBe(false);
    expect(h.uncalled_because).toBe("the date-shuffling null was declined before it started, as over the work budget");
    expect(h.uncalled_because).not.toMatch(/has not finished/);

    // THE DISTINCTION SURVIVES TO THE WIRE. A CANDIDATE the null never tested carries NaN, which
    // JSON.stringify writes as `null` — not 1.0, and not 0 — so "not tested" and "not a sweep" stay
    // different answers. A non-candidate carries the reference's own 1.0 fill. This is the whole
    // reason a stopped or declined null is worth keeping, and the one place the port deliberately
    // departs from the reference's fill (which has no behaviour here: upstream, B always completes).
    const cand = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: skipped.job_id, section: "candidates" } }));
    const rows = parseText(
      await ctx.client.callTool({ name: "get_results", arguments: { job_id: skipped.job_id, section: "sites", sites: [cand.candidates[0], 1] } })
    ).rows;
    expect(rows[0].p_perm).toBeNull();
    expect(rows[0].q_perm).toBeNull();
    expect(rows[1].p_perm).toBe(1);

    // The rest of the analysis survived.
    expect(skipped.summary.stage1_candidates).toBeGreaterThan(0);
    expect(skipped.summary.bandwidth_years).toBeGreaterThan(0);
    const codes = (await (async () => {
      const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: skipped.job_id, section: "warnings" } });
      return parseText(res).warnings.map((w) => w.code);
    })())
    expect(codes).toContain("TEMPORAL_NULL_SKIPPED");

    // A declined null cannot reproduce either, and the caveat says which absence it is.
    expect(skipped.honesty.reference_command.reproduces).toBe(false);
    expect(skipped.honesty.reference_command.caveats.join(" ")).toMatch(/above its work budget|NO permutation numbers/);
  });

  it("p_perm = 1.0 is flagged as the reference's fill, and NOT as the key to who was tested", async () => {
    const h = first.honesty;
    const untested = first.summary.codons_total - first.summary.stage1_candidates;
    expect(h.p_perm_fill).toMatch(new RegExp(String(untested)));
    expect(h.p_perm_fill).toMatch(/not a measurement/i);
    expect(h.p_perm_fill).toMatch(/temporal\.py:620-621/);

    // THE CLAIM THIS ASSERTION REPLACES was "a CANDIDATE whose null did not run carries NaN, never
    // 1.0, so `not tested` and `not a sweep` stay distinguishable". Literally true of a stopped
    // null, and false as the reading it invited: a TESTED candidate that every shuffle beat scores
    // (1 + B) / (B + 1) = 1.0 exactly, so 1.0 does not mean untested. The same honesty block
    // disproved it — `download_notes` carries the runtime's `temporalPPermNote`, whose measured
    // counter-example is H5N1 at B = 200, 399 rows at 1.0 against 398 non-candidates. Two fields of
    // one object said opposite things; the note is the runtime's now and this asserts the true one.
    expect(h.p_perm_fill).not.toMatch(/NaN, never 1\.0/);
    expect(h.p_perm_fill).toMatch(/`classification`/);
    expect(h.p_perm_fill).toMatch(/does NOT mean untested|not mean untested/);
    // ... and it names the call THIS surface serves the mask with, not a record key a CSV reader
    // has no access to.
    expect(h.p_perm_fill).toMatch(/section=candidates/);
    // The honesty block no longer contradicts its own download notes.
    expect(h.download_notes.join(" ")).toMatch(/does NOT mean untested|not mean untested/);

    // And the record keeps the mask that separates the two meanings: a codon OUTSIDE stage one
    // carries the fill, a codon inside it carries a drawn p.
    const nonCandidate = await section("sites", { sites: [1] });
    expect(nonCandidate.body.rows[0].p_perm).toBeTypeOf("number");
    const cand = await section("candidates");
    expect(cand.body.candidates.length).toBe(first.summary.stage1_candidates);
    const one = await section("sites", { sites: [cand.body.candidates[0]] });
    expect(one.body.rows[0].p_perm).toBeGreaterThan(0);
    expect(one.body.rows[0].p_perm).toBeLessThanOrEqual(1);
    // `classification` is on the row, which is what makes the note's advice followable here.
    expect(typeof one.body.rows[0].classification).toBe("string");
  });

  it("the wave shares carry the set they are conditioned on, and the sign convention", async () => {
    const waves = await section("waves");
    const wv = waves.body.wave_variance;
    expect(wv.shares_pct).toEqual(first.summary.fpca_wave_variance_pct);
    expect(["confirmed-sweeps", "peak-intensity-fallback"]).toContain(wv.source);
    expect(wv.conditioned_on).toBeTruthy();
    if (wv.source === "confirmed-sweeps") {
      expect(wv.conditioned_on).toMatch(/thresholded on the permutation p/);
      expect(wv.note).toMatch(/MOVE WITH THE NULL/);
      expect(wv.note).toMatch(/32 confirmed here against 18 there/);
    } else {
      expect(wv.note).toMatch(/fewer than four confirmed/);
      expect(wv.note).toMatch(/which BRANCH was taken/i);
    }
    // D28: the reference has no convention and writes its solver's raw singular vectors.
    expect(wv.sign).toBe("canonical");
    expect(wv.note).toMatch(/a mode and its negative are the same mode/);
  });

  it("reference_command is the object, reproduces is FALSE because the null drew, and it says so", async () => {
    const ref = first.honesty.reference_command;
    expect(Array.isArray(ref)).toBe(false);
    expect(ref.command).toMatch(/^hyphaeon temporal /);
    // Inline text has no file name, so every pillar records the same placeholder `alignment.fasta`
    // — the `-d` name is present only because the date layer takes one as an explicit option, since
    // it is the sole source of `-d` on this line.
    expect(ref.command).toMatch(/-a alignment\.fasta/);
    expect(ref.command).toMatch(/-d H5N1_HA_metadata\.csv/);
    expect(ref.command).toMatch(new RegExp("-B " + FAST.n_permutations));
    expect(ref.command).toMatch(new RegExp("--time-points " + FAST.time_points));
    // EVERY run whose null drew at all: numpy MT19937 upstream against xoshiro256** here (D17).
    expect(ref.reproduces).toBe(false);
    expect(ref.caveats.join(" ")).toMatch(/xoshiro256\*\*/);
    expect(ref.caveats.join(" ")).toMatch(/MT19937|RandomState\(42\)/);
    // Caveat zero, on every run whatever `reproduces` says.
    expect(ref.caveats[0]).toMatch(/does not make the four files diff clean/);
    // The notes that must travel with the CSVs.
    expect(first.honesty.download_notes.length).toBeGreaterThanOrEqual(5);
    expect(first.honesty.download_notes.join(" ")).toMatch(/selection_intensity` and `sweep_velocity` from the same array/);

    // The same object is on provenance, so a client reading provenance alone still sees it.
    const prov = await section("summary");
    expect(prov.body.provenance.reference_command.reproduces).toBe(false);
  });

  it("keeps the caller's metadata document out of provenance.options, and the section filter too", async () => {
    // The phenotype_file precedent: a caller's Auspice JSON can be megabytes, and an option is
    // copied into the job store and into provenance. Only the NAME is an option — and `sites`,
    // which SHAPES a section rather than restricting the run, must not land there either, or the
    // provenance would claim the run had been limited to those codons when it had not.
    const withSites = parseText(
      await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, ...FAST, sites: [1, 2, 3], section: "summary" } })
    );
    const opts = withSites.provenance.options;
    expect(opts).not.toHaveProperty("dates_file");
    expect(opts).not.toHaveProperty("alignment");
    expect(opts).not.toHaveProperty("tree");
    expect(opts).not.toHaveProperty("sites");
    expect(opts).not.toHaveProperty("section");
    expect(opts.dates_file_name).toBe("H5N1_HA_metadata.csv");
    expect(JSON.stringify(opts)).not.toMatch(/A\/Goose|ATGC{4}/);
  });

  it("carries the dates it analysed, including the rules the reference does not have", async () => {
    const dates = await section("dates");
    expect(dates.body.dates.file).toBe("H5N1_HA_metadata.csv");
    expect(dates.body.dates.dated).toBe(first.summary.taxa_timestamped);
    // The DateIngest went in, not a bare map, so the rule table and the beyond-reference count
    // survived: `by_rule` is populated and `beyond_reference` is a measurement rather than a zero
    // the input could not support.
    expect(dates.body.dates.by_rule).toBeTruthy();
    expect(dates.body.dates.beyond_reference).not.toBeNull();
    expect(typeof dates.body.dates.beyond_reference.count).toBe("number");
    expect(dates.body.dates.source).toBe("table");
  });

  it("refuses the date gates and a date set with no clock, all as input errors", async () => {
    const h1n1 = await example("H1N1_2009_pandemic.fasta");

    // Undated sequences: H1N1 dates 95 of 100 from its headers.
    const undated = await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { alignment: h1n1, ...FAST } });
    expect(undated.isError).toBe(true);
    const ub = parseText(undated);
    expect(ub.kind).toBe("input");
    expect(ub.code).toBe("DATES_UNDATED_PRESENT");
    expect(ub.date_review.coverage.undated).toBe(5);

    // Bare numbers under a forced unit.
    const bare = await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { alignment: h1n1, time_units: "generations", ...FAST } });
    expect(bare.isError).toBe(true);
    expect(parseText(bare).code).toBe("DATES_BARE_NUMBER_MAJORITY");

    // Fewer than five dated: temporal's own threshold (temporal.py:474), refused before the graph.
    const sparse =
      ">a_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCC\n" +
      ">b_2002\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n" +
      ">c_2003\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCA\n" +
      ">d_2004\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCT\n";
    const few = await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { alignment: sparse, ...FAST } });
    expect(few.isError).toBe(true);
    const fb = parseText(few);
    expect(fb.kind).toBe("input");
    expect([TEMPORAL_REFUSALS.TOO_FEW_DATED, "DATES_TOO_FEW"]).toContain(fb.code);
    // NEVER the server class: this is the caller's metadata, and the Phase 3 TN93 misclassification
    // is the mistake this assertion exists to keep from being repeated.
    expect(fb.hint || "").not.toMatch(/report it to the operator/);

    // No dates at all.
    const undatedAll = ">alpha\nATGAAACCCGGG\n>beta\nATGAAACCCGGT\n>gamma\nATGAAACCCGGA\n>delta\nATGAAACCCGGC\n>eps\nATGAAACCCGTC\n";
    const none = await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { alignment: undatedAll, ...FAST } });
    expect(none.isError).toBe(true);
    const nb = parseText(none);
    expect(nb.kind).toBe("input");
    expect([TEMPORAL_REFUSALS.NO_DATES, "DATES_NONE"]).toContain(nb.code);
  });

  it("hyphaeon://temporal/{id} serves the summary and the honesty block, never the record", async () => {
    const list = await ctx.client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain("hyphaeon://temporal/" + first.job_id);

    const res = await ctx.client.readResource({ uri: "hyphaeon://temporal/" + first.job_id });
    expect(res.contents[0].mimeType).toBe("application/json");
    const body = JSON.parse(res.contents[0].text);
    expect(body.analysis).toBe("temporal");
    expect(body.job_id).toBe(first.job_id);
    expect(body.summary.codons_total).toBe(566);
    expect(body.honesty.null_state).toBe("finished");
    expect(body.sections).toEqual([...TEMPORAL_SECTIONS]);
    expect(body.next).toMatch(/never served whole/);
    // The bulk is NOT here: a resource that served the record would hand a client both the
    // megabytes it cannot use and the two columns it must not read unqualified.
    expect(body.record).toBeUndefined();
    expect(body.curves).toBeUndefined();
    expect(Buffer.byteLength(res.contents[0].text)).toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
  });

  it("run_async hands back the job id at once, and job_status names the sections", async () => {
    const queued = parseText(
      await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, ...FAST, run_async: true } })
    );
    expect(queued.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(queued.reason).toMatch(/run_async requested/);
    expect(queued.next).toMatch(/never returned inline/);

    const status = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
    expect(status.analysis).toBe("temporal");
    expect(status.sections).toEqual([...TEMPORAL_SECTIONS]);
    await ctx.client.callTool({ name: "cancel_job", arguments: { job_id: queued.job_id } });
  });
});

describe.skipIf(SKIP_SLOW)("hyphaeon_temporal at the reference's own grid", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("the full record is many times the inline limit, and the sections are not", async () => {
    const inputs = {
      alignment: await example("H5N1_HA_geo.fasta"),
      tree: await example("H5N1_HA.nwk"),
      dates_file: await example("H5N1_HA_metadata.csv"),
      dates_file_name: "H5N1_HA_metadata.csv"
    };
    const t0 = Date.now();
    // The reference's own defaults: --time-points 250, -B 1000.
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, time_points: 250, n_permutations: 1000 } }));
    const ms = Date.now() - t0;
    expect(body.stage).toBe("complete");
    expect(body.honesty.null_state).toBe("finished");
    expect(body.honesty.permutations.completed).toBe(1000);

    // THE SIZE RULE, MEASURED RATHER THAN ASSERTED FROM A COMMENT. The record itself is what the
    // tool refuses to inline; every section it serves instead fits.
    const summary = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: body.job_id } }));
    const recordKb = Number((summary.note.match(/is (\d+) KB/) || [])[1]);
    expect(recordKb * 1024).toBeGreaterThan(ANALYZE_INLINE_MAX_BYTES * 4);

    const sizes = {};
    for (const name of TEMPORAL_SECTIONS) {
      const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: body.job_id, section: name } });
      const bytes = Buffer.byteLength(res.content[0].text);
      expect(bytes, name + " is " + bytes + " B").toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
      sizes[name] = bytes;
    }
    console.log(
      "[temporal] H5N1 at the reference's grid (T 250, B 1000): " + ms + " ms, record " + recordKb + " KB (" +
        (((recordKb * 1024) / ANALYZE_INLINE_MAX_BYTES) | 0) + "x the inline limit); sections " +
        Object.entries(sizes).map(([k, v]) => k + " " + v).join(", ")
    );
  });
});

describe("a stopped run: what survives a cancel, and what says so", () => {
  // PHASE 6 REVIEW, M1 and M2. A temporal job cancelled mid-null used to answer `status:
  // "cancelled"` with the record DISCARDED, and get_results then said "Poll job_status until
  // status is completed" about a job that can never be completed — while the runtime had in fact
  // run its stop-early path to completion and handed back a full record at the achieved draw
  // count. Measured for this suite on H5N1 at -B 10,000, cancelled 1.5 s into the null: the run
  // resolved at 4,364 of 10,000 draws with 168 candidates and 16 confirmed sweeps.
  let ctx;
  let inputs;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    inputs = {
      alignment: await example("H5N1_HA_geo.fasta"),
      tree: await example("H5N1_HA.nwk"),
      dates_file: await example("H5N1_HA_metadata.csv"),
      dates_file_name: "H5N1_HA_metadata.csv"
    };
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  const call = async (name, args) => {
    const res = await ctx.client.callTool({ name, arguments: args });
    return { body: parseText(res), isError: res.isError === true, bytes: Buffer.byteLength(res.content[0].text) };
  };

  /** Submit a long run and stop it once the null has drawn for `ms`. */
  const stopMidNull = async (ms) => {
    const started = await call("hyphaeon_temporal", { ...inputs, time_points: 60, n_permutations: 10000, run_async: true });
    const jid = started.body.job_id;
    for (;;) {
      const st = (await call("job_status", { job_id: jid })).body;
      if (st.progress && /temporal-null/.test(st.progress.phase || "")) break;
      if (st.status !== "queued" && st.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, ms));
    const cancelled = await call("cancel_job", { job_id: jid });
    let status;
    for (;;) {
      status = (await call("job_status", { job_id: jid })).body;
      if (!status.result_pending) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { jid, submit: started.body, cancel: cancelled.body, status };
  };

  it("the not-yet-finished reply is its own shape, and its `next` names a call that works", async () => {
    // M2: with wait_seconds it used to hand back the job store's public view and a `next` pointing
    // at get_results section=summary, which CANNOT succeed on a running temporal job — nothing of
    // the record exists until the null ends.
    const pending = await call("hyphaeon_temporal", { ...inputs, time_points: 60, n_permutations: 10000, wait_seconds: 1 });
    expect(pending.isError).toBe(false);
    expect(pending.body.shape).toBe("pending");
    expect(pending.body.analysis).toBe("temporal");
    expect(["queued", "running"]).toContain(pending.body.status);
    expect(pending.body.result_available).toBe(false);
    expect(pending.body.summary).toBeUndefined();
    expect(pending.body.sections_ready).toEqual([]);
    expect(pending.body.next).toMatch(/^job_status job_id=[0-9a-f]{32}/);
    expect(pending.body.reason).toMatch(/did not finish within wait_seconds/);

    // The call the `next` names WORKS, and the one it defers to fails with the reason it defers.
    const status = await call("job_status", { job_id: pending.body.job_id });
    expect(status.isError).toBe(false);
    expect(["queued", "running"]).toContain(status.body.status);
    const tooSoon = await call("get_results", { job_id: pending.body.job_id, section: "summary" });
    expect(tooSoon.isError).toBe(true);
    expect(tooSoon.body.kind).toBe("input");

    // run_async takes the same shape, so a client switches on one key either way.
    const async_ = await call("hyphaeon_temporal", { ...inputs, time_points: 60, n_permutations: 200, run_async: true });
    expect(async_.body.shape).toBe("pending");
    expect(async_.body.next).toMatch(/job_status job_id=/);
    await call("cancel_job", { job_id: pending.body.job_id });
    await call("cancel_job", { job_id: async_.body.job_id });
  }, 300000);

  it("a cancel mid-null KEEPS the record, and every door to it says it is partial and at what count", async () => {
    const { jid, cancel, status } = await stopMidNull(1200);

    // cancel_job says what it expects to keep rather than "keeps nothing".
    expect(cancel.success).toBe(true);
    expect(cancel.partial_result_expected).toBe(true);

    // job_status: available, partial, and never advised to wait for `completed`.
    expect(status.status).toBe("cancelled");
    expect(status.partial_result).toBe(true);
    expect(status.result_available).toBe(true);
    expect(status.next).toMatch(/get_results job_id=/);
    expect(status.next).not.toMatch(/until status is completed/);

    // get_results serves it, labelled, with the achieved count.
    const whole = await call("get_results", { job_id: jid });
    expect(whole.isError).toBe(false);
    expect(whole.body.status).toBe("cancelled");
    expect(whole.body.partial_result).toBe(true);
    expect(whole.body.partial.completed).toBeGreaterThan(0);
    expect(whole.body.partial.completed).toBeLessThan(10000);
    expect(whole.body.partial.requested).toBe(10000);
    expect(whole.body.partial.note).toMatch(/THIS RUN WAS STOPPED/);
    expect(whole.body.partial.note).toMatch(new RegExp("-B " + whole.body.partial.completed));
    // The analysis is really there: this is a record, not a stub.
    expect(whole.body.summary.stage1_candidates).toBeGreaterThan(0);
    expect(whole.body.stage).toBe("complete");

    // Every section carries it too, on the honesty block every section already had.
    for (const name of ["summary", "permutations", "sites", "waves"]) {
      const sec = await call("get_results", { job_id: jid, section: name });
      expect(sec.isError, name).toBe(false);
      expect(sec.body.status, name).toBe("cancelled");
      expect(sec.body.partial_result, name).toBe(true);
      expect(sec.body.honesty.null_truncated, name).toBeTruthy();
      expect(sec.body.honesty.null_truncated.completed, name).toBe(whole.body.partial.completed);
      // `p_perm` was estimated at the ACHIEVED count, and the grid it bought is on the wire.
      expect(sec.body.honesty.null_truncated.grid_step, name).toBeCloseTo(1 / (whole.body.partial.completed + 1), 12);
    }
    const perm = await call("get_results", { job_id: jid, section: "permutations" });
    expect(perm.body.permutations.cancelled).toBe(true);
    expect(perm.body.permutations.completed).toBe(whole.body.partial.completed);
    expect(perm.body.permutations.requested).toBe(10000);
    // The runtime's own warning for the same fact is on the record.
    const warned = await call("get_results", { job_id: jid, section: "warnings" });
    expect(warned.body.warnings.map((w) => w.code)).toContain("TEMPORAL_NULL_TRUNCATED");

    // And the resource serves it as stopped, never as finished.
    const res = await ctx.client.readResource({ uri: "hyphaeon://temporal/" + jid });
    const body = JSON.parse(res.contents[0].text);
    expect(body.status).toBe("cancelled");
    expect(body.partial_result).toBe(true);
    expect(body.partial.completed).toBe(whole.body.partial.completed);
    const listed = (await ctx.client.listResources()).resources.find((r) => r.uri === "hyphaeon://temporal/" + jid);
    expect(listed.description).toMatch(/STOPPED/);
  }, 300000);

  it("a call WAITING on a run someone else stops answers with the partial record, not with a refusal", async () => {
    // The other half of M1: the cancel arrives while the tool call is still inside its
    // wait_seconds, which is where a second client (or a timeout) stops a run. The reply must be
    // the record the runtime kept, labelled — not "the run was cancelled" with the work discarded.
    const pending = ctx.client.callTool({
      name: "hyphaeon_temporal",
      arguments: { ...inputs, time_points: 60, n_permutations: 10000, wait_seconds: 120 }
    });
    // The job id is not known to the caller until the call returns, so the store is the handle
    // here, exactly as a second client's job_status listing would be.
    let job = null;
    for (;;) {
      job = ctx.handle.jobs.list().find((j) => j.analysis === "temporal" && j.status === "running" && j.progress && /temporal-null/.test(j.progress.phase || ""));
      if (job) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 400));
    ctx.handle.jobs.cancel(job.job_id);

    const res = await pending;
    expect(res.isError).toBeFalsy();
    const body = parseText(res);
    expect(body.status).toBe("cancelled");
    expect(body.partial_result).toBe(true);
    expect(body.partial.completed).toBeGreaterThan(0);
    expect(body.partial.requested).toBe(10000);
    expect(body.summary.stage1_candidates).toBeGreaterThan(0);
    expect(body.honesty.null_truncated.completed).toBe(body.partial.completed);
  }, 300000);

  it("a cancel BEFORE the null keeps nothing, and says so without telling a client to wait for it", async () => {
    const started = await call("hyphaeon_temporal", { ...inputs, time_points: 60, n_permutations: 200, run_async: true });
    const jid = started.body.job_id;
    await new Promise((r) => setTimeout(r, 30));
    await call("cancel_job", { job_id: jid });
    let status;
    for (;;) {
      status = (await call("job_status", { job_id: jid })).body;
      if (!status.result_pending) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(status.status).toBe("cancelled");
    expect(status.partial_result).toBe(false);
    expect(status.result_available).toBe(false);

    const res = await call("get_results", { job_id: jid });
    expect(res.isError).toBe(true);
    expect(res.body.kind).toBe("input");
    expect(res.body.error).toMatch(/cancelled and kept nothing/);
    // THE ADVICE MUST BE ACTIONABLE. "Poll job_status until status is completed" was the old
    // answer, about a job that can never be completed.
    expect(res.body.hint).not.toMatch(/until status is completed/);
    expect(res.body.hint).toMatch(/can never reach `completed`/);
    expect(res.body.hint).toMatch(/Submit the run again/);
  }, 300000);
});

describe("the temporal thresholds and budgets this surface quotes", () => {
  it("TEMPORAL_MIN_DATED_TAXA is the runtime's own number, and message and hint agree on it", () => {
    // M4: the refusal's message said five (temporal.py:474, `if N < 5: raise`) and its hint said
    // three, because the dispatcher handed every clock refusal DATES_TOO_FEW's hint.
    expect(TEMPORAL_MIN_DATED_TAXA).toBe(TEMPORAL_THRESHOLDS.minDatedTaxa);
    const hint = TIME_REFUSAL_HINTS.TEMPORAL_TOO_FEW_DATED;
    expect(hint).toMatch(new RegExp("at least " + TEMPORAL_MIN_DATED_TAXA + " dated sequences"));
    expect(hint).not.toMatch(/At least 3 sequences/);
  });

  it("every hint that quotes a threshold quotes its OWN code's threshold", () => {
    // The sweep M4 asked for: no hint may name a number that contradicts the code it belongs to.
    expect(TIME_REFUSAL_HINTS.DATES_TOO_FEW).toMatch(/At least 3 sequences/);
    expect(TIME_REFUSAL_HINTS.DATING_TOO_FEW_DATED).toMatch(/At least 3 sequences/);
    expect(TIME_REFUSAL_HINTS.TEMPORAL_TOO_FEW_DATED).toMatch(/at least 5 dated sequences/);
    // Each of the three names the tool that reports what was read, never the alignment fix.
    for (const code of ["DATES_TOO_FEW", "DATING_TOO_FEW_DATED", "TEMPORAL_TOO_FEW_DATED"]) {
      expect(TIME_REFUSAL_HINTS[code], code).not.toMatch(/in frame|reading frame/);
    }
  });
});

describe("the `curves` budget, re-measured", () => {
  // PHASE 6 REVIEW, M7. TEMPORAL_CURVES_MAX_POINTS used to record "15.3 bytes at T = 60 and 15.2
  // at T = 250 — stable", a figure taken from two curves. A curve is a run of JSON doubles and its
  // width is the width of ITS OWN numbers, so the cost per number is a distribution (13.5 to 22.6
  // measured over every curve the section serves), not a constant, and the budget has to follow
  // the WORST case because the caller chooses the codons. This test measures it again on every
  // run, prints the numbers, and fails if the budget stops fitting the envelope.
  let ctx;
  let inputs;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    inputs = {
      alignment: await example("H5N1_HA_geo.fasta"),
      tree: await example("H5N1_HA.nwk"),
      dates_file: await example("H5N1_HA_metadata.csv"),
      dates_file_name: "H5N1_HA_metadata.csv"
    };
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("stays inside the inline envelope at both ends of the time grid, at the measured worst cost", async () => {
    const rows = [];
    for (const T of [60, 250]) {
      const run = parseText(await ctx.client.callTool({ name: "hyphaeon_temporal", arguments: { ...inputs, time_points: T, n_permutations: 100 } }));
      const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: run.job_id, section: "curves" } });
      const body = parseText(res);
      const bytes = Buffer.byteLength(res.content[0].text);
      const per = body.curves.map((c) => Buffer.byteLength(JSON.stringify(c)) / (2 * T));
      const numbers = body.curves_returned * 2 * T;
      const head = bytes - body.curves.reduce((a, c) => a + Buffer.byteLength(JSON.stringify(c)), 0);
      rows.push({ T, curves: body.curves_returned, numbers, bytes, head, worst: Math.max(...per), mean: per.reduce((a, b) => a + b, 0) / per.length });

      // The budget is a budget in NUMBERS and it is honoured.
      expect(numbers).toBeLessThanOrEqual(TEMPORAL_CURVES_MAX_POINTS);
      expect(body.curves_returned).toBe(Math.floor(TEMPORAL_CURVES_MAX_POINTS / (2 * T)));
      // And the section it buys fits, with the head the honesty block costs included.
      expect(bytes, "T " + T + " curves section is " + bytes + " B").toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
    }
    // THE BOUND THE CONSTANT IS DERIVED FROM. If a future record makes a number wider, or the
    // honesty block grows past the 20 KB head this budget reserves, this is what catches it.
    for (const r of rows) {
      expect(r.head, "fixed head at T " + r.T + " is " + r.head + " B").toBeLessThan(20 * 1024);
      expect(TEMPORAL_CURVES_MAX_POINTS * r.worst + 20 * 1024, "worst-case budget at T " + r.T).toBeLessThan(ANALYZE_INLINE_MAX_BYTES);
    }
    console.log(
      "[temporal] curves budget " + TEMPORAL_CURVES_MAX_POINTS + " numbers: " +
        rows.map((r) => "T " + r.T + " -> " + r.curves + " curves, " + r.bytes + " B, head " + r.head + " B, bytes/number mean " + r.mean.toFixed(2) + " worst " + r.worst.toFixed(2)).join("; ")
    );
  }, 300000);
});
