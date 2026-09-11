# Temporal selection and dating in PrimAeon — plan

Draft 1, 2026-09-11. Engine revisions read for this plan: `veg/HyphAeon` `main` at `49c188c` and
`feat/js-port` at `5848336` (tag `phase-4b`, the line PrimAeon is pinned to). Nothing here is built
yet; this is the plan of record for the work, in the shape of `PLAN.md`.

## 0. The answer in one paragraph

Yes, the formats matter, and they are already decided: the engine's `temporal` pillar ingests dates
three ways — from FASTA headers, from a Nextstrain Auspice JSON, or from a CSV/TSV metadata table —
and harmonises all of them to a decimal year. The hard part is not parsing, which is a hundred lines
of regular expressions; it is that a surveillance set fails quietly, with half its taxa dateless or
its metadata names not quite matching its sequence names, and the reference simply drops those
taxa. So the page has to make date ingestion a visible, reviewable step rather than a silent one.
Two other things shape the work. The pillar exists only on the engine's `main`, which has diverged
from the branch PrimAeon pins, and reconciling those two lines is a prerequisite, not a detail.
And "dating" in the sense people usually mean it — a clock rate, a time to most recent common
ancestor, outlier detection — is **not** in the engine at all, but phylotree, which this app already
ships, has root-to-tip regression with best-root fitting, so that half is cheap and should come
first, because it is also the honest gate on whether the temporal analysis means anything.

## 1. What exists upstream, and what does not

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

All three mechanisms end in the same place: a map from taxon name to a float time coordinate.
`parse_temporal_metadata` dispatches; `parse_date_to_decimal` normalises.

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

## 3. Dating, which the engine does not do

Three different things travel under this word. Being explicit about which we ship matters.

**Temporal signal (cheap, and we should do it first).** Root-to-tip regression: divergence from the
root against sampling date, one point per tip. The slope is a clock rate, the x-intercept an
estimated time to most recent common ancestor, the R² tells you whether the data are clocklike at
all, and the residual outliers are the sequences with wrong dates, recombination, or contamination.
This is what TempEst does, and it is the honest gate on the temporal pillar: if the regression is
flat, the trajectories downstream are decoration.

We can ship it almost for free. `phylotree` 2.6.0 is **already a dependency and already used** by the
site-tree modal, and it exports `rootToTip`, `fitRootToTip` (best root by maximising R²) and
`extractDates`. The app already builds a neighbour-joining tree on TN93 distances for display (D22),
which is exactly the input this needs. Note that phylotree's own date extractor is narrower than the
engine's, so feed it dates we parsed with the engine's rules through a custom getter rather than
letting it re-parse names.

**A time-scaled tree (a later decision).** Converting substitutions per site into calendar time for
every node — what LSD2 or TreeTime produce. Least-squares dating is implementable in JavaScript and
would give the report a dated tree to draw, but it is a project of its own and it is not needed by
the temporal pillar, which works on the time axis of the tips alone.

**Bayesian dating (out of scope).** BEAST-class inference does not belong in a browser tab.

## 4. The page

A separate route, `/temporal`, not a section of the existing report: the input is different (an
alignment *and* a time source), the failure modes are different, and the run is long enough that it
should be startable, cancellable and reviewable on its own. It reuses everything else — the same
drop zone, the same streaming record, the same IndexedDB store, the same section machinery.

Three stages, streaming in the order a reader needs them:

1. **Dates.** What was found, from where, how many taxa carry one, the timespan, the units, a
   reviewable table of raw string to parsed value with imputation flagged, and the unmatched names.
   Nothing else runs until this is green, and the reader can supply a metadata file here if the
   headers were not enough.
2. **Temporal signal.** Root-to-tip regression on the display tree, best-fitting root, rate, TMRCA,
   R², and flagged outliers the reader can drop before continuing.
3. **Temporal selection.** The engine's pillar: per-site trajectories, velocities, the wave modes,
   and the four-way classification against the static MEME q-values, which means the meme pass runs
   first and the page shows it.

Downloads mirror the CLI's own files so a browser run and a command-line run are interchangeable.

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

## 6. The blocker: two engine lines that have diverged

PrimAeon pins `feat/js-port`. The temporal pillar is on `main`. They are not close.

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

**Proposal.** Reconcile before porting anything: merge `main` into `feat/js-port`, resolve
`dataset.py` with D20 landed upstream rather than carried as a patch, regenerate the fixtures, re-run
the parity gate, and tag the result as the new `ENGINE_REF`. Everything in §5 assumes that has
happened; starting the port against an unreconciled branch means porting a file that will move.

## 7. Demo data

No time-stamped example ships with the engine; the five bundled alignments are static. A temporal
page with no example to click is a page nobody tries, so this is real work, not an afterthought.

- **Experimental evolution.** `tests/test_temporal_experimental.py` builds a synthetic 25-clone,
  50,000-generation panel with a single fixation at codon 301. It is small, it is ours, it has a
  known answer, and it exercises the non-calendar path. This should be the first demo and a port
  fixture.
- **Surveillance.** Influenza A/H3N2 haemagglutinin from GenBank is the classic public choice with
  real wave structure and no redistribution constraints. **Not GISAID**, whose terms forbid
  redistribution, which rules out most convenient SARS-CoV-2 collections.
- **Within-host longitudinal.** A published HIV-1 env series is a good third, and closer to what the
  lab's own users bring.

## 8. Phases

1. **Reconcile the engine** (§6) and tag. Parity green on the existing surfaces before anything new.
   This is the only phase with no product output, and nothing else can start on top of it.
2. **Dates and temporal signal.** The date ingestion port, the diagnostics, the review table, the
   root-to-tip stage, the `/temporal` page shell. Shippable on its own and useful on its own.
3. **The temporal pillar.** The library port, the runtime orchestrator, the worker, the sections and
   their figures, the downloads, fixtures and parity.
4. **The other surfaces.** A `hyphaeon_temporal` MCP tool and a server analysis, as every other
   pillar has.

## 9. Decisions needed

| | Question | Recommendation |
|---|---|---|
| D23 | Separate page or a section of the report | **Separate `/temporal`.** Different inputs, different failures, long run. |
| D24 | Ship dating at all | **Ship temporal signal (root-to-tip) in phase 2**, defer time-scaled trees until someone asks. |
| D25 | Who reconciles the engine lines | Needs an owner upstream; the app cannot merge D20 on the ML team's behalf. |
| D26 | Permutations in the browser | **Default to 200, not the reference's 1,000**, and say so on the page. Measured: the null costs 35 to 100 seconds at two hundred candidate sites and three to eight minutes at a thousand, dwarfing the model itself. Offer the full count as a server run. |
| D28 | Wave sign convention | Pin one on both sides before parity, as D20 did for the MDS. Until then the wave modes are a picture, not a number. |
| D27 | Taxon cap for temporal | The report caps at 256. A surveillance set is thousands. Uniform temporal downsampling, per the guide's own advice, is the right default; the cap must not silently eat the early epidemic. |

## 10. Risks

- **Date ingestion is where users will fail**, not the model. Every hour spent on the review table is
  worth more than an hour spent on the figures.
- **The engine's documentation drift** means the only trustworthy specification is the code.
- **Permutation cost** may put the honest default out of reach in a tab; see D26.
- **Surveillance sizes** break the assumptions the report was built on: 256 taxa is a demo, not a
  pandemic.
