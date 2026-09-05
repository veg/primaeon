# Phase 4 — harden and share: CI, the last product gaps, and the handoff

Phase 4 of the plan of record (`PLAN.md` §8: "harden and share") is the phase that turns a working
tree into something a team can pick up: continuous integration that fails when a fixture, a
Playwright assertion or a parity class is lost; the four product gaps `PHASE3.md` left open in the
report; a README written for a reader who has never seen the repository; and one document,
`HANDOFF.md`, for everything that needs an account, a secret, a decision or another repository —
none of which this phase could do from inside the two checkouts. `PLAN.md` §8's cross-repository
items (hyphy-scope promotion, DataMonkey 3's Predict switch, the Datamonkey MCP mount, the axomeme3
redirect) are specified there rather than done here; §5 of `HANDOFF.md` says why and how.

`PHASE0.md`, `PHASE1.md`, `PHASE2.md` and `PHASE3.md` are the previous maps; the project notebook
is `CLAUDE.md`. The engine side of the phase (`../HyphAeon`, branch `feat/js-port`, working tree
ahead of tag `phase-3a`) is described in `../HyphAeon/PHASE4A.md`, with `../HyphAeon/UPSTREAM.md`
as the consolidated list of reference bugs the port found.

## Final state of the product

One upload, one report, three surfaces, no Python and no HyPhy at runtime — as Phase 3 left it —
now with the four report gaps closed and a CI that can say no.

| Surface | What it is | State at the end of Phase 4 |
|---|---|---|
| `web/` | SvelteKit static site: drop or paste an alignment (± tree), or pick one of five prebaked examples; the report streams in (diagnostics, sites, gene, epistasis + sectors, attribution, filter, DMS, phenotype on demand); `/methods`, `/evaluate`, `/mcp` | Builds with the full gallery prebake (5/5 records, 0.60–1.91 MB each); `svelte-check` 577 files, 0 errors; 13 vitest files / 93 tests; 62 Playwright tests against the built site |
| `runtime/` | The analyses over `@veg/hyphaeon-js` and ONNX Runtime, shared by every surface | 22 vitest files / 297 tests; `display_tree_source` is `'user' \| 'user-topology' \| 'nj'` (D6 done) |
| `mcp/` 0.4.0 | `@veg/hyphaeon-mcp`, stdio, 12 tools, all in-process | 10 files / 113 tests; the TN93 refusal is an INPUT error (`TN93_UNCOMPUTABLE`) |
| `server/` | Node HTTP: jobs, SSE, `/validate`, `/mcp` over HTTP with OAuth | 5 files / 57 tests |
| `e2e/` | Playwright against `vite preview` of the built site | 62/62 in 28.5 s; new assertions for every Phase 4 polish item |
| `.github/workflows/ci.yml` | Two jobs, `app` and `parity`, both checking out `veg/HyphAeon` beside this repository | Parses; `actionlint` clean; the steps were run by hand in their exact shape (below) |
| Parity | `runtime/scripts/parity-node.mjs` writes `node` + `node-tn93`; the e2e writes `web` + `web-tn93`; the engine's rewritten `scripts/parity.py` compares | **20 comparisons, 20 pass, 0 violations, `PASS`, exit 0** — meme, busted, epistasis, DMS and phenotype on node; meme, busted, epistasis tree-free on node-tn93; meme, epistasis and tree-free meme in the browser |

### What changed this phase, by file

| Path | What changed |
|---|---|
| `.github/workflows/ci.yml`, `.nvmrc` (new) | `app`: setup-node from `.nvmrc` (22), cached `node_modules`, `npm run test --workspaces --if-present` with `HYPHAEON_MODELS_DIR` / `HYPHAEON_ENGINE_DIR` pointing into the engine checkout, `svelte-check`, the full web build, cached Playwright browsers, `npx playwright test`, report uploaded on failure. `parity`: Python 3.11 + CPU torch + `pip install -e ".[all]"` of the engine, `parity-node.mjs --examples all --analyses meme,busted,epistasis,dms,phenotype`, then `scripts/parity.py --examples all --surfaces python,node,node-tn93`, `report.json` uploaded always. `ONNXRUNTIME_NODE_INSTALL=skip` workflow-wide (onnxruntime-node 1.23.2 lists cuda12 for linux/x64). `ENGINE_REF` is `phase-3a` and must be bumped (below). |
| `README.md` | Rewritten for a public reader: what the repository is, the two-repository rule (D9, §5.5), running locally with the engine as a sibling checkout, the environment variables, the MCP install line, the server, the parity commands, what CI runs, links. |
| `runtime/src/pipeline.js` | **D6 done.** `displayTreeFor`: a tree-free run whose upload carried a topology draws THE READER'S topology, pruned to `loaded.taxa`, with unit branch lengths (`unitTopologyNewick`, iterative, keeps support values), `source: 'user-topology'`, `label: USER_TOPOLOGY_LABEL` = "your topology; branch lengths not estimated (model used TN93 distances)". Neighbour joining only when there is no topology (or none of its tips match; a REQUESTED tree-free run keeps NJ since the reference's flag ignores the tree). `DISPLAY_TREE_SOURCES = ['user', 'user-topology', 'nj']`. |
| `web/src/lib/report/alignmentBlock.ts` (new), `ReportView.svelte`, `phenotype.svelte.ts`, `PhenotypeSection.svelte`, `storage/reports.ts` | **Site views on a locally run report.** The browser record already kept `inputs.alignmentText`; the site-tree modal, entropy overlays and phenotype panel read `sections.sites.alignment`, which only the prebake and server wrote. The `{names, sequences}` block is now DERIVED on read from the stored text through the library's parser minus the provenance's `dropped_taxa` (the prebake's own recipe). Measured before choosing: Smc6 text-only 2.01 MB vs +66 KB (+3 %) for a stored block, HIV1_RT 1.73 MB vs +261 KB (+15 %); a per-site codon-column store is the same bytes as the block. Pre-Phase-2 records get `null` and the existing notices. |
| `web/src/lib/report/displayTree.ts`, `api.ts`, `viz/ProvenancePanel.svelte`, `viz/TreePicker.svelte`, `diagnostics/panel.ts` | The `user-topology` source everywhere a tree is named: the modal caption ("Display only — your topology; branch lengths not estimated (model used TN93 distances). This run was tree-free: … the unit branch lengths drawn here are a convention, not a fit."), the provenance "Tree drawn" row, the foreground picker's display-only sentence, and the diagnostics strip's tree plan. A Phase 3 record that drew NJ keeps saying NJ: the label is decided by what was drawn. |
| `mcp/src/engine.js` | `tn93Refusal()` classifies the runtime's "TN93 distances could not be computed …" as an INPUT `EngineError`, code `TN93_UNCOMPUTABLE`, with a data-facing message (saturated pair vs no overlapping position, keyed on the quoted `ValueError` / `ZeroDivisionError`) and a hint naming a tree with branch lengths. |
| `web/src/routes/mcp/+page.server.ts`, `facts.server.ts`, `tools.ts` (new), `+page.svelte`, `page.test.ts` (new) | `/mcp` reads `mcp/package.json`'s version and `mcp/src/tools.js` `TOOL_NAMES` at build (prerendered; falls back to page copy when `mcp/` is absent), so the page cannot describe a release other than the one beside it: "Current release: `@veg/hyphaeon-mcp 0.4.0` — read from the package at build, with the 12 tools listed below." The Phase 3 "Runs / bridged" column is gone. |
| `runtime/test/parity-fixtures.test.js` | The engine's regenerated `fixtures/e2e/busted_*.json` carry two arrays the CLI does not write (`site_lrts`, `is_invariable`, from a `hyphaeon meme` run whose float32 sums reproduce `omnibus_lrt` and `total_selection_energy` exactly); the key-order assertion drops them and the per-site LRTs are now checked at the graph class instead (max relative \|ΔLRT\| 1.98e-6 on Smc6). |
| `runtime/test/pipeline.test.js`, `no-hyphy.test.js`, `mcp/test/engine.test.js`, `web/src/lib/report/siteViews.test.ts` (new), `web/src/lib/diagnostics/panel.test.ts` | Four display-tree cases; camelid asserts `user-topology`; the TN93 refusal's kind, code, wording and hint; the derived alignment block (from text minus `dropped_taxa`, stored block preferred, `null` for pre-Phase-2 records, the two captions); the tree-plan sentence. |
| `e2e/helpers.ts`, `gallery.spec.ts`, `treefree.spec.ts`, `smoke.spec.ts` | `USER_TOPOLOGY_LABEL` shared; camelid and HIV1_RT prebaked records assert `display_tree_source: 'user-topology'`, `from: 'tree-text'` and the label; the camelid LIVE record's modal draws the topology with the unit-length caption and no notice; the pasted-Smc6 live record draws its NJ tree (the "a live run cannot draw" comment is gone with the behaviour); the gallery camelid modal asserts the new caption; `/mcp/` is held against `mcp/package.json` and `TOOL_NAMES` read independently (version visible, one row per tool, no `Runs`/`bridged`/Python in the table). |
| `web/static/gallery/*.json` | Rebaked by the full build (runtime stamp changed): camelid and HIV1_RT now carry the reader's topology (`display_tree_source: 'user-topology'`, 212 and 256 tips). |
| `HANDOFF.md` (new) | Everything outside the two repositories or needing the team's hand; §"Pointers" below. |
| `CLAUDE.md` | A "CI" section, the D6 note in the why-config, and the Phase 4 release-note entries. |

## How to run each check, and what it printed at integration

From `/Users/sweaver/Programming/_bioinformatics/hyphaeon-app` with `../HyphAeon` beside it
(branch `feat/js-port`, working tree of 2026-09-05 with the regenerated fixtures and the rewritten
`scripts/parity.py`), Node 22 x64, onnxruntime-node 1.23.2. The Python reference venv is the
scratch one `HANDOFF.md` §7.2 describes, with `HYPHAEON_WEIGHTS=../HyphAeon/model.safetensors
HF_HUB_OFFLINE=1`.

| # | Check | Command | Printed |
|---|---|---|---|
| 1 | Install | `npm ci` | completed; the audit notice only (`Run npm audit for details`) |
| 2 | Every workspace's suite (the CI step as written) | `HYPHAEON_MODELS_DIR=../HyphAeon/models npm test --workspaces --if-present` | runtime `Test Files 22 passed (22)` / `Tests 297 passed (297)`; web `13 passed (13)` / `93 passed (93)`; mcp `10 passed (10)` / `113 passed (113)`; server `5 passed (5)` / `57 passed (57)` — see the note on the first run below |
| 3 | Types and templates | `cd web && npm run check` | `COMPLETED 577 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| 4 | Full build, gallery prebaked | `cd web && npm run build` | copy-assets: 2 ORT files (13.3 MB) + 4 model files (16.7 MB) + `_headers`; prebake `camelid 19.4 s ok`, `HIV1_RT 70.6 s ok`, `RHO 72.4 s ok` (bat_oas1 and Smc6 before them), `total 175.2 s`; record sizes `bat_oas1 0.67 MB · Smc6 1.91 MB · camelid 0.60 MB · HIV1_RT 1.42 MB · RHO 1.86 MB`; `[check-caveats] ok — v1: 24 caveats, 5 tables`; vite `✓ built in 3.16s` + `✓ built in 6.30s`; `Wrote site to "build"`; 3 min 04 s wall. A second build after the viz edits: `bat_oas1: up to date (stamp af9b5121…); reusing` × 5, `✓ built in 3.09s` + `6.13s` |
| 5 | Playwright against the built site | `cd e2e && npx playwright test --reporter=list` | `62 passed (28.5s)`, exit 0 — including `the site tree modal draws the reader’s topology on the LIVE record, with the unit-length caption`, `the stored record: … the reader’s topology drawn beside it`, `and the gallery’s tree-free record (camelid) draws the reader’s topology with the same caption`, `/mcp/ is current with the mcp/ workspace: its version and one row per registered tool, no bridge`; the run wrote `parity/browser/{bat_oas1.meme,Smc6.epistasis,RHO.phenotype}.json` and `parity/browser-tn93/camelid.meme.json` |
| 6 | The node surfaces | `node runtime/scripts/parity-node.mjs --threads 8` | `wrote 12 file(s) to …/HyphAeon/parity/node; 0 failed` and `5 tree-free file(s) in …/parity/node-tn93 (HIV1_RT, camelid)`; camelid meme `TREE-FREE (D22, reason no_branch_lengths)`; 1 min 46 s wall |
| 7 | The reference and the comparison | `cd ../HyphAeon && python scripts/parity.py --examples all --surfaces python,node,node-tn93,web,web-tn93` | `reference runs: 23 (0 failed); self-check violations: 0; comparisons: 20 (20 pass, 0 fail); missing: 18; redirected: 7; incomparable: 1; violations: 0; informational excursions: 1` / `[parity] PASS` / `exit 0` |
| 8 | Workflow file | `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` | `yaml ok; jobs: ['app', 'parity']; steps: {'app': 14, 'parity': 11}; on: ['push', 'pull_request', 'workflow_dispatch']`; `actionlint 1.7.12` no findings (the CI builder's run) |
| 9 | Documents | a case-insensitive `grep` for AI-attribution strings (co-author trailers, vendor and model names, session links) over README.md, CLAUDE.md, HANDOFF.md, PHASE4.md, `.github/workflows/ci.yml`, `e2e/*.ts` and every new source file, and a pipe-count pass over every Markdown table | no matches (the only `claude` strings are the `CLAUDE.md` filename, `claude mcp add` and "claude.ai connector"); README 2 tables, CLAUDE.md 1, HANDOFF.md 13 — every row has its header's column count once escaped `\|` cells are read as cells |
| 10 | Hygiene | `git status --porcelain --ignored` | ignored: `node_modules/` (×5), `web/.svelte-kit/`, `web/build/`, `web/static/_headers`, `web/static/models/`, `web/static/ort/`, `e2e/test-results/`; the engine's `parity/` is ignored there. Tracked and modified: only sources, tests, documents and the five gallery records the build rebakes on purpose |

**The note on check 2.** The first run printed runtime `Tests 1 failed | 296 passed (297)`:
`parity-fixtures.test.js` compared the busted record's key list to `fixtures/e2e/busted_Smc6.json`,
which a concurrent engine-side regeneration (13:47) had given two extra arrays. The test was
corrected (row "runtime/test/parity-fixtures.test.js" above) and the suite re-run:
`Test Files 1 passed (1)` / `Tests 8 passed (8)` with
`[parity-fixtures] busted Smc6 site_lrts: max relative |dLRT| 1.98e-6 at site 628`, then the whole
runtime suite `22 passed (22)` / `297 passed (297)`.

**The note on check 5.** The first full run printed `1 failed / 61 passed`: the new `/mcp/`
currency test counted `table.tools tbody tr` (13) against the 12 tools, because the "Job control"
group heading is a `tr.tools__group`; the second attempt tripped on the page's own historical
sentence "nothing here is marked "bridged"" and on "abridged". Both were the test's fault and
were narrowed (rows `:not(.tools__group)`; the wording assertion applies to the table). The pasted
line is the clean third run.

## Parity table

The engine's `scripts/parity.py` (rewritten in Phase 4a: tree-free `<surface>-tn93` siblings, `dms`
and `phenotype` comparators, PLAN §5.4's graph class as `1e-5 · max(1, |ref|)`, BUSTED head fields
skipped as nondeterministic) compared every file the app's two runners wrote. "Worst" is the
largest |Δ| as a fraction of that field's bound; a comparison passes when nothing reaches 1.

| Surface | Example | Analysis | Result | Worst field |
|---|---|---|---|---|
| node | Smc6 | meme | pass | `hyphaeon_lrt` 0.20 |
| node | Smc6 | busted | pass | `p_value_acat` 0.16 |
| node | Smc6 | epistasis | pass | `null_coherence_std` 0.94 |
| node | Smc6 | **dms** | pass | `p_value` 0.30 |
| node | bat_oas1 | meme | pass | `hyphaeon_lrt` 0.24 |
| node | bat_oas1 | busted | pass | `p_value_acat` 0.04 |
| node | bat_oas1 | epistasis | pass | `null_coherence_std` 0.65 |
| node | RHO | meme | pass | `hyphaeon_lrt` 0.19 |
| node | RHO | busted | pass | `p_value_simes` 0.15 |
| node | RHO | epistasis | pass | `null_coherence_std` 0.77 |
| node | RHO | **phenotype** | pass | `score` 0.69 |
| node-tn93 | camelid | meme | pass | `hyphaeon_lrt` 0.22 |
| node-tn93 | camelid | busted | pass | `p_value_simes` 0.20 |
| node-tn93 | camelid | epistasis | pass | `null_coherence_std` 0.66 |
| node-tn93 | HIV1_RT | meme | pass | `hyphaeon_lrt` 0.22 |
| node-tn93 | HIV1_RT | busted | pass | `total_selection_energy` 0.04 |
| node-tn93 | HIV1_RT | epistasis | pass | `null_coherence_std` 0.46 |
| web | bat_oas1 | meme | pass | `hyphaeon_lrt` 0.23 |
| web | Smc6 | epistasis | pass (1 informational) | `similarity` 0.18 |
| web-tn93 | camelid | meme | pass | `hyphaeon_lrt` 0.19 |
| web | RHO | phenotype | incomparable | `taxa_count differs (reference 655, surface 256)` — the browser caps at 256 taxa (PHASE3.md gap, unchanged) |

Reference runs: 17 with the example's tree (`python/`) plus 6 tree-free (`python-tn93/`: camelid
and HIV1_RT × meme, busted, epistasis, each with the `tn93` binary hidden so the pure-Python package
computes the distances, as the fixtures and the port do). 18 "missing" are the surface × example ×
analysis cells no app runner writes (the browser writes four files, the node runner does not run
DMS beyond Smc6 or phenotype beyond RHO); 7 "redirected" are the tree-free examples compared to
`python-tn93/` instead of `python/`. `--strict-missing` is off, as the workflow leaves it.

Two things this table settles that `PHASE3.md` could not. The **DMS comparator** exists and Smc6
passes it on node with `p_value` at 0.30 of its bound (the CI builder's earlier shape run, against
an intermediate `parity.py`, saw `mutant_deltas` at 1.48× and 2.24× of a bound the engine side then
revised; on the final script the excursion is gone). And the **phenotype comparator** exists: RHO
marine on node passes at `score` 0.69.

## Integration changes (beyond wiring)

- `runtime/test/parity-fixtures.test.js` — the fixture-only arrays, above.
- `web/src/lib/viz/ProvenancePanel.svelte`, `viz/TreePicker.svelte`, `diagnostics/panel.ts` +
  `panel.test.ts` — the polish builder's own report listed these as still printing "the tree the
  model was given" / "built from the TN93 distances" / "a neighbour-joining tree" for the new
  `user-topology` source; each now branches on it.
- `e2e/` — the four specs, above; the polish builder had flagged `gallery.spec.ts:102` and
  `treefree.spec.ts:98-99` as asserting `'nj'` for topology-only uploads.
- `CLAUDE.md` why-config — the "There is no tree tool and no HyPhy" rule now names both display
  sources.

## Known gaps carried out of Phase 4

Everything that needs a hand outside these two checkouts is in `HANDOFF.md`; the items below are
the ones a reader of this document should know before trusting a green check.

1. **`ENGINE_REF` is `phase-3a`**, whose `scripts/parity.py` refuses the `node-tn93` surface, so
   the `parity` job fails at its last step until the engine tags a ref carrying the Phase 4a
   rewrite (which the run above used from the `feat/js-port` working tree) and the ref — and the
   README's "phase-3a today" line — is bumped. `HANDOFF.md` §1 and §3.
2. **`ENGINE_TOKEN`** (fine-grained PAT, Contents: read on `veg/HyphAeon`) does not exist yet;
   `veg/hyphaeon-app` does not exist on GitHub; pull requests from forks get no secrets and fail at
   the engine checkout by design. `HANDOFF.md` §0 and §3.3.
3. **The browser's phenotype run stays incomparable** with the RHO fixture (256-taxon cap vs 655);
   node compares and passes.
4. **Neither the wheel nor the npm tarball carries `models/manifest.json`**; the app reads models
   from the sibling engine checkout (`HYPHAEON_ENGINE_DIR`), so pinning a published
   `@veg/hyphaeon-js` alone does not deliver models. `HANDOFF.md` §2.2.
5. **`@veg/hyphaeon-mcp` depends on the private `@veg/hyphaeon-runtime@0.0.0`** and cannot be
   installed from npm as it stands. `HANDOFF.md` §3.3.
6. **`vite dev` cannot drive the analysis path** (the linked library outside the workspace root is
   not servable), so only a built preview works — the e2e already assumes this; under vite dev /
   vitest the `/mcp` facts import prints two harmless "dynamic import cannot be analyzed" warnings.
7. **The engine working tree is ahead of `phase-3a` and uncommitted** (regenerated fixtures,
   `parity.py`, three workflows, `PHASE4A.md`, `UPSTREAM.md`); every number above was taken
   against that tree. The app's `runtime/test/parity-fixtures.test.js` and `tree-free.test.js`
   read those fixtures, so a checkout at `phase-3a` proper would replay the older ones.
8. **Nothing is deployed and nothing is published.** `HANDOFF.md` §3 and §4 are the runbooks.

## Pointers into `HANDOFF.md`

| You need to… | Read |
|---|---|
| Push `feat/js-port`, rebase onto the two commits `main` gained, open the engine PR | §1 (1.1 steps, 1.2 the three rewritten functions the port mirrors, 1.3 reviewer order) |
| Get the ML team's sign-off on D20 (MDS signs), D2 (canonical weights + HF tag), the BUSTED head, the codon vocabulary | §2 |
| Cut `v1.0.0`: bump, tag, PyPI trusted publisher, npm scope, `release.yml` prerequisites | §3 |
| Deploy: domain, host requirements, vhost rules, the server's environment, smoke checks | §4 |
| Promote viz to hyphy-scope, switch DM3 Predict, mount the MCP in Datamonkey, redirect axomeme3 | §5 |
| Know what CI cannot run without the private engine, and what was in flight when the document was written | §6 |
| Resume in a new session: tags, the venv, the check commands and their tails | §7 |
