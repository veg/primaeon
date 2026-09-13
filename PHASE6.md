# Phase 6 — the time pillars on the other two surfaces, and the close of the plan

PLAN-TEMPORAL.md phase 6, integrated 2026-09-12. Its whole sentence in the plan is "MCP tools and
server analyses for both pillars, as every other pillar has", and matching what `meme` / `busted` /
`epistasis` / `dms` / `phenotype` already do is therefore the specification. Two builders worked in
parallel — one on `mcp/`, one on `server/` — and this document is the integrator's: what they built,
what it was measured at on this machine, what each surface refuses, what was broken at integration
and fixed, and — because **this is the last phase of the plan** — one consolidated list of what
remains open across all of it, in place of a sixth separate "carried" list.

The four phases that built the `/time` route are `PHASE2-DATES.md` (the date layer),
`PHASE3-DATING.md` (the molecular clock), `PHASE4-DATING-MODEL.md` (its model-based estimator) and
`PHASE5-TEMPORAL.md` (temporal selection). Each of them ends by saying that the MCP and the server
got nothing; this phase is that debt.

## 1. The verdict

**Three analyses, three tools, and no new arithmetic.** Nothing under `runtime/src/`, nothing in
`web/` outside `src/routes/mcp/`, and nothing in the engine was touched. Both surfaces wrap the
runtime exports Phase 5 left for them (`./dates`, `./dating`, `./dating/neural`, `./clock`,
`./temporal`), so a number that is wrong here is wrong in the browser too, and the browser's
numbers were checked against the reference in the four reports above.

What is genuinely new is **surface contract**, and it is where a non-interactive client can be
misled:

- **The date layer is a second input.** `dates_file` is a document — an Auspice build, a
  name-to-date map, a CSV — and it has to survive JSON transport, a job directory and a worker
  boundary to reach the parser. A run that quietly fell back to reading the sequence NAMES instead
  would still answer, with different numbers and no error anywhere.
- **Two confirmation gates that the browser puts to a human have nobody to ask.** Dates read mostly
  as a bare number in a sequence name, and a set with undated sequences that would be dropped
  silently, both refuse on these surfaces with a named override (`accept_bare_numbers`,
  `drop_undated`) — and `analysis: "dates"` never refuses for either, because reporting them is its
  whole job.
- **A negative finding is not a result until the null is in.** `permutations.tested` flips true
  after the first chunk while the call columns are still zeros, so every temporal payload — interim
  or final, section or whole record — carries the null's four-state discriminator
  (`not-started | running | finished | stopped`), `calls_are_final`, and the clause that says why
  not. A client reading `tested` alone would print "nothing is under selection" one second into
  every run.
- **Neither pillar promises reproduction it cannot deliver.** `reference_command` on `dating` and
  `temporal` is an OBJECT, `{command, reproduces, caveats}`, not the argv array the other six
  pillars stamp; `mcp/src/engine.js`'s `referenceCommand` now THROWS for these two rather than build
  a second, disagreeing line. `reproduces` is false on every temporal run whose null drew at all
  (numpy MT19937 upstream against xoshiro256\*\* here, D17) and on every dating run whose dates came
  from sequence headers (this build's parser is wider than the reference's).

## 2. What landed

### `mcp/` 0.5.0 — `@veg/hyphaeon-mcp`

`TOOL_NAMES` is 15, registered in the order a client uses them: `…hyphaeon_phenotype`,
**`hyphaeon_dates`**, **`hyphaeon_dating`**, **`hyphaeon_temporal`**, `hyphaeon_evaluate`, ….

| Tool | What it is | Cost |
|---|---|---|
| `hyphaeon_dates` | The date review as data: which rule dated each sequence, what did not match, what was imputed, the span, the match ladder, and whether the set carries a clock at all. **Never reaches `src/engine.js`**: no model, no graph. | milliseconds |
| `hyphaeon_dating` | The molecular clock: rate, MRCA date with its interval, the spline adjudication, a per-taxon table of residuals and outliers. Model-free by default, and takes **no tree** (D34). `use_model: true` loads the second ONNX artifact and a different estimator. | one graph pass only under `use_model` |
| `hyphaeon_temporal` | Per-site trajectories through calendar time, a permutation null, four fPCA wave modes, a four-way classification against the static MEME call. **Always a job**; the record is never returned inline. | the model pass plus the null |

New in the protocol surface: `get_results` gained a `sites` argument and its `section` enum is now
`REPORT_SECTIONS ∪ TEMPORAL_SECTIONS` (`summary | sites | curves | waves | permutations | dates |
candidates | warnings | honesty | provenance`); `job_status` names the sections of a temporal job;
`hyphaeon://temporal/{id}` is a new resource template serving summary + honesty + date review + the
section vocabulary and never the record; `hyphaeon://methods/requirements` gained `pillars.dates`,
`.dating`, `.temporal`, `caps.temporal`, `caps.taxa.dating_model_max` and the date layer's warning
vocabulary (31 codes plus the two gates, counted from `mcp/src/validate.js`'s `DATE_DESCRIPTIONS`);
three new prompts (`interpret-dates`, `interpret-dating`, `interpret-temporal`) and three new rows
plus a time-aware pre-flight section in `choose-analysis`.
`caps.js` gained `DATING_MODEL_MAX_TAXA = 1500` and `TEMPORAL_ALWAYS_JOB`, and `workFor` /
`classifyRun` take an optional trailing options bag so `server/src/validate.js`'s existing calls keep
working.

`mcp/src/time.js` (new, ~900 lines) is where the shared judgements live: the date-layer wrapper, the
23-code refusal→hint table, the dating reproduction line and honesty block, the null's four states,
and the temporal honesty, summary and section projections.

### `server/` — ten analyses on `POST /api/v1/jobs`

`ANALYSES` is `analyze, meme, busted, epistasis, dms, phenotype, evaluate, dates, dating, temporal`,
and the zod enums on `JobRequest.analysis` and `ValidateRequest.analysis` pick the three new names up
from it.

- **`dates_file`** is the metadata document's TEXT in the body, `z.string().max(MAX_ALIGNMENT_CHARS)`
  (the `phenotype_file` precedent, 8 MiB), never a server path. It is written into the job directory
  as `dates.txt` — named for what it honestly may be — and threaded to the engine as an **INPUT**,
  so no copy of a caller's Auspice build lands in `provenance.options`. `names.dates_file` is the
  basename, printed as `-d <name>` on the reproduction line. `POST /api/v1/validate` accepts both.
- **The date layer is checked at the door**, synchronously on the HTTP thread after the caps check,
  so an undatable alignment is a 422 before a worker is spent.
- **`POST /api/v1/jobs/:id/cancel`** (new): stop the run and KEEP what it produced. 404 unknown,
  else 200 with the job view, idempotent on a terminal job. Every pillar but `temporal` then ends
  `cancelled`; a temporal run ends **`completed`** with a truncated null and a `RUN_STOPPED_EARLY`
  warning naming the achieved draw count — draw *b* is seeded from `splitmix64(seed, b)`, so a run
  stopped at 313 draws is bit-identical to one configured at 313. `DELETE` still removes everything.
- **Result-route knobs**: `?section=` serves the ten temporal sections through the MCP's own
  `temporalSection`, so `get_results section=curves` and `GET /result?section=curves` are one
  implementation; `?sites=12,44,90` names 1-indexed codons for `sites` and `curves`; `?file=` serves
  the reference's own output files (temporal `sites|curves|waves|summary`, dating `json|csv`) with a
  `Content-Disposition`, and `?prediction_method=1` adds dating's extra column.
- **SSE**: the progress contract is unchanged, `progress(phase, done, total, message)`. New phases
  reachable: `dating` (6 steps), `dating-model`, and
  `temporal-infer | temporal-smooth | temporal-null | temporal-waves`. A temporal job publishes two
  live sections and no more — `summary` once non-final at stage `scored` and once final, and
  `permutations` once per null chunk. `sections` on the job view is now per-analysis
  (`LIVE_SECTIONS`): the report's seven for `analyze`, `{summary, permutations}` for `temporal`,
  absent for the rest.
- **`HYPHAEON_TEMPORAL_PERM_BUDGET`**, default 1.0e12 — twenty times the browser's 5.0e10, which was
  chosen so a tab stays responsive. The job timeout, not the work budget, is what bounds a long null
  here, and a null the clock stops still returns a valid record.
- `server/src/time.js` (new) is the seam. It **resolves** `mcp/src/time.js` beside the published
  `./engine` entry (`createRequire().resolve` + `pathToFileURL`) rather than copying the gate
  thresholds, the refusal table, the four-state discriminator or the honesty clauses: a second copy
  of `BARE_NUMBER_MAJORITY` would be a second threshold, and two surfaces disagreeing about when to
  refuse a bare-number axis is the exact failure the gate exists to prevent. It is a documented
  workaround for an exports map with no `./time`, not a design.

### `e2e/server.spec.ts` — all three through the real bin

The three analyses are now driven the way the seven before them are: POST, stream the SSE, read the
result, take the downloads — against `server/bin/hyphaeon-server.js` started as a user would start
it, **on a PATH that is an empty directory**. Five new specs, plus two strengthened assertions:

- the H5N1 date review over the wire, with the metadata table as `dates_file` (the result must say
  `date_review.source === 'table'`, which is the only thing that distinguishes a run that used the
  document from one that silently read the sequence names);
- the door refusals: `dating` and `temporal` on an undatable alignment are 422 `DATES_NONE`,
  `kind: "input"`, with a hint that names the metadata fix and not "report it to the operator";
- the korber undated gate, refused for `dating` and **reported** by `dates`;
- the H5N1 clock, with both reference files taken as downloads and the `{command, reproduces,
  caveats}` object asserted to be an object;
- the H5N1 temporal run end to end: the refining null on the stream, the byte bound on the
  projection, every one of the ten sections under the MCP's 256 KiB inline limit, `?sites=`,
  the 400 on an out-of-range codon, and all four reference files with their `Content-Disposition`;
- `GET /api/v1/models` now asserts `engine.dating_graph` and `engine.date_layer`, because
  `deploy/README.md` tells an operator to read the first of those to know whether a build can serve
  `use_model` at all;
- the no-subprocess test now asserts that `server/src/time.js`, `mcp/src/time.js`,
  `runtime/src/datingNeural.js`, `runtime/src/rootToTip.js` and `runtime/src/{dates,dating,temporal}/`
  are **inside** the scan that proves it, rather than merely not caught by it. A file moved out of the
  scanned directories would otherwise drop silently out of the proof, and `dates` is the one analysis
  on this surface that reads a user's own metadata document.

The dated examples live in `../HyphAeon/examples/`, not in `web/static/gallery/inputs/`, so these
specs skip when the sibling checkout is absent, exactly as `e2e/time.spec.ts` does.

## 3. The numbers

Everything below was produced by a run in this integration session on this machine (Node 22.22.0
x64 under Rosetta, onnxruntime-node 1.23.2), with
`HYPHAEON_MODELS_DIR=../HyphAeon/models` and the engine checked out at **`phase-5e`**. The app pins
`phase-5d`; `phase-5d..phase-5e` is one commit touching only `scripts/parity.py`, so the library
these suites link is byte-identical to the pinned one.

### Suites

| Workspace | Files | Tests | Duration | New this phase |
|---|---|---|---|---|
| `runtime/` | 28 | 592 | 49.94 s | none (untouched) |
| `web/` | 24 | 309 | 2.80 s | `src/routes/mcp/page.test.ts` updated for the three tools |
| `mcp/` | 13 | 154 | 42.26 s | `test/dates.test.js` 16, `test/dating.test.js` 8, `test/temporal.test.js` 16 |
| `server/` | 6 | 91 | 42.47 s | `test/time.test.js` 33, one added to `test/sweep.test.js` |
| **total** | **71** | **1,146** | **2 min 18 s** | |

`cd web && npm run check` → `COMPLETED 659 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, 7.9 s.
`HYPHAEON_PREBAKE=skip npm run build` clean, 8.8 s of vite.
`npm ci --dry-run` resolves the root lockfile without error.

The builders' own baselines, for the deltas: mcp was 10 files / 113 tests before this phase and
server 5 / 57. The MCP builder reported 154 tests at 46.21 s and the server builder 91 at 41.11 s;
both reproduce here (154 at 42.26 s, 91 at 42.47 s), the differences being machine load.

### Playwright

| Run | Specs | Duration |
|---|---|---|
| `npx playwright test` (whole suite, against a `HYPHAEON_PREBAKE=skip` build) | 76 | 48.8 s |
| `npx playwright test server.spec.ts` | 15 | 13.6 s |

`server.spec.ts` was 10 specs before this phase. The five new ones cost **3.27 s of the 13.6 s**:
date review 36 ms, door refusals 23 ms, korber gate 33 ms, the clock with both files 80 ms, and the
temporal run with every section and file **3.1 s**. That is the cheapest honest budget available:
H5N1_HA_geo is 98 sequences × 566 codons with a tree and a metadata CSV, and at `time_points: 60`,
`n_permutations: 200` it exercises the metadata-table date path, the streaming null, all ten
sections and all four reference files in one run. korber_env_gp160 (143 sequences, exactly one of
them undated) is the gate's own test case and costs 33 ms because no model runs.

### What the new specs measured

| Measurement | Value |
|---|---|
| H5N1 date review over the wire | 98 of 98 dated from the table, span 1996 – 2005, units `years`, 98 rows returned |
| H5N1 molecular clock (model-free, TN93) | `t_mrca` 1979.834, μ 6.811 × 10⁻⁴, 98 taxa, `tree_source: 'tn93'`, run phase `dating` only, 0.1 s |
| H5N1 temporal, T = 60, B = 200 | 3.4 s wall on the stream; **9 section events, biggest 28.7 KB, 175.4 KB of section traffic in all, 7 permutation payloads**, 200 of 200 draws completed, `null_state: 'finished'` |
| Temporal `sites` file | 567 lines (566 codons + header), the reference's own column order from `site,ref_aa,derived_aa,mutation_label,domain,…` |
| Server `analyze` vs the Python reference (unchanged, re-measured) | max \|Δ\| 1.34e-5, max relative 2.41e-6, ρ 1.000000 — 0 graph-class violations |
| `/mcp` over HTTP, tools/list | the 15 names, in registration order |

**One discrepancy with a builder's figure, recorded rather than reconciled.** The server builder
measured the SSE null projection in-process (supertest) at "~24 KB biggest, ~133 KB total"; over a
real HTTP connection the e2e measures **28.7 KB and 175.4 KB**. Neither number is a contract — the
chunk cadence of the null decides how many payloads there are — which is why both the server suite
and the e2e assert the **bounds** (< 128 KB per event, < 512 KB in all) and annotate the achieved
figures. The bound is what protects the server; the figure is what it cost on the day.

## 4. What each surface refuses, and with what

23 refusal codes, every one `kind: "input"` on the MCP and `422 {error:{kind:"input", code}}` on the
server, each with a metadata-specific hint (`mcp/src/time.js` `TIME_REFUSAL_HINTS`, audited by
`mcp/test/dates.test.js`):

```
DATES_SOURCE_UNREADABLE     DATES_SOURCE_KIND_UNKNOWN   DATES_BEAST_XML_UNSUPPORTED
DATES_TABLE_NO_DATE_COLUMN  DATES_AUSPICE_NO_TIPS       DATE_REGEX_INVALID
DATE_REGEX_NO_GROUP         DATES_TABLE_NO_MATCH        DATES_NONE
DATES_TOO_FEW               DATES_NO_SPAN               DATES_BARE_NUMBER_MAJORITY
DATES_UNDATED_PRESENT       DATING_ALIGNMENT_EMPTY      DATING_ALIGNMENT_RAGGED
DATING_ALIGNMENT_NOT_CODING DATING_TOO_FEW_DATED        DATING_NO_TIME_SPAN
DATING_TN93_UNCOMPUTABLE    DATING_MODEL_TOO_MANY_TAXA  TEMPORAL_NO_DATES
TEMPORAL_TOO_FEW_DATED      TEMPORAL_NO_TIME_SPAN
```

Three of them are Phase 6's own. `DATES_BARE_NUMBER_MAJORITY` and `DATES_UNDATED_PRESENT` are the
two confirmation gates, each naming its override; `DATING_GRAPH_UNAVAILABLE` (a server-class code,
not in the input table above) answers `use_model: true` on a build whose manifest declares no
`<variant>_taxa.onnx`, naming that fact rather than quietly answering with the other estimator.

The hint wording is itself asserted, on both surfaces and in the e2e: a caller with a bad CSV must
not be told to "report it to the operator" (the Phase 3 mistake that Phase 4 fixed for TN93 and this
table extends to 23 more codes), and must not be told to "check the reading frame", which is useless
advice to someone whose metadata has the wrong column name.

`analysis: "dates"` refuses for the metadata being unreadable and for **nothing else**: it answers
with `gate.blocking` populated where the two pillars would refuse, because reporting the gate is the
analysis.

## 5. Integration changes

Two things were red on arrival and are fixed here; neither was a test weakened.

1. **`e2e/smoke.spec.ts` failed on the `/mcp` page copy.** The MCP builder's new `hyphaeon_dates`
   row opened "Runs no model and loads no graph", and that spec forbids the bare word `Runs`
   anywhere in the tools table — Phase 3 had a "Runs" COLUMN that marked tools bridged to the Python
   reference, and the assertion that keeps it deleted cannot tell a column from a verb. The copy now
   opens "Loads no model and no graph", with the reason in a comment beside it so the next author
   does not rediscover it. The whole suite then passed 76 / 76.
2. **`.github/workflows/pages.yml` pinned `ENGINE_REF: phase-5c` while `ci.yml` pinned `phase-5d`**,
   against pages.yml's own comment that the two must match. That is not a stale deployment but a
   failed one: `js/src/temporal.js` does not exist at `phase-5c` (verified with `git cat-file`), so
   the web build's named imports of it fail at module link and take the Pages deployment with them.
   Both are `phase-5d` now, with the reason recorded in the file and in `CLAUDE.md`'s CI section.

Also confirmed rather than trusted, at the server builder's request: the two version strings they
edited in `package-lock.json` (mcp `0.4.0 → 0.5.0`, and `server`'s dependency on it) are the only
lockfile change, and `npm ci --dry-run` resolves the tree. Leaving them stale would have failed
`npm ci` at the root.

## 6. What Phase 6 did not do

These are this phase's own gaps, all of them deliberate and all of them named by the builders.

1. **The two gate codes live in the wrong repository layer.** `DATES_BARE_NUMBER_MAJORITY`,
   `DATES_UNDATED_PRESENT` and the 0.5 bare-number threshold are in `mcp/src/time.js` rather than in
   `runtime/src/dates/codes.js`, where all three surfaces would read one number and the browser
   would RENDER the refusal instead of computing its own in
   `web/src/lib/time/dateReview.ts`. The MCP builder's brief excluded `runtime/src/`. The
   duplication is visible and flagged in `time.js`'s header and in `mcp/README.md`'s known gaps.
2. **`datingReferenceCommand` is likewise in `mcp/src/time.js`**, not beside
   `temporalReferenceCommand` in `runtime/src/dating/results.js`. The runtime has no dating
   reproduction line at all, and the browser's static `DATING_DOWNLOAD_NOTE` still makes the
   unqualified claim the temporal pillar learned not to make.
3. **No parity surface for either pillar** (see §7.4).
4. **No downloads channel on the MCP.** The runtime ships byte-equal writers for both pillars and
   they are resolved in `loadRuntime`, but no tool returns file TEXT — `get_results` is JSON only,
   as it is for every other pillar. `temporalDownloadNotes` IS returned inside the honesty block, so
   a client that fetches the files elsewhere still gets the five mandatory sentences. The server
   does serve them, through `?file=`.
5. **A temporal job has no progressive sections on the MCP.** `runTemporal`'s `onProgress` is
   threaded through `engine.run` but no MCP surface subscribes: an interim payload is the whole
   record, and projecting it is what the server did. `cancel_job` on a temporal job therefore loses
   the run, exactly as it does for a report — the `stopped` null state is reachable and tested
   through `perm_work_budget` (a declined null), not through cancellation. Modelling "stop and keep
   what was drawn" on the MCP needs a `jobs.js` change, a shared file neither brief covered.
6. **`e2e/server.spec.ts` is the only browser-level coverage**, and it drives the server over HTTP
   rather than through the page. No browser flow posts a temporal job (see §7.2 item 4).
7. **`mcp/caveats.json` was not touched**: it is model-card and `model_eval` data keyed by
   `model_version`, and neither time pillar produced a calibration number this phase that is not
   already in the tool descriptions, the requirements resource and the prompts.
8. **No rate-limit test.** `server/test/time.test.js` raises the per-IP job limit in its own
   configuration (it submits about forty jobs in a few seconds, each refusal being its own POST) and
   says so; the limit itself is unchanged and untested, as it was before.

## 7. What remains open across the whole plan

This replaces the "carried" lists of `PHASE3.md`, `PHASE4.md`, `PHASE2-DATES.md` §6,
`PHASE3-DATING.md` §6, `PHASE4-DATING-MODEL.md` §8 and `PHASE5-TEMPORAL.md` §7, and the gap list in
`HANDOFF.md` §6. Where an item was closed since it was written, it is not repeated here; the two
biggest closures are `ENGINE_REF` (now `phase-5d` in both workflows, was `phase-3a`) and the GitHub
prerequisites (`veg/primaeon` exists, Pages deploys, and the engine checkout uses the read-only
`ENGINE_DEPLOY_KEY`, not the fine-grained PAT the older documents ask for).

### 7.1 Ship blockers — nothing is published and only a preview is deployed

1. **Nothing is on npm or PyPI.** `@veg/hyphaeon-mcp` 0.5.0 depends on `@veg/hyphaeon-runtime@0.0.0`,
   which is `private: true` and resolved by the workspace link, so the published tarball as it
   stands cannot be installed from the registry. `HANDOFF.md` §3.3 is the runbook; the fix is either
   to publish the runtime or to bundle it into the MCP's `files`.
2. **Neither the wheel nor the npm tarball carries `models/manifest.json`.** Every surface reads the
   graphs from the sibling engine checkout (`HYPHAEON_ENGINE_DIR` / `HYPHAEON_MODELS_DIR`), so
   pinning a published `@veg/hyphaeon-js` alone does not deliver models. `HANDOFF.md` §2.2.
3. **The server is not deployed anywhere.** `veg.github.io/primaeon` is a single-threaded static
   preview (Pages cannot send COOP/COEP); `deploy/README.md` is the runbook for the real origin and
   D1's domain question is still open. `HANDOFF.md` §4.
4. **The engine library is still a `file:` link** (`@veg/hyphaeon-js: file:../../HyphAeon/js`). At
   integration the engine checkout was on `feat/temporal` at `phase-5e` — one commit past the
   `phase-5d` the app pins, touching only `scripts/parity.py` — with further uncommitted changes to
   `scripts/parity.py` and `PARITY.md` in the working tree. Both repositories need a tagged release
   together (D19), and the app's two `ENGINE_REF`s move in the same change.

### 7.2 Product gaps a reader would notice

1. **A locally-run report over the browser caps cannot hand off to the server.** `dms.skipped`
   carries the work and the budget and the section names the server, but nothing posts the job —
   there is no `POST /api/v1/jobs` anywhere in `web/src`. Phase 2 carried this for DMS; Phase 6
   widens it, because the server now has a `temporal` analysis and the `/time` page's refusal copy
   still deliberately offers no server job (it was written when none existed).
2. **The browser's RHO phenotype stays incomparable with the reference fixture**: 655 taxa in the
   fixture against the app's 256-taxon cap (hard max 512). Node compares and passes. Needs either a
   fixture generated with `--max-species 256` or an uncapped browser path for parity runs.
3. **Permulation cost in the browser**: two L × B float64 matrices (~56 MB at RHO's L = 349,
   B = 10,000) in the analyze worker. A chunked B loop, or a cap tied to L before 10,000 is offered.
4. **`p_perm` printed at B = 1,000** is printing Monte Carlo noise to three decimals; PLAN §5.4's
   "null moments within 2 %" is only meaningful from B ≈ 10,000. The report should show B and round
   accordingly, or run 10,000 in the worker.
5. **Diagnostics thresholds** were never product-reviewed: `SHALLOW_TREE` flags Smc6 (the general
   model's own regime), `STAR_LIKE` fires below 5 haplotypes, `COST_ESTIMATE` uses a CPU-torch
   constant, and since D22 depth is judged on TN93 distances without the regime line saying so.
6. **Two caveats files**: `web/caveats.json` (validated at build) and `mcp/caveats.json` (served as
   `hyphaeon://caveats`, validated by nothing).
7. **Temporal records are not persisted with their date review.** Two [L, T] float64 curve blocks
   are 17.5 MB at the default grid, so a browser reload re-runs the model pass.
8. **No dated example is prebaked into the gallery.** korber, H5N1 and H1N1 live in the engine
   checkout, so `/time` has no demo on a machine without it, and the four time-phase reports' demo
   item is still open.

### 7.3 Decisions still owed by the ML team

1. **D20, the canonical MDS eigenvector sign convention**, still needs sign-off. It is implemented
   and defaulted on both sides (`../HyphAeon/MDS_SIGN.md`); the alternative is accepting that the
   browser cannot reproduce the CLI on the affected datasets.
2. **D2, canonical weights and a HuggingFace tag carrying `manifest.json`.**
3. **The BUSTED neural head has no trained weights in the checkpoint**, so its fields are
   nondeterministic upstream and `parity.py` skips them.
4. **The codon vocabulary** (`dataset.py`'s 61 sense codons against DataMonkey 3 / AxoMEME's TCAG-64)
   is settled in the library but not upstream.
5. **The wave-sign convention** is implemented and defaulted in the library (`WAVE_SIGN.md`) and the
   engine has no `--wave-sign` flag, so the two sides differ by a recorded flip vector — on the
   acceptance run, (−1, +1, −1, −1).
6. **Does a dating fit with no clock signal refuse, or disclose?** Date randomisation currently
   produces a confident sentence around −993.5; upstream does the same.

### 7.4 Parity and CI

1. **`dating` and `temporal` have no parity surface.** `runtime/scripts/parity-node.mjs` has no such
   analyses and `scripts/parity.py` has no comparator for either, nor does it know the H1N1 or H5N1
   example names. Their acceptance evidence is `runtime/test/{dating,temporal}-port.test.js` against
   the reference CLI's own committed output, plus the surface tests in `mcp/` and `server/`. The
   comparator belongs upstream with the field classes of `PHASE5-TEMPORAL.md` §3, and both new
   surfaces will want it.
2. **`temporal`'s `p_perm` can never be bit-reproduced** (numpy MT19937 against xoshiro256\*\*), and
   three things hang off it: the confirmed- and rescued-sweep sets, the classification of the codons
   in them, and the wave shapes and variance shares. The honesty block says so on every result; the
   statistical class is the only meaningful one there.
3. **A second committed fixture directory for H5N1** would pin the near-degenerate spectrum
   (97.0 / 1.54 / 0.66 / 0.48) that exercises the subspace rule; today that case lives in an e2e
   assertion and a scratch run.
4. **The gallery prebake is the CI long pole**: any edit under `runtime/src` rebakes all five
   examples at the next full build (3 min at 8 threads locally, 8.8 min on a runner). The `gallery`
   job is the only one that rebakes, and pull requests build with `HYPHAEON_PREBAKE=skip`.
5. **CI cannot run without the private engine checkout**, so pull requests from forks fail at that
   step by design; the engine's own `model_eval.yml` additionally needs `secrets.HF_TOKEN` and
   mamba, and `release.yml` cannot run at all until §7.1's accounts exist.
6. **`ENGINE_REF` lives in two files** (`ci.yml` and `pages.yml`) and must be bumped in both, in the
   same change that moves the app onto a new library. §5 item 2 is what happens when it is not.

### 7.5 Documents that are now wrong or missing

1. **`PLAN-TEMPORAL.md` is in neither checkout.** It is the plan of record for the four time phases
   and for decisions D26–D34, which `PHASE2-DATES.md`, `PHASE3-DATING.md`, `PHASE4-DATING-MODEL.md`
   and `PHASE5-TEMPORAL.md` all cite by number; those citations currently resolve to nothing. Its
   §5.1.3 cost table and D26 wording were both reported as needing correction from measurement.
2. **`PLAN.md` has not been rewritten for the time pillars** (its decision list ends at D22) nor for
   Phase 3's vocabulary: §4.0 and §4.2 still describe HyPhy branch-length estimation, §3.5's
   `tree_source` list has `hyphy-hky85`/`nj` where the recorded values are `user | embedded | tn93`,
   §3.6 and D16 still describe the Python bridge as live, and §5.1/§5.4 cite `dataset.py` line
   numbers that have moved. §8 says "all five phases are built and tagged", which was true of the
   product series and says nothing about the time series.
3. **`web/DESIGN.md` §6's e2e contract covers `/time` for the date, clock and temporal phases but
   not the MODEL-BASED clock**: there is no "phase 4" block beside the phase 2, 3 and 5 ones, so
   `PHASE4-DATING-MODEL.md`'s four hooks (`.model[data-state]`, `.divergence`, `.agreement`, and the
   aria-labels "Root for divergence" and "Divergence with the model") are still unrecorded there.
4. **`CLAUDE.md`'s release notes have no entries for the four time phases** — they jump from the
   2026-09-06 redesign to this phase. The four phase reports are the record; the notebook points at
   them but does not summarise them.
5. **`HANDOFF.md` predates all five time phases** (it was verified 2026-09-05) and its §0 ground
   truth, §6.3 "work in flight" and §7.3 check-command tails are all stale. Its §1–§5 runbooks —
   the engine pull request, the ML decisions, the release, the deployment and the cross-repository
   integrations — are still the right documents.

### 7.6 Deliberate refusals, recorded so nobody rediscovers them as bugs

Not gaps; decisions, each with a reason and each visible in the product rather than silent.

- **BEAST XML** is refused by name (`DATES_BEAST_XML_UNSUPPORTED`) rather than half-read; the
  reference reads one at `dating.py:433-434`.
- **`hyphaeon dating`'s power-law clock (D33), `--loocv`, `--bootstrap`** and its `poisson`,
  `residual-boot`, `site-boot` and `jackknife` interval methods are not ported and are refused by
  the schema. `record.primaeon.estimators_not_built` names each and why, and the reproduction line
  prints no flag for them. Tree re-rooting (D34) is declined rather than approximated.
- **Above 1,500 dated sequences** a model-based dating run refuses (`DATING_MODEL_TOO_MANY_TAXA`)
  where the reference quietly falls back to OLS — because the covariance the fallback does not build
  is the whole difference between the two answers.
- **Besag–Clifford curtailment** of the temporal null is not implemented: it changes the estimator,
  so a record carrying it would have to say so, and the budget check it exists to rescue essentially
  never fires at the shipped settings.
- **Lanczos MDS above N = 500** is not ported (the dense path agrees to 6.4e-7 on RHO, the one
  example that reaches it).
- **`server/src/runner.js`'s `composeReportFallback`** is dead against the current runtime and is
  kept as the documented degradation path.
- **`onnxruntime-node` is pinned exactly to 1.23.2** (the last release with darwin/x64 bindings);
  bump it together with an arm64 Node, not in a routine dependency update.

---

## 8. The review round, and the final check

Three adversarial reviewers drove both surfaces after §2 was integrated; one returned RED. What they
closed is in the source, in the headers that explain it and in the tests that keep it; this section
records only what CHANGED ABOUT THE DOCUMENT ABOVE, and what the final check found that no single
reviewer could see, because every remaining item was a disagreement BETWEEN two surfaces.

### 8.1 Items in §6 that are no longer open

- **§6.2 (`datingReferenceCommand` in the wrong layer) is closed.** It is
  `runtime/src/dating/results.js`'s now, under the same four-argument signature, and `mcp/src/time.js`
  re-exports it rather than keeping a copy. `datingDownloadNotes` landed beside it and
  `web/src/lib/time/datingDownloads.ts`'s unconditional `DATING_DOWNLOAD_NOTE` — the one §6.2 named —
  is a function of the run that claims a reproduction only when `reproduces` is true.
- **§6.5 (a cancelled temporal job loses the run on the MCP) is closed.** `mcp/src/jobs.js` keeps the
  record the runtime finished; `get_results`, `job_status`, `cancel_job` and
  `hyphaeon://temporal/{id}` all serve it labelled `status: cancelled`, `partial_result: true`, at
  the achieved draw count. DRIVEN OVER STDIO at this check on H5N1_HA_geo (T = 250, `-B 10000`,
  cancelled 2.9 s in): the record came back at **724 of 10,000 draws** with `null_truncated` naming
  the coarser grid (`p_perm` no finer than 1/725 = 0.00138), all four sections served and labelled,
  and the resource listing the run as STOPPED. The 16 confirmed sweeps at 724 draws are the same 16
  the full 10,000-draw run finds, which is what the per-draw substreams are for.
- **§6.1 (the two gate codes in the MCP rather than the runtime) is NOT closed** and stays as
  written.

### 8.2 What the final check found, and fixed

Every one of these is a disagreement between two surfaces about the same number or sentence — the
class of defect this phase exists to prevent, and the one no reviewer working on a single surface
could see.

1. **The MCP quoted a t_MRCA the browser refuses to quote, and nobody was told.** `datingHeadline`
   was ported to the runtime for all three surfaces and only the browser called it. MEASURED on
   korber over the wire at this check: the server's dating result carried `t_mrca 1938.77` with
   `ci_mrca [1938.77, 1938.77]` — `active_model` is `spline`, whose bootstrap never runs upstream —
   while the `/time` page shows **1893.91 [1850.90, 1916.79]**, the OLS fit. **Forty-five years
   apart on the flagship example, from the same run.** `honesty.headline` and `summary.headline` now
   carry `{key, active_model, departed, quotable, t_mrca, ci_mrca, refutation, clock_signal}` on
   every dating result, `record.t_mrca` is still there and still `active_model`'s, and the
   reproduction line gains the caveat naming both dates. `mcp/test/dating.test.js` asserts the block
   equals `datingHeadline(record)` field for field, so it cannot drift from the browser's rule.
2. **One honesty block said two opposite things about `p_perm`.** `download_notes` carried the
   runtime's `temporalPPermNote` ("a 1.0 does NOT mean untested — a tested candidate every shuffle
   beat scores (1 + B)/(B + 1) = 1.0 exactly; measured on H5N1 at B = 200, 399 of 566 rows read 1.0
   against 398 non-candidates") while `p_perm_fill`, two keys away, still said "a CANDIDATE whose
   null did not run carries NaN, never 1.0, so `not tested` and `not a sweep` stay distinguishable"
   and pointed at `sites.stage1`, a record key a CSV reader does not have. `p_perm_fill` is the
   runtime's note now, plus the only clause that is about the surface: which call serves the mask,
   and the one case the reference cannot reach (a DECLINED or STOPPED null leaves NaN at a candidate
   it never got to). `hyphaeon://methods/requirements` and the `/mcp` page's transcript carried the
   same false invitation and are corrected. The test that pinned the false sentence asserts the true
   one and additionally asserts the block no longer contradicts its own notes.
3. **`TEMPORAL_TAXON_CAPS` was keyed by four nicknames, of which one is a real surface string.**
   `provenance.surface` is `web-time`, `mcp-stdio`, `mcp-http` or `node-server`; the table said
   `browser | mcp | server | runtime`. Every non-browser lookup missed and fell through to the
   runtime default — to the RIGHT value, because all three are `null` today, which is why nothing
   failed and why it was worth fixing before one of them changes. The stamped strings are keys now
   and `runtime/test/temporal-port.test.js` asserts each resolves to its nickname's value.
4. **`e2e/server.spec.ts:639` pinned `download_notes.length` at 5 and the runtime returned 6.** This
   was the RED: `temporalDownloadNotes` gained the null's exchangeability assumption and a count
   pinned from the e2e pinned it in the wrong repository. The spec asserts what each note SAYS now —
   the FORMAT/CONTENT split, the duplicated curves column, the `p_perm` fill, what the null assumes,
   the wave-sign convention. `runtime/test/temporal-port.test.js` owns these notes and asserts
   them the same way, by CONTENT — it pins no count either, which is the right shape for a list
   whose length was never the contract. (One reviewer's hand-off says that file pins the number; it
   does not, and after this change nothing does.)
5. **Five Python citations had drifted, and one was load-bearing.** `dating.py:1917` is
   `boot_mu_rec.append(b_rec)`; the `la.lstsq(b_X, b_d, rcond=None)` that kills the spline bootstrap
   — the whole reason §8.2.1 exists — is **1912**, and the bare `except` that swallows it is
   1919-1920. Corrected in eight files and in `PHASE3-DATING.md`. Also: the bare-number header
   pattern is `temporal.py:209` (210 is `if m:`), `--no-tree` on the date subcommand is
   `cli.py:1898`, the date parser's flags run `cli.py:1895-1926`, and dating's `-s/--max-species` is
   `cli.py:1922`. The MECHANISMS were all verified correct against the read-only reference; only the
   numbers had moved.
6. **Two figures for one measurement.** `server/src/app.js` and `server/src/formats.js` quoted
   16,269,093 bytes for the `time_points: 2000` record where `server/src/time.js`'s measured table
   says 16,272,879. One number now. And `temporalDownloadNotes` is described as the runtime's own
   list rather than as "five mandatory sentences" in the two server files that counted it.

### 8.3 Driven over the wire at this check, not through a test

- **The `time_points` cap refuses at the door.** `POST /jobs` with `time_points` 999999 → 422
  `TEMPORAL_TIME_POINTS_EXCEEDED`, 2001 → the same, −3 and 2.5 → 422
  `TEMPORAL_TIME_POINTS_INVALID`; all four `kind: "input"`, each with a hint naming the bound and
  the reference's own default, and `details` carrying `time_points` and `grid_cells`. A legitimate
  large one still runs: T = 500 on H5N1_HA_geo → 202, completed, `inputs.size.grid_cells` 283,000,
  record 4,182,988 bytes — 8,366 bytes a grid point, which is the "about 8 KB a grid point" the
  refusal hint quotes.
- **The whole-record route agrees with the capability resource.** T = 600 → 4,988,493 bytes → 406
  `TEMPORAL_RECORD_TOO_LARGE`, whose `details.sections` is exactly the ten
  `caps.temporal.sections` the resource names and whose `details.files` is the reference's own four.
  All ten sections then answered 200 in the one envelope, the biggest (`curves`) 152,137 bytes
  against the MCP's 262,144 inline limit, and all four files served with a `Content-Disposition`.
  The one difference — the REST route serves a record below `TEMPORAL_RECORD_BYTES_MAX` where the
  MCP never returns one inline — is the deliberate one argued in `server/src/app.js`, and the 406
  points at the same two doors `record_never_inline` points at.

### 8.4 Corrections to §7

§7 is otherwise accurate. Three amendments: §7.2 item 4 (`p_perm` printed at B = 1,000 is Monte
Carlo noise) is now stated on every temporal result rather than only carried here, through
`honesty.permutations.grid_step`; §7.3 item 6 ("does a dating fit with no clock signal refuse, or
disclose?") is ANSWERED — it discloses, with `DATING_NO_CLOCK_SIGNAL` and
`datingHeadline().refutation`, because the reference prints the number and refusing would be a
divergence — but the ML team is still owed the sign-off on that reading; and `runtime/`, which §2
says was untouched by this phase, was touched by the review round (`dates/`, `dating/`, `temporal/`,
two new files), so the sentence "a number that is wrong here is wrong in the browser too" now cuts
both ways and the browser's own suites are the ones that hold it.
