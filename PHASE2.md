# Phase 2 — one action, one report: epistasis and DMS in the browser, the Node server, the remote MCP

Phase 2 of the plan of record (`PLAN.md` §8: "epistasis and DMS in the browser + remote MCP") made
the product rule of §4.0 (D21) real: the only thing a user does is upload a dataset. The landing
page is the drop zone; dropping or pasting an alignment (with or without a tree), or picking one of
the five bundled examples, starts one run of everything, and one report fills in as the sections
arrive — diagnostics, sites (`meme`), gene (`busted`), epistasis + sectors, attribution, the
artifact filter, and last the digital DMS, progressive and cancellable, with the phenotype offer at
the end. The same orchestrator (`runtime/src/analyze.js` `runEverything`) runs in the browser's
analyze worker, in the gallery prebake, in the MCP's `hyphaeon_analyze`, and in the Node server's
`analyze` job, so the four surfaces produce the same record. The engine side of the phase
(`../HyphAeon` at tag `phase-2a`: the epistasis / sectors / DMS ports and the canonical MDS sign)
is described in `../HyphAeon/PHASE2A.md` and `../HyphAeon/MDS_SIGN.md`.

This page maps what exists, how each check runs and what it printed at integration, the parity
table against the Python CLI, the server and MCP status, and what is knowingly carried into
Phase 3. `PHASE1.md` is the previous map; the project notebook is `CLAUDE.md`.

## What exists

| Path | What it is |
|---|---|
| `runtime/src/analyze.js` | `runEverything` — the orchestrator contract every surface codes against: one `prepareRun` load, one session, PLAN §4.0 order (diagnostics → sites → gene → epistasis → attribution on the called sites → filter → DMS via a child `AbortController` → `phenotype: null`), `progress(phase, done, total, message)` over `parse, prepare, infer, stats, postprocess, gene, epistasis, attribute, filter, dms`, `onSection(name, payload, {final})` (DMS also fires `{final: false}` per slab). Optional sections fail into `{failed, error}` without taking the report down. Returns the `ReportRecord` (`schema_version: 2, kind: 'report'`). Also exports `geneFromPass` (the BUSTED head run on the `root_repr` the meme pass already returned — no site rescored), `calledSiteIndices`, `REPORT_DEFAULTS`, `SURROGATE_FOR`. |
| `runtime/src/epistasis.js` | `runEpistasis` over the library's phase-2a ports with `cmd_epistasis`'s thresholds (min_sim 0.30, min_shared 2, max_fdr 0.05, min_lrt 1.0, min_cesi 2.0, min_clique_size 3, min_coherence 0.50, seed 42). Takes the attention (`mean_root_attns`) and LRTs of the meme pass — the graph is never re-run for it — or a session for the reference's all-sites loop; the two give identical edges, sectors and coherence (`runtime/test/epistasis.test.js`). Browser B defaults to 1,000, CLI/parity B to 10,000; `permutations: {n, seed, rng, note}` records PHASE2A.md's Monte Carlo caveat. |
| `runtime/src/dms.js` | `runDms` over `runInsilicoSelectionDms`, slabbed one forward pass at a time, publishing the partial plasticity table after every batch, honouring an `AbortSignal` (cancel keeps what was computed), and refusing before any forward pass when `19·L·N²` exceeds `workBudget` (default 2.5e9) with `{skipped, reason, work, budget}`. |
| `runtime/src/report.js` | The `ReportRecord`, `setSection` / `addTiming` / `toReportRecord`, and `downloadsForReport` — the CLI's meme / busted / epistasis / dms JSON + CSV and the GraphML through the library writers (rebuilds the meme document from a stored section with no typed arrays; closes `PHASE1.md` gap 7). |
| `runtime/src/pipeline.js` | Two additive changes: `runMeme` accepts `options.prepared` (a `prepareRun()` result) and its result carries a non-enumerable `inference` (`lrt, siteIndices, batchSize, mean_root_attns, root_repr`) for the later phases. |
| `runtime/scripts/parity-node.mjs` | The `node` surface now also writes `<example>.epistasis.json` (B = 10,000, `parity.py`'s own default) and `<example>.dms.json` (Smc6 by default). |
| `web/src/lib/workers/analyze.worker.ts` | One worker for the whole orchestrator: manifest, hash-verified backbone + BUSTED head, `runEverything`, one `section` message per finished section (many for DMS). The interim runMeme+runBusted bridge was removed at integration. |
| `web/src/lib/report/` | `run.svelte.ts` (the live record in Svelte 5 `$state`, persisted to a new IndexedDB `reports` store on every final section, throttled for DMS; cancel and DMS-only cancel on the one `AbortSignal`), `load.ts` (live job → IndexedDB, v1 `runs` wrapped as `sections.sites` → `static/gallery/<name>.json` → server job over `GET /api/v1/jobs/<id>[/result]` + SSE `/events` with polling fallback), `status.ts`, `mcp.ts` (the `hyphaeon_analyze` snippet), `downloads.ts`, and the section components (`ReportView`, `Section`, `DataStrip`, `SitesSection`, `EpistasisSection`, `DmsSection`, `PhenotypeOffer`, `ProvenanceSection`, `RerunDisclosure`). |
| `web/src/lib/viz/` | New: `OverviewStrip`, `GeneCard` (p_ACAT, p_Simes, omnibus LRT, energy, significant counts; the neural fields and ω bars behind the nondeterminism note), `EpistasisNetwork` (d3-force SVG: node size LRT, edge width CESI, colour by sector), `PairTable`, `SectorPanel` (coherence track vs null mean / 95th / isotropic 1/K; `p_perm` with B, seed and the `3·√(p(1−p)/B)` half-width), `DmsHeatmap` (20 × L canvas with hover, plasticity track, per-site 19-Δ detail, progressive fill). Phase 1's Manhattan, ranked plots, site table, site tree, attribution and filter panels are reused. |
| `web/src/routes/` | `/` is the drop zone with five chips linking to `/report/gallery/<id>/`; `/report/[...id]/` (prerendered `local` + `gallery/<name>` shells); `/results/...` redirects to `/report/...`; `/gallery/` redirects to `/`; `/analyze/` keeps `?demo=<id>&autorun=1` and the refusal fallback; `/methods/` has one section per report section with caveats rendered from `web/caveats.json`; `/mcp/` has the install lines, the 12-tool table with `hyphaeon_analyze` first, and a transcript recorded against the real stdio server. Nav is Methods / Evaluate / MCP. |
| `web/caveats.json`, `web/scripts/check-caveats.mjs`, `web/src/lib/caveats/` | Every number the site quotes about the model, keyed by `model_version`, each with a source; validated at build against `models/manifest.json` (model_version, reference_version, taxon caps, PRNG, tensor names, variants, hash prefixes); typed lookups and a `<Caveats pillar=… />` component. |
| `web/scripts/prebake-gallery.mjs`, `web/static/gallery/` | The five README examples baked through `runEverything` under `onnxruntime-node` (general, cap 256, seed 42, B 1,000, DMS on with the default budget; camelid and HIV1_RT get HKY85 branch lengths from HyPhy WASM before the orchestrator). `index.json` is schema 3; each `<id>.json` is a `ReportRecord` v2 plus the page envelope. Tracked (7.8 MB: 6.4 MB records + 1.4 MB inputs). |
| `mcp/` 0.3.0 | `hyphaeon_epistasis` and `hyphaeon_dms` run in-process through `runEpistasis` / `runDms` (surface `mcp-stdio` / `mcp-http`); the new `hyphaeon_analyze` runs `runEverything` and returns the `ReportRecord` (always a job, waits up to `wait_seconds`, inlines the record at ≤ 256 KB, else summary + `job_id`); `get_results` gained `section=` and serves final sections while the job runs; resource `hyphaeon://report/{id}`; prompt `interpret-report`; `mountHttp(app, {path, authenticate})` for the server's OAuth middleware. `src/bridge.js` keeps only the phenotype argv table — the ONE bridged tool. |
| `server/` (`@veg/hyphaeon-server`, new workspace) | Express 5 implementing PLAN §3.5: `POST /api/v1/validate`, `POST /api/v1/jobs` → `202 {id}` (analyze / meme / busted / epistasis / dms / evaluate), `GET /jobs/:id`, SSE `/jobs/:id/events` (`status`, `progress`, `section` with progressive DMS, `done`), `GET /jobs/:id/result` (JSON + provenance; `?format=csv|graphml`; `?fields`/`?top`/`?summary_only`; `?section=`), `DELETE`, `/models`, `/health`, `/version`. Jobs run in a `worker_threads` pool with its own ONNX sessions; metadata in SQLite (`node:sqlite`), inputs/results per job directory, TTL 7 days, 10-min timeout, restart recovery. `src/oauth.js` ports Datamonkey's auto-approving OAuth 2.1 ceremony (discovery, DCR, PKCE S256, OOB redirect, refresh, revoke); `src/mcp-mount.js` mounts the MCP at `/mcp` behind it. |
| `deploy/` | Apache vhost (COOP/COEP, `.onnx`/`.wasm` MIME, `/api` + `/mcp` + OAuth proxied with SSE unbuffered), pm2 ecosystem, Dockerfile + docker-compose, `rsync-web.sh`, runbook. Nothing was deployed. |
| `e2e/` | `helpers.ts` (autorun driver, IndexedDB `reports` reader, epistasis comparator mirroring `parity.py`'s classes, browser parity-file writer), `smoke.spec.ts`, `gallery.spec.ts`, `report.spec.ts` (bat_oas1 and Smc6 report drives), `server.spec.ts` (spawns `server/bin` on a free port in 4260–4299, drives a job over SSE, the OAuth ceremony and `/mcp`). `analyze.spec.ts` (the Phase 1 form) is gone. |

## The report, section by section (PLAN §4.0 order)

| # | Section | Runs | What the page shows |
|---|---|---|---|
| 1 | Diagnostics | `diagnose()` + the automatic repairs; HyPhy WASM HKY85 when branch lengths are missing, NJ when there is no tree | The compact "what we did to your data" strip, expandable to the full warnings table |
| 2 | Sites (`meme` surrogate) | One forward pass over the variable sites | Manhattan with tiers and entropy overlays, ranked plot, site table, calls toggle, site tree; CSV / JSON |
| 3 | Gene (`busted` surrogate) | Statistics from the site LRTs + one head call on the pass's `root_repr` | Gene card: p_ACAT verdict, p_Simes, omnibus LRT, energy, significant counts; neural fields flagged nondeterministic |
| 4 | Epistasis + sectors | Graph math on the same pass's attention; the seeded permutation null (B = 1,000 in the browser) | Force network, pair table, sector panel with coherence vs null and `p_perm ± 3·√(p(1−p)/B)`; GraphML |
| 5 | Attribution | Re-scoring the non-consensus taxa at the called sites | Per-site attribution table |
| 6 | Filter | `cmd_meme --filter`'s two re-scoring passes | "N suspicious patches", masked / unmasked toggle that swaps the Sites rows |
| 7 | Digital DMS | 19·L forward passes, last, slabbed, cancellable, work-capped | 20 × L heatmap filling progressively, plasticity track, per-site detail, progress bar + Cancel; over budget → "offers the server" |
| 8 | Phenotype | Not run (needs a trait) | The offer panel (Phase 3) |

"Re-run with…" (variant, taxon cap, call mode, seed, reference sequence, permutations B, DMS on/off
+ budget) is one disclosure at the end of the report and starts a new report on the kept inputs.

## How to run each check, and what it printed at integration

From the repository root with `../HyphAeon` at `phase-2a` beside it, Node 22 (x64 under Rosetta on
this machine), and for the Python side a venv with `hyphaeon` installed editable:

```bash
export HYPHAEON_PY_BIN=<venv>/bin/hyphaeon
export HYPHAEON_WEIGHTS=$PWD/../HyphAeon/model.safetensors HF_HUB_OFFLINE=1
export HYPHAEON_MODELS_DIR=$PWD/../HyphAeon/models      # mcp and server tests
```

| # | Check | Command | Printed at integration |
|---|---|---|---|
| 1 | Install | `npm install` (root; `server` added to the workspaces, its standalone lockfile removed) | `added 21 packages, and audited 376 packages in 3s`; `node_modules/@veg/hyphaeon-server -> ../../server` beside runtime / web / mcp / e2e and `hyphaeon-js -> ../../../HyphAeon/js` |
| 2 | All workspaces | `npm test --workspaces --if-present` | runtime `Test Files 20 passed / Tests 274 passed` (7.95 s); web `10 passed / 65 passed`; mcp `9 passed / 93 passed` (with the env above — without `HYPHAEON_PY_BIN` the two phenotype bridge tests fail, or set `HYPHAEON_MCP_SKIP_BRIDGE=1`); server `5 passed / 52 passed` (13.2 s) |
| 3 | Runtime alone | `cd runtime && npx vitest run` | `20 passed / 274 passed`. Logs: `[analyze] bat_oas1 sites vs hyphaeon meme: max relative |ΔLRT| 2.41e-6`; `[analyze] Smc6: max relative |ΔLRT| 1.98e-6; p_acat 0.11797653 (ref 0.11797637); omnibus 3.2988615 (ref 3.2988663)`; `[epistasis] Smc6 edges: 5 identical pairs, worst float |Δ| 2.86e-6 (lrt_v@279-930)`; `[epistasis] sector 1 sites [244,279,461,557]: C 0.99133497 vs 0.99133497; p_perm 0.001 vs 0.001`; `sector 2 sites [685,930]: p_perm 0.08 vs 0.093 (|Δ| 0.0130 <= 0.0276)`; `[epistasis] Smc6 sector DMS: 6 sites, worst |Δ delta_lrt| 9.54e-6`; `[epistasis] bat_oas1 shared pass vs all-sites pass: 25 identical edges, worst float |Δ| 0.00e+0`; `[dms] bat_oas1_sites_lrt_ge_3.84_focal_default: 5 sites, worst |Δ| 1.76e-5 (K@273)`; `[dms] batch 19 vs 256 through ORT: worst |Δ delta_lrt| 9.54e-7`; `[parity-fixtures] bat_oas1 (canonical MDS signs, no alignment): max relative |dLRT| 2.41e-6 at site 273, 0/182 variable sites beyond 1e-5` |
| 4 | MCP alone | `cd mcp && npx vitest run` (env above) | `9 passed / 93 passed` (9.2 s). `[epistasis] Smc6 in-process: 3913 ms, 5 edges, 2 sectors, 6 plasticity records`; `worst per edge field: similarity 1.79e-7 abs; p_val 2.0e-11; fdr_q 5.6e-10; lrt_u 5.79e-7 rel; cesi 7.30e-7 rel`; `[dms] bat_oas1 … worst |delta| / LRT scale 1.32e-6`; `[analyze] bat_oas1 report: 7230 ms; status completed`; `streaming run: partial sites section observed while running = true`; `[bridge] hyphaeon_phenotype bat_oas1 through Python: 3911 ms`; `[engine] Smc6 busted vs reference: p_value_acat 1.6e-7, omnibus 4.8e-6; MDS max |dz| 1.40e-8` |
| 5 | Server alone | `cd server && HYPHAEON_MODELS_DIR=../../HyphAeon/models npx vitest run` | `5 passed / 52 passed` — analyze lifecycle on bat_oas1 over SSE with progressive DMS, `?format=csv` header `site,hyphaeon_lrt,p_value,q_value,is_invariable`, caps (1001 taxa → 422 `CAPS_EXCEEDED`, 8 MiB+ → 413), TTL sweep / orphans / timeout / `SERVER_RESTARTED`, the OAuth ceremony end to end, `/mcp` 401 with `WWW-Authenticate` |
| 6 | Web check + build | `cd web && npm run check && npm run build` | `svelte-check … 562 FILES 0 ERRORS 0 WARNINGS`; prebuild `[copy-assets] ort 2 files (13.3 MB), models 4 files (16.7 MB), hyphy 3 files (6.4 MB)`; `[prebake-gallery] bat_oas1 / Smc6 / camelid / HIV1_RT / RHO: up to date; reusing … index: wrote … (5/5 entries with reports)`; `[check-caveats] ok — v1: 19 caveats, 5 tables`; `✓ built in 5.69s … Wrote site to "build" ✔ done`; `build/report/{local,gallery/{bat_oas1,camelid,HIV1_RT,RHO,Smc6}}` emitted; `web/build` 71 MB |
| 7 | e2e | `cd e2e && npx playwright test --reporter=list` (after 6; port 4173 free; the server spec picks a free port in 4260–4299) | `37 passed (15.4s)`, `EXIT 0` — gallery (5): five chips, `/report/gallery/Smc6/` renders every section from the prebaked record with no heavy asset, `/gallery/` → `/`, `/results/gallery/Smc6/` → `/report/gallery/Smc6/`, prebaked Smc6 epistasis vs the CLI fixture; report bat_oas1 (12, serial): autorun → `/report/local/?id=`, Sites / Gene / Epistasis stream in with their stored values, DMS progress then done/cancelled, stored record (`surface: browser`, `model_variant: general`, `crossOriginIsolated`, ≥ 2 ORT threads, `distance_rescaled`, `tree_source: user`), exactly `general.onnx` + `busted_head.onnx` and only `ort-wasm-simd-threaded.{wasm,mjs}`, reload from IndexedDB without a model fetch, invariable flags exact vs Python, LRTs within the graph class vs Python (strict; the Phase 1 `test.fail` is gone) and vs node, `parity/browser` + `parity/web` bat_oas1.meme.json written, "Re-run with…" viral → a second report with `model_variant: viral` and `viral.onnx` fetched, original untouched; report Smc6 (4, serial): epistasis final while the DMS runs and Cancel scoped to the scan, browser edges / sectors vs the CLI at B = 1,000, `parity/browser/Smc6.epistasis.json` written, mid-run reload → `interrupted` with the finished sections kept; server (7): health / version / models, `POST /jobs` analyze → 202 hex32, SSE status → runtime phases → progressive DMS sections → done (9.0 s), result schema 2 with node-server provenance and CSV header, LRTs vs Python at the graph class, OAuth register → authorize (PKCE) → token → `/mcp` `tools/list`, DELETE → 404; smoke (10): drop zone without the surrogate caveat, nav Methods / Evaluate / MCP, same-origin and no model / ORT / HyPhy bytes on `/`, COOP/COEP on six routes, `/methods/` and `/mcp/` content |
| 8 | Parity, node surface | `node runtime/scripts/parity-node.mjs --examples all --analyses meme,busted,epistasis,dms --busted-examples all --dms-examples Smc6 --threads 6` | `wrote 16 file(s) to ../HyphAeon/parity/node; 0 failed`. Smc6 meme 0.1 s / busted 0.1 s / epistasis 1.3 s (B = 10,000) / dms 11.6 s; bat_oas1 epistasis 0.8 s; camelid 7.0 s; HIV1_RT 50.6 s; RHO 61.2 s (655 taxa, dense MDS vs the reference's Lanczos) |
| 9 | Parity, harness | `cd ../HyphAeon && python scripts/parity.py --examples all --surfaces python,node,web` (the e2e writes the browser files into `parity/browser/` and `parity/web/`; `parity.py` knows `web`, not `browser`) | `reference runs: 15 (0 failed); self-check violations: 0; comparisons: 17; missing: 13; violations: 1073 … FAIL` (exit 1, by its own conventions — the table below re-evaluates at PLAN §5.4's classes: node passes on Smc6, bat_oas1 and RHO for meme, busted and epistasis; browser passes bat_oas1 meme and Smc6 epistasis exact/graph fields; camelid and HIV1_RT informational) |
| 10 | Hygiene | `git status --short --untracked-files=all` | 138 entries, 33 untracked paths, none under `node_modules`, `build`, `.svelte-kit`, `web/static/{ort,models,wasm,_headers}`, `test-results`, `playwright-report`, `server/data`; one lockfile (root, regenerated); tracked binaries: `runtime/vendor/hyphy/2.5.98/` 6.4 MB, `web/static/gallery/` 7.8 MB (inputs 1.4 MB; records bat_oas1 0.66 MB, Smc6 1.91 MB, camelid 0.61 MB, HIV1_RT 1.45 MB, RHO 1.74 MB; `index.json` 16 KB); `git ls-files -co` grep for attribution strings hits only product references (`claude mcp add`, the claude.ai connector, the `CLAUDE.md` filename) |

## Parity table

`parity.py` compares each surface file against the reference CLI's output on the same inputs.
Its conventions have not moved since Phase 1 (engine repository, `PHASE1.md` gap 2): `TOL_GRAPH`
is 1e-6 absolute where PLAN §5.4's measured class for anything that went through the graph is
1e-5·max(1, |lrt|); the BUSTED neural-head fields are compared although the reference draws them
unseeded; and the epistasis edge `fdr_q` / `p_hyper` are compared at 1e-9 across inputs that differ
at the graph class. So `parity.py` prints `FAIL` by construction, and the table below re-evaluates
every violation at PLAN §5.4's classes from the same files (a scratch re-evaluation script over `parity/report.json` and the surface files; Phase 1 used the same method). What
changed with the canonical MDS sign (`MDS_SIGN.md`): bat_oas1 and RHO now reproduce `hyphaeon meme`
at the graph class on every surface, where Phase 1 had them at 1e-2 relative.

Reading: on Smc6, bat_oas1 and RHO every LRT-bearing field of `meme`, `busted` (statistics) and `epistasis` is inside PLAN §5.4's graph class on the node surface, p/q are exact given the LRT, edges and sectors are exact and `p_perm` and the null moments pass at B = 10,000; the browser reproduces the node surface (bat_oas1 LRT max |Δ| 1.29e-5 vs the reference, 0/351 beyond the class; Smc6 epistasis 5 edges / 2 sectors exact). camelid and HIV1_RT fail at the class on every surface for one cause — the HyPhy WASM 2.5.98 HKY85 branch lengths against the fixtures' native 2.5.65 (`PHASE1.md` gap 3; camelid median rel. 1.1e-5, HIV1_RT 4.7e-4, ρ ≥ 0.99998) — and are informational until D22 removes HyPhy from the product. The `parity.py` column counts its own violations (1e-6 absolute on LRTs, the unseeded head fields, `fdr_q` across non-identical inputs).

| Surface | Example | Analysis | parity.py | PLAN §5.4 | Detail |
| node | HIV1_RT | meme | fail (151) | FAIL: hyphaeon_lrt 149/335 | LRT: 149/335 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 2.88e-02; median rel. 4.7e-04; ρ 0.999983; p/q exact given the LRT |
| node | HIV1_RT | busted | fail (10) | FAIL: omnibus_lrt max \|Δ\| 0.0935; total_selection_energy max \|Δ\| 0.109; p_value_simes (derived, 1/1, max \|Δ\| 4.545909127932728e-05) | sig counts exact; omnibus \|Δ\| 9.35e-02; energy 1.09e-01; p_ACAT 3.59e-07; p_Simes 4.55e-05; neural head fields excluded (unseeded upstream) |
| node | HIV1_RT | epistasis | fail (179) | FAIL: lrt_u max \|Δ\| 0.00839; lrt_v max \|Δ\| 0.0116; similarity (tolerance, 26/26, max \|Δ\| 0.004772365093231201); cesi max \|Δ\| 0.0233; sectors sector_id order (exact, 1/6, max \|Δ\| None); mean_lrt max \|Δ\| 0.00614; spectral_coherence (tolerance, 6/6, max \|Δ\| 0.0008029341697692871); baseline_lrt max \|Δ\| 0.0116; intrinsic_plasticity max \|Δ\| 0.00983; p_value (derived, 18/22, max \|Δ\| 0.00019816512277362475) | 26 edges, 6 sectors exact; worst rel. LRT-field \|Δ\| 2.62e-01; statistical violations 0; p_perm max \|Δ\| 0.0028 |
| node | RHO | meme | fail (63) | **pass** | LRT: 0/349 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 2.19e-05; median rel. 3.9e-07; ρ 1.000000; p/q exact given the LRT |
| node | RHO | busted | fail (7) | **pass** | sig counts exact; omnibus \|Δ\| 7.63e-06; energy 0.00e+00; p_ACAT 1.04e-08; p_Simes 1.46e-07; neural head fields excluded (unseeded upstream) |
| node | RHO | epistasis | fail (110) | **pass** | 41 edges, 7 sectors exact; worst rel. LRT-field \|Δ\| 1.86e-06; statistical violations 0; p_perm max \|Δ\| 0.0069 |
| node | Smc6 | meme | fail (18) | **pass** | LRT: 0/1097 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 7.63e-06; median rel. 2.1e-07; ρ 1.000000; p/q exact given the LRT |
| node | Smc6 | busted | fail (8) | **pass** | sig counts exact; omnibus \|Δ\| 4.77e-06; energy 2.29e-05; p_ACAT 1.61e-07; p_Simes 0.00e+00; neural head fields excluded (unseeded upstream) |
| node | Smc6 | epistasis | fail (12) | **pass** | 5 edges, 2 sectors exact; worst rel. LRT-field \|Δ\| 7.30e-07; statistical violations 0; p_perm max \|Δ\| 0.0007 |
| node | bat_oas1 | meme | fail (33) | **pass** | LRT: 0/351 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 1.34e-05; median rel. 2.4e-07; ρ 1.000000; p/q exact given the LRT |
| node | bat_oas1 | busted | fail (7) | **pass** | sig counts exact; omnibus \|Δ\| 7.15e-06; energy 0.00e+00; p_ACAT 3.54e-08; p_Simes 3.33e-16; neural head fields excluded (unseeded upstream) |
| node | bat_oas1 | epistasis | fail (86) | **pass** | 25 edges, 4 sectors exact; worst rel. LRT-field \|Δ\| 2.41e-06; statistical violations 0; p_perm max \|Δ\| 0.0025 |
| node | camelid | meme | fail (81) | FAIL: hyphaeon_lrt 44/96 | LRT: 44/96 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 1.65e-04; median rel. 1.1e-05; ρ 1.000000; p/q exact given the LRT |
| node | camelid | busted | fail (10) | FAIL: omnibus_lrt max \|Δ\| 0.000359; total_selection_energy max \|Δ\| 0.000809; p_value_simes (derived, 1/1, max \|Δ\| 6.067616196953063e-06) | sig counts exact; omnibus \|Δ\| 3.59e-04; energy 8.09e-04; p_ACAT 2.90e-07; p_Simes 6.07e-06; neural head fields excluded (unseeded upstream) |
| node | camelid | epistasis | fail (257) | FAIL: lrt_u max \|Δ\| 0.000165; lrt_v max \|Δ\| 0.000165; similarity (tolerance, 47/61, max \|Δ\| 9.566545486450195e-06); cesi max \|Δ\| 0.000102; mean_lrt max \|Δ\| 0.000103; baseline_lrt max \|Δ\| 0.000165; intrinsic_plasticity max \|Δ\| 3.09e-05 | 61 edges, 3 sectors exact; worst rel. LRT-field \|Δ\| 3.79e-05; statistical violations 0; p_perm max \|Δ\| 0.0015 |
| web | Smc6 | epistasis | fail (11) | FAIL: null_coherence_std (statistical, 1/2, max \|Δ\| 0.003735870122909546); plasticity site order (exact, 1/6, max \|Δ\| None) | 5 edges, 2 sectors exact; worst rel. LRT-field \|Δ\| 7.22e-07; statistical violations 1; p_perm max \|Δ\| 0.0004 |
| web | bat_oas1 | meme | fail (30) | **pass** | LRT: 0/351 sites beyond 1e-5·max(1,\|lrt\|); max \|Δ\| 1.29e-05; median rel. 2.4e-07; ρ 1.000000; p/q exact given the LRT |

The browser (`web`) surface has files for bat_oas1 `meme` and Smc6 `epistasis` only (the two the e2e writes); `parity.py` reports the other 13 web comparisons as `missing` (not counted as violations). The Smc6 browser epistasis file is at B = 1,000 (the report's default) against a reference at B = 10,000: `p_perm` passes the bound at either B (max |Δ| 0.0004; `parity.py --n-permutations 1000` gives the same two residuals); `null_coherence_std` differs by 3.2 % on sector 1 (0.1137 vs 0.1174), the estimator's own Monte Carlo error at B = 1,000 (PHASE2A.md measures ≈ 2.2 % standard error per side, and the browser value equals the Node value bit for bit under the same seed); and `selection_dms_plasticity` is empty because the report's epistasis section does not run the per-sector DMS (the whole-alignment DMS section covers those sites) — `parity.py` counts that as 1/6 `plasticity site order`. Both are documented, not defects.

## Server and MCP status

- **Server** (`server/`, port 7040 by default): all of PLAN §3.5 is implemented and tested, jobs
  run in a warm `worker_threads` pool with their own sessions, and the e2e drives the real binary:
  `POST /api/v1/jobs {analysis: 'analyze'}` on bat_oas1 → 202 → SSE `status … progress … section
  (dms, final: false) … done` → `GET /result` is a `ReportRecord` with `provenance.surface:
  "node-server"` whose LRTs match the Python reference at the graph class. Not deployed: `deploy/`
  holds the Apache / pm2 / Docker / rsync files with placeholders (`hyphaeon.example.org`,
  `/var/www/hyphaeon`, the silverback host).
- **MCP over HTTP**: `@veg/hyphaeon-mcp`'s `mountHttp` is mounted at `/mcp` behind
  `oauth.requireBearer`; register → authorize (PKCE, auto-approved, OOB page for headless clients)
  → token → `initialize` + `tools/list` (12 tools, `hyphaeon_analyze` first) + `tools/call` pass in
  `server/test/oauth.test.js` and `e2e/server.spec.ts`; `POST /mcp` without a bearer answers 401
  with `WWW-Authenticate … resource_metadata`, RFC 8707 audience enforced. OAuth stores are
  in-memory (as Datamonkey's): a restart invalidates tokens and registered clients. Working as a
  claude.ai connector requires a public issuer (D1) — not exercised here.
- **MCP stdio** (`node mcp/bin/hyphaeon-mcp.js`): 12 tools, 8 prompts (incl. `interpret-report`),
  templates `hyphaeon://examples/{name}`, `hyphaeon://gallery/{name}`, `hyphaeon://report/{id}`;
  SIGTERM → exit 0. Only `hyphaeon_phenotype` still shells to the Python CLI.
- **Caveats**: `web/caveats.json` (validated) and `mcp/caveats.json` (served as
  `hyphaeon://caveats`, from Phase 0/1) agree on every number but are two files; the MCP copy still
  quotes the pre-export viral hash prefix and the model_eval README's "Mode I" phenotype wording.

## Integration changes (beyond wiring)

- Root `package.json` lists `server` in `workspaces`; `server/package.json` depends on
  `@veg/hyphaeon-js` `1.0.0`, `@veg/hyphaeon-mcp` `0.3.0` and `@veg/hyphaeon-runtime` `0.0.0` by
  version (the workspace rule in `CLAUDE.md`) instead of `file:`; its standalone
  `package-lock.json` / `node_modules` were removed and the root lockfile regenerated (express 5,
  express-rate-limit and supertest are the new packages).
- `web/src/lib/workers/analyze.worker.ts`: the interim runMeme+runBusted bridge (for a runtime
  without `runEverything`) was deleted; the worker imports `runEverything` directly and
  `AnalyzeResponse.orchestrator` is `'runtime'` only.
- `web/src/routes/report/[...id]/+page.svelte`: the load effect read the live job's `record.status`
  synchronously through `loadReport` (load.ts line 73), so Svelte tracked it and re-ran the effect —
  nulling `loaded`, reloading and **remounting the whole report** (Manhattan canvas, force network,
  heatmap) — on every progress tick. Measured with a MutationObserver on the Smc6 run: the
  `div.report` root was removed from the page every 20–40 ms, a 100 ms sampler fired 10 times in
  56 s, and the DMS took 56 s; with the load wrapped in `untrack()` there are no removals, the
  sampler runs at rate, and the same DMS finishes in 12.6 s. This was also why Playwright could
  never click "Cancel the scan" (the button was detached on every retry) and why the first e2e run
  took 8.1 min against 15 s now.
- `web/src/lib/report/RerunDisclosure.svelte`: the work-budget input had `min="1e6" step="1e8"`,
  a grid the default 2.5e9 is not on, so the browser's form validation refused the submit ("the two
  nearest valid values are 2.401e9 and 2.501e9") and "Re-run with…" never ran; `step="any"` (and
  `step="1"` on permutations B).
- `runtime/src/analyze.js` `runEverything` accepts `provenance` overrides as `runMeme` does, and the
  analyze worker passes the manifest's `model_version` / `model_variant` / `artifact_sha256` /
  `reference_version`: a browser session handle carries only the URL and the sha256, so the
  browser record's `provenance.model_variant` was `null` (a Node `createSession` handle is stamped).
- `e2e/helpers.ts` gained `formatCardP` (the gene card prints p at four decimals, the overview tile
  at three); the two report assertions that compared the card to the tile's format were the two
  failures in the e2e builder's first run, and are fixed with it.
- `mcp/src/resources.js`: the `hyphaeon://gallery` descriptions now say what the index (schema 3)
  and the records (`ReportRecord` v2) are; the code only passed entries through, so nothing else
  moved.
- `server/README.md`: install is the root `npm install`, not `npm install --no-workspaces`.

## Known gaps for Phase 3

1. **Phenotype (PhyloWAS) is the one unported pillar.** `sections.phenotype` is `null` on every
   surface; the report renders the offer (disabled picker) and `hyphaeon_phenotype` is the ONE tool
   that still shells to the Python CLI (`mcp/src/bridge.js`, argv table with `--seed` /
   `--mds-sign`). When `phenotype.py` is ported: delete `src/bridge.js`, move phenotype into
   `NATIVE_ANALYSES` in `mcp/src/caps.js`, fill `sections.phenotype` + a `SURROGATE_FOR` entry in
   `runtime/src/analyze.js`, add its download in `report.js`, and the trait UI (presets, tips on
   the tree, paste, CSV, continuous) of PLAN §4.5.
2. **Bridge removal and no Python anywhere** is Phase 3's exit criterion; today the Python path is
   reached only through `hyphaeon_phenotype` and the parity harness.
3. **HyPhy WASM is still the tree tool** (HKY85 branch lengths, NJ). D22 replaces it with the
   library's TN93 tree-free mode plus JS neighbour-joining for display and removes the vendored
   build; camelid and HIV1_RT parity is informational until then (WASM 2.5.98 vs the fixtures'
   native 2.5.65: max |Δ patristic| 3.7e-4 moves LRTs by up to 2e-2 relative).
4. **`parity.py` conventions** (engine repository): `TOL_GRAPH` 1e-6 absolute → PLAN §5.4's
   1e-5·max(1, |lrt|); skip the unseeded BUSTED head fields with a note; evaluate the epistasis
   edge `fdr_q` / `p_hyper` "given the surface's own inputs" as `p_value` / `q_value` already are;
   add a `dms` analysis (`parity/node/Smc6.dms.json` is written in the layout); accept `browser`
   as a surface name. With those, node and browser pass clean on Smc6, bat_oas1 and RHO today.
5. **Over-budget DMS does not yet hand off to the server.** `dms.skipped` carries `work`, `budget`
   and a reason, and the report page says so and names the server, but no action posts
   `POST /api/v1/jobs {analysis: 'analyze'}` and follows `/report/job:<id>`; the loader already
   reads server jobs.
6. **The report's taxon cap is one cap** (default 256, `Infinity` in the tests) shared by every
   pillar, where `hyphaeon busted` caps at 512 and `meme` / `epistasis` / `dms` cap at nothing. A
   caller reproducing a specific CLI invocation uses `runMeme` / `runBusted` / `runEpistasis` /
   `runDms` directly, as the MCP per-pillar tools and the parity runner do.
7. **`p_perm` in the browser is at B = 1,000** (±0.03 per side, PHASE2A.md), recorded in
   `permutations` and printed beside the value; "Re-run with…" and the MCP accept a larger B.
8. **`runEverything`'s DMS default sweeps the whole alignment**: ~80 s on Smc6 (1,097 codons)
   under `onnxruntime-node` at 6 threads and ~30 s in the browser; cancellable and work-capped but
   not bounded by default (`options.dms.maxSites` exists).
9. **Two caveat files** (`web/caveats.json` validated at build; `mcp/caveats.json` not) — make the
   MCP read the web copy, or move the file to the repository root.
10. **Gallery timings in `index.json`** were recorded on a contended machine (HIV1_RT 276.7 s vs
    121.2 s isolated); `HYPHAEON_PREBAKE=force node web/scripts/prebake-gallery.mjs` on a quiet
    machine restores them. Every edit under `runtime/src` changes the stamp and rebakes (~6–10 min)
    at the next build.
11. **Not exercised end to end in the browser**: the NJ (no-tree) path (the MCP's `hyphaeon_analyze`
    covers it under Node), gzip upload, RHO's embedded NEXUS tree, a mid-DMS reload on a large
    example (the `interrupted` state is unit-tested and driven on Smc6 only), camelid's HKY85 fit in
    the tree worker (Phase 1 covered it; Phase 2 dropped the spec for time).
12. **Delivery**: `_headers` still allows `https://unpkg.com` and the HyPhy glue needs
    `'unsafe-eval'` in a module worker (gone with D22); no woff2 vendored; no CI workflow;
    `@veg/hyphaeon-mcp` needs the npm publish of `@veg/hyphaeon-js@1.0.0`; `onnxruntime-node`
    stays pinned at 1.23.2; `node:sqlite` prints an `ExperimentalWarning` on Node 22 unless run
    with `--disable-warning=ExperimentalWarning` (the bin, pm2 and Docker do); the Apache CSP in
    `deploy/` and `web/static/_headers` are two files to reconcile.
13. **`PLAN.md` §3.6** should list `hyphaeon_analyze`, `get_results section=` and
    `hyphaeon://report/{id}`; §3.3 still quotes the pre-export viral hash `de765904…`.
