# REPORTS_PLAN.md — a "Reports" tab: SARS-CoV-2 temporal-selection notebook

Status: **plan, not yet built.** Branch: `feature/temporal-reports` (off `main`).
Owner decisions captured inline. No code written yet.

---

## 1. What this is

A new **read-only** section of the PrimAeon web app that publishes the results of
`hyphaeon temporal` (the engine's `feature/dating-mrca-module` branch) as a lab-notebook-style
study. **No in-browser computation** — the analyses already ran on the cluster; the tab renders
their aggregate outputs.

- **Nav label / route:** **Reports** at `/reports/`. Chosen over "Surveillance"/"Notebook"
  because it is honest about the format without the "blog" connotation, reads academic (matches
  `web/DESIGN.md`), and is the most extensible (room for a future index of multiple published
  studies). The single SARS-CoV-2 study lives *at* `/reports/` for now; a thin index can be
  added when a second study exists.
- **Report unit:** one SARS-CoV-2 temporal study, **genes as sections** on one long
  notebook-style page with anchored nav (`?gene=` deep-links scroll to a section). Chosen for the
  narrative "notebook" read.
- **Placement:** inside the existing SvelteKit app (`web/`), reusing the lab-notebook design
  system, the `viz/theme.ts` tokens, Observable Plot (already a dep), and the adapter-static build.

This is a **different pillar** from the current MEME/BUSTED report engine. It does not touch
`runtime/`, the ONNX sessions, or the existing report/gallery/analyze routes.

## 2. The source data

`/storage/xl-data/users/sweaver/data/sars-cov-2-daq/fanout_dh_fix/` — 19 genes with a complete
temporal output set (`_temporal_summary.json`, `_temporal_sites_summary.csv`,
`_temporal_curves.csv`, `_temporal_waves.csv`):

    3C, E, M, N, endornase, exonuclease, helicase, leader, methyltransferase,
    nsp4, nsp6, nsp7, nsp8, nsp9, nsp10, ORF3a, ORF5, ORF7a, ORF8

Genes present in the pipeline but with **no / empty** temporal output (shown as "not run" on the
genome map): ORF6, ORF7b, ORF10 (empty MSAs), S, ORF1a, ORF1b, RdRp, nsp2, nsp3 (no
`_temporal_summary.json` in this dir — the larger/more-diverse genes that failed or were not run).

Each gene is an **independent subsample** (E = 282 taxa, N = 1974, helicase = 1925) — there is no
single genome-wide alignment or tree; the study is presented per gene.

### 2.1 Output shapes (measured)

- `*_temporal_summary.json` — run params, wave-variance %, category counts
  (`confirmed_sweeps`, `rescued_sweeps`, `concordant_sweeps`, `filtered_static_noise`),
  `timespan_years`, `t_min`/`t_max`, `taxa_total`, `codons_total`/`variable`/`invariable`.
- `*_temporal_sites_summary.csv` — one row per codon; columns include `site`, `ref_aa`,
  `derived_aa`, `mutation_label`, `classification` (`CONFIRMED_SWEEP` / `RESCUED_SWEEP` /
  `CONCORDANT_STATIC_SWEEP` / `TEMPORAL_NOISE` / `FLAT_NO_SIGNAL` / `INVARIABLE`),
  `cross_classification`, `lrt`, `p_static`, `q_static`, `p_perm`, `q_perm`, `r2_fpca`,
  `peak_date`, `peak_intensity`, `t_half_start/end`, `fwhm_years`, `mean_intensity`, `auc`,
  `Wave_1..4_loading`.
- `*_temporal_curves.csv` — per site × time: `selection_intensity` = â_s(t), `sweep_velocity` =
  v_s(t), `prevalence` = genotype frequency at the site over time. ~250 timepoints per site.
- `*_temporal_waves.csv` — collective fPCA modes `W_1..W_4(t)`, ~250 rows.

### 2.2 The size problem

Raw `_temporal_curves.csv` totals **63 MB** across genes (250 timepoints × every codon, including
invariable sites whose curves are ~0). Ship target: **1–3 MB total**, achieved by the prebake:

- Trajectory / velocity / prevalence curves kept **only for confirmed + rescued sweep sites**
  (a handful per gene), downsampled 250 → ~60 timepoints (matches `--time-bins 40`; float noise
  below plot resolution dropped).
- Per-site table keeps **variable sites only** (invariable rows carry no signal).
- Wave curves kept whole per gene (small).
- `summary.json` kept whole per gene.
- The reduction is recorded in each record (as the gallery prebake does) so the page can state it.

## 3. GISAID DAA constraint (non-negotiable)

Inputs (`*.fasta`, `*_dates.tsv`, `*.sam`, `*.msa.fasta`) are DAA-restricted: **no redistribution,
no public display of per-sequence data.** Only **aggregate site-level** results are publishable.

- The prebake reads **only** the four aggregate output types plus, for the sampling strip,
  **aggregate counts per time bin** derived from `*_dates.tsv` (never strain names, never
  per-sequence dates).
- Nothing per-sequence is committed or served.
- A guard in the prebake asserts it emitted only counts/coordinates/aggregates; the e2e asserts no
  strain name or per-sequence date appears in any shipped payload — mirroring how
  `e2e/server.spec.ts` scans for subprocess routes.

## 4. Feature parity with nextstrain.org/ncov/open/global/6m (essentials only)

Tree, map, transmissions, and interactivity are **explicitly out of scope** (owner call). The
parity goal is the essential *scientific content* a reader gets, rendered in our static notebook
form.

| Nextstrain essential | Our equivalent | Source | Status |
|---|---|---|---|
| Variant/clade frequency stream (Muller) | **fPCA dynamic wave modes** W₁..W₄ presented as the epidemic-turnover narrative, annotated with the engine guide's canonical mapping (W₁≈Delta transition, W₂≈BA.1, W₃≈BA.5/BQ.1, W₄≈XBB/JN.1) **plus an explicit caveat** that these are data-driven modes, not Pango labels | `_temporal_waves.csv` | ✓ substitute |
| Per-mutation frequency over time ("colour by genotype") | **Site prevalence + selection trajectory**: â_s(t) and prevalence(t) on a shared time axis for each sweep site | `_temporal_curves.csv` | ✓ direct |
| Diversity / entropy panel (genome-wide) | **Genome diversity track**: per-site sweep/variability marks on genome coordinates | sites summary + coord table | ✓ |
| Genomic coordinate context (nt/aa) | **Genome map overview**: genes as an `NC_045512.2` coordinate track, sweep counts as marks | coord table (§4.1) | ✓ |
| Sampling over time | **Sampling-density strip** per gene (aggregate seqs per time bin) | `*_dates.tsv` → counts only | ✓ (DAA-safe) |
| Calendar time axis | All trajectories/waves on decimal-year axis | curves/waves | ✓ already |
| Time-scaled tree, geographic map, transmissions | out of scope | — | — |

### 4.1 The one honest non-parity item

**Named Pango-lineage frequencies are not reproducible from this data** — headers carry only
`strain|date|date`, and no temporal output has a lineage/clade column. Owner decision: present the
**fPCA wave modes as the principled substitute, with a methods caveat**; do *not* fake named
lineages. A true lineage-frequency stream would require a separate join against a Pango-annotated
metadata source (new data dependency, DAA care) — recorded as a **future item**, not built now.

**Gene → genome coordinate table:** `scripts/fanout/genes.txt` lists names only; the actual
`NC_045512.2` offsets live in the pipeline's `extract_genes.sh` (PLAN.md §, lines ~204–408, e.g.
S = `NC_045512.2:21563-25384`). The prebake sources the coordinate table from there, or from a
small committed constant derived from it, rather than assuming it is present in the working dir.

## 5. Files to add

### Prebake (build-time, Node)
- `web/scripts/prebake-temporal.mjs` — reads source dir (env `HYPHAEON_TEMPORAL_DIR`, default the
  fanout path; `HYPHAEON_TEMPORAL=skip` keeps committed records so a machine without the data still
  builds, exactly like `HYPHAEON_PREBAKE=skip`). Parses + reduces per §2.2, writes:
  - `web/static/temporal/<gene>.json` — one reduced record per gene.
  - `web/static/temporal/index.json` — study metadata: gene list, per-gene sweep counts,
    timespan, wave-variance, reduction notes.
  - `web/static/temporal/genome-map.json` — gene → `NC_045512.2` coordinate table + per-gene
    sweep-count marks; genes with no run flagged.
  - Each per-gene record carries a `sampling` array (aggregate counts per time bin).
  - Stamp-cached on inputs + script version. `WHY THIS FILE EXISTS` header per project rule.
  - Wired into `web/package.json` `prebuild` after `copy-assets` / `prebake-gallery`.

### Committed data (DAA-safe aggregates only, tracked like `web/static/gallery/`)
- `web/static/temporal/*.json` — ~1–3 MB.

### Routes (SvelteKit, adapter-static, prerendered)
- `web/src/routes/reports/+page.svelte` — the study: title, abstract, methods sentence (incl. the
  Pango caveat), the genome-map overview, then a numbered section per gene.
- `web/src/routes/reports/+page.ts` — load `index.json` + records; prerender.
- `web/src/routes/reports/+layout.ts` — trailing-slash + prerender config.

### Report library (`web/src/lib/temporal/`)
- `load.ts` — fetch index + per-gene records through `base`.
- `types.ts` — reduced record shapes.
- `TemporalReport.svelte` — notebook shell: paper title, middle-dotted metadata line + black rule,
  sections numbered by CSS counter (per `DESIGN.md`), each plot a `<figure>` + numbered caption.
- `GeneSection.svelte` — per gene: the panel set + sweep table + sampling strip.

### Visualizations (`web/src/lib/viz/temporal/`; Observable Plot + one canvas heatmap)
- `GenomeMap.svelte` (Plot) — study overview / navigation spine: genome coordinate axis, gene
  blocks, sweep-density marks; "not run" genes greyed. Serves the diversity/coordinate parity.
- `WaveModes.svelte` (Plot) — Panel A: W₁..W₄(t) with the annotated turnover reading + caveat.
- `VelocityWaterfall.svelte` (**canvas**, like `DmsHeatmap`/`ManhattanPlot`) — Panel B: v_s(t)
  heatmap, sites sorted by peak-velocity date, purple–white–grey ramp (DESIGN.md).
- `TrajectoryMap.svelte` (Plot) — Panel C: â_s(t) multi-line for confirmed/rescued sites; paired
  with prevalence(t) for the "colour by mutation" parity.
- `PhaseSpace.svelte` (Plot) — Panel D: L_{s,1} vs L_{s,2} scatter, coloured by classification.
- `SamplingStrip.svelte` (Plot) — aggregate seqs per time bin (Nextstrain "tips over time").
- `SweepTable.svelte` — per-site: mutation label, classification, LRT, q_static/q_perm, r2_fpca,
  peak date, peak intensity, wave loadings; called-site styling (purple square) from the system.

### Nav
- Add `{ href: '/reports/', label: 'Reports' }` to `links` in `web/src/routes/+layout.svelte`.

### E2E
- `e2e/reports.spec.ts` — the tab loads; the study + each gene section render their figures; no
  off-origin request on the route; **no strain name / per-sequence date in any payload** (the DAA
  assertion); genome map and sampling strips carry only counts/coordinates.

## 6. Explicitly not doing
- No runtime/engine code — pure visualization of existing outputs.
- No sequences, dates, SAM, or MSA files committed or fetched.
- No changes to the report/gallery/analyze pillars.
- No new npm dependencies (Observable Plot + design system already ship).
- No tree, map, transmissions, or interactive controls (owner call).
- No fabricated Pango-lineage frequencies (§4.1).

## 7. Verify
- `HYPHAEON_TEMPORAL_DIR=… npm run build` in `web/` (prebake + vite build clean).
- `svelte-check` 0 errors.
- `npm run e2e` for `reports.spec.ts` (incl. the DAA assertion).
- Report the committed `web/static/temporal/` size (target 1–3 MB).

## 8. Open items to settle during build
- Exact reduced-curve timepoint count (measure plotted resolution vs. file size; pick smallest
  visually lossless; log the reduction in each record like the gallery prebake).
- Genome-position ordering / offsets for the map (source from `extract_genes.sh`).
- Whether `/reports/` is the study directly or a thin index + `/reports/sars-cov-2-temporal/`
  (default: study at `/reports/`, add index when a second study exists).

## 9. Future (not this branch)
- True named-variant (Pango) frequency stream via an external lineage-annotation join.
- Index of multiple published studies once a second exists.
