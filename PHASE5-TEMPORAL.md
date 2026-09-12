# Phase 5 — temporal selection (the pillar, the null, and the /time section)

PLAN-TEMPORAL.md phase 5. Recorded 2026-09-12, after the work was done and checked three times:
an independent re-derivation of the acceptance run, a QA pass in a real browser against the built
site, and a senior review of both diffs with its own reference runs.

## 1. The verdict

**Everything that is determined by the data reproduces the reference, and one thing is not
determined by the data.** `hyphaeon temporal`'s deterministic half — the time grid, the root
consensus, the directional attribution, the Nadaraya–Watson smoothing, the velocities, peaks,
half-widths, areas, the static LRT and its p and q, the stage-one candidate set, the shape gate,
the mutation labels and the four output files' shape — comes back at or below the graph class on
every surface, over all 4,384 codons of `examples/H1N1_2009_pandemic.fasta`. The permutation
p-value does not, and cannot: the reference draws its shuffles from numpy's Mersenne Twister and
this application draws them from xoshiro256\*\* substreams, so `p_perm` agrees in distribution and
never digit for digit.

Three things hang off `p_perm` and therefore inherit its class, which is the single most important
sentence in this report: the **confirmed-** and **rescued-sweep sets**, the `classification` of the
codons those sets contain, and — because `temporal.py:720` decomposes the confirmed set — the
**wave shapes, their singular values and their variance shares**. Measured on the acceptance run:
the reference confirms 18 sweeps at B = 100 and this runtime confirms 32, the two sets disagree on
18 codons, and the wave shares come out 33.84 / 28.26 / 17.81 / 11.11 against the reference's
39.67 / 32.37 / 13.92 / 9.31. Conditioned on the reference's *own* `is_confirmed_sweep` column the
same code reproduces 39.67 / 32.36 / 13.92 / 9.31 and σ = 20.6989 / 18.6961 / 12.2629 / 10.0253,
so the decomposition itself is exact and only the set it runs over moved.

The 32-vs-18 gap was pushed until it broke or held. It holds. Per candidate, `(ours − ref)/se` over
the 246 candidates has mean −0.083, sd 1.110 and max |z| 2.85; Pearson r on exceedance counts is
0.970. The decisive check was re-running the pillar at eight seeds: our own confirmed count is
**17, 24, 25, 28, 29, 32, 32, 35** (mean 27.8, sd 5.7) with `stage1_candidates` = 246 at every one.
The reference's 18 sits inside our own spread and is matched by our seed 7. **"18 confirmed sweeps"
is not a property of the acceptance run at B = 100**; it is one draw of a statistic whose standard
deviation at that B is a third of its value, and PLAN-TEMPORAL.md and the surveys should stop
carrying it as an answer. The tests assert the three-sigma band around the cut, never the count.

A fourth divergence is a documented absence rather than noise: `temporal.py` has **no singular-vector
sign convention** and writes LAPACK's raw signs. The library adopts and defaults a canonical rule
(`WAVE_SIGN.md`), the flip vector against the reference's own `_waves.csv` is **(−1, +1, −1, −1)**
on the acceptance run, and every test records the flip rather than absorbing it. Once the engine
grows `--wave-sign` the comparison becomes column by column with no sign allowance.

## 2. What landed

### Engine — `../HyphAeon`, branch `feat/temporal`, head `69f52a3`

Eight commits over the tag `phase-5c`; 27 files, +44,606 lines (most of it fixtures).

- `js/src/numeric/calculus.js` — `numpyLinspace`, `numpyGradient` / `numpyGradientRows`,
  `numpyTrapezoid` / `numpyTrapezoidRows`, `isUniformSpacing` (numpy's exact-equality test, which is
  false for every linspace time axis). `js/src/numeric/reduce.js` gains `numpyMeanFloat64`,
  `numpyVarFloat64`, `numpyStdFloat64`.
- `js/src/numeric/svd.js` — `dominantTimeModes` via the T×T time Gram matrix, so U is never formed;
  `timeGram`, `projectionResidual`, `canonicalizeWaveSigns`, `resolveWaveSign`,
  `WAVE_GAP_THRESHOLD = 0.05`, `WAVE_RANK_EPS`.
- `js/src/temporal.js` — the pillar as pure functions: regime and bandwidth resolution, the time
  grid, `inferRootSequence`, `directionalAttribution`, `nadarayaWatsonWeights`,
  `smoothTrajectories`, `sweepMetric`, `temporalTrajectoryStatistics`, `resolveEnergyFloors`,
  `stageOneMask`, the null kernel (`temporalPermStat`, `temporalDrawPermutation`,
  `temporalNullDraws`, `temporalPermPValues`), `fpcaShapeGate`, `confirmSweeps`,
  `classifyTemporalSites`, `temporalWaveDecomposition`, `temporalMutationLabels`. No session, no
  I/O, no `AbortSignal`, no default B — orchestration is the app's.
- `js/src/writers.js` — `temporalSitesCsv` / `temporalCurvesCsv` / `temporalWavesCsv` /
  `temporalSummaryJson`, plus `pyFloat32Repr` and `pyRound`.
- `WAVE_SIGN.md`, `fixtures/temporal/` (4 files, 398 KB, `gen_fixtures.py --only temporal`, 1 s),
  and `fixtures/temporal/acceptance/` — the reference CLI's own four files for H1N1 at `--cpu`,
  committed so the runtime suite has something to diff against.

`js/test/index.test.js`'s `PUBLIC_SURFACE` list grew from 305 to 368 names; it is the only existing
test that was edited.

### App — this worktree, branch `feat/temporal`, head `0221779`

Nine commits over `feat/dating-model`'s tip; 25 files, +7,364 lines. `mcp/`, `server/` and
`deploy/` are untouched.

- `runtime/src/temporal/` — `run.js` (`runTemporal`: the one call, taking `loaded`, `dates`,
  `session`, options, and streaming three payloads through `onProgress`), `null.js` (the chunked,
  cancellable, resumable null driver plus `temporalNullBudget`, `temporalNullWork`,
  `candidateNnz`, `chunkFor` and the calibration constants), `record.js` (the `TemporalRecord`:
  the reference's eighteen summary keys in its own order, then 27 parallel typed-array site
  columns, curves, waves, candidates, permutations, floors, root, dates, warnings), `results.js`
  (the four downloads, `temporalReferenceCommand`, `temporalDownloadNotes`). Exported as
  `@veg/hyphaeon-runtime/temporal`.
- `web/src/lib/time/temporal.ts` — the result-semantics layer, pure and surface-agnostic:
  `temporalGate`, `codonCeiling`, `nullCeiling`, `costSentences` / `costMeasured`,
  `borderlineBand`, `ledeSentence`, `honestyNotes`, `siteRows`, the four figure builders, the
  reader's words for every enum.
- `web/src/lib/time/` components — `TemporalSection.svelte`, `TrajectoryFigure`, `VelocityFigure`,
  `WaveFigure`, `ClassificationFigure`, `TemporalTable`; all inline SVG, all colours through
  tokens, no canvas.
- `web/src/lib/workers/temporal.worker.ts` and the protocol types — a sixth worker, and the
  three-payload contract (`scored`, `null`, `complete`) with a deliberately thin middle payload.
- `web/src/routes/time/+page.svelte` — section 5 wired in, the old section 5 renumbered to 6.

The one existing runtime test edited is `no-hyphy.test.js`, whose exact `package.json` exports list
gains `./temporal`.

## 3. The numbers, field by field

Three classes are kept apart throughout, as PLAN.md §5.4 requires, and the phase reports should
name the convention when they quote one: **relative-to-value** (what is quoted below for the
intensity family) and **absolute** differ by 160× on `peak_intensity`, because the quantity itself
lives at a 5e-5 scale.

### Library against the reference's own pre-chain state (H1N1, all 4,384 codons)

Driving the library's chain over the reference's dumped `lrts`, `mean_attns`, `a_valid`, `inv` and
`taxa_dates`: **bit-identical** on `lrt`, `q_static`, `r2_fpca`, `peak_date`, `fwhm_years`, the root
indices, `ref_aa` / `derived_aa` / `mutation_label` / `domain`, and every one of the 60 grid points.
`p_static` 2.4e-15 abs. `peak_intensity` / `mean_intensity` / `auc` 2.5e-13 relative — BLAS `dgemm`
summation order in the one matmul. `t_half_start` / `t_half_end` differed in 13 cells by exactly
one float32 ulp until `pyFloat32Repr`'s half-to-even tie rule was fixed; now zero.

Re-parsing the reference's own three CSVs and rewriting them through the library's writers
reproduces all three **byte for byte**: `_sites_summary.csv` 780,749 bytes / 4,384 rows,
`_curves.csv` 1,186,202 bytes / 14,760 rows, `_waves.csv` 6,083 bytes / 60 rows.

### Runtime against the reference CLI, through the real ONNX graph (H1N1, `-B 100 --time-points 60`)

Ingestion is exact: 100 taxa, 95 dated — the same five sequences the reference drops, checked
against its own `valid_taxa_mask` — 4,384 codons, 273 variable, 4,111 invariable, 2 nt trimmed,
2,998 in-frame stops. `dates.beyond_reference = 0`, so this is a comparison and not a
better-than-reference run.

**Bit-identical over all 4,384 rows**: `site`, `ref_aa`, `derived_aa`, `mutation_label`, `domain`,
`is_concordant_sweep`, `peak_date`, `t_half_start`, `t_half_end`, `fwhm_years`, and the float32
time axis at every grid point.

**Strict class** (onnxruntime against torch; the reference's own MPS-vs-CPU spread on `lrt` is
7.0e-6 / 6.3e-6, so we sit on its floor): `lrt` 1.15e-5 abs / 7.1e-6 rel; `p_static` 5.1e-7;
`q_static` 9.0e-7; `r2_fpca` 5.0e-7; `peak_intensity` / `mean_intensity` / `auc` 1.68e-5
relative-to-value (1.04e-7 absolute); trajectories 6.7e-9; velocities 1.0e-7.

**Exact as a set**: all **246** stage-one candidates — confirmed independently from the
`_curves.csv` site column rather than from any internal mask — and the `INVARIABLE` (4,111) and
`FLAT_NO_SIGNAL` partitions of `classification`, 0 mismatches. Justified by margin: the binding
floor is `tau_auc = 1e-5`, the smallest passing area 2.00e-5 (2.0×) and the largest failing
3.48e-6 (0.35×).

**Headline summary keys**: 16 of the reference's 18 identical — taxa 100 / 95, codons
4,384 / 273 / 4,111, `t_min` 2009.2490234375, `t_max` 2009.9150390625, span 0.666015625,
bandwidth 0.05 (the floor binds), `tau_peak` 5e-5, `tau_auc` 1e-5, 246 candidates, 0
static-significant, 0 concordant, escape hatch not used. The two that differ are
`confirmed_sweeps` and `rescued_sweeps` (32 vs 18), and `fpca_wave_variance_pct` downstream of
them. Exactly four site columns differ, and only in the same 18 rows: `classification`,
`cross_classification`, `is_confirmed_sweep`, `is_rescued_sweep`.

`_curves.csv`: 14,760 rows, header identical, `site` / `mutation_label` / `time` strings identical
in every row, the 246 distinct site numbers identical as a set. `_waves.csv`: 60 rows, time axis
bit-identical; the raw curves differ because the decomposition runs over a different confirmed set,
and after conditioning on the reference's own column and applying the recorded flip, the wave
curves agree to 8.7e-8 and the loadings to 1.29e-5 relative — an order tighter than the reference
is with itself (1.7e-4).

### Runtime against a fresh reference run (H5N1, `-B 200 --time-points 60 --cpu`)

Run by the reviewer against no committed fixture: 97 dated taxa, 566 codons, 169 variable, span
9.00 yr (the bandwidth clamp does **not** bind, bw 0.450), `tau_peak` 5e-5, `tau_auc` 1.8e-5,
**168 candidates** — every one reproduced exactly. Zero differing rows on `peak_date`,
`t_half_start`, `t_half_end`, `fwhm_years`, `ref_aa`, `derived_aa`, `mutation_label`; 1 of 566 on
`classification`; `lrt` 8.7e-6 abs / 1.3e-5 rel, `peak_intensity` 8.5e-7 rel, `auc` 5.8e-7 rel,
`r2_fpca` 9.4e-7 rel.

### Browser against the reference (H1N1 on the built site, T = 60)

All 4,384 rows compared column by column from the page's own downloaded CSV: bit-identical text in
`site`, `ref_aa`, `derived_aa`, `mutation_label`, `domain`, `peak_date`, `t_half_start`,
`t_half_end`, `fwhm_years`; the 246-candidate set with symmetric difference 0; `INVARIABLE` (4,111)
and `FLAT_NO_SIGNAL` (27) exact; `lrt` 1.7e-5 abs / 9.1e-6 rel, `p_static` 3.2e-7, `q_static`
4.0e-7, `r2_fpca` 1.7e-7, the intensity family 8.7e-6 relative. The e2e drives H5N1 instead
(566 codons, the metadata-table ingestion path) and reproduces **168 candidates** at T = 60 in
3.3 s; the sweep count agreeing at 16 as well is pleasing and is deliberately not asserted.

One difference that will be reported as a discrepancy and is not one: the page defaults to T = 250
and gives **247** candidates where the reference's T = 60 gives 246. Setting the grid to 60
reproduces 246 exactly, and the reproduction line carries the right `--time-points`.

### Suites

| suite | files / tests | baseline |
|---|---|---|
| `../HyphAeon/js` | 36 / **1,561** | 1,339 (+222 in 3 new files) |
| `runtime` | 28 / **580** | 525 (+55 in `temporal-port.test.js`) |
| `web` | 24 / **286** | 245 (+41 in `time/temporal.test.ts`) |
| `mcp` | 10 / 113 | unchanged |
| `server` | 5 / 57 | unchanged |

`svelte-check` 659 files, 0 errors, 0 warnings. `HYPHAEON_PREBAKE=skip npm run build` clean in
8.2 s. Playwright `time.spec.ts` 9 passed in 16.3 s, whole suite **71 passed in 38.9 s** (baseline
69), with no existing spec edited except `time.spec.ts`'s empty-state test.

## 4. The null, what it costs, and the browser default it forced

**PLAN-TEMPORAL §5.1.3 is two orders of magnitude out, and backwards.** It budgets 35–100 s at 200
candidates and 3–8 minutes at 1,000, and calls the null "one to two orders above everything else
including the model". Measured on the acceptance alignment at 8 threads, warm:

| phase | all 4,384 codons, B = 100, T = 60 | variable only | all, at CLI defaults B = 1000, T = 250 |
|---|---|---|---|
| model pass | 12.89 s | 0.91 s | 12.13 s |
| smoothing | 0.07 s | 0.03 s | 0.07 s |
| **null** | **0.13 s** | 0.07 s | **1.76 s** |
| waves | 0.03 s | 0.01 s | 0.12 s |
| total | 13.12 s | 1.02 s | 14.08 s |

Verification re-measured it independently at 11.89–12.24 s total with the null at 0.07 s — 0.6 % of
the pillar against the model's 99 %. The cause is the one the kernel survey identified and the
library's CSR layout exploits: `leaf_attributions` is attention times an indicator of carrying a
non-root residue, measured at ρ = 0.043 (1,000 nonzero of 23,370), and the kernel skips the zeros.
A cold first run measures 30.6 s end to end; that is session creation, sha256 verification and JIT,
and **no surface may quote a cold number to a reader**.

`scoreInvariableSites: false` saves 93 % of the model pass and produces the same 246 candidates,
the same 32 sweeps, the same classification and a bit-identical `peak_date` — asserted as a test.

**The cost model's fixed term is 21, not 7.** The kernel survey's `W = B·C·T·(nnz/C + 7)` under-counts
the per-grid-point statistic by a factor of three; fitting k and the rate to two extreme shapes gives
k ≈ 21 and ≈ 9.5e8 u/s, which then predicts the unfitted shapes within 2.6 % and 20 %. The runtime
ships `TEMPORAL_PERM_STAT_UNITS = 21` and `TEMPORAL_PERM_RATE = 9.0e8`. **The reviewer's independent
timing does not support 9.0e8 as conservative**: the same five shapes in isolated processes imply
6.1e8–8.3e8, a 1.4× spread, and the mid and large predictions run 1.5× optimistic (5.45 s predicted
vs 8.07 s measured; 8.16 s vs 11.9 s). Refitting gives k ≈ 15.3, R ≈ 5.7e8. The practical bite is
small — the pre-run estimate goes through `nullCeiling`, which over-states by ~20×, and the live
countdown uses measured ms/draw — but `TEMPORAL_PERM_BUDGET_DEFAULT`'s "about 55 s" is really about
80 s, and `null.js`'s header claim of a conservative, flat constant is not earned. The driver's own
chunking overhead claim (2–8 %) does reproduce: −6 % to +1 %.

In a real Chromium on the built site the null ran at **1.12 ms/draw** at C = 247, N = 95, T = 250
with nnz = 1,002 — about 5.2e9 u/s under the fitted model, six times the quoted floor. The deferred
"re-measure the rate in a browser" item can be closed with that number, and the page's own sentence
("the rate this build measured on its own development machine, which is a floor for a browser
rather than a promise") turned out to be exactly right.

**The browser default.** `TEMPORAL_PERM_ROUNDS = [200, 500, 1000]` and the page passes
`permutations: null`, so the run walks the rounds and the budget that would stop it essentially
never fires (refusing needs more than 10,000 codons at the 256-sequence cap). The browser's
effective default is therefore the reference's own **1,000 draws**, not 200. D26 asked for a
default well below 1,000; this is a deliberate, disclosed deviation — the page says it plainly, the
achieved count travels with every p-value, and per-draw substreams make a stopped run bit-identical
to one configured at that B — but it is a deviation and the plan should record it as one rather
than describing 200 as the default.

Cancelling was designed around this. `runTemporalNull` catches its own abort and
`p = (1 + exceedances)/(draws + 1)` at the achieved count is the reference's own estimator on a
coarser grid, not an approximation of it. Measured in the browser: stopping the model pass is
honoured in 0.13 s with nothing partial claimed; stopping the null at draw 1 finished the chunk in
flight at 313 of 1,000 and said so, naming the grid step and the smallest reportable value
(0.00318).

## 5. What verification found

Three passes ran: an independent re-derivation of the acceptance run through a driver written from
the public API, a QA pass in Chromium against the built site on H1N1 plus a warning case
(korber_env_gp160) and a refusal case (Smc6), and a senior review of both diffs with its own
reference runs, null-kernel correctness checks and micro-benchmarks. All suites green in every
pass. **Nothing below was fixed; these are reported, open, and belong at the top of phase 6.**

**The one real defect, and it is a false statement on screen.** While the null is running, from the
first completed chunk onward, the section's lede asserts a completed negative finding: "No codon of
the N candidates is confirmed: every one of them was reproduced too often by shuffling the dates,
or failed the wave-alignment gate at R² ≥ 0.35", and the stats row flips from "the null has not
been drawn" to "Confirmed sweeps 0". The interim payload merges only `p_perm`, `q_perm` and
`permutations`, so `confirmed_sweeps` and `classification` are still the scored payload's zeros
while `permutations.tested` goes true after one chunk; `ledeSentence` then takes its `n === 0`
branch unqualified. And `p` at draw k is `(1 + exceedances)/(k + 1)`, so early p is near 1 by
construction and "none confirmed" is *guaranteed* at the start of every run. Reproduced in Chromium
twice: on H5N1 the window is ~0.9 s, on H1N1 ~2 s, on Korber ~9 s, and at the mid and large shapes
the cost model budgets for it is 8–12 s. No test catches it — the e2e waits for `data-state=landed`
before reading the verdict. The fix is a fourth form of the sentence while the run is in flight, or
gating the tested branch on `completed === requested`. This is precisely the "a stop that claims
nothing" property the phase set out to hold, and it is the only place the section actively asserts
something false.

**`temporalReferenceCommand` returns `reproduces: true` on a run its own command cannot
reproduce**, and one of its caveats says "No other number differs." Measured end to end on H1N1:
1 of 4,384 rows of `_sites_summary.csv` is byte-identical to the reference's `--cpu` output, 17 of
27 columns differ somewhere, 0 of 60 `_waves.csv` rows match, and the summary differs on three
keys. The xoshiro-vs-MT19937 divergence is never named in `caveats` and never sets the flag false,
and the page only prints its "will not reproduce this run" warning when the flag is false. Three
further paths leave it true while omitting the flag that would reproduce them: a downsampled run,
an explicit bandwidth, and explicit `tauPeak` / `tauAuc` / `sweepMode` / `keepDuplicates`.

**The downloads' "byte for byte" copy inherits a qualifier it does not carry.** The *format* is
byte-exact and verified (headers, key order, row counts 4,384 / 14,760 / 60). The *content* is not:
a reader who takes the page's invitation to diff all four files against a command-line run sees
4,383 of 4,384 rows differ. The library's own byte-for-byte claim is legitimate and about a
different thing — rewriting the reference's own numbers through the writers.

**The wave variance shares are presented as if reproducible.** The page shows 33.8 / 28.3 / 17.8 /
11.1 against the reference's 39.67 / 32.37 / 13.92 / 9.31, and the one note about waves says "No
singular value, no variance share, no R² and no classification reads a sign" — true of the sign,
and easy to read as a claim that those numbers are comparable. The runtime handles this correctly
(its test conditions on the reference's own column and reproduces the shares to 2 dp); the finding
never reaches the page.

**The offer prices the cheap part.** The pre-run paragraph gives one time figure — "about 2.4
minutes" — for the null, which took 1.1 s; the model pass, 16 of the 17.8 s the reader waited, is
described and given no time at all. The runtime already measures codons/s on every run.

**Smaller findings.** `numpyVarFloat64` allocates a `Float64Array(T)` per row inside the innermost
null loop — measured 98 ms against 45 ms hoisted over 1000 × 246 rows, about a fifth of the null's
cost at that shape, and a large part of why the fitted constant came out at 21. The page
hard-codes `9.0e8` and `+ 21` as literals rather than importing the runtime's constants, and its
test re-encodes them, so a re-measurement would silently split the two. The interim record is
rebuilt in full on every null chunk (~10 MB of churn at 63 chunks on H1N1) for payloads the worker
discards. `np.maximum(0.0, x)` propagates NaN and the port maps NaN to 0 — unreachable, undocumented.
A literal NUL byte at `runtime/test/temporal-port.test.js:321` makes `file(1)` call the file data and
`grep` treat it as binary. Plural agreement in the verdict ("1 of them are also called"). Two stale
figures in headers the same work corrected elsewhere: `null.js:246` still writes the cost model with
`+ 7`, and `js/src/temporal.js:178` still says the span is 0.671 yr.

**Result-semantics gap, found by writing an independent driver**: the summary JSON's `alignment` and
`tree` read `inputs.alignment` / `inputs.tree` with no fallback, and the writer emits `""` for a
missing one — a plausible key (`alignment_name`) produced a nameless reference summary with every
number in it correct.

**Both implementations write `p_perm = 1.0` for the 4,138 non-candidate codons** — a p-value of 1
at a codon on which no permutation was run. Faithfully ported, and the same objection the runtime
answered with NaN for `p_static` is left unanswered here.

**Two housekeeping facts.** The worktree carries an untracked, un-gitignored `.review/` directory
of scratch `.mjs` files that neither builder created; `git add -A` would sweep it into a commit.
And a `vite preview` on port 4199 was left running by QA (`lsof -nP -iTCP:4199 -sTCP:LISTEN`).

## 6. Upstream problems

Twelve quirks of `hyphaeon/temporal.py`, all replicated rather than fixed, per the house rule, and
all pinned by a fixture or a test so a later "fix" fails loudly.

- **Q1** (`:604`, `:610`) — the `tau_peak` override tests the *value* (`tau_peak is None or
  tau_peak == 1e-4`), not whether a caller supplied one, so passing the documented default
  explicitly is silently replaced. The record carries `floors.tau_peak_overridden`; the acceptance
  run fires it.
- **Q2** (`:355`) — an unknown residue in an *explicit* root taxon becomes index 0 = Alanine, so
  every gapped position of that taxon reads as a difference in every other sequence, including at
  invariable codons, which then acquire real trajectories, peaks, areas, loadings and wrong
  mutation labels. This is the only configuration in which the model's outputs at invariable codons
  matter, so `runTemporal` pins `scoreInvariableSites` back on when a root taxon is named, and says
  why. The `'X'` default at `:356` and the `'-'` default at `:390` are both unreachable.
- **Q3** (`:366`) — the root consensus window is `max(3, min(25, int(0.05*N)))`: 3 below 60 dated
  taxa and 25 above 500, so the docstring's "earliest 5 %" is true in neither tail. The acceptance
  run's window is 4 of 95.
- **Q4** (`:365`, `:722`) — both argsorts are numpy's unstable quicksort. The acceptance run's root
  window is tie-free, but 4,111 of its 4,384 peak intensities are tied at exactly zero, so the
  wave-stage fallback set is not reproducible across sort implementations. The port uses stable
  (value, index) sorts and records the choice.
- **Q5** (`:692–693`) — the static-LRT escape hatch fires on the confirmed *count* being zero, uses
  a hard-coded 0.10 rather than `perm_alpha` and a hard-coded 3.84 against the float32 LRT, and is
  recorded in no output file: a run that confirmed nothing and one that confirmed thirty through
  the hatch are indistinguishable in the CSV. The record carries `escape_hatch_used`; a test forces
  the branch with `permAlpha = 0`, since no example reaches it.
- **Q6** (`:569–578` vs `:579–582`) — the fixation branch divides the velocity by `site_scale` and
  the episodic branch does not, so calendar `peak_intensity` and `auc` scale as ~1/N while the
  stage-one floors stay fixed: candidate counts are taxon-count dependent in calendar mode, which is
  exactly what downsampling changes.
- **Q7** (`:669`) — `stds_c = std + 1e-8` turns a constant candidate row into exact zeros, giving
  `sse = 0`, `sst = 1e-8` and `r2_fpca = 1.0`: a pass on no signal. `fpcaShapeGate` reports such
  rows in `flatRows`.
- **Q8** (`:672`) — `k_eff = min(4, n_stage1)` with mean-centred rows makes the shape gate vacuous
  at exactly four candidates (row-space rank ≤ 3). C ≤ 3 is already the solitary regime, so C = 4
  is the only live case; `fpcaShapeGate` returns `vacuous`.
- **Q9** (`:807–808`) — `_curves.csv` writes `selection_intensity` and `sweep_velocity` from the
  same array, identical in all 14,760 rows on both sides. Reproduced so the file diffs clean, and
  asserted *as a bug*.
- **Q10** (`:785`, `:848`, `:851`) — `mean_intensity` is the mean of the *velocity*, and
  `timespan_years` / `bandwidth_years` / `fwhm_years` say "years" whatever `--time-units` was.
  Asserted on a generations-unit run.
- **Q11** (`:665`) — `q_perm` is uninformative at every feasible B: BH runs over the C candidates,
  so rank one is bounded by C/(B+1) = 2.4 on the acceptance run, clipped to 1, and every confirmed
  sweep reports the same q = 0.4298. Reaching q ≤ 0.10 there needs ≈ 2,500 draws. One correction to
  the surveys: C/(B+1) is *not* a floor on the step-up minimum, only a bound at rank one, so the
  record reports `permutations.q_min` beside `q_rank1_bound` and warns on the former.
- **Q12** — `TEMPORAL_ANALYSIS_GUIDE.md` documents flags and an entry point that do not exist
  (`--time-bins`, `--root`, `--out-dir`, `--min-peak-intensity`, `run_temporal_analysis`). The code
  is the only specification.

Plus one absence (**D28**, the wave sign, above) and one quirk neither survey names, found by
writing the test: `pvals_from_lrt_self_liang` returns 1.0 wherever the LRT is not positive, and NaN
is not positive, so a surface that skips the invariable codons gets `p_static = 1` at a codon
nothing was measured on. The runtime sets NaN, which the writers emit as pandas' own empty cell.

**Three documented figures are wrong and should be corrected wherever they are carried forward.**
The pipeline and surface surveys quote `t_max = 2009.9200439453125` for the acceptance run; the
reference's own `_waves.csv` ends at 2009.9150390625 with `t_min` 2009.2490234375, a span of
0.666015625 years, confirmed from the bytes by all three passes. The decomposition survey puts
`sigma_j` and `fpca_wave_variance_pct` in the strict graph class, which is true of the decomposition
given a matrix and false of the pipeline (§1). And the surface survey's figure budget for `/time`
is off by one in the common case: the dating regression only exists after a reader runs section 3,
so with a tree and no dating run temporal's figures are 3–6, not 4–7 — a spec that pins "Figure 4"
to a component is pinning something the page does not promise.

## 7. What remains

**Blocking CI, and left alone deliberately.** `ENGINE_REF` is still `phase-5c` while the engine's
`feat/temporal` is eight commits ahead of it. Everything green in this report is a *local* result:
`runtime/test/temporal-port.test.js` reads `fixtures/temporal/acceptance/` (landed in `69f52a3`)
and the whole library surface lands in `b4feb85..e54e99e`, so the `app` job would fail at import
against `phase-5c`. Bumping the ref is the first act of the next change, together with the engine
tag.

**Open defects from §5**, in the order they should be taken: the interim lede's false negative;
`reproduces: true` on runs the command cannot reproduce, and the four paths that reach it; the
downloads' "byte for byte" copy; the wave shares' class on the page; the offer's missing model-pass
time; the calibration constants (re-fit or re-label, and import them into the page rather than
re-typing them); `numpyVarFloat64`'s per-row allocation; the summary JSON's nameless-input path;
the NUL byte; the two stale header figures; the plural agreement.

**Phase 6 proper.** `mcp/` needs `hyphaeon_temporal` and `server/` needs the `temporal` analysis and
the over-budget handoff; `runTemporal`'s option surface and its refusal contract were written for
them (refusals are *returned* as `{ok: false, refusal}`, never thrown, so an MCP classifies them as
the reader's input rather than a server fault). The page's refusal copy deliberately does not offer
a server job, because none exists.

**Parity.** `runtime/scripts/parity-node.mjs` has no `temporal` analysis and `scripts/parity.py` has
no temporal comparator and does not know the H1N1 or H5N1 example names — the same gap Phase 4
carried for `dms` and `phenotype` until the 4a rewrite. This phase's proof is the runtime suite and
three independent drivers; the comparator belongs upstream with the field classes of §3, and the
MCP and the server will need it.

**A second fixture directory for H5N1.** The browser and the reviewer both reproduce the reference's
168 candidates on that file, but the comparison lives in an e2e assertion and a scratch run rather
than in a committed fixture beside `fixtures/temporal/acceptance/`. Its near-degenerate spectrum
(97.0 / 1.54 / 0.66 / 0.48) is the case that exercises the subspace rule.

**Not done and deliberately so.** `--wave-sign` on the Python side (the convention is implemented
and defaulted in the library; the engine has no flag, and until it lands the two sides differ by the
recorded flip vector). Besag–Clifford curtailment, the kernel survey's second gear — it changes the
estimator, so a record carrying it must say so, and the budget check it exists to rescue essentially
never fires. Persisting the temporal record with the date review — two [L, T] float64 curve blocks
are 17.5 MB at the default grid, so a reload re-runs the model pass with the graph already cached.
A browser run on the H1N1 acceptance alignment in the e2e (the runtime already compares it element
by element; H5N1 exercises the same streaming, numbering and copy in a fifth of the time). A
page-level test of the cancelled-null copy, which needs a component harness `web/` does not have.
And PLAN-TEMPORAL.md itself, whose §5.1.3 cost table and D26 wording both need correcting from §4.
