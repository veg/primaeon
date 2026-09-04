/**
 * helpers.ts — what the Phase 1 specs share: request tracking, the demo-run driver for /analyze,
 * the IndexedDB reader, the parity comparators and the engine paths.
 *
 * WHY THIS FILE EXISTS. Three spec files drive the same built site (smoke, analyze, gallery) and
 * two of them (analyze, gallery) need the same request bookkeeping the landing spec started
 * with; the analyze spec additionally has to run a demo to completion twice (bat_oas1, camelid)
 * and read the stored record back out of IndexedDB in the page context (PLAN.md §5.4: the
 * browser leg of the parity harness compares the numbers the page actually stored, not a
 * re-run). Keeping the drivers here keeps each spec a list of assertions.
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
 * default `../../HyphAeon`, as web/scripts/prebake-gallery.mjs accepts.
 *
 * TOLERANCE. `GRAPH_TOL(lrt)` is PLAN.md §5.4's graph class, 1e-5 · max(1, |lrt|): absolute for
 * small LRTs (where a relative bound on a value near 0 is meaningless), relative above 1.
 */

import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));
export const ENGINE_DIR = resolve(process.env.HYPHAEON_ENGINE_DIR ?? resolve(E2E_DIR, '../../HyphAeon'));
export const FIXTURES_E2E = resolve(ENGINE_DIR, 'fixtures/e2e');
export const PARITY_DIR = resolve(ENGINE_DIR, 'parity');

/** Model graphs, any ONNX Runtime WASM artefact, and the HyPhy WASM trio. */
export const HEAVY_ASSET = /\.onnx(\?|$)|ort-wasm[^/]*\.(wasm|mjs)(\?|$)|ort-[^/]*\.wasm(\?|$)|\/hyphy\.(wasm|data|js)(\?|$)/i;
export const ONNX = /\.onnx(\?|$)/i;
export const ORT_WASM = /ort-[^/]*\.wasm(\?|$)/i;
export const ORT_LOADER = /ort-[^/]*\.mjs(\?|$)/i;
export const ORT_FORBIDDEN = /jsep|asyncify|jspi/i;
export const HYPHY_ASSET = /\/hyphy\.(wasm|data|js)(\?|$)/i;

export interface RequestLog {
	urls: () => string[];
	failed: () => string[];
	/** Requests whose URL matches `re`. */
	matching: (re: RegExp) => string[];
	/** Requests to another origin than `origin`. */
	offOrigin: (origin: string) => string[];
}

/** Record every http(s) request the page (and its workers) makes, from before navigation. */
export function trackRequests(page: Page): RequestLog {
	const urls: string[] = [];
	const failed: string[] = [];
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
		offOrigin: (origin) => urls.filter((u) => new URL(u).origin !== origin)
	};
}

/** The demo chips on /analyze (lib/analyze/inputs.ts DEMOS). */
export const DEMO_LABEL: Record<string, string> = {
	bat_oas1: 'Bat OAS1',
	Smc6: 'Smc6',
	camelid: 'Camelid VHH',
	HIV1_RT: 'HIV-1 RT',
	RHO: 'Rhodopsin'
};

/** The "Before you run" panel, settled (aria-busy false, rows rendered). */
export async function beforeYouRun(page: Page) {
	const panel = page.locator('section[aria-labelledby="byr-title"]');
	await expect(panel).toBeVisible();
	await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
	await expect(panel.locator('table.warnings')).toBeVisible({ timeout: 60_000 });
	return panel;
}

/**
 * Open /analyze and load a demo through its chip. The page is prerendered, so the chip exists
 * before Svelte hydrates and a click before hydration is a no-op (no handler yet); the click is
 * retried until the alignment textarea fills, which is the only observable sign the handler ran.
 */
export async function loadDemo(page: Page, demo: keyof typeof DEMO_LABEL): Promise<void> {
	await page.goto('/analyze/');
	await page.waitForLoadState('networkidle');
	const chip = page.getByRole('button', { name: DEMO_LABEL[demo], exact: true });
	const alignment = page.getByLabel('Or paste it');
	for (let attempt = 0; attempt < 10; attempt++) {
		await chip.click();
		try {
			await expect(alignment).not.toHaveValue('', { timeout: 3_000 });
			return;
		} catch {
			// not hydrated yet, or the fetch is still in flight: click again
		}
	}
	await expect(alignment, `demo ${demo} loaded into the alignment box`).not.toHaveValue('');
}

export interface RunDemoOptions {
	variant?: 'general' | 'viral';
	/** Wall-clock budget for the run itself (model download, HyPhy, inference). */
	runTimeoutMs?: number;
}

/**
 * With a demo loaded and diagnosed: pick the variant, Run, and wait for the navigation to the
 * stored result. Resolves to the record id from the results URL.
 */
export async function runDemo(page: Page, { variant = 'general', runTimeoutMs = 240_000 }: RunDemoOptions = {}): Promise<string> {
	await beforeYouRun(page);
	await page.locator(`input[name="variant"][value="${variant}"]`).check();
	const run = page.getByRole('button', { name: 'Run', exact: true });
	await expect(run).toBeEnabled({ timeout: 60_000 });
	await run.click();
	await page.waitForURL(/\/results\/local\/\?id=/, { timeout: runTimeoutMs });
	const id = new URL(page.url()).searchParams.get('id');
	expect(id, 'results URL carries the record id').toBeTruthy();
	return id!;
}

/** A site row as the CLI writes it (Appendix B). */
export interface CliSite {
	site: number;
	hyphaeon_lrt: number;
	p_value: number;
	q_value: number;
	is_invariable: boolean;
}

/** The parts of a stored ResultRecord the specs read (typed arrays are left behind on purpose). */
export interface StoredRun {
	id: string;
	name: string;
	inputs: { treeSource: string; demo?: string; tree: unknown; alignment: { name: string; sha256: string | null } };
	options: Record<string, unknown>;
	steps: Array<{ id: string; status: string; message: string | null; elapsedMs: number | null }>;
	runtime: { numThreads: number; crossOriginIsolated: boolean; hardwareConcurrency: number | null; wallMs: number };
	provenance: Record<string, any>;
	summary: Record<string, unknown>;
	sites: CliSite[];
	siteCount: number;
	hasArrays: boolean;
}

/**
 * Read a stored run out of IndexedDB in the page context (lib/storage/results.ts: database
 * `hyphaeon`, store `runs`, keyed by id) and return a structured-clone-safe projection of it.
 */
export async function readStoredRun(page: Page, id: string): Promise<StoredRun | null> {
	return page.evaluate(async (runId) => {
		const record = await new Promise<any>((resolvePromise, reject) => {
			const open = indexedDB.open('hyphaeon');
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				if (!db.objectStoreNames.contains('runs')) return resolvePromise(null);
				const get = db.transaction('runs', 'readonly').objectStore('runs').get(runId);
				get.onsuccess = () => resolvePromise(get.result ?? null);
				get.onerror = () => reject(get.error);
			};
		});
		if (!record) return null;
		const result = record.result ?? {};
		return {
			id: record.id,
			name: record.name,
			inputs: record.inputs,
			options: record.options,
			steps: (record.steps ?? []).map((s: any) => ({ id: s.id, status: s.status, message: s.message, elapsedMs: s.elapsedMs })),
			runtime: record.runtime,
			provenance: JSON.parse(JSON.stringify(result.provenance ?? {})),
			summary: JSON.parse(JSON.stringify(result.summary ?? {})),
			sites: (result.sites ?? []).map((s: any) => ({
				site: Number(s.site),
				hyphaeon_lrt: Number(s.hyphaeon_lrt),
				p_value: Number(s.p_value),
				q_value: Number(s.q_value),
				is_invariable: Boolean(s.is_invariable)
			})),
			siteCount: (result.sites ?? []).length,
			hasArrays: Boolean(result.arrays && result.arrays.lrt)
		};
	}, id);
}

/** The reference CLI's document for an e2e fixture (`fixtures/e2e/meme_<example>.json`, a one-entry list). */
export function referenceMeme(example: string): { sites: CliSite[]; taxa_count: number; codon_count: number } | null {
	const path = resolve(FIXTURES_E2E, `meme_${example}.json`);
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	const doc = Array.isArray(raw) ? raw[0]?.outputs : raw;
	if (!doc || !Array.isArray(doc.sites)) return null;
	return doc;
}

/** A surface file the app's runner wrote (`parity/<surface>/<example>.meme.json`). */
export function surfaceMeme(surface: string, example: string): { sites: CliSite[] } | null {
	const path = resolve(PARITY_DIR, surface, `${example}.meme.json`);
	if (!existsSync(path)) return null;
	const doc = JSON.parse(readFileSync(path, 'utf8'));
	return Array.isArray(doc?.sites) ? doc : null;
}

/** PLAN.md §5.4 graph class: 1e-5 · max(1, |lrt|). */
export function graphTol(lrt: number): number {
	return 1e-5 * Math.max(1, Math.abs(lrt));
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
