/**
 * prebake-temporal.mjs — read the aggregate `hyphaeon temporal` outputs for the SARS-CoV-2 study
 * and write the compact, DAA-safe records the /reports page renders.
 *
 * WHY THIS FILE EXISTS. REPORTS_PLAN.md: the /reports tab publishes the temporal-selection run
 * (the engine's `feature/dating-mrca-module` branch, `hyphaeon temporal`) as a lab-notebook study,
 * genes as sections. There is no in-browser computation — the analyses already ran on the cluster
 * and this script turns their outputs into the JSON the page fetches, exactly as
 * prebake-gallery.mjs turns `runEverything` into a ReportRecord. The source is a fanout directory
 * of per-gene files:
 *
 *   <gene>_temporal_summary.json        run params, wave variance, category counts
 *   <gene>_temporal_sites_summary.csv   one row per codon; classification, stats, wave loadings
 *   <gene>_temporal_curves.csv          per site x time: selection_intensity, sweep_velocity,
 *                                       prevalence  (~250 timepoints per site)
 *   <gene>_temporal_waves.csv           collective fPCA modes W_1..W_4(t)  (~250 rows)
 *
 * and (for the sampling strip) <gene>_dates.tsv, from which ONLY aggregate counts per time bin are
 * read — never a strain name, never a per-sequence date.
 *
 * GISAID DAA (REPORTS_PLAN.md §3, the data dir's CLAUDE.md). The inputs are DAA-restricted: no
 * redistribution, no public display of per-sequence data; only aggregate site-level results are
 * publishable. This script reads only the four aggregate outputs plus binned date COUNTS, and
 * asserts before writing that no record carries a strain-shaped string (see assertDaaSafe). The
 * e2e re-checks the shipped payloads.
 *
 * SIZE (REPORTS_PLAN.md §2.2). The raw curves total ~63 MB across genes (250 timepoints x every
 * codon, invariable curves ~0). This ships ~1-3 MB by three reductions, each recorded in the
 * record's `reduction` block so the page can state it: curves are kept ONLY for confirmed/rescued
 * sweep sites, downsampled from ~250 to CURVE_POINTS (~60, matching --time-bins 40, below which the
 * logistic trajectories are visually lossless); the sites table keeps VARIABLE sites only; the
 * per-site float columns are rounded to ROUND_DP. Wave curves and summary.json are kept whole.
 *
 * SKIP. HYPHAEON_TEMPORAL=skip keeps the committed records (a machine without the fanout data
 * still builds), exactly as HYPHAEON_PREBAKE=skip keeps the gallery. The source dir is
 * HYPHAEON_TEMPORAL_DIR (default the fanout path this study was run in).
 *
 * OUTPUTS (web/static/temporal/, tracked):
 *   <gene>.json        one reduced record per gene
 *   index.json         study metadata: gene list, per-gene counts, timespan, wave variance
 *   genome-map.json    gene -> NC_045512.2 coordinate track + sweep-count marks
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = join(WEB_ROOT, 'static', 'temporal');

const SCRIPT_VERSION = 1; // bump to force a rebake

const DEFAULT_SOURCE = '/storage/xl-data/users/sweaver/data/sars-cov-2-daq/fanout_dh_fix';
const SOURCE_DIR = process.env.HYPHAEON_TEMPORAL_DIR || DEFAULT_SOURCE;

const CURVE_POINTS = 60; // downsample target per site; ~1 bin/month over ~5 years
const ROUND_DP = 5; // per-site float rounding
const SAMPLING_BINS = 'month-quarter'; // dates binned to calendar quarters for the strip

// SARS-CoV-2 reference NC_045512.2 gene coordinates (1-based nt, mature-protein where applicable).
// Sourced from the pipeline's extract_genes.sh gene table (REPORTS_PLAN.md §4.1); the S example
// header NC_045512.2:21563-25384 matches. Genes with no temporal output are still listed so the
// map can show them as "not run".
const GENE_COORDS = {
	leader: [266, 805],
	nsp2: [806, 2719],
	nsp3: [2720, 8554],
	nsp4: [8555, 10054],
	'3C': [10055, 10972],
	nsp6: [10973, 11842],
	nsp7: [11843, 12091],
	nsp8: [12092, 12685],
	nsp9: [12686, 13024],
	nsp10: [13025, 13441],
	RdRp: [13442, 16236],
	helicase: [16237, 18039],
	exonuclease: [18040, 19620],
	endornase: [19621, 20658],
	methyltransferase: [20659, 21552],
	S: [21563, 25384],
	ORF3a: [25393, 26220],
	E: [26245, 26472],
	M: [26523, 27191],
	ORF5: [26523, 27191],
	ORF6: [27202, 27387],
	ORF7a: [27394, 27759],
	ORF7b: [27756, 27887],
	ORF8: [27894, 28259],
	N: [28274, 29533],
	ORF10: [29558, 29674],
	ORF1a: [266, 13483],
	ORF1b: [13442, 21555]
};

// ---- small CSV reader (the outputs are plain comma-separated, no embedded commas) ----
function parseCsv(text) {
	const lines = text.trim().split('\n');
	const header = lines[0].split(',');
	const rows = new Array(lines.length - 1);
	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i].split(',');
		const row = {};
		for (let c = 0; c < header.length; c++) row[header[c]] = cells[c];
		rows[i - 1] = row;
	}
	return { header, rows };
}

const num = (v) => (v === undefined || v === '' ? null : Number(v));
const bool = (v) => v === 'True' || v === 'true';
const round = (v) => (v === null || !Number.isFinite(v) ? v : Number(v.toFixed(ROUND_DP)));

// Uniformly subsample a sorted list of points to at most `n`, always keeping first and last.
function downsample(points, n) {
	if (points.length <= n) return points;
	const out = [];
	const step = (points.length - 1) / (n - 1);
	for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
	return out;
}

// DAA guard: no shipped string may look like a strain identifier (hCoV-19/..., or a bare date).
function assertDaaSafe(record, gene) {
	const strainish = /hCoV-19|\/20\d\d|\d{4}-\d{2}-\d{2}/;
	const walk = (v, path) => {
		if (typeof v === 'string') {
			if (strainish.test(v)) throw new Error(`DAA guard: ${gene} record ${path} looks per-sequence: ${v}`);
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, `${path}[${i}]`));
		} else if (v && typeof v === 'object') {
			for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
		}
	};
	walk(record, gene);
}

function sha256(text) {
	return createHash('sha256').update(text).digest('hex');
}

// ---- per-gene reduction ----
function reduceGene(gene, files) {
	const summary = JSON.parse(readFileSync(files.summary, 'utf8'));
	const sites = parseCsv(readFileSync(files.sites, 'utf8')).rows;
	const waves = parseCsv(readFileSync(files.waves, 'utf8')).rows;
	const curves = parseCsv(readFileSync(files.curves, 'utf8')).rows;

	// Sweep sites: confirmed or rescued. Curves are kept only for these.
	const sweepSet = new Set();
	const siteRows = [];
	for (const r of sites) {
		const cls = r.classification;
		if (cls === 'INVARIABLE') continue; // variable sites only
		const site = Number(r.site);
		const isSweep = bool(r.is_confirmed_sweep) || bool(r.is_rescued_sweep);
		if (isSweep) sweepSet.add(site);
		siteRows.push({
			site,
			ref_aa: r.ref_aa,
			derived_aa: r.derived_aa,
			mutation_label: r.mutation_label,
			classification: cls,
			cross_classification: r.cross_classification,
			is_confirmed_sweep: bool(r.is_confirmed_sweep),
			is_rescued_sweep: bool(r.is_rescued_sweep),
			is_concordant_sweep: bool(r.is_concordant_sweep),
			lrt: round(num(r.lrt)),
			q_static: round(num(r.q_static)),
			q_perm: round(num(r.q_perm)),
			r2_fpca: round(num(r.r2_fpca)),
			peak_date: round(num(r.peak_date)),
			peak_intensity: round(num(r.peak_intensity)),
			fwhm_years: round(num(r.fwhm_years)),
			auc: round(num(r.auc)),
			wave_loadings: [
				round(num(r.Wave_1_loading)),
				round(num(r.Wave_2_loading)),
				round(num(r.Wave_3_loading)),
				round(num(r.Wave_4_loading))
			]
		});
	}

	// Curves grouped by site, kept for sweep sites only, downsampled.
	const bySite = new Map();
	for (const r of curves) {
		const site = Number(r.site);
		if (!sweepSet.has(site)) continue;
		if (!bySite.has(site)) bySite.set(site, { site, mutation_label: r.mutation_label, points: [] });
		bySite.get(site).points.push({
			t: Number(r.time),
			a: num(r.selection_intensity),
			v: num(r.sweep_velocity),
			p: num(r.prevalence)
		});
	}
	const curveOut = [];
	let rawPointsPerCurve = 0;
	for (const c of bySite.values()) {
		c.points.sort((x, y) => x.t - y.t);
		rawPointsPerCurve = Math.max(rawPointsPerCurve, c.points.length);
		const ds = downsample(c.points, CURVE_POINTS);
		curveOut.push({
			site: c.site,
			mutation_label: c.mutation_label,
			t: ds.map((p) => Number(p.t.toFixed(4))),
			a: ds.map((p) => round(p.a)),
			v: ds.map((p) => round(p.v)),
			p: ds.map((p) => round(p.p))
		});
	}
	curveOut.sort((a, b) => a.site - b.site);

	// Wave modes (kept whole).
	const waveOut = {
		t: waves.map((r) => Number(Number(r.time).toFixed(4))),
		W: [1, 2, 3, 4].map((k) => waves.map((r) => round(num(r[`wave_${k}`]))))
	};

	// Sampling density from dates.tsv, aggregate COUNTS per calendar quarter only.
	const sampling = files.dates ? binDates(files.dates) : null;

	const record = {
		gene,
		schema_version: 1,
		coords: GENE_COORDS[gene] ?? null,
		summary: {
			taxa_total: summary.taxa_total,
			codons_total: summary.codons_total,
			codons_variable: summary.codons_variable,
			codons_invariable: summary.codons_invariable,
			timespan_years: summary.timespan_years,
			t_min: summary.t_min,
			t_max: summary.t_max,
			confirmed_sweeps: summary.confirmed_sweeps,
			rescued_sweeps: summary.rescued_sweeps,
			concordant_sweeps: summary.concordant_sweeps,
			filtered_static_noise: summary.filtered_static_noise,
			fpca_wave_variance_pct: summary.fpca_wave_variance_pct,
			runtime_sec: summary.runtime_sec
		},
		sites: siteRows,
		curves: curveOut,
		waves: waveOut,
		sampling,
		reduction: {
			curve_points: CURVE_POINTS,
			raw_curve_points: rawPointsPerCurve,
			curves_kept: 'confirmed_or_rescued_sweep_sites',
			sites_kept: 'variable_only',
			round_dp: ROUND_DP,
			sampling_bins: SAMPLING_BINS
		}
	};
	assertDaaSafe(record, gene);
	return record;
}

// Read a dates.tsv and return { bins: [{t, n}] } — counts per calendar quarter, nothing else.
function binDates(path) {
	const text = readFileSync(path, 'utf8');
	const counts = new Map(); // decimal-year quarter start -> count
	const lines = text.trim().split('\n');
	for (let i = 1; i < lines.length; i++) {
		const tab = lines[i].indexOf('\t');
		if (tab < 0) continue;
		const date = lines[i].slice(tab + 1).trim(); // YYYY-MM-DD
		const m = /^(\d{4})-(\d{2})/.exec(date);
		if (!m) continue;
		const year = Number(m[1]);
		const month = Number(m[2]);
		const q = Math.floor((month - 1) / 3); // 0..3
		const t = year + q * 0.25;
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	const bins = [...counts.entries()].map(([t, n]) => ({ t, n })).sort((a, b) => a.t - b.t);
	return { bins };
}

// ---- discovery + orchestration ----
function discoverGenes(dir) {
	const found = new Map();
	for (const f of readdirSync(dir)) {
		const m = /^(.+)_temporal_summary\.json$/.exec(f);
		if (!m) continue;
		const gene = m[1];
		const files = {
			summary: join(dir, `${gene}_temporal_summary.json`),
			sites: join(dir, `${gene}_temporal_sites_summary.csv`),
			curves: join(dir, `${gene}_temporal_curves.csv`),
			waves: join(dir, `${gene}_temporal_waves.csv`),
			dates: join(dir, `${gene}_dates.tsv`)
		};
		if (!existsSync(files.sites) || !existsSync(files.curves) || !existsSync(files.waves)) continue;
		if (!existsSync(files.dates)) files.dates = null;
		found.set(gene, files);
	}
	return found;
}

function main() {
	mkdirSync(OUT_DIR, { recursive: true });

	if (process.env.HYPHAEON_TEMPORAL === 'skip') {
		console.log('[prebake-temporal] HYPHAEON_TEMPORAL=skip — keeping committed records.');
		return;
	}

	if (!existsSync(SOURCE_DIR)) {
		console.log(`[prebake-temporal] source dir absent (${SOURCE_DIR}); keeping committed records.`);
		return;
	}

	const genes = discoverGenes(SOURCE_DIR);
	if (genes.size === 0) {
		console.log(`[prebake-temporal] no temporal outputs in ${SOURCE_DIR}; keeping committed records.`);
		return;
	}

	// One-gene mode for the initial build: HYPHAEON_TEMPORAL_ONLY=E
	const only = process.env.HYPHAEON_TEMPORAL_ONLY;
	const geneList = only ? [only].filter((g) => genes.has(g)) : [...genes.keys()];

	const indexGenes = [];
	let totalBytes = 0;
	for (const gene of geneList.sort()) {
		const record = reduceGene(gene, genes.get(gene));
		const json = JSON.stringify(record);
		writeFileSync(join(OUT_DIR, `${gene}.json`), json);
		totalBytes += Buffer.byteLength(json);
		indexGenes.push({
			gene,
			coords: record.coords,
			taxa_total: record.summary.taxa_total,
			codons_total: record.summary.codons_total,
			codons_variable: record.summary.codons_variable,
			confirmed_sweeps: record.summary.confirmed_sweeps,
			rescued_sweeps: record.summary.rescued_sweeps,
			timespan_years: record.summary.timespan_years,
			t_min: record.summary.t_min,
			t_max: record.summary.t_max,
			fpca_wave_variance_pct: record.summary.fpca_wave_variance_pct,
			bytes: Buffer.byteLength(json)
		});
	}

	const index = {
		schema_version: 1,
		study: 'sars-cov-2-temporal',
		source_version: SCRIPT_VERSION,
		source_hash: sha256(geneList.join(',') + SCRIPT_VERSION),
		genes: indexGenes,
		partial: Boolean(only)
	};
	writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index));

	// Genome map: every known gene, with coords and whether it was run.
	const runGenes = new Set(geneList);
	const genomeMap = {
		schema_version: 1,
		reference: 'NC_045512.2',
		genes: Object.entries(GENE_COORDS).map(([gene, coords]) => {
			const idx = indexGenes.find((g) => g.gene === gene);
			return {
				gene,
				start: coords[0],
				end: coords[1],
				run: runGenes.has(gene),
				confirmed_sweeps: idx?.confirmed_sweeps ?? null,
				rescued_sweeps: idx?.rescued_sweeps ?? null,
				codons_variable: idx?.codons_variable ?? null
			};
		})
	};
	writeFileSync(join(OUT_DIR, 'genome-map.json'), JSON.stringify(genomeMap));

	console.log(
		`[prebake-temporal] wrote ${geneList.length} gene(s)${only ? ` (ONLY=${only})` : ''} + index + genome-map to ${OUT_DIR}, ` +
			`${(totalBytes / 1024).toFixed(0)} KB of records.`
	);
}

main();
