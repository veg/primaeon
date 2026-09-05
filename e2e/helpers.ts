/**
 * helpers.ts — what the Phase 2 specs share: request tracking, the autorun driver for a demo
 * report, the IndexedDB `reports` reader, the parity comparators (sites, epistasis) and the
 * engine paths.
 *
 * WHY THIS FILE EXISTS. Five spec files drive the same built site (smoke, gallery, report, redirect,
 * server) and three of them need the same request bookkeeping the landing spec started with; the
 * report spec additionally has to start a demo through the one product action (PLAN.md §4.0, D21:
 * `/analyze/?demo=<id>&autorun=1` is the landing page's hand-off, with no form on the way) and
 * read the stored ReportRecord back out of IndexedDB in the page context (PLAN.md §5.4: the
 * browser leg of the parity harness compares the numbers the page actually stored, not a re-run).
 * Keeping the drivers here keeps each spec a list of assertions.
 *
 * ASSET PATTERNS. `HEAVY_ASSET` matches every lazy asset PLAN.md §4.4 says the landing page must
 * not request: a graph (`*.onnx`), any ONNX Runtime WASM artefact (binary or `.mjs` loader, any
 * variant), and the HyPhy WASM trio (`hyphy.wasm`, `hyphy.data`, `hyphy.js`). `ORT_FORBIDDEN`
 * lists the onnxruntime-web variants the CPU-only entry must never reach for (`jsep` is the
 * WebGPU/WebNN build, `asyncify`/`jspi` the async-call builds); `scripts/copy-assets.mjs` vendors
 * only `ort-wasm-simd-threaded.{wasm,mjs}`, so a request for anything else is a 404 and a wrong
 * import path in runtime/src/session-web.js.
 *
 * ENGINE PATHS. The Python reference fixtures and the parity directory live in the engine
 * repository beside this one (PARITY.md "File layout"); `HYPHAEON_ENGINE_DIR` overrides the
 * default `../../HyphAeon`, as web/scripts/prebake-gallery.mjs accepts. The browser surface file
 * is written to `parity/browser/` and mirrored to `parity/web/` because scripts/parity.py's
 * KNOWN_SURFACES names that surface `web`.
 *
 * TOLERANCE CLASSES (PLAN.md §5.4, mirrored from scripts/parity.py's compare_epistasis):
 *   - graph:       |Δ| ≤ 1e-5 · max(1, |lrt|) for anything that went through ORT (LRTs, cesi,
 *                  similarity, sector mean_lrt);
 *   - exact:       edge set and order, ref_u/ref_v, shared counts, sector membership, signatures;
 *   - special:     p_val / hyper_p / fdr_q are a hypergeometric on integer counts and BH over it;
 *                  the inputs are exact, so 1e-6 absolute (the MCP suite measured ≤ 1e-6 on Smc6);
 *   - statistical: p_perm within 3·√(p(1−p)/B) with p floored at 1/B (parity.py stat_tol); the
 *                  null moments are Monte Carlo estimates and at B = 1,000 each side carries about
 *                  5 % of its own error (PHASE2A.md), so mean and p95 are held to 5 % and the std
 *                  to 20 %, as mcp/test/helpers.js does; the exact figures are annotated.
 */

import { expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));
export const APP_DIR = resolve(E2E_DIR, '..');
export const ENGINE_DIR = resolve(process.env.HYPHAEON_ENGINE_DIR ?? resolve(E2E_DIR, '../../HyphAeon'));
export const FIXTURES_E2E = resolve(ENGINE_DIR, 'fixtures/e2e');
export const PARITY_DIR = resolve(ENGINE_DIR, 'parity');
export const MODELS_DIR = resolve(ENGINE_DIR, 'models');
/** The bundled inputs the gallery prebake and the server tests read. */
export const GALLERY_INPUTS = resolve(APP_DIR, 'web/static/gallery/inputs');

/** Model graphs, any ONNX Runtime WASM artefact, and the HyPhy WASM trio. */
export const HEAVY_ASSET = /\.onnx(\?|$)|ort-wasm[^/]*\.(wasm|mjs)(\?|$)|ort-[^/]*\.wasm(\?|$)|\/hyphy\.(wasm|data|js)(\?|$)/i;
export const ONNX = /\.onnx(\?|$)/i;
export const ORT_WASM = /ort-[^/]*\.wasm(\?|$)/i;
export const ORT_LOADER = /ort-[^/]*\.mjs(\?|$)/i;
export const ORT_FORBIDDEN = /jsep|asyncify|jspi/i;
export const HYPHY_ASSET = /\/hyphy\.(wasm|data|js)(\?|$)/i;

/** The report's sections, in PLAN.md §4.0 order (lib/api.ts SECTION_ORDER). */
export const SECTIONS = ['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype'] as const;
export type SectionName = (typeof SECTIONS)[number];
/** The sections `runEverything` computes unasked (phenotype is on demand, Phase 3). */
export const COMPUTED_SECTIONS: SectionName[] = ['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms'];

export interface RequestLog {
	urls: () => string[];
	failed: () => string[];
	/** Requests whose URL matches `re`. */
	matching: (re: RegExp) => string[];
	/** Requests to another origin than `origin`. */
	offOrigin: (origin: string) => string[];
	/** Forget everything recorded so far (to scope a check to what follows). */
	reset: () => void;
}

/** Record every http(s) request the page (and its workers) makes, from before navigation. */
export function trackRequests(page: Page): RequestLog {
	let urls: string[] = [];
	let failed: string[] = [];
	page.on('request', (request) => {
		const url = request.url();
		if (/^https?:/i.test(url)) urls.push(url);
	});
	page.on('requestfailed', (request) => {
		const url = request.url();
		if (/^https?:/i.test(url)) failed.push(`${url} (${request.failure()?.errorText ?? 'failed'})`);
	});
	page.on('response', (response) => {
		const url = response.url();
		if (/^https?:/i.test(url) && response.status() >= 400) failed.push(`${url} (HTTP ${response.status()})`);
	});
	return {
		urls: () => [...urls],
		failed: () => [...failed],
		matching: (re) => urls.filter((u) => re.test(u)),
		offOrigin: (origin) => urls.filter((u) => new URL(u).origin !== origin),
		reset: () => {
			urls = [];
			failed = [];
		}
	};
}

/**
 * The one product action, for a bundled example: open `/analyze/?demo=<id>&autorun=1` (what a
 * landing-page chip or a dropped file leads to) and wait for the navigation to the report. Resolves
 * to the report id from `/report/local/?id=<id>` (lib/api.ts reportPath).
 */
export async function startDemoReport(page: Page, demo: string, { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<string> {
	await page.goto(`/analyze/?demo=${encodeURIComponent(demo)}&autorun=1`);
	await page.waitForURL(/\/report\/local\/\?id=/, { timeout: timeoutMs });
	const id = new URL(page.url()).searchParams.get('id');
	expect(id, 'report URL carries the record id').toBeTruthy();
	return id!;
}

/** The report section element (lib/report/Section.svelte: `section#<name>[data-state]`). */
export function section(page: Page, name: SectionName | 'provenance') {
	return page.locator(`section#${name}`);
}

/** Wait until a section's `data-state` is one of `states`. */
export async function waitForSectionState(page: Page, name: SectionName, states: string[], timeoutMs = 120_000): Promise<string> {
	const loc = section(page, name);
	await expect(loc).toBeAttached();
	await expect
		.poll(async () => (await loc.getAttribute('data-state')) ?? '', { timeout: timeoutMs, message: `section ${name} reaches ${states.join('|')}` })
		.toMatch(new RegExp(`^(${states.join('|')})$`));
	return (await loc.getAttribute('data-state'))!;
}

/** A site row as the CLI writes it (Appendix B). */
export interface CliSite {
	site: number;
	hyphaeon_lrt: number;
	p_value: number;
	q_value: number;
	is_invariable: boolean;
}

/** An epistasis edge as `hyphaeon epistasis -o` writes it (epistasis.py / js epistasis port). */
export interface CliEdge {
	site_u: number;
	site_v: number;
	ref_u: string;
	ref_v: string;
	lrt_u: number;
	lrt_v: number;
	similarity: number;
	shared_taxa: number;
	shared_branches: number;
	p_val: number;
	hyper_p: number;
	fdr_q: number;
	cesi: number;
}

export interface CliSector {
	sector_id: number;
	size: number;
	sites: number[];
	spectral_coherence: number;
	p_perm?: number;
	null_coherence_mean?: number;
	null_coherence_std?: number;
	null_coherence_95?: number;
	isotropic_baseline: number;
	shared_taxa: number;
	shared_branches: number;
	mean_lrt: number;
	pars_signature: string;
	consensus_signature: string;
}

export interface CliEpistasis {
	alignment: string | null;
	tree: string | null;
	taxa_count: number;
	codon_count: number;
	evaluated_taxa: number;
	coselection_edges_count: number;
	discovered_sectors_count: number;
	edges: CliEdge[];
	sectors: CliSector[];
	plasticity: unknown[];
	coselection_edges: CliEdge[];
	epistatic_sectors: CliSector[];
	selection_dms_plasticity: unknown[];
	permutations?: { n: number; seed: number };
}

/** The parts of a stored ReportRecord the specs read (typed arrays and input texts are left behind). */
export interface StoredReport {
	id: string;
	name: string;
	inputs: Record<string, any>;
	options: Record<string, any>;
	diagnostics: unknown;
	status: { state: string; phase: string | null; done: number; total: number; message: string | null; error?: string; completed: string[] };
	runtime: { numThreads: number; crossOriginIsolated: boolean; hardwareConcurrency: number | null; wallMs: number } | null;
	provenance: Record<string, any> | null;
	timings: Record<string, number>;
	sectionKeys: Record<string, boolean>;
	sites: CliSite[];
	siteCount: number;
	taxaUsed: number | null;
	gene: Record<string, any> | null;
	epistasis: CliEpistasis | null;
	attribution: { attribution_enabled: boolean; attributed: number } | null;
	filter: { filter_enabled: boolean; artifacts_masked: number } | null;
	dms: { focal_taxon: string | null; total_mutations: number; plasticity: number; progress: { done: number; total: number } | null; cancelled: boolean; skipped: unknown; capped: boolean } | null;
}

/**
 * Read a stored report out of IndexedDB in the page context (lib/storage/results.ts: database
 * `hyphaeon`, store `reports`, keyed by id) and return a structured-clone-safe projection of it.
 */
export async function readStoredReport(page: Page, id: string): Promise<StoredReport | null> {
	return page.evaluate(async (reportId) => {
		const record = await new Promise<any>((resolvePromise, reject) => {
			const open = indexedDB.open('hyphaeon');
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				if (!db.objectStoreNames.contains('reports')) {
					db.close();
					return resolvePromise(null);
				}
				const get = db.transaction('reports', 'readonly').objectStore('reports').get(reportId);
				get.onsuccess = () => {
					db.close();
					resolvePromise(get.result ?? null);
				};
				get.onerror = () => {
					db.close();
					reject(get.error);
				};
			};
		});
		if (!record) return null;
		const clean = (v: unknown) => (v == null ? null : JSON.parse(JSON.stringify(v)));
		const s = record.sections ?? {};
		const sites = s.sites?.sites ?? [];
		const inputs = { ...(record.inputs ?? {}) };
		delete inputs.alignmentText;
		delete inputs.treeText;
		const epi = s.epistasis;
		return {
			id: record.id,
			name: record.name,
			inputs,
			options: clean(record.options) ?? {},
			diagnostics: clean(record.diagnostics),
			status: clean(record.status),
			runtime: clean(record.runtime),
			provenance: clean(record.provenance),
			timings: clean(record.timings) ?? {},
			sectionKeys: Object.fromEntries(Object.keys(s).map((k) => [k, s[k] != null])),
			sites: sites.map((r: any) => ({
				site: Number(r.site),
				hyphaeon_lrt: Number(r.hyphaeon_lrt),
				p_value: Number(r.p_value),
				q_value: Number(r.q_value),
				is_invariable: Boolean(r.is_invariable)
			})),
			siteCount: sites.length,
			taxaUsed: record.provenance?.preprocessing?.taxa_used ?? s.sites?.provenance?.preprocessing?.taxa_used ?? null,
			gene: s.gene ? clean(s.gene.record) : null,
			epistasis:
				epi && Array.isArray(epi.edges)
					? {
							alignment: epi.alignment ?? null,
							tree: epi.tree ?? null,
							taxa_count: epi.taxa_count,
							codon_count: epi.codon_count,
							evaluated_taxa: epi.evaluated_taxa ?? epi.taxa_count,
							coselection_edges_count: epi.coselection_edges_count ?? epi.edges.length,
							discovered_sectors_count: epi.discovered_sectors_count ?? epi.sectors.length,
							edges: clean(epi.edges),
							sectors: clean(epi.sectors),
							plasticity: clean(epi.plasticity ?? []),
							coselection_edges: clean(epi.edges),
							epistatic_sectors: clean(epi.sectors),
							selection_dms_plasticity: clean(epi.plasticity ?? []),
							permutations: epi.permutations ? { n: epi.permutations.n, seed: epi.permutations.seed } : undefined
						}
					: null,
			attribution: s.attribution && !s.attribution.failed ? { attribution_enabled: Boolean(s.attribution.attribution_enabled), attributed: Object.keys(s.attribution.attributions ?? {}).length } : null,
			filter: s.filter && !s.filter.failed ? { filter_enabled: Boolean(s.filter.filter_enabled), artifacts_masked: (s.filter.artifacts_masked ?? []).length } : null,
			dms:
				s.dms && !s.dms.failed
					? {
							focal_taxon: s.dms.focal_taxon ?? null,
							total_mutations: Number(s.dms.total_mutations ?? 0),
							plasticity: (s.dms.plasticity ?? []).length,
							progress: s.dms.progress ? { done: s.dms.progress.done, total: s.dms.progress.total } : null,
							cancelled: Boolean(s.dms.cancelled),
							skipped: clean(s.dms.skipped ?? null),
							capped: Boolean(s.dms.capped)
						}
					: null
		};
	}, id);
}

/** Poll IndexedDB until the report's status leaves `running` (done, cancelled, failed). */
export async function waitForStoredState(page: Page, id: string, timeoutMs = 300_000): Promise<StoredReport> {
	let last: StoredReport | null = null;
	await expect
		.poll(
			async () => {
				last = await readStoredReport(page, id);
				return last?.status.state ?? 'missing';
			},
			{ timeout: timeoutMs, intervals: [500, 1000, 2000], message: `report ${id} leaves the running state` }
		)
		.not.toMatch(/^(running|missing)$/);
	return last!;
}

/** The reference CLI's document for an e2e fixture (`fixtures/e2e/<name>.json`, a one-entry list). */
function referenceFixture<T>(name: string): T | null {
	const path = resolve(FIXTURES_E2E, `${name}.json`);
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	const doc = Array.isArray(raw) ? raw[0]?.outputs : raw;
	return (doc as T) ?? null;
}

export function referenceMeme(example: string): { sites: CliSite[]; taxa_count: number; codon_count: number } | null {
	const doc = referenceFixture<{ sites: CliSite[]; taxa_count: number; codon_count: number }>(`meme_${example}`);
	return doc && Array.isArray(doc.sites) ? doc : null;
}

/** `fixtures/e2e/epistasis_<example>_n_permutations_<B>.json` (the CLI at `--n-permutations B --seed 42`). */
export function referenceEpistasis(example: string, permutations: number): CliEpistasis | null {
	const doc = referenceFixture<CliEpistasis>(`epistasis_${example}_n_permutations_${permutations}`);
	return doc && Array.isArray(doc.edges) ? doc : null;
}

/** A surface file the app's runner wrote (`parity/<surface>/<example>.meme.json`). */
export function surfaceMeme(surface: string, example: string): { sites: CliSite[] } | null {
	const path = resolve(PARITY_DIR, surface, `${example}.meme.json`);
	if (!existsSync(path)) return null;
	const doc = JSON.parse(readFileSync(path, 'utf8'));
	return Array.isArray(doc?.sites) ? doc : null;
}

/** Write a surface file for scripts/parity.py under `parity/browser/` and its `web` alias. */
export function writeBrowserParityFile(name: string, text: string): string {
	const body = text.endsWith('\n') ? text : `${text}\n`;
	let first = '';
	for (const surface of ['browser', 'web']) {
		const dir = resolve(PARITY_DIR, surface);
		mkdirSync(dir, { recursive: true });
		const path = resolve(dir, name);
		writeFileSync(path, body);
		if (!first) first = path;
	}
	return first;
}

/** `hyphaeon epistasis -o` document from a report's epistasis section (runtime/src/report.js epistasisDocument). */
export function epistasisDocumentText(epi: CliEpistasis, provenance: Record<string, unknown> | null): string {
	const doc: Record<string, unknown> = {
		alignment: epi.alignment,
		tree: epi.tree,
		taxa_count: epi.taxa_count,
		codon_count: epi.codon_count,
		evaluated_taxa: epi.evaluated_taxa,
		coselection_edges_count: epi.coselection_edges_count,
		discovered_sectors_count: epi.discovered_sectors_count,
		edges: epi.edges,
		sectors: epi.sectors,
		plasticity: epi.plasticity,
		coselection_edges: epi.edges,
		epistatic_sectors: epi.sectors,
		selection_dms_plasticity: epi.plasticity
	};
	if (provenance) doc.provenance = { ...provenance, permutations: epi.permutations ?? provenance.permutations };
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/** PLAN.md §5.4 graph class: 1e-5 · max(1, |lrt|). */
export function graphTol(lrt: number): number {
	return 1e-5 * Math.max(1, Math.abs(lrt));
}

/** parity.py stat_tol: 3·√(p(1−p)/B) with p floored at 1/B. */
export function statTol(p: number, B: number): number {
	const q = Math.min(1 - 1 / B, Math.max(1 / B, p));
	return 3 * Math.sqrt((q * (1 - q)) / B);
}

export interface LrtComparison {
	n: number;
	maxAbs: number;
	maxRel: number;
	/** Sites whose |Δ| exceeds graphTol(reference lrt). */
	violations: Array<{ site: number; a: number; b: number; delta: number }>;
	spearman: number;
}

/** Compare two site lists in site order: LRT within the graph class, invariable flags exact. */
export function compareLrt(a: CliSite[], b: CliSite[]): LrtComparison {
	expect(a.length, 'site counts agree').toBe(b.length);
	const violations: LrtComparison['violations'] = [];
	let maxAbs = 0;
	let maxRel = 0;
	const xs: number[] = [];
	const ys: number[] = [];
	for (let i = 0; i < a.length; i++) {
		expect(a[i].site, `site index at row ${i}`).toBe(b[i].site);
		const delta = Math.abs(a[i].hyphaeon_lrt - b[i].hyphaeon_lrt);
		maxAbs = Math.max(maxAbs, delta);
		maxRel = Math.max(maxRel, delta / Math.max(1, Math.abs(b[i].hyphaeon_lrt)));
		if (delta > graphTol(b[i].hyphaeon_lrt)) violations.push({ site: a[i].site, a: a[i].hyphaeon_lrt, b: b[i].hyphaeon_lrt, delta });
		if (!b[i].is_invariable) {
			xs.push(a[i].hyphaeon_lrt);
			ys.push(b[i].hyphaeon_lrt);
		}
	}
	return { n: a.length, maxAbs, maxRel, violations, spearman: spearman(xs, ys) };
}

export interface EpistasisComparison {
	/** Exact and graph-class failures; any entry fails the test. */
	violations: string[];
	/** Statistical-class notes (p_perm and the null moments), for the annotation. */
	statistical: string[];
	/** Statistical-class failures. */
	statViolations: string[];
	edges: number;
	sectors: number;
}

const EDGE_EXACT: Array<keyof CliEdge> = ['ref_u', 'ref_v', 'shared_taxa', 'shared_branches'];
const EDGE_GRAPH: Array<keyof CliEdge> = ['lrt_u', 'lrt_v', 'similarity', 'cesi'];
const EDGE_SPECIAL: Array<keyof CliEdge> = ['p_val', 'hyper_p', 'fdr_q'];
const EDGE_SPECIAL_TOL = 1e-6;
const SECTOR_EXACT: Array<keyof CliSector> = ['size', 'sites', 'shared_taxa', 'shared_branches', 'pars_signature', 'consensus_signature', 'isotropic_baseline'];
const SECTOR_EIGEN_TOL = 1e-5;
const NULL_MOMENT_REL: Record<string, number> = { null_coherence_mean: 0.05, null_coherence_95: 0.05, null_coherence_std: 0.2 };

/**
 * Compare an epistasis document against the reference at the same B: edges and sectors exact
 * (set, order, membership, signatures), ORT-derived fields within the graph class, the
 * hypergeometric p / BH q at 1e-6, `p_perm` within the statistical bound.
 */
export function compareEpistasis(got: CliEpistasis, ref: CliEpistasis, B: number): EpistasisComparison {
	const violations: string[] = [];
	const statistical: string[] = [];
	const statViolations: string[] = [];
	for (const k of ['taxa_count', 'codon_count', 'evaluated_taxa', 'coselection_edges_count', 'discovered_sectors_count'] as const) {
		if (got[k] !== ref[k]) violations.push(`${k}: ${got[k]} vs ${ref[k]}`);
	}
	const key = (e: CliEdge) => `${e.site_u}-${e.site_v}`;
	const gKeys = got.edges.map(key);
	const rKeys = ref.edges.map(key);
	if (JSON.stringify(gKeys) !== JSON.stringify(rKeys)) violations.push(`edge set/order: got [${gKeys.join(', ')}] vs ref [${rKeys.join(', ')}]`);
	else {
		for (let i = 0; i < ref.edges.length; i++) {
			const g = got.edges[i];
			const r = ref.edges[i];
			for (const f of EDGE_EXACT) if (g[f] !== r[f]) violations.push(`edge ${rKeys[i]} ${f}: ${g[f]} vs ${r[f]}`);
			for (const f of EDGE_GRAPH) {
				const d = Math.abs((g[f] as number) - (r[f] as number));
				if (d > graphTol(r[f] as number)) violations.push(`edge ${rKeys[i]} ${f}: |Δ| ${d.toExponential(2)} > graph class (${g[f]} vs ${r[f]})`);
			}
			for (const f of EDGE_SPECIAL) {
				const d = Math.abs((g[f] as number) - (r[f] as number));
				if (d > EDGE_SPECIAL_TOL) violations.push(`edge ${rKeys[i]} ${f}: |Δ| ${d.toExponential(2)} > ${EDGE_SPECIAL_TOL} (${g[f]} vs ${r[f]})`);
			}
		}
	}
	const gIds = got.sectors.map((s) => s.sector_id);
	const rIds = ref.sectors.map((s) => s.sector_id);
	if (JSON.stringify(gIds) !== JSON.stringify(rIds)) violations.push(`sector ids: got [${gIds.join(', ')}] vs ref [${rIds.join(', ')}]`);
	else {
		for (let i = 0; i < ref.sectors.length; i++) {
			const g = got.sectors[i];
			const r = ref.sectors[i];
			for (const f of SECTOR_EXACT) {
				if (JSON.stringify(g[f]) !== JSON.stringify(r[f])) violations.push(`sector ${r.sector_id} ${f}: ${JSON.stringify(g[f])} vs ${JSON.stringify(r[f])}`);
			}
			const dl = Math.abs(g.mean_lrt - r.mean_lrt);
			if (dl > graphTol(r.mean_lrt)) violations.push(`sector ${r.sector_id} mean_lrt: |Δ| ${dl.toExponential(2)} > graph class`);
			const dc = Math.abs(g.spectral_coherence - r.spectral_coherence);
			if (dc > SECTOR_EIGEN_TOL) violations.push(`sector ${r.sector_id} spectral_coherence: |Δ| ${dc.toExponential(2)} > ${SECTOR_EIGEN_TOL}`);
			if (typeof r.p_perm === 'number' && typeof g.p_perm === 'number') {
				const dp = Math.abs(g.p_perm - r.p_perm);
				const tol = statTol(r.p_perm, B);
				statistical.push(`sector ${r.sector_id} p_perm ${g.p_perm} vs ${r.p_perm} (|Δp| ${dp.toFixed(4)} ≤ ${tol.toFixed(4)})`);
				if (dp > tol) statViolations.push(`sector ${r.sector_id} p_perm: |Δp| ${dp.toFixed(4)} > 3·√(p(1−p)/B) = ${tol.toFixed(4)}`);
				for (const [f, rel] of Object.entries(NULL_MOMENT_REL)) {
					const gv = g[f as keyof CliSector] as number | undefined;
					const rv = r[f as keyof CliSector] as number | undefined;
					if (typeof gv !== 'number' || typeof rv !== 'number') continue;
					const d = Math.abs(gv - rv) / Math.max(Math.abs(rv), 1e-12);
					statistical.push(`sector ${r.sector_id} ${f} rel ${d.toExponential(2)}`);
					if (d > rel) statViolations.push(`sector ${r.sector_id} ${f}: relative ${d.toExponential(2)} > ${rel}`);
				}
			}
		}
	}
	return { violations, statistical, statViolations, edges: ref.edges.length, sectors: ref.sectors.length };
}

function ranks(values: number[]): number[] {
	const order = values.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
	const out = new Array<number>(values.length);
	let i = 0;
	while (i < order.length) {
		let j = i;
		while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
		const r = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) out[order[k][1]] = r;
		i = j + 1;
	}
	return out;
}

/** Spearman rank correlation (average ranks on ties). */
export function spearman(xs: number[], ys: number[]): number {
	if (xs.length < 2) return NaN;
	const rx = ranks(xs);
	const ry = ranks(ys);
	const mx = rx.reduce((s, v) => s + v, 0) / rx.length;
	const my = ry.reduce((s, v) => s + v, 0) / ry.length;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < rx.length; i++) {
		sxy += (rx[i] - mx) * (ry[i] - my);
		sxx += (rx[i] - mx) ** 2;
		syy += (ry[i] - my) ** 2;
	}
	return sxy / Math.sqrt(sxx * syy);
}

/** The gene card's p formatting (lib/viz/GeneCard.svelte, OverviewStrip.svelte fmtP). */
export function formatP(p: number): string {
	return p < 1e-4 ? p.toExponential(1) : p.toFixed(3);
}

/** The gene card's p format (web/src/lib/viz/GeneCard.svelte `fmtP`): four decimals, two-digit exponent under 1e-4. */
export function formatCardP(p: number): string {
	return p < 1e-4 ? p.toExponential(2) : p.toFixed(4);
}
