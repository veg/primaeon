# @veg/hyphaeon-server

<!--
WHY THIS FILE EXISTS. The package's front door: what the server is for, how to run and test it,
and where each concern lives. The deployment runbook is deploy/README.md; the plan of record for
the API is PLAN.md 3.5 and for the MCP mount 3.6.
-->

The HyphAeon Node server. The web app runs every analysis in the browser; this server exists for
the two things a browser cannot do: serve the MCP over streamable HTTP to remote clients (claude.ai,
Claude Code) behind the auto-approving OAuth ceremony, and run jobs above the browser's caps, on
the same `@veg/hyphaeon-runtime` under `onnxruntime-node`.

**Node and the model files are the whole dependency list.** Every pillar, phenotype association
included since Phase 3, is JavaScript in a worker thread; the server starts no subprocess, so the
host needs no Python, no `hyphaeon` CLI and no HyPhy (PLAN.md 8 phase 3, D16). **A tree is optional
on every route** (PLAN.md D22): one with branch lengths is used as it is, and otherwise the run
takes pairwise TN93 distances from the sequences — `provenance.preprocessing.tree_source` records
`user`, `embedded` or `tn93` on every result, and `POST /api/v1/validate` reports a missing tree as
`TREE_FREE_TN93` at info level rather than refusing it.

```bash
npm install                                          # at the repository root: server/ is a workspace
cd server
HYPHAEON_MODELS_DIR=../web/static/models npm start   # http://localhost:7040
HYPHAEON_MODELS_DIR=../../HyphAeon/models npm test
```

| Route | Purpose |
|---|---|
| `POST /api/v1/validate` | Library diagnostics (same codes as the browser) + this server's caps |
| `POST /api/v1/jobs` | `{analysis: "analyze" \| "meme" \| "busted" \| "epistasis" \| "dms" \| "phenotype" \| "evaluate" \| "dates" \| "dating" \| "temporal", alignment, tree?, phenotype_file?, dates_file?, options?, seed?, names?}` → `202 {id}` |
| `GET /api/v1/jobs/:id`, `/events` | Status, progress `{phase, done, total, message}`, warnings, expiry, section states; SSE |
| `GET /api/v1/jobs/:id/result` | JSON with provenance; `?format=csv\|graphml`, `?file=`, `?fields=`, `?top=`, `?section=`, `?sites=`, `?summary_only=1` |
| `POST /api/v1/jobs/:id/cancel` | Stop the run and KEEP what it produced (see **Time pillars** below) |
| `DELETE /api/v1/jobs/:id` | Early deletion (default: 7-day TTL) |
| `GET /api/v1/models`, `/health`, `/version` | Manifest + engine status; liveness; versions |
| `/.well-known/*`, `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1, ported from datamonkey-js-server |
| `POST/GET/DELETE /mcp` | The `@veg/hyphaeon-mcp` transport behind the bearer check |

`analysis: "analyze"` is the product's one action (PLAN.md 4.0): the runtime's `runEverything`
streams `sites → gene → epistasis → attribution → filter → dms` (progressive) into the job, and
`/result` returns the ReportRecord the report page renders. The per-pillar analyses run through the
MCP's in-process engine so a REST job and an MCP tool call produce the same bytes.

**Phenotype.** `analysis: "phenotype"` runs the pillar on its own; the trait is
`options.phenotype` (`preset`, `foreground`, `trait_col`, `species_col`, `continuous`,
`permulations`, `n_permutations`, `alpha`, `min_taxa`, `max_perm_p`, `seed`) plus the table's TEXT
as the `phenotype_file` field. The same block on an `analyze` job fills `sections.phenotype` from
the report's OWN forward pass (`provenance.phenotype_source: "report-pass"`), so it costs graph
maths and no inference; without it the section stays `null`, because a trait cannot be guessed.
Brownian-motion permulations need a phylogeny: a tree-free run skips them and says so in
`permulations.reason`.

## Time pillars (Phase 6)

Three analyses read a sampling date for every sequence and ask what changed over calendar time.
They share one date layer and one set of refusals with `hyphaeon_dates` / `hyphaeon_dating` /
`hyphaeon_temporal` on the MCP, so a REST job and a tool call refuse the same input for the same
reason with the same code.

**The date layer is a second input.** `dates_file` is the metadata document's TEXT in the request
body — a Nextstrain Auspice JSON, a name-to-date JSON object, or a CSV/TSV — never a server path,
under the same 8 MiB field cap as the alignment, written into the job directory as submitted and
recorded as `inputs.files.dates_file`. Omit it and the dates come from the FASTA headers, which is
the reference's own fallback. Its options are the CLI's: `date_source_kind`, `strain_col`,
`date_col`, `delimiter`, `date_pattern` (+`date_pattern_flags`), `time_units`, `archival_1959`,
`header_fallback`. `names.dates_file` is what the reproduction line prints as `-d <name>`.

| Analysis | What it runs | Cost, measured on this machine |
|---|---|---|
| `dates` | The review only. Which sequences carry a date, by which rule, what was imputed, which metadata rows named nothing, whether the set carries a clock. **No model, no graph** — it answers on a checkout with no `models/`. | korber (143 seqs): **215 ms** end to end, 35 KB result |
| `dating` | Root-to-tip molecular clock, t<sub>MRCA</sub> and interval, per-taxon residuals and outliers. **Takes no tree** (D34): always pairwise TN93 distances. `use_model: true` adds the `<variant>_taxa.onnx` pass and switches the estimator to `latent`. | H5N1 (98 × 566): **296 ms**. korber model-free **147 ms**; korber with `use_model` **8.3 s** at 4 threads |
| `temporal` | Per-site prevalence trajectories and sweep velocity through calendar time, a two-stage filter with a refining date-shuffling null, four fPCA wave modes, and a four-way classification against the static call. | H5N1 (98 × 566) at `time_points: 60`, `n_permutations: 200`: **3.1 s**, 632 KB result |

**Refusals happen at the door.** An unreadable metadata file, a date set with fewer than three
dated sequences or no time axis, and a bad `date_pattern` are a synchronous `422` with the date
layer's own code (`DATES_*`, `DATING_*`, `TEMPORAL_*` — all `kind: "input"`, each with a hint that
names the metadata fix), before a worker is spent. `POST /api/v1/validate` with the same
`alignment`, `dates_file` and `options` rehearses it and returns the review in a `dates` block.

**Two gates the browser puts to a human, and an HTTP job cannot.** `dating` and `temporal` refuse
until the caller answers them, and the answer is recorded in provenance:

- `DATES_BARE_NUMBER_MAJORITY` → `options.accept_bare_numbers: true`. When half or more of the
  dates were read as a bare number in the sequence name, that rule is claiming any number it finds.
  Measured on the bundled H1N1 set, forcing `time_units: "generations"` dates 100 of 100 sequences
  on an axis running from 1 to 46,241,654, with no error anywhere.
- `DATES_UNDATED_PRESENT` → `options.drop_undated: true`. Undated sequences are dropped silently by
  the pillars, so a run that did not say so answers about a different dataset (korber: 142 of 143).

`analysis: "dates"` never refuses for either — reporting them is its job — and returns them as
`gate.blocking[]`.

**A temporal job streams its null, and stopping it keeps the answer.** The null walks 200 → 500 →
1,000 draws in chunks; the `permutations` section is re-emitted per chunk with the achieved draw
count and the p-values at the stage-one candidates (a projection: the runtime's own interim payload
is the whole multi-megabyte record). `POST /jobs/:id/cancel` aborts the run and keeps what it
produced — the temporal pillar then **completes** with a truncated null and a `RUN_STOPPED_EARLY`
warning, because draw *b* is seeded from `splitmix64(seed, b)` and a run stopped at 313 draws is
bit-identical to one configured at 313. `DELETE` still removes everything.

Read `honesty` before reading any call column: `null_state` (`not-started | running | finished |
stopped`) is the only field that says whether a negative finding is a result, `p_perm` is the
reference's assumed 1.0 at every codon that never reached stage two, and the wave variance shares
move with the null. `provenance.reference_command` on these two pillars is a `{command, reproduces,
caveats}` **object**, not the argv array the other pillars carry, and `reproduces` is `false` on
every temporal run whose null drew at all.

**The grid is capped, and it is in the cost model.** `time_points` sets the size of the
`[codons × time_points]` trajectory store every stage after the model pass walks, and the caps'
`L·N²` work term is blind to it. Measured on H5N1 (566 × 98), one job at a time: the model pass is
5–9 s at every grid, smoothing plus waves is 0.6 s at 60 points, 10.5 s at 1,000 and **67.8 s at
2,000**, and a 5,000-point run never left `temporal-smooth` inside the 600 s job timeout; the stored
record grows linearly at about 8 KB a grid point (2,162,993 B at 250, 16,269,093 B at 2,000). So a
job is refused at the door, `422 {kind:"input"}`, for `time_points > 2000`
(`TEMPORAL_TIME_POINTS_EXCEEDED` — the ceiling `hyphaeon_temporal`'s own schema already enforces),
for `time_points < 2` (`TEMPORAL_TIME_POINTS_INVALID`) and for `codons × time_points > 1.2e6`
(`TEMPORAL_GRID_TOO_LARGE`). `POST /api/v1/validate` rehearses all three and reports
`summary.time_points` and `summary.grid_cells` either way.

**An option this server cannot name is refused, not dropped.** A key in `options` that is not an
option of the analysis is `422 {code:"UNKNOWN_OPTION"}` with the keys in `details` and the nearest
real key in the hint — `n_permutation` used to buy a 202 and a run at the 1,000-draw default. The
vocabulary is derived from the MCP tools' own input schemas (`src/options.js`), so an option the
runtime gains arrives here in the change that gives the tool its schema entry.

**Paging a temporal result.** The whole record is returned up to
`TEMPORAL_RECORD_BYTES_MAX` (4 MiB); above it the answer is `406 {code:"TEMPORAL_RECORD_TOO_LARGE"}`
naming the two doors below, because the document is read, parsed and re-serialised on the HTTP event
loop and its size is the caller's choice. (The MCP refuses whole-record delivery outright —
`caps.temporal.record_never_inline`, 8–27× its inline limit — for a reason that does not apply to an
HTTP client: a tool result is spent in a model's context window.)
`?section=summary|sites|curves|waves|permutations|dates|candidates|warnings|honesty|provenance`
pages it, `?sites=12,44,90` names codons for `sites` and `curves`, and
`?file=sites|curves|waves|summary` writes the reference's own four output files (never guarded: they
are streamed as text). `dating` offers `?file=json|csv` (the CLI's `-o` and `-c`; add
`?prediction_method=1` for this build's extra column). Byte-equal format is not reproducible
content — `honesty.download_notes` says why.

**One envelope for `?section=`, whatever the job's state.** Running and finished both answer
`{analysis, section, status, final, ...the section's own body}`, with `honesty` at the top level in
both — a client that reads `body.honesty` used to get `undefined` exactly while a run was in flight.
A report section shaped as another pillar carries that name as `section_analysis`.

| Module | Owns |
|---|---|
| `src/app.js` | Express app, routes, body limit, rate limits, same-origin rule, error bodies |
| `src/config.js` | Environment → configuration (`HYPHAEON_*`), PLAN.md 3.5 defaults |
| `src/jobs.js`, `src/db.js` | Job lifecycle: SQLite (`node:sqlite`) row + per-job directory, TTL sweep, timeout, live events |
| `src/pool.js`, `src/worker.js`, `src/runner.js` | Worker pool (`node:worker_threads`), the analysis dispatch on the runtime/engine |
| `src/validate.js`, `src/formats.js` | Diagnostics + caps + the temporal grid check + the date-layer door check; CSV/GraphML/file/fields/top shaping through the library writers and the MCP's `shapeResult`, and the one `?section=` envelope |
| `src/options.js` | The option vocabulary `POST /jobs` accepts, derived from the MCP tools' own input schemas, and the `UNKNOWN_OPTION` refusal |
| `src/time.js` | The date layer as an analysis, the temporal null's SSE projection, the reference output files. Resolves `mcp/src/time.js` beside the published `./engine` entry rather than copying its gate thresholds or its honesty clauses |
| `src/oauth.js` | The ceremony (discovery, DCR, PKCE, OOB page, refresh, revoke, bearer check) |
| `src/mcp-mount.js` | `/mcp`: origin check, rate limit, bearer, `mountHttp` on a pool-backed engine |
| `bin/hyphaeon-server.js` | Start, listen, clean shutdown |

Environment: `HYPHAEON_SERVER_PORT` (7040), `HYPHAEON_SERVER_ISSUER` (public origin; OAuth issuer and
the only allowed `Origin`), `HYPHAEON_MODELS_DIR`, `HYPHAEON_DATA_DIR` (`server/data`),
`HYPHAEON_SERVER_WORKERS` (1), `HYPHAEON_SERVER_THREADS` (2), `HYPHAEON_JOB_TTL_MS`,
`HYPHAEON_JOB_TIMEOUT_MS`, `HYPHAEON_RATE_{API,JOBS,MCP,OAUTH}`, `HYPHAEON_SERVER_EXTRA_ORIGINS`,
`HYPHAEON_TRUST_PROXY` (`loopback`), `HYPHAEON_MCP` / `HYPHAEON_MCP_AUTH` (never `0` on a public host),
`HYPHAEON_TEMPORAL_PERM_BUDGET` (1.0e12; see `src/config.js` for why it is not the browser's 5.0e10),
`HYPHAEON_SERVER_LOG`.
