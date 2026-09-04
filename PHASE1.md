# Phase 1 — site selection end to end, in the browser and over MCP

Phase 1 of the plan of record (`PLAN.md` §8: "client-side site selection + stdio MCP") turned the
Phase 0 scaffold into a product: an alignment goes in on `/analyze`, is checked by the library's
diagnostics and DM3's XGBoost prescreen, gets a tree fitted by HyPhy WebAssembly when it needs one,
is scored by the general or viral ONNX graph in a Web Worker on as many ORT threads as the
isolated origin allows, and comes out as a results page with the Manhattan plot, the ranked-site
plots, the sortable table, the per-site tree, CLI-byte-equal downloads and the MCP reproduction
snippet. The same runtime serves the five README examples prebaked at build time on `/gallery`,
and the MCP server runs `hyphaeon_meme`, `hyphaeon_busted` and `hyphaeon_evaluate` in-process
under `onnxruntime-node` while the three unported pillars stay on the Python bridge. The engine
side of the phase (`../HyphAeon` at tag `phase-1a`) is described in `../HyphAeon/PHASE1A.md`.

This page maps what exists, how each check runs and what it printed at integration, the parity
table against `hyphaeon meme` / `hyphaeon busted`, and what is knowingly carried into Phase 2.
The project notebook is `CLAUDE.md`.

## What exists

| Path | What it is |
|---|---|
| `runtime/src/pipeline.js` | `runMeme` rewritten over `@veg/hyphaeon-js` phase-1a, phase for phase with `cmd_meme`: `loadAlignmentAndTree` (with the `estimateTree` hook or the reference's "HyPhy not found" branch), variable-site-only ORT inference with pruned fetch lists, `memeSitePq` float32 p/q, `--filter` through `runAlignmentFilter {cliVariant: true}`, `--attribute` through `attributeSelection`, DM3's `zScore` / `percentile` / `call` columns beside the Python fields, PLAN §3.5 provenance with `diagnose()` warnings. |
| `runtime/src/busted.js`, `evaluate.js` | `runBusted` (library `runBusted` + `busted_head.onnx` with the all-false mask; neural fields flagged `deterministic_upstream: false`), `runEvaluate` (`evaluateFiles`). |
| `runtime/src/createSession.js`, `predict.js`, `results.js` | One session factory for Node and web (manifest → variant → sha256-verified backbone + lazy head, handles stamped for provenance); the `predict(c, a, meta)` callback glue and `inferSites` (inference.py's batch ladder); Python-byte-equal `meme`/`busted` JSON + CSV through the library writers, JSON-safe result records, `downloadsFor`. |
| `runtime/src/session-node.js`, `session-web.js` | `loadBustedHead` on both; `releaseSessions()` on Node (added at integration, see below). |
| `runtime/src/hyphy/` + `runtime/vendor/hyphy/2.5.98/` | HyPhy 2.5.98 WASM (DataMonkey 3's build, `PROVENANCE.md` with sha256s) driven in a browser worker or under Node: `createHyPhy({locateFile, glueStrategy, progress})` → `estimateBranchLengths` (axomeme3's HKY85 HBL verbatim), `njTree` (DM3's `NJ.bf` verbatim), `convertAlignment`, `hyphyVersion`, low-level `run`. Exported as `@veg/hyphaeon-runtime/hyphy`. `scripts/copy-assets.mjs` copies it into `web/static/wasm/hyphy/<version>/`. |
| `runtime/scripts/parity-node.mjs` | The `node` surface for `../HyphAeon/scripts/parity.py`: every example, `meme` and `busted`, written to `../HyphAeon/parity/node/`. |
| `web/src/lib/workers/` | Three module workers over one typed envelope (`protocol.ts`, `client.ts`, `serve.ts`): `prep.worker` (library `diagnose()` + prescreen), `tree.worker` (HyPhy WASM: HKY85 when `BRANCH_LENGTHS_MISSING`, NJ when `TREE_MISSING`), `infer.worker` (the whole `runMeme` with the session created inside it; threads = `hardwareConcurrency` capped at 16, honoured only when `crossOriginIsolated`). |
| `web/src/lib/analyze/`, `diagnostics/panel.ts`, `storage/results.ts` | Upload (drag/drop, paste, `.gz`, demo chips, `?demo=<id>`), the "Before you run" model (severity table, regime line, automatic variant suggestion, tree plan, cost estimate), `runAnalysis` with the six-step checklist, the `MemeRecord` conversion, IndexedDB persistence (`hyphaeon`/`runs`). |
| `web/src/lib/results/`, `web/src/lib/viz/`, `web/src/routes/results/[...id]/` | Record types and loader (gallery JSON or IndexedDB), per-mode row derivation (Top 5 % of variable sites / q ≤ 0.10 / Z-score), entropy, Fitch parsimony, MCP snippet, downloads; summary tiles, Manhattan canvas with codon/AA entropy overlays, Observable Plot ranked views, sortable table with AA spark bars, phylotree site-tree modal with substitution highlighting, provenance / filter / attribution panels. Prerendered as `/results/local/` (reads `?id=`) and `/results/gallery/<name>/`. |
| `web/scripts/prebake-gallery.mjs`, `web/static/gallery/` | The five README examples baked at build through the real `runMeme` under `onnxruntime-node` (general, cap 256, stamp-cached), shipped as `inputs/` (1.4 MB) and `<name>.json` (1.7 MB) with `index.json`; `/gallery` cards link to `/results/gallery/<name>/`. Both are tracked so a machine without `onnxruntime-node` can build with `HYPHAEON_PREBAKE=skip`. |
| `mcp/src/engine.js` (+ `models.js`, `tools.js`, `resources.js`, `validate.js`) | In-process engine: one memoised session per variant from `createSession`, CLI-shaped options mapped one to one, the runtime's HyPhy driver as the branch-length estimator, results serialised as `hyphaeon <cmd> -o` writes them with `provenance.surface = "mcp-stdio" \| "mcp-http"` and `reference_command`. `hyphaeon_validate` is the library's `diagnose()` plus this server's caps. Resources gained `hyphaeon://gallery` and `hyphaeon://gallery/{name}`. Epistasis, DMS and phenotype stay on `src/bridge.js` (`python-reference`). |
| `e2e/` | `helpers.ts`, `analyze.spec.ts`, `gallery.spec.ts`, `smoke.spec.ts`: 19 Playwright tests (below). |

Not yet present (Appendix A): `server/`, `deploy/`, `/jobs/[id]`, `web/caveats.json`, any CI workflow.

## How to run each check, and what it printed

From the repository root with `../HyphAeon` at `phase-1a` beside it, Node 22, and for the Python
side a venv with `hyphaeon` installed editable:

```bash
export HYPHAEON_PY_BIN=<venv>/bin/hyphaeon
export HYPHAEON_WEIGHTS=$PWD/../HyphAeon/model.safetensors HF_HUB_OFFLINE=1
```

| # | Check | Command | Printed at integration |
|---|---|---|---|
| 1 | Install | `npm install` | `added 2 packages, and audited 354 packages`; `node_modules/@veg/hyphaeon-js -> ../../../HyphAeon/js`, runtime/web/mcp/e2e linked |
| 2 | All workspaces | `npm test --workspaces --if-present` | runtime `Test Files 16 passed / Tests 235 passed`; web `8 passed / 50 passed`; mcp `5 passed / 63 passed \| 1 skipped` (the skip is the LRT graph-class clause, blocked upstream; without `HYPHAEON_PY_BIN` the two bridge tests fail — set it or `HYPHAEON_MCP_SKIP_BRIDGE=1`) |
| 3 | Runtime alone | `cd runtime && npx vitest run` | `16 passed / 235 passed`, 7.5 s. Logs: `[parity-fixtures] Smc6: max relative \|dLRT\| 1.49e-6 at site 720`; `bat_oas1 UNALIGNED MDS signs: max relative \|dLRT\| 8.42e-2, 181/182 variable sites beyond 1e-5`; `bat_oas1 (MDS signs aligned): 1.77e-6 at site 222`; `attribute_selection: max \|d delta_lrt\| 1.10e-5 over 6 sites`; `busted Smc6: p_acat 0.11831577 (ref 0.11831563), omnibus 3.2853990 (ref 3.2854052)`; `[hyphy] camelid HKY85 (WASM 2.5.98): 3386 ms, 421 branches, 348 > 0, 73 == 0` vs native 2.5.65 `max \|delta\| 3.68e-4 over 22366 pairs`; `[hyphy-browser] module worker NJ` / `classic worker HKY85 (18 taxa): 163 ms` |
| 4 | MCP alone | `cd mcp && npm test` (env above) | `5 passed / 63 passed \| 1 skipped`; `hyphaeon_meme` in-process on bat_oas1 answers with `mcp-stdio` provenance; p/q are `cmd_meme`'s float32 casts; busted statistical fields at class; evaluate at 1e-9; bridge runs epistasis through Python |
| 5 | Web build | `cd web && npm run build && npm run check` | `[copy-assets] ort 2 files (13.3 MB), models 4 files (16.7 MB), hyphy 3 files (6.4 MB) [2.5.98], headers (COOP/COEP added)`; `[prebake-gallery] Smc6…RHO: up to date; reusing … index: wrote … (5/5 entries with results)`; `✓ 1160 modules transformed … Wrote site to "build" ✔ done` with no Vite warning; `svelte-check … 520 FILES 0 ERRORS 0 WARNINGS`; `web/build` 66 MB (assets included) |
| 6 | e2e | `cd e2e && npx playwright test --reporter=list` (after 5; port 4173 free) | `19 passed (8.3 s)`: smoke (title, same-origin, no model/ORT on the landing route, COOP/COEP on `/`, `/analyze/`, `/gallery/`), gallery (five cards, `/results/gallery/Smc6/` renders from the prebaked JSON), bat_oas1 demo end to end (DISTANCE_RESCALED in the panel, six checklist steps, ORT threads engaged, Manhattan canvas, 15-page table, CSV header `site,hyphaeon_lrt,p_value,q_value,is_invariable`, exactly one `.onnx` and only `ort-wasm-simd-threaded.{wasm,mjs}` fetched, same-origin), the browser-vs-node graph-class parity, the MDS-sign envelope, the strict Python check declared `test.fail()` (flips to an unexpected pass when the library fix lands), the `parity/browser` + `parity/web` file write, and camelid's HKY85 fit in the HyPhy WASM tree worker (`tree_source: hyphy-hky85`) |
| 7 | MCP stdio smoke | `node mcp/bin/hyphaeon-mcp.js` driven over JSON-RPC (scratch script) | 11 tools, `list_models` reports the in-process engine (`web/static/models`, `onnxruntime-node`); `hyphaeon_meme` bat_oas1 in 300 ms with `provenance.surface: mcp-stdio`, top sites 273/329/332; `hyphaeon_busted` 150 ms; 38 resources incl. `hyphaeon://gallery/*`; SIGTERM → exit 0 at 1 and 4 threads (was SIGABRT, see integration changes) |
| 8 | Parity, node surface | `node runtime/scripts/parity-node.mjs --examples all --busted-examples all --threads 6` | `wrote 10 file(s) to ../HyphAeon/parity/node; 0 failed` (camelid / HIV1_RT with HKY85 from HyPhy WASM 2.5.98) |
| 9 | Parity, harness | `cd ../HyphAeon && python scripts/parity.py --examples all --surfaces python,node,web` | `reference runs: 10 (0 failed); self-check violations: 0; comparisons: 11; missing: 9; violations: 817; FAIL` — every violation is one of the three known causes in the table below; `parity.py` does not know a `browser` surface (its `KNOWN_SURFACES` are `python, node, web, mcp`), so the e2e writes the browser file to both `parity/browser/` and `parity/web/` |
| 10 | Hygiene | `git status --short --untracked-files=all` | 127 entries, none under `node_modules`, `build`, `.svelte-kit`, `web/static/{ort,models,wasm,_headers}`, `test-results`, `playwright-report`; one lockfile (root); tracked binaries: `runtime/vendor/hyphy/2.5.98/` 6.4 MB, `web/static/gallery/` 2.8 MB (inputs 1.4 MB, records 1.7 MB) |

## Parity table

`parity.py` compares each surface file against the reference CLI's output on the same inputs.
`TOL_GRAPH` in `parity.py` is still 1e-6 absolute; PLAN §5.4's measured class for the graph is
1e-5·max(1, |lrt|), and the column "PLAN class" below re-evaluates the LRT check at that bound
from the same files (`scratchpad/parity_table.py`). `p_value` / `q_value` are checked "given the
surface's own LRT" (PARITY.md) and pass at `max_abs 0.0` everywhere; `taxa_count`,
`codon_count`, site order and `is_invariable` are exact everywhere.

| Surface | Example | Analysis | `hyphaeon_lrt` at 1e-6 (parity.py) | LRT at PLAN class | max \|Δ\| | median rel. (variable sites) | Spearman (variable) | Cause |
|---|---|---|---|---|---|---|---|---|
| node | Smc6 | meme | 17 / 1097 | **0 / 1097** | 5.7e-6 | 2.4e-7 | 1.000000 | ORT vs torch fp32 (the class PLAN §5.4 records) |
| node | bat_oas1 | meme | 182 / 351 | 181 / 351 | 0.119 | 7.0e-3 | 0.999592 | MDS eigenvector signs (columns 1, 2) — library |
| web | bat_oas1 | meme | 182 / 351 | 181 / 351 | 0.119 | 7.0e-3 | 0.999592 | same; browser vs node agree at max \|Δ\| 5.25e-6 |
| node | RHO | meme | 145 / 349 | 145 / 349 | 0.260 | 1.2e-2 | 0.998984 | MDS signs (columns 2, 3); 655 taxa after pruning 55 duplicates on both sides |
| node | camelid | meme | 86 / 96 | 86 / 96 | 0.507 | 2.0e-2 | 0.998094 | HyPhy WASM 2.5.98 vs native 2.5.65 branch lengths (+ possible sign) — informational |
| node | HIV1_RT | meme | 151 / 335 | 147 / 335 | 0.043 | 7.8e-4 | 0.999976 | same — informational |

Busted, node surface (the head fields `selection_probability`, `predicted_gene_lrt`,
`synonymous_rate_variation`, `omega_3`, `proportion_*` violate on every example because the
reference loads the head unseeded — its Smc6 `selection_probability` was 0.995 in one run and
0.601 in the next — and are excluded from the columns below):

| Example | `sig_sites_p05/p10` (exact) | `omnibus_lrt` (L·1e-6) | `total_selection_energy` (L·1e-6) | `p_value_acat` (1e-6) | `p_value_simes` (1e-6) |
|---|---|---|---|---|---|
| Smc6 | pass | pass, \|Δ\| 6.2e-6 | pass, 3.1e-5 | pass, 1.3e-7 | pass, 0.0 |
| bat_oas1 | pass | 2.9e-2 | 0.216 | 4.6e-4 | 3.9e-3 |
| RHO | **1 / 1 differ** | 0.962 | 3.03 | 1.4e-5 | 3.1e-3 |
| camelid | pass | 1.11 | 3.21 | 1.8e-4 | 6.7e-3 |
| HIV1_RT | pass | 6.8e-2 | 9.9e-2 | 1.2e-5 | 3.3e-5 |

Reading: Smc6, where the library's MDS signs happen to agree with LAPACK's on all four columns,
reproduces `hyphaeon meme` and the `hyphaeon busted` statistics at the PLAN classes on every
surface. On the other examples the per-site LRT differs at the 1e-2 relative level (ranking
essentially unchanged, ρ ≥ 0.998) and everything downstream — p/q are bit-exact given the LRT,
but the omnibus sums, ACAT/Simes and RHO's significant-site counts inherit the shift.

## Integration changes (beyond wiring)

- **`runtime/package.json`** exports `./hyphy` (→ `src/hyphy/index.js`) and lists `vendor` in
  `files`; `web/src/lib/workers/tree.worker.ts` now imports `@veg/hyphaeon-runtime/hyphy` instead
  of reaching through the workspace by relative path.
- **`runtime/src/createSession.js`** holds the session-module specifier in a variable: the literal
  `import(/* @vite-ignore */ './session-node.js')` was followed by Rollup and pulled `node:crypto`
  into every browser bundle that imported the runtime's main entry. With that, the
  `hyphaeon:stub-node-session` plugin left `web/vite.config.ts` and `infer.worker.ts` imports
  `runMeme` and the manifest helpers from `@veg/hyphaeon-runtime` like every other module.
- **`web/src/routes/results/[...id]/+page.ts`** reads `static/gallery/index.json` for
  `entries()` through a variable-specifier `node:fs/promises` import, which removes the two Vite
  "externalized for browser compatibility" warnings the build printed.
- **`runtime/src/session-node.js` `releaseSessions()`** (+ a real-ORT test): releases every
  memoised `InferenceSession` and drops it from the memo. `mcp/src/engine.js` `close()` calls it,
  `server.js` / `http.js` release the engine they created (not one passed in), and
  `bin/hyphaeon-mcp.js` sets `process.exitCode` after `close()` instead of calling
  `process.exit(0)` with sessions alive. Measured before the change: SIGTERM to the stdio server
  after one `hyphaeon_meme` ended in `libc++abi: terminating … mutex lock failed: Invalid argument`
  (SIGABRT) at 1 and 4 threads; after it, exit 0 both ways. The MCP test suite also depends on
  this: releasing a handle without clearing the runtime's memo gave the next server a
  "Session already disposed" session.
- `web/static/gallery/_sample.json` (a fixture-derived sample nobody referenced once the real
  gallery records landed) removed. `web/tsconfig.json` keeps `checkJs: false` — with it on,
  `svelte-check` type-checks the linked JavaScript packages under strict and reports ~20 errors
  in `runtime/src` and the library, which run their own typecheck with `checkJs` off.
- Root `package-lock.json` regenerated for `mcp/`'s new dependencies (`@veg/hyphaeon-js`,
  `@veg/hyphaeon-runtime`, `onnxruntime-node` promoted from optional). No new packages beyond
  those the workspaces already carried.

## Known gaps for Phase 2

1. **LRT parity is blocked by MDS eigenvector signs in the library** (`../HyphAeon/js/src/preprocess/mds.js`,
   tred2/tql2, "parity up to a per-column sign"). `dataset.py` applies no convention either — it
   inherits LAPACK `ssyevd`'s — and the model is not sign-invariant (`mds_proj = nn.Linear(4, …)`
   on the raw coordinates). Measured: bat_oas1 columns 1, 2 flipped → max relative |ΔLRT| 8.4e-2;
   RHO columns 2, 3 → 6.0e-2; Smc6 all columns agree → 1.5e-6. Flipping the columns to the Python
   signs restores 1.8e-6 (`runtime/test/parity-fixtures.test.js` pins both facts). Fix upstream:
   reproduce LAPACK's sign behaviour in `mds.js`, or adopt a canonicalisation in the reference
   (e.g. largest-|entry| positive) and regenerate fixtures (PLAN §5.3 rule 3). Then: drop the
   `test.fail()` on the strict e2e parity test, the `ctxt.skip` in `mcp/test/engine.test.js`, and
   the "unaligned run differs" assertion in `runtime/test/parity-fixtures.test.js`.
2. **`parity.py` conventions** (engine repository): `TOL_GRAPH` 1e-6 absolute is unreachable for
   ORT vs torch (Smc6: 17 sites at up to 5.7e-6, PLAN §5.4 says 1e-5·max(1, |lrt|)); the neural
   BUSTED head fields should be skipped with a note until the checkpoint is completed upstream;
   `browser` is not a known surface name (the e2e writes `web` too).
3. **HyPhy WASM 2.5.98 vs native 2.5.65.** camelid's HKY85 tree differs by max |Δ patristic|
   3.7e-4 (73 zero-length branches on both), enough to move LRTs by 2e-2 relative; the fixtures
   for camelid and HIV1_RT were made with the native binary. Informational until the reference
   records the tree it used.
4. **Taxon caps differ by surface by design.** `runMeme` defaults to 256 (manifest
   `default_taxon_cap`), the gallery bakes HIV1_RT (476 taxa) and RHO (710) at 256, while
   `hyphaeon meme` applies no cap and the MCP mirrors the CLI (`max_species` unset = no cap for
   meme, 512 for busted). Consumers reproducing the CLI pass `maxSpecies: Infinity`.
5. **Not exercised end to end in the browser:** the NJ (no-tree) path, `--filter` / `--attribute`
   through `/analyze` (the runtime supports both; the worker passes them through and the runtime
   tests replay the fixtures), gzip upload, RHO's embedded NEXUS tree. TN93 tree-free mode is not
   implemented anywhere in-process (the MCP refuses it with an input error; the bridged tools pass
   it to the CLI).
6. **Two `cmd_meme` quirks pass through by design:** `--filter` with an embedded tree and ≥ 1
   masked artifact throws at the cleaned reload ("No tree specified", `cli.py:192`), and the
   cleaned re-score reuses the baseline tree cache. Upstream issues, documented in `pipeline.js`.
7. **The stored browser record does not carry `runMeme`'s `arrays`**, so downloads take the
   library-writer path over the CLI document instead of `results.js`'s runtime writers (same
   bytes for the same numbers; `memeDocument` would also need `taxa_count` / `runtime_sec` on the
   record). `runtime/src/callModes.js` has no q-value mode; the "q ≤ 0.10" toggle is app-side in
   `web/src/lib/results/derive.ts`.
8. **Local result links are `/results/local/?id=<uuid>`** (adapter-static, strict, no fallback);
   `/results/<uuid>/` renders in dev but 404s on the static host. A history list over
   `listResults()` and an Apache rewrite in `deploy/` are both open.
9. **The reference prunes tree tips without a sequence before HyPhy fits branch lengths;** the
   library has no Newick writer, so the MCP refuses such a tree with HyPhy's message and the
   browser hands the tree to HyPhy as given.
10. **Performance / calibration.** RHO (655 taxa) takes 18 s and HIV1_RT (475) ~25 s under
    `onnxruntime-node` at 6 threads on this x64/Rosetta Node; the panel's WASM cost constants
    (`web/src/lib/diagnostics/panel.ts`) come from three drives on one machine; the library's
    `COST_ESTIMATE` still uses the CPU-torch constant (PHASE1A gap 6). `SHALLOW_TREE` flags Smc6
    (the general model's own regime) and drives the viral suggestion.
11. **Delivery:** `_headers` is DM3's file plus COOP/COEP and still allows `https://unpkg.com`;
    the HyPhy glue in a module worker needs `'unsafe-eval'` (granted there); no woff2 vendored;
    no CI workflow; `@veg/hyphaeon-mcp` depends on `@veg/hyphaeon-js@1.0.0`, which resolves to
    the workspace link today and needs the npm publish before the MCP can be `npx`-installed;
    `onnxruntime-node` stays pinned at 1.23.2 (see `CLAUDE.md`).
12. **PLAN.md §3.3** still quotes the pre-export viral hash `de765904…`; the exported graphs are
    general `aa10e8e0…`, viral `c3ea5795…`.
