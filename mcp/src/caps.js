/**
 * caps.js — size and work caps for every HyphAeon MCP analysis tool.
 *
 * WHY THIS FILE EXISTS
 *
 * The analysis tools answer INSIDE the tool call when the input is small enough, and hand back a
 * job id otherwise (PLAN.md 3.6). Something has to decide "small enough", and it has to be one
 * decision shared by every tool, measured on the file as submitted, before any subprocess starts.
 * In Phase 0 the work happens in a Python subprocess (src/bridge.js), so the caller's process is
 * not stalled the way datamonkey-js-server's axomeme_scan stalls its event loop; the caps exist for
 * a different reason here: a single MCP tool call has to come back in a time a human and a client
 * will wait for, and a laptop has to survive the run.
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
 *                        inside epistasis runs only on sector nodes, not every site.
 *   DMS_MUTANTS_PER_SITE 19. PLAN.md 1: dms is "19 substitutions x L sites" and "capped by work
 *                        19·L·N²", so the work term for dms is multiplied by 19.
 *   MIN_TAXA / MAX_TAXA  3 and 1,000. PLAN.md 3.5 and 4.3: "Taxa < 3 | refuse (#7)", "> 1,000
 *                        refuse". TAXON_CAP 512 is the model's hard ceiling (PLAN.md 3.3 manifest
 *                        taxon_cap), above which the CLI applies Faith's-PD subsampling.
 *   MAX_PERMUTATIONS     10,000; MAX_PERMULATIONS 2,000. PLAN.md 3.5. The CLI defaults to 10,000
 *                        permutations, so the cap is the default; permulations default to 0.
 *   JOB_TIMEOUT_MS       10 minutes. PLAN.md 3.5 "job timeout 10 min". The bridge kills the Python
 *                        process at this wallclock whether the run is sync or a job.
 *   JOB_TTL_MS           7 days, PLAN.md 3.5 "TTL 7 days". MAX_JOBS bounds the in-process map; a
 *                        job store that lives in one Node process cannot rely on TTL alone.
 *
 * Measured reference (PLAN.md 1, Apple M4 Pro, CPU, Python path): meme on 476 x 335 (HIV1_RT,
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
  dms: 3000
});

export const DMS_MUTANTS_PER_SITE = 19;

export const MAX_PERMUTATIONS = 10000;
export const MAX_PERMULATIONS = 2000;

export const JOB_TIMEOUT_MS = 10 * 60 * 1000;
export const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_JOBS = 200;

/** The analyses that run the network and therefore fall under the work caps. */
export const MODEL_ANALYSES = Object.freeze(["meme", "busted", "epistasis", "dms", "phenotype"]);

/**
 * Work term for an analysis: sites x taxa^2, times 19 for the digital DMS sweep.
 *
 * @param {string} analysis  one of MODEL_ANALYSES
 * @param {number} codons    codon sites of the LONGEST sequence
 * @param {number} taxa      sequences in the file as submitted
 * @returns {number}
 */
export function workFor(analysis, codons, taxa) {
  const base = codons * taxa * taxa;
  return analysis === "dms" ? base * DMS_MUTANTS_PER_SITE : base;
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
export function classifyRun(analysis, { codons, taxa }) {
  const work = workFor(analysis, codons, taxa);
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
  const passes = analysis === "epistasis" ? 2 : 1; // attribution + forward, roughly
  return 1.5 + passes * (2e-4 * codons + 2.1e-7 * work);
}
