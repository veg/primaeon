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
| `POST /api/v1/jobs` | `{analysis: "analyze" \| "meme" \| "busted" \| "epistasis" \| "dms" \| "phenotype" \| "evaluate", alignment, tree?, phenotype_file?, options?, seed?, names?}` → `202 {id}` |
| `GET /api/v1/jobs/:id`, `/events` | Status, progress `{phase, done, total, message}`, warnings, expiry, section states; SSE |
| `GET /api/v1/jobs/:id/result` | JSON with provenance; `?format=csv\|graphml`, `?fields=`, `?top=`, `?section=`, `?summary_only=1` |
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

| Module | Owns |
|---|---|
| `src/app.js` | Express app, routes, body limit, rate limits, same-origin rule, error bodies |
| `src/config.js` | Environment → configuration (`HYPHAEON_*`), PLAN.md 3.5 defaults |
| `src/jobs.js`, `src/db.js` | Job lifecycle: SQLite (`node:sqlite`) row + per-job directory, TTL sweep, timeout, live events |
| `src/pool.js`, `src/worker.js`, `src/runner.js` | Worker pool (`node:worker_threads`), the analysis dispatch on the runtime/engine |
| `src/validate.js`, `src/formats.js` | Diagnostics + caps; CSV/GraphML/fields/top shaping through the library writers and the MCP's `shapeResult` |
| `src/oauth.js` | The ceremony (discovery, DCR, PKCE, OOB page, refresh, revoke, bearer check) |
| `src/mcp-mount.js` | `/mcp`: origin check, rate limit, bearer, `mountHttp` on a pool-backed engine |
| `bin/hyphaeon-server.js` | Start, listen, clean shutdown |

Environment: `HYPHAEON_SERVER_PORT` (7040), `HYPHAEON_SERVER_ISSUER` (public origin; OAuth issuer and
the only allowed `Origin`), `HYPHAEON_MODELS_DIR`, `HYPHAEON_DATA_DIR` (`server/data`),
`HYPHAEON_SERVER_WORKERS` (1), `HYPHAEON_SERVER_THREADS` (2), `HYPHAEON_JOB_TTL_MS`,
`HYPHAEON_JOB_TIMEOUT_MS`, `HYPHAEON_RATE_{API,JOBS,MCP,OAUTH}`, `HYPHAEON_SERVER_EXTRA_ORIGINS`,
`HYPHAEON_TRUST_PROXY` (`loopback`), `HYPHAEON_MCP` / `HYPHAEON_MCP_AUTH` (never `0` on a public host),
`HYPHAEON_SERVER_LOG`.
