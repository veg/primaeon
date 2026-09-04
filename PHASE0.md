# Phase 0 — what exists in `veg/hyphaeon-app` after the scaffold

Phase 0 (`PLAN.md` §8) scaffolded this repository as npm workspaces and gave it a runtime that
scores a real alignment through the library in `../HyphAeon/js` over onnxruntime, a static web
site that ships the graphs and ORT from its own origin, an MCP server that reaches every pillar
through the Python CLI bridge, and Playwright delivery assertions. This page maps what is here,
how each check runs, and what is carried to Phase 1. The project notebook is `CLAUDE.md`.

## What exists

| Path | What it is |
|---|---|
| `package.json` | Workspaces `runtime`, `web`, `mcp`, `e2e`; one root `package-lock.json`. `npm test` = vitest in every workspace with a `test` script; `npm run build` = web; `npm run e2e` = Playwright. |
| `runtime/` (`@veg/hyphaeon-runtime`, private) | `manifest.js` (manifest load, variant pick, sha256), `session-web.js` (from DM3), `session-node.js` (from datamonkey-js-server), `feeds.js`, `pipeline.js` (`runMeme`: parse → prepare → infer → postprocess over `@veg/hyphaeon-js`, `progress(phase, done, total, message)`, PLAN §3.5 provenance), `postprocess.js`/`callModes.js`, `fastaValidation.js`, `treeSanitation.js`, `prescreen/` (DM3's XGBoost hit-likelihood). Depends on `@veg/hyphaeon-js` by `file:../../HyphAeon/js` until a tag is published. `onnxruntime-node` pinned to 1.23.2 (see `CLAUDE.md`). |
| `web/` (`@veg/hyphaeon-web`) | SvelteKit 2 + Svelte 5 + TS, adapter-static, `paths.base` from `HYPHAEON_BASE`, `trailingSlash: 'always'`. Routes `/`, `/analyze` (upload/paste, gzip, tree, reference sniff, taxon caps; Run disabled), `/gallery`, `/methods`, `/evaluate`, `/mcp`. `scripts/copy-assets.mjs` (prebuild) vendors ORT WASM, `../HyphAeon/models/*`, DM3's HyPhy WASM and `_headers` (+COOP/COEP) into `web/static/`. |
| `mcp/` (`@veg/hyphaeon-mcp` 0.1.0) | 11 tools (`hyphaeon_validate`, `_meme`, `_busted`, `_epistasis`, `_dms`, `_phenotype`, `_evaluate`, `job_status`, `get_results`, `cancel_job`, `list_models`), 4 resources, 7 prompts, stdio bin, `mountHttp` (no auth yet). Every analysis runs through `src/bridge.js` → `hyphaeon` CLI with `provenance.surface = "python-reference"`. |
| `e2e/` | Playwright, chromium, against `vite preview` of the built site: title/heading, same-origin only, no model/ORT fetch on the landing route, COOP/COEP + `crossOriginIsolated`. |
| `CLAUDE.md`, `README.md`, `.gitignore` | Notebook (commands, why-config, release notes), overview, ignores for `node_modules`, `.svelte-kit`, `build`, `web/static/{ort,models,wasm}`, Playwright output, `parity/`. |

Not yet present (Appendix A): `server/`, `deploy/`, `web/src/lib/workers/`, `web/src/lib/viz/`,
`/results/[id]`, `/jobs/[id]`, `web/caveats.json`, any CI workflow.

## How to run each check

From the repository root, with `../HyphAeon` checked out beside it (its `models/` exported) and,
for the MCP bridge, a venv with `hyphaeon` installed editable:

```bash
export HYPHAEON_PY_BIN=<venv>/bin/hyphaeon
export HYPHAEON_WEIGHTS=$PWD/../HyphAeon/model.safetensors HF_HUB_OFFLINE=1
```

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Install | `npm install` | `node_modules/@veg/hyphaeon-js -> ../../../HyphAeon/js`; runtime/web/mcp/e2e linked |
| 2 | All workspaces | `npm test` | runtime `178 passed`, web `10 passed`, mcp `39 passed` (36 + 3 skipped with `HYPHAEON_MCP_SKIP_BRIDGE=1`) |
| 3 | Runtime alone | `cd runtime && npx vitest run` | `Test Files 9 passed / Tests 178 passed`; log `[pipeline] real-graph run against engine models/viral.onnx + manifest` and `bat_oas1 ... invariable flags agree on 351/351 sites` |
| 4 | MCP alone | `cd mcp && npm test` | `4 passed / 39 passed`; the bridge test scores bat_oas1 (18 × 351) with `python-reference` provenance |
| 5 | Web build | `cd web && npm run build && npm run check` | copy-assets: ort 2 files 13.3 MB, models 4 files 16.7 MB, hyphy 3 files 6.4 MB; `Wrote site to "build"`; `0 ERRORS 0 WARNINGS`; `web/static/models/` holds `general.onnx`, `viral.onnx`, `busted_head.onnx`, `manifest.json` |
| 6 | e2e | `npm run e2e` (after 5; needs `npx playwright install chromium` once; port 4173 free) | `4 passed` |

`git status --short --untracked-files=all` should show no `node_modules`, `build`, `.svelte-kit`,
`web/static/{ort,models,wasm,_headers}`, `test-results` or `playwright-report` entries.

## Gaps carried to Phase 1

1. **Numbers do not match `hyphaeon meme` yet.** On bat_oas1 with identical weights the pipeline's
   variable-site LRTs correlate with the reference at Spearman 0.13 (viral) / 0.10 (general).
   Measured causes, both the library's (`../HyphAeon/PHASE0.md` items 1–2): the `>10` patristic
   rescale and the codon vocabulary. Together they reach 0.94 / 0.69; the residual (max |ΔLRT|
   ≈ 2) is for the per-function fixture harness. The pipeline test PRINTS this comparison and
   asserts only shape, finiteness and invariable-site agreement (351/351).
2. **No p/q columns, `--filter`, `--attribute`** in `pipeline.js` until the stats/filter/attribution
   ports land (PLAN §5.2 order 1–3); no `hyphaeon_lrt`/`is_invariable` aliases of Appendix B yet.
3. **`/analyze` has no run path**: Run is disabled; the reference-sequence sniff is a header
   scan, not the library's parser; no workers, no results page, no gallery "Run in browser".
   `runtime/` is linked into `web/` but not imported by any page.
4. **MCP is bridge-only.** Every pillar shells to the Python CLI; `hyphaeon_epistasis`/`_dms`
   cannot select a variant (the CLI has no `--model-variant` there); `mountHttp` has no OAuth
   (Phase 2). The bridge classifies errors from the CLI's printed `[!]` markers until upstream
   typed exceptions land. `HYPHAEON_WEIGHTS` pointing at a missing file is silently ignored by the
   reference (falls back to another source) — upstream check wanted.
5. **No CI workflow** in this repository. The root `npm test` needs `HYPHAEON_MCP_SKIP_BRIDGE=1`
   or a Python venv for the three bridge tests; `e2e` needs a build and chromium.
6. **Delivery**: `web/static/_headers` is DM3's file verbatim plus COOP/COEP and still allows
   `https://unpkg.com` and `connect-src https:`; fonts fall through to system faces (no woff2
   vendored); e2e does not yet cover `/analyze` (ORT thread engagement, `/ort/` request assertion).
7. **`onnxruntime-node` 1.23.2** carries an `adm-zip` audit finding; 1.29 has no darwin/x64 build
   for this machine's Rosetta Node. Revisit with an arm64 Node.
8. **The parity `node` runner** that writes `parity/node/<example>.<analysis>.json` for
   `../HyphAeon/scripts/parity.py` does not exist yet; `parity.yml` therefore verifies the Python
   side only.
9. **`PLAN.md` §3.3** still quotes viral `onnx_sha256: de765904…` (DM3's/HF's single-output graph);
   the three-output export is `c3ea5795…`. PLAN.md is not edited by builders; update it deliberately.
10. **BUSTED neural head** outputs from `busted_head.onnx` are one of the reference's random
    possibilities (checkpoint incomplete upstream); do not surface them as results until fixed.
