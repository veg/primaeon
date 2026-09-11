# Temporal selection and dating in PrimAeon — plan

Draft 2, 2026-09-11. Engine revisions read for this plan: `veg/HyphAeon` `main` at `49c188c`,
`feature/dating-mrca-module` at `b3b9d3c`, and `feat/js-port` at `5848336` (tag `phase-4b`, the line
PrimAeon is pinned to). Nothing here is built yet; this is the plan of record for the work, in the
shape of `PLAN.md`.

**Draft 1 was wrong on one point and it mattered.** It said the engine has no dating. It has a large
one, on `feature/dating-mrca-module`, which my first fetch missed because the local clone's remote
is configured to fetch only `main`. That branch is the subject of §3, and it changes the shape of
the work: dating is not something we invent, it is a second pillar to port.

## 0. The answer in one paragraph

Yes, the formats matter, and they are already decided upstream: both pillars ingest dates the same
three ways — from FASTA headers, from a Nextstrain Auspice JSON, or from a CSV/TSV metadata table —
and harmonise them to a decimal year, with dating adding a custom regular expression for headers
that fit none of the patterns. The parsing is the easy half. The hard half is that a dated set fails
quietly: metadata names are compared to sequence names with nothing but a trim, a partial table
never falls back to the headers for the taxa it missed, and a bare year is silently imputed to the
middle of the year. So date ingestion has to be a visible, reviewable stage of its own, and that
stage is most of the product work. What we are wrapping is two separate pillars, **dating** (a clock
rate, an ancestor date with a confidence interval, and the sequences whose dates do not fit) and
**temporal** (how selection at each site moves through time). Dating is the one to ship first: it is
smaller, it answers a question people already ask, its flagship example reproduces a famous result
in about a second, and its diagnostics are the honest gate on whether the temporal analysis means
anything. The blocker for both is that they live on two engine branches that have each diverged from
the line PrimAeon pins, and reconciling those is a prerequisite, not a detail.

## 1. What exists upstream

Three engine branches matter, and no two of them agree.

| Branch | Carries |
|---|---|
| `feat/js-port` (`5848336`, tag `phase-4b`) | What PrimAeon runs on: the ONNX export, the JavaScript library, the fixtures, the parity harness, the MDS sign convention |
| `main` (`49c188c`) | The `temporal` pillar, `splits`, the v0.1.0 release, a reworked `dataset.py`. No export, no library |
| `feature/dating-mrca-module` (`b3b9d3c`) | Everything on `main` at its fork point **plus** an epidemiology suite: `dating.py` (3,194 lines), `autoclock.py` (1,878), `r0.py` (935), `geo.py` (921), `sieve.py` (803), `sketch.py` (302), `alignment.py` (200), and dated example data |

The dating branch adds five new command-line verbs: `dating` (aliases `date`, `mrca`, `clock`,
`chronaeon`), `geo` for discrete phylogeography, `r0` for epidemic growth and reproduction numbers,
`sieve` for triaging very large collections, and `autoclock`. Only the first is in scope here; the
others are noted in §8 so the roadmap is not a surprise.

## 1a. The temporal pillar

`hyphaeon temporal` (aliases `surveillance`, `longitudinal`) landed on the engine's `main` in
`hyphaeon/temporal.py`, 1,100 lines, with `TEMPORAL_ANALYSIS_GUIDE.md` and two test files
(`tests/test_temporal.py`, `tests/test_temporal_experimental.py`). It advertises "continuous
temporal selection regression, two-stage filtering, and dynamic wave decomposition": per-site
selection trajectories over calendar time, their velocities, a small number of collective wave modes
extracted across sites, and a four-way classification of each codon against the static MEME result.

It has two modes. Calendar mode (`--time-units years`) is pathogen surveillance. Non-calendar mode
(`generations`, `days`, `arbitrary`) is experimental evolution: the LTEE support added in the same
series, where the time axis is generation number and a sweep is a permanent fixation rather than an
episodic wave (`--sweep-mode fixation`).

**What does not exist upstream:** any molecular-clock dating. There is no tip-dating, no time-scaled
tree, no rate estimate, no temporal-signal diagnostic. The pillar consumes dates; it never estimates
them. Anything we offer under the word "dating" is ours to build.

**The documentation is ahead of the code.** `TEMPORAL_ANALYSIS_GUIDE.md` documents flags that do not
exist (`--time-bins`, `--root`, `--out-dir`, `--min-peak-intensity`), a Python entry point that does
not exist (`run_temporal_analysis`; the real one is `run_temporal_surveillance`) and output files
with different names. Port from `temporal.py`, never from the guide, and raise the drift upstream.

## 2. The input contract, which is the hard part

All three mechanisms end in the same place: a map from taxon name to a float time coordinate. The
temporal pillar's rules are below; dating accepts the same three sources **plus** a user-supplied
regular expression, and in practice reads conventions these patterns miss — its own HIV example uses
two-digit years embedded in lab-style names. Treat the union as the contract, and make the page show
which rule matched each sequence.

### 2.1 Dates in FASTA headers

`extract_date_from_string` tries four patterns in order, each requiring a delimiter (`|`, `/`, `_`
or whitespace) before the date and a delimiter or end of string after it:

| Pattern | Example header | Parsed as |
|---|---|---|
| ISO date | `USA/WA-CDC-UW210415/2021|2021-04-15` | 2021.2868 |
| Decimal year | `hCoV-19/England/PHE-1234/2020|2020.9562` | 2020.9562 |
| Year and month | `B.1.1.7_Alpha_isolate_01|2021-01` | mid-January |
| Trailing year | `A/Darwin/6/2021` | 2021.5 |

Partial dates are imputed: a missing day becomes the 15th, a missing month becomes June, so a
year-only header lands at mid-year. February is clamped to the 28th and every other month to the
30th. Calendar values outside 1800 to 2100 are rejected as not-a-date.

In non-calendar mode the patterns change entirely: an explicit unit token (`gen_5000`, `_20000gen`,
`g50000`, `day_12`) wins, then a bare delimiter-bound number, and the year gate is off.

### 2.2 Nextstrain Auspice JSON v2

`parse_dates_from_auspice_json` walks the tree, and for each tip takes the first of
`node_attrs.num_date.value`, `node_attrs.date.value`, `node_attrs.year.value`, or the same keys as
bare scalars, falling back to parsing the tip name. This is the least error-prone path for anyone
who already has a Nextstrain build.

### 2.3 CSV or TSV metadata

Column discovery is by name, first match wins. The identifier column is sought among `strain`,
`taxon`, `taxa`, `name`, `id`, `accession`, `sequence_id`, `isolate` and two capitalised variants,
falling back to **the first column in the file**. The date column is sought among `generation`,
`generations`, `gen`, `timepoint`, `time`, `day`, `days`, `transfer`, `date`, `num_date`,
`collection_date`, `Date`, `submission_date`, `year` and capitalised variants, then any column with
"date" in its name. Both can be named explicitly (`--date-col`, `--strain-col`).

### 2.4 The four traps, and what the page must do about them

1. **Names must match exactly.** The metadata identifier is compared to the FASTA name with nothing
   but a `strip()`. No case folding, no accession extraction, no prefix matching. A table keyed on
   `EPI_ISL_402124` against headers reading `hCoV-19/Wuhan/IVDC-HB-01/2019|EPI_ISL_402124|2019-12-30`
   matches nothing at all. **The page must diagnose this the way the report already diagnoses tree
   tips**: how many taxa matched, at what tier, and a sample of the ones that did not.
2. **Partial coverage falls back only when coverage is zero.** The header fallback runs when the
   metadata produced *no* dates; a table covering 80 % of taxa leaves the other 20 % dateless and
   they are dropped downstream. The page should offer the fallback per taxon and say what it did.
3. **Imputation is invisible.** A header carrying only a year silently becomes mid-year, which on a
   two-year epidemic is a large error. The date review table must show the raw string, the parsed
   value, and whether it was imputed.
4. **Time units change the parser.** The same header parses differently under `years` and
   `generations`. The page must ask, or infer and show what it inferred, before anything runs.

## 3. Dating: the ChronAeon pillar

`hyphaeon dating` calibrates a molecular clock from time-stamped sequences and dates their common
ancestor. It runs three estimators and reports all of them side by side.

1. **Centred root-to-tip ordinary least squares**, an emulation of TempEst. Divergence from the root
   against sampling date, parameterised around the mean date rather than year zero, which makes the
   ancestor's standard error an exact expression instead of a numerically unstable one.
2. **Attention-derived generalised least squares.** Closely related sequences are not independent
   observations, which is why plain regression reports intervals that are too narrow. Instead of
   inferring a tree to get the shared-ancestry covariance, this uses the model's own cross-taxa
   attention as that covariance, with ridge regularisation. This is the pillar's flagship, and it is
   the reason the dating page needs the neural model at all.
3. **Latent manifold coalescent collapse.** Tree-free and root-free: track the variance of the
   model's 128-dimensional sequence representations over time and extrapolate back to where it
   vanishes, which is the founding bottleneck. It needs no root, no tree and no clock assumption,
   and upstream's own benchmark shows it beating the other two badly on within-host data.

It also offers clock curvature models (linear, restricted spline, power, or an automatic choice
between them), six ways to compute the ancestor's confidence interval, a bootstrap defaulting to a
thousand resamples, leave-one-out cross-validation, and per-taxon outlier detection.

**Inputs**: an in-frame codon alignment, strictly enforced, or a BEAST XML; an optional tree; dates
by the same three mechanisms as §2 plus `--date-regex` for headers that fit no pattern; and a root
taxon, which may be an explicit outgroup or a consensus.

**Outputs**: a results JSON, a per-taxon CSV carrying each sequence's sampled date, its predicted
date, the discrepancy and a Z-score, and optional diagnostic figures.

### 3.1 Why this is the half to ship first

The upstream benchmark reproduces a landmark result. On 143 HIV-1 group M envelope sequences, the
pillar dates the pandemic ancestor to 1927.6 with a 95 % interval of 1916.4 to 1938.7, against the
1931.4 published in 2000 off seven days on a 512-processor machine, and it recovers the same clock
rate. The model pass takes about a second. It also flags the 1959 Léopoldville isolate as the
outlier it is, and predicts its date to within a few years of the published estimate.

That is a browser-sized analysis with a famous answer, and the per-taxon outlier table is exactly
what a working virologist wants from a dating tool: which of my sequences have wrong dates.

### 3.2 The one open question: what the model has to give us

Two of the three estimators need model outputs. The latent estimator needs the 128-dimensional
sequence representation, which **we already export** as `root_repr`. The generalised least squares
estimator needs a cross-taxa attention matrix over taxa, and what our export currently emits is the
root row of that attention, not the full matrix. Whether the pillar builds its covariance from what
we already have, or needs a new graph output, decides whether the dating page costs an export change,
a new hash in the manifest, and a re-bake of every stored record. **This is the first thing to
settle**, and §5.1 records the answer once measured.

Note also what this pillar does *not* need: the trajectories, the permutation null and the wave
decomposition that dominate the temporal pillar's runtime. Dating is a regression over N taxa, not a
resampling loop over sites, which is the other reason it is the cheaper half.

### 3.3 What phylotree still gives us for free

`phylotree` 2.6.0 is already a dependency and already used by the site-tree modal, and it exports
root-to-tip regression with best-root fitting. That is not a substitute for the pillar, but it is a
useful instant preview: the moment dates are parsed, the page can draw the regression and its R²
before anyone commits to a full run, and it gives a second implementation to check the ported
ordinary-least-squares estimator against.

## 4. The page

One route, `/time`, covering both pillars, not a section of the existing report: the input is
different (an alignment *and* a time source), the failure modes are different, and the runs are long
enough to want their own cancellable page. Everything else is reused — the drop zone, the streaming
record, the IndexedDB store, the section machinery, the figure and caption idiom.

Four stages, streaming in the order a reader needs them:

1. **Dates.** What was found and from where, how many taxa carry one, the span, the units, and a
   reviewable table of raw string against parsed value with every imputation flagged. Unmatched names
   are shown, not swallowed. The reader can drop in a metadata file or a custom pattern here and
   watch the table change. Nothing else runs until this stage is green.
2. **Clock.** The three dating estimators side by side, as the command line prints them: ancestor
   date with interval, rate, R². The root-to-tip plot is the centrepiece and is drawn from the
   preview the moment stage 1 is green.
3. **Outliers.** The per-taxon table: sampled date, predicted date, discrepancy, Z-score. This is
   the part users act on, and it should be sortable and downloadable, with the option to drop the
   flagged sequences and re-run.
4. **Temporal selection.** The second pillar, offered rather than automatic because it costs minutes
   where dating costs seconds: per-site trajectories, velocities, wave modes, and the four-way
   classification against the static result.

Downloads mirror each command's own files so a browser run and a command-line run are interchangeable.

## 5. The port

Line references are to `hyphaeon/temporal.py` at `main` `49c188c`.

### 5.1 The good news: the model already gives us everything

The pillar calls the model **once per site and never again**. Sites are scored in batches
(`ceil(L / batch)` forward passes, five to eighteen for a thousand codons at five hundred taxa), and
it reads back exactly the pair every other pillar already reads: the per-site LRT and the root
attention `mean_root_attns`. Nothing downstream re-enters the graph. **No new ONNX export, no new
head, no change to the manifest.** The rest is arithmetic over two matrices.

The pipeline after inference: anchor a root (an explicit taxon, else the consensus of the earliest
5 % of dated sequences), turn attention into a per-site, per-taxon directional attribution against
that root, smooth it along time with a Gaussian kernel to get a trajectory per site, differentiate
for a velocity, filter on an energy floor, test what survives against a date-shuffling null, extract
four collective wave modes by singular value decomposition, and cross the result with the static
MEME q-values into the four-way classification.

### 5.2 What is already in the library, and what is missing

| Needed | Status |
|---|---|
| MEME p-values, Benjamini-Hochberg | **Already ported** and in use |
| Trapezoidal integration, peak-to-peak, variance, standardisation | Ten lines each |
| Gaussian kernel smoother | A matrix multiply, plus a row normalisation |
| `np.gradient` | Central differences inside, **one-sided at both edges**, which must match exactly |
| **Thin singular value decomposition** | **Absent.** Build it from the existing symmetric eigensolver on the smaller Gram matrix |
| Delimiter-sniffing CSV, Auspice JSON walk, column discovery | Absent, and by the split rule this belongs in the app, beside the FASTA validator, not in the library |

### 5.3 Cost, and the one loop that matters

For a realistic surveillance run, five hundred taxa by a thousand codons, two hundred and fifty time
points and the reference's default of a thousand permutations:

| Stage | Work | Estimate |
|---|---|---|
| Inference | 5 to 18 forward passes | seconds to tens of seconds |
| Smoothing | one matrix multiply | under a second |
| Gradients, integrals, widths | linear in sites times time | negligible |
| **Permutations** | **permutations x candidates x taxa x time** | **35 to 100 s at 200 candidate sites, 3 to 8 minutes at 1,000** |
| Both decompositions | a 250 by 250 eigenproblem each | under a second |

The permutation null is one to two orders of magnitude more expensive than everything else combined,
including the model, and it scales linearly in all four of its factors. It has to be a flat typed
array kernel in a worker, chunked so it can report progress and be cancelled, the way the digital
mutational scan already is. Memory is not a concern at a few megabytes, with one exception: the
per-site, per-time table must be stored as columns, not as a quarter of a million row objects.

### 5.4 What parity can and cannot claim

The reference draws its permutations from a hard-coded seed of 42 through numpy's Mersenne Twister;
the library standardises on a different generator and has already recorded, for phenotype, that the
streams cannot agree element by element. So the permutation p-value, its q-value, and **every label
that is thresholded on it**, which includes the confirmed-sweep flag and both classification columns,
can only be compared in statistical class. Everything upstream of the shuffle, the trajectories,
peaks, areas, widths and the static columns, is deterministic and should be held to the strict graph
class, as the other pillars are.

The wave modes carry a second, subtler problem: singular vector signs are not reproducible across
implementations, and the sign is exactly what the report would read as "in phase" or "anti phase".
This repository has been bitten by precisely this before, in the MDS eigenvector work behind D20, so
a sign convention has to be pinned on both sides before any comparison means anything. Where two
singular values are nearly equal the basis can rotate, and no sign rule fixes that.

### 5.5 Upstream quirks to replicate and report

Per the house rule, port the bug and flag it rather than fixing it in the port.

- A caller who passes the documented default peak threshold explicitly is silently overridden,
  because the override tests the value rather than whether it was supplied.
- The per-site trajectory file writes the same array into two differently named columns.
- The summary's keys say "years" whatever the time units are.
- An unknown root residue is labelled `X` on one code path and `-` on the other.
- The "earliest 5 %" root window is at least three sequences and at most twenty-five, so it is three
  for anything under sixty taxa and capped for anything over five hundred.

## 6. The blocker: three engine lines that have diverged

PrimAeon pins `feat/js-port`. The temporal pillar is on `main`. The dating suite is on
`feature/dating-mrca-module`, which is 22 commits ahead of `main` and 16 behind it. No two of the
three agree, and all three touch the same preprocessing file.

| | |
|---|---|
| `main` ahead of `feat/js-port` | 22 commits |
| `feat/js-port` ahead of `main` | 6 commits |
| `js/` (the whole JavaScript library) | exists only on `feat/js-port` |
| `hyphaeon/export.py` (the ONNX export the app runs on) | exists only on `feat/js-port`, 654 lines |
| `hyphaeon/dataset.py` | 171 lines apart |
| `hyphaeon/temporal.py`, `hyphaeon/splits.py` | exist only on `main` |

The dataset divergence is the one that matters, because the JavaScript library mirrors that file
line by line and the fixtures were generated from it:

- **`main` never took the MDS sign convention.** `resolve_mds_sign`, `canonicalize_eigenvector_signs`
  and the `mds_sign` parameter exist only on our branch. That is decision **D20**, still marked as
  needing the ML team's sign-off, and it is the change that made browser and command-line results
  agree on bat_oas1 and RHO. Merging the lines forces that decision.
- `compute_tn93_distance_matrix` changed signature on `main`.
- `main` added internal-stop warnings (`_warn_internal_stops`).
- The dating branch changes **the predicate behind our tree policy**. `has_nonzero_branch_lengths`
  used to require half the branches to be positive; it now requires half to be numeric and only five
  per cent to be positive, explicitly so that dense outbreak trees full of identical isolates are
  accepted. That is precisely the D22 decision about when an upload goes tree-free, and precisely
  the data the time page targets, so the same upload can change path depending on which engine line
  the app is pinned to.
- The dating branch also adds BEAST XML parsing and a cross-distance matrix to the same file.

**Proposal.** Reconcile before porting anything: merge `main` into `feat/js-port`, resolve
`dataset.py` with D20 landed upstream rather than carried as a patch, regenerate the fixtures, re-run
the parity gate, and tag the result as the new `ENGINE_REF`. Everything in §5 assumes that has
happened; starting the port against an unreconciled branch means porting a file that will move.

## 7. Demo data

Draft 1 said none ships. That was wrong too: the dating branch brings dated examples.

- **HIV-1 group M envelope, 143 sequences, 981 codons** (`examples/korber_env_gp160.fasta`). The
  flagship. Public LANL data, a famous published answer, small enough to run in a tab, and it
  exercises the awkward header case — the names carry two-digit years in a lab convention that none
  of the standard patterns match, so it is also the argument for the custom-pattern box.
- **H5N1 haemagglutinin with a metadata CSV and a tree**, the phylogeography benchmark set. Useful
  here as the worked example of dates arriving in a table rather than in headers.
- **H1N1 2009 pandemic, 100 sequences**, headers carrying a decimal year in a pipe-delimited field.
  Note it is 13,154 nt, which is not divisible by three, so it will not survive the dating pillar's
  strict in-frame check as it stands; it belongs to the geography example.
- **Experimental evolution** has no shipped dataset, but the temporal tests build a synthetic
  25-clone, 50,000-generation panel with a known fixation, which is the right first demo for the
  generations axis and doubles as a port fixture.

So the gallery story is: one famous dating result, one table-driven example, one generations
example. No GISAID data, which cannot be redistributed.

## 8. Phases

1. **Reconcile the engine** (§6) and tag. Parity green on the existing surfaces before anything new.
   This is the only phase with no product output, and nothing else can start on top of it.
2. **Dates.** The ingestion port, the matching diagnostics, the review table, the custom-pattern box,
   the `/time` page shell and the instant root-to-tip preview. Shippable and useful on its own.
3. **Dating.** The three estimators, the intervals, the outlier table, the Korber example in the
   gallery, fixtures and parity. This is the phase that delivers the headline.
4. **Temporal selection.** The heavier pillar: trajectories, velocities, waves, classification, and
   the permutation null in a worker at a browser-sized default.
5. **The other surfaces.** MCP tools and server analyses for both, as every other pillar has.

A note on sequencing. Dating before temporal is not only about size: dating's outlier table is how a
reader finds the bad dates that would otherwise poison every trajectory in the temporal run.

## 9. Decisions needed

| | Question | Recommendation |
|---|---|---|
| D23 | Separate page or a section of the report | **One separate route, `/time`**, carrying both pillars. Different inputs, different failures, long runs. |
| D24 | Which pillar first | **Dating.** Seconds rather than minutes, a famous worked example, and its outliers are the gate on the other pillar's inputs. |
| D25 | Who reconciles the engine lines | Needs an owner upstream; the app cannot merge D20 on the ML team's behalf. |
| D26 | Permutations in the browser | **Default to 200, not the reference's 1,000**, and say so on the page. Measured: the null costs 35 to 100 seconds at two hundred candidate sites and three to eight minutes at a thousand, dwarfing the model itself. Offer the full count as a server run. |
| D27 | Taxon cap for temporal | The report caps at 256. A surveillance set is thousands. Uniform temporal downsampling, per the guide's own advice, is the right default; the cap must not silently eat the early epidemic. |
| D28 | Wave sign convention | Pin one on both sides before parity, as D20 did for the MDS. Until then the wave modes are a picture, not a number. |
| D29 | Does dating need a new ONNX output | Unresolved, and the first thing to measure (§3.2). If the covariance needs a full cross-taxa attention matrix, this costs an export change, a manifest hash and a gallery re-bake. |
| D30 | What to do about the rest of the suite | Phylogeography, reproduction numbers and the large-collection sieve arrived on the same branch. **Out of scope here**, but they are the reason to design `/time` as a surface that can hold more than one time-aware analysis. |

## 10. Risks

- **Date ingestion is where users will fail**, not the model. Every hour spent on the review table is
  worth more than an hour spent on the figures.
- **The engine's documentation drift** means the only trustworthy specification is the code.
- **Permutation cost** may put the honest default out of reach in a tab; see D26.
- **Surveillance sizes** break the assumptions the report was built on: 256 taxa is a demo, not a
  pandemic.
