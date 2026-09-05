# HyphAeon handoff — what Phase 4 needs from the team, and nothing that was executed here

<!--
WHY THIS FILE EXISTS. PLAN.md §8 Phase 4 ("Harden and share") is the one phase whose work is
mostly OUTSIDE these two repositories or needs a human with credentials: a pull request into
veg/HyphAeon main, ML-team sign-offs, PyPI/npm/HuggingFace publishing, a host, a domain, and three
other repositories (hyphy-scope, datamonkey3, datamonkey-js-server, plus axomeme3's redirect).
Every item below states what it is, why it is needed, the exact steps or commands, who decides,
and what is blocked on it. Nothing in this document has been done: no push, no PR, no publish, no
deploy, no DNS. The facts were verified on 2026-09-05 against the checkouts named in §0 and, where
a remote service is involved, by read-only queries (gh api, npm view, curl) whose results are
quoted. Dated 2026-09-05.
-->

**Date:** 2026-09-05.
**Repositories at handoff:** engine `veg/HyphAeon` at `../HyphAeon`, branch `feat/js-port`, tag
`phase-3a` (`61d681a`); application `veg/hyphaeon-app` at this directory, branch `main`, tag
`phase-3` (`a428530`). Both were clean at those tags when Phase 4 started; both working trees now
carry uncommitted Phase 4 work by concurrent builders (§6.3), so where this document describes a
file it names the state at the tag and says what is in flight. The app links the library by
`file:../../HyphAeon/js` (`runtime/package.json`).
**Plan of record:** `PLAN.md` (draft v5): §5.4 parity classes, §7 upstream changes, §8 Phase 4,
§9 decisions D1–D22. Phase records: `PHASE0–3.md` here, `../HyphAeon/PHASE{0,1A,2A,3A}.md`,
`../HyphAeon/MDS_SIGN.md`, `../HyphAeon/PARITY.md` (being rewritten concurrently for the tree-free
surfaces and the `dms`/`phenotype` comparators). Upstream fix list: `../HyphAeon/UPSTREAM.md`
(1,018 lines, written concurrently, untracked at 2026-09-05 13:50: sections A crashes C1–C5,
B wrong results W1–W19, C silent fallbacks S1–S8, D dead code; §1.4 is the cross-check of what it
must cover).

---

## 0. Ground truth at handoff (verified 2026-09-05)

| Fact | Verified how | Result |
|---|---|---|
| `feat/js-port` is not on `origin` | `git ls-remote --heads origin` in `../HyphAeon` | heads: `main` (`2641a21`), `feature/axomeme-2.0-spec` only. No `phase-*` tags on the remote. |
| Remote `main` moved past the branch's base | `gh api repos/veg/HyphAeon/compare/3cb9cc6...main` | `ahead_by: 2` — `124c3ea` (PR #36: Python 3.8, TN93 domain-error fix, tn93 in CI) and `2641a21` (spectral splits + temporal pillars). Both touch files the port mirrors (§1.2). |
| `veg/HyphAeon` visibility | `gh api repos/veg/HyphAeon` | `private: true`; this account has `admin`. |
| `veg/hyphaeon-app` on GitHub | `gh repo view veg/hyphaeon-app` | "Could not resolve to a Repository" — **does not exist** (or is invisible to this account). The app has no `origin` (`git remote -v` prints nothing). |
| GitHub environment `pypi` on veg/HyphAeon | `gh api repos/veg/HyphAeon/environments` | `total_count: 0` — release.yml's `environment: pypi` does not exist yet. |
| Team `@veg/hyphaeon-maintainers` (CODEOWNERS) | `gh api /orgs/veg/teams/hyphaeon-maintainers` | 404 — the placeholder team does not exist; CODEOWNERS is silently ignored. |
| `@veg/hyphaeon-js`, `@veg/hyphaeon-mcp` on npm | `npm view … version` | both 404 — never published. (`npm whoami` returned E401: no valid npm token on this machine.) |
| PyPI / TestPyPI name `hyphaeon` | `curl https://pypi.org/pypi/hyphaeon/json` | 404 on both — the name is free; a *pending* trusted publisher can be registered before the first upload. |
| HuggingFace `datamonkey/hyphaeon`, `datamonkey/axomeme` | `curl https://huggingface.co/api/models/…` | 401 unauthenticated — both private/gated. `../HyphAeon/models/_hf/` holds an authenticated download from before: `config.json`, `model.viral.onnx` (sha256 `de765904…`, 7,786,911 B), `model.viral.safetensors` (`b6b0d8d0…`). |
| Weights and graphs committed in the engine | `git ls-files` | `model.safetensors` (suite, `0278dff0…`, 9,842,824 B), `models/{general,viral,busted_head}.onnx`, `models/manifest.json` are tracked. |
| Neither package artifact carries the models | `npm pack --dry-run` in `js/`; `python -m build` to a scratch dir | npm: 35 files, 195.4 kB packed, `src/` only. wheel 109,667 B / sdist 136,597 B, 47 entries, `hyphaeon/` only. `models/manifest.json` and the ONNX graphs are in **neither** (PLAN §3.3 says "packaged into both"; §3.2). |
| hyphy-scope | `git remote get-url origin` in `../hyphy-scope`; `npm view hyphy-scope version` | `stevenweaver/hyphy-scope` (not `veg/hyphy-scope`, which does not resolve), `cdfbaab8` = 1.11.0 = the npm version. |
| datamonkey3 / datamonkey-js-server / axomeme3 | `git remote get-url origin` | `stevenweaver/datamonkey3` @ `fac1330`; `veg/datamonkey-js-server` @ `1e84d6f`; `veg/axomeme3` @ `b365cc6`. |
| Toolchain on this machine | `node --version`, `npm --version`, `hyphy --version`, venv | Node v22.22.0 (x64 under Rosetta), npm 10.9.4, HyPhy 2.5.65 at `/usr/local/bin/hyphy`, `tn93` binary at `/usr/local/bin/tn93`, `hf` 1.4.1 CLI on PATH; scratch venv Python 3.14.0 (§7.2). |

Checks run today, both repositories (tails in §7.3): engine `npx vitest run` 29 files / 1,067
tests, `tsc` silent, `fixture-coverage` 48/48, `pytest` 252 passed / 2 skipped, `parity.py
--examples Smc6 --surfaces python` PASS; app `npm test --workspaces` runtime 294 / web 79 / mcp 113
/ server 57, `svelte-check` 571 files 0 errors.

---

## 1. Engine: `feat/js-port` → pull request into `veg/HyphAeon` `main`

**What.** Four commits on `feat/js-port`, based on `main@3cb9cc6` (v1.0.0), tagged per phase,
carrying the JavaScript library, the ONNX export with attention outputs, the fixture generator and
fixtures, the parity harness, the CI/release workflows, and the two reference-side changes the
plan asked for (`--mds-sign`, `--seed`). `git diff --stat main..feat/js-port`: 192 files,
+396,526 / −12 (the bulk is `fixtures/` JSON, 5.6 MB, and `models/` binaries, 17.5 MB). A fifth,
Phase 4 commit is in preparation in the engine working tree (§6.3: `scripts/parity.py`,
`scripts/gen_fixtures.py`, regenerated fixtures, the three workflows); the PR should include it.

| Tag | Commit | Date | Subject | Stat |
|---|---|---|---|---|
| `phase-0` | `267f5cf` | 2026-09-04 | Add JavaScript preprocessing library, ONNX export with attention outputs, fixtures, and parity CI | 107 files, +189,329 |
| `phase-1a` | `cf838ab` | 2026-09-04 | Mirror dataset.py in the JavaScript library and port stats, filter, attribution, omnibus, evaluation, diagnostics | 65 files, +51,624 / −2,153 |
| `phase-2a` | `61d30e3` | 2026-09-05 | Canonical MDS eigenvector signs, seeds, and the epistasis, sectors and DMS ports | 50 files, +39,035 / −5,774 |
| `phase-3a` | `61d681a` | 2026-09-05 | Tree-free TN93 mode and the phenotype port in the JavaScript library | 29 files, +124,602 / −149 |

The Python-side diff is small and is the part the ML team owns: 9 files, +1,060 / −12 —
`hyphaeon/export.py` (+654, new), `hyphaeon/cli.py` (+55: `export-onnx`, `--mds-sign`, `--seed`),
`hyphaeon/dataset.py` (+64: `compute_mds_coordinates(mds_sign=)`, `canonicalize_eigenvector_signs`),
`hyphaeon/phenotype.py` (+8: `seed=`), `README.md` (+29), `CODEOWNERS` (+14), and three workflows
(`js.yml`, `parity.yml`, `release.yml`). Everything else is additive: `js/`, `fixtures/`,
`models/`, `scripts/{export_onnx,gen_fixtures,parity,verify_onnx,mds_sign_effect}.py`, the phase
documents.

**Why.** PLAN D9/§5.5: the port lives beside the Python it mirrors so a method change and its
port land in one PR and ship under one tag. Until the branch is on `main`, nothing in §3 (release)
can run, the app cannot pin a published version, and the `ci.yml` being added to this repository
(§6.3) has no engine ref to check out except a branch that exists only on this machine.

### 1.1 Steps

```bash
cd ../HyphAeon
git fetch origin
git push -u origin feat/js-port                    # the branch
git push origin phase-0 phase-1a phase-2a phase-3a # the phase tags (release.yml triggers on v* only, so these publish nothing)
gh pr create --base main --head feat/js-port \
  --title "JavaScript library mirroring hyphaeon/*.py, ONNX export with attention outputs, fixtures, parity harness, release workflow" \
  --body-file PR.md                                 # write PR.md from this section and PHASE0–3A.md
```

Before or as part of the PR: **rebase onto `origin/main`** (two commits ahead, §1.2). Expect
conflicts in `hyphaeon/cli.py` (both add subcommands and flags), `hyphaeon/dataset.py` (both edit
`compute_tn93_distance_matrix`'s neighbourhood), `hyphaeon/phenotype.py`, `README.md`. No conflict
in `pyproject.toml` (the branch does not touch it) or `.github/workflows/tests.yml` (the branch
adds three other workflow files).

### 1.2 What moved on `main` after the branch was cut, and why it matters to the port

The port discipline (PLAN §5.3 rule 3) is: fix the Python, regenerate the fixtures, then change
the JavaScript. Both upstream commits change functions the library mirrors line for line, so the
rebase is not mechanical: three ports and their fixtures must follow.

| Upstream change (`main`) | Where the port mirrors the OLD behaviour | What must happen after the rebase |
|---|---|---|
| `124c3ea` (#36): `compute_tn93_distance_matrix` wraps `tn.calculate_distance` in `try/except (ValueError, OverflowError)` → `d = 1.0`. | `js/src/preprocess/tn93.js:258, 551` throw the Python exception names; `js/src/diagnostics.js:657-660` turns the throw into `TN93_SATURATED_PAIRS` at **refuse** level; `PHASE3A.md` "Python quirks" records the raise as replicated. | A saturated pair is now a distance of 1.0, not an error. Re-mirror `tn93.js`, regenerate `fixtures/dataset/tn93_distance*.json`, `load_alignment_and_tree_tn93.json`, `e2e/*_tn93.json`, decide what `TN93_SATURATED_PAIRS` means (a count at info level, as `PLAN.md` §4.3 wrote it). `mcp/src/engine.js`'s rewrite of the same exception (PHASE3.md integration change 1) becomes dead. |
| `2641a21`: `compute_tn93_distance_matrix` gains `threshold=100.0` (binary called with `-t 100.0`, retry at `1.0`), a pandas parse of the binary's CSV, and a **single vectorised imputation**: every zero off-diagonal → `max(1.0, max_d)`. The old two-rule imputation (identical → `max(1.0, max_d)`, different-at-zero → `1e-4`) is gone. | `tn93.js` implements the two-rule imputation and the `1e-4` case (PHASE3A.md quirk "the identical-sequence imputation is the maximum, not the minimum"); `fixtures/dataset/tn93_distance_matrix.json` pins it. | Same as above: re-mirror, regenerate, replay. Also re-run the binary-vs-package equality check PHASE3A.md §"The fixtures" describes — the binary is now invoked at threshold 100, which changes which pairs come back as 0 from a stock `tn93 <= 1.0.15`. |
| `2641a21`: `phenotype.compute_phylogenetic_covariance` rewritten as one O(M) traversal keyed by node identity and an exact-name dict; the Biopython `find_any(name=…)` regex lookup is gone; an unmatched taxon gets `V[i,i] = 1.0`. | `js/src/permulations.js` `computePhylogeneticCovariance` reproduces `find_any`'s regex semantics (`findAnyByName`, `pyRegexSource`) — PHASE3A.md quirk "`Bio.Phylo`'s `find_any(name=X)` treats X as a regex". | Re-mirror; regenerate `fixtures/phenotype/compute_phylogenetic_covariance.json` and `generate_permulations.json`; the regex helpers become dead code. |
| `2641a21`: `epistasis.compute_sector_permutation_test` computes the `[N, N]` Gram matrix when `K > N` instead of `[K, K]`. | `js/src/sectors.js` `computeSectorPermutationTest` always forms `[K, K]`. | Same nonzero spectrum, so λ₁ and the trace agree up to float rounding; confirm with the statistical class rather than assume, and mirror the branch so the two stay line-for-line. |
| `2641a21`: new pillars `hyphaeon/splits.py` (spectral graph bisection, `cmd_splits`), `hyphaeon/temporal.py` (`cmd_temporal`), with `MIGRATION_GUIDE.md`, `TEMPORAL_ANALYSIS_GUIDE.md`, `SPECTRAL_SPLITS_BENCHMARK.md`; `dataset.py` +50/−30, `cli.py` +130. | Not ported; not in PLAN D3's six pillars. | **Decision (§2.5):** in scope for the app or not. |
| `124c3ea`: `requires-python >= 3.8`, CI matrix 3.8–3.12, tn93 installed in CI. | `release.yml`'s `verify` job uses `tomllib` (3.11+) on `ubuntu-latest` — fine. | None, but note `fixtures/manifest.json` records Python 3.14.0 / numpy 2.3.3 / pandas 3.0.5, and open issue #40 says `temporal.py` breaks on NumPy ≥ 2.0. |

Also open upstream and touching the same code: PR #34 "Vectorize TN93 distance-matrix assembly
(--no-tree): 5.3s → 2.0s, identical output" (`perf/vectorize-tn93-distance`), PR #38
(`--use-tn93` passthrough for temporal), PR #41 (temporal LTEE). Land or close #34 before
regenerating the TN93 fixtures, or regenerate twice.

### 1.3 What reviewers should look at (in this order)

1. **`MDS_SIGN.md` and decision D20** (§2.1). The one change on the branch that alters the
   reference's own outputs. `hyphaeon/dataset.py` `canonicalize_eigenvector_signs`, the CLI flag,
   the env var, and the measured-effect table are all in that document. If D20 is not accepted,
   the default in `dataset.py` flips to `lapack` and `fixtures/` are regenerated before merge.
2. **`UPSTREAM.md`** (§1.4): the reference defects the port replicated on purpose and now waits on.
3. **`js/`**: `js/src/README.md` (module map, the `predict` callback convention, the purity
   rule), then each module's "WHY THIS FILE EXISTS" header — every function cites the Python file
   and line it mirrors. `js/test/index.test.js` pins the 232 public names. Purity check:
   `grep -rnE "onnxruntime|node:|\bfs\b|fetch\(|Worker\(|process\.|require\(" js/src/` yields hits
   only inside comments (PHASE3A.md check 6).
4. **`fixtures/`**: `fixtures/README.md`, `fixtures/manifest.json` (`engine_commit`, weights hash,
   environment, `known_quirks` (20), `mds_sign`, `busted_head_missing_keys`,
   `tn93_package: 1.2.2`), `scripts/gen_fixtures.py`. Reviewers should confirm the generator runs
   the functions the way the CLI does (the `cliVariant` cases in `filter` are there because
   `cmd_meme --filter` is a second copy of the OCI screen).
5. **`hyphaeon/export.py` + `scripts/verify_onnx.py`**: the three-output export, the BUSTED head
   graph, the seeded head (§2.3), the tolerance `1e-5·max(1,|lrt|)` and why 1e-6 is unreachable
   in fp32.
6. **CI**: `js.yml` (Node 22, `npm ci`, vitest + fixture replay, tsc, on paths `js/ fixtures/
   models/`; the in-flight edit adds `fixture-coverage.mjs` as a third gate that fails when a
   fixture is replayed by no test), `parity.yml` (Python reference on every example plus the
   harness's self-check; the non-Python surfaces are the app's to produce — the in-flight edit
   writes that contract into the file), `release.yml` (§3.3), `CODEOWNERS` (placeholder team —
   replace or CODEOWNERS does nothing).
7. **`PARITY.md`** and `scripts/parity.py`'s conventions (§6.1 item 1). At `phase-3a` its
   `TOL_GRAPH` is 1e-6 absolute where PLAN §5.4 says `1e-5·max(1,|lrt|)`, it compares the unseeded
   BUSTED head fields, and it knows no tree-free surface, so it prints FAIL on runs the phase
   tables pass. The in-flight rewrite (+986 lines: `TOL_GRAPH_REL = 1e-5`, `BASE_SURFACES` with
   `<surface>-tn93` siblings and a `browser` alias, `compare_dms`, `compare_phenotype`, the seven
   neural-head fields skipped with a note) is what reviewers should read; check it reproduces
   PHASE3.md's table on the same `parity/` files.

**Who decides:** the ML team (owners of `hyphaeon/`) for merge and for D20; the app maintainers
for `js/` review. Both halves are one review under CODEOWNERS once the team exists.

**Blocked on it:** §3 entirely (no tag can be cut from a branch that is not on `main`); the app's
`runtime/package.json` pin (still `file:`); `.github/workflows/ci.yml` `ENGINE_REF` (points at
`phase-3a`, a tag that exists only locally until pushed); §5.2 and §5.3 (both need a published
`@veg/hyphaeon-js`).

### 1.4 What `UPSTREAM.md` must cover (cross-check)

`../HyphAeon/UPSTREAM.md` is the single list of reference-side defects the port replicated and
waits on, in PLAN §5.3 rule 3 order (fix Python → regenerate fixtures → JS follows), with the line,
the user-visible effect, where the port reproduces it, and whether a fix changes numbers. It was
written concurrently with this document and is untracked at the time of writing; the reviewer
should check it against this list, assembled from the phase documents: PLAN §7 items 3 (`hyphaeon.api.run_meme/run_busted`, typed exceptions), 4
(`--progress-json`), 5 (`schema_version` + `provenance` in results; regenerate `examples/*`,
`expected_results/*`), 6 (`diagnose()` in Python with the §4.3 codes), 8 (`list-models --json`) —
none opened (`grep -n schema_version hyphaeon/cli.py` finds nothing; `def diagnose` exists in no
Python module); the "Python quirks replicated" lists in `PHASE1A.md`, `PHASE2A.md`, `PHASE3A.md`;
PHASE2A gap 6 (`max_overlap` dead, float32 cosine > 1, CLI `min_sim` 0.30 vs function 0.35);
PHASE3A gap 6 (tn93 exceptions — now handled upstream by `124c3ea`, differently from the plan's
sentinel; the `[-0:]` slice at `phenotype.py:334`; `leaf_attr @ Y_perms.T` computed twice at
`phenotype.py:432/436`; the unread `background` parameter); PHASE0 gap 11 (PHYLIP multi-line
mis-parse, NEXUS quoted labels, `TREE x = [&R]` rejected, `forward()` micro-batch mis-slice); and
§2.3–2.4 below.

---

## 2. ML-team decisions still open

### 2.1 D20 — canonical MDS eigenvector signs as the default (sign-off needed)

**What.** `feat/js-port` makes `--mds-sign canonical` the default on `meme`, `busted`, `epistasis`,
`dms`, `phenotype`, `filter` (env `HYPHAEON_MDS_SIGN`; `dataset.compute_mds_coordinates(mds_sign=)`).
The rule: for each kept eigenvector, flip the column so its largest-magnitude entry
(`np.argmax(np.abs(col))`, first index on ties) is positive, before the `sqrt(eigenvalue)`
scaling, on the dense and Lanczos paths alike. The library applies the identical rule. `lapack`
reproduces pre-change outputs bit for bit on the same machine and BLAS.

**Why.** The model is not sign-invariant (`mds_proj = nn.Linear(4, …)` on raw coordinates), and
LAPACK `ssyevd`, ARPACK `eigsh` and the library's tred2/tql2 return different signs on some
columns, so without a convention the browser cannot reproduce the CLI (Phase 1 measured
bat_oas1 and RHO missing by 0.12 and 0.26 in LRT). With it, every surface agrees at the graph
class on all five examples (PHASE2.md, PHASE3.md tables).

**The measured effect on the reference's own outputs** (`MDS_SIGN.md`; `scripts/mds_sign_effect.py`;
bundled weights, torch 2.10.0, HyPhy 2.5.65 for camelid/HIV1_RT):

| Example | N | Solver | Columns flipped | max \|ΔLRT\| (site) | median rel. \|ΔLRT\| | Spearman ρ | p ≤ 0.05 calls changed |
|---|---|---|---|---|---|---|---|
| HIV1_RT | 475 | LAPACK | 1, 2 | 3.90e-02 (219) | 9.06e-04 | 0.999962 | 0 / 151 (35 → 35) |
| RHO | 655 | Lanczos | 1, 3 | 5.95e-01 (183) | 1.46e-02 | 0.998792 | **2 / 145** (23 → 25) |
| Smc6 | 20 | LAPACK | 1, 2, 3 | 1.85e-02 (628) | 3.52e-04 | 0.999908 | 0 / 97 (1 → 1) |
| bat_oas1 | 18 | LAPACK | 0, 1 | 5.40e-01 (332) | 1.71e-02 | 0.998433 | 0 / 182 (5 → 5) |
| camelid | 212 | LAPACK | 1, 2 | 2.25e-01 (18) | 1.03e-02 | 0.999170 | 0 / 86 (15 → 15) |

Smc6 `busted`: `p_value_acat` 0.11831563 → 0.11797637, `omnibus_lrt` 3.2854052 → 3.2988663,
`sig_sites_p05` 5 → 5. Every variable site moves by more than the 1e-5 class; rankings are
unchanged (ρ ≥ 0.998); two RHO sites cross p = 0.05.

**Steps.** Reproduce: `HYPHAEON_WEIGHTS=model.safetensors HF_HUB_OFFLINE=1 python
scripts/mds_sign_effect.py --out /tmp/mds_sign` (~70 s). Then one of:
(a) accept canonical (recommended in `MDS_SIGN.md`): merge as is; regenerate `examples/*_results.csv`,
`examples/*.json`, `examples/expected_results/`, `model_eval/` outputs under the new default (PLAN
§7 item 5); record `mds_sign` in result provenance; consider evaluating or fine-tuning on
canonical coordinates (`training_data.py` already goes through `load_alignment_and_tree`, so the
next training run sees them).
(b) keep `lapack` as default: change the default in `dataset.resolve_mds_sign` and the CLI, keep
`canonical` as the flag, regenerate `fixtures/` with `--mds-sign lapack`… and accept that browser,
MCP and server cannot reproduce the CLI on any dataset where the solvers disagree (the plan's
stated alternative).

**Who decides:** the ML team. **Blocked on it:** §1 merge; §3 first release (a default-behaviour
change for existing CLI users belongs in the release notes either way).

### 2.2 D2 — canonical weights, and a HuggingFace tag carrying `manifest.json`

**What is known** (hashes measured today):

| Artifact | sha256 | Where | Role |
|---|---|---|---|
| `model.safetensors` (9,842,824 B) | `0278dff0…` | engine repo root, committed | the suite (backbone + head_meme + head_busted + head_absrel); the `general` variant's weights; `HYPHAEON_WEIGHTS` in every check |
| `models/_hf/model.viral.safetensors` | `b6b0d8d0…` | HF `datamonkey/hyphaeon` (private), local copy | the `viral` variant's weights |
| `models/_hf/model.viral.onnx` (7,786,911 B) | `de765904…` | HF `datamonkey/hyphaeon`; DM3 `static/models/axomeme/` | the **single-output** graph DM3 and Datamonkey's `axomeme_scan` ship today |
| `models/general.onnx` | `aa10e8e0…` | engine, committed | three-output export from the suite |
| `models/viral.onnx` | `c3ea5795…` | engine, committed | three-output export; `verify_onnx.py` checks its `lrt` against `de765904…` within 1e-5 |
| `models/busted_head.onnx` | `2ad554e0…` | engine, committed | the BUSTED head, seeded export (§2.3) |
| `models/manifest.json` | — | engine, committed | all of the above, `model_version: v1`, `reference_version: 1.0.0`, opset 17, taxon caps, PRNG |

**Decision needed.** (1) Confirm `0278dff0…` and `b6b0d8d0…` are the canonical `general` and
`viral` weights for v1 and that no newer checkpoint supersedes them. (2) Publish to
`datamonkey/hyphaeon` under a **tag equal to the git tag** (D19: `v1.0.0`) the six files above
plus `manifest.json`, so `hyphaeon` (Python, via `weights.py` `HF_REPO_ID = "datamonkey/hyphaeon"`)
and the app can pin one revision. (3) Choose how the ONNX graphs and manifest reach the app once
it stops reading `../HyphAeon/models` through `HYPHAEON_ENGINE_DIR` (`scripts/copy-assets.mjs:71`):
neither the wheel nor the npm tarball contains them (§0), and `release.yml` attaches only
`manifest.json` to the GitHub release. Options: add `models/` to `js/package.json` `files` (+16.7 MB
per install), attach the three graphs to the GitHub release and have `copy-assets.mjs` fetch by
tag, or fetch from the HF tag at build time. The plan (§3.3, §5.5) assumed the package carries
them.

**Commands** (needs `datamonkey` org membership; `hf auth login` first; check `hf --help` for the
exact subcommand names on the installed 1.4.1 — the older `huggingface-cli upload` /
`huggingface-cli tag create` forms also exist):

```bash
cd ../HyphAeon
hf upload datamonkey/hyphaeon models/manifest.json manifest.json
hf upload datamonkey/hyphaeon models/general.onnx model.general.onnx
hf upload datamonkey/hyphaeon models/viral.onnx model.viral.v1-three-output.onnx   # do not overwrite de765904… in place: DM3 and datamonkey-js-server pin it by hash
hf upload datamonkey/hyphaeon models/busted_head.onnx busted_head.onnx
hf upload datamonkey/hyphaeon model.safetensors model.general.safetensors
hf repo tag create datamonkey/hyphaeon v1.0.0
hf download datamonkey/hyphaeon manifest.json --revision v1.0.0 && shasum -a 256 …            # verify
```

**Who decides:** the ML team (weights), with the app maintainers on (3). **Blocked on it:** §3
(the release should name the HF revision), §5.2/§5.3 (DM3 and Datamonkey swap models by hash and
must land together — `datamonkey3/CLAUDE.md` § "Updating the AxoMEME model").

### 2.3 The BUSTED neural head has no trained weights in the checkpoint

**What.** `model.safetensors` lacks 11 `BustedMultiTaskHead` parameters
(`fixtures/manifest.json` `busted_head_missing_keys`): `in_proj.{weight,bias}`,
`head_prop.{weight,bias}`, `head_syn_var.{0,2}.{weight,bias}`, `coral_{logp,lrt,omega3}.theta_steps`.
`cli.py:371` loads the backbone with `strict=False` and `cli.py:378` loads the head with
`strict=False`, unseeded, so `predicted_gene_lrt`, `selection_probability`,
`synonymous_rate_variation` and `rate_distributions.*` are **random on every `hyphaeon busted`
run**. `busted_head.onnx` was exported after `torch.manual_seed(0)` (`export.py`
`BUSTED_HEAD_INIT_SEED = 0`): one of the reference's possible outputs, frozen. The e2e fixtures
null those fields; the app flags them "nondeterministic" on the gene card; `parity.py` counts
exactly those seven fields as violations on every busted comparison (PHASE3.md table).

**Decision needed.** Either (a) supply a checkpoint that includes the head (then `hyphaeon
export-onnx --variant all`, `python scripts/verify_onnx.py`, `python scripts/gen_fixtures.py`, and
the app's `runtime/` tests read the new hashes), or (b) declare the neural BUSTED fields not part
of v1 and remove them from the CLI output, the fixtures, the manifest (`busted_head_onnx_sha256`)
and the gene card. The statistical half of `busted` (ACAT, Simes, omnibus LRT, energy) is
deterministic and at parity either way.

**Who decides:** the ML team. **Blocked on it:** a clean `parity.py` run; honest gene-level output.

### 2.4 The codon vocabulary: `dataset.py` vs DataMonkey 3 / AxoMEME

**What.** DM3's port (`src/lib/services/axomeme/tokenizer.js`), byte-identical to the AxoMEME 2.0
training script `train_transformer_selection.py:74-85`, numbers all 64 codons 0..63 in TCAG order
with gap 64 / unknown 65 and amino-acid sentinels 20/21/22, and treats stops as observations in
site variability with a serine two-family rule. `hyphaeon/dataset.py:25-57` numbers the 61 sense
codons 0..60 in TCAG order, sends stops, gaps and unknowns to 64, and has one amino-acid sentinel
(20); variability is on amino-acid tokens only. 54 of 64 codon tokens differ. Measured on
bat_oas1 with the viral weights (CLAUDE.md, Phase 0): DM3's tables give Spearman 0.13 against
`hyphaeon meme`; `dataset.py`'s tables plus the `> 10` rescale give 0.94. The library follows
`dataset.py` (`js/src/preprocess/tokenizer.js` header) and the fixtures pin every token.

**Questions for the ML team.** (1) Confirm the suite (`0278dff0…`) and the HF viral checkpoint
(`b6b0d8d0…` / `de765904…`) were trained with `dataset.py`'s tables (HF `config.json` says
`num_tokens: 66`, which fits either). (2) If so, the numbers DataMonkey 3's "Predict" and
`axomeme_scan` produce **today** come from a different vocabulary than the weights were trained
with; §5.2/§5.3 fix that by construction, and the fix changes users' numbers. (3) DM3's
`HYPHAEON-HANDOFF.md` §1.4 trap 2 records that the ML team's own driver tokenised 63/64 codons
differently from training; that history is why rule 1 of PLAN §5.3 exists.

**Who decides:** the ML team. **Blocked on it:** the wording of §5.2's change note to DM3 users.

### 2.5 New pillars upstream (`splits`, `temporal`)

`main@2641a21` adds two subcommands not in PLAN D3 or the port. Decide whether they are in scope
for the app (each would need a JS mirror, fixtures, and — for `temporal` — a `dates` input the
report has no UI for) or stay CLI-only. Open issues #39 (splits OOM), #40 (temporal on NumPy ≥ 2)
suggest they are not release-ready.

---

## 3. Releases: version bump, tagging, PyPI, npm, `release.yml`

### 3.1 Policy (D19)

The JavaScript library carries the repository tag as its version: `hyphaeon==X.Y.Z` on PyPI ↔
`@veg/hyphaeon-js@X.Y.Z` on npm, from one commit, `models/manifest.json` records the tag
(`reference_version`), and the app pins an exact version and bumps deliberately. `@veg/hyphaeon-mcp`
(0.4.0) and the app's other workspaces version independently — they are runtimes, not mirrors.

### 3.2 Steps to cut a release

```bash
cd ../HyphAeon                                   # on main, after §1 merged
# 1. same version in both manifests (release.yml refuses otherwise)
sed -i '' 's/"version": "1.0.0"/"version": "1.1.0"/' js/package.json
sed -i '' 's/^version = "1.0.0"/version = "1.1.0"/' pyproject.toml
python - <<'EOF'
import json; m=json.load(open('models/manifest.json')); m['reference_version']='1.1.0'
json.dump(m, open('models/manifest.json','w'), indent=2); open('models/manifest.json','a').write('\n')
EOF
git commit -am "Release 1.1.0" && git tag v1.1.0 && git push origin main v1.1.0
# 2. watch: gh run watch --repo veg/HyphAeon
# 3. afterwards, in the app:
#    runtime/package.json  "@veg/hyphaeon-js": "1.1.0"   (replaces file:../../HyphAeon/js)
#    .github/workflows/ci.yml ENGINE_REF: v1.1.0
#    npm install && npm test --workspaces --if-present
```

Whether the first public tag is `v1.0.0` (the version both manifests carry today, matching the
Python package's existing 1.0.0 that was never on PyPI) or `v1.1.0` (because §2.1 changes default
outputs) is a decision for the ML team; D19 only requires the two files and the tag to agree.

**Dry runs (done today, no network):**

```
cd js && npm pack --dry-run
  name: @veg/hyphaeon-js  version: 1.0.0  package size: 195.4 kB  unpacked size: 591.1 kB  total files: 35
cd .. && python -m build --no-isolation --outdir <scratch>
  Successfully built hyphaeon-1.0.0.tar.gz and hyphaeon-1.0.0-py3-none-any.whl   (136,597 B / 109,667 B; 47 sdist entries)
cd ../hyphaeon-app/mcp && npm pack --dry-run
  name: @veg/hyphaeon-mcp  version: 0.4.0  package size: 89.3 kB  unpacked size: 294.2 kB  total files: 14
```

Note `python -m build` without `--no-isolation` needs network to fetch `setuptools>=61` into its
build env; the venv has `build 1.3.0`, `setuptools 80.9.0`, `wheel 0.45.1`.

### 3.3 What `release.yml` does (engine, on `push: tags: v*`)

As committed at `phase-3a`:

| Job | Needs | Steps | Credentials |
|---|---|---|---|
| `verify` | — | `js/package.json` version == tag; `pyproject.toml` version == tag (`tomllib`); `models/manifest.json` exists | none |
| `pypi` | verify | Python 3.11, `pip install build`, `python -m build`, `pypa/gh-action-pypi-publish@release/v1` | **trusted publishing** (OIDC, `id-token: write`, `environment: pypi`) |
| `npm` | verify | Node 22, `npm ci` in `js/`, `npm test`, `npm run build --if-present`, `npm publish --provenance --access public` | `secrets.NPM_TOKEN` (automation token), `id-token: write` |
| `github-release` | verify, pypi, npm | `gh release create <tag> --generate-notes` if none, `gh release upload <tag> models/manifest.json --clobber` | `github.token` (`contents: write`) |

**In flight at the time of writing** (uncommitted in the engine working tree, §6.3): the `npm` job
drops `NPM_TOKEN` and `--provenance` in favour of **npm trusted publishing** (OIDC; provenance is
attached automatically; the job installs npm ≥ 11.5.1 because Node 22 ships an older one); the
`verify` job also requires `MDS_SIGN.md` and recomputes every `models/*.onnx` sha256 against
`manifest.json` so a re-export without a manifest regeneration cannot ship; the GitHub release
gets `MDS_SIGN.md` beside the manifest. Read the file at the tag you release; the items below
cover both variants.

**What must exist before the first tag (none of it does today):**

1. **PyPI project + trusted publisher.** The name `hyphaeon` is free on PyPI and TestPyPI. Register
   a *pending publisher* at https://pypi.org/manage/account/publishing/ with owner `veg`,
   repository `HyphAeon`, workflow `release.yml`, environment `pypi`; do the same on TestPyPI and
   run one tag against it first (change the action's `repository-url` for the trial, or use a
   `workflow_dispatch` copy). Who: whoever owns the PyPI account that will own the project (the
   `pyproject.toml` author is spond@temple.edu).
2. **GitHub environment `pypi`** on veg/HyphAeon (Settings → Environments; optional required
   reviewers). `gh api repos/veg/HyphAeon/environments` returns none today.
3. **npm `@veg` scope and the first publish.** Confirm the org exists and who owns it
   (`npm login && npm org ls veg`; this machine's token is invalid, E401). With the in-flight
   workflow, the trusted publisher is configured on the package's Settings page (GitHub Actions,
   owner `veg`, repository `HyphAeon`, workflow `release.yml`) — which means the package has to
   exist first: publish `@veg/hyphaeon-js` **once by hand** from `js/` (`npm publish --access
   public` as a scope owner), then configure the trusted publisher, then let the tag do the rest.
   PyPI's pending publisher has no such step. With the `phase-3a` workflow instead, create an
   **automation** token and store it as repository secret `NPM_TOKEN`. `js/package.json` already
   has the `repository` block with `directory: js` that provenance requires.
4. **Provenance vs a private repository.** veg/HyphAeon is private today. npm's provenance
   attestation publishes a link to the source repository and commit and is documented for public
   repositories; expect a provenance-attached publish to be refused while the repository is
   private. Decide: make veg/HyphAeon public before the first tag (the plan's public-launch
   intent), or publish the first version without provenance.
5. **A real team in `CODEOWNERS`** (or a user list) — cosmetic for the release, required for the
   review rule the plan describes.
6. **`@veg/hyphaeon-mcp` cannot be installed from npm as it stands.** `mcp/package.json` depends on
   `@veg/hyphaeon-runtime: 0.0.0`, a `private: true` workspace that is never published; the
   dependency resolves only through the workspace link. Publishing `@veg/hyphaeon-mcp` needs one
   of: publish `@veg/hyphaeon-runtime` too (drop `private`, version it, publish first), or bundle
   the runtime into the MCP package (`CLAUDE.md` says "bundling what it needs" — nothing does the
   bundling yet). Also its `@veg/hyphaeon-js: 1.0.0` must exist on npm first. Who: app maintainers.
7. **The app repository itself** (`veg/hyphaeon-app`) has to be created and pushed (`gh repo create
   veg/hyphaeon-app --private --source . --push`), with the `ENGINE_TOKEN` secret §6.3 describes.

**Who decides:** PI / org owners for accounts and visibility; app maintainers for item 6.
**Blocked on it:** the app's pin, §5.2, §5.3, any `npx @veg/hyphaeon-mcp` instruction on `/mcp`.

---

## 4. Deployment (D1) — nothing is deployed

**State.** `deploy/` holds a complete runbook (`deploy/README.md`) and four files with
placeholders: `apache-hyphaeon.conf` (`hyphaeon.example.org`, `/var/www/hyphaeon/build`,
Let's Encrypt paths), `ecosystem.config.cjs` (pm2; `HYPHAEON_SERVER_ISSUER:
"https://hyphaeon.example.org"`, models at `/var/www/hyphaeon/build/models`, data at
`/var/lib/hyphaeon`), `docker-compose.yml` + `Dockerfile` (the server as a linux/amd64 image; build
context is the directory above the app so `../HyphAeon/js` is reachable), `rsync-web.sh`
(`deploy@silverback.example.org`, `/var/www/hyphaeon`; refuses a build without `models/manifest.json`
or `ort/*.wasm`). No DNS record, certificate, vhost, pm2 process, data directory or upload exists.

### 4.1 Domain and origin — decide first

| Option | `HYPHAEON_BASE` at build | Where COOP/COEP is set | Notes |
|---|---|---|---|
| **Own origin** `hyphaeon.hyphy.org` (D1 recommendation) | `''` | its own vhost: `apache-hyphaeon.conf` as written | Same origin for `/`, `/api/`, `/mcp`; the OAuth `resource` is `<issuer>/mcp`; `HYPHAEON_SERVER_ISSUER=https://hyphaeon.hyphy.org`. Needs a DNS A/AAAA record to silverback and `certbot --apache`. |
| Sub-path under the existing host, `data.hyphy.org/web/hyphaeon` (beside axomeme3 at `silverback:/archive/sb-data/shares/web/web/axomeme3/`) | `/web/hyphaeon` | inside the existing `data.hyphy.org` vhost: a `<Directory>`/`<FilesMatch "\.html$">` block for that path only, plus the `ProxyPass` lines for `/web/hyphaeon/api/`, `/mcp` and the OAuth paths | No new DNS or certificate. COOP/COEP on documents under the sub-path do not affect the rest of the host, but `Cross-Origin-Embedder-Policy: require-corp` requires every asset the page loads to be same-origin or CORP-tagged — true for this build (no CDNs), and the e2e asserts it. The server's `webUrl`/issuer become `https://data.hyphy.org` and the proxied paths carry the prefix. |

`web/svelte.config.js` reads `HYPHAEON_BASE` for exactly these two cases. **Who decides:** the PI
(name) and the silverback administrator (vhost, DNS, certificate).

### 4.2 The host needs Node and the model files, nothing else

`deploy/README.md` § "What the host needs": no Python, no HyPhy, no `tn93` binary, no torch, no
HF download — every analysis is JavaScript under `onnxruntime-node` over `@veg/hyphaeon-js`. A
runbook or unit that installs Python "for HyphAeon" is stale. Requirements: Debian/Ubuntu, Apache
2.4 with `proxy proxy_http headers rewrite ssl`, Node ≥ 22.13 **x86-64** (`onnxruntime-node` is
pinned at 1.23.2 for x64; `ONNXRUNTIME_NODE_INSTALL=skip` at `npm install` avoids its CUDA
download on linux/x64), `pm2` (or Docker), certbot.

### 4.3 Steps (from `deploy/README.md`, condensed; replace placeholders first)

```bash
# host
sudo mkdir -p /opt && cd /opt
git clone https://github.com/veg/HyphAeon.git && (cd HyphAeon && git checkout <tag>)      # until the app pins a published @veg/hyphaeon-js
git clone https://github.com/veg/hyphaeon-app.git && cd hyphaeon-app && ONNXRUNTIME_NODE_INSTALL=skip npm install
sudo mkdir -p /var/lib/hyphaeon /var/log/hyphaeon && sudo chown $USER /var/lib/hyphaeon /var/log/hyphaeon
#   edit deploy/ecosystem.config.cjs env: HYPHAEON_SERVER_ISSUER, HYPHAEON_MODELS_DIR, HYPHAEON_DATA_DIR
pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
sudo cp deploy/apache-hyphaeon.conf /etc/apache2/sites-available/hyphaeon.conf   # edit ServerName, paths
sudo a2ensite hyphaeon && sudo apachectl configtest && sudo systemctl reload apache2 && sudo certbot --apache
# build machine
HYPHAEON_BASE='' npm -w web run build && npm -w web run check
HYPHAEON_DEPLOY_HOST=deploy@silverback HYPHAEON_DEPLOY_ROOT=/var/www/hyphaeon deploy/rsync-web.sh
# Docker instead of pm2: docker compose -f deploy/docker-compose.yml up -d --build   (binds 127.0.0.1:7040 only)
```

### 4.4 What the vhost must get right

- **COOP/COEP on every HTML response** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) so `crossOriginIsolated` is true and
  `onnxruntime-web` runs multi-threaded (D13); one thread otherwise. `web/static/_headers` carries
  the same headers for hosts that read that file; Apache does not.
- **MIME types**: `AddType application/octet-stream .onnx`, `application/wasm .wasm`,
  `text/javascript .mjs` — `WebAssembly.instantiateStreaming` rejects the wrong type and COEP
  refuses the fetch.
- **CSP** `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; …` —
  no `'unsafe-eval'` (it left with HyPhy WASM, D22) and no other origin, matching `_headers`.
- **Immutable caching** for `/models/` and `/ort/` (content-addressed by the manifest) and
  `/_app/immutable/`.
- **SSE unbuffered**: `ProxyPass … flushpackets=on timeout=600` for `/api/` and `/mcp`; `no-gzip`
  on the events routes. `LimitRequestBody 10485760` (the server refuses > 8 MiB itself).
- Only Apache listens publicly; Node binds `127.0.0.1:7040`. Never `HYPHAEON_MCP_AUTH=0` on a
  public host (the server logs a banner when the mount is unauthenticated).

### 4.5 The server's environment (`server/src/config.js`)

| Variable | Default | Meaning |
|---|---|---|
| `HYPHAEON_SERVER_PORT` | 7040 | listen port (loopback behind Apache) |
| `HYPHAEON_SERVER_ISSUER` | `http://localhost:<port>` | public `https://` origin: OAuth issuer, the only allowed `Origin`, the `resource` is `<issuer>/mcp` |
| `HYPHAEON_SERVER_EXTRA_ORIGINS` | — | extra allowed origins (development only) |
| `HYPHAEON_MODELS_DIR` | — (required) | `manifest.json` + `.onnx`; sha256 verified at load; `web/build/models` after a build, or `HyphAeon/models` |
| `HYPHAEON_DATA_DIR` | `server/data` | `jobs.sqlite` + `jobs/<id>/` (inputs as submitted, `result.json`, `sections/*.json`) — `/var/lib/hyphaeon` on the host |
| `HYPHAEON_JOB_TTL_MS` | 7 days | sweep every `HYPHAEON_SWEEP_INTERVAL_MS` (10 min) removes expired rows and orphan directories |
| `HYPHAEON_JOB_TIMEOUT_MS` | 10 min | per job |
| `HYPHAEON_SERVER_WORKERS` | 1 (max 8) | worker threads, each with its own ORT sessions (~1 GB RSS with `general` + head) |
| `HYPHAEON_SERVER_THREADS` | 2 | ORT intra-op threads per worker (4 in `ecosystem.config.cjs`) |
| `HYPHAEON_RATE_API` / `_JOBS` / `_MCP` / `_OAUTH` | 120 / 20 / 120 / 60 | per IP per minute |
| `HYPHAEON_TRUST_PROXY` | — | `loopback` under Apache (trust `X-Forwarded-For` from 127.0.0.1 only) |
| `HYPHAEON_MCP`, `HYPHAEON_MCP_AUTH` | on, on | serve `/mcp`; require the OAuth bearer |
| `HYPHAEON_SERVER_LOG` | info | `debug` for the worker's engine lines |

Caps (`mcp/src/caps.js`, shared by the server): alignment ≤ 8 MiB, 3 ≤ taxa ≤ 1,000 (model cap
512 by Faith's PD), codons ≤ 30,000 (`dms` ≤ 3,000), work `L·N²` ≤ 2.5e9, permutations ≤ 10,000,
permulations ≤ 2,000; a refused upload is `422 {error:{kind:"input", code:"CAPS_EXCEEDED"}}`.

### 4.6 Smoke checks after deploy (`deploy/README.md` § Verify)

```bash
curl -sI https://HOST/ | grep -iE 'cross-origin-(opener|embedder)'                 # both present
curl -sI https://HOST/models/manifest.json | grep -i content-type                 # application/json
curl -sI https://HOST/ort/ort-wasm-simd-threaded.wasm | grep -i content-type      # application/wasm
curl -s https://HOST/api/v1/health | jq .;  curl -s https://HOST/api/v1/version | jq .
curl -s https://HOST/api/v1/models | jq '.available, .engine.available, .engine.onnxruntime_node'
# a job end to end (bat_oas1 with its tree), then the same alignment with NO tree (must record tree_source "tn93"),
# then a phenotype job with {preset:"marine"} on RHO — the three jq|curl recipes are in deploy/README.md
curl -s https://HOST/.well-known/oauth-protected-resource/mcp | jq .              # resource == <issuer>/mcp
curl -si -X POST https://HOST/mcp -H 'content-type: application/json' -d '{}' | grep -iE '^(HTTP|WWW-Authenticate)'
claude mcp add --transport http hyphaeon https://HOST/mcp                          # auto-approving OAuth; OOB page on headless machines
```

Then open `/` in a browser, drop `web/static/gallery/inputs/bat_oas1.fasta`, and confirm the
report streams and the provenance panel shows `surface: browser` with threads > 1
(`crossOriginIsolated`). `e2e/smoke.spec.ts` asserts the same headers against `vite preview`; the
production equivalent is the curl lines above.

**Who decides:** silverback administrator (host access, vhost, pm2, backups of
`/var/lib/hyphaeon`), PI (domain). **Blocked on it:** public launch; the axomeme3 redirect (§5.4);
the `/mcp` page's remote-connector instructions (they print the issuer).

---

## 5. Cross-repository integrations deferred to the team

### 5.1 Promote `web/src/lib/viz/` to hyphy-scope (D4)

**Target.** `stevenweaver/hyphy-scope` (npm `hyphy-scope` 1.11.0; the DM3 handoff calls it
`veg/hyphy-scope`, which does not resolve). Its pattern: one Svelte component per analysis in
`src/lib/*.svelte`, pure helpers in `src/lib/utils/<analysis>-{utils,plots}.ts`, everything
re-exported from `src/lib/index.ts`, `svelte-package` + `publint`; dependencies already include
`@observablehq/plot`, `d3`, `phylotree`; peer `svelte ^5`. `AxomemeVisualization.svelte` (the
current HyphAeon-adjacent component) has a scoped `<style>` with its own font stack and **zero**
`:global` rules.

**Candidates** (imports are the boundary; measured today):

| Component | Lines | Imports outside `./` | Verdict |
|---|---|---|---|
| `ManhattanPlot.svelte` + `manhattan.ts` | 354 + 259 | `$lib/results/{derive,entropy}`, `./theme` | promote; move `derive`/`entropy` helpers as `hyphaeon-utils.ts` |
| `RankedSitesPlot.svelte` + `rankedPlots.ts` | 141 + 211 | `$lib/results/derive`, `./theme`, Plot | promote |
| `SiteTable.svelte`, `SparkBar.svelte`, `SummaryTiles.svelte` | 341 / 121 / 116 | `$lib/results/{derive,entropy,types}` | promote |
| `GeneCard.svelte`, `PairTable.svelte`, `SectorPanel.svelte`, `EpistasisNetwork.svelte`, `DmsHeatmap.svelte` | 239 / 133 / 222 / 248 / 246 | `$lib/report/types`, `./theme`, d3 | promote (the epistasis / DMS set the plan names) |
| `PhenotypePlot.svelte` + `phenotypePlots.ts`, `PhenotypeGeneCard.svelte` | 152 + 221 / 244 | `$lib/report/types`, `./theme`, Plot | promote |
| `AttributionPanel.svelte`, `FilterPanel.svelte` | 156 / 182 | `$lib/results/{types,entropy}` | promote |
| `TreePicker.svelte` | 301 | d3, svelte only | promote (or fold into hyphy-scope's `PhylogeneticTreeViewer`) |
| `SiteTreeModal.svelte` | 464 | `$lib/report/displayTree`, `$lib/results/fitch` | app-shaped (knows which tree the model saw); the Fitch-parsimony site tree could join `PhylogeneticTreeViewer` |
| `OverviewStrip.svelte`, `ProvenancePanel.svelte`, `ResultsView.svelte` | 182 / 368 / 249 | `$lib/api`, `$lib/report/status`, `$lib/results/{downloads,mcpSnippet}` | stay — application concerns (URLs, downloads, MCP snippet, run status) |

**The scoped-CSS boundary.** Every viz component here resolves colour from the app's CSS tokens
(`web/src/app.css`: `--tier-strong`, `--tier-moderate`, `--tier-none`, `--brand`, `--accent`,
`--ok`, surface and text colours, `--font-mono`) through `theme.ts`, which reads them off the
document at draw time with light-scheme fallbacks; the four components that style generated SVG
(`PhenotypePlot`, `RankedSitesPlot`, `SiteTreeModal`, `TreePicker`) use `:global(...)` **nested
under the component's own root class** (`.plot__canvas :global(svg)`, `.tree :global(.branch)`),
which is already leak-free. To promote: declare the tokens as CSS custom properties **on the
component's root element with defaults** (so a host without `app.css` renders), keep `theme.ts` as
the resolver (it becomes `hyphaeon-theme.ts`), keep the nested-`:global` pattern, move the data
types (`$lib/report/types`, `$lib/results/types`) into `utils/hyphaeon-types.ts`, and leave the
"what the app did to your data" strip in the app (the DM3 handoff's split: plots are a property of
the analysis, caveats of the application). Then `web/` imports `hyphy-scope` and deletes the
copies, as DM3 does for `AxomemeVisualization`.

**Who decides:** the hyphy-scope maintainer. **Blocked on it:** nothing in the app; DM3's §5.2
switch benefits from it (one visualisation for both).

### 5.2 DataMonkey 3: "Predict" switches to `@veg/hyphaeon-js` (D14)

**What.** Replace `datamonkey3/src/lib/services/axomeme/` (10 files, 2,013 lines: `modelContract`,
`newick`, `patristic`, `symmetricEigen`, `mds`, `tokenizer`, `assemble`, `postprocess`,
`callModes`, `session`) with the library (`loadAlignmentAndTree`, `siteBatch`, `validateInputBundle`,
`memeSitePq`, `callModes`) and the app's `runtime/` pieces (`session-web.js`, `manifest.js`,
`postprocess.js`), and vendor the three-output graphs + `manifest.json` instead of
`static/models/axomeme/axomeme_v1_viral_finetuned.onnx` (`de765904…`).

**Why.** The library mirrors `dataset.py`; DM3's port does not (§2.4: vocabulary, `> 10` rescale,
MDS on the real N, sign convention, variability rule). DM3's numbers will change; the
`HYPHAEON-HANDOFF.md` §1.6 coupling hazard (two model copies, two hash pins, two policies)
collapses into one manifest.

**DM3 files** (`stevenweaver/datamonkey3@fac1330`; the handoff's §4 wiring list plus today's grep):
`src/lib/services/axomeme/*`, `src/lib/services/AxomemeAnalysisRunner.js`,
`src/lib/services/BackendAnalysisRunner.js` (`case 'axomeme'`), `src/lib/AnalyzeTab.svelte` (the
two tree gates — a tree is now optional, D22), `src/lib/AnalysisResultViewer.svelte`,
`src/lib/AxomemeResults.svelte`, `src/lib/MethodSelector.svelte` (`SUPPORTED_METHODS`,
`METHOD_INFO`, execution-mode logic, call-mode copy), `src/lib/config/methodAdvancedOptions.js`,
`src/lib/config/methodOptions.toml`, `src/routes/+page.svelte` (`methodConfig.AxoMEME`),
`src/lib/RunOutlook.svelte`, `src/lib/MemeHitLikelihood.svelte`, `src/stores/analyses.js`,
`src/stores/analysisConfig.js`, `src/lib/utils/executionAdvice.js`, `src/lib/utils/runStatusLine.js`,
`static/models/axomeme/`, `src/test/axomeme-*.test.js` (149 cases; `axomeme-model-contract.test.js`
is designed to fail on a model swap and must be updated to the new contract, not deleted),
`e2e/19-axomeme.spec.js` (keep its URL assertions), `scripts/axomeme/` (parity harnesses against
the old driver — retire; the fixtures and `parity.py` replace them), `CLAUDE.md` § "Updating the
AxoMEME model".

**Steps.** Needs `@veg/hyphaeon-js` on npm (§3) and the models delivery decided (§2.2 item 3).
Then: `npm i @veg/hyphaeon-js@X.Y.Z`; copy `models/manifest.json` + `general.onnx` + `viral.onnx`
into `static/models/hyphaeon/`; port `session.js` → the runtime's `session-web.js` pattern (verify
hash from the manifest, `onnxruntime-web/wasm` entry, `wasmPaths` to `static/ort/`); run
`AxomemeAnalysisRunner` through `loadAlignmentAndTree` + `siteBatch` + `predict` + `memeSitePq`;
drop the "tree with branch lengths required" gate in `AnalyzeTab.svelte` in favour of the TN93
path; keep `is_surrogate` / `surrogateFor`, the percentile default and the "not scored" rule; add
the D20/§2.4 change note to the results view ("numbers differ from earlier runs because …");
re-record `e2e/19-axomeme.spec.js` expectations. Land in the same release as §5.3 (both pin the
model by hash; `datamonkey3/CLAUDE.md` "Both sides must swap together").

**Who decides:** the DM3 maintainer, with the ML team on the change note. **Blocked on it:** §3,
§2.2, §2.4.

### 5.3 Datamonkey MCP: mount `@veg/hyphaeon-mcp`, retire `axomeme_scan`

**What.** `veg/datamonkey-js-server@1e84d6f` `lib/mcp/tools.js:519-721` implements `axomeme_scan`
(synchronous, capped at 8 MiB / 12,000 codons / work 2.5e9 — the figures `mcp/src/caps.js` cites
by line), with `lib/axomeme/` (`cli.js`, `predict.js`, `session.js`, `model/`, `vendor/` = a CJS
copy of DM3's port), `app/axomeme/` (`axomeme.js`, `axomeme.sh`, `descriptor.js` — the SLURM job
path), `lib/mcp/resources.js:10,99,262,292-294`, `lib/mcp/prompts.js:10,401`, `test/axomeme/`.
PLAN §3.6 mounts this app's tool module there instead, so the claude.ai Datamonkey connector
exposes `hyphaeon_analyze`, `hyphaeon_meme`, `hyphaeon_busted`, `hyphaeon_epistasis`,
`hyphaeon_dms`, `hyphaeon_phenotype`, `hyphaeon_evaluate`, `hyphaeon_validate`, `job_status`,
`get_results`, `cancel_job`, `list_models` (12 tools; `mcp/src/tools.js` `TOOL_NAMES`).

**Shape mismatch to resolve.** datamonkey-js-server is CommonJS (`require`) and registers with
`registerTools(mcpServer, redisClient, notifier)`; `@veg/hyphaeon-mcp` is ESM with
`registerTools(server, deps)` (`mcp/src/tools.js:704`), `createServer(opts)`, `mountHttp(app, opts)`
(`mcp/src/http.js:63`). Mount through `await import('@veg/hyphaeon-mcp/tools')` inside the CJS
module, pass an engine built from `@veg/hyphaeon-runtime` under the server's own
`onnxruntime-node` (already pinned 1.23.2 there, `package.json:31`), and reuse Datamonkey's OAuth,
redis notifier and rate limits; the job tools (`job_status`, `get_results`, `cancel_job`) collide
by name with Datamonkey's own — namespace one side or route by job-id prefix. Then delete
`axomeme_scan`, `lib/axomeme/`, `app/axomeme/`, the `axomeme` entries in resources/prompts, and
`test/axomeme/`; keep the caps. Best-effort completion notifications and polling as the source of
truth are the same on both sides (`deploy/README.md` § MCP notifications).

**Who decides:** the datamonkey-js-server maintainer. **Blocked on it:** §3 item 6 (a publishable
`@veg/hyphaeon-mcp`), §2.2 (one model hash for DM3 and the server).

### 5.4 axomeme3 → redirect to the new site

**What.** `veg/axomeme3` is a single `index.html` + `MEME_transformer.onnx` (the AxoMEME 2.0
five-input model) with CDN dependencies and a HyPhy WASM branch-length fit, live at
https://data.hyphy.org/web/axomeme3 from `silverback:/archive/sb-data/shares/web/web/axomeme3/`
(its README's rsync line). D14: at launch it redirects here; the app's `/report/gallery/<name>/`
pages are the successors of its demos.

**Steps.** After §4 is live: either replace `index.html` in that directory with a page that
`<meta http-equiv="refresh" content="0; url=https://HOST/">` plus a one-line notice (keeps the
directory, no vhost change), or add `Redirect 301 /web/axomeme3 https://HOST/` to the
`data.hyphy.org` vhost. Update the axomeme3 README and archive the repository. **Who decides:**
the axomeme3 owner and the silverback administrator. **Blocked on it:** §4.

### 5.5 DM3's `HYPHAEON-HANDOFF.md` (`fac1330`, 2026-09-04): what is now superseded

| Handoff item | Status after Phase 3 |
|---|---|
| §1.2 the artifact: `de765904…`, 4-in / 1-out, pull `--revision v1-viral` | Superseded: three-output `viral.onnx` `c3ea5795…` (drop-in for `lrt` within 1e-5, `verify_onnx.py`), `general.onnx` `aa10e8e0…`, `busted_head.onnx`, one `manifest.json` (§2.2) |
| §1.3 "preprocessing is not in the graph … this is the asset" | Superseded by `@veg/hyphaeon-js` mirroring `dataset.py` with per-function fixtures; DM3's port was the Phase 0 seed and is now divergent (§2.4) |
| §1.4 trap 1 (TCAG order) | Holds |
| trap 2 (the driver's tokenizer bug; "implement the training tokenizer") | Inverted: the library implements `dataset.py`'s tables, which the shipped checkpoint wants (§2.4); DM3's "training tokenizer" is the 2.0 script's |
| trap 3 (gap 64 / unknown 65; AA 21/22; `< 64 & < 21` gate) | Superseded: `dataset.py` uses 64 for stop/gap/unknown and 20 for the AA sentinel |
| trap 4 (MDS on the padded 512×512) | Superseded: MDS on the real N (dense; ≤ 6.4e-7 from ARPACK at N = 655) |
| traps 5, 6, 7, 10 (site-invariant tensors; species order from the tree; negative lengths clamped and recorded; `lrt` is ordinal-decoded in-graph) | Hold; `treeSanitation.js` is in `runtime/` |
| trap 8 (serine two-family rule; stops as observations) | Superseded by `dataset.py:718-723`'s rule (amino-acid tokens only) |
| trap 9 ("eigenvector parity is bounded in principle … don't promise bit parity") | Superseded by D20: exact per-column agreement with no sign allowance is now the test |
| §1.5 delivery discipline (`onnxruntime-web/wasm`, vendored WASM, dynamic import, memoise verified sessions) | Holds; `runtime/src/session-web.js`, `scripts/copy-assets.mjs`, e2e URL assertions. `numThreads = 1` superseded by COOP/COEP (D13) |
| §1.6 three surfaces, two model copies, two policies (dropped heads; taxon cap) | Superseded by one manifest (`dropped_heads_policy: omit`, `taxon_cap: 512`, `default_taxon_cap: 256`) once §5.2/§5.3 land |
| §1.7 result shape (`isSurrogate`, `summary.matchedFromTree`) | Carried as `is_surrogate`/`surrogate_for` and the `provenance.preprocessing` block (PLAN §3.5) |
| §1.8 visualisation in hyphy-scope, caveat box in the app | The split holds; §5.1 is the promotion |
| §2 MEME hit-likelihood prescreen | Taken whole: `runtime/src/prescreen/` (`meme_gate.json` read as bytes) |
| §3.1 MDS on the main thread | Superseded: workers |
| §3.2, §3.3 two copies, two `modelVersion` strings | Superseded: `manifest.json` `model_version` |
| §3.4 doc drift ("AxoMEME 2.0", "five tensors") | Moot once `src/lib/services/axomeme/` is deleted |
| §3.5 `prior_shift` unreachable | Holds; a calibration shift still needs a re-export |
| §3.6 **the corpus problem** — port parity is not model quality | **Still open.** Nothing in either repository evaluates the model on MEME results it did not train on; `model_eval/` and the manuscript's numbers are the only evidence, and PLAN §2 items 1–3 are still the honest description |

---

## 6. Known gaps carried out of Phase 3 and Phase 4

### 6.1 From `PHASE3.md` (and the engine phase documents)

1. **`parity.py` conventions.** At `phase-3a` it compares `hyphaeon_lrt` at `TOL_GRAPH` = 1e-6
   **absolute** where PLAN §5.4 is `1e-5·max(1,|lrt|)`; it compares the seven unseeded BUSTED head
   fields (§2.3); it holds epistasis `fdr_q`/`p_hyper` to 1e-9 across inputs that differ at the
   graph class; it has no `node-tn93`/`web-tn93` surfaces (their reference is
   `fixtures/e2e/*_tn93.json`, not `parity/python/`) and no `phenotype` or `dms` comparator
   (`KNOWN_SURFACES = ("python", "node", "web", "mcp")`, `scripts/parity.py:78` at the tag). So it
   prints `FAIL` on runs the phase tables pass (PHASE3.md: `reference runs: 15 (0 failed);
   comparisons: 11; missing: 19; violations: 384 … FAIL`, then every node comparison re-evaluated
   at the plan's classes passes). **Being closed in the engine working tree at the time of
   writing** (uncommitted, §6.3): `BASE_SURFACES` plus `<surface>-tn93` siblings and a `browser`
   alias, `ANALYSES` with `dms` and `phenotype`, `TOL_GRAPH_REL = 1e-5`, `TOL_DERIVED = 1e-6`,
   `STAT_NULL_REL = 0.02`, the neural-head fields skipped with a note. The app's in-flight
   `ci.yml` already invokes `--surfaces python,node,node-tn93`, which only that rewrite accepts;
   until both land together the parity job is red for a naming reason, not a numerical one. The
   layout the runner writes is documented in `runtime/scripts/parity-node.mjs`'s header and each
   run's `summary.json`.
2. **RHO phenotype in the browser vs the fixture.** `fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json`
   was generated without `--max-species` (655 taxa); the app caps at 256 by default (hard max 512,
   PLAN §4.2), so the browser scores a Faith's-PD subsample: 124 of 145 sites shared, 17 called
   against 22, ρ(association_rho) 0.83 on the shared sites. Element-wise comparison needs an
   uncapped surface (the node runner passes `maxSpecies: Infinity` for `meme`, and passes), not a
   tolerance. Options: a fixture generated with `--max-species 256`, or an uncapped browser path
   for parity runs only.
3. **`p_perm` at B = 1,000.** The browser's Smc6 epistasis runs B = 1,000 (`e2e/`) against a
   reference at B = 10,000: `null_coherence_std` differs by 3.2 % (0.00374) — the estimator's own
   Monte Carlo error at that B (PHASE2A.md measured ±0.03 absolute / ±5 % per side at B = 1,000;
   B = 100,000 with three seeds a side agrees to < 1 %). PLAN §5.4's "null moments within 2 %" is
   only meaningful from B ≈ 10,000. A UI printing `p_perm = 0.093` to three decimals at B = 1,000 is
   printing noise; the report should show the B and round accordingly, or run 10,000 in the worker.
4. **PLAN.md vocabulary drift** (not the integrator's to edit): §4.0 row 1 / §4.2 still describe
   HyPhy branch-length estimation; §3.5's `tree_source` list has `hyphy-hky85`/`nj` where the
   recorded values are `user | embedded | tn93` with `nj` only as `display_tree_source`; §3.6 and
   D16 still describe the bridge as live; §5.1/§5.4 cite `dataset.py:443-521` (now 493-571 /
   598-636 at `61d30e3`, and moving again on `main`).
5. **Permulation cost in the browser** (PHASE3A gap 4): two L × B float64 matrices (~56 MB at RHO's
   L = 349, B = 10,000) in the analyze worker; a chunked B loop or a cap tied to L before offering
   10,000 on a long gene.
6. **Diagnostics thresholds** (PHASE3A gap 3): depth is now judged on TN93 distances when there is
   no tree, so camelid newly trips `DEEP_LARGE_TREE` and HIV1_RT `SHALLOW_TREE`; neither is wrong,
   both are new; the regime line does not yet say the judgement came from distances. Also PHASE1A
   gap 6: `SHALLOW_TREE` flags Smc6 (the general model's own regime), `STAR_LIKE` fires below 5
   haplotypes, `COST_ESTIMATE` uses a CPU-torch constant. Product review wanted; PLAN §7 item 6
   should give the Python `diagnose()` the same numbers.
7. **A locally-run record does not store its alignment**, so the site-tree modal cannot draw on a
   report the reader just ran (prebaked and server records draw). D22 makes this sharper: the
   reader who supplied no tree is the one who wants the NJ tree.
8. **e2e coverage**: no trait-table or pick-on-the-tree phenotype run, no B > 0 permulation run
   (needs its own fixture at the statistical class).
9. **Over-budget DMS does not hand off to the server** (PHASE2.md gap 5): `dms.skipped` carries the
   work and the budget, the page names the server, nothing posts the job.
10. **Two caveats files**: `web/caveats.json` (24, validated at build) and `mcp/caveats.json`
    (served as `hyphaeon://caveats`, validated by nothing).
11. **Delivery**: `web/static/_headers` and `deploy/apache-hyphaeon.conf` agree but are two files;
    no woff2 vendored (the font stacks fall back); `onnxruntime-node` pinned at 1.23.2 (darwin/x64
    under Rosetta; bump together with an arm64 Node).
12. **`server/src/runner.js` `composeReportFallback`** is dead against the current runtime, kept as
    the documented degradation path.
13. **Gallery prebake cost**: every edit under `runtime/src` rebakes all five examples at the next
    build (3 min at 8 threads locally; 3–5 min on a 4-vCPU runner per `ci.yml`).
14. **Engine-side**: Lanczos MDS for N > 500 is not ported (dense agrees to 6.4e-7 on RHO, the one
    example that reaches it); `loadAlignmentAndTree` has no `mdsSign` option (PHASE2A gap 9);
    BLAS `sgemm` is not reproducible so the cosine class stays 1e-6, not bit-equality (PHASE2A gap
    4); the reference prefers the `tn93` binary and nothing checks binary-vs-package equality in CI
    (PHASE3A gap 8; `main@2641a21` now calls the binary at threshold 100, §1.2); `examples/` has
    five alignments, not the six PLAN §3.3 mentions.

### 6.2 What the CI cannot run without the private engine checkout

- **The app's tests, build and e2e need `../HyphAeon` beside the checkout**: `runtime/package.json`
  links `file:../../HyphAeon/js`; the runtime, MCP and server suites read `../HyphAeon/models/`
  (`HYPHAEON_MODELS_DIR`) and replay `../HyphAeon/fixtures/`; `copy-assets.mjs` copies the graphs
  from `HYPHAEON_ENGINE_DIR` (default `../HyphAeon`); the prebake and the e2e compare against
  `fixtures/e2e/`. The in-flight `ci.yml` checks out `veg/HyphAeon` at `ENGINE_REF` with a
  fine-grained PAT (`ENGINE_TOKEN`, Contents: read) — a repository secret that has to be created,
  and that pull requests from forks never receive (their runs fail at that step by design).
- **The engine's `parity.yml` never gets a `node` surface** — the runner is in the app; the job
  passes on the Python side alone (`PARITY.md`). The app's `ci.yml` `parity` job is the one that
  runs both sides, and it needs §6.1 item 1.
- **`model_eval.yml`** needs `secrets.HF_TOKEN` (private HF repo) and mamba (`hyphy=2.5.101`,
  `seq-gen`), while the fixtures were generated with native HyPhy 2.5.65 — only relevant if the
  fixture generator ever runs in CI (it does not today; camelid's HyPhy-fitted cases need `hyphy`
  on PATH, PHASE0.md check 4).
- **`release.yml`** cannot run at all until §3.3's accounts and secrets exist.

### 6.3 Phase 4 work in flight in both repositories (uncommitted at 2026-09-05 13:45)

Observed with `git status --short --untracked-files=all`; owned by other builders and still
changing, listed here only so the reader knows the tags are not the last word. `git status` is
authoritative; `PHASE4.md` (app) and the engine's Phase 4 record are the documents to read when
they land.

- **App**: `.github/workflows/ci.yml` (new: two jobs, `app` and `parity`, sibling checkout of
  `veg/HyphAeon` at `ENGINE_REF: phase-3a`, `ENGINE_TOKEN`, `ONNXRUNTIME_NODE_INSTALL: skip`,
  Playwright with the `github` reporter, `parity.py --surfaces python,node,node-tn93`); `.nvmrc`
  (`22`); `runtime/src/pipeline.js` (+138: the user's topology kept for display with unit branch
  lengths — `DISPLAY_TREE_SOURCES` gains `user-topology`; D6's Phase 4 polish item) with
  `runtime/test/{pipeline,no-hyphy}.test.js`; `web/src/lib/report/{ReportView,PhenotypeSection}.svelte`,
  `displayTree.ts`, `phenotype.svelte.ts`, `alignmentBlock.ts` (new), `siteViews.test.ts` (new),
  `web/src/lib/storage/reports.ts`, `web/src/lib/api.ts` (a locally-run record now stores what the
  site-tree modal needs — §6.1 item 7); `web/src/routes/mcp/{+page.svelte,+page.server.ts,tools.ts,page.test.ts}`
  (the `/mcp` page generated from the tool module); `mcp/src/engine.js` + test; `README.md` (+153)
  and `CLAUDE.md` (+78, a "Phase 4: CI and repository hygiene" release note).
- **Engine**: `scripts/parity.py` (+986/−: §6.1 item 1) with `PARITY.md` rewritten to match
  (`python-tn93` reference runs, `node-tn93`/`web-tn93` surfaces, `browser` alias, `dms` and
  `phenotype` comparators, a "graph, delta" class for DMS differences, statistical bounds that use
  each side's own B); `scripts/gen_fixtures.py` (+89: PHASE1A's fixture-convention defects —
  relative MDS tolerance with a floor of 1, `inputs.dtype` on the float32 stats cases, per-site
  LRTs and `is_invariable` on the busted cases) with the regenerated `fixtures/{manifest.json,
  dataset/compute_mds_coordinates.json, stats/*.json, e2e/busted_{Smc6,HIV1_RT,Smc6_tn93}.json}`
  and the replays that read them (`js/test/{fixtures,numeric-stats,omnibus}.test.js`);
  `.github/workflows/{js,parity,release}.yml` (§1.3 item 6, §3.3); `README.md`; `UPSTREAM.md`
  (new, §1.4). The check tails in §7.3 were taken before these edits; rerun `cd js && npx vitest
  run && node scripts/fixture-coverage.mjs` and `python -m pytest tests/ -q` once they are
  committed.

---

## 7. How to resume in a new session

### 7.1 Tags and checkouts

| Repository | Path | Branch | Tags (all local) | Head |
|---|---|---|---|---|
| `veg/HyphAeon` (engine) | `../HyphAeon` | `feat/js-port` | `phase-0` `267f5cf`, `phase-1a` `cf838ab`, `phase-2a` `61d30e3`, `phase-3a` `61d681a` | `61d681a` + uncommitted Phase 4 edits (§6.3); base `main@3cb9cc6`; `origin/main` at `2641a21` (§1.2) |
| `veg/hyphaeon-app` (app) | this directory | `main` | `phase-0` `c4e4102`, `phase-1` `beda8bd`, `phase-2` `353b8d2`, `phase-3` `a428530` | `a428530` + uncommitted Phase 4 edits (§6.3); no remote |

The two must sit side by side as `HyphAeon/` and `hyphaeon-app/` (the `file:` link, `copy-assets`,
the parity runner and `ci.yml` all assume it). Sibling reference checkouts, read-only:
`../datamonkey3` (`fac1330`), `../datamonkey-js-server` (`1e84d6f`), `../hyphy-scope` (`cdfbaab8`),
`../axomeme3` (`b365cc6`), `../axomeme` (`0910277`), `../hyphaeon-manuscript`.

### 7.2 Rebuild the Python reference venv (parity and fixtures only; never at product runtime)

The scratch venv used for every phase was Python 3.14.0 with: torch 2.10.0, numpy 2.3.3,
scipy 1.16.2, pandas 3.0.5, networkx 3.6.1, biopython 1.85, safetensors 0.8.0,
huggingface_hub 1.4.1, tn93 1.2.2, onnx 1.22.0, onnxruntime 1.29.0, lxml 6.1.0, pytest 8.4.2,
build 1.3.0, setuptools 80.9.0, wheel 0.45.1; `hyphaeon` editable from `../HyphAeon`. The
`fixtures/manifest.json` `environment` block records the versions the committed fixtures came from
(the writers' byte-parity references depend on pandas 3.0.5 / lxml 6.1.0 / networkx 3.6.1 /
Python 3.14 formatting).

```bash
python3.14 -m venv hyvenv && . hyvenv/bin/activate
pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu
pip install -e '../HyphAeon[all]' onnx==1.22.0 onnxruntime lxml build
export HYPHAEON_WEIGHTS=$PWD/../HyphAeon/model.safetensors HF_HUB_OFFLINE=1
# native tools the generator needs: hyphy 2.5.65 on PATH (camelid/HIV1_RT HyPhy-fitted cases); the tn93 binary is
# hidden by gen_fixtures.py on purpose so the package path is what the fixtures pin (PHASE3A.md)
```

Node: 22.x (`.nvmrc` says 22; this machine ran v22.22.0 x64 under Rosetta), npm 10.9; `npm install`
at the app root only (never inside a workspace — the root lockfile is the only lockfile).

### 7.3 Check commands per repository, and what they printed on 2026-09-05

Engine (`cd ../HyphAeon`, venv active, the two exports above):

| Command | Printed today |
|---|---|
| `cd js && npx vitest run` | `Test Files  29 passed (29)` / `Tests  1067 passed (1067)` / `Duration  8.61s` |
| `cd js && npm run typecheck` | `tsc --noEmit -p tsconfig.json` (silent) |
| `cd js && node scripts/fixture-coverage.mjs` | `48/48 fixture files read by a test` |
| `python -m pytest tests/ -q` | `252 passed, 2 skipped, 1 warning in 41.51s` |
| `python scripts/parity.py --examples Smc6 --surfaces python --out <scratch>` | `reference runs: 3 (0 failed); self-check violations: 0; comparisons: 0; missing: 0; violations: 0` / `[parity] PASS` |
| `python scripts/verify_onnx.py` (only after a re-export) | expected `[✓] All checks passed` (PHASE0.md check 2; not re-run today) |
| `python scripts/gen_fixtures.py` (only after a Python change; rewrites `fixtures/`) | ~75 s; needs `hyphy` on PATH |

App (`cd hyphaeon-app`, `export HYPHAEON_MODELS_DIR=$PWD/../HyphAeon/models`):

| Command | Printed today |
|---|---|
| `npm install` | links `@veg/hyphaeon-js` → `../../HyphAeon/js` (PHASE3.md check 1) |
| `npm test --workspaces --if-present` | runtime `22 passed / 294 passed` (29.7 s); web `11 / 79`; mcp `10 / 113` (32.8 s); server `5 / 57` (14.6 s) |
| `cd web && npm run check` | `COMPLETED 571 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| `cd web && HYPHAEON_PREBAKE=force npm run build` | ~3 min at 8 threads; `[copy-assets] ort: copied 2 files (13.3 MB)`, `models: copied 4 files (16.7 MB)`, five gallery reports (PHASE3.md check 5; not re-run today) |
| `cd e2e && npx playwright test --reporter=list` | `60 passed (29.3s)` (PHASE3.md check 6; needs the build; not re-run today) |
| `node runtime/scripts/parity-node.mjs --examples all --analyses meme,busted,epistasis,dms,phenotype --busted-examples all --dms-examples Smc6 --phenotype-examples RHO --threads 6` | `wrote 17 file(s) to ../HyphAeon/parity/node; 0 failed` + 6 tree-free files in `parity/node-tn93` (PHASE3.md check 7; 2:28 wall; writes into the engine checkout's gitignored `parity/`) |
| `cd ../HyphAeon && python scripts/parity.py --examples all --surfaces python,node,web` | prints `FAIL` by its own conventions (§6.1 item 1); read `parity/report.json` and PHASE3.md's table |
| `node mcp/bin/hyphaeon-mcp.js` | stdio MCP, `serverInfo {"name":"hyphaeon","version":"0.4.0"}`, 12 tools (PHASE3.md check 11) |
| `cd server && HYPHAEON_MODELS_DIR=../web/static/models npm start` then `curl -s localhost:7040/api/v1/health` | the server on 7040 (`deploy/README.md`) |

### 7.4 Reading order for a newcomer

`PLAN.md` §0–§3 and §9; this file; `PHASE3.md` (the current map of the app) and
`../HyphAeon/PHASE3A.md` (the current map of the library); `CLAUDE.md` § "The split" and
"Why-config"; `../HyphAeon/js/src/README.md`; `../HyphAeon/PARITY.md`; `deploy/README.md`.
