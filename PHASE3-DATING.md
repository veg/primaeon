# Phase 3 — model-free dating (ChronAeon OLS)

PLAN-TEMPORAL.md phase 3. Recorded 2026-09-12, after the work was done and checked.

## 1. What a reader can now do

Drop a dated alignment on `/time`, pick a root, and read the date of its common ancestor with a
95 % confidence interval, a clock rate, a curvature test and a per-sequence table — computed in the
browser from pairwise distances alone, with no model loaded and nothing sent off-origin.
On `examples/korber_env_gp160.fasta` the page reports the reference's own published fit, 1893.9
[1850.9, 1916.8], to the last digit it displays.

## 2. What landed

**Engine — `../HyphAeon`, branch `feat/date-parsers`, head `93645e3`** ("Generate the dating
fixtures from the reference, and land on its published fit"). Three commits: `8ce7048` the numeric
kernel (`tPpf`, `normPpf`, `fSf`, `fCdf`, `percentile`, `brentq`), `b14e7d0` the estimators
(`runOlsDating`, `computeFiellerMrcaInterval`, `computeDeltaMrcaInterval`, `computeRcsBasis`,
`runRestrictedSplineClockDating`, `clockFittedAndPredicted`, `precisionWeightedEnsemble`,
`computeTreeFreeDivergences`, the consensus roots, the rectangular TN93), `93645e3` the fixtures and
their replay. Public surface 256 → 287 names, pinned by `test/index.test.js`.

**App — this repository, branch `feat/dating-ols`, head `d4677d4`** ("Check the section against a
real run, not against a fixture of itself"). Six commits over `7d7a4c6`:

- `9387ff1`, `67aa73c` — `runtime/src/dating/` (7 new files) behind the new subpath export
  `@veg/hyphaeon-runtime/dating`, plus `runtime/test/dating-port.test.js`. The module imports only
  `@veg/hyphaeon-js`, its own siblings and `../dates/codes.js`: no manifest, no session, no
  `node:fs`. That boundary is asserted, not merely intended.
- `5073424`, `2322ae3`, `f44b87b`, `d4677d4` — `web/src/lib/time/dating.ts` (the deciding and the
  saying), `DatingSection` / `DatingFigure` / `TaxonDatingTable`, `datingDownloads.ts`, a
  cancellable `dating.worker.ts` (58 KB built, zero occurrences of `onnxruntime`), the record schema
  at `TIME_SET_SCHEMA_VERSION` 2, and two new numbered sections on `/time`.

31 files changed, 16 of them new. `runtime/src/clockRegression.js`, `rootToTip.js` and `clock.js`
are byte-identical across the whole diff — the independent check stayed independent. `.github/` was
not touched.

## 3. The numbers

This is the section that says the port is right. Every figure below was reproduced for this report
by calling `runDating` directly and diffing against the reference's own output, not by reading it
off a builder's summary.

`hyphaeon dating -a examples/korber_env_gp160.fasta --root-taxon CONSENSUS --no-tree --method ols`:

| Field | Reference | Ours | Difference |
|---|---|---|---|
| `mu` | 0.0011690322000749895 | 0.0011690322000749895 | **0 — bit-identical** |
| `t_mrca` | 1893.91095511759 | 1893.91095511759 | **0 — bit-identical** |
| `p_value` | 1.569958274494354e-9 | 1.569958274494354e-9 | **0 — bit-identical** |
| `ensemble.t_mrca` | 1893.91095511759 | 1893.91095511759 | **0 — bit-identical** |
| `spline.delta_aic` | 3.2696711294240686 | 3.2696711294240686 | **0 — bit-identical** |
| `d0` | 0.11415106391019024 | 0.11415106391019023 | 1.4e-17 |
| `se_mu` | 0.00018073676662794878 | …76 | 2.7e-20 |
| `rmse` | 0.007907117740165328 | …27 | 1.7e-18 |
| `r2` | 0.23135174335911296 | 0.23135174335911318 | 2.2e-16 (1 ulp) |
| `ci_fieller[0]` | 1850.9002455209902 | 1850.900245520545 | 4.45e-10 yr (14 ms) |
| `ci_fieller[1]` | 1916.7928463014516 | 1916.7928463015778 | 1.26e-10 yr (4 ms) |
| `fieller_g` | 0.09343971122537506 | 0.09343971122671851 | 1.3e-12 |
| `ci_delta` | [1864.0411349860476, 1923.7807752491324] | [...985833, ...249347] | 2.1e-10 yr |
| `spline.f_stat` | 5.255140428205752 | 5.25514042820602 | 2.7e-13 |
| `spline.p_f_test` | 0.023394714664289055 | 0.023394714664285332 | 3.7e-15 |
| `spline.t_mrca` | 1938.7746674292187 | 1938.774667417826 | 1.14e-8 yr |

`n` = 141 on both sides; 143 sequences, 142 dated, `Z59ZR.ZHU` the single coverage holdout; zero
outliers. `selected_clock` is **byte-equal**: `Restricted Spline (rate deceleration (0.04x)
detected: F=5.26, p=0.0234, ΔAIC=+3.3)`.

All 142 `taxa_summary` rows match in order and name (0 mismatches). Worst per-column difference:

| Column | Worst |Δ| |
|---|---|
| `root_divergence` | **0 — exact** |
| `fitted_divergence` | 1.48e-11 |
| `z_score` | 1.90e-9 |
| `predicted_date` | 4.53e-7 yr |
| `temporal_residual` | 4.53e-7 yr |

`prediction_method` splits 118 spline / 12 linear_arm / 12 linear_fallback, exactly as measured.

**Where the differences come from, since none of them is ours to fix.** The two Fieller endpoints
are inherited from scipy: its own `t.ppf(0.975, 139)` is 8.1e-13 out *in probability* (cephes'
`stdtri` polishes loosely), and korber's 97.7-year lever arm turns that into sub-nanosecond calendar
time. The library's `tPpf` is the more accurate of the two, which is why any difference exists. The
spline's 1.14e-8 and `predicted_date`'s 4.53e-7 — the latter above the brief's stated 1e-7 — both
come from upstream's uncentred spline solve on a calendar axis, measured at cond 9.3e12
(`dating.py:1857-1871`); `brentq` reproduces the reference to 2.5e-11 years given identical
coefficients.

**Second case, `H1N1_2009_pandemic.fasta`**, added because it takes the other branch of every rule
korber exercises. Root description `time_decay_consensus_root (γ=3.0030)` exact; all 95 divergences
exact; `mu`, `t_mrca` (2009.0426391755814) and both Fieller endpoints bit-identical; spline
rejected; one outlier; the `L mod 3` trim of 2 nt fires.

**The one field that does not match, on either example.** H1N1's `p_value`: the reference prints
1.1102230246251565e-16, we print exactly 0. `dating.py:1269` spells `1 - stats.f.cdf(...)` where the
sibling test at :1877 correctly uses `stats.f.sf(...)`, *and* scipy's `f.cdf` returns one ulp below
1.0 where the correctly rounded double is 1.0. The true survival is 1.59e-24. We replicate the
spelling; neither printed number is the answer, and the page quotes neither as one. Asserted and
documented rather than papered over.

**Suites, all re-run for this report.** Engine `HyphAeon/js` 32 files / 1267 tests (baseline 1105,
+162). App: runtime 26 / 493, web 22 / 215, mcp 10 / 113, server 5 / 57 — 63 files / 878 tests.
`svelte-check` 636 files, 0 errors, 0 warnings. `runtime/test/dating-port.test.js` 51/51, confirmed
executing rather than skipping. 0 failures across both repositories; both working trees clean.

## 4. What verification found

**The one red finding: CI will fail at module link, not skip — and all three builder reports say
the opposite.** Each report states that not bumping `ENGINE_REF` merely makes the dating suites
"SKIP with a printed reason". That is false, and the guard written to produce the skip is dead code.

- `ENGINE_REF` is `phase-4b` (`.github/workflows/ci.yml:90`), not `phase-3a` as all three reports
  claim. It does not rescue anything: `js/src/dating.js`, `js/src/numeric/optimize.js`,
  `js/src/preprocess/consensus.js` and `examples/korber_env_gp160.fasta` are all **absent** at that
  ref (confirmed with `git cat-file -e`).
- `runtime/src/dating/` uses **static named imports** from the library — `select.js:30`,
  `record.js:51`, `results.js:37`, `run.js:49` — and `runtime/src/index.js:85` does
  `export * from './dating/index.js'`. The library is `"type": "module"`, so a missing named export
  is a hard link-time error. Verified against an extraction of `phase-4b`: both
  `runtime/src/dating/index.js` and `runtime/src/index.js` fail with
  `SyntaxError: The requested module '@veg/hyphaeon-js' does not provide an export named
  'precisionWeightedEnsemble'`.
- `dating-port.test.js` statically imports `../src/dating/index.js` at line 60, so
  `describe.skipIf(!HAS_LIBRARY)` at line 110 **never runs** — the module fails to link before any
  guard is evaluated. The web side has the same trap behind `describe.runIf(available())`.
- The blast radius is wider than tests: 9 files under `web/src` import the dating subpath and
  `web/src/lib/time/dating.ts` is imported by `routes/time/+page.svelte`, so the **web build** is
  affected too.

This is a design consequence, not a regression from this phase — the brief forbade bumping
`ENGINE_REF` and the code is correct against the engine it targets. But the carried-forward note
must read *CI fails at module link until `ENGINE_REF` moves past the dating port*, not *the suites
skip*. Fixing it — lazy `import()` behind the guards, or bumping the ref — is a real decision,
deliberately left open here.

**Thin, and worth naming.** The suites run against a *symlink* to the developer's live engine
checkout (`feat/date-parsers` @ `93645e3`), not an isolated copy. That is why the acceptance test
passes here and would not at the pinned CI ref. Interpret any future green run from this worktree
with that in mind.

**Four behaviours no current test exercises**, found by reading the port against `dating.py`:

1. **float64 mean where numpy uses float32.** `HyphAeon/js/src/dating.js:981`,
   `computeTreeFreeDivergences` case 3 (earliest cohort, rectangular branch). `dating.py:673` is
   `np.mean(cross_mat, axis=1).astype(np.float64)` over a **float32** array, and numpy accumulates
   in float32. The port widens each row and calls `mean64` — about 5e-8 relative on every
   divergence, propagating into every fitted value and moving `t_MRCA`. The port's own square
   sub-branch twenty lines below does it correctly with `Math.fround`, and its comment says so, so
   this is an internal inconsistency rather than an unknown rule. Reachable from the UI: `/time`'s
   root picker offers `earliest`, which becomes a cohort whenever two or more sequences share the
   earliest date. Fixture `002_case3_earliest_cohort` has a 2-member cohort whose values happen to
   agree, so it does not discriminate.
2. **`selected_clock` diverges when Fieller's g ≥ 1.** `runtime/src/dating/select.js:136` collapses
   the reference's two remaining auto branches into one ternary. `dating.py:2985-2995` has three;
   `ols_valid` but not bounded should give `Linear (OLS fallback: PGLS non-positive rate)` and we
   emit the third arm instead. The file's header claims the sentence is byte-equal with the
   reference, and `selected_clock` is an exported JSON field. It is also dishonest in its own right:
   it tells a reader the rate is non-positive when `mu` is positive and only the *interval* is
   unbounded — precisely the weak-clock case a surveillance user hits.
3. **`runDating` throws on a reachable input, against its own documented contract**
   (`run.js:113`: "It never throws except on a bad `ciMethod` and on abort"). The `NO_TIME_SPAN`
   guard at `run.js:247` is computed over all dated taxa, but the fit uses only the training subset,
   so a file whose full dated set spans time while every *training* row shares one date reaches the
   library's singular-design refusal. `web/src/routes/time/+page.svelte:452` assigns `e.message`
   straight to `datingFailure`, showing the reader a raw engine string carrying a Python line number
   instead of the `DATING_NO_TIME_SPAN` refusal that already exists.
4. **`ci_method: 'linear'` displays the wrong interval under the wrong label.**
   `web/src/lib/time/dating.ts:194-200` maps anything not `'delta'` to `'fieller'`, but
   `dating.py:1249` groups `linear` *with* `delta`, and the runtime honours that. Latent today
   because the page hard-codes `'fieller'` — armed for whoever adds the picker this phase deferred.

**Two test-quality notes.** `DATING_SPLINE_PREFERRED` carries two opposite meanings — "the curvature
test chose the spline" (`select.js:101`) and "the curvature test did not run at all"
(`run.js:295`) — so a client filtering by code will describe a failed fit as a preferred one. And
the 22 top-level record keys are only ever asserted against themselves (`RECORD_KEYS`, the very
transcription under test) in both suites; the per-taxon columns are properly anchored to the CLI
fixture. The transcription is correct today, so this is an unanchored claim rather than a live
defect.

**Browser acceptance, driven with Playwright against the built site.** The reader's numbers match
the reference to the last displayed digit; `crossOriginIsolated` true; off-origin requests `[]` and
heavy assets (`*.onnx`, `ort-wasm`, `hyphy`) `[]` across the whole flow *including* the run; 94–98
ms from click to verdict; no console errors. Two of three no-clock-signal controls refuse cleanly
(non-positive rate; all dates identical, which is refused *before* the button is offered). **The
third does not refuse**: date-randomisation (slope p = 0.82, R² = 0.000, Fieller unbounded below)
produces the declarative sentence "These 141 sequences share a common ancestor in -993.5" and prints
-993.5 in the Ancestor date tile. The honest material is all on the page — the lede names the
missing bound, the Slope p tile reads 8.19 × 10⁻¹ — but the strongest signal never reaches the
sentence a skimming reader reads, and `DATING_UNBOUNDED_ANTIQUITY` sits behind a closed disclosure.
The reference behaves identically, so this is replicated upstream behaviour, not a port defect; but
if "no clock signal must refuse" is the product rule, `g ≥ 1` and a non-significant slope need to
join the refusals rather than the warnings. **This is an open decision, listed in §6.**

**Honesty of the page, checked deliberately.** No sentence overclaims. The section kicker reads
`hyphaeon dating --method ols --no-tree, ported`; Table 2 lists all seven estimators with the four
unbuilt ones as rows saying "Not built" plus the reason; three standing paragraphs state that this
is the tree-free least-squares estimator and nothing else, that the two model-based estimators are
not built, and that OLS treats related sequences as independent so the interval is optimistic — and
it volunteers that the published 1931.4 lies outside that interval. Any OLS status other than `OK`
becomes a black refusal block before a sentence is built, which is *more* conservative than the
reference. Degenerate and half-infinite intervals are never dressed as ranges.

**Three small defects, none of them numeric.** `primaeon.prediction_methods` emits counts as Python
floats (`"ols": 95.0`, reproduced for this report) because `DATING_FLOAT_KEYS`
(`runtime/src/dating/results.js:41-95`) is keyed by *name* rather than by path, so `ols`/`spline`
inside that block are coerced along with `ensemble.weights`; harmless today, since `primaeon` is
dropped from the CLI-shaped file, but path-insensitive. The non-positive-rate refusal prints `mu` at
17 significant figures where every other number goes through `sci()`. And at a 420 px viewport the
document scrolls sideways (454 vs 420) against `DESIGN.md`'s rule — the offender is phase 2's dates
table in section 1, not either new section.

**House style**, otherwise clean: `web/src/lib/time/TaxonDatingTable.svelte` opens with "WHY IT IS
NOT AN OUTLIER TABLE" rather than the mandated literal `WHY THIS FILE EXISTS`; it is the only one of
the 16 new files that does. No AI attribution anywhere in either repository. The design grep over
the three new components returns only `border-radius: 0` and weights 400/700.

**The independent check held.** `clockRegression.js` was handed the same divergences and the same
training rows and was deliberately not reconciled: korber `mu` 8.0e-13 relative, `t_MRCA` 7.8e-11
years; H1N1 `mu` 5.9e-12. The suite asserts the preview still has no imports and still quotes no
interval.

## 5. Upstream problems found and not fixed

All replicated deliberately; each is now visible as a diagnostic rather than dropped.

- **`dating.py:1912` — the spline bootstrap never runs.** `la.lstsq(b_X, b_d, rcond=None)` where
  `la` is `scipy.linalg`, whose keyword is `cond`. Verified on scipy 1.16.2: all 500 replicates
  raise `TypeError` inside a bare `except Exception: pass`, so all four spline confidence intervals
  collapse to their point estimates. korber publishes a **zero-width 95 % interval**
  [1938.7746674292187, 1938.7746674292187] for a quantity whose real interval is ~55 years wide. One
  word from working. Consequence for us is good: the pillar needs no PCG64 and no seed contract.
  Raised as `DATING_SPLINE_NO_INTERVAL` so a page cannot draw [x, x] as an interval.
- **`dating.py:2894-2941` — the ensembler drops the selected model.** Admission requires a positive
  interval width, so on korber the *selected* spline (1938.77) is dropped and `ensemble.weights`
  reads `{ols: 1.0}` at 1893.91: two numbers 45 years apart in one record with nothing connecting
  them. The ensembler also converts each interval to an SE by `(hi-lo)/(2*1.96)`, a symmetric-normal
  read of a deliberately skewed Fieller interval, with a 1.96 that does not match the t-based bounds
  it is reading. Raised as `DATING_ENSEMBLE_IGNORES_SELECTED`.
- **`dating.py:3019-3026` — 12 of korber's 142 rows come from a different model.** `brentq`'s
  bracket is refused (a decelerating spline is bounded above) and a bare `except` substitutes the
  ancestral linear inverse, producing perfectly ordinary-looking 1994–1999 dates with nothing in the
  JSON or CSV marking them. We emit a per-row `prediction_method` the reference does not have.
- **`dating.py:3019` — the surviving root finds are not healthy either.** 43 of 142 rows predict
  after the latest sample (1997.5), the furthest at 2097.19 against the root find's own bracket
  ceiling of 2097.5. That is an inversion pressed against its own bracket, not a date. New:
  `DATING_PREDICTION_SATURATED`. (The surface survey's "36 of 142 after 2010" counted against 2010
  rather than against the data; the page states 43 and names the survey's threshold.)
- **`dating.py:1884` — `dB[-1, 0]` reads the spline derivative at the last row in input order**, not
  at `t_max`, so `rate_recent`, `rate_ratio` and therefore `is_nonlinear_preferred` depend on FASTA
  order. On korber the last training row happens to be `t_max`, so the published 0.04× deceleration
  is right by luck.
- **`dating.py:1269` — the regression p is `1 - f.cdf` where `f.sf` was meant**, quantising at one
  ulp of 1.0 for F above ~100. See §3 for the measured consequence on H1N1.
- **`dating.py:163-174` — `verify_coding_alignment` silently mutates the caller's dict**, trimming
  `L mod 3` trailing nucleotides, and prints a notice nobody keeps. It fires on H1N1 and not on
  korber, so a port tested only on korber would never see it; without it every one of H1N1's 95
  divergences is wrong. Our port returns a new map and raises `DATING_ALIGNMENT_TRIMMED`.
- **`dating.py:2706` against `:3046` — `is_holdout` can simply be false.** `train_idx` only narrows
  when at least three rows survive, so below that guard every low-coverage sequence is *in* the fit
  and still labelled `is_holdout: true`. Replicated, with a new `DATING_HOLDOUTS_IN_FIT`. Fires on
  neither example; found by reading the two lines together.
- **`dataset.py:840/844` vs `:896` — the two TN93 engines disagree on any alignment containing `*`,
  and nothing in the output says which ran.** Measured on korber: 2389 asterisks across 18 of 143
  sequences; as gaps (the compiled branch the published numbers came from) all 142 divergences are
  exact, as unknowns 18 differ, `Z59ZR.ZHU` goes 0.0608 → 0.1106, `t_MRCA` moves 0.097 years. This
  is the single precondition that makes the pure-JS TN93 reproduce the compiled run exactly. Worth
  recording the engine in the output. Note for the record: commit `92f0cda`'s comment in
  `tn93-wasm.js` says korber carries "four asterisks in one of its 143 sequences" — the real count
  is 2389 across 18, and that file rewrites `*` to `?` while this pillar rewrites it to `-`. Both
  conventions are now documented where they are applied.
- **`dating.py:1244-1258` — an unrecognised `ci_method` silently becomes Fieller** (the chain ends
  in an `else`). `runDating` refuses the three unported methods by name instead, so a page cannot
  claim to have computed an interval it did not.
- **`ci_bootstrap` is initialised to `None` and never assigned** (`:1246`, `:1285`), shipping in the
  exported JSON as a permanent null.
- **scipy, not hyphaeon, but it sets every tolerance here:** `t.ppf` is off by up to 3.7e-11
  relative against mpmath over the dating grid and returns ~7e-17 rather than 0 at q = 0.5;
  `f.sf(1e-12, 1, 139)` is 4.9e-9 relative from the truth; `f.cdf(194.58, 1, 93)` returns one ulp
  *below* 1 where the correctly rounded double is exactly 1.0. All recorded under
  `scipy_deviations` with mpmath as the arbiter.
- **Ours, flagged rather than changed:** the library's *square* TN93 does not carry
  `dataset.py:795-799`'s `except (ValueError, OverflowError): d = 1.0`, because `pyLog` throws where
  CPython's `math.log` raises. That throw is a pinned contract — `diagnostics.js` renders it as the
  `TN93_SATURATED_PAIRS` refusal — so completing the port there would turn a refusal into a distance
  of 1.0 for the selection pillar. The new rectangular sibling *does* catch, mirroring
  `dataset.py:903-906` as written. The asymmetry is documented in both headers.

## 6. Deferred to phase 4, and the decisions now open

**Open decisions, in the order they should be taken.**

1. **`ENGINE_REF`.** It was not bumped, per the brief, and the consequence is worse than any report
   stated (§4): CI fails at module link, and the web build is in the blast radius. Either bump the
   ref past the dating port or put the dating imports behind lazy `import()` so the guards can do
   their job. This one blocks a green CI run.
2. **Does a fit with no clock signal refuse, or disclose?** Date-randomisation currently produces a
   confident sentence around -993.5 (§4). Upstream does the same. If the product rule is that it
   must refuse, `g ≥ 1` and a non-significant slope join `DATING_NON_POSITIVE_RATE` and
   `DATING_NO_TIME_SPAN`.
3. **The page headlines OLS's 1893.9 while the downloaded `dating.json`'s top-level `t_mrca` is the
   spline's 1938.8.** The divergence is deliberate and explained in prose on the page, but it is
   *not* in `DATING_DOWNLOAD_NOTE`, so a reader who downloads before reading gets a 45-year
   surprise.
4. **Whether `parity.py` grows a `dating` analysis.** It has none, and `parity-node.mjs` writes no
   dating surface. The fixtures plus the three-layer acceptance test cover what parity would buy
   here — no model, no seed, no float32 graph, and a bit-deterministic reference — and the asserted
   `dating_reference_source` line ranges turn an upstream edit into a visible data diff. Adding
   `dating` to `ANALYSES` and `reference_command` is the cheap half; **do not add it to CI's parity
   job until a comparator exists.**

**Deferred work.** The MCP tool and the server analysis for dating (the runtime exports everything
they need; no tool or job type was added). A prebaked korber `TimeSetRecord` for the gallery, which
the surface survey names as this phase's demo. The clock-model and interval-method pickers —
`TimeSetOptions` carries `clockModel` and `ciMethod` and `runDating` honours both, but the page
hard-codes `auto` and `fieller`, because offering `--clock-model linear` before anyone has asked is
a control with no question behind it. The rectangular mode for the compiled TN93 engine, now an
option rather than a prerequisite since the pure-JS path reproduces the compiled run exactly. The
half-infinite Fieller interval and the `DATING_HOLDOUTS_IN_FIT` disagreement are handled and
unit-tested but fire on no checked-in example, so neither is exercised in a browser; both need a
constructed alignment.

**Out of scope by decision, not by omission**, with `runDating` refusing the three unported
`ci_method` strings by name and `primaeon.estimators_not_built` stating the rest in the record so a
page can say so in place rather than promise them: the power-law clock (D33 — under
`clock_model='auto'` the reference never fits it); LOOCV/jackknife (opt-in behind `--loocv`); the
Poisson and wild-residual intervals and the spline bootstrap's resampling, each of which would need
a bit-compatible mirror of numpy's PCG64 — skipping all three is what lets this pillar ship with no
RNG and no seed contract; tree re-rooting (D34, declined rather than approximated); and everything
the transformer feeds — PGLS, REML Pagel lambda, `tune_ridge`, the latent convex-hull root, the
neural and attention covariance kernels — which is phase 4, D29: a new ONNX contract, a new manifest
hash, new fixtures and a re-baked gallery.

One note for whoever picks up phase 4's REML lambda: `minimizeScalarBounded(f, a, b, {xatol = 1e-5})`
is the signature, and scipy's default `xatol` is 1e-5, so set parity expectations at 1e-5 and not at
1e-12. And `tSf` is 1.5e-11 relative at df = 1e5, outside `gen.py`'s df ≤ 2000 grid, so `tPpf`'s
accuracy claim is bounded at df ≤ 1e4 in its header — extend the grid or leave the bound, but do not
rediscover it as a mystery.
