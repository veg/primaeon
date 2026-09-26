/**
 * time.test.js — Phase 6's three analyses over the jobs API: `dates`, `dating` and `temporal`.
 *
 * WHY THIS FILE EXISTS
 *
 * The contract these three add is not the contract the other seven have, and every clause below is
 * one that would ship a plausible wrong answer if it were missing:
 *
 *  - A DATE LAYER IS A SECOND INPUT. `dates_file` is TEXT in the body under the same 8 MiB field
 *    cap as the alignment, written into the job directory as submitted, and threaded to the engine
 *    as an INPUT rather than an option (so no copy of a caller's Auspice build lands in
 *    `provenance.options`). It is also checked BEFORE a worker is spent on it.
 *  - EVERY DATE REFUSAL IS `kind: "input"` WITH ITS OWN CODE. Phase 3 classified exactly one
 *    refusal of this shape as a SERVER fault and Phase 4 had to fix it; the assertions below check
 *    the code AND that the hint does not tell a caller with a bad CSV to "report it to the
 *    operator", which is the sentence that mistake produces.
 *  - THE TWO CONFIRMATION GATES. The browser asks a human before it will run on dates read mostly
 *    as a bare number in the sequence name, or on a set with undated sequences that would be
 *    dropped silently. An HTTP job has nobody to ask, so it refuses with a named override — and
 *    `analysis: "dates"` never refuses for either, because reporting them is its job.
 *  - THE NULL REFINES AND THE STREAM SAYS SO. The `permutations` section is re-emitted per chunk
 *    with the achieved draw count, and the payload is a projection: the runtime's own interim is
 *    the WHOLE record (measured upstream at ~6.7 MiB, 17 of them at the reference's defaults) and
 *    forwarding it would put 114 MiB through the SSE stream to deliver a p-value table.
 *  - A STOPPED RUN STILL HAS AN ANSWER. `POST /jobs/:id/cancel` is not DELETE: the temporal pillar
 *    resolves with a record classified at the achieved count, and a client that stopped at draw N
 *    reads a result that says N and means it.
 *
 * The examples are the cheapest honest ones. H5N1_HA_geo (98 sequences x 566 codons, with a tree
 * and a metadata CSV) is the whole temporal pillar in ~3 s at T = 60, B = 200 and exercises the
 * metadata-table date path, duplicate collapse, tied dates, the near-degenerate wave flag and the
 * sign convention in one run; korber_env_gp160 is the dating example because it is the only shipped
 * set with imputation, a beyond-reference header rule, an explicit root taxon and exactly one
 * undated sequence — which is what makes it the gate's own test case.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { poolEngine } from "../src/mcp-mount.js";
import { TEMPORAL_RECORD_BYTES_MAX, TEMPORAL_SECTIONS, TEMPORAL_TIME_POINTS_MAX } from "../src/time.js";
import { optionVocabulary } from "../src/options.js";
import { temporalDownloadNotes } from "@veg/hyphaeon-runtime/temporal";
import { engineExample, engineExamplesDir, listen, readSse, silentLogger, testConfig } from "./helpers.js";

let handle;
let config;
let srv;

beforeAll(async () => {
  // The per-IP job limit is 20 a minute, and this file submits about forty in a few seconds from
  // one address — every refusal is its own POST, which is the point of testing them one at a time.
  // Raised here, and nowhere else, so the limit itself stays what a deployment ships.
  config = testConfig({ mcpEnabled: false, rateLimit: { windowMs: 60_000, api: 10_000, jobs: 10_000, mcp: 120, oauth: 60 } });
  handle = createApp(config, { logger: silentLogger });
  srv = await listen(handle.app);
});

afterAll(async () => {
  await srv.close();
  await handle.close();
  config.cleanup();
});

const ID_RE = /^[0-9a-f]{32}$/;
const HAVE_EXAMPLES = Boolean(engineExamplesDir());
/** The full-grid run and the model-based clock; skipped on a pull request (see CLAUDE.md, CI). */
const SLOW = process.env.HYPHAEON_SKIP_SLOW_TESTS === "1";

/** Four sequences that carry no date anywhere, for the refusals that are about the metadata. */
const UNDATABLE = ">alpha\nATGATGATGATG\n>beta\nATGATGATGCTG\n>gamma\nATGATGCTGATG\n>delta\nATGCTGATGATG\n>epsilon\nCTGATGATGATG\n";
/** Four sequences all sampled on the same day: dated, and with no time axis to regress against. */
const ONE_DAY = ">a_2001\nATGATGATGATG\n>b_2001\nATGATGATGCTG\n>c_2001\nATGATGCTGATG\n>d_2001\nATGCTGATGATG\n";

const post = (body) => request(handle.app).post("/api/v1/jobs").send(body);

async function settle(id, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(handle.app).get("/api/v1/jobs/" + id);
    if (["completed", "failed", "cancelled"].includes(res.body.status)) return res.body;
    if (Date.now() > deadline) throw new Error("job " + id + " did not settle: " + res.body.status);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Submit and wait; fails loudly with the job's own error rather than an assertion on undefined. */
async function run(body) {
  const res = await post(body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const view = await settle(res.body.id);
  return { id: res.body.id, view };
}

describe("analysis: dates — the review, with no model and no graph", () => {
  let id;

  it.skipIf(!HAVE_EXAMPLES)("reads korber's headers and says which rule dated each sequence", async () => {
    const ex = engineExample("korber_env_gp160");
    const out = await run({ analysis: "dates", alignment: ex.alignment, names: ex.names });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    id = out.id;

    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.analysis).toBe("dates");
    expect(body.ok).toBe(true);
    // MEASURED: 142 of 143 by `korber_isolate` (the one miss is the sequence named CONSENSUS),
    // span 1959.5-1997.5, units INFERRED rather than named.
    expect(body.date_review.coverage.dated).toBe(142);
    expect(body.date_review.coverage.taxa_total).toBe(143);
    expect(body.date_review.by_rule.korber_isolate).toBe(142);
    expect(body.date_review.time_units).toBe("years");
    expect(body.date_review.time_units_source).toBe("inferred");
    expect(body.date_review.span.min).toBeCloseTo(1959.5, 3);
    expect(body.date_review.span.max).toBeCloseTo(1997.5, 3);
    // A sequence is NEVER omitted from the per-taxon table: that is the question the layer answers.
    expect(body.date_review.rows).toHaveLength(143);
    expect(body.date_review.rows.filter((r) => r.value === null)).toHaveLength(1);
    expect(body.provenance.surface).toBe("node-server");
    expect(body.provenance.engine).toBe("in-process (no model, no graph)");
  });

  it.skipIf(!HAVE_EXAMPLES)("REPORTS the two gates rather than refusing for them", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result");
    const gate = res.body.gate;
    expect(gate.ok).toBe(false);
    expect(gate.blocking.map((b) => b.code)).toEqual(["DATES_UNDATED_PRESENT"]);
    expect(gate.blocking[0].hint).toMatch(/drop_undated/);
    // The clock is still possible — the gate is a confirmation, not a verdict on the data.
    expect(res.body.clock).toMatchObject({ has_clock: true, dating_possible: true, temporal_possible: true });
    expect(res.body.next).toMatch(/gate\.blocking/);
  });

  it.skipIf(!HAVE_EXAMPLES)("publishes no section states: there is no 'during' in a 200 ms analysis", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id);
    expect(res.body.sections).toBeUndefined();
  });

  it("refuses an undatable alignment as an INPUT fault, with the code and the review", async () => {
    const out = await run({ analysis: "dates", alignment: UNDATABLE });
    expect(out.view.status).toBe("failed");
    expect(out.view.error.kind).toBe("input");
    expect(out.view.error.code).toBe("DATES_NONE");
    expect(out.view.error.hint).toMatch(/dates_file|date_pattern/);
    // The Phase 3 mistake, which Phase 4 fixed for TN93 and this table extends to 23 more codes.
    expect(out.view.error.hint).not.toMatch(/report it to the operator/);
    // The review rides on the error so a caller can act on it without a second request.
    expect(out.view.error.details.date_review.coverage.dated).toBe(0);
    expect(out.view.error.details.date_review.headers).toBeTruthy();
  });
});

describe("the date layer is checked at the door, before a worker is spent", () => {
  const ex = () => engineExample("korber_env_gp160");

  /** @type {Array<[string, object, string]>} label, request, expected code */
  const CASES = [
    ["no metadata and no header dates", { analysis: "dating", alignment: UNDATABLE }, "DATES_NONE"],
    ["every sequence on one day", { analysis: "dating", alignment: ONE_DAY, options: { drop_undated: true } }, "DATES_NO_SPAN"],
    ["temporal, every sequence on one day", { analysis: "temporal", alignment: ONE_DAY, options: { drop_undated: true } }, "DATES_NO_SPAN"],
    // DATES_NONE and not TEMPORAL_NO_DATES: the date layer refuses FIRST, before the pillar is
    // reached, and its code is the more specific one — it is about the metadata, which is what the
    // caller has to change. TEMPORAL_NO_DATES stays reachable inside the run, where the taxon cap,
    // the duplicate collapse and the tree pruning can leave a dated file with nothing dated.
    ["temporal with nothing dated", { analysis: "temporal", alignment: UNDATABLE }, "DATES_NONE"]
  ];

  for (const [label, body, code] of CASES) {
    it(label + " -> 422 " + code, async () => {
      const res = await post(body);
      expect(res.status).toBe(422);
      expect(res.body.error.kind).toBe("input");
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.hint).toBeTruthy();
      expect(res.body.error.hint).not.toMatch(/report it to the operator/);
      // The hint must name the METADATA fix, not the alignment fix: "check the reading frame" is
      // useless advice to someone whose CSV has the wrong column name.
      expect(res.body.error.hint).not.toMatch(/in-frame codon alignment \(FASTA/);
    });
  }

  // WHAT THIS USED TO ASSERT. Until Phase 6b this case was "refuses a BEAST XML by name rather
  // than reading half of it", and the code was DATES_BEAST_XML_UNSUPPORTED. The build reads one
  // now (runtime/src/dates/beast.js, a port of dataset.py:84-233), so the assertion is replaced
  // rather than removed: the same document — a <beast> with an empty <taxa> and nothing else — is
  // still refused at the door, with the narrower code that says WHICH way it failed, and the
  // describe block below is the other half, the file that is read.
  it.skipIf(!HAVE_EXAMPLES)("refuses an XML holding nothing a BEAST file holds, now by what it lacks", async () => {
    const res = await post({
      analysis: "dating",
      alignment: ex().alignment,
      dates_file: '<?xml version="1.0"?><beast><taxa/></beast>',
      names: { dates_file: "dates.xml" }
    });
    expect(res.status).toBe(422);
    expect(res.body.error.kind).toBe("input");
    expect(res.body.error.code).toBe("DATES_BEAST_NOT_BEAST");
    expect(res.body.error.hint).toMatch(/two-column CSV|CSV\/TSV/);
    // The retired code must not reappear anywhere in the answer.
    expect(JSON.stringify(res.body)).not.toMatch(/DATES_BEAST_XML_UNSUPPORTED/);
  });

  it.skipIf(!HAVE_EXAMPLES)("refuses a metadata document that is neither Auspice, a map nor a table", async () => {
    const res = await post({ analysis: "dating", alignment: ex().alignment, dates_file: "[1,2,3]", names: { dates_file: "x.json" } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DATES_SOURCE_KIND_UNKNOWN");
  });

  it.skipIf(!HAVE_EXAMPLES)("refuses a caller's own regular expression before running it", async () => {
    const bad = await post({ analysis: "dating", alignment: ex().alignment, options: { date_pattern: "(" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("DATE_REGEX_INVALID");
    const nogroup = await post({ analysis: "dating", alignment: ex().alignment, options: { date_pattern: "\\d{4}" } });
    expect(nogroup.status).toBe(422);
    expect(nogroup.body.error.code).toBe("DATE_REGEX_NO_GROUP");
    expect(nogroup.body.error.hint).toMatch(/capturing group/);
  });

  it.skipIf(!HAVE_EXAMPLES)("GATE 1: undated sequences refuse until drop_undated says otherwise", async () => {
    const blocked = await post({ analysis: "dating", alignment: ex().alignment, options: { root_taxon: "CONSENSUS" } });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("DATES_UNDATED_PRESENT");
    expect(blocked.body.error.message).toMatch(/1 of 143/);
    expect(blocked.body.error.hint).toMatch(/drop_undated/);
    const allowed = await post({ analysis: "dating", alignment: ex().alignment, options: { root_taxon: "CONSENSUS", drop_undated: true } });
    expect(allowed.status).toBe(202);
    await settle(allowed.body.id);
  });

  it.skipIf(!HAVE_EXAMPLES)("GATE 2: a bare-number axis refuses until accept_bare_numbers says otherwise", async () => {
    const h1n1 = engineExample("H1N1_2009_pandemic");
    // MEASURED: forcing `generations` on this set dates 100 of 100, 75 of them by the bare-number
    // rule, on an axis running 1 to 46,241,654 — every number nonsense, with no error anywhere.
    const blocked = await post({
      analysis: "temporal",
      alignment: h1n1.alignment,
      names: h1n1.names,
      options: { time_units: "generations", drop_undated: true }
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("DATES_BARE_NUMBER_MAJORITY");
    expect(blocked.body.error.hint).toMatch(/accept_bare_numbers/);
    expect(blocked.body.error.message).toMatch(/46,?241,?654|46241654/);
    // The override is accepted (and recorded); it is not asserted to RUN here because a 4,384-codon
    // temporal pass is not what this test is about — only that the gate is a gate and not a wall.
    const dates = await post({ analysis: "dates", alignment: h1n1.alignment, options: { time_units: "generations" } });
    expect(dates.status).toBe(202);
    const view = await settle(dates.body.id);
    expect(view.status).toBe("completed");
    const body = (await request(handle.app).get("/api/v1/jobs/" + dates.body.id + "/result")).body;
    // `dates` NEVER refuses for a gate: reporting it is the analysis.
    expect(body.ok).toBe(true);
    expect(body.gate.blocking.map((b) => b.code)).toContain("DATES_BARE_NUMBER_MAJORITY");
  });
});

// ── Phase 6b: a BEAST XML is a date source, and this door reads one ──────────────────────────
//
// `dates_file` used to refuse `.xml` on the NAME, unread (DATES_BEAST_XML_UNSUPPORTED). The
// runtime now ports `parse_beast_xml` (dataset.py:84-233), so the contract this surface owes is
// the one below, and each clause is one that would ship a plausible wrong answer if it were
// missing:
//
//  - THE DOOR AGREES WITH THE READER. A BEAST XML that dates the run is a 202, not a 422, and the
//    dates it produces are the dates the CSV of the same taxa produces — asserted as an
//    EQUIVALENCE against the bundled metadata table rather than against numbers typed out here,
//    because a typed number would pass while both paths were wrong together.
//  - EVERY REFUSAL IS STILL `kind: "input"` WITH A CODE AND A METADATA HINT. Four replace the one:
//    DATES_XML_UNPARSABLE, DATES_XML_UNSAFE, DATES_BEAST_NOT_BEAST, DATES_BEAST_NO_DATES. Phase 3
//    classified exactly one refusal of this shape as a SERVER fault and Phase 4 had to fix it, so
//    the kind and the hint are asserted, not just the code.
//  - THE READER HAS NO FILESYSTEM AND NO NETWORK. An external-entity document is refused, and the
//    answer carries none of what the entity pointed at. That is the same property e2e/server.spec.ts
//    asserts for subprocesses, applied to the one new parser in the tree.
//  - `POST /validate` IS A REHEARSAL. It answers what `POST /jobs` will answer, for the same XML.
describe("a BEAST XML is a date source (Phase 6b)", () => {
  const metadata = () => {
    const dir = engineExamplesDir();
    return dir ? readFileSync(path.join(dir, "H5N1_HA_metadata.csv"), "utf8") : null;
  };
  /** `[[taxon, date], ...]` from the bundled H5N1 metadata table — the reference the XMLs are built from. */
  const pairs = () =>
    metadata()
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(","))
      .map(([taxon, date]) => [taxon, date]);

  /** The BEAST 1.x shape: `<taxa>` of `<taxon id><date value>` (dataset.py:158-174). Dates only. */
  const beast1 = () =>
    '<?xml version="1.0" standalone="yes"?>\n<beast version="1.10.4">\n<taxa id="taxa">\n' +
    pairs()
      .map(([t, d]) => '<taxon id="' + t + '"><date value="' + d + '" direction="forwards" units="years"/></taxon>')
      .join("\n") +
    "\n</taxa>\n</beast>\n";

  /** The BEAST 2.x shape: one `<trait traitname="date" value="a=…,b=…">` (dataset.py:176-188). */
  const beast2 = () =>
    '<?xml version="1.0" encoding="UTF-8"?>\n<beast namespace="beast.evolution.alignment" version="2.6">\n' +
    '<trait id="dateTrait" spec="beast.evolution.tree.TraitSet" traitname="date" value="\n' +
    pairs()
      .map(([t, d]) => t + "=" + d)
      .join(",\n") +
    '"/>\n</beast>\n';

  it.skipIf(!HAVE_EXAMPLES)("BEAST 1 dates the same taxa, with the same values, as the metadata CSV", async () => {
    const ex = engineExample("H5N1_HA_geo", { dates: "H5N1_HA_metadata.csv" });
    const xml = beast1();
    const viaXml = await run({ analysis: "dates", alignment: ex.alignment, dates_file: xml, names: { alignment: ex.names.alignment, dates_file: "h5n1.xml" } });
    expect(viaXml.view.status, JSON.stringify(viaXml.view.error)).toBe("completed");
    const fromXml = (await request(handle.app).get("/api/v1/jobs/" + viaXml.id + "/result")).body;

    const viaCsv = await run({ analysis: "dates", alignment: ex.alignment, dates_file: ex.dates_file, names: ex.names });
    const fromCsv = (await request(handle.app).get("/api/v1/jobs/" + viaCsv.id + "/result")).body;

    // The XML is read as a BEAST document and says so; the CSV is still read as a table.
    expect(fromXml.date_review.source).toBe("beast");
    expect(fromXml.date_review.source_kind).toBe("beast");
    expect(fromCsv.date_review.source).toBe("table");

    // THE EQUIVALENCE. Same taxa dated, same values, same axis — the whole point of the port.
    expect(fromXml.date_review.coverage.dated).toBe(fromCsv.date_review.coverage.dated);
    expect(fromXml.date_review.coverage.taxa_total).toBe(fromCsv.date_review.coverage.taxa_total);
    expect(fromXml.date_review.coverage.from_beast).toBe(fromXml.date_review.coverage.dated);
    expect(fromXml.date_review.span).toEqual(fromCsv.date_review.span);
    const valueOf = (doc) => new Map(doc.date_review.rows.filter((r) => Number.isFinite(r.value)).map((r) => [r.taxon, r.value]));
    const xs = valueOf(fromXml);
    const cs = valueOf(fromCsv);
    expect(xs.size).toBe(cs.size);
    for (const [taxon, v] of cs) expect(xs.get(taxon)).toBeCloseTo(v, 9);

    // These dates are bare decimal years, so the reference's own parser returns them unchanged and
    // its calendar formula — which differs from the library's by up to 2.815 days — is not in play.
    expect(fromXml.date_review.by_rule.beast_float).toBe(fromXml.date_review.coverage.dated);
  });

  it.skipIf(!HAVE_EXAMPLES)("BEAST 2's date TraitSet reaches the same answer as BEAST 1's <date> elements", async () => {
    const ex = engineExample("H5N1_HA_geo", { dates: "H5N1_HA_metadata.csv" });
    const one = await run({ analysis: "dates", alignment: ex.alignment, dates_file: beast1(), names: { dates_file: "b1.xml" } });
    const two = await run({ analysis: "dates", alignment: ex.alignment, dates_file: beast2(), names: { dates_file: "b2.xml" } });
    const a = (await request(handle.app).get("/api/v1/jobs/" + one.id + "/result")).body;
    const b = (await request(handle.app).get("/api/v1/jobs/" + two.id + "/result")).body;
    expect(b.date_review.coverage.dated).toBe(a.date_review.coverage.dated);
    expect(b.date_review.span).toEqual(a.date_review.span);
  });

  it.skipIf(!HAVE_EXAMPLES)("a BEAST XML carries a dating job end to end, and the file lands as submitted", async () => {
    const ex = engineExample("H5N1_HA_geo");
    const xml = beast1();
    const out = await run({ analysis: "dating", alignment: ex.alignment, dates_file: xml, names: { alignment: ex.names.alignment, dates_file: "h5n1_beast.xml" } });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    // Written verbatim under the kind-neutral name: the server does not interpret the document
    // before the date layer sniffs it, and a BEAST XML did not change that (src/jobs.js).
    expect(out.view.inputs.files.dates_file).toBe("dates.txt");
    expect(readFileSync(path.join(config.jobsDir, out.id, "dates.txt"), "utf8")).toBe(xml);
    const doc = (await request(handle.app).get("/api/v1/jobs/" + out.id + "/result")).body;
    expect(doc.provenance.preprocessing.date_source).toBe("beast");
    expect(doc.provenance.reference_command.command).toMatch(/ -d h5n1_beast\.xml /);
  });

  /**
   * B1 AND B2 ON THIS SURFACE. A BEAST XML passed as `dates_file` IS the document `-d` names, so
   * the reproduction line must not answer "not every date on this run came from it" — it did, on
   * every BEAST-sourced run, because the source set it checked against was three hard-coded words
   * that `'beast'` never joined. And `match_tiers_available` must be the ladder that actually ran,
   * because a BEAST source runs the eight-tier one.
   */
  it.skipIf(!HAVE_EXAMPLES)("says the dates DID come from the file on the `-d` line, and publishes the ladder that ran", async () => {
    const ex = engineExample("H5N1_HA_geo");
    const out = await run({
      analysis: "dating",
      alignment: ex.alignment,
      dates_file: beast1(),
      names: { alignment: ex.names.alignment, dates_file: "h5n1_beast.xml" }
    });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    const doc = (await request(handle.app).get("/api/v1/jobs/" + out.id + "/result")).body;
    const ref = doc.provenance.reference_command;
    expect(ref.command).toMatch(/ -d h5n1_beast\.xml /);
    expect(ref.caveats.join(" ")).not.toMatch(/not every date on this run came from it/);
    expect(ref.caveats.join(" ")).not.toMatch(/were read from the sequence names by this build/);

    // The same document through `analysis: "dates"` publishes the BEAST ladder.
    const review = await run({ analysis: "dates", alignment: ex.alignment, dates_file: beast1(), names: { dates_file: "h5n1_beast.xml" } });
    const body = (await request(handle.app).get("/api/v1/jobs/" + review.id + "/result")).body;
    expect(body.date_review.source_kind).toBe("beast");
    expect(body.match_tiers_available).toContain("seq_prefix_stripped");
    for (const tier of Object.keys(body.date_review.match_tiers)) {
      expect(body.match_tiers_available, tier).toContain(tier);
    }
  });

  /**
   * The four narrower refusals that replaced DATES_BEAST_XML_UNSUPPORTED, each raised by a document
   * that reaches it for a different reason.
   *
   * `UNDATABLE` is the alignment for the no-dates case ON PURPOSE: with a header-datable alignment
   * the same XML is a WARNING rather than a refusal, because the headers rescued the run — the
   * DATES_TABLE_NO_MATCH precedent — and asserting a refusal there would pin the wrong behaviour.
   *
   * @type {Array<[string, string, string, string]>} label, dates_file, alignment, expected code
   */
  const XML_REFUSALS = [
    ["not well-formed", '<?xml version="1.0"?><beast><taxa><taxon id="a"></beast>', null, "DATES_XML_UNPARSABLE"],
    [
      // A BEAST tree annotation written with a bare `&` is not well-formed XML, and upstream raises
      // on the WHOLE document rather than on the tree (dataset.py:109-110).
      "a bare & in a newick annotation",
      '<?xml version="1.0"?><beast><newick>((a:1[&rate=0.1],b:2):0);</newick></beast>',
      null,
      "DATES_XML_UNPARSABLE"
    ],
    [
      // 600 deep, above the reader's own nesting cap; refused before the document is walked.
      "nested past the reader's cap",
      '<?xml version="1.0"?><beast>' + "<x>".repeat(600) + "</x>".repeat(600) + "</beast>",
      null,
      "DATES_XML_UNSAFE"
    ],
    ["well-formed XML that is not BEAST", '<?xml version="1.0"?><root><a/></root>', null, "DATES_BEAST_NOT_BEAST"],
    [
      // MEASURED against the reference: ElementTree names a namespaced element `{uri}data`, and
      // `parse_beast_xml` searches UNQUALIFIED tags, so upstream reads this file as empty and dates
      // nothing. This build refuses it and the hint says why, rather than showing an empty result.
      "a namespaced BEAST 2 document the reference reads as empty",
      '<beast xmlns="http://beast2.org" version="2.6"><data><sequence taxon="a" value="ATG"/></data></beast>',
      null,
      "DATES_BEAST_NOT_BEAST"
    ],
    [
      "a BEAST file with sequences but no sampling date",
      '<?xml version="1.0"?><beast version="1.10.4"><alignment id="aln"><sequence><taxon idref="alpha"/>ATGATGATGATG</sequence></alignment></beast>',
      UNDATABLE,
      "DATES_BEAST_NO_DATES"
    ]
  ];

  for (const [label, datesFile, alignment, code] of XML_REFUSALS) {
    it.skipIf(!HAVE_EXAMPLES)(label + " -> 422 " + code, async () => {
      const res = await post({
        analysis: "dating",
        alignment: alignment || engineExample("H5N1_HA_geo").alignment,
        dates_file: datesFile,
        names: { dates_file: "x.xml" }
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.kind).toBe("input");
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.hint).toBeTruthy();
      // Not a server fault, and not the alignment's hint: this is someone's metadata document.
      expect(res.body.error.hint).not.toMatch(/report it to the operator/);
      expect(res.body.error.hint).not.toMatch(/in-frame codon alignment \(FASTA/);
    });
  }

  it.skipIf(!HAVE_EXAMPLES)("refuses an external entity without reading what it points at", async () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE beast [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<beast><taxa><taxon id="&xxe;"><date value="2005.0"/></taxon></taxa></beast>';
    const res = await post({ analysis: "dating", alignment: engineExample("H5N1_HA_geo").alignment, dates_file: xxe, names: { dates_file: "xxe.xml" } });
    expect(res.status).toBe(422);
    expect(res.body.error.kind).toBe("input");
    expect(["DATES_XML_UNPARSABLE", "DATES_XML_UNSAFE"]).toContain(res.body.error.code);
    // Nothing that file holds may appear in the answer, in any field.
    const answer = JSON.stringify(res.body);
    expect(answer).not.toMatch(/root:/);
    expect(answer).not.toMatch(/\/bin\/(ba)?sh/);
  });

  it.skipIf(!HAVE_EXAMPLES)("POST /validate rehearses both answers for the same XML", async () => {
    const ex = engineExample("H5N1_HA_geo");
    const good = await request(handle.app).post("/api/v1/validate").send({ analysis: "dating", alignment: ex.alignment, dates_file: beast1() });
    expect(good.status).toBe(200);
    expect(good.body.dates.ok).toBe(true);
    expect(good.body.dates.date_review.source).toBe("beast");
    expect(good.body.warnings.some((w) => w.severity === "refuse")).toBe(false);

    const bad = await request(handle.app).post("/api/v1/validate").send({ analysis: "dating", alignment: ex.alignment, dates_file: '<?xml version="1.0"?><root><a/></root>' });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.dates.code).toBe("DATES_BEAST_NOT_BEAST");
    // The rehearsal and the job answer the same code, which is the whole point of validating.
    const job = await post({ analysis: "dating", alignment: ex.alignment, dates_file: '<?xml version="1.0"?><root><a/></root>' });
    expect(job.status).toBe(422);
    expect(job.body.error.code).toBe(bad.body.dates.code);
  });

  /**
   * THE HOLE THE FEATURE MAKES REACHABLE. A caller who now has a BEAST XML in hand has three
   * fields to try it in, and `alignment` is the tempting one. MEASURED before this refusal existed:
   * the library's `parseAlignmentSequences` read a BEAST XML built around H5N1_HA_geo's own
   * alignment as FOUR sequences named `<?xml`, `<taxon`, `<alignment` and `<sequence><taxon`,
   * 581 "codons" between them, and `sizeCheck` returned `{ok: true}` — a 202, a spent worker and a
   * failure inside the pillar on nonsense. `analysis: "dates"` is the case that matters most,
   * because it is the cheapest analysis and so the one a caller reaches for first.
   */
  const beast1ish =
    '<?xml version="1.0"?>\n<beast version="1.10.4">\n<taxa id="taxa">\n' +
    '<taxon id="a"><date value="2001.0"/></taxon>\n<taxon id="b"><date value="2002.0"/></taxon>\n' +
    '<taxon id="c"><date value="2003.0"/></taxon>\n<taxon id="d"><date value="2004.0"/></taxon>\n' +
    '</taxa>\n<alignment id="alignment" dataType="nucleotide">\n' +
    '<sequence><taxon idref="a"/>ATGGCCATG</sequence>\n<sequence><taxon idref="b"/>ATGGCAATG</sequence>\n' +
    '<sequence><taxon idref="c"/>ATGGTAATG</sequence>\n<sequence><taxon idref="d"/>TTGGTAATG</sequence>\n' +
    "</alignment>\n</beast>\n";

  for (const analysis of ["dates", "dating", "temporal", "analyze", "meme"]) {
    it("refuses an XML in the `alignment` field (" + analysis + ") rather than sizing its angle brackets", async () => {
      const res = await post({ analysis, alignment: beast1ish });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.kind).toBe("input");
      expect(res.body.error.code).toBe("ALIGNMENT_IS_XML");
      expect(res.body.error.hint).toMatch(/`dates_file`/);
      expect(res.body.error.hint).toMatch(/BEAST XML/);
    });
  }

  it("POST /validate refuses the same body, so the rehearsal is not kinder than the door", async () => {
    const res = await request(handle.app).post("/api/v1/validate").send({ analysis: "dating", alignment: beast1ish });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    // First, because it is the refusal that explains the others: the library is handed the empty
    // string rather than the XML, so it says FORMAT_UNKNOWN and reports a summary of nulls instead
    // of a nucleotide composition for a document that has none.
    expect(res.body.warnings[0].code).toBe("ALIGNMENT_IS_XML");
    expect(res.body.warnings.map((w) => w.code)).not.toContain("NON_ACGT_FRACTION");
    expect(res.body.summary.sequence_count).toBe(0);
  });

  it("but that same XML, in `dates_file`, is read", async () => {
    const alignment = ">a\nATGGCCATG\n>b\nATGGCAATG\n>c\nATGGTAATG\n>d\nTTGGTAATG\n";
    const out = await run({ analysis: "dates", alignment, dates_file: beast1ish, names: { dates_file: "small.xml" } });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    const doc = (await request(handle.app).get("/api/v1/jobs/" + out.id + "/result")).body;
    expect(doc.date_review.source).toBe("beast");
    expect(doc.date_review.coverage.dated).toBe(4);
    expect(doc.date_review.span).toMatchObject({ min: 2001, max: 2004 });
  });
});

describe("analysis: dating — the molecular clock", () => {
  let id;

  it.skipIf(!HAVE_EXAMPLES)("dates H5N1 from its headers and records the estimator it used", async () => {
    const ex = engineExample("H5N1_HA_geo");
    const out = await run({ analysis: "dating", alignment: ex.alignment, names: ex.names });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    id = out.id;
    const doc = (await request(handle.app).get("/api/v1/jobs/" + id + "/result")).body;
    expect(doc.analysis).toBe("dating");
    expect(doc.record.taxa_count).toBe(98);
    // MEASURED on this machine through this server: model-free, over pairwise TN93 distances.
    expect(doc.record.distance_mode).toBe("tn93");
    expect(doc.record.t_mrca).toBeCloseTo(1979.83, 1);
    expect(doc.record.mu).toBeCloseTo(6.811e-4, 6);
    expect(doc.taxa_summary).toHaveLength(98);
    expect(doc.provenance.surface).toBe("node-server");
    // D34: no tree, on any surface. The record says so rather than leaving it to be inferred.
    expect(doc.provenance.preprocessing.tree_source).toBe("tn93");
    expect(doc.provenance.preprocessing.branch_lengths_estimated).toBe(false);
    // THE SERVER NEEDS NO CODE OF ITS OWN FOR THIS, and that is what is being asserted: dating runs
    // through `@veg/hyphaeon-mcp/engine` (runner.js), so the engine's resolution of the compiled
    // TN93 is the server's too. `js` here would mean the distances came from the library's
    // JavaScript port while the record named veg/tn93's compiled code — the defect this field
    // exists to close, and the one that made every dating run on every surface use the port.
    expect(doc.record.primaeon.tn93_engine).toBe("wasm");
    expect(doc.provenance.preprocessing.tn93_engine).toBe("wasm");
  });

  it.skipIf(!HAVE_EXAMPLES)("carries the reproduction line as an OBJECT that refuses to over-promise", async () => {
    const doc = (await request(handle.app).get("/api/v1/jobs/" + id + "/result")).body;
    const ref = doc.provenance.reference_command;
    // Deliberately NOT the argv array the other six pillars stamp: a command string alone makes a
    // reproducibility promise this build explicitly declines to make.
    expect(ref).toBeTypeOf("object");
    expect(Array.isArray(ref)).toBe(false);
    // The three fields the contract requires. It was a CLOSED key set here until phase 6's review
    // moved this builder into `runtime/src/dating/results.js`, where it gained a fourth — `headline`,
    // naming which fit the surface quotes — so the assertion is now "at least these three, and the
    // fourth has the shape the contract gives it", not "exactly these three". Pinning a closed set
    // from the server suite pinned the runtime's return shape in the wrong repository.
    for (const k of ["caveats", "command", "reproduces"]) expect(Object.keys(ref)).toContain(k);
    expect(ref.command).toMatch(/^hyphaeon dating -a H5N1_HA_geo\.fasta --no-tree --distance-mode tn93 /);
    // The dates came from the headers, read by a parser wider than the reference's, so the run is
    // not reproducible from this line alone and the caveat says to export the dates as a table.
    expect(ref.reproduces).toBe(false);
    expect(ref.caveats.join(" ")).toMatch(/-d/);
    expect(doc.honesty.distance_mode).toBe("tn93");
    expect(doc.honesty.note).toMatch(/t_mrca` moves with `distance_mode/);

    // AND THE DATE THIS SURFACE MAY QUOTE. `record.t_mrca` is `active_model`'s and the `/time` page
    // does not always print it: `datingHeadline` refuses a fit whose `ci_mrca` is a point estimate
    // `[x, x]`, which every spline fit is upstream. Measured on korber at this review, the two
    // differ by 45 years. `honesty.headline` is the browser's own rule, on the wire.
    const head = doc.honesty.headline;
    expect(head).toBeTruthy();
    expect(typeof head.key).toBe("string");
    expect(typeof head.departed).toBe("boolean");
    expect(typeof head.quotable).toBe("boolean");
    expect(head.active_model).toBe(doc.record.active_model);
    expect(ref.headline.key).toBe(head.key);
    expect(ref.headline.departed).toBe(head.departed);
    if (!head.departed) expect(head.t_mrca).toBe(doc.record.t_mrca);
    if (!head.quotable) expect(head.refutation).toMatch(/not a finding/);
  });

  it.skipIf(!HAVE_EXAMPLES)("writes the reference's own two files through ?file=", async () => {
    const csv = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="dating-[0-9a-f]{8}\.csv"/);
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe("taxon,sampling_date,root_divergence,fitted_divergence,predicted_date,divergence_residual,temporal_residual,z_score,is_outlier,is_holdout");
    expect(lines).toHaveLength(99);
    // `prediction_method` is OURS and the reference emits no such column, so the default file diffs
    // against a CLI run and the column is available on request.
    expect(lines[0]).not.toMatch(/prediction_method/);
    const withCol = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=csv&prediction_method=1");
    expect(withCol.text.split("\n")[0]).toMatch(/,prediction_method$/);

    const json = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=json");
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toMatch(/application\/json/);
    const parsed = JSON.parse(json.text);
    expect(parsed.primaeon).toBeUndefined(); // includeProvenance: false — the CLI's shape exactly
    expect(parsed.t_mrca).toBeCloseTo(1979.83, 1);
    expect(parsed.taxa_summary).toHaveLength(98);

    // `?format=csv` without `?file=` still means "this analysis's main table".
    const plain = await request(handle.app).get("/api/v1/jobs/" + id + "/result?format=csv");
    expect(plain.text).toBe(csv.text);
    const bad = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=curves");
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/json, csv/);
  });

  it.skipIf(!HAVE_EXAMPLES)("takes the dates from a metadata table and prints -d on the reproduction line", async () => {
    const ex = engineExample("H5N1_HA_geo", { dates: "H5N1_HA_metadata.csv" });
    const out = await run({ analysis: "dating", alignment: ex.alignment, dates_file: ex.dates_file, names: ex.names });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    // The document is on disk, as submitted, so a job that died in a restart can be reconstructed.
    expect(out.view.inputs.files.dates_file).toBe("dates.txt");
    expect(existsSync(path.join(config.jobsDir, out.id, "dates.txt"))).toBe(true);
    expect(readFileSync(path.join(config.jobsDir, out.id, "dates.txt"), "utf8")).toBe(ex.dates_file);
    // And it is NOT an option: a caller's metadata document must not end up copied into provenance.
    expect(JSON.stringify(out.view.options)).not.toMatch(/Vietnam|A\/chicken/);

    const doc = (await request(handle.app).get("/api/v1/jobs/" + out.id + "/result")).body;
    expect(doc.date_review.source).toBe("table");
    expect(doc.provenance.reference_command.command).toMatch(/ -d H5N1_HA_metadata\.csv /);
    expect(doc.provenance.preprocessing.date_source).toBe("table");
    expect(doc.provenance.preprocessing.date_gate.overrides).toEqual({ accept_bare_numbers: false, drop_undated: false });
  });

  it.skipIf(!HAVE_EXAMPLES || SLOW)("use_model is a REQUEST, and it changes the estimator and the answer", async () => {
    const ex = engineExample("korber_env_gp160");
    const free = await run({ analysis: "dating", alignment: ex.alignment, names: ex.names, options: { root_taxon: "CONSENSUS", drop_undated: true } });
    const model = await run({ analysis: "dating", alignment: ex.alignment, names: ex.names, options: { root_taxon: "CONSENSUS", drop_undated: true, use_model: true } });
    expect(model.view.status, JSON.stringify(model.view.error)).toBe("completed");
    const a = (await request(handle.app).get("/api/v1/jobs/" + free.id + "/result")).body;
    const b = (await request(handle.app).get("/api/v1/jobs/" + model.id + "/result")).body;
    expect(a.record.distance_mode).toBe("tn93");
    expect(b.record.distance_mode).toBe("latent");
    expect(b.honesty.model_pass).toBe(true);
    // MEASURED through this server: 1938.77 model-free against 1926.81 with the dating graph, on
    // the same sequences and the same dates. This is why `use_model` is not an availability
    // accident and why `distance_mode` travels with every date.
    expect(a.record.t_mrca).toBeCloseTo(1938.77, 1);
    expect(b.record.t_mrca).toBeCloseTo(1926.81, 1);
    expect(Math.abs(a.record.t_mrca - b.record.t_mrca)).toBeGreaterThan(10);
  }, 300_000);
});

describe("analysis: temporal — a refining null on an SSE stream", () => {
  let id;
  let events;

  it.skipIf(!HAVE_EXAMPLES)("runs H5N1 end to end and streams `summary` then a refining `permutations`", async () => {
    const ex = engineExample("H5N1_HA_geo", { tree: "H5N1_HA.nwk", dates: "H5N1_HA_metadata.csv" });
    const res = await post({
      analysis: "temporal",
      alignment: ex.alignment,
      tree: ex.tree,
      dates_file: ex.dates_file,
      names: ex.names,
      options: { time_points: 60, n_permutations: 200 }
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toMatch(ID_RE);
    expect(res.body.sections).toEqual({ summary: "pending", permutations: "pending" });
    id = res.body.id;

    events = await readSse(srv.baseUrl, "/api/v1/jobs/" + id + "/events");
    expect(events.at(-1).event).toBe("done");
    expect(events.at(-1).data.status).toBe("completed");

    const phases = new Set(events.filter((e) => e.event === "progress").map((e) => e.data.phase));
    for (const p of phases) {
      expect(["parse", "prepare", "temporal-infer", "temporal-smooth", "temporal-null", "temporal-waves"]).toContain(p);
    }

    const sections = events.filter((e) => e.event === "section");
    const perms = sections.filter((e) => e.data.name === "permutations");
    expect(sections.filter((e) => e.data.name === "summary").length).toBeGreaterThan(0);
    // The null refines: more than one payload, non-final first, exactly one final and last.
    expect(perms.length).toBeGreaterThan(1);
    expect(perms.filter((e) => e.data.final === false).length).toBeGreaterThan(0);
    expect(perms.at(-1).data.final).toBe(true);
    expect(perms.filter((e) => e.data.final).length).toBe(1);
    // The achieved draw count only ever goes up.
    const counts = perms.map((e) => e.data.payload.permutations.completed);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts.at(-1)).toBe(200);
  }, 300_000);

  it.skipIf(!HAVE_EXAMPLES)("projects the interim record: kilobytes on the wire, not megabytes", () => {
    const sections = events.filter((e) => e.event === "section");
    const biggest = Math.max(...sections.map((e) => e.bytes));
    const total = sections.reduce((a, e) => a + e.bytes, 0);
    // MEASURED on this run: the largest section event is ~24 KB and the whole stream's section
    // traffic is ~133 KB. The runtime's own interim payload is the WHOLE record — 6.7 MiB apiece
    // at the reference's defaults, 17 of them — so this bound is the projection doing its job, and
    // it is asserted rather than assumed because forwarding the record would not ERROR, it would
    // just make the server unusable under a second client.
    expect(biggest).toBeLessThan(128 * 1024);
    expect(total).toBeLessThan(512 * 1024);
  });

  it.skipIf(!HAVE_EXAMPLES)("says, on every payload, whether a negative finding is a result yet", () => {
    const perms = events.filter((e) => e.event === "section" && e.data.name === "permutations");
    const first = perms[0].data.payload;
    const last = perms.at(-1).data.payload;
    // `permutations.tested` flips true after the FIRST chunk while the call columns are still
    // zeros, so a client reading it alone prints "nothing is under selection" a second into every
    // run. `calls_are_final` is the discriminator, and it is on every payload, final or not.
    //
    // The first payload is the CALIBRATION chunk: draws have been made but `tested` has not flipped
    // yet, so the four-state discriminator reads `not-started` rather than `running`, and its
    // clause is "has not been drawn". Both are honest at that instant and neither is `finished`;
    // what must never happen is a payload that lets a reader conclude the calls are in.
    expect(first.calls_are_final).toBe(false);
    expect(["not-started", "running"]).toContain(first.null_state);
    expect(first.uncalled_because).toMatch(/has not (finished|been drawn)/);
    expect(perms.some((e) => e.data.payload.null_state === "running")).toBe(true);
    expect(last.calls_are_final).toBe(true);
    expect(last.null_state).toBe("finished");
    expect(last.uncalled_because).toBeNull();
    // p is reported only where it was measured; the note says why the rest is absent.
    expect(last.p_perm_at_candidates.length).toBeLessThanOrEqual(last.stage1_candidates);
    expect(last.note).toMatch(/splitmix64/);
    expect(last.note).toMatch(/assumed 1\.0/);

    // THE PROJECTION READS THE LIVE COLUMNS, NOT THE SCORED FILL. An interim payload is the scored
    // record with the live p-values spread onto the TOP LEVEL; `record.sites.p_perm` on that same
    // object is still 1.0 at every codon. A projection that read the wrong one would publish the
    // reference's assumed 1.0 as a measurement at every candidate, per chunk, for the whole run —
    // and it would look completely plausible, which is why this is asserted rather than eyeballed.
    const mid = perms.find((e) => e.data.payload.null_state === "running").data.payload;
    expect(mid.candidates_measured).toBeGreaterThan(0);
    expect(mid.p_perm_at_candidates.every((r) => r.p_perm === null || (r.p_perm > 0 && r.p_perm <= 1))).toBe(true);
    expect(mid.p_perm_at_candidates.some((r) => r.p_perm !== 1)).toBe(true);
  });

  it.skipIf(!HAVE_EXAMPLES)("serves all ten sections of the finished record, each of a sane size", async () => {
    const view = await request(handle.app).get("/api/v1/jobs/" + id);
    expect(view.body.sections).toEqual({ summary: "final", permutations: "final" });

    for (const name of TEMPORAL_SECTIONS) {
      const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=" + name);
      expect(res.status, name).toBe(200);
      expect(res.body.section, name).toBe(name);
      expect(res.body.honesty, name).toBeTruthy();
      expect(res.body.provenance, name).toBeTruthy();
      // The `curves` section is budgeted in NUMBERS because the time grid is a caller option; every
      // section stays inside the MCP's own 256 KiB inline limit so the two surfaces page alike.
      expect(JSON.stringify(res.body).length, name).toBeLessThan(256 * 1024);
    }

    const curves = (await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=curves&sites=1,2,3")).body;
    expect(curves.curves.map((c) => c.site)).toEqual([1, 2, 3]);
    expect(curves.curves[0].prevalence).toHaveLength(curves.time_points);
    expect(curves.duplicate_column_note).toMatch(/selection_intensity/);

    const bad = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=curves&sites=99999");
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/out of range/);
    const unknown = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=nope");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toMatch(/summary, sites, curves/);
  });

  it.skipIf(!HAVE_EXAMPLES)("writes the reference's four files, and never promises they diff clean", async () => {
    for (const [name, suffix, type] of [
      ["sites", "_sites_summary.csv", /text\/csv/],
      ["curves", "_curves.csv", /text\/csv/],
      ["waves", "_waves.csv", /text\/csv/],
      ["summary", "_summary.json", /application\/json/]
    ]) {
      const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=" + name);
      expect(res.status, name).toBe(200);
      expect(res.headers["content-type"], name).toMatch(type);
      expect(res.headers["content-disposition"], name).toMatch(new RegExp('filename="temporal-[0-9a-f]{8}' + suffix.replace(/\./g, "\\.") + '"'));
      expect(res.text.length, name).toBeGreaterThan(100);
    }
    const sites = await request(handle.app).get("/api/v1/jobs/" + id + "/result?file=sites");
    expect(sites.text.split("\n")[0]).toMatch(/^site,ref_aa,derived_aa,mutation_label,domain,/);
    expect(sites.text.trim().split("\n")).toHaveLength(567); // 566 codons + header

    const doc = (await request(handle.app).get("/api/v1/jobs/" + id + "/result")).body;
    const ref = doc.honesty.reference_command;
    expect(Object.keys(ref).sort()).toEqual(["caveats", "command", "reproduces"]);
    // `reproduces` is false on every run whose null drew at all: numpy MT19937 upstream against
    // xoshiro256** here (D17), so the arithmetic is identical and the answer is not.
    expect(ref.reproduces).toBe(false);
    expect(ref.caveats.length).toBeGreaterThan(0);
    // NOT A COUNT. `temporalDownloadNotes` is the runtime's, its length is the runtime's business
    // (it was five and is six since the null-assumption note landed), and a number pinned here was
    // pinning another workspace's constant from this suite. What this route owes is that the notes
    // arrive UNCHANGED on every JSON answer, which is the stronger thing to assert.
    expect(doc.honesty.download_notes).toEqual(temporalDownloadNotes(doc.record));
    expect(doc.honesty.download_notes.length).toBeGreaterThanOrEqual(5);
    expect(doc.honesty.download_notes.join(" ")).toMatch(/FORMAT byte for byte/);
    expect(doc.honesty.download_notes.join(" ")).toMatch(/selection_intensity` and `sweep_velocity` from the same array/);
    expect(doc.honesty.p_perm_fill).toMatch(/never reached stage two/);
    expect(doc.honesty.wave_variance.conditioned_on).toBeTruthy();
  });

  it.skipIf(!HAVE_EXAMPLES)("records the dates it used, the tree it was given and the null it ran", async () => {
    const doc = (await request(handle.app).get("/api/v1/jobs/" + id + "/result")).body;
    expect(doc.record.taxa_timestamped).toBeGreaterThan(0);
    expect(doc.record.stage).toBe("complete");
    expect(doc.record.permutations.completed).toBe(200);
    expect(doc.record.permutations.cancelled).toBe(false);
    expect(doc.date_review.source).toBe("table");
    expect(doc.provenance.preprocessing.tree_source).toBe("user");
    expect(doc.provenance.preprocessing.date_coverage.dated).toBe(98);
    expect(doc.provenance.null_state).toBe("finished");
    expect(doc.provenance.surface).toBe("node-server");
  });
});

describe("stopping a temporal run keeps what it produced", () => {
  // POST /cancel drives an abort into the worker and KEEPS what the run produced (Phase 6). The
  // TRUNCATION SEMANTICS — a mid-null abort resolves with a record at the achieved draw count,
  // carrying its p-values and a RUN_STOPPED_EARLY warning — are pinned deterministically in the
  // runtime, where the abort can be tripped by the null's own progress with no clock in the loop
  // (runtime/test/temporal-port.test.js, "a null aborted mid-draw..."). Proving the SAME thing here
  // meant catching a live run mid-null over HTTP and hoping the cancel won the race against the
  // null's completion; on a fast runner it did not, the run finished clean, and the test flaked (CI
  // run 35519189635). This test proves only what is the SERVER's to prove, and does so without that
  // race: that the route aborts the run, that the pillar RESOLVES rather than being deleted, and
  // that a resolved temporal record is a truncated-honest one. Whether the abort lands before the
  // null (job `cancelled`, no draws) or during it (job `completed`, a truncated record) is timing,
  // so BOTH terminal outcomes are accepted; the truncation assertions run in the `completed` branch,
  // which is the one the runtime test also exercises head-on.
  it.skipIf(!HAVE_EXAMPLES)("POST /cancel aborts the run, keeps it, and resolves a truncated record", async () => {
    const ex = engineExample("H5N1_HA_geo", { tree: "H5N1_HA.nwk", dates: "H5N1_HA_metadata.csv" });
    const res = await post({
      analysis: "temporal",
      alignment: ex.alignment,
      tree: ex.tree,
      dates_file: ex.dates_file,
      names: ex.names,
      // A large null so the cancel has room to land while it runs; the assertions do not depend on it.
      options: { time_points: 250, n_permutations: 4000 }
    });
    expect(res.status).toBe(202);
    const id = res.body.id;

    // Cancel as soon as the null phase is announced (draw 0), AWAITED so the route contract itself is
    // under test: 200 and a job view back. This is not timed against the null — the assertions below
    // hold for either terminal state the abort produces.
    let cancelSent = false;
    let cancelStatus = null;
    await readSse(srv.baseUrl, "/api/v1/jobs/" + id + "/events", {
      onEvent: (ev) => {
        if (cancelSent) return;
        if (ev.event !== "progress" || ev.data.phase !== "temporal-null") return;
        cancelSent = true;
        // `.end(cb)` DISPATCHES the request now. A supertest request built with `.send()` alone is
        // lazy — it does not hit the wire until awaited, and awaiting it after this SSE read (which
        // only resolves when the run is `done`) would send the cancel AFTER the null had already
        // finished. That is the mistake that made this look like a broken abort; it was an unsent
        // request. Fire it here and capture the status in the callback.
        request(handle.app).post("/api/v1/jobs/" + id + "/cancel").send().end((_e, r) => { cancelStatus = r && r.status; });
      }
    });
    expect(cancelSent, "the run never entered the null phase").toBe(true);

    const view = await settle(id);
    expect(cancelStatus).toBe(200);
    // KEPT, not deleted: the row and its result survive the cancel (DELETE is the route that removes).
    // A pillar that cannot answer partially ends `cancelled`; the temporal pillar RESOLVES, so a
    // cancel that landed mid-null ends `completed` with a truncated record. Both are valid here.
    expect(["completed", "cancelled"]).toContain(view.status);

    if (view.status === "completed") {
      expect(view.warnings.map((w) => w.code)).toContain("RUN_STOPPED_EARLY");
      const doc = (await request(handle.app).get("/api/v1/jobs/" + id + "/result")).body;
      const perm = doc.record.permutations;
      expect(perm.cancelled).toBe(true);
      expect(perm.completed).toBeLessThan(perm.requested);
      // A client that stopped at draw N reads a result that says N and MEANS it: draw b is seeded
      // from splitmix64(seed, b), so this record is bit-identical to one configured at `completed`.
      const stopped = doc.provenance.warnings.find((w) => w.code === "RUN_STOPPED_EARLY");
      expect(stopped.message).toMatch(new RegExp("completed " + perm.completed + " of " + perm.requested));
      expect(stopped.data.reason).toMatch(/cancelled by client/);
      expect(doc.honesty.calls_are_final).toBe(true);
      expect(doc.record.stage).toBe("complete");
    }
  }, 300_000);

  it("cancelling an unknown job is 404, and cancelling a finished one is a no-op", async () => {
    const missing = await request(handle.app).post("/api/v1/jobs/" + "0".repeat(32) + "/cancel").send();
    expect(missing.status).toBe(404);
    const out = await run({ analysis: "dates", alignment: UNDATABLE });
    const again = await request(handle.app).post("/api/v1/jobs/" + out.id + "/cancel").send();
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("failed");
  });
});

describe("caps and plumbing", () => {
  it("a dates_file is capped the same way the alignment is", async () => {
    // The per-field cap and the whole-body limit are BOTH MAX_ALIGNMENT_CHARS (8 MiB), so a single
    // oversized field always trips the body limit first and answers 413 rather than the schema's
    // 400 — which is the right answer and is asserted here rather than assumed, because a reader of
    // the schema would expect the other one. The schema's message is what catches an oversized
    // field inside a body that is otherwise within the limit.
    const res = await post({ analysis: "dating", alignment: UNDATABLE, dates_file: "x".repeat(8 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.error.kind).toBe("input");
    // THE 8 MiB IS ONE BUDGET FOR EVERY FIELD, and since Phase 6b `dates_file` can be a BEAST XML
    // carrying its own alignment (measured at 1.03-1.61x the FASTA inside it). "Submit fewer
    // sequences" is then the wrong advice — the data is not too big, it arrived twice — so the
    // hint names that case and the two ways out of it.
    expect(res.body.error.message).toMatch(/every field together/);
    expect(res.body.error.hint).toMatch(/BEAST XML/);
    expect(res.body.error.hint).toMatch(/counted twice/);
  });

  it("n_permutations above the cap is refused before the date layer is even consulted", async () => {
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { n_permutations: 10_001 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CAPS_EXCEEDED");
  });

  it("POST /validate rehearses the same door checks, with no model byte spent", async () => {
    const res = await request(handle.app).post("/api/v1/validate").send({ analysis: "temporal", alignment: UNDATABLE });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.dates.ok).toBe(false);
    expect(res.body.dates.code).toBe("DATES_NONE");
    expect(res.body.warnings.some((w) => w.code === "DATES_NONE" && w.severity === "refuse")).toBe(true);
  });

  it.skipIf(!HAVE_EXAMPLES)("POST /validate reports the gate for `dates` as a warning, not a refusal", async () => {
    const ex = engineExample("korber_env_gp160");
    const res = await request(handle.app).post("/api/v1/validate").send({ analysis: "dates", alignment: ex.alignment });
    expect(res.status).toBe(200);
    expect(res.body.dates.ok).toBe(false);
    expect(res.body.dates.code).toBe("DATES_UNDATED_PRESENT");
    const w = res.body.warnings.find((x) => x.code === "DATES_UNDATED_PRESENT");
    expect(w.severity).toBe("warn");
    expect(w.data.gates_the).toEqual(["dating", "temporal"]);
    expect(res.body.ok).toBe(true);
  });

  it("the HTTP MCP's task literal carries dates_file", async () => {
    // The one failure in this seam that is INVISIBLE: an input added to the REST schema and
    // forgotten in mcp-mount.js's hand-copied task means REST jobs carry the metadata file and
    // /mcp tool calls silently run without it, on the same server, with no error on either path.
    let seen = null;
    const stub = {
      size: 1,
      status: async () => ({}),
      run(task) {
        seen = task;
        return { promise: Promise.resolve({ analysis: "dating", provenance: {} }), cancel() {} };
      }
    };
    await poolEngine(stub).run({ analysis: "dating", alignment: "A", dates_file: "name,date\nx,2001", names: { dates_file: "m.csv" } });
    expect(seen.dates_file).toBe("name,date\nx,2001");
    expect(seen.names.dates_file).toBe("m.csv");
  });

  it("the HTTP MCP's engine offers the runtime bag the temporal tool shapes its sections with", async () => {
    // The second invisible failure in this seam. `hyphaeon_temporal`'s `section=sites|curves` asks
    // the engine for a runtime bag and falls back to an EMPTY object when there is none, so a
    // pool-backed engine without it reaches `rt.siteRow(...)` on `undefined` — the same tool
    // answering two different ways on two transports of the same server.
    const engine = poolEngine({ size: 1, status: async () => ({}), run: () => ({ promise: Promise.resolve({ provenance: {} }), cancel() {} }) });
    const bag = await engine.runtimeBag();
    for (const fn of ["siteRow", "candidateSiteIndices", "temporalReferenceCommand", "temporalDownloadNotes"]) {
      expect(typeof bag[fn], fn).toBe("function");
    }
    // And it stays a promise of pure helpers: loading it must not drag onnxruntime into the HTTP
    // thread the worker pool exists to keep free.
    expect(await engine.runtimeBag()).toBe(bag);
  });

  it("every Phase 6 analysis is accepted by name, and an unknown one is still refused", async () => {
    for (const analysis of ["dates", "dating", "temporal"]) {
      const res = await post({ analysis, alignment: UNDATABLE });
      // Refused for its DATES, which is the point: the analysis name itself was understood.
      expect([202, 422]).toContain(res.status);
      if (res.status === 422) expect(res.body.error.code).toMatch(/^(DATES|DATING|TEMPORAL)_/);
    }
    const bogus = await post({ analysis: "chronology", alignment: UNDATABLE });
    expect(bogus.status).toBe(400);
  });
});

// =================================================================================================
// Review round: the six findings the adversarial pass returned against this surface.
// =================================================================================================

/** N sequences of `codons` codons, all dated, so a grid refusal is reached on size and not on dates. */
function widePairs(codons, n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // One codon differs per sequence so the set is not a single haplotype, and the header carries
    // a year so the date layer has an axis if it is ever consulted.
    const body = "ATG".repeat(codons - 1) + (i % 2 ? "CTG" : "ATG");
    out.push(">seq_" + i + "_" + (2000 + i) + "\n" + body);
  }
  return out.join("\n") + "\n";
}

describe("S1 — `time_points` is capped, and the grid is in the cost model", () => {
  it("999,999 grid points is refused at the door, not accepted and run", async () => {
    // REPRODUCED before this cap: 202, then a worker held for the whole job timeout with /health
    // still reporting ok. The refusal is reached BEFORE the date layer, exactly as the permutation
    // cap is, so an undatable alignment is enough to prove the order.
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { time_points: 999_999 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("TEMPORAL_TIME_POINTS_EXCEEDED");
    expect(res.body.error.kind).toBe("input");
    expect(res.body.error.hint).toMatch(/2000/);
    expect(res.body.error.details.time_points).toBe(999_999);
  });

  it("5,000 grid points — the value that wedged a single-worker deployment — is refused too", async () => {
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { time_points: 5000 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("TEMPORAL_TIME_POINTS_EXCEEDED");
  });

  it("2,000 is accepted — the cap is the MCP tool schema's own number, not a tighter one", async () => {
    // It gets past the grid check and is then refused for its DATES, which is what proves the grid
    // check passed rather than that nothing was checked.
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { time_points: 2000 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toMatch(/^DATES_/);
  });

  it("a legal grid on too many codons is refused on [codons x T], not waved through", async () => {
    // 2,000 codons x 1,000 points = 2.0e6 cells, above the 1.2e6 cap; every OTHER number this
    // request carries is small (5 sequences, work 2.0e7 against a 2.5e9 cap), which is precisely
    // the shape that used to pass: the caps size the forward pass and the forward pass is T-blind.
    const res = await post({ analysis: "temporal", alignment: widePairs(2000), options: { time_points: 1000 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("TEMPORAL_GRID_TOO_LARGE");
    expect(res.body.error.details.grid_cells).toBe(2_000_000);
    expect(res.body.error.details.work).toBeLessThan(2.5e9);
    expect(res.body.error.hint).toMatch(/Lower `time_points` to at most 600\b/);
  });

  it("a grid below two points is refused as invalid rather than clamped", async () => {
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { time_points: 1 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("TEMPORAL_TIME_POINTS_INVALID");
  });

  it("POST /validate rehearses the grid refusal and reports the cell count either way", async () => {
    const over = await request(handle.app).post("/api/v1/validate").send({ analysis: "temporal", alignment: widePairs(2000), options: { time_points: 1000 } });
    expect(over.status).toBe(200);
    expect(over.body.ok).toBe(false);
    expect(over.body.warnings.some((w) => w.code === "TEMPORAL_GRID_TOO_LARGE" && w.severity === "refuse")).toBe(true);
    expect(over.body.summary.grid_cells).toBe(2_000_000);
    const under = await request(handle.app).post("/api/v1/validate").send({ analysis: "temporal", alignment: widePairs(100), options: { time_points: 250 } });
    expect(under.body.summary.time_points).toBe(250);
    expect(under.body.summary.grid_cells).toBe(25_000);
    expect(under.body.warnings.some((w) => w.code.startsWith("TEMPORAL_GRID") || w.code.startsWith("TEMPORAL_TIME_POINTS"))).toBe(false);
  });

  it("the default grid is the reference's own, and it is what an omitted option is sized at", async () => {
    const res = await request(handle.app).post("/api/v1/validate").send({ analysis: "temporal", alignment: widePairs(100) });
    expect(res.body.summary.time_points).toBe(250);
    expect(res.body.summary.grid_cells).toBe(25_000);
  });
});

describe("S5 — an option this server cannot name is refused, not dropped", () => {
  it("a one-letter typo is a 422 that names the key and the nearest real one", async () => {
    // REPRODUCED before this check: 202, the option echoed back in the job view, the run made the
    // 1,000-draw default, and nothing anywhere said the option had been ignored.
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { n_permutation: 50 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNKNOWN_OPTION");
    expect(res.body.error.kind).toBe("input");
    expect(res.body.error.details.unknown).toEqual(["n_permutation"]);
    expect(res.body.error.details.suggestions.n_permutation).toBe("n_permutations");
    expect(res.body.error.hint).toMatch(/Did you mean/);
  });

  it("the refusal comes before the caps and before the date layer", async () => {
    // An oversize option value AND a typo: the typo is what the caller can see and fix first.
    const res = await post({ analysis: "temporal", alignment: UNDATABLE, options: { n_permutation: 50, n_permutations: 10_001 } });
    expect(res.body.error.code).toBe("UNKNOWN_OPTION");
  });

  it("every analysis has a vocabulary, and a key with no near neighbour still refuses", async () => {
    const res = await post({ analysis: "dating", alignment: UNDATABLE, options: { zzzz_nonsense: 1 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNKNOWN_OPTION");
    expect(res.body.error.details.suggestions.zzzz_nonsense).toBeUndefined();
    expect(res.body.error.hint).toMatch(/The options `dating` accepts are: /);
  });

  it("the real options of every Phase 6 analysis are accepted", async () => {
    const vocab = optionVocabulary();
    for (const [analysis, keys] of [
      ["temporal", ["time_points", "n_permutations", "sweep_mode", "perm_work_budget", "root_taxon", "score_invariable_sites", "seed", "accept_bare_numbers", "dates_file_name"]],
      ["dating", ["use_model", "clock_model", "ci_method", "root_taxon", "excluded_taxa", "date_col", "drop_undated"]],
      ["dates", ["rows", "row_limit", "date_col", "delimiter", "accept_bare_numbers"]]
    ]) {
      for (const k of keys) expect(vocab[analysis].has(k), analysis + "." + k).toBe(true);
    }
    // And the vocabulary is DERIVED: `hyphaeon_temporal`'s schema is where `time_points` is named,
    // so a tool that gains an option gives this route the same option with no edit here.
    expect(vocab.temporal.has("bandwidth")).toBe(true);
    expect(vocab.temporal.has("tau_auc")).toBe(true);
    // Result-shaping and MCP delivery knobs are NOT job options: they are query parameters here.
    for (const k of ["fields", "top", "summary_only", "run_async", "wait_seconds", "section", "cpu"]) {
      expect(vocab.temporal.has(k), k).toBe(false);
    }
    // Nor are the request's own body fields.
    for (const k of ["alignment", "tree", "dates_file"]) expect(vocab.temporal.has(k), k).toBe(false);
  });

  it("a typo INSIDE `options.phenotype` or `options.dms` is refused too", async () => {
    // Both blocks copy their keys by name — `phenotypeRequestFor` (src/runner.js) walks a fixed
    // list and `runEverything` reads four names out of `options.dms` — so a typo in either was
    // exactly as invisible as a typo outside one.
    const pheno = await post({ analysis: "phenotype", alignment: UNDATABLE, options: { phenotype: { foregrund: "a,b" } } });
    expect(pheno.status).toBe(422);
    expect(pheno.body.error.code).toBe("UNKNOWN_OPTION");
    expect(pheno.body.error.details.block).toBe("phenotype");
    expect(pheno.body.error.details.suggestions.foregrund).toBe("foreground");
    const dms = await request(handle.app).post("/api/v1/validate").send({ analysis: "analyze", alignment: UNDATABLE, options: { dms: { enabl: false } } });
    expect(dms.status).toBe(200);
    // /validate does not refuse on options (it is a rehearsal of the caps and the date layer), so
    // the block check is asserted where it fires: at the job door.
    const dmsJob = await post({ analysis: "analyze", alignment: UNDATABLE, options: { dms: { enabl: false } } });
    expect(dmsJob.status).toBe(422);
    expect(dmsJob.body.error.details.block).toBe("dms");
    // And the real nesting the REST API documents is accepted — the shape server/test/jobs.test.js
    // submits for a phenotype run. Accepted here means "not refused for its options"; the job is
    // deleted again because a four-codon alignment has nothing to associate.
    const ok = await post({ analysis: "phenotype", alignment: UNDATABLE, options: { phenotype: { foreground: "a,b", n_permutations: 20 }, seed: 42 } });
    expect(ok.status).toBe(202);
    await request(handle.app).delete("/api/v1/jobs/" + ok.body.id);
  });

  it("the analyze report's own section switches are options, in both spellings", async () => {
    const vocab = optionVocabulary();
    for (const k of ["epistasis", "attribute", "filter", "dms", "call_mode", "callMode", "max_species", "maxSpecies", "phenotype"]) {
      expect(vocab.analyze.has(k), k).toBe(true);
    }
    // Through /validate rather than /jobs: the point is the vocabulary, not a forward pass.
    const res = await request(handle.app).post("/api/v1/validate").send({ analysis: "analyze", alignment: UNDATABLE, options: { epistasis: false, attribute: false, filter: false, dms: { enabled: false } } });
    expect(res.status).toBe(200);
    expect(res.body.warnings.some((w) => w.code === "UNKNOWN_OPTION")).toBe(false);
  });
});

describe("S3, S4, S6 — one envelope, a live null that says it is live, and no dead events", () => {
  let id;
  let events;
  /** `GET /result?section=summary` taken WHILE the null was drawing. */
  let liveSummary = null;
  let liveSummaryProgress = null;

  it.skipIf(!HAVE_EXAMPLES)("reports the null as RUNNING while it runs, on the summary section", async () => {
    const ex = engineExample("H5N1_HA_geo", { tree: "H5N1_HA.nwk", dates: "H5N1_HA_metadata.csv" });
    const res = await post({
      analysis: "temporal",
      alignment: ex.alignment,
      tree: ex.tree,
      dates_file: ex.dates_file,
      names: ex.names,
      // A grid small enough to be quick and a draw count large enough that the null is a phase and
      // not an instant, which is what makes the mid-run question askable at all.
      options: { time_points: 60, n_permutations: 2000 }
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    id = res.body.id;

    // THE READ IS AWAITED FROM INSIDE THE STREAM, NOT FIRED AND FORGOTTEN. The earlier version
    // launched `GET /jobs/:id` + `GET ?section=summary` with `.then().catch()` and never awaited
    // them, so `readSse` ran on to `done` (the run finished) and the two reads resolved AFTER the
    // null had advanced to `temporal-waves` — a race that failed on a fast runner
    // (`expected 'temporal-waves' to be 'temporal-null'`, nightly run 36240742640). `readSse` now
    // takes `onEventAsync` and awaits it before consuming the next SSE frame, so the run's own
    // progress is paused behind this read: while the test holds the event loop between the frame and
    // the read's resolution, the worker can post more frames but the stream does not advance, and
    // the phase cannot move past `temporal-null` under the reading. Triggered on the FIRST
    // `temporal-null` progress event (draw 0), the earliest point the null is provably live.
    //
    // REPRODUCED before the ORIGINAL fix: at phase `temporal-null` with done > 400, `?section=
    // summary` answered `{null_state: 'not-started'}` — a live null reported as not begun. That is
    // the bug this test guards; the state, not the timing, is the subject.
    let asked = false;
    events = await readSse(srv.baseUrl, "/api/v1/jobs/" + id + "/events", {
      onEventAsync: async (ev) => {
        if (asked) return;
        // A `temporal-null` progress event with at least one draw DONE: `done >= 1` is what makes
        // the null `running` rather than `not-started` (the scored payload exists only once a draw
        // has completed), and the phase check keeps it before `temporal-waves`. `done === 0` (the
        // phase's opening tick) would read `not-started` — the very state this test proves the
        // summary no longer wrongly reports mid-run — so it is explicitly skipped.
        if (ev.event !== "progress" || ev.data.phase !== "temporal-null" || !(ev.data.done >= 1)) return;
        asked = true;
        const v = await request(handle.app).get("/api/v1/jobs/" + id);
        liveSummaryProgress = v.body.progress;
        const s = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=summary");
        liveSummary = s.body;
      }
    });
    expect(asked, "the run never entered the null phase").toBe(true);
    expect(events.at(-1).data.status, JSON.stringify(events.at(-1).data.error || {})).toBe("completed");
    // The grid this run was sized at is ON the job, beside the codon and sequence counts the caps
    // already recorded — T is part of what sized the run now, not an option nobody measured.
    const sized = (await request(handle.app).get("/api/v1/jobs/" + id)).body.inputs.size;
    expect(sized.time_points).toBe(60);
    expect(sized.grid_cells).toBe(566 * 60);
    // The question was asked mid-null, which is the only thing that makes the answer interesting.
    expect(liveSummaryProgress && liveSummaryProgress.phase).toBe("temporal-null");
    expect(liveSummary).toBeTruthy();
    expect(liveSummary.honesty.null_state).toBe("running");
    expect(liveSummary.honesty.calls_are_final).toBe(false);
    expect(liveSummary.honesty.uncalled_because).toMatch(/has not finished/);
    expect(liveSummary.status).toBe("running");
    expect(liveSummary.final).toBe(false);
  }, 300_000);

  it.skipIf(!HAVE_EXAMPLES)("answers a running and a finished section in the SAME envelope", async () => {
    const done = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=summary");
    expect(done.status).toBe(200);
    // The four envelope fields, at the same depth, in both states — `honesty` above all, because a
    // client that reads `body.honesty` used to get `undefined` exactly while a run was in flight.
    for (const key of ["analysis", "section", "status", "final", "honesty", "summary"]) {
      expect(liveSummary[key], "live." + key).toBeDefined();
      expect(done.body[key], "done." + key).toBeDefined();
    }
    expect(liveSummary.analysis).toBe("temporal");
    expect(done.body.analysis).toBe("temporal");
    expect(done.body.section).toBe("summary");
    expect(done.body.status).toBe("completed");
    expect(done.body.final).toBe(true);
    expect(done.body.honesty.null_state).toBe("finished");
    // Nothing is nested under `payload` any more on either side.
    expect(liveSummary.payload).toBeUndefined();
    expect(done.body.payload).toBeUndefined();
  });

  it.skipIf(!HAVE_EXAMPLES)("every temporal section carries honesty at the top level", async () => {
    for (const name of TEMPORAL_SECTIONS) {
      const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=" + name);
      expect(res.status, name).toBe(200);
      expect(res.body.analysis, name).toBe("temporal");
      expect(res.body.section, name).toBe(name);
      expect(res.body.status, name).toBe("completed");
      expect(res.body.final, name).toBe(true);
      expect(res.body.honesty, name).toBeTruthy();
    }
  });

  it.skipIf(!HAVE_EXAMPLES)("emits no `permutations` payload that repeats the one before it", () => {
    const perms = events.filter((e) => e.event === "section" && e.data.name === "permutations");
    // MEASURED before this change, at B = 4,000: a tail of 3945, 4000, 4000, 4000, 4000 whose null
    // states read running, running, running, finished, finished — the last chunk, the round
    // boundary at the same count, the finished record arriving as an interim, and the final. Three
    // of the five said nothing new and two of those still said the null was running.
    const keys = perms.map((e) => e.data.payload.null_state + ":" + e.data.payload.permutations.completed);
    expect(new Set(keys).size).toBe(keys.length);
    // The count never goes backwards; it repeats only where the STATE moved, which is the final
    // payload flipping `running` to `finished` at the achieved count and nothing else.
    const counts = perms.map((e) => e.data.payload.permutations.completed);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    const repeats = counts.filter((c, i) => i > 0 && c === counts[i - 1]);
    expect(repeats).toEqual([2000]);
    expect(perms.at(-2).data.payload.null_state).toBe("running");
    expect(counts.at(-1)).toBe(2000);
    expect(perms.filter((e) => e.data.final).length).toBe(1);
    expect(perms.at(-1).data.final).toBe(true);
    // And the summary is emitted for a STATE CHANGE, not per chunk: three states at most
    // (not-started at the scored payload, running, finished), never one per draw chunk.
    const summaries = events.filter((e) => e.event === "section" && e.data.name === "summary");
    expect(summaries.length).toBeLessThanOrEqual(4);
    expect(summaries.at(-1).data.final).toBe(true);
    expect(summaries.at(-1).data.payload.honesty.null_state).toBe("finished");
    expect(summaries.some((e) => e.data.payload.honesty.null_state === "running")).toBe(true);
  });

  it.skipIf(!HAVE_EXAMPLES)("a record under the 4 MiB cap is still served whole, byte count on the view", async () => {
    const view = await request(handle.app).get("/api/v1/jobs/" + id);
    expect(view.body.result_bytes).toBeGreaterThan(0);
    expect(view.body.result_bytes).toBeLessThan(TEMPORAL_RECORD_BYTES_MAX);
    const whole = await request(handle.app).get("/api/v1/jobs/" + id + "/result");
    expect(whole.status).toBe(200);
    expect(whole.body.record.stage).toBe("complete");
  });

  it.skipIf(!HAVE_EXAMPLES)("keeps the projection small even with the honesty block on every payload", () => {
    // WHAT IS ACTUALLY BOUNDED HERE IS THE PAYLOAD, NOT THE STREAM, and the first version of this
    // test asserted the stream. It summed every `section` event's bytes and checked `total < 512
    // KiB`, but the NUMBER of those events is a function of how many null chunks finish and how many
    // progress refreshes fire — which grows with wall-clock, so a loaded machine emits more events
    // for the same run and the sum rises with it. It failed at ~564 KB under a four-workspace run
    // and passed in isolation, the signature of an assertion on something unbounded rather than of
    // a flake. PHASE6 §3 called it "the bound that protects the server"; it never was one.
    //
    // The real invariant is PER-EVENT: every section is a projected section (a summary or a
    // permutations chunk, whose rows TEMPORAL_PERM_ROWS_MAX already bounds), never the runtime's
    // interim WHOLE record, which is 6.7 MiB apiece. So the bound is asserted on EACH event, with no
    // dependence on how many there are. A per-event check cannot be defeated by one oversized payload
    // the way a mean or a sum can, and it catches the regression this test exists for — a payload
    // that starts carrying the whole record, off by two orders of magnitude.
    const PER_EVENT_MAX = 128 * 1024;
    const sections = events.filter((e) => e.event === "section");
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(s.bytes).toBeLessThan(PER_EVENT_MAX);
  });
});

describe("S2 — the whole record is served, up to a measured size", () => {
  it.skipIf(SLOW || !HAVE_EXAMPLES)("a record over the cap is 406 naming ?section= and ?file=, both of which still work", async () => {
    const ex = engineExample("H5N1_HA_geo", { tree: "H5N1_HA.nwk", dates: "H5N1_HA_metadata.csv" });
    // MEASURED on this example: 4,987,844 bytes at T = 600 against 4,182,333 at T = 500, so 600 is
    // the first grid on the shipped demo whose record crosses the 4 MiB cap. B is small because the
    // null has nothing to do with the record's size.
    const out = await run({
      analysis: "temporal",
      alignment: ex.alignment,
      tree: ex.tree,
      dates_file: ex.dates_file,
      names: ex.names,
      options: { time_points: 600, n_permutations: 50 }
    });
    expect(out.view.status, JSON.stringify(out.view.error)).toBe("completed");
    expect(out.view.result_bytes).toBeGreaterThan(TEMPORAL_RECORD_BYTES_MAX);

    const whole = await request(handle.app).get("/api/v1/jobs/" + out.id + "/result");
    expect(whole.status).toBe(406);
    expect(whole.body.error.code).toBe("TEMPORAL_RECORD_TOO_LARGE");
    expect(whole.body.error.kind).toBe("input");
    expect(whole.body.error.details.result_bytes).toBe(out.view.result_bytes);
    expect(whole.body.error.details.sections).toEqual(TEMPORAL_SECTIONS);
    expect(whole.body.error.hint).toMatch(/\?section=/);
    expect(whole.body.error.hint).toMatch(/\?file=/);

    // The two doors the refusal names are open, and they are the ones that cost no whole-record
    // parse: every section stays inside the MCP's own inline limit, and a reference file is text.
    for (const name of TEMPORAL_SECTIONS) {
      const s = await request(handle.app).get("/api/v1/jobs/" + out.id + "/result?section=" + name);
      expect(s.status, name).toBe(200);
      expect(s.body.honesty, name).toBeTruthy();
      expect(JSON.stringify(s.body).length, name).toBeLessThan(256 * 1024);
    }
    const file = await request(handle.app).get("/api/v1/jobs/" + out.id + "/result?file=curves");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/text\/csv/);
    expect(file.text.length).toBeGreaterThan(TEMPORAL_RECORD_BYTES_MAX / 4);
    // CSV of the same record is not guarded either: it is a writer's output, not a parsed document.
    const csv = await request(handle.app).get("/api/v1/jobs/" + out.id + "/result?format=csv");
    expect(csv.status).toBe(200);
  }, 300_000);
});
