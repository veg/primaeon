/**
 * caps.js — size and work caps for every HyphAeon MCP analysis tool.
 *
 * WHY THIS FILE EXISTS
 *
 * The analysis tools answer INSIDE the tool call when the input is small enough, and hand back a
 * job id otherwise (PLAN.md 3.6). Something has to decide "small enough", and it has to be one
 * decision shared by every tool, measured on the file as submitted, before any model is loaded.
 * Since Phase 3 EVERY pillar runs in this process (src/engine.js), so the caps also keep one tool
 * call from monopolising the server's event loop; the reason they exist is the same either way: a
 * single MCP tool call has to come back in a time a human and a client will wait for, and a laptop
 * has to survive the run.
 *
 * Where the numbers come from:
 *
 *   MAX_ALIGNMENT_CHARS  8 MiB. datamonkey-js-server lib/mcp/tools.js:22 — enforced by the zod
 *                        schema before the string is touched. PLAN.md 3.5 keeps the same figure for
 *                        the Node server.
 *   MAX_SYNC_CODONS      12,000 codon sites. tools.js:23 and PLAN.md 3.6 ("answers inside the call
 *                        under axomeme_scan's caps, 12,000 codons and work 2.5e9").
 *   MAX_SYNC_WORK        2.5e9 = sites x taxa^2. tools.js:24. The model reads an N x N distance
 *                        matrix per site, so cost is quadratic in taxa, not linear. The taxa count
 *                        is the number of sequences in the file as submitted, BEFORE duplicate
 *                        collapse or PD subsampling, and the site count is the LONGEST sequence
 *                        (tools.js:621-629): a ragged file whose first sequence is 3 nt long would
 *                        otherwise wave through a 40,000-codon run.
 *   MAX_WORK             2.5e9 — the hard cap PLAN.md 3.5 sets for the server ("work L x N_used^2
 *                        <= 2.5e9"). It equals MAX_SYNC_WORK, so the job path is taken only for
 *                        codon counts between MAX_SYNC_CODONS and the per-analysis cap.
 *   MAX_CODONS           PLAN.md 3.5: "codons <= 30,000 (meme/busted), <= 3,000 (dms)". Epistasis
 *                        and phenotype are not named there; they share the 30,000 figure because
 *                        their forward-pass cost is the meme cost plus attention, and the DMS sweep
 *                        inside epistasis runs only on sector nodes, not every site. `analyze`
 *                        (hyphaeon_analyze, the whole PLAN.md 4.0 report) is sized like meme: its
 *                        DMS section is capped by its OWN work budget inside the runtime
 *                        (progressive, cancellable, "above the cap the report says so"), so the
 *                        19x term is not part of the sync/job decision here.
 *   DMS_MUTANTS_PER_SITE 19. PLAN.md 1: dms is "19 substitutions x L sites" and "capped by work
 *                        19·L·N²", so the work term for dms is multiplied by 19.
 *   MIN_TAXA / MAX_TAXA  3 and 1,000. PLAN.md 3.5 and 4.3: "Taxa < 3 | refuse (#7)", "> 1,000
 *                        refuse". TAXON_CAP 512 is the model's hard ceiling (PLAN.md 3.3 manifest
 *                        taxon_cap), above which the CLI applies Faith's-PD subsampling.
 *   MAX_PERMUTATIONS     10,000; MAX_PERMULATIONS 2,000. PLAN.md 3.5. The CLI defaults to 10,000
 *                        permutations, so the cap is the default; permulations default to 0.
 *   JOB_TIMEOUT_MS       10 minutes. PLAN.md 3.5 "job timeout 10 min". The engine aborts the run at
 *                        this wallclock whether it is answering in the call or as a job.
 *   JOB_TTL_MS           7 days, PLAN.md 3.5 "TTL 7 days". MAX_JOBS bounds the in-process map; a
 *                        job store that lives in one Node process cannot rely on TTL alone.
 *
 * Measured reference (PLAN.md 1, Apple M4 Pro, CPU, the Python reference's path): meme on 476 x 335 (HIV1_RT,
 * work 7.6e7) takes 17 s; dms on the same file (work x19 = 1.4e9) takes 46 s. The 2.5e9 cap is
 * therefore roughly a minute and a half of dms on that machine, and well inside the timeout.
 *
 * This module is a LEAF: it imports nothing and touches no I/O. Everything here is a number or a
 * pure function of numbers so the web app's "Before you run" panel and the Node server can reuse
 * the same decision later without dragging the MCP in.
 */

export const MAX_ALIGNMENT_CHARS = 8 * 1024 * 1024;
export const MAX_SYNC_CODONS = 12000;
export const MAX_SYNC_WORK = 2.5e9;
export const MAX_WORK = 2.5e9;

export const MIN_TAXA = 3;
export const MAX_TAXA = 1000;
export const TAXON_CAP = 512;

export const MAX_CODONS = Object.freeze({
  meme: 30000,
  busted: 30000,
  epistasis: 30000,
  phenotype: 30000,
  dms: 3000,
  analyze: 30000,
  // Phase 6. EVERY analysis needs a row: `classifyRun` applies the codon cap only when
  // `MAX_CODONS[analysis] !== undefined`, so an analysis added without one is silently UNCAPPED on
  // sites and a 40,000-codon temporal upload sails through the only check that would have stopped
  // it. `temporal` and `dating` size like meme (one forward pass per codon); `dates` reads sequence
  // NAMES and never a codon, and carries the same row so the absence is a decision and not an
  // omission.
  temporal: 30000,
  dating: 30000,
  dates: 30000
});

export const DMS_MUTANTS_PER_SITE = 19;

export const MAX_PERMUTATIONS = 10000;
export const MAX_PERMULATIONS = 2000;

export const JOB_TIMEOUT_MS = 10 * 60 * 1000;
export const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_JOBS = 200;

/**
 * How long hyphaeon_analyze waits inside the call for the whole report before handing back the
 * job id with the sections that are ready (app-side semantics, not a CLI behaviour: the report
 * streams section by section, PLAN.md 4.0, and DMS runs last and may be minutes). The default is
 * what a human and an MCP client will sit through; the maximum is the job timeout.
 */
export const ANALYZE_WAIT_DEFAULT_SEC = 120;
export const ANALYZE_WAIT_MAX_SEC = JOB_TIMEOUT_MS / 1000;

/**
 * Above this many bytes of JSON, hyphaeon_analyze answers with the report's summary and the job
 * id (get_results pages it by `section`) instead of inlining the whole ReportRecord: an epistasis
 * section with attention-derived edges plus a 20 x L DMS grid is megabytes no client wants in one
 * tool result.
 */
export const ANALYZE_INLINE_MAX_BYTES = 256 * 1024;

/**
 * The analyses that run the network and therefore fall under the work caps.
 *
 * `dating` is here CONDITIONALLY and that is the point of the note: its default path is model-free
 * (a root-to-tip regression over TN93 distances, O(N x L), measured at 85 ms on the 143-sequence
 * korber example), and `use_model: true` adds one forward pass over every codon through
 * `<variant>_taxa.onnx` (measured upstream at 9.4-17.1 s on the same file — 88% of the wall clock).
 * `workFor` below switches on that option rather than on the analysis name.
 */
export const MODEL_ANALYSES = Object.freeze(["meme", "busted", "epistasis", "dms", "phenotype", "analyze", "temporal", "dating"]);

/**
 * `hyphaeon dating`'s own ceiling on the model-based estimators: dating.py:2745-2747 gives up on
 * the transformer above this and silently falls back to OLS, and the runtime
 * (runtime/src/dating/modelFits.js DATING_NEURAL_MAX_TAXA) refuses instead, because the fallback
 * and the thing that was asked for are different answers under one name. Quoted here so `caps`
 * can publish it beside MAX_TAXA, which is a DIFFERENT number for a different reason (MAX_TAXA is
 * what this server will accept at all; this is what the estimator will run).
 */
export const DATING_MODEL_MAX_TAXA = 1500;

/**
 * A temporal record is NEVER answered inside the tool call. MEASURED (H5N1_HA_geo, 98 taxa x 566
 * codons, general.onnx at 4 threads, B = 1000 at the reference's own --time-points 250): the run is
 * 4,065 ms and the JSON-safe record is 2,149,694 bytes, 8.2x ANALYZE_INLINE_MAX_BYTES, of which
 * `curves` alone is 1,988,099 (92.5%). The engine's own H1N1 acceptance run is 7.18 MB, 27x. `top`
 * cannot help: the site columns are typed arrays, not arrays of records. So the tool always creates
 * a job, waits for it, and answers with the SUMMARY plus the job id; `get_results section=` pages
 * the record (src/time.js TEMPORAL_SECTIONS).
 */
export const TEMPORAL_ALWAYS_JOB = true;

/**
 * The pillars, ALL of which run IN THIS PROCESS (runtime/ over onnxruntime-node;
 * provenance.surface "mcp-stdio" / "mcp-http"). Phase 1b moved meme, busted and evaluate off the
 * Python reference, Phase 2a's library port moved epistasis and dms, and Phase 3 moved the last
 * one, phenotype (js/src/phenotype.js at veg/HyphAeon phase-3a), so no Python runs anywhere in the
 * product (PLAN.md 8, phase 3's exit criterion; D16). `analyze` is the app's own tool
 * (hyphaeon_analyze: the whole report). Defined in this leaf so src/validate.js, src/engine.js and
 * src/tools.js share one list without importing each other.
 */
export const NATIVE_ANALYSES = Object.freeze([
  "meme",
  "busted",
  "epistasis",
  "dms",
  "phenotype",
  "evaluate",
  "analyze",
  // Phase 6, the last phase: the two time pillars and the date layer that makes them safe
  // (runtime/src/dates/, runtime/src/dating/, runtime/src/temporal/; PLAN-TEMPORAL D31/D34).
  // `dates` runs no model at all and is in this list because it is a tool a client calls and a
  // name `hyphaeon_validate` sizes; `list_models` reports its own no-model status.
  "dates",
  "dating",
  "temporal"
]);

/**
 * Work term for an analysis: sites x taxa^2, times 19 for the digital DMS sweep.
 *
 * @param {string} analysis  one of MODEL_ANALYSES
 * @param {number} codons    codon sites of the LONGEST sequence
 * @param {number} taxa      sequences in the file as submitted
 * @returns {number}
 */
export function workFor(analysis, codons, taxa, options = {}) {
  const base = codons * taxa * taxa;
  if (analysis === "dms") return base * DMS_MUTANTS_PER_SITE;
  // The date layer reads sequence NAMES: no codon is parsed and no matrix is built, so the work
  // term that describes a forward pass describes nothing here. Its real cost is O(taxa) string
  // work — measured at 3-24 ms on the four bundled examples — and its real cap is
  // MAX_ALIGNMENT_CHARS, which the schema enforces before the string is touched.
  if (analysis === "dates") return 0;
  // Dating's default path is a root-to-tip regression over pairwise TN93 distances: O(N x L)
  // character work plus an N x N distance matrix, NOT a per-site forward pass (measured: 85 ms on
  // korber's 143 x 981, against 2.0e7 "units" if L x N^2 were applied to it). `use_model` adds one
  // forward pass over every codon through the taxa graph, which IS L x N^2.
  if (analysis === "dating") return options.useModel === true ? base : codons * taxa;
  return base;
}

/**
 * Probe the size of a parsed alignment the way axomeme_scan does: the codon count is the
 * LONGEST sequence, not the first, because the reference sequence the CLI sizes the run off
 * is not necessarily the first one and the longest bounds every choice.
 *
 * @param {Array<{name: string, seq: string}>} sequences
 * @returns {{sequenceCount: number, longestSequenceChars: number, codons: number}}
 */
export function probeSequences(sequences) {
  let longest = 0;
  for (const s of sequences) {
    if (s.seq.length > longest) longest = s.seq.length;
  }
  return {
    sequenceCount: sequences.length,
    longestSequenceChars: longest,
    codons: Math.floor(longest / 3)
  };
}

/**
 * Decide whether a run is refused outright, answered in the call, or handed to a job.
 *
 * @param {string} analysis
 * @param {{codons: number, taxa: number}} size
 * @returns {{ok: boolean, mode?: "sync"|"job", work: number, reason?: string, hint?: string}}
 */
export function classifyRun(analysis, { codons, taxa }, options = {}) {
  const work = workFor(analysis, codons, taxa, options);
  const codonCap = MAX_CODONS[analysis];

  if (taxa < MIN_TAXA) {
    return {
      ok: false,
      work,
      reason:
        "The alignment has " + taxa + " sequence(s); HyphAeon needs at least " + MIN_TAXA +
        ". A two-taxon alignment produces a degenerate distance matrix (veg/HyphAeon#7).",
      hint: "Add more sequences to the alignment."
    };
  }
  if (taxa > MAX_TAXA) {
    return {
      ok: false,
      work,
      reason:
        "The alignment has " + taxa + " sequences; the cap is " + MAX_TAXA +
        " as submitted (the model itself is capped at " + TAXON_CAP + " after PD subsampling).",
      hint: "Reduce the alignment to at most " + MAX_TAXA + " sequences before submitting."
    };
  }
  // The model-based dating estimators have their OWN ceiling and refuse rather than downsample
  // into it. It is checked after MAX_TAXA because MAX_TAXA is what this server accepts at all,
  // and it is deliberately UNREACHABLE at today's numbers: DATING_MODEL_MAX_TAXA is 1,500 and
  // MAX_TAXA is 1,000, so no submission this server admits can reach the pillar's own ceiling.
  // The branch stays because the two numbers answer different questions and either may move, and
  // because the runtime refuses on it independently (DATING_MODEL_TOO_MANY_TAXA): a deployment
  // that raised MAX_TAXA without this would get the refusal from inside the run instead of before
  // it, which is the same answer minutes later.
  if (analysis === "dating" && options.useModel === true && taxa > DATING_MODEL_MAX_TAXA) {
    return {
      ok: false,
      work,
      reason:
        "The alignment has " + taxa + " sequences; the model-based dating estimators are refused above " +
        DATING_MODEL_MAX_TAXA + " (dating.py:2745-2747 silently falls back to OLS at that size; this build will not, " +
        "because the fallback and the thing you asked for are different answers under one name).",
      hint: "Re-run with use_model: false to get the model-free estimate deliberately, or submit fewer sequences."
    };
  }
  if (codons < 1) {
    return {
      ok: false,
      work,
      reason: "The longest sequence is shorter than one codon.",
      hint: "Submit an in-frame codon alignment."
    };
  }
  if (codonCap !== undefined && codons > codonCap) {
    return {
      ok: false,
      work,
      reason:
        "This alignment has " + codons + " codon sites; hyphaeon_" + analysis +
        " is capped at " + codonCap + " sites.",
      hint: "Split the alignment or trim it to at most " + codonCap + " codon sites."
    };
  }
  if (work > MAX_WORK) {
    return {
      ok: false,
      work,
      reason:
        "This run is too large: " + codons + " codon sites x " + taxa + " sequences" +
        (analysis === "dms" ? " x " + DMS_MUTANTS_PER_SITE + " mutants" : "") +
        " = " + work.toExponential(2) + " units of work, above the cap of " +
        MAX_WORK.toExponential(1) + " (sites x sequences^2" +
        (analysis === "dms" ? " x 19" : "") + ").",
      hint:
        "Submit fewer sequences or fewer sites. max_species does not help here: the cap is " +
        "measured on the file as submitted, before any taxon subsampling."
    };
  }
  if (codons > MAX_SYNC_CODONS || work > MAX_SYNC_WORK) {
    return {
      ok: true,
      mode: "job",
      work,
      reason:
        "Above the synchronous caps (" + MAX_SYNC_CODONS + " codon sites, work " +
        MAX_SYNC_WORK.toExponential(1) + "); queued as a job."
    };
  }
  return { ok: true, mode: "sync", work };
}

/**
 * A rough wallclock estimate for the Python reference path on a laptop CPU, from the
 * measurements in PLAN.md 1. Advisory only; it is shown in hyphaeon_validate so a caller can see
 * whether a run is seconds or minutes before starting it.
 *
 * Model: 1.5 s start-up + 2e-4 s per site + 2.1e-7 s per unit of work. The second coefficient is
 * fitted to HIV1_RT (476 x 335 in 17.3 s); the per-site term keeps small-N genes (Smc6, 20 x
 * 1,097 in 3.5 s) in the right order of magnitude rather than exactly right.
 *
 * @param {string} analysis
 * @param {number} codons
 * @param {number} taxa
 * @returns {number} seconds
 */
export function estimateSeconds(analysis, codons, taxa) {
  const work = workFor(analysis, codons, taxa);
  // attribution + forward for epistasis, roughly; the report runs meme, busted, epistasis, the
  // attribution loop and two filter passes before its (budget-capped) DMS.
  // MEASURED on this machine at 4 threads: the date layer is 3-24 ms on the bundled examples
  // (H5N1 6 ms, korber 3 ms, H1N1 9 ms, H5N1 + a metadata CSV 24 ms), which rounds to zero against
  // a 1.5 s model start-up this analysis never pays.
  if (analysis === "dates") return 0.05;
  // MEASURED: korber's model-free clock is 85 ms end to end (143 sequences x 981 codons), so the
  // model-free path is the parse plus arithmetic and nothing else. With `use_model` the taxa-graph
  // pass dominates (9.4 s on the same file upstream, 88% of the wall clock) and the work term is
  // the ordinary per-site one, so the ordinary coefficient applies.
  if (analysis === "dating") return work === codons * taxa ? 0.2 : 1.5 + 2e-4 * codons + 2.1e-7 * work;
  // MEASURED: H5N1_HA_geo (98 x 566) is 4,065 ms for the whole pillar with the full 1,000-draw
  // null inside budget, against a 4.4e6 work term — so the forward pass is not the whole story and
  // the null adds a term the caps vocabulary has no name for (its own budget lives in
  // runtime/src/temporal/null.js). This stays an ADVISORY order of magnitude, as the docstring says.
  if (analysis === "temporal") return 1.5 + 2 * (2e-4 * codons + 2.1e-7 * work);
  const passes = analysis === "epistasis" ? 2 : analysis === "analyze" ? 4 : 1;
  return 1.5 + passes * (2e-4 * codons + 2.1e-7 * work);
}
