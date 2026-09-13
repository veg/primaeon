/**
 * dates.test.js — hyphaeon_dates, the tool that runs no model.
 *
 * WHY THIS FILE EXISTS
 *
 * `hyphaeon_dates` is the pre-flight the other two time tools depend on, and everything it is for
 * is a property the other tests cannot check: that it costs no model byte, that it never hides an
 * undated sequence, that it reports the RULE each date came from, and that it reports the two
 * confirmation gates rather than applying them. Those are the four things this file pins.
 *
 * IT IS FAST ON PURPOSE and needs no HYPHAEON_SKIP_SLOW_TESTS guard: measured in this session,
 * the date layer is 3-24 ms on the four bundled examples and the whole describe block below runs
 * in well under a second of work, because nothing here loads a graph. That is the property, not a
 * happy accident — a regression that made this tool touch the engine would show up as a suite that
 * suddenly needs models on disk.
 *
 * The examples come from the sibling HyphAeon checkout, as every other test in this suite does:
 *   korber_env_gp160.fasta  143 sequences, 142 dated by the `korber_isolate` rule and ONE not
 *                           (`CONSENSUS`) — the undated-sequence case, the imputation case, and the
 *                           archival-1959 offer, all in one file.
 *   H5N1_HA_geo.fasta       98 sequences, all dated from their headers; with H5N1_HA_metadata.csv
 *                           the same 98 dated from a TABLE, which is the delimiter-sniffing and
 *                           column-discovery path.
 *   H1N1_2009_pandemic.fasta  100 sequences, 95 dated — and the file the bare-number gate exists
 *                           for: forced to `generations` it dates 100 of 100 on an axis running
 *                           from 1 to 46,241,654, which is the measurement in src/time.js's header.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, parseText, example } from "./helpers.js";
import { DATE_DIAGNOSTIC_CODES } from "@veg/hyphaeon-runtime/dates";
import { DATING_REFUSALS } from "@veg/hyphaeon-runtime/dating";
import { TEMPORAL_REFUSALS } from "@veg/hyphaeon-runtime/temporal";
import { TIME_REFUSAL_HINTS, DATES_BARE_NUMBER_MAJORITY, DATES_UNDATED_PRESENT } from "../src/time.js";
import { timeRefusal, classifyEngineError } from "../src/engine.js";
import { CODES } from "../src/validate.js";

/**
 * The `severity: "refuse"` codes of `runtime/src/dates/codes.js`. The runtime publishes the whole
 * ordered list, not the refusing subset, so this is written out — and checked against that list
 * below, so a code added upstream cannot silently miss the mapping.
 */
const DATE_REFUSAL_CODES = [
  "DATES_SOURCE_UNREADABLE",
  "DATES_SOURCE_KIND_UNKNOWN",
  "DATES_BEAST_XML_UNSUPPORTED",
  "DATES_TABLE_NO_DATE_COLUMN",
  "DATES_AUSPICE_NO_TIPS",
  "DATE_REGEX_INVALID",
  "DATE_REGEX_NO_GROUP",
  "DATES_TABLE_NO_MATCH",
  "DATES_NONE",
  "DATES_TOO_FEW",
  "DATES_NO_SPAN"
];

describe("hyphaeon_dates: which sequence got a date, and by what rule", () => {
  let ctx;
  beforeAll(async () => {
    // NO `threads` and NO models needed: this tool never reaches src/engine.js.
    ctx = await connect();
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  const call = async (args) => {
    const res = await ctx.client.callTool({ name: "hyphaeon_dates", arguments: args });
    return { body: parseText(res), isError: res.isError === true };
  };

  it("korber: reads 142 of 143 from the headers, names the rule, and reports the one it could not", async () => {
    const alignment = await example("korber_env_gp160.fasta");
    const { body, isError } = await call({ alignment });
    expect(isError).toBe(false);
    expect(body.analysis).toBe("dates");
    expect(body.ok).toBe(true);
    expect(body.engine).toMatch(/no model/);

    const c = body.date_review.coverage;
    expect(c.taxa_total).toBe(143);
    expect(c.dated).toBe(142);
    expect(c.undated).toBe(1);
    expect(body.date_review.source).toBe("header");
    // THE RULE COLUMN IS THE POINT. `korber_isolate` is one of the rules the reference's own header
    // parser does not have (D31), which is why a temporal run on this file cannot be reproduced by
    // the CLI without exporting the dates as a table.
    expect(body.date_review.by_rule.korber_isolate).toBe(142);
    expect(body.date_review.by_rule.unparsed).toBe(1);
    expect(body.date_review.time_units).toBe("years");
    expect(body.date_review.time_units_source).toBe("inferred");
    expect(body.date_review.span.min).toBeCloseTo(1959.5, 3);
    expect(body.date_review.span.max).toBeCloseTo(1997.5, 3);

    // A SEQUENCE IS NEVER OMITTED. The undated one is a row like any other, with a null value.
    expect(body.date_review.rows).toHaveLength(143);
    const undated = body.date_review.rows.filter((r) => r.value === null);
    expect(undated).toHaveLength(1);
    expect(undated[0].taxon).toBe("CONSENSUS");
    expect(body.date_review.unmatched_taxa.names).toContain("CONSENSUS");

    // Imputation is reported per row, not only counted.
    expect(c.imputed).toBeGreaterThan(0);
    const imputed = body.date_review.rows.find((r) => r.imputed);
    expect(imputed.imputations).toBeTruthy();

    const codes = body.date_review.warnings.map((w) => w.code);
    expect(codes).toContain("DATES_IMPUTED");
    expect(codes).toContain("DATES_UNITS_INFERRED");
    expect(codes).toContain("DATES_ARCHIVAL_1959_AVAILABLE");
  });

  it("reports the two gates the analyses refuse on, and refuses neither itself", async () => {
    const alignment = await example("korber_env_gp160.fasta");
    const { body, isError } = await call({ alignment });
    // The review tool ALWAYS answers: reporting an undated sequence is the thing it was asked to do.
    expect(isError).toBe(false);
    expect(body.gate.ok).toBe(false);
    expect(body.gate.blocking.map((b) => b.code)).toEqual(["DATES_UNDATED_PRESENT"]);
    expect(body.gate.blocking[0].hint).toMatch(/drop_undated/);
    expect(body.gate.overrides).toEqual({ accept_bare_numbers: false, drop_undated: false });
    expect(body.next).toMatch(/refuse this date set/);

    // With the override it clears, and the override is recorded rather than merely obeyed.
    const cleared = await call({ alignment, drop_undated: true });
    expect(cleared.body.gate.ok).toBe(true);
    expect(cleared.body.gate.applied).toEqual(["DATES_UNDATED_PRESENT"]);
    expect(cleared.body.next).toMatch(/hyphaeon_dating/);
  });

  it("H1N1 under a forced non-calendar unit: 100 of 100 dated, and the bare-number gate fires", async () => {
    const alignment = await example("H1N1_2009_pandemic.fasta");

    // Inferred units: 95 of 100, by the decimal-year rule, over a real epidemic.
    const inferred = await call({ alignment });
    expect(inferred.body.date_review.coverage.dated).toBe(95);
    expect(inferred.body.date_review.by_rule.header_decimal_year).toBe(95);
    expect(inferred.body.date_review.time_units).toBe("years");
    expect(inferred.body.date_review.span.min).toBeGreaterThan(2009);
    expect(inferred.body.date_review.span.max).toBeLessThan(2010);
    // Nothing bare was read, so only the undated gate is up.
    expect(inferred.body.gate.blocking.map((b) => b.code)).toEqual(["DATES_UNDATED_PRESENT"]);

    // Forced to generations, EVERYTHING dates and every number is nonsense. This is the measurement
    // src/time.js's decision 1 is built on, and the reason passing `time_units` explicitly is the
    // dangerous option rather than the careful one: it bypasses the calendar-majority probe.
    const forced = await call({ alignment, time_units: "generations" });
    expect(forced.body.date_review.coverage.dated).toBe(100);
    expect(forced.body.date_review.coverage.undated).toBe(0);
    expect(forced.body.date_review.by_rule.header_bare_number).toBe(75);
    expect(forced.body.date_review.time_units_source).toBe("supplied");
    expect(forced.body.date_review.span.min).toBe(1);
    expect(forced.body.date_review.span.max).toBe(46241654);

    const gate = forced.body.gate;
    expect(gate.ok).toBe(false);
    expect(gate.blocking.map((b) => b.code)).toEqual(["DATES_BARE_NUMBER_MAJORITY"]);
    expect(gate.blocking[0].message).toMatch(/46241654/);
    expect(gate.blocking[0].hint).toMatch(/accept_bare_numbers/);
    // Still not an error: the tool's job is to show this, so a client can see it before running.
    expect(forced.isError).toBe(false);

    const accepted = await call({ alignment, time_units: "generations", accept_bare_numbers: true });
    expect(accepted.body.gate.ok).toBe(true);
    expect(accepted.body.gate.applied).toEqual(["DATES_BARE_NUMBER_MAJORITY"]);
  });

  it("H5N1: the same 98 dates from the headers and from a metadata TABLE, with the table's own evidence", async () => {
    const alignment = await example("H5N1_HA_geo.fasta");
    const metadata = await example("H5N1_HA_metadata.csv");

    const headers = await call({ alignment });
    expect(headers.body.date_review.coverage.dated).toBe(98);
    expect(headers.body.date_review.source).toBe("header");
    expect(headers.body.date_review.by_rule.header_trailing_year).toBe(98);
    expect(headers.body.gate.ok).toBe(true);
    expect(headers.body.clock).toMatchObject({ has_clock: true, dating_possible: true, temporal_possible: true });

    const table = await call({ alignment, dates_file: metadata, dates_file_name: "H5N1_HA_metadata.csv" });
    expect(table.body.date_review.coverage.dated).toBe(98);
    expect(table.body.date_review.source).toBe("table");
    expect(table.body.date_review.coverage.from_table).toBe(98);
    expect(table.body.date_review.source_kind).toBe("table");
    // The table read is reported, not just used: which column, how the delimiter was chosen, and
    // how many rows named no sequence. That last one is the line that catches a wrong-file paste.
    expect(table.body.date_review.table.date_col).toBeTruthy();
    expect(table.body.date_review.table.strain_col).toBeTruthy();
    expect(table.body.date_review.table.delimiter).toBe(",");
    expect(table.body.date_review.table.delimiter_source).toBe("sniffed");
    expect(table.body.date_review.unmatched_metadata.count).toBe(0);
    expect(table.body.date_review.warnings.map((w) => w.code)).toContain("DATES_DELIMITER_GUESSED");
    // Both spellings of the same dates agree on the axis.
    expect(table.body.date_review.span.min).toBeCloseTo(headers.body.date_review.span.min, 6);
    expect(table.body.date_review.span.max).toBeCloseTo(headers.body.date_review.span.max, 6);
  });

  it("refuses an unreadable metadata source and a BEAST XML, as input errors with the date layer's own codes", async () => {
    const alignment = await example("H5N1_HA_geo.fasta");

    // A JSON ARRAY is none of the three shapes this layer reads (an Auspice build, a name-to-date
    // object, or a delimited table), so the sniff is definite about it. Note that free text IS read
    // as a one-column table and merely warns — the layer's own behaviour, and why this case uses a
    // shape it can refuse rather than one it can guess at.
    const junk = await call({ alignment, dates_file: "[1, 2, 3]", dates_file_name: "junk.json" });
    expect(junk.isError).toBe(true);
    expect(junk.body.ok).toBe(false);
    const junkCodes = junk.body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code);
    expect(junkCodes).toContain("DATES_SOURCE_KIND_UNKNOWN");

    // An Auspice JSON whose tips carry no name: it parsed, and it says nothing.
    const nameless = await call({ alignment, dates_file: JSON.stringify({ version: "v2", meta: {}, tree: { name: null, children: [] } }), dates_file_name: "tree.json" });
    expect(nameless.isError).toBe(true);
    expect(nameless.body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code)).toContain("DATES_AUSPICE_NO_TIPS");

    // The reference reads a BEAST XML (dating.py:433-434) and this build does not, so it is a
    // REFUSAL naming that fact rather than a silent header fallback.
    const beast = await call({ alignment, dates_file: '<?xml version="1.0"?><beast><taxa/></beast>', dates_file_name: "run.xml" });
    expect(beast.isError).toBe(true);
    const beastCodes = beast.body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code);
    expect(beastCodes).toContain("DATES_BEAST_XML_UNSUPPORTED");
  });

  it("a metadata table that names no sequence is reported, not silently replaced by the headers", async () => {
    // THE WRONG-ANSWER CASE. `header_fallback` is on by default (the reference's own behaviour), so
    // a table that matched nothing still produces a dated run — from DIFFERENT dates than the caller
    // supplied. The run must say so, in the warnings and in the counts, or it is a wrong-answer
    // machine with a green light on it.
    const alignment = await example("H5N1_HA_geo.fasta");
    const table = "strain,date\nnot_in_this_alignment_1,2001-01-01\nnot_in_this_alignment_2,2002-02-02\n";

    const rescued = await call({ alignment, dates_file: table, dates_file_name: "wrong.csv" });
    expect(rescued.body.date_review.coverage.from_table).toBe(0);
    expect(rescued.body.date_review.coverage.from_header).toBe(98);
    expect(rescued.body.date_review.source).toBe("header");
    expect(rescued.body.date_review.unmatched_metadata.count).toBe(2);
    const codes = rescued.body.date_review.warnings.map((w) => w.code);
    expect(codes).toContain("DATES_TABLE_NO_MATCH");
    expect(codes).toContain("DATES_HEADER_FALLBACK");
    // DATES_TABLE_NO_MATCH is the one CONDITIONAL severity in the table: a warning when the header
    // fallback rescued the run, a refusal when it did not.
    expect(rescued.body.date_review.warnings.find((w) => w.code === "DATES_TABLE_NO_MATCH").severity).toBe("warn");
    expect(rescued.isError).toBe(false);

    // With the fallback off it is the refusal it would otherwise have been.
    const refused = await call({ alignment, dates_file: table, dates_file_name: "wrong.csv", header_fallback: false });
    expect(refused.isError).toBe(true);
    expect(refused.body.date_review.warnings.find((w) => w.code === "DATES_TABLE_NO_MATCH").severity).toBe("refuse");
    expect(refused.body.date_review.coverage.dated).toBe(0);
  });

  it("refuses a pattern with no capturing group, and one that will not compile", async () => {
    const alignment = await example("H5N1_HA_geo.fasta");

    const noGroup = await call({ alignment, date_pattern: "\\d{4}" });
    const noGroupCodes = noGroup.body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code);
    expect(noGroupCodes).toContain("DATE_REGEX_NO_GROUP");
    expect(noGroup.isError).toBe(true);

    const bad = await call({ alignment, date_pattern: "(unclosed" });
    const badCodes = bad.body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code);
    expect(badCodes).toContain("DATE_REGEX_INVALID");
    expect(bad.isError).toBe(true);
  });

  it("says when nothing can be dated at all, rather than answering about an empty set", async () => {
    // Three sequences whose names carry nothing a date parser can read.
    const alignment = ">alpha\nATGAAACCCGGG\n>beta\nATGAAACCCGGT\n>gamma\nATGAAACCCGGA\n";
    const { body, isError } = await call({ alignment });
    expect(isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.date_review.coverage.dated).toBe(0);
    const codes = body.date_review.warnings.filter((w) => w.severity === "refuse").map((w) => w.code);
    expect(codes).toContain("DATES_NONE");
    expect(body.clock.has_clock).toBe(false);
    expect(body.clock.temporal_possible).toBe(false);
    expect(body.next).toMatch(/Fix the refusal/);
  });

  it("`rows: false` drops the table and keeps every count, and `top` keeps the problems first", async () => {
    const alignment = await example("korber_env_gp160.fasta");

    const noRows = await call({ alignment, rows: false });
    expect(noRows.body.date_review.rows).toBeUndefined();
    expect(noRows.body.date_review.coverage.taxa_total).toBe(143);
    expect(noRows.body.date_review.by_rule.korber_isolate).toBe(142);

    const capped = await call({ alignment, top: 5 });
    expect(capped.body.date_review.rows).toHaveLength(5);
    expect(capped.body.date_review.rows_total).toBe(143);
    expect(capped.body.date_review.rows_note).toMatch(/counts the block above counts all 143|counts all 143/);
    // THE UNDATED SEQUENCE SURVIVES THE CAP. A truncation that dropped it would be the exact
    // silence this tool exists to break.
    expect(capped.body.date_review.rows.some((r) => r.taxon === "CONSENSUS")).toBe(true);
    expect(capped.body.date_review.coverage.dated).toBe(142);
  });

  it("publishes the match ladder, and substring matching is not on it", async () => {
    const { body } = await call({ alignment: await example("H5N1_HA_geo.fasta") });
    expect(body.match_tiers_available).toEqual([
      "exact",
      "quote_stripped",
      "whitespace_collapsed",
      "case_insensitive",
      "first_token",
      "sanitized",
      "field_containment"
    ]);
    // `EPI_ISL_4021` must never match `EPI_ISL_402124`: the failure mode of a fuzzy match here is a
    // plausible WRONG date, so no strength of substring matching is offered at all.
    expect(body.match_tiers_available).not.toContain("substring");
  });
});

/**
 * THE PHASE 3 MISTAKE, AS A TEST.
 *
 * The runtime's TN93 refusal fell through to the SERVER class in Phase 3 and Phase 4 had to fix it
 * with TN93_UNCOMPUTABLE, because `classifyEngineError`'s default arm tells a caller "nothing about
 * the submitted data will change this; report it to the operator". Phase 6 adds twenty-three more
 * refusals of exactly that shape — every one a property of the caller's metadata or alignment — so
 * this block checks the whole table at once rather than trusting twenty-three separate `it`s to be
 * written.
 */
describe("the three code tables: every refusal is an input fault with its own code and its own hint", () => {
  const ALL = [
    ...DATE_REFUSAL_CODES,
    DATES_BARE_NUMBER_MAJORITY,
    DATES_UNDATED_PRESENT,
    ...Object.values(DATING_REFUSALS),
    ...Object.values(TEMPORAL_REFUSALS)
  ];

  it("the date refusal list is a subset of the runtime's own ordered table", () => {
    for (const code of DATE_REFUSAL_CODES) expect(DATE_DIAGNOSTIC_CODES, code).toContain(code);
  });

  it("every one of them maps to kind `input`, carries its code, and gets a hint about the METADATA", () => {
    expect(ALL.length).toBe(23);
    for (const code of ALL) {
      expect(TIME_REFUSAL_HINTS, code).toHaveProperty(code);
      const err = timeRefusal({ code, message: "the runtime's own sentence", data: {} });
      expect(err.kind, code).toBe("input");
      expect(err.code, code).toBe(code);
      expect(err.message, code).toBe("the runtime's own sentence");
      // NOT the generic hints. "Check that the alignment is an in-frame codon alignment" is useless
      // advice to someone whose CSV has the wrong column name, and "report it to the operator" is
      // the Phase 3 mistake itself.
      expect(err.hint, code).toBeTruthy();
      expect(err.hint, code).not.toMatch(/report it to the operator/);
      expect(err.hint, code).not.toMatch(/in-frame codon alignment \(FASTA, NEXUS or PHYLIP\)/);
    }
  });

  it("a refusal code inside a THROWN message is still an input fault, and an unrelated failure is not", () => {
    const thrown = classifyEngineError(new Error("runTemporal refused: " + TEMPORAL_REFUSALS.NO_TIME_SPAN + " on this alignment"));
    expect(thrown.kind).toBe("input");
    expect(thrown.code).toBe(TEMPORAL_REFUSALS.NO_TIME_SPAN);

    const engine = classifyEngineError(new Error("ENOENT: the onnxruntime-node binding is missing"));
    expect(engine.kind).toBe("server");
    expect(engine.hint).toMatch(/report it to the operator/);
  });

  it("every code the date layer can emit has a published description in hyphaeon://methods/requirements", () => {
    for (const code of DATE_DIAGNOSTIC_CODES) expect(CODES, code).toHaveProperty(code);
    expect(CODES).toHaveProperty(DATES_BARE_NUMBER_MAJORITY);
    expect(CODES).toHaveProperty(DATES_UNDATED_PRESENT);
    // The refusals are marked as such, so a client can tell a stop from a note without running one.
    for (const code of DATE_REFUSAL_CODES) expect(CODES[code], code).toMatch(/\[refuse/);
  });
});

/**
 * THE IMPORT BOUNDARY, ASSERTED RATHER THAN CLAIMED.
 *
 * "Reviewing dates costs no model byte" is only a fact while `src/time.js` reaches the runtime
 * through its `./dates` and `./dating` subpaths, neither of which imports `manifest.js`,
 * `predict.js`, a session or `tn93-wasm.js` (`runtime/test/dating-port.test.js` asserts that half).
 * A single `import { createSession } from "@veg/hyphaeon-runtime"` at the top of this module would
 * destroy the property silently — the tool would still answer, just after loading an ONNX stack it
 * never uses — so the source is scanned, the way the runtime scans its own.
 *
 * `./temporal` is deliberately NOT on the allow-list: that subtree DOES reach onnxruntime, which is
 * why the engine resolves it lazily through `loadRuntime()` and this module never names it.
 */
describe("hyphaeon_dates costs no model byte", () => {
  const TIME_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "time.js");

  it("src/time.js imports only the runtime subpaths that load no graph", () => {
    const source = readFileSync(TIME_JS, "utf8");
    const specifiers = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.sort()).toEqual(["@veg/hyphaeon-runtime/dates", "@veg/hyphaeon-runtime/dating"]);
    for (const forbidden of [
      "onnxruntime",
      "@veg/hyphaeon-runtime/node",
      "@veg/hyphaeon-runtime/web",
      "@veg/hyphaeon-runtime/temporal",
      "./engine.js",
      "createSession",
      "loadSession"
    ]) {
      expect(specifiers.join(" "), forbidden).not.toMatch(forbidden);
    }
    // And no bare runtime entry either: `@veg/hyphaeon-runtime` pulls the whole barrel.
    expect(specifiers).not.toContain("@veg/hyphaeon-runtime");
  });

  it("the tool answers on a checkout with no models directory", async () => {
    // `hyphaeon_dates` never calls loadRuntime() and never reaches engine.session(), so a models
    // directory that does not exist changes nothing about it. `engine.run` refuses the analysis by
    // name for the same reason, and says where it went instead.
    const ctx = await connect({ env: { ...process.env, HYPHAEON_MODELS_DIR: "/nonexistent-models-directory" } });
    try {
      const res = await ctx.client.callTool({
        name: "hyphaeon_dates",
        arguments: { alignment: await example("H5N1_HA_geo.fasta"), rows: false }
      });
      expect(res.isError).toBeFalsy();
      const body = parseText(res);
      expect(body.ok).toBe(true);
      expect(body.date_review.coverage.dated).toBe(98);
      expect(body.engine).toMatch(/no model, no graph/);
    } finally {
      await ctx.close();
    }
  }, 900000);
});
