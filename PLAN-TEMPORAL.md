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
3. **A latent root search.** The guide advertises a third estimator that extrapolates the variance
   of the model's representations back to a founding bottleneck. **That estimator is not in the
   code.** What is there instead optimises a root *position* in the model's representation space, by
   gradient descent on a weighted combination of the observed sequences, so that distance-to-root
   correlates as strongly as possible with sampling date. Useful, but a different thing, and another
   case of the documentation running ahead of the source.

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

### 3.2 What the model has to give us, now answered

**Least squares needs nothing from the model.** Ask for that estimator with tree or TN93 distances
and the transformer is never loaded. That is the whole reason a first version can ship without
touching the export.

**Everything else needs two outputs we do not have.** The covariance is built from the full
taxon-by-taxon attention matrix averaged over sites, heads and layers, together with a per-taxon
embedding. Our graph emits the *root token's* attention row and the *root token's* embedding, which
are vectors where these are matrices. So the attention-based estimator and the latent root search
both require **a new export with two more outputs, and the averaging must happen inside the graph** —
emitting attention per site would be tens of gigabytes at surveillance size. That means a new
contract, a new hash in the manifest, fresh fixtures for a quantity nothing currently checks, and a
re-bake of the gallery.

Incidentally, the embeddings are 384-dimensional in the current configuration, not the 128 the guide
repeats.

Note also what this pillar does *not* need: the trajectories, the permutation null and the wave
decomposition that dominate the temporal pillar. Dating is a regression over taxa, not a resampling
loop over sites.

### 3.2a One thing in the date parser we must not copy silently

The dating pillar's header parser contains a hard-coded special case: any sequence whose name
contains `Z59`, `ZR59` or `1959` is dated to mid-1959, before any pattern is tried. It exists for the
archival isolate in the HIV example. Whatever we do about it, the page must not apply a rule like
that invisibly, and it belongs in the upstream issue list.

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

### 5.0 Dating

**The cheap version is genuinely cheap.** Least-squares dating with tree-free distances needs no
model, no export change, and almost nothing the library does not already have: the TN93 matrix, the
alignment parser, Newick handling and patristic distances are all in place. What is missing is small
and enumerable:

| Missing | Size |
|---|---|
| The inverse Student-t, which every confidence interval needs | ~40 lines over the existing cumulative function |
| The F distribution's tail, for the curvature tests | ~10 lines over the existing incomplete beta |
| A bounded one-dimensional minimiser, for the covariance parameter | ~60 lines |
| A root finder, for inverting the spline clock per taxon | ~40 lines |
| Poisson sampling and a general percentile | small |
| A rectangular TN93, distances from every taxon to one root | a loop over the existing pair function |

**The expensive version is the tree.** Re-rooting is the one part with no counterpart in the library
and the one where a subtly wrong port produces plausible, wrong dates that never announce themselves:
the reference deep-copies the tree up to sixty times, re-roots on each candidate node and picks by
residual sum of squares under a causality constraint. A first version should decline to do it, which
the reference itself supports with a single flag, and which our own tree-free default already leans
towards.

**Two things to leave behind.** The power-law clock needs a box-constrained quasi-Newton fit with
two dozen restarts and five hundred bootstrap refits; it is not what the automatic choice selects, so
drop it from the browser surface. And the reference's redundant algebra should not be reproduced
faithfully: it decomposes the same covariance matrix four separate times and then forms its inverse
densely, which at scale is minutes to hours of pure waste in JavaScript. Factor once, share the
spectrum, and accept that parity then compares the estimates rather than the intermediates.

**Cost.** At the size of the worked HIV example, 143 sequences and 981 codons, the whole thing is a
second of model time and microseconds of regression: comfortably a browser analysis. At three
thousand sequences the model path is not viable in a tab at all, roughly an hour and a half and over
the memory ceiling, and the reference itself refuses the neural route above fifteen hundred
sequences without a tree. Least squares at that size is a minute or two, dominated entirely by
computing the distances.

**Two upstream problems to raise rather than port.** The reference's own pairwise distance loop is
plain Python and costs minutes where a typed-array loop costs seconds. And the latent root search
allocates two arrays of about fourteen gigabytes each at three thousand sequences, which is a bug
that only stays hidden because a guard refuses that size first.

### 5.1 Temporal

Line references are to `hyphaeon/temporal.py` at `main` `49c188c`.

### 5.1.1 The good news: the model already gives us everything

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

### 5.1.2 What is already in the library, and what is missing

| Needed | Status |
|---|---|
| MEME p-values, Benjamini-Hochberg | **Already ported** and in use |
| Trapezoidal integration, peak-to-peak, variance, standardisation | Ten lines each |
| Gaussian kernel smoother | A matrix multiply, plus a row normalisation |
| `np.gradient` | Central differences inside, **one-sided at both edges**, which must match exactly |
| **Thin singular value decomposition** | **Absent.** Build it from the existing symmetric eigensolver on the smaller Gram matrix |
| Delimiter-sniffing CSV, Auspice JSON walk, column discovery | Absent, and by the split rule this belongs in the app, beside the FASTA validator, not in the library |

### 5.1.3 Cost, and the one loop that matters

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

### 5.1.4 What parity can and cannot claim

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

### 5.1.5 Upstream quirks to replicate and report

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

## 7a. The rest of the suite, and what it means for us

The dating branch brought four more analyses. None is in scope, but two change how `/time` should be
designed and one is worth stealing outright.

- **`r0`** estimates epidemic growth rate and reproduction numbers from a dated tree, by least-squares
  tree calibration, an exact profile likelihood over the coalescent, and the standard conversion to
  R nought. It never touches the neural model and needs nothing exotic, so it is **the most
  browser-portable thing on the branch**. It is also the natural second tenant of a `/time` page.
- **`geo`** infers a discrete transmission network by parsimony plus a label-permutation test, and a
  spatial epicentre. Portable too, with one substitution: it shells out to FastTree when given no
  tree, and we already have neighbour joining. It requires a metadata file with a location column
  and reads nothing from sequence names.
- **`autoclock`** deconvolves a collection into several clocks by spectral clustering, then dates
  each community. It is the largest new module, it has no test file, and its documented three-tier
  pipeline is **not actually wired**: the sketching and alignment tiers it describes are never
  called and their command-line verbs do not exist.
- **`sieve`** triages large submission streams against a pre-fitted clock. Mostly portable, except
  that its alignment path shells out to minimap2.

**The one to steal: `alignment.py`.** A reference-guided codon threader that takes *unaligned*
sequences, finds the strand and reading frame, aligns to a reference protein and threads codons back
into a fixed-length frame. It needs no model, no subprocess and no network, and it is a textbook
dynamic program. Today PrimAeon refuses an unaligned upload; this is the smallest change that would
let it accept one, and it is independently useful to every existing pillar.

**A warning about the branch as it stands.** Importing the package now pulls in scikit-learn and
matplotlib through `autoclock.py`, and neither is a declared dependency, so a base install fails at
import. That is an upstream fix, but it lands on whoever reconciles the lines.

## 7b. Three date parsers, not one

This is the finding that matters most for the page, and it is not visible from any one guide.

The temporal pillar, the dating pillar and the reproduction-number module **each parse dates their
own way**, with different rules and different fallbacks. Dating understands the lab conventions the
others miss, including two-digit years in LANL-style names and weeks-post-infection, and it accepts a
user-supplied pattern. The reproduction-number module tries pipe-delimited fields in its own order.
The temporal pillar has the four patterns in §2.1 and no custom-pattern escape.

So "what date does this sequence have" currently depends on which analysis you asked for. The app
must not reproduce that. **One ingestion component, the union of the rules, and a table that says
which rule matched each sequence** — and an upstream issue asking that the three converge, because
the alternative is that our page and the command line disagree about the same file.

## 8. Phases

1. **Reconcile the engine** (§6) and tag. Parity green on the existing surfaces before anything new.
   This is the only phase with no product output, and nothing else can start on top of it.
2. **Dates.** The ingestion port, the matching diagnostics, the review table, the custom-pattern box,
   the `/time` page shell and the instant root-to-tip preview. Shippable and useful on its own.
3. **Dating without the model.** Least squares with tree-free distances, the intervals, the
   curvature test, the per-taxon outlier table, the HIV example in the gallery, fixtures and parity.
   No export change, no new graph output, and it already answers the question people ask.
4. **Dating with the model.** The export gains the taxon-by-taxon attention and the per-taxon
   embeddings, averaged in-graph; then the attention-based estimator and the latent root search.
   This is a separate phase because it costs a new model contract and a gallery re-bake.
5. **Temporal selection.** The heavier pillar: trajectories, velocities, waves, classification, and
   the permutation null in a worker at a browser-sized default.
6. **The other surfaces.** MCP tools and server analyses for both, as every other pillar has.

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
| D29 | Does dating need a new ONNX output | **Answered: yes, for two of the three estimators, no for the first.** Least squares never loads the model; the attention covariance and the latent root need a taxon-by-taxon attention matrix and per-taxon embeddings, averaged inside the graph (§3.2). Ship phase 3 without them. |
| D33 | The power-law clock in the browser | **Drop it.** It needs a constrained quasi-Newton fit with two dozen restarts, and the automatic model choice does not select it. |
| D34 | Tree re-rooting | **Do not port it for a first version.** It is the one place a subtly wrong port yields plausible, wrong dates; the reference has a flag to skip it and our tree-free default already leans that way. |
| D30 | What to do about the rest of the suite | Phylogeography, reproduction numbers and the large-collection sieve arrived on the same branch (§7a). **Out of scope here**, but they are the reason to design `/time` as a surface that can hold more than one time-aware analysis. Reproduction numbers are the cheapest follow-on: no model, nothing exotic. |
| D31 | Whose date rules win | **One ingestion component in the app, the union of all three upstream parsers**, showing which rule matched each sequence (§7b), plus an upstream issue asking that they converge. |
| D32 | Accept unaligned uploads | Worth doing on its own schedule: the branch's reference-guided codon threader is model-free, subprocess-free and the easiest port on it, and it would lift a refusal every pillar currently makes. |

## 10. Risks

- **Date ingestion is where users will fail**, not the model. Every hour spent on the review table is
  worth more than an hour spent on the figures.
- **The engine's documentation drift** means the only trustworthy specification is the code.
- **Permutation cost** may put the honest default out of reach in a tab; see D26.
- **Surveillance sizes** break the assumptions the report was built on: 256 taxa is a demo, not a
  pandemic. The model-based dating path is not viable in a tab beyond about a thousand sequences,
  and the reference refuses it above fifteen hundred without a tree. Be explicit on the page about
  where the browser stops and the server starts.
- **A wrong re-rooting is silent.** Every other failure here announces itself; that one just moves
  the answer by years.
- **The documentation is not the specification**, in three separate places now: temporal's flags,
  dating's advertised third estimator, and the sieve's design document. Port from source, and keep
  a running list for upstream.
