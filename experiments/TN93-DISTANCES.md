# Can TN93 distances replace the tree in the model's input?

Branch `explore/tn93-distances`, measured 2026-09-07 against engine `feat/js-port` (`2078867`),
`general.onnx`, four intra-op threads, darwin/x64 Node 22. Every number below is reproducible with
the four scripts beside this file. Nothing in `runtime/`, `web/`, `mcp/` or `server/` was changed:
this is measurement, not a proposal already implemented.

## The question

Today (PLAN.md D22) a run uses the reader's tree when it carries branch lengths and pairwise TN93
distances only when it does not. If TN93 scored the same sites, one path would serve every upload,
nothing in the product would depend on a topology, and the tree would be a display artefact only.

The model was trained on **patristic** distances: `build_gene_npz`
(`hyphaeon/training_data.py:222`) calls `load_alignment_and_tree(alignment, tree)` with `use_tn93`
at its default `False`. TN93 at inference is therefore a distribution shift, and the only honest
test is against the target the model was trained to reproduce, real HyPhy MEME.

## Ground truth

`veg/HyphAeon` carries a committed MEME cache at
`model_eval/_cache/meme_<alignment sha256, 16 hex>_<tree sha256, 16>_hyphy2.5.101(MP).json`,
already reduced to per-site LRT and p-value. Three of the five bundled examples are in it:
bat_oas1, Smc6 and camelid. RHO and HIV1_RT are not. The metrics are the team's own, ported from
`model_eval/concordance/_common.py:144`.

## 1. The same run, both distance sources

`node experiments/tn93-vs-patristic.mjs`

| Example | Taxa | Codons | Default source | rho(TN93, patristic) | Calls p≤0.05 | vs MEME rho | vs MEME kappa |
|---|---:|---:|---|---:|---:|---|---|
| bat_oas1 | 18 | 351 | user tree | 0.9987 | 5 → 5 | 0.273 → 0.270 | 0.090 → 0.090 |
| Smc6 | 20 | 1097 | user tree | 0.99997 | 1 → 1 | 0.366 → 0.367 | −0.017 → −0.017 |
| camelid | 212 | 96 | already TN93 | 1.000000 | 15 → 15 | 0.323 → 0.323 | −0.003 → −0.003 |
| RHO | 655 | 349 | embedded tree | 0.9937 | 25 → **18** | no MEME cache | |
| HIV1_RT | 475 | 335 | already TN93 | 1.000000 | 35 → 35 | no MEME cache | |

camelid and HIV1_RT have trees without branch lengths, so both runs take the same path; they are
the control that the harness measures nothing when nothing changes.

Two readings. On the shallow examples the distance source is invisible: identical calls, and MEME
concordance moves in the third decimal. On RHO, seven of twenty-five called sites disappear.

At the product's actual default cap of 256 taxa rather than all 655, the same comparison on RHO is
20 calls against 17, sharing 16.

## 2. Why: pairwise divergence saturates

`node experiments/distance-matrices.mjs`

| Example | Patristic median / p95 / max | TN93 median / p95 / max | Pearson | TN93 ÷ patristic, median |
|---|---|---|---:|---:|
| bat_oas1 | 0.3513 / 0.3513 / 0.3513 | 0.2120 / 0.2640 / 0.2863 | 0.60 | 0.668 |
| Smc6 | 0.0238 / 0.0497 / 0.0540 | 0.0218 / 0.0433 / 0.0466 | 0.18 | 0.790 |
| RHO | 0.6810 / 1.1349 / 1.4995 | 0.0991 / 0.1449 / 0.2113 | 0.77 | **0.145** |

On RHO the tree's paths are about seven times the pairwise divergence. That is saturation: TN93
corrects for multiple hits under a homogeneous rate, while a fitted tree accumulates branch length
along a path and absorbs among-site rate variation. The deeper the alignment, the wider the gap.

Note Smc6's Pearson of 0.18. Two nearly uncorrelated matrices produce the same 1 call and rho
0.99997, so on shallow data the model is barely reading the distances at all.

## 3. The deficit is a scale effect, and the scale is what the tree measured

`node experiments/tn93-scale-sweep.mjs` multiplies RHO's TN93 matrix by k, recomputes the MDS from
the scaled matrix, and re-scores. Patristic baseline: 25 calls.

| k | Calls p≤0.05 | rho vs patristic | Shared with the tree's 25 |
|---:|---:|---:|---:|
| 1 | 18 | 0.9937 | 18 |
| 2 | 18 | 0.9946 | 18 |
| 4 | 19 | 0.9957 | 19 |
| 6.9 | 20 | 0.9968 | 20 |
| 10 | 24 | 0.9957 | 24 |
| 20 | 42 | 0.9755 | 25 |

The model reads magnitude as evidence strength, so compressed distances make it conservative and
inflated ones make it over-call. A single constant does not fix this: k is a property of the
alignment's depth and rate heterogeneity, the very quantity the fitted tree supplies.

## 4. Cost, and the WebAssembly question

`node experiments/tn93-speed.mjs`, against native `tn93` 1.0.15 on the same files.

| Alignment | Sequences × nt | JavaScript | Native binary |
|---|---|---:|---:|
| bat_oas1 | 18 × 1053 | 28 ms | 0.00 s |
| Smc6 | 20 × 3291 | 15 ms | 0.03 s |
| camelid | 212 × 288 | 54 ms | 0.03 s |
| HIV1_RT | 476 × 1005 | 821 ms | 0.24 s |

RHO's whole prepare is 1.73 s through the tree and 3.59 s through TN93, so the 655-taxon matrix
costs under two seconds. **No WebAssembly build of veg/tn93 is needed.** JavaScript is within about
three times native at the largest size the app accepts, the difference is a second against a model
pass measured in tens of seconds, and a second implementation would have to stay bit-identical with
the tn93 1.2.2 package that parity currently depends on.

## Recommendation

**Do not replace patristic distances unconditionally.** Keep D22 as it stands: use the tree's
distances when the upload has them, TN93 when it does not. The shallow evidence is genuinely
neutral, but RHO shows a real cost at depth, in the direction of missing selection rather than
inventing it, and the model was trained on the other input.

Three ways forward, cheapest first.

1. **Report the exposure.** A tree-free run at depth is conservative. Say so where the report
   already names the distance source, and quantify it with the number above.
2. **Correct the saturation.** A pairwise distance with among-site rate variation, TN93 plus a
   gamma correction, expands exactly the large distances that are compressed here. That is an
   engine change in `hyphaeon/dataset.py` and its JavaScript mirror, testable with this harness
   before anything ships.
3. **Remove the shift.** Retrain with TN93 distances, or with both, so the model has seen the
   input the app can always compute. That is the clean fix and the only one that makes the tree
   genuinely optional.

**The measurement that would settle it** is a real HyPhy MEME run on RHO, added to
`model_eval/_cache/`. It is the one deep example with a usable tree and no ground truth, so today
neither distance source can be called right on it. That run is expensive at 655 taxa, and it is the
team's to schedule.
