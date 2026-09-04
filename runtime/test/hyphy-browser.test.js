/**
 * hyphy-browser.test.js - HyPhy WASM in headless Chromium, in the two kinds of worker.
 *
 * WHY THIS FILE EXISTS. The Node suite proves the evaluate path; the browser is where the build
 * was compiled for, and it has two entry shapes the web worker will meet: a classic worker
 * (importScripts, Vite's production `worker.format: 'iife'`) and a module worker (Vite's dev
 * server, which cannot importScripts, so the glue text is fetched and evaluated). Both must
 * produce a tree, and neither may leak HyPhy's `postMessage({type: 'biowasm'})` status traffic
 * to the worker's owner, which is what an unwrapped biowasm build does.
 *
 * Runs only when playwright-core (a dependency of the e2e workspace, hoisted to the root
 * node_modules) can launch Chromium; otherwise the suite is skipped with a note. Serves
 * runtime/ over node:http on a port in 4200-4299 (the project notebook: never touch other servers' ports)
 * with the worker scripts and page held in memory, so no test fixture files are needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HYPHY_WASM_VERSION, HYPHY_VERSION_STRING } from '../src/hyphy/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, '..');
const examples = resolve(runtimeDir, '..', '..', 'HyphAeon', 'examples');
const haveExamples = existsSync(join(examples, 'bat_oas1.fasta'));

const MIME = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.wasm': 'application/wasm',
	'.data': 'application/octet-stream',
	'.bf': 'text/plain',
	'.html': 'text/html',
	'.fasta': 'text/plain',
	'.nwk': 'text/plain'
};

const WORKER_BODY = `
self.onmessage = async (e) => {
	const { kind, fasta, newick, base } = e.data;
	try {
		const { createHyPhy } = await import('/src/hyphy/index.js');
		const hyphy = await createHyPhy({ locateFile: (name) => base + '/' + name });
		let r;
		if (kind === 'version') r = await hyphy.hyphyVersion();
		else if (kind === 'nj') r = await hyphy.njTree(fasta);
		else if (kind === 'hky85') r = await hyphy.estimateBranchLengths(fasta, newick);
		self.postMessage({ ok: true, result: r.result, elapsedMs: r.elapsedMs, strategy: hyphy.assets.glueStrategy });
	} catch (err) {
		self.postMessage({ ok: false, error: String(err && err.stack || err) });
	}
};
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>hyphy worker test</title><script>
window.runInWorker = (url, type, payload) => new Promise((resolve, reject) => {
	const w = new Worker(url, type ? { type } : undefined);
	const leaked = [];
	w.onmessage = (e) => {
		if (e.data && e.data.type === 'biowasm') { leaked.push(e.data); return; }
		w.terminate();
		resolve({ ...e.data, leaked: leaked.length });
	};
	w.onerror = (e) => { w.terminate(); reject(new Error('worker error: ' + e.message)); };
	w.postMessage(payload);
});
</script>`;

function startServer() {
	return new Promise((ready, failed) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url, 'http://localhost');
			const p = url.pathname;
			let body;
			let type = 'text/plain';
			if (p === '/' || p === '/index.html') {
				body = PAGE;
				type = 'text/html';
			} else if (p === '/worker.js') {
				body = WORKER_BODY;
				type = 'text/javascript';
			} else {
				const root = p.startsWith('/examples/') ? examples : runtimeDir;
				const rel = p.startsWith('/examples/') ? p.slice('/examples/'.length) : p.slice(1);
				const file = resolve(root, rel);
				if (!file.startsWith(root) || !existsSync(file)) {
					res.writeHead(404);
					res.end('not found');
					return;
				}
				body = readFileSync(file);
				type = MIME[extname(file)] ?? 'application/octet-stream';
			}
			res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
			res.end(body);
		});
		let port = 4200 + Math.floor(Math.random() * 60);
		const tryListen = () => {
			server.once('error', (e) => {
				if (e.code === 'EADDRINUSE' && port < 4299) {
					port += 1;
					tryListen();
				} else failed(e);
			});
			server.listen(port, '127.0.0.1', () => ready({ server, port }));
		};
		tryListen();
	});
}

async function launchChromium() {
	try {
		const { chromium } = await import('playwright-core');
		return await chromium.launch();
	} catch (e) {
		console.log(`[hyphy-browser] skipped: ${e?.message?.split('\n')[0] ?? e}`);
		return null;
	}
}

describe('HyPhy WASM in Chromium workers', () => {
	let browser = null;
	let server = null;
	let port = 0;
	let page = null;

	beforeAll(async () => {
		browser = await launchChromium();
		if (!browser) return;
		({ server, port } = await startServer());
		page = await browser.newPage();
		page.on('console', (m) => {
			if (m.type() === 'error') console.log(`[hyphy-browser] console.error: ${m.text()}`);
		});
		await page.goto(`http://127.0.0.1:${port}/`);
	});

	afterAll(async () => {
		await browser?.close();
		server?.close();
	});

	const base = () => `http://127.0.0.1:${port}/vendor/hyphy/${HYPHY_WASM_VERSION}`;
	const skipIfNoBrowser = () => !browser;

	it('module worker (eval path): version and NJ on bat_oas1, no biowasm leak', async ({ skip }) => {
		if (skipIfNoBrowser()) skip();
		const fasta = readFileSync(join(examples, 'bat_oas1.fasta'), 'utf8');
		const v = await page.evaluate(
			([b]) => window.runInWorker('/worker.js', 'module', { kind: 'version', base: b }),
			[base()]
		);
		expect(v.ok, v.error).toBe(true);
		expect(v.result).toBe(HYPHY_VERSION_STRING);
		expect(v.strategy).toBe('eval');
		expect(v.leaked).toBe(0);

		const r = await page.evaluate(
			([b, f]) => window.runInWorker('/worker.js', 'module', { kind: 'nj', fasta: f, base: b }),
			[base(), fasta]
		);
		expect(r.ok, r.error).toBe(true);
		expect(r.result.endsWith(';')).toBe(true);
		expect((r.result.match(/:/g) ?? []).length).toBe(33);
		expect(r.leaked).toBe(0);
		console.log(`[hyphy-browser] module worker NJ: ${r.elapsedMs.toFixed(0)} ms`);
	}, 120_000);

	it('classic worker (importScripts path): HKY85 on bat_oas1, no biowasm leak', async ({ skip }) => {
		if (skipIfNoBrowser() || !haveExamples) skip();
		const fasta = readFileSync(join(examples, 'bat_oas1.fasta'), 'utf8');
		const newick = readFileSync(join(examples, 'bat_oas1.nwk'), 'utf8');
		const r = await page.evaluate(
			([b, f, t]) => window.runInWorker('/worker.js', null, { kind: 'hky85', fasta: f, newick: t, base: b }),
			[base(), fasta, newick]
		);
		expect(r.ok, r.error).toBe(true);
		expect(r.strategy).toBe('importScripts');
		expect((r.result.match(/:/g) ?? []).length).toBe(33);
		expect(r.result).not.toMatch(/:-/);
		expect(r.leaked).toBe(0);
		console.log(`[hyphy-browser] classic worker HKY85 (18 taxa): ${r.elapsedMs.toFixed(0)} ms`);
	}, 120_000);
});
