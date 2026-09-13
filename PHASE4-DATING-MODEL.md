# Phase 4 — model-based dating (the taxa graph, PGLS, the latent root)

PLAN-TEMPORAL.md phase 4. Recorded 2026-09-12, after the work was done and checked.

## 1. The verdict

**The export was feasible, and it cost the existing pillars nothing.** The two tensors the dating
pillar needs — `splits.py`'s cross-taxa attention and its per-taxon embeddings — export cleanly to
ONNX at opset 17 as a *separate* artifact per variant (`models/general_taxa.onnx`,
`models/viral_taxa.onnx`, 7,340,384 bytes each). `general.onnx`, `viral.onnx` and
`busted_head.onnx` are byte-identical to `phase-5b`; the manifest change is purely additive; no
gallery record was rebaked and no parity surface re-run. A fresh `runEverything` on a tree-based
example (bat_oas1) and a tree-free one (camelid) reproduces the records committed before this phase
with **zero numeric differences** in all six sections — only wall-clock fields moved.

**The two model-based estimators reproduce the reference.** Against
`hyphaeon dating -a examples/korber_env_gp160.fasta --root-taxon CONSENSUS --no-tree --method all
--cpu --distance-mode {tn93,latent}`, the whole record — every field, both distance modes, all 142
per-taxon rows — comes back inside the float32 BLAS floor of the covariance kernel: PGLS `t_MRCA`
to 8.1e-7 years (tn93) and 4.1e-4 years (latent), Pagel's λ* to 4.6e-7, the latent root's α to
7.9e-8 relative with the same six anchor taxa in the same order, and `selected_clock` byte for
byte in both modes. In the browser, 143 sequences × 981 codons run through the taxa graph in
**6.0–6.9 s** at 14 threads, against 6.03 s for the reference CLI on the same box.

One number in the whole pillar is not determined to the digit the page prints: the latent-mode
spline's date, −1974.2 against the reference's −1974.28, a 0.12-year disagreement. That is the
reference's own conditioning, not the port's — see §4.

## 2. The one design decision, and the measurement behind it

The brief said to re-export the graphs the application already uses and update their hashes. The
export stage built exactly that first — both reductions folded into `BackboneGraph`, exported,
confirmed correct — then measured it and **did not ship it**.

onnxruntime does not prune a graph to the requested fetch list. On the folded graph, fetching
`['lrt']` cost the same as fetching all five outputs: 189.0 ms vs 188.2 ms at N=143/B=24, and
309.2 vs 310.6 ms at N=256/B=16. Folding would therefore have taxed every MEME, BUSTED, epistasis,
DMS and phenotype site by **2.5–7.3 % at one thread and 15–19 % at eight**, on every surface,
forever, for outputs only dating reads. The stated budget was 3 %, and the browser is
multi-threaded whenever `crossOriginIsolated`, so 19 % is the figure that would have shipped.

Hence a separate artifact per variant. `runtime/src/feeds.js`'s header, which asserted the
opposite and was the load-bearing justification for a belief held in three other files, now
retracts the claim and carries the measurement. A grep of `runtime/`, `web/src`, `mcp/` and
`server/` found no surviving copy of the retracted claim; the three files that read
`session.outputNames` (`analyze.js:457-458`, `busted.js:107`, `datingNeural.js:111`) use it for
availability, not cost, so none was invalidated.

Both variants were exported, not just `general`. Dating's own default is `general`, but the app
picks a variant per run and korber (HIV env gp160) is viral data; an asymmetric export would make
dating unavailable exactly where it is most wanted, and the dating pass must use the same weights
as the report or the two disagree about the model.

## 3. What landed

### Engine — `../HyphAeon`, branch `feat/dating-model`, head `8a3ce78`

Twelve commits over the tag `phase-5b`, in four groups.

**The export** (`b9e430a`, `2a87ff1`, `1735adb`, `c89634d`). `export.py`'s new `TaxaGraph` mirrors
`splits.py:24-155` line for line with the tree cache inlined as `BackboneGraph` inlines it. Two
new outputs, both reduced over the batch so their size is independent of site batching:

- `cross_attn_sum` float32 `[num_species, num_species]` = `attn_weights[:,:,1:,1:].mean(dim=1).sum(dim=0)`
  accumulated over row layers (`splits.py:131-132`)
- `taxa_repr_sum` float32 `[num_species, 384]` = `x_full[:,1:,central_idx,:].sum(dim=0)`
  (`splits.py:147-149`)

They are SUMS over the call's sites and the names say so: `splits.py` gets the whole alignment in
one call and divides at `:151-153`; the runtime cannot, so it accumulates and divides once by
`L·num_layers` and by `L`. The averaging is in the graph because the unreduced `[L,heads,N,N]`
tensor is 12.6 MB per site at taxon cap 512 — 12.6 GB for 1000 codons.

`scripts/verify_onnx.py` gained the element-wise gate; the manifest gained
`variants.<v>.taxa_onnx_sha256`, `onnx.taxa_outputs`, `onnx.taxa_row_layers` and `onnx.embed_dim`.
`taxa_outputs` is deliberately **not** merged into `onnx.outputs`, which is the default fetch list
for a backbone session. Both new keys are optional by construction, so a manifest without them
means the dating graph was not built and the model-based estimators must be *unavailable* rather
than approximated.

| Artifact | sha256 | Status |
|---|---|---|
| `models/general_taxa.onnx` | `eb44892de607…` | new, 7,340,384 B |
| `models/viral_taxa.onnx` | `5fa5167f3828…` | new, 7,340,384 B |
| `models/general.onnx` | `aa10e8e0…` | **unchanged** |
| `models/viral.onnx` | `c3ea5795…` | **unchanged** |
| `models/busted_head.onnx` | `2ad554e0…` | **unchanged** |

**The library** (`8d80132`, `62f41d2`, `0dba6f4`, `77b9c23`, `23a6c38`). `js/src/datingModel.js`
and `fminbound` in `js/src/numeric/optimize.js`, beside `brentq`. The public surface, all from
`@veg/hyphaeon-js`'s single entry point; matrices are flat row-major `Float64Array`:

- `computeNeuralCovarianceKernel(crossAttn, n, taxaRepr = null, embedDim = 0)` → `n·n`, unit diagonal
- `estimateRemlPagelLambda(times, dists, covMatrix, {eigen})` → `{best_lambda, status, w_K, V, objective, nfev}`
- `runPglsDating(times, dists, covMatrix, {ridge, pagelLambda, tRef, ciMethod, eigen})` → the
  reference's record, snake_case in the reference's insertion order, plus `cov_beta`
- `optimizeLatentConvexHullRoot(taxonRepr, times, {embedDim, taxaNames, pairwisePhysDists, anchorMask, learningRate, maxIter, trajectorySteps})`
- `pairwiseAcgtHammingMatrix(sequences)`, `fminbound(f, a, b, {xatol, maxIter})`
- constants: `PGLS_DENSE_EIGEN_MAX` 2500, `REML_DENSE_MAX` 2000, `PAGEL_LAMBDA_BOUNDS`,
  `REML_STATUS`, `ADAM_DEFAULTS`, `LATENT_ROOT_DEFAULTS`, `LATENT_TRAJECTORY_STEPS`

Pass `estimateRemlPagelLambda`'s `w_K`/`V` back as `runPglsDating`'s `options.eigen`: the reference
decomposes the same matrix twice per fit (DATING Q9), and this is the saving its own unused reuse
branch was written for.

Five things **refuse** rather than approximate, all `RangeError`: `n > 2500` (the eigsh branch),
`n > 2000` in REML (the stratified subsample), the poisson / residual-boot / wild / jackknife /
loocv intervals, `ridge='auto'`, and `n < 3`. An unrecognised `ci_method` string still falls
through to Fieller, as upstream.

**The GLS spline and the record fixture** (`081d1f1`, `a4738ab`, `8a3ce78`). See §6, DATING Q10 —
this was a deliberate change beyond the brief, because the record would otherwise carry a wrong
number. `fixtures/dating/run_mrca_dating_model.json` is the CLI's own two records.

### App — this worktree, branch `feat/dating-model`, head `8458fc6`

Six commits over `ac7875d`.

- `477574b` — the session layer. `loadTaxaGraph({modelPath|modelUrl, expectedSha256, threads})`,
  `runTaxaSites(session, bundle, ort)`, `createSession(...).loadTaxaGraph()` returning **null** when
  the manifest declares no dating graph; `manifest.js` gained `TAXA_OUTPUT_NAMES`,
  `taxaOutputNames()`, `taxaGraphArch()` and `pickVariant().taxaOnnxSha256/taxaOnnxFile`. And the
  pass itself: `@veg/hyphaeon-runtime/dating/neural` (`runtime/src/datingNeural.js`, kept **outside**
  `src/dating/` on purpose), `runDatingModelPass({alignmentText | sequences, session, manifest,
  batchSize?, progress?, signal?})` → `{crossAttn, taxaRepr, taxa, N, L, embedDim, rowLayers,
  batchSize, calls, starsRewritten, elapsedSeconds}`. It runs **every** codon, not the variable ones,
  with no taxon cap and no duplicate pruning, over all alignment taxa in alignment order — 7.3 s for
  korber's 143 × 981 at 4 threads in Node.
- `3139a50` — the covariance, the fits and the record. `runDating` gained `neural`, `distanceMode`
  (`'auto' | 'tn93' | 'latent'`) and `modelUnavailableReason`, and returns `{pgls, latent,
  distanceMode, distanceModeReason, pagelLambda, printedRidge, covTrain}` on top of its old shape;
  the record fills `pgls`, `latent_root` and `distance_mode`. `DATING_SCHEMA_VERSION` is 2.
  Also exported: `resolveDistanceMode`, `DATING_DISTANCE_MODES`, `DATING_NEURAL_MAX_TAXA`,
  `effectiveRidge`, `neuralKernel`, `sliceSymmetric`, `sliceRows`, `latentRoot`,
  `latentRootDescription`, `fitPgls`, `NOT_BUILT_WITHOUT_MODEL`.
- `ad50ec6` — `ENGINE_REF`. See §7.
- `36e2404`, `5b40e85`, `8458fc6` — the page. The model half is an **opt-in second action** in
  section 3, in its own worker: `web/src/lib/workers/datingModel.worker.ts` loads
  `<variant>_taxa.onnx`, runs the pass, then calls the same `runDating` with `neural` handed in. It
  is not a branch on `dating.worker.ts` — that worker's import graph is what makes "the date review
  costs no model byte" a fact — and not a request kind on `analyze.worker.ts`, because it is a
  different artifact over a different site and taxon set. The reader picks the distance mode: `auto`
  (the reference's default, resolving to latent) or `tn93`, which is the other ground-truth run —
  covariance from the model, divergences still sequence distances. Both are the reference's and
  neither is more correct.

The reusable part is the view model, `web/src/lib/time/dating.ts`: `headlineOf` (quote
`active_model` unless its interval is its own point estimate, so a tn93 model run quotes the GLS fit
and agrees with the CLI's `t_mrca`, where phase 3's "always OLS" could not), `distanceModeOf`,
`modelRan`, `divergenceSentence`, `latentRootView`, `agreementNote`, `modeShiftSentence`,
`modelOffer`, `MODEL_NAMES`/`MODEL_SHORT`, `isDegenerate`.

Three new warning codes a page must render: `DATING_LATENT_DIVERGENCES` (the divergences are not
sequence distances, and *every* estimator was fitted against them), `DATING_MODEL_SPLINE_REWEIGHTED`
(the spline is a GLS spline and is not the one a model-free run draws), `DATING_CLADE_ATTENUATED`
(the GLS fit was disqualified from both the headline and the averaged row). Plus
`DATING_MODEL_GRAPH_ABSENT`, `DATING_MODEL_TAXA_MISSING` and the refusal
`DATING_MODEL_TOO_MANY_TAXA`.

`TimeSetRecord` is schema 3 (`TimeSetOptions` gained `useModel` and `distanceMode`, `DatingResult`
an optional `model`); a v2 record reads back as the model-free review it was, with its stored
version number left alone. `rootCase` is now `number | null` everywhere on the app side — the latent
root is not one of `compute_tree_free_divergences`' four cases, and `rootSentence` tests the
`latent_convex_hull` prefix before anything else.

**The one thing a caller must not get wrong**: pass the *raw* alignment text to
`runDatingModelPass`, or sequences whose `*` has already been rewritten to `-`. That rewrite is a
model input, not a clean-up (§6). The pass does it itself from text and reports the count as
`starsRewritten`.

## 4. The numbers

Every figure below was reproduced for this report against the reference's own runs, regenerated on
this machine, not read off a builder's summary. Ground truth is
`fixtures/dating/run_mrca_dating_model.json`, which two independent passes re-derived from the CLI
and deep-diffed to **0 numeric differences** in both records.

### The graph against torch

`splits.py::extract_cross_taxa_attentions_and_embeddings` vs onnxruntime on the *same*
`prepare_alignment` tensors (`max_species=None`, `prune_duplicates=False`, TN93 when tree-free):

| Check | cross_attn | taxa_repr |
|---|---|---|
| general, B=24, korber 143×981 | 1.169e-08 abs / 6.411e-07 rel | 2.992e-07 / 1.363e-07 |
| general, B=71 | 1.202e-08 / 6.592e-07 | 3.818e-07 / 1.739e-07 |
| viral, B=33 | 1.302e-08 / 5.522e-07 | 2.848e-07 / 1.357e-07 |
| general, 120-site slice, B=24 | 7.078e-09 / 3.644e-07 | — |

Correlation 1.000000000000 on every comparison; row sums ≈ 0.9815 (general) / 0.9776 (viral) on
both sides. Across the export stage's own 54 checks (both variants, three alignments — Smc6 20×1097,
korber 143×981 tree-free, camelid 212×96 — at two batch sizes) the worst were cross_attn 6.42e-07
relative and taxa_repr 5.40e-07 relative, zero failures. Batch-invariance — the property `runtime/`
depends on and nothing else tested — holds to 1.286e-09 between batches of 78 and 31, and the
backbone's `lrt`/`mean_root_attns`/`root_repr` are **bitwise** identical to the committed graph at
N = 7, 13, 31, 143.

**On the tolerance.** The first bound was absolute 2e-8, taken from the spec, and it failed Smc6 at
2.72e-08. That was the bound's shape being wrong, not the graph: the error is float32
reassociation (the graph sums the whole call, `splits.py` sums in chunks of 32), so absolute error
scales with the largest entry, which scales as 1/N. Absolute error spans 14× across the three
examples while relative spans 2.7× and is flat in both N and L — Smc6's relative error, 6.04e-07, is
*lower* than korber's. The bound is therefore relative 1e-6, 1.6× the worst observation and four
decades below any structural error (a transposed block or an off-by-one slice moves entries by
≥ 1e-4). One absolute bound is kept, on korber alone, and it is the only tolerance derived from a
product quantity: measured chain sensitivity is cross_attn 1e-8 → K 8.1e-6 → `t_MRCA` 7.8e-4 years,
so 2e-8 is what a 1e-3-year acceptance class buys.

### The estimators against the reference, in the browser

Driven headless-Chromium against the built site: korber loaded, tree-free, the one-undated gate
accepted, root CONSENSUS, the model-free estimate first, then the model estimate in both modes.
Compared field by field against reference runs produced on the same machine, walking every leaf
including all 142 `taxa_summary` rows.

**`auto` → latent:**

| Quantity | Page | Reference | Difference |
|---|---|---|---|
| OLS `t_mrca` (the headline) | 1926.8 [1880.6, 1945.9] | 1926.8110 [1880.6099, 1945.8828] | 5.0e-6 yr (rel 2.6e-9) |
| OLS `mu`, R² | 5.551e-4, 0.140 | 5.551006e-4, 0.139684 | — |
| PGLS `t_mrca` | 1633.1, no lower bound, upper 1836.7 | 1633.0721 / −inf / 1836.7086 | 4.7e-4 yr (rel 2.9e-7) |
| Pagel λ*, Fieller g | 0.8591, 1.72 | 0.859133, 1.72355 | — |
| Spline `t_mrca` | −1974.2 | −1974.2815 | **0.120 yr** (rel 6.1e-5) |
| Spline `rate_ancestral` | 9.088e-6 | 9.088133e-6 | 3.1e-5 rel |
| Ensemble | 1926.8 [1894.2, 1959.4], ols 100 % | 1926.8110 [1894.1746, 1959.4475] | ≤ 1.7e-5 yr |
| Latent root α, R | 0.05407, +0.374 | 0.05406844…, — | 4.6e-8 rel |
| Six anchors | B85US.ALA1 .3240, D90UG.UG269A .2311, C89SO.SM145A .1971, C91DJ.259A .1422, D90UG.274A2 .0385, D84ZR.NDK .0255 | same taxa, same order | worst weight 2.5e-5 rel |
| Curvature test | F 0.25, p 0.6213, ΔAIC −1.75 | 0.245192 / 0.621269 / −1.7497 | — |
| Holdout Z59ZR.ZHU | predicted 3084.5 (label 1959.5) | 3084.4907 | — |
| 142 taxa rows | — | — | worst rel: root_divergence 4.2e-7, fitted 8.3e-8, predicted_date 4.5e-8, z 3.5e-5 |

`selected_clock`, byte for byte: `Linear (OLS preferred: PGLS temporal slope non-significant,
g=1.72 vs OLS g=0.173)`.

**`tn93` + model covariance:**

| Quantity | Page | Reference | Difference |
|---|---|---|---|
| PGLS `t_mrca` (the headline, `active_model=pgls`) | 1841.6 [1753.2, 1882.2] | 1841.6130 [1753.1766, 1882.2303] | 1.9e-4 yr (rel 1.0e-7) |
| PGLS `mu`, R² (Buse), λ* | 7.708e-4, 0.170, 0.6984 | 7.70789e-4, 0.169941, 0.698425 | — |
| OLS row | 1893.9 [1850.9, 1916.8], 1.169e-3, R² 0.231 | identical | **0.000e+00** — no model output enters it |
| Spline row | 1864.5, 9.178e-4 | 1864.5478, 9.17756e-4 | 3.2e-4 yr |
| Ensemble | 1883.1 [1824.4, 1941.8], ols 79 % / pgls 21 % | 1883.0964 [1824.3987, 1941.7942], .79321 / .20679 | — |
| 142 taxa rows | — | — | worst rel z / temporal_residual 1.0e-4 (2.9e-5 absolute) |

`selected_clock`: `Linear PGLS (parsimonious linear clock preferred, λ*=0.6984; p=0.5753)`.

**Worst disagreement anywhere: 0.120 years**, the latent-mode spline date. It is `−β₀/β₁` on an
uncentred calendar axis with `β₁ = 9.09e-6` (DATING Q5, condition number 9.3e12) — a lever arm of
about 2,000 years per unit relative error in the slope. `β₁` itself lands at 1.1e-4 relative, and
pinning λ* to the reference's own value moves the date only from 0.43 to 0.38 years, so the residual
is the kernel's float32 BLAS floor and not the optimiser. Its well-conditioned rate is asserted
exactly. Everything else on the page is ≤ 3e-5 relative and almost all of it ≤ 3e-6.

### The port, function by function (library stage, before any app code)

| Stage | Agreement with the reference |
|---|---|
| Covariance kernel | max \|ΔK\| 1.954e-06 — the floor, not a defect: `cross_attn` and `taxa_repr` are float32, so numpy's Gram products at `dating.py:96` and `:107` are BLAS sgemm and no float64 port can be bit-exact |
| PGLS, given the reference's own λ | worst exported field 2.5e-11, `t_MRCA` 1.2e-11 yr — every quantity has the form `aᵀ V f(w) Vᵀ b` and is invariant to the eigenbasis, the opposite of the MDS situation |
| REML | scipy's own 12 function evaluations; λ within 2.7e-10 (latent) and 1.3e-8 (tn93), the residual being the objective's float64 reassociation — on a closed-form objective `fminbound` agrees with scipy exactly |
| Latent root, 250-step Adam replayed on a hand-derived gradient | max \|Δw\| 3.823e-07, \|Δz_root\| 2.611e-07, \|Δdists\| 1.190e-07, Δ(temporal_r) 1.500e-08, same six anchors in the same order |
| Whole chain, fixture model outputs → published date | 8.1e-07 yr (tn93), 4.1e-04 yr (latent) |

### Timing

| | |
|---|---|
| model-free estimate, browser | 56 ms and 64 ms wall, press to verdict; zero `.onnx`, zero ORT |
| model estimate, browser, total | 6,912 ms (tn93) / 7,712 ms (auto), incl. the one-off 7.3 MB graph download and session creation |
| the forward pass alone | 6,406 ms / 6,864 ms — 143 × 981, batch 78, 13 calls, 6 row layers, embed_dim 384, 14 threads |
| reference CLI, same box | 6.03 s end to end on MPS |
| the pass in Node | 7.3 s at 4 threads |

Exactly one graph is fetched (`/models/general_taxa.onnx`), ORT is
`ort-wasm-simd-threaded.{mjs,wasm}`, off-origin requests `[]`, failed requests `[]`, console and
page errors 0 across both runs.

### Suites

| Suite | Before | After |
|---|---|---|
| engine `js` | 32 files / 1267 | 33 / **1339** (+72) |
| `runtime` | 26 / 493 | 27 / **525** (+32) |
| `web` | 22 / 215 | 23 / **245** (+30) |
| `mcp` | 10 / 113 | 10 / 113 |
| `server` | 5 / 57 | 5 / 57 |
| `svelte-check` | 640 files, 0 errors | **641, 0 errors, 0 warnings** |
| Playwright | 62 | **69** in 39.7 s |

No vitest case was skipped anywhere; `runtime/test/dating-model.test.js` ran all 32 for real against
the live graph (74.6 s), and Playwright's `time.spec.ts` flow 1c runs the full browser forward pass
(10.8 s). That was the failure mode specifically looked for, given that both new suites `skipIf` on
the engine checkout.

## 5. What verification found

Three passes, run independently of the builders: a full-suite pass, a browser QA pass driving the
built site against reference runs it produced itself, and a fidelity review reading the port
against `dating.py`, `splits.py`, `model.py` and scipy's own source. All three returned
**green with known gaps**. Twelve fidelity spot checks came back clean, including the
`np.divide(where=, out=np.eye)` semantics and the silent `len(taxa_repr) != n` drop, `fminbound`
transcribed against scipy 1.16.2's `_minimize_scalar_bounded` line for line
(`sqrt_eps=sqrt(2.2e-16)`, `si=np.sign(rat)+(rat==0)`, the `tol1`/`tol2` recompute), the
hand-derived Adam gradient re-derived from scratch, and the subsetting order kernel → dated →
training (`dating.py:2568`, `:2576`, `:2781`) — centre-then-subset, not subset-then-centre, which a
caller that slices first gets plausibly wrong. Every upstream quirk checked is replicated and
flagged (B11–B19), none silently fixed.

What the passes found that the builders had not:

1. **Figure 2's caption is wrong in latent mode.** `DatingFigure.svelte:101` and `:55` hard-code
   "the vertical axis is TN93 distance to {rootLabel}" and an aria-label of "TN93 divergence from
   the root", while the page's own note two paragraphs above says in orange that divergence here is
   *not* a sequence distance, and `rootLabel` completes the sentence with "…a root the model placed
   inside its own representation of your sequences". This is the one place a reader is told
   something false. The fix is one conditional on `distanceMode`; the e2e's selector (an aria-label
   containing "TN93") moves with it.
2. **The headline does not name the estimator when it is OLS** (`dating.ts:548`). tn93 mode reads
   "…*by the generalised fit*, share a common ancestor in 1841.6"; latent mode reads a bare "…share
   a common ancestor in 1926.8". That was defensible when OLS was the unmarked model-free fit, but
   under `auto` the ordinary fit is now fitted against latent divergences and has moved 32.9 years.
   Recoverable three ways on the same screen, so an attribution gap rather than an error.
3. **Figure 2 is unreadable in latent mode, for a data reason.** The y axis scales to the held-out
   Z59ZR.ZHU, whose latent divergence is ≈ 0.64 against a fitted band of 0.02–0.04, so all 141
   fitted points collapse into a hairline. In tn93 mode the same holdout is only ≈ 4× the band and
   the plot reads normally. Excluding holdouts from the y-domain would fix it.
4. **A plural/verb disagreement on one of the two model paths** (`DatingSection.svelte:344`): with
   exactly one live warning the page renders "1 thing that change how it should be read".
5. **`viral_taxa.onnx` is deployed and unreachable.** `copy-assets.mjs:152` copies every `*.onnx`,
   but `/time` has no variant control: `+page.svelte:462` resolves only the default and
   `datingModel.worker.ts:63` is never passed a `variant`. 7.3 MB rsynced and never fetched.
6. **A stated parity that does not exist.** `+page.svelte:461-463` claims its probe takes "the same
   rule the worker's `pickVariant` takes" and reads `doc.default_variant ?? 'general'`;
   `manifest.js:203` never reads `default_variant` — `DEFAULT_VARIANT` is the hard constant
   `'general'`. Both resolve to general today, so nothing diverges, but the claim that "if a future
   manifest names a non-general default, both move together" is false.
7. **Reader-excluded sequences still shape the covariance, undocumented.** The worker hands
   `runDatingModelPass` the full alignment text while `run.js:265` drops `excludedTaxa` from
   `datedTaxa`, so an excluded sequence leaves the fit, the hull and the α calibration but keeps
   contributing its row to the column centring at `dating.py:95`/`:106` — exclusion behaves as
   "undated", not "not in the file". `datingNeural.js` note 3 documents only "including undated
   ones".
8. **The REML fit's own status is thrown away** (`modelFits.js:178-187` keeps only `best_lambda`).
   A non-converged `fminbound` silently yields the reference's 0.95 fallback, and a *flat* profile
   yields an arbitrary λ inside the bracket — which `gen_fixtures.py:84-91` documents for an
   identity and a rank-1 kernel ("the profile varies by 2.7e-12 across the whole box"), i.e. what a
   covariance over near-identical sequences looks like. `dating.ts:797` then prints "Pagel's λ* = …
   estimated by profile REML" unqualified. The reference prints the number too, but does not assert
   it was estimated.
9. **`DATING_LATENT_ALPHA_ASSUMED` can never fire** (`codes.js:63`, message at `:271`):
   `modelFits.js:150` always supplies `pairwisePhysDists`, so `dating.py:756-757`'s assumed-α branch
   is unreachable on every app path.
10. **`modelRan()` reports the pass, not the estimate** (`dating.ts:530` reads
    `primaeon.model_pass`, set from `hasModel` alone). On the tn93 + `DATING_MODEL_TAXA_MISSING`
    path the record carries `pgls: null` and a model-*free* spline, yet the section still frames the
    run as a model run. Nothing fabricates a fit — `agreementNote` and the table handle
    `pgls: null` correctly — but the framing is wrong in that state.
11. **`runPglsDating`'s singular-2×2 `RangeError` is uncaught** at `run.js:497`, where the spline
    immediately below it *is* wrapped. Faithful to `dating.py:1371`, which has no `try/except`
    either, and practically unreachable because `DATING_NO_TIME_SPAN` refuses first — noted only
    because it would take the model-free estimates down with it rather than producing a refusal.

Two fixes the new e2e turned up, both pre-existing: section 4 said a sequence "calibrated the
clock", which breaks the page's own forbidden-vocabulary rule (flow 2 checks those four words but
never runs an estimate, so the violation had never been rendered under a test that looks); and a
stale comment claimed orange on this page is "reserved for problems with the dates" when the page's
actual rule, and `DESIGN.md`'s, is the warning treatment for what changes the answer. One runtime
message was corrected: `DATING_MESSAGES.MODEL_GRAPH_ABSENT` asserted "this build has no dating
graph" in the template while the caller passes a different reason into the parenthesis, so on a
build that *has* the graph the sentence contradicted itself.

The best thing on the page is the mode-shift sentence, and it is measured rather than asserted:
"The ordinary fit moved from 1893.9 to 1926.8 — 32.9 years — between your last two runs, and its
arithmetic did not change. Its *input* did: divergence was measured to TN93 distances and is now
measured to the latent root, and the rate went from 1.169e-3 to 5.551e-4. The two are not one
estimator disagreeing with itself; they are two response vectors." Both endpoints check out against
the reference — 1893.91095511759 to double precision, 1926.8110 to 5e-6 years.

## 6. Upstream problems found

**The asterisk is a model input, and it closes the previous stage's flagged TN93 divergence.**
`dataset.py:747` writes `seq_dict[t].replace('*','-')` into the FASTA it hands the `tn93` binary;
the pure-Python branch does not. Korber is a LANL MASE alignment with **2,389 asterisks**, and that
TN93 matrix is the transformer's own `dist_matrix` input, so the two branches are two different
forward passes. Measured: without the rewrite the site-averaged cross-taxa attention is off by
1.703e-3 (9.3 % of its largest entry) and the embeddings by 4.067e-2; with it, 1.22e-8 / 6.7e-7
relative. The library stage had reported this as a "tn93 binary vs package" algorithm difference;
it was never that. `runtime/test/dating-model.test.js` pins both numbers, and the record says
`stars_rewritten: 2389`.

Seen from outside, this means **the reference's published date is a function of the reference
machine's optional dependencies**. With `/usr/local/bin/tn93` on PATH the command gives OLS
1926.811 / PGLS 1633.072 / spline −1974.28, α 0.054068, λ* 0.85913. With `PATH=/usr/bin:/bin`, so
`dataset.py` falls back to the pure-Python distances, the *same* command gives OLS 1926.898 / PGLS
1625.032 / spline 1611.93, α 0.054103, λ* 0.85371 — 8 years on the generalised fit and 3,586 years
on the spline. The app takes the binary branch deliberately, which is why it agrees.

**DATING Q10 — switching the model on silently changes phase 3's spline.** `dating.py:2842-2844`
passes `cov_train` as `spline_cov` whenever the neural path ran, so the restricted spline becomes a
GLS spline on divergences that did not move: on korber tn93, `beta_0` goes −4.3868 → −1.7112,
`t_mrca` 1938.77 → 1864.55, `is_nonlinear_preferred` True → False, and the clock selection flips.
Phase 3's `runRestrictedSplineClockDating` took no covariance and its header said the arm was
unreachable. It now takes `covMatrix`/`ridge` — a deliberate engine change beyond the brief,
because the record would otherwise carry a wrong number. With `covMatrix` null the arithmetic is
bit-identical to phase 3's, and a test asserts that null is not the same code path as an identity;
pinned by a new fixture, `run_restricted_spline_clock_dating_gls.json`, generated from the reference.

**DATING Q11 — `--distance-mode auto` resolves to latent, not tn93**, whenever there is no tree and
the model is available. So under `--method all` the divergences fed to *every* estimator, the
ordinary least-squares one included, are `α·‖z_i − z_root‖`. On korber that moves `ols.t_mrca` from
1893.91 to 1926.81 and `ols.mu` from 0.001169 to 0.000555. A report must name the divergence
source and not only the estimator, which is what the page's divergence note and mode-shift sentence
exist to do.

**DATING Q8 — three numbers under one word.** `primaeon` carries `pagel_lambda`, `printed_ridge`
and `model_pass`, and `record.pgls.ridge` is a third number: 0.6984, 0.2000 and 0.3016 on korber. A
page must never show two of them under one label.

**An unexplained reference artifact.** The proof survey's `phase4/korber-truth.json` no longer
reproduces, and it is the reference that moved, not the page. Four runs of the brief's exact
command (three on MPS, one `--cpu`) are bit-identical to each other and to the survey's other file,
`phase4/korber-all.json` — OLS 1926.8110104271354, α 0.05406844636921284 every time.
`korber-truth.json`, same command, same log banner, same day, carries OLS 1923.8242, PGLS
1658.6425, spline 1366.6915, α 0.0592915, λ* 0.862946 and a *different* anchor ordering. It could
not be reproduced or attributed: `hyphaeon/*.py` is unchanged since (only `export.py` moved on this
branch), the PATH-branch hypothesis gives a third distinct answer, and MPS is deterministic across
repeats here. So the latent-root search has at least one input this verification has not
identified, with a 25-year swing in the generalised fit and a 3,341-year swing in the spline behind
it. The page was compared against the answer the command gives today, and it matches.

**`scripts/verify_onnx.py` cannot run anywhere but the author's machine.** The new element-wise
taxa gate (`:337`, `:392`, `:430`) calls `resolve_variant_weights(variant, None, hf_dir)`, which
takes no override and does not consult `HYPHAEON_WEIGHTS`. The manifest's recorded `general`
weights (`0278dff0`) are not on this machine — `*.safetensors` is gitignored — so the default
invocation aborts with `FileNotFoundError` before any check runs, and CI cannot run it either. The
`--variants viral` run does pass, 41/41 including all 20 new taxa checks, exit 0. A
`--general-weights` passthrough (which `run_export` already has) would close it. The graph is not
unverified — the app's runtime suite covers `general_taxa.onnx` against fixtures, an independent
torch-vs-onnxruntime harness covers it directly, and `verify_onnx` covers `viral_taxa.onnx` against
torch — but the specific general+torch path cannot be re-run by a reviewer here.

**Pre-existing and unrelated**: the engine's pytest suite fails 3 of 308 on this machine
(`test_autoclock_with_beast_xml` and `test_hierarchical_autoclock_deconvolution` on a missing
`sklearn` in a scratch venv, `test_training_cli_runs_two_epochs_from_checkpoint` on a
`CalledProcessError`). Attributed, not assumed: a pristine `phase-5b` worktree produces a
byte-identical failure set in 3.56 s, and this phase's Python diff touches only `export.py`,
`gen_fixtures.py` and `verify_onnx.py`. Separately, that suite is not side-effect-free in the
repository root — it regenerates the tracked `h5n1_geo_example.png` and drops a transient
`errors.log` — which matters before anyone wires pytest into CI on a checkout they care about.

## 7. What the new graph costs the existing pillars

Nothing numerically, and 14.7 MB on the wire.

- `models/` gained exactly two files; the three existing graphs hash identically to `phase-5b`
  (`aa10e8e0`, `c3ea5795`, `2ad554e0`) and the manifest diff is additive only.
- A fresh `runEverything` on **bat_oas1** (tree-based, 8 threads, 3.5 s) and on **camelid**
  (tree-free / TN93, 19.5 s), with each committed record's own options, reproduces them with **0
  numeric differences** in sites, gene, epistasis, attribution, filter and DMS. Only
  `sites.runtime_sec` (0.0999 → 0.1226) and `epistasis.elapsed_sec` (0.104 → 0.108) moved.
  Key-set parity was checked in both directions so a missing key could not hide a shape change:
  exact everywhere except `provenance.options.prepared.*` on sites, which is the tensor bundle the
  prebake script strips by design.
- Independent corroboration from the mcp suite: bat_oas1 sites vs `hyphaeon meme` max relative
  \|ΔLRT\| 2.41e-6, identical to the figure `CLAUDE.md` has recorded since Phase 2.
- `web/static/models` grows 16.7 MB → 32 MB (+88 %) after the build copies both taxa graphs. 7.3 MB
  of that — `viral_taxa.onnx` — is unreachable from any surface today (§5.5). The 14.7 MB is fetched
  only by a reader who presses the opt-in second action; the empty `/time` route, a route with a red
  gate, and the whole selection report still fetch not one byte of it.
- A full `HYPHAEON_PREBAKE=skip npm run build` left `git status` empty: no tracked file touched.

## 8. What remains

**Blocking for CI.** `ENGINE_REF` in `.github/workflows/ci.yml:107` is now the *branch*
`feat/dating-model`, which is unpushed and untagged in both repositories. Both jobs check out
`veg/HyphAeon` at that ref, so both fail at `actions/checkout` and none of the numbers above has
been reproduced on a clean runner. The pin genuinely had to move —
`runtime/src/dating/modelFits.js:57-63` imports five library functions by name that `phase-5b` does
not have, and a named import of something the pinned engine lacks fails at module link and takes the
whole workspace with it. The integrator must push and tag before anything green can be claimed.

**Not done, out of scope by the brief.** Nothing in `mcp/` or `server/` exposes the model-based
estimators: the MCP dating tool was deferred at phase 3 (`PHASE3-DATING.md:313`) and the server has
no dating analysis at all. Both suites were run only to confirm no regression. The server's worker
pool would need a per-worker `loadTaxaGraph`, which is the same shape as its existing BUSTED head
load.

**Refusals, not omissions.** Three large-N branches are declined rather than approximated:
`run_pgls_dating`'s truncated Lanczos above 2500 taxa (ARPACK on a float32 cast, tol 1e-4, no JS
equivalent), `estimate_reml_pagel_lambda`'s 1500-row stratified subsample above 2000 with its
`OPTIMAL_REML_SUBSAMPLED` status, and the three Monte-Carlo intervals (each needs numpy's PCG64
stream and each first materialises a dense N×N `C_inv`). Above 1,500 dated sequences the run
refuses with `DATING_MODEL_TOO_MANY_TAXA` where the reference quietly falls back to OLS — because
the covariance the fallback does not build is the whole difference between the two answers.

**Open questions.**

- The 256/512-taxon cap is a *meaning* question, not a memory one. The reference dates uncapped and
  unpruned, and `runDatingModelPass` follows it, so at korber's 143 taxa the two agree exactly. A
  surveillance-sized upload would need the page to decide whether the report's capped taxon set and
  the dating pass's uncapped one may disagree about which sequences exist.
- The latent-over-tree promotion rule at `dating.py:2619-2683` (a supplied tree with slope ≤ 1e-6 or
  R² < 0.02 re-runs the latent extraction and takes it if `lat_r > 0` and `lat_r2 > tree_r2 + 0.05`)
  is orchestration, is not ported, is reachable in the app, and no second example with a real tree
  exercises it.
- The model run **replaces** the record rather than extending it, and only the latest is stored.
  That is deliberate — under `auto` the two runs are fitted against different response vectors and
  merging them would invite exactly the averaging this phase exists to avoid — but it means the
  one-sentence comparison between them lives in session state and is gone after a reload. Worth a
  decision if the pillar ever gets a run history.
- `scripts/parity.py` still has no dating comparator. Also still unported and previously declared:
  the power-law clock (D33), LOOCV, tree re-rooting (D34), and site-boot.
- `web/DESIGN.md` §6's e2e contract does not list `/time` at all, so this phase's four new hooks
  (`.model[data-state]`, `.divergence`, `.agreement`, and the aria-labels "Root for divergence" and
  "Divergence with the model") are unrecorded there.
- The offer's cost claim ("143 sequences × 981 codons took 7.3 seconds" *at four threads*)
  undersells its own scaling: measured at fourteen threads it takes 6.4–6.9 s, i.e. the pass is
  nearly flat in thread count. Not wrong, and it errs safe, but the qualifier implies a scaling
  that is not there.
- The two new suites `skipIf` on the engine checkout, so a missing sibling checkout is a silent skip
  rather than a failure. `runtime`'s header says it skips loudly;
  `web/src/lib/time/datingModel.test.ts:58` uses `describe.skipIf` and does not.
