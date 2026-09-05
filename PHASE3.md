# Phase 3 — tree-free by default, phenotype in the browser, no Python and no HyPhy at runtime

Phase 3 of the plan of record (`PLAN.md` §8: "phenotype in the browser, tree-free TN93, bridge
gone") removed the last two things the product depended on that were not the product: **HyPhy**,
which existed only to fit branch lengths or build a tree when an upload lacked them, and **Python**,
which still answered one MCP tool. Both are gone from every surface.

What replaces them is the reference's own behaviour. A tree with usable branch lengths is used as
it is. No tree, or a tree without usable branch lengths, takes the library's tree-free path —
pairwise TN93 distances straight into the MDS, `hyphaeon --use-tn93` (D22) — and the run records
which of the two happened and why. A small app-side neighbour joining on the same distance matrix
(`runtime/src/nj.js`) gives the report a topology to DRAW; the model never sees it. The phenotype
pillar (PhyloWAS) runs in JavaScript in the browser worker, in the MCP process and in the server's
job pool, on the attention of the pass the report already made, with Brownian-motion permulations
when — and only when — the run has a real tree.

The consequence PLAN.md predicted, measured: **camelid and HIV1_RT now reproduce the reference at
PLAN §5.4's strict graph class**, on the node surface and in the browser. They were the two examples
Phases 1 and 2 could only report as informational, because the app fitted their branch lengths with
HyPhy 2.5.98 compiled to WebAssembly while the fixtures came from native HyPhy 2.5.65. Both sides
now compute the same TN93 matrix, and the gap closed by construction rather than by tolerance.

The engine side of the phase (`../HyphAeon` at tag `phase-3a`: `tn93.js`, `phenotype.js`,
`permulations.js`, the tree-free `loadAlignmentAndTree`) is described in `../HyphAeon/PHASE3A.md`.
`PHASE2.md` is the previous map; the project notebook is `CLAUDE.md`.

## What exists

| Path | What it is |
|---|---|
| `runtime/src/pipeline.js` | `decideTreePolicy` makes D22's decision in the app and `prepareRun` records it: `tree_source` is now `'user'` \| `'embedded'` \| `'tn93'`, beside `tree_provided`, `tree_free {reason, taxa_order}`, `tn93_saturated_pairs` and `display_tree_source`. `displayTreeFor` returns the display-only tree (`{newick, source, from, taxa}`). `options.estimateTree` is gone; `options.useTn93` forces the tree-free path (the reference's own flag) and `options.requireBranchLengths` is the only way to make a missing tree refuse. A tn93 exception (the package raises where `dataset.py` expects a sentinel) is rewritten into a sentence about the alignment. |
| `runtime/src/nj.js` | **New, app-side, not a mirror of any Python.** Saitou–Nei neighbour joining with the Studier–Keppler O(n³) formulation on the TN93 matrix, negative branch lengths clamped at 0 (and counted), plus an iterative Newick serialiser (`newickFromTree`, `njNewick`, `njTreeFromLoaded`). Display only: nothing in it reaches the model. |
| `runtime/src/phenotype.js` | **New.** `runPhenotype` runs the pillar over the library's `runPhenotypeAssociation` on the meme pass's own attention and LRTs, exactly as `runEpistasis` does, or over a session for the reference's all-sites loop. Returns `phenotype.py:624-646`'s 21 keys plus the app's `trait`, `permulations`, `sector_permutations`, `attention_source`, `thresholds`, `options` and `elapsed_sec`. Permulations are gated on a real tree: tree-free skips them with a reason and never substitutes the NJ tree. It replaces `mcp/src/bridge.js`. |
| `runtime/src/analyze.js` | `runEverything.phenotype` / `runPhenotypeForReport` fills `sections.phenotype` on demand from the report's own pass; `record.diagnostics` gained `tree_free` and `display_tree`; `SURROGATE_FOR` gained `phenotype`. The automatic run still leaves phenotype null — it needs a trait (PLAN §4.0 row 8). |
| `runtime/src/report.js` | `phenotypeDocument` / `phenotypeJsonText` / `phenotypeCsvText`; `downloadsForReport` adds `<stem>.phenotype.{json,csv}`; `REPORT_PHASES` ends with `phenotype`. |
| `runtime/scripts/parity-node.mjs` | Writes the tree-free runs to a suffixed surface directory (`parity/node-tn93/`), deleting the stale pre-D22 file in `parity/node/`, and records `tree_free` per run in `summary.json`; gained `--phenotype-examples` / `--phenotype-fg` / `--permulations`. |
| **Deleted** | `runtime/src/hyphy/` (driver + 4 HBL scripts), `runtime/vendor/hyphy/` (the tracked 6.4 MB WebAssembly build and its provenance), `runtime/test/hyphy*.test.js`, the `./hyphy` subpath export, `web/src/lib/workers/tree.worker.ts`, `web/src/lib/report/PhenotypeOffer.svelte`, `mcp/src/bridge.js`, `mcp/test/bridge.test.js`, and the copy-assets step that put HyPhy in `web/static/wasm/`. |
| `runtime/test/` | 22 files / 294 tests. New: `nj.test.js` (recovers an additive tree exactly; gets the textbook case right where the closest pair are not neighbours; clamps and counts negatives; 400 tips without recursion), `tree-free.test.js` (camelid and HIV1_RT through the real graph against the CLI's `--use-tn93` fixtures), `phenotype.test.js` (RHO against the reference document), `no-hyphy.test.js` (HyPhy stays removed: no mention in code with comments stripped, no directory, no export, no WebAssembly shipped, and camelid still produces a complete report). |
| `web/src/lib/report/PhenotypeSection.svelte` + `phenotype.svelte.ts`, `viz/PhenotypePlot.svelte`, `viz/PhenotypeGeneCard.svelte`, `viz/TreePicker.svelte` | The trait UI of PLAN §4.5: a preset (filtered to presets whose species actually match this report's taxa, with the count, resolved by the library itself), tips clicked on the display tree, a pasted list or pattern (with the warning that the reference reads a glob as a regex), or a trait CSV/TSV with column pickers and a continuous toggle; a live preview of the matched taxa and the library's own description sentence. Results: the association impulse plot with q ≤ α highlighted, the PARS signature, trait sectors through the existing `SectorPanel`, the gene card, the top-25 table in the reference's score order, JSON and CSV. Permulations are offered only when the report has a tree with branch lengths; otherwise the control is disabled and shows the runtime's reason. |
| `web/src/lib/report/displayTree.ts`, `viz/SiteTreeModal.svelte` | One place that answers "which tree may this page draw, and did the model see it": the site-tree modal and the foreground picker both take it, and both label a tree-free run's topology "display only, built from the TN93 distances". |
| `web/src/lib/workers/analyze.worker.ts` + `protocol.ts` | A second request kind, `phenotype`, on the SAME warm ORT session; `TreeRequest`/`TreeResponse` and the tree client are gone. |
| `web/src/lib/diagnostics/panel.ts` | `treePlan` returns `user` \| `embedded` \| `tree-free{reason, treeKeptForDisplay}` \| `none` from `TREE_FREE_TN93`; `saturatedPairs` reads `TN93_SATURATED_PAIRS`. The recoverable-refusal machinery is gone: nothing about a tree blocks a run any more, and only an uncomputable TN93 matrix does. |
| `web/caveats.json` | 24 caveats (was 19), five new from `phase3a`: `tree-free-tn93` (ρ = 0.9997 against tree-based, and the measured bit-identical matrices), `tn93-identical-sequences`, `tn93-saturation`, `phenotype-foreground-is-a-regex`, `permulations-need-a-tree`, plus a rewritten `phenotype-on-demand`. |
| `web/scripts/prebake-gallery.mjs` | The HyPhy fit is gone; the tree file is handed to `runEverything` as it is and `tree_source` / `tree_free` / `branch_length_method` are read back off the runtime's provenance. camelid and HIV1_RT now bake tree-free. |
| `mcp/` 0.4.0 | Every analysis tool is in-process. `hyphaeon_phenotype` runs `runPhenotype` with `cli.py cmd_phenotype`'s options (preset, foreground, background, inline `phenotype_file` text, trait_col, species_col, continuous, permulations, alpha, min_taxa, max_perm_p, seed, use_tn93, …); `hyphaeon_analyze` takes a trait block and fills `sections.phenotype` from the report's own forward pass (`provenance.phenotype_source: "report-pass"`). Every per-pillar tool now accepts an alignment with no tree, records `tree_source` / `tree_free.reason` / `tn93_saturated_pairs`, and writes `--use-tn93` into `reference_command` when the run was tree-free (the reference refuses a missing tree; only that flag reproduces it). `hyphaeon://methods/requirements` reports `requires_tree: false` on all seven pillars and `provenance.bridged.analyses: []`. |
| `server/` | `ANALYSES` gained `phenotype`; `phenotype_file` is a first-class job input; tree-less jobs succeed and `/validate` reports `TREE_FREE_TN93` at info; `estimateTree`, `poolEngine.capabilities` and `noBridge` are deleted. |
| `deploy/` | "What the host needs: Node and the model files. Nothing else." — an explicit "do not install Python, HyPhy or tn93" rule, tree-less and phenotype verification curls, `rsync-web.sh` checking for ORT WASM instead of HyPhy, and the bare `'unsafe-eval'` (which only the HyPhy glue in a module worker needed) dropped from the Apache CSP. |
| `e2e/` | 60 tests. New: `treefree.spec.ts` (camelid autorun → tree-free with the reason on the strip, parity against the `--use-tn93` fixture, `parity/browser/camelid.meme.json` written; Smc6 pasted with no tree → `no_tree`, the NJ display tree, the modal's display-only caption) and `phenotype.spec.ts` (gallery RHO → marine preset → Run → plot, PARS, gene card, table; a second run on the fixture's own foreground writes `parity/browser/RHO.phenotype.json`). `smoke.spec.ts` gained "HyPhy is gone (D22)": nothing named after it in the build, six deleted paths absent, the old URLs 404, no route requests one. |

## The report, section by section (PLAN §4.0 order)

Only rows 1 and 8 changed this phase.

| # | Section | Runs | What the page shows |
|---|---|---|---|
| 1 | Diagnostics | `diagnose()` + the automatic repairs; **the D22 tree decision** — a tree with branch lengths as given, otherwise TN93 distances, with a display-only NJ tree | The "what we did to your data" strip, which now names the tree path and its reason ("tree-free (TN93) — no branch lengths"), expandable to the full warnings table |
| 2 | Sites (`meme` surrogate) | One forward pass over the variable sites | Manhattan, ranked plot, site table, calls toggle, site tree (labelled display-only when the model saw distances); CSV / JSON |
| 3 | Gene (`busted` surrogate) | Statistics from the site LRTs + one head call | Gene card; neural fields flagged nondeterministic |
| 4 | Epistasis + sectors | Graph math on the same pass's attention | Network, pair table, sector panel; GraphML |
| 5 | Attribution | Re-scoring non-consensus taxa at called sites | Per-site attribution table |
| 6 | Filter | Two re-scoring passes | "N suspicious patches", masked / unmasked toggle |
| 7 | Digital DMS | 19·L forward passes, last, slabbed, cancellable, work-capped | Heatmap filling progressively, plasticity track, per-site detail |
| 8 | Phenotype | **Runs in the browser on demand**, on the same pass's attention: preset, tips on the tree, pasted list, or trait table; permulations when the run has a tree | Association impulse plot with q ≤ α, PARS signature, trait sectors, gene card, top sites, JSON / CSV |

## How to run each check, and what it printed at integration

From the repository root with `../HyphAeon` at `phase-3a` beside it and Node 22 (x64 under Rosetta
on this machine). **No Python variable is needed for anything but the parity harness**, which is the
whole point of the phase:

```bash
export HYPHAEON_MODELS_DIR=$PWD/../HyphAeon/models          # mcp and server tests
export HYPHAEON_WEIGHTS=$PWD/../HyphAeon/model.safetensors  # parity harness only
export HF_HUB_OFFLINE=1
```

| # | Check | Command | Printed at integration |
|---|---|---|---|
| 1 | Install | `npm install` (root; the runtime dropped its `vendor` files entry and its `./hyphy` export, and `mcp` went 0.3.0 → 0.4.0) | `up to date, audited 376 packages in 2s`. The lockfile regenerated to exactly two lines: `mcp` `"version": "0.3.0"` → `"0.4.0"` and `server`'s `"@veg/hyphaeon-mcp": "0.3.0"` → `"0.4.0"`. `@veg` links: hyphaeon-e2e, hyphaeon-js → `../../HyphAeon/js`, hyphaeon-mcp, hyphaeon-runtime, hyphaeon-server, hyphaeon-web |
| 2 | All workspaces | `HYPHAEON_MODELS_DIR=$PWD/../HyphAeon/models npm test --workspaces --if-present` | runtime `Test Files 22 passed (22)` / `Tests 294 passed (294)` (29.09 s); web `11 passed / 79 passed` (1.70 s); mcp `10 passed / 113 passed` (32.75 s); server `5 passed / 57 passed` (14.91 s). 1:22 wall, exit 0. **No Python variable was set for any of it** — Phase 2 needed `HYPHAEON_PY_BIN` or `HYPHAEON_MCP_SKIP_BRIDGE=1` here |
| 3 | The new runtime suites alone | `cd runtime && npx vitest run test/tree-free.test.js test/phenotype.test.js test/nj.test.js test/no-hyphy.test.js` | `4 passed / 32 passed` (27.15 s). `[tree-free] camelid meme vs hyphaeon meme --use-tn93: max relative \|ΔLRT\| 2.25e-6 at site 27; 0/96 sites beyond the class`; `[tree-free] HIV1_RT … 2.21e-6 at site 312; 0/335 sites beyond the class`; `[tree-free] Smc6 busted --use-tn93: p_acat 0.11763476796330352 (ref 0.11763468069456134); omnibus 3.3154969215393066 (ref 3.315500259399414)`; `[tree-free] Smc6 epistasis --use-tn93: 6 identical edges, worst float \|Δ\| 3.81e-6 (lrt_u@697-726)` (the tree run finds 5 edges and 2 sectors — the discriminator that the tree-free path was really taken); `[phenotype] RHO sites (145): hyphaeon_lrt 2.19e-5@325, association_rho 1.46e-7@24, p_value 3.28e-7@14 …`; `[phenotype] RHO sector 1 [ D83 - G101 - K195 - I259 - A292 - K325 ]: C 0.6355729699134827 vs 0.6355729699134827`; `[phenotype] Smc6 with its tree: 100 permulations, gene p = 0.48514851485148514`; `[phenotype] Smc6 tree-free: permulations skipped (tree-free); 97 sites on the parametric p` |
| 4 | Web typecheck | `cd web && npm run check` | `COMPLETED 571 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| 5 | Web build, full prebake | `cd web && HYPHAEON_PREBAKE=force npm run build` | 3:02 wall. `[copy-assets] ort: copied 2 files (13.3 MB)`, `models: copied 4 files (16.7 MB)`, `headers: wrote web/static/_headers (COOP/COEP + same-origin CSP)` — **no `hyphy` line, and no `web/static/wasm/`**; `[prebake-gallery] index: wrote … (5/5 entries with reports)`; `[check-caveats] ok — v1: 24 caveats, 5 tables`; `Wrote site to "build"`. New timings, DMS-complete, 8 threads: bat_oas1 3.07 s, Smc6 9.63 s, **camelid 19.23 s**, **HIV1_RT 70.03 s**, RHO 71.57 s. camelid and HIV1_RT log `tree tn93 (tn93)` where Phase 2 logged an HKY85 fit; their records changed numerically and are the two the parity table below now passes. A second `npm run build` after the source edits reused all five stamps in 7.8 s |
| 6 | e2e | `cd e2e && npx playwright test --reporter=list` | `60 passed (29.3s)`, `EXIT 0`; re-run after the parity-path fix (§ integration changes): `60 passed (27.2s)`, `EXIT 0`. Includes `smoke.spec.ts` "HyPhy is gone (D22)" (nothing named after it in `web/build`, six deleted paths absent, `/wasm/hyphy/2.5.98/*` → 404 on the served site, no route requests one), `treefree.spec.ts` (camelid tree-free + strict parity, Smc6 pasted with no tree → NJ display tree + the display-only caption), `phenotype.spec.ts` (RHO marine end to end, document shape against the reference), and the server's tree-less and phenotype jobs with the process started on an empty `PATH` |
| 7 | Parity, node surfaces | `node runtime/scripts/parity-node.mjs --examples all --analyses meme,busted,epistasis,dms,phenotype --busted-examples all --dms-examples Smc6 --phenotype-examples RHO --threads 6` | `wrote 17 file(s) to ../HyphAeon/parity/node; 0 failed` + `6 tree-free file(s) in …/parity/node-tn93 (HIV1_RT, camelid) — compare with fixtures/e2e/*_tn93.json, NOT with parity/python`, 2:28 wall. Each tree-free run also removed the stale pre-D22 file from `parity/node/`. camelid meme 0.9 s, HIV1_RT meme 6.9 s, RHO phenotype 9.0 s, RHO epistasis 55.3 s (B = 10,000) |
| 8 | Parity, harness | `cd ../HyphAeon && HYPHAEON_WEIGHTS=$PWD/model.safetensors HF_HUB_OFFLINE=1 python scripts/parity.py --examples all --surfaces python,node,web` | `reference runs: 15 (0 failed); self-check violations: 0; comparisons: 11; missing: 19; violations: 384 … FAIL` (exit 1 by its own conventions — see the table). `--surfaces python,node,browser` is refused: `[parity] unknown surface: browser (choose from python, node, web, mcp)` |
| 9 | The surfaces parity.py cannot express | scratch comparator over `parity/{node-tn93,browser-tn93}/*.meme.json` vs `fixtures/e2e/meme_*_tn93.json`, and `parity/{node,browser}/RHO.phenotype.json` vs `fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json` | camelid [node-tn93] **PASS**, HIV1_RT [node-tn93] **PASS**, camelid [browser-tn93] **PASS**, RHO phenotype [node] **pass** (see the table); RHO phenotype [browser] not comparable element-wise (256 taxa vs the fixture's 655) |
| 10 | No HyPhy, no bridge, no Python in code | greps over `runtime/src runtime/scripts web/src web/scripts mcp/src mcp/bin server/src server/bin scripts e2e deploy` | `hyphy` outside comments: **0** (the surviving comment hits are the removal notes and "HyPhy MEME / BUSTED", the real methods the surrogate stands for). `bridge` outside comments: **0** (`abridged` and "the statistical bridge" excluded). `HYPHAEON_PY_BIN`: **0** in the app; the only hits in the repository are the historical `PHASE0/1/2.md` records. `child_process` / `execFile` / `spawnSync` / `fork(` / `exec(` in `runtime/src web/src mcp/src mcp/bin server/src server/bin`: **0 process calls** (the hits are `RegExp.exec` and `node:sqlite`'s `db.exec`). `web/static/wasm` and `web/build/wasm`: **do not exist**; `.gitignore` and `web/.gitignore` no longer name `static/wasm` |
| 11 | MCP stdio, driven | `node mcp/bin/hyphaeon-mcp.js` over JSON-RPC (`HYPHAEON_MCP_THREADS=4`) | `serverInfo {"name":"hyphaeon","version":"0.4.0"}`; `hyphaeon_validate` 98 ms (`tree_source: "user"`, `tree_free: null`), `hyphaeon_meme` 344 ms, `hyphaeon_busted` 247 ms, `hyphaeon_phenotype` on a great-ape foreground with `permulations: 100` 1,037 ms → `permulations_count 100, gene_p_value_perm 0.48514851485148514`; SIGTERM → clean exit, no onnxruntime abort. This exchange is what `/mcp` now shows |
| 12 | Hygiene | `git status --short --untracked-files=all` | 130 entries, 19 untracked (this file included), none under `node_modules`, `build`, `.svelte-kit`, `web/static/{ort,models,_headers}`, `test-results`, `playwright-report`, `server/data`; one lockfile (root). The removals are staged as deletions: `runtime/src/hyphy/` (6 files), `runtime/vendor/hyphy/` (4, 6.4 MB), `runtime/test/hyphy*.test.js` (2), `mcp/src/bridge.js`, `mcp/test/bridge.test.js`, `web/src/lib/workers/tree.worker.ts`, `web/src/lib/report/PhenotypeOffer.svelte`. Tracked binaries are now `web/static/gallery/` alone: 7.9 MB — bat_oas1 0.70 MB, camelid 0.65 MB, HIV1_RT 1.51 MB, RHO 1.95 MB, Smc6 2.01 MB, `index.json` 15.8 KB, `inputs/` 1.4 MB |

## Parity table

`parity.py` compares each surface file against the reference CLI's output on the same inputs. Its
conventions have not moved since Phase 1 (`PHASE2.md` gap 4): `TOL_GRAPH` is 1e-6 **absolute** where
PLAN §5.4's measured class for anything that went through the graph is 1e-5·max(1, |lrt|); the
BUSTED neural-head fields are compared although the reference draws them **unseeded**; and the
epistasis `p`/`q` are held to 1e-9 across inputs that themselves differ at the graph class. So
`parity.py` prints `FAIL` by construction, and the table below re-evaluates every one of its
comparisons at PLAN §5.4's classes **from the same files** (a scratch comparator; Phases 1 and 2
used the same method).

D22 changed what "the same inputs" means for two examples. camelid's and HIV1_RT's `.nwk` files
carry a topology and no branch lengths, so those runs are now tree-free — a **different analysis of
the same data** from the reference run in `parity/python/`, which used the tree. Their counterpart
is the CLI's own `--use-tn93` fixture set, so the runner files them under `parity/node-tn93/` (and
the e2e under `parity/browser-tn93/`, changed at this integration), where `parity.py` reports them
as `missing` rather than comparing the wrong pair. **That is where the Phase 2 gap closes**, and
those two rows are the headline of this phase.

### Tree-free (D22): the two examples Phase 2 could not close

| Surface | Example | Analysis | Reference | PLAN §5.4 | Detail |
|---|---|---|---|---|---|
| node-tn93 | camelid | meme | `fixtures/e2e/meme_camelid_tn93.json` | **pass** | 212 taxa, 96 sites, order identical, `is_invariable` 0 mismatches; max \|ΔLRT\| 1.10e-05, max relative 2.25e-06, **0/96** sites beyond 1e-5·max(1, \|lrt\|); max \|Δp\| 3.58e-07, \|Δq\| 7.15e-07. Phase 2: **44/96 beyond the class**, max \|Δ\| 1.65e-04 |
| node-tn93 | HIV1_RT | meme | `fixtures/e2e/meme_HIV1_RT_tn93.json` | **pass** | 475 taxa, 335 sites; max \|ΔLRT\| 1.72e-05, max relative 2.21e-06, **0/335** beyond the class; max \|Δp\| 4.17e-07, \|Δq\| 2.26e-06. Phase 2: **149/335 beyond the class**, max \|Δ\| 2.88e-02 |
| browser-tn93 | camelid | meme | same fixture, through ORT WASM in Chromium | **pass** | 212 taxa, 96 sites; max \|ΔLRT\| 1.91e-05, max relative 1.86e-06, **0/96** beyond the class; max \|Δp\| 3.28e-07, \|Δq\| 2.38e-06 |
| runtime suite | Smc6 | busted `--use-tn93` | `fixtures/e2e/busted_Smc6_tn93.json` | **pass** | `p_acat 0.11763476796330352` (ref `0.11763468069456134`); `omnibus 3.3154969215393066` (ref `3.315500259399414`); `energy 84.96565246582031` (ref `84.96566772460938`); significant counts exact |
| runtime suite | Smc6 | epistasis `--use-tn93` | `fixtures/e2e/epistasis_Smc6_tn93.json` | **pass** | 6 identical edges and 3 sectors (the tree run gives 5 and 2 — proof the tree-free path was taken); worst float \|Δ\| 3.81e-06 (`lrt_u`@697-726); `p_perm` 0.001/0.001, 0.08 vs 0.093 (tol 0.0276), 0.107 vs 0.114 (tol 0.0302) |

### Phenotype, the newly live pillar

| Surface | Example | Reference | PLAN §5.4 | Detail |
|---|---|---|---|---|
| node | RHO (marine) | `fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json` | **pass** | The reference's 21 keys identical and in order; 145 site rows in the same score order, `site` / `ref_aa` / `derived_aa` 0 mismatches; **no field beyond the class** — worst per column `hyphaeon_lrt` 2.19e-05, `score` 6.93e-07, `q_value` 4.70e-07, `association_rho` 1.46e-07, `p_value` 3.28e-07, `attribution_norm` 5.22e-08, both frequency columns 0.00e+00; gene `spectral_energy` 1.94e-09, `score_track_a` 2.05e-06, `p_evd_length_adjusted` 2.76e-13; counts exact (22 significant, 128 pairs, 1 sector); the sector `[ D83 - G101 - K195 - I259 - A292 - K325 ]` with coherence equal to the last digit |
| browser | RHO (marine) | same | not comparable element-wise | The fixture was produced without `--max-species`, i.e. 655 taxa; the app's default cap is 256 (hard max 512), so the browser scored a Faith's-PD subsample: 124 of 145 sites shared, 17 called against 22. What IS asserted holds: the 21 keys present and in order, the reference's own trait description, `permulations_count` 0 with null permulation columns, and BH consistency. Closing this needs an uncapped surface, not a tolerance (gap 2) |

### Tree-based: `parity.py`'s own comparisons, re-evaluated

Every node comparison passes at PLAN §5.4. `parity.py`'s per-row violation counts are its 1e-6
absolute tolerance and, for `busted`, exactly the seven unseeded neural-head fields
(`predicted_gene_lrt`, `selection_probability`, `synonymous_rate_variation`, `rate_distributions.*`).

| Surface | Example | Analysis | parity.py | PLAN §5.4 | Worst residual at the class |
|---|---|---|---|---|---|
| node | Smc6 | meme | fail (18) | **pass** | 3,291 numeric pairs; `hyphaeon_lrt` 7.63e-06, `p_value` 3.58e-07, `q_value` 0.00e+00 |
| node | Smc6 | busted | fail (7) | **pass** | `total_selection_energy` 2.29e-05, `omnibus_lrt` 4.77e-06, `p_value_acat` 1.61e-07; the 7 are the neural head |
| node | Smc6 | epistasis | fail (12) | **pass** | 77 pairs; `lrt_v` 2.86e-06, `cesi` 2.15e-06, `lrt_u` 1.91e-06; edges and sectors exact |
| node | bat_oas1 | meme | fail (33) | **pass** | 1,053 pairs; `hyphaeon_lrt` 1.34e-05, `p_value` 4.47e-07 |
| node | bat_oas1 | busted | fail (7) | **pass** | `omnibus_lrt` 7.15e-06, `p_value_acat` 3.54e-08 |
| node | bat_oas1 | epistasis | fail (86) | **pass** | 319 pairs; `lrt_u` / `lrt_v` 1.34e-05, `cesi` 4.05e-06 |
| node | RHO | meme | fail (63) | **pass** | 1,047 pairs; `hyphaeon_lrt` 2.19e-05, `q_value` 1.39e-06 |
| node | RHO | busted | fail (7) | **pass** | `omnibus_lrt` 7.63e-06, `p_value_simes` 1.46e-07 |
| node | RHO | epistasis | fail (110) | **pass** | 528 pairs; `lrt_v` 2.19e-05, `lrt_u` 1.05e-05 |
| web | bat_oas1 | meme | fail (30) | **pass** | 1,053 pairs; `hyphaeon_lrt` 1.29e-05 — the browser reproduces the node surface |
| web | Smc6 | epistasis | fail (11) | FAIL: `null_coherence_std` | Every graph-class field passes (`lrt_u` / `lrt_v` 1.91e-06, `cesi` 1.67e-06) and edges / sectors are exact; the one residual is the Monte Carlo one `PHASE2.md` documented — the browser runs B = 1,000 against a reference at B = 10,000, and the null's standard deviation differs by 3.2 % (0.00374), the estimator's own error at that B |

`parity.py`'s totals for the run: `reference runs: 15 (0 failed); self-check violations: 0;
comparisons: 11; missing: 19; violations: 384 … FAIL`. The 19 missing are the six tree-free files
now under `node-tn93/` and `browser-tn93/` (correctly not compared against the tree reference) and
the thirteen browser files the e2e does not write.

## Server and MCP status

- **MCP stdio** (`node mcp/bin/hyphaeon-mcp.js`), 0.4.0: 12 tools, all seven analyses in-process,
  no subprocess of any kind. Driven for this report: `initialize` → `tools/list` (12) →
  `hyphaeon_validate` (98 ms) → `hyphaeon_meme` (344 ms) → `hyphaeon_busted` (247 ms) →
  `hyphaeon_phenotype` on a great-ape foreground with 100 permulations (1,037 ms, gene
  `p_perm` 0.485) → SIGTERM → clean exit. That transcript is what `/mcp` now shows.
- **MCP over HTTP** and the **server**: unchanged from Phase 2 except that `phenotype` is a job
  analysis, `phenotype_file` is a job input, and a job with no tree completes tree-free. The e2e
  drives all three against the real binary.
- **Nothing is deployed.** `deploy/` still holds placeholders (`hyphaeon.example.org`,
  `/var/www/hyphaeon`); what changed is that the runbook's host requirements are now Node and the
  model files alone.
- **Caveats**: `web/caveats.json` (24, validated at build against the manifest) and
  `mcp/caveats.json` (not validated) are still two files — `PHASE2.md` gap 9, carried.

## Integration changes (beyond wiring)

- **`mcp/src/engine.js` misclassified the runtime's TN93 refusal.** `prepareRun` now rewrites the
  `tn93` package's `ValueError` / `ZeroDivisionError` into a sentence about the alignment, and
  `INPUT_PATTERNS` did not match it, so an alignment with a saturated pair would have been reported
  as an internal server failure ("report it to the operator") rather than as the input problem it
  is. Added, with a case in `mcp/test/engine.test.js`.
- **`web/static/_headers` was still DataMonkey's file**, copied verbatim by `scripts/copy-assets.mjs`
  since Phase 0: it grants `https://unpkg.com` in `script-src`/`style-src`, `connect-src https:`
  and the bare `'unsafe-eval'` that only the HyPhy glue in a module worker ever needed. D22 removed
  the last consumer (`PHASE2.md` gap 12) and this app has never loaded from another origin, so the
  file is now authored by the script — same-origin CSP with `'wasm-unsafe-eval'` for ORT, matching
  `deploy/apache-hyphaeon.conf`, which the MCP/server builder had already tightened. `DATAMONKEY3_DIR`
  is no longer read.
- **The diagnostics panel promised a tree the runtime does not draw.** `treePlanText` said a
  supplied topology "is drawn in the report" when a tree-free run kept one for display, but
  `displayTreeFor` always returns the NJ tree on a tree-free run (a topology without branch lengths
  is not drawable as a phylogram). The e2e asserts `display_tree_source: 'nj'`; the sentence now
  says a neighbour-joining tree is drawn and the model sees neither topology. (PLAN.md D6's own
  wording, "its topology is kept only for display", has the same drift — noted as a gap below, since
  `PLAN.md` is not mine to edit.)
- **`web/src/routes/mcp/` was a Phase 1 page**: the tool table still marked epistasis, DMS and
  phenotype "Python bridge", `list_models` still offered to say "whether the Python bridge is
  reachable", and `HYPHAEON_PY_BIN` was documented as an environment variable. The table is now
  in-process for every analysis, the bridge paragraph is replaced by a statement that the bridge is
  deleted, and the transcript was **re-recorded against 0.4.0** with a fourth turn — the phenotype
  pillar with permulations — because that is the tool the bridge used to answer.
- **`.gitignore` and `web/.gitignore`** no longer ignore `web/static/wasm/`; nothing writes it.
- **`web/src/lib/gallery/types.ts`**: `BranchLengthMethod` dropped its permissive `(string & {})`
  escape hatch, which existed only because `copy-assets.mjs` still wrote the WebAssembly fit's name.

## Known gaps for Phase 4

1. **`parity.py` does not know the tree-free surfaces, and has no `phenotype` or `dms` comparator.**
   The files exist and are named for it: `parity/node-tn93/` (6), `parity/browser-tn93/` and
   `parity/web-tn93/` (1 each), `parity/{node,browser}/RHO.phenotype.json`, `parity/node/Smc6.dms.json`.
   A `node-tn93` / `web-tn93` surface pointed at `fixtures/e2e/*_tn93.json` instead of
   `parity/python/`, plus a phenotype comparator over `phenotype.py`'s 21 keys, would fold the whole
   of this phase's table into the harness. Both are the engine repository's (`../HyphAeon`,
   read-only here); the layout is documented in `runtime/scripts/parity-node.mjs`'s header, in
   `e2e/helpers.ts` `writeBrowserParityFile`, and per run in each `summary.json`. Carried with it:
   `TOL_GRAPH` 1e-6 absolute → 1e-5·max(1, |lrt|), skipping the unseeded BUSTED head fields, and
   evaluating the epistasis `fdr_q` / `p_hyper` "given the surface's own inputs" (`PHASE2.md` gap 4).
2. **The browser's phenotype run cannot be compared element-wise with the RHO fixture.** The fixture
   used all 655 taxa; the app caps at 256 by default (hard max 512, PLAN §4.2), so the browser scores
   a PD subsample — 124 of 145 sites, ρ(association_rho) 0.83 on the shared ones. The e2e asserts
   everything independent of the subsample and annotates the rest with the taxon counts; the
   comparator switches to element-wise automatically once a surface runs the same taxa. Closing it
   needs an uncapped browser path, not a tolerance.
3. **`PLAN.md` still carries the pre-D22 vocabulary.** §4.0 row 1 and §4.2 describe HyPhy branch-length
   estimation and an NJ tree "when there is no tree at all"; §3.5's `tree_source` list has
   `hyphy-hky85` and `nj`, where the recorded values are now `user | embedded | tn93` with `nj` only
   as `display_tree_source`; D6 says a topology-only tree's "topology is kept only for display",
   which `displayTreeFor` does not do (it draws the NJ tree, because a topology without lengths is
   not a phylogram — the app-side wording was corrected at this integration, the plan's was not);
   §3.6 still describes "bridge, then port" and D16's bridge as live; §5.1/§5.4 cite
   `dataset.py:443-521`. `PLAN.md` is not the integrator's to edit. `PHASE2.md` gaps 1–3 are closed.
4. **Permulation cost in the browser** (`PHASE3A.md` gap 4). The panel offers B up to 10,000 and the
   library allocates two L × B float64 matrices — about 56 MB at RHO's L = 349, in the analyze
   worker. A chunked P loop, or a cap tied to L, is wanted before that is offered on a long gene.
5. **Diagnostics thresholds want the review `PHASE3A.md` gap 3 asks for.** Depth is now judged on
   TN93 distances, so camelid newly trips `DEEP_LARGE_TREE` and HIV1_RT newly trips `SHALLOW_TREE`;
   neither is wrong, both are new advice on inputs that used to get none, and the regime line does
   not yet say the judgement came from distances rather than a tree.
6. **A locally-run record does not store its alignment**, so the site-tree modal cannot draw on a
   report the reader just ran — it shows the "this record does not carry the tree and the sequences"
   notice — while prebaked and server records draw fine. Pre-existing, but D22 makes it sharper: the
   reader who supplied no tree is exactly the one who would want to see the NJ tree. The e2e
   therefore asserts the caption on the live run and the drawn tree on the gallery record.
7. **The e2e has no trait-table or pick-on-the-tree phenotype run and no B > 0 permulation run.** The
   preset and pasted-foreground paths are covered end to end; the CSV tab and the tree picker are
   unit-tested only, and a permulation run at the statistical class needs its own fixture.
8. **Over-budget DMS still does not hand off to the server** (`PHASE2.md` gap 5): `dms.skipped`
   carries the work and the budget and the page names the server, but nothing posts the job.
9. **Two caveats files** (`PHASE2.md` gap 9): `web/caveats.json` is validated at build (24 caveats,
   5 tables); `mcp/caveats.json` is a second copy, served as `hyphaeon://caveats`, validated by
   nothing.
10. **Delivery** (`PHASE2.md` gap 12, partly closed): `web/static/_headers` is now authored by
    `scripts/copy-assets.mjs` with a same-origin CSP and no `'unsafe-eval'`, matching
    `deploy/apache-hyphaeon.conf` — two files still, but they now agree and each says so. Still open:
    no woff2 vendored, no CI workflow in this repository, `@veg/hyphaeon-mcp` needs the npm publish
    of `@veg/hyphaeon-js@1.0.0`, `onnxruntime-node` stays pinned at 1.23.2 (darwin/x64 under
    Rosetta), and nothing is deployed.
11. **`server/src/runner.js` still carries `composeReportFallback`** for a runtime without
    `runEverything` — dead against the current runtime, kept as the documented degradation path.
12. **The gallery is baked at 8 threads on this machine** (bat_oas1 3.1 s, Smc6 9.6 s, camelid 19.2 s,
    HIV1_RT 70.0 s, RHO 71.6 s; 3 min for all five). Every edit under `runtime/src` changes the stamp
    and rebakes all five at the next build.
