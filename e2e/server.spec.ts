/**
 * server.spec.ts — the Node server at the wire: one `analyze` job on bat_oas1 from POST to result
 * over SSE, and the OAuth ceremony in front of the HTTP MCP mount.
 *
 * WHY THIS FILE EXISTS. PLAN.md §3.5 is the contract the web report's server-job path and the
 * claude.ai connector code against: `POST /api/v1/jobs {analysis, alignment, tree?, ...}` → 202
 * `{id}`; `GET /jobs/{id}/events` streams `status | progress {phase, done, total, message} |
 * section {name, final, payload} | done`; `GET /jobs/{id}/result` is the ReportRecord with a
 * `node-server` provenance. PLAN.md §3.6: `/mcp` is Bearer-guarded behind dynamic registration,
 * PKCE and an auto-approving /authorize, "so it can be added as a claude.ai connector the same way
 * the Datamonkey connector was". server/test/ checks each piece in-process with supertest; this
 * spec starts the real bin (`server/bin/hyphaeon-server.js`) as a user would, on a port in the
 * e2e range, with HYPHAEON_MODELS_DIR pointing at the engine's models, drives it over HTTP with
 * Playwright's request context, and stops it. The result's site LRTs are also held to the graph
 * class against the Python reference: the node-server leg of PLAN.md §5.4's four surfaces.
 *
 * The SSE stream is read with Node's streaming fetch (the request context buffers a response to
 * its end, and the server keeps the event stream open after `done`).
 *
 * PHASE 3 ADDS THE TWO THINGS THAT USED TO NEED SOMETHING ELSE. A job with an alignment and NO TREE
 * used to have no answer on this surface (the browser fitted one in HyPhy WASM; the server refused
 * or star-treed); under D22 it runs, tree-free, and the result says so in `preprocessing.tree_free`
 * — PLAN.md §4.2. And `analysis: "phenotype"` used to be the one pillar the MCP answered by
 * shelling out to the Python reference through `mcp/src/bridge.js`; the bridge is deleted, so the
 * job runs in the same worker thread as every other pillar. That claim is worth more than a passing
 * job, so it is checked at the source (nothing in server/ or mcp/ imports `node:child_process` or
 * names a Python entry point) and at run time: THE SERVER IS STARTED WITH A PATH THAT CONTAINS
 * NOTHING — no venv, no `hyphaeon`, no `python` — so a run that needed one would fail rather than
 * silently succeed on a developer's machine.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_DIR, GALLERY_INPUTS, MODELS_DIR, compareLrt, referenceMeme } from './helpers';

/** Every `.js` under `dir`, recursively (the server's and the MCP's sources). */
function jsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, name.name);
		if (name.isDirectory()) out.push(...jsFiles(full));
		else if (name.name.endsWith('.js')) out.push(full);
	}
	return out;
}

/**
 * What reaching for a subprocess looks like in these sources: the module that can start one, the
 * synchronous escapes, a spawn of an interpreter or of the reference CLI by name, and the deleted
 * bridge. Prose that merely names Python is not on this list; `mcp/src/tools.js` promises a reader
 * "there is no Python anywhere", and that sentence must not fail the test that proves it.
 */
const SUBPROCESS_PATTERNS = [
	/node:child_process|require\(['"]child_process['"]\)/,
	/\b(execFile|execFileSync|execSync|spawnSync|fork)\s*\(/,
	/\bspawn\s*\(\s*['"`](?:python|hyphaeon|hyphy)/i,
	/['"`](?:python\d?|hyphaeon|hyphy)['"`]\s*,\s*\[/i,
	/hyphaeon-bridge|from ['"]\.\/bridge|require\(['"]\.\/bridge/
];

/** Source with comments removed, so a sentence ABOUT subprocesses is not read as one. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const SERVER_BIN = resolve(APP_DIR, 'server/bin/hyphaeon-server.js');
const PORT_RANGE: [number, number] = [4260, 4299];
const ID_RE = /^[0-9a-f]{32}$/;
const REPORT_PHASES = ['parse', 'prepare', 'infer', 'stats', 'gene', 'epistasis', 'attribute', 'filter', 'dms', 'postprocess'];

async function freePort([lo, hi]: [number, number]): Promise<number> {
	for (let port = lo; port <= hi; port++) {
		const ok = await new Promise<boolean>((resolvePromise) => {
			const srv = createServer();
			srv.once('error', () => resolvePromise(false));
			srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)));
		});
		if (ok) return port;
	}
	throw new Error(`no free port in ${lo}-${hi}`);
}

interface SseEvent {
	event: string;
	data: any;
}

/** Read an SSE stream until the `until` event (or the stream ends). */
async function readSse(url: string, { until = 'done', timeoutMs = 240_000 }: { until?: string; timeoutMs?: number } = {}): Promise<SseEvent[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const events: SseEvent[] = [];
	try {
		const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
		if (res.status !== 200 || !res.body) throw new Error(`SSE status ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		outer: for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let i: number;
			while ((i = buf.indexOf('\n\n')) !== -1) {
				const block = buf.slice(0, i);
				buf = buf.slice(i + 2);
				let event = 'message';
				let data = '';
				for (const line of block.split('\n')) {
					if (line.startsWith('event:')) event = line.slice(6).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (!data) continue;
				events.push({ event, data: JSON.parse(data) });
				if (event === until) break outer;
			}
		}
		controller.abort();
	} catch (err) {
		if (!(err instanceof Error && err.name === 'AbortError')) throw err;
	} finally {
		clearTimeout(timer);
	}
	return events;
}

/** JSON-RPC messages out of a StreamableHTTP answer (SSE body or plain JSON). */
function rpcMessages(contentType: string, text: string): any[] {
	if (/text\/event-stream/.test(contentType)) {
		const out: any[] = [];
		for (const block of text.split('\n\n')) for (const line of block.split('\n')) if (line.startsWith('data:')) out.push(JSON.parse(line.slice(5).trim()));
		return out;
	}
	const parsed = JSON.parse(text);
	return Array.isArray(parsed) ? parsed : [parsed];
}

function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

test.describe('server', () => {
	test.describe.configure({ mode: 'serial', timeout: 300_000 });
	test.skip(!existsSync(SERVER_BIN), 'server/bin/hyphaeon-server.js is not in the tree');
	test.skip(!existsSync(join(MODELS_DIR, 'manifest.json')), `${MODELS_DIR}/manifest.json not found (engine checkout)`);

	let child: ChildProcess | null = null;
	let port: number;
	let issuer: string;
	let dataDir: string;
	let api: APIRequestContext;
	let jobId: string;
	let report: any;
	const log: string[] = [];

	test.beforeAll(async ({ playwright }) => {
		port = await freePort(PORT_RANGE);
		issuer = `http://localhost:${port}`;
		dataDir = mkdtempSync(join(tmpdir(), 'hyphaeon-e2e-server-'));
		// Phase 3: no Python and no HyPhy at runtime anywhere. `process.execPath` is absolute, so an
		// empty directory as the whole PATH costs this server nothing and makes any attempt to shell
		// out to `python`, `hyphaeon` or `hyphy` fail loudly instead of finding a developer's venv.
		const emptyPath = join(dataDir, 'empty-path');
		mkdirSync(emptyPath, { recursive: true });
		child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_BIN], {
			cwd: resolve(APP_DIR, 'server'),
			env: {
				...process.env,
				PATH: emptyPath,
				VIRTUAL_ENV: '',
				HYPHAEON_BIN: '',
				HYPHAEON_SERVER_PORT: String(port),
				HYPHAEON_SERVER_ISSUER: issuer,
				HYPHAEON_MODELS_DIR: MODELS_DIR,
				HYPHAEON_DATA_DIR: dataDir,
				HYPHAEON_SERVER_WORKERS: '1',
				HYPHAEON_SERVER_THREADS: process.env.HYPHAEON_SERVER_THREADS ?? '4',
				HYPHAEON_SERVER_LOG: 'info'
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		child.stdout!.on('data', (d) => log.push(String(d)));
		child.stderr!.on('data', (d) => log.push(String(d)));
		api = await playwright.request.newContext({ baseURL: issuer });
		// Wait for the health endpoint (the bin loads the runtime and opens SQLite first).
		const deadline = Date.now() + 90_000;
		let ready = false;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log.join('')}`);
			try {
				const r = await api.get('/api/v1/health');
				if (r.ok()) {
					ready = true;
					break;
				}
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!ready) throw new Error(`server did not become healthy on ${issuer}:\n${log.join('')}`);
	});

	test.afterAll(async () => {
		await api?.dispose();
		if (child && child.exitCode === null) {
			const exited = new Promise<void>((r) => child!.once('exit', () => r()));
			child.kill('SIGTERM');
			await Promise.race([exited, new Promise((r) => setTimeout(r, 30_000))]);
			if (child.exitCode === null) child.kill('SIGKILL');
		}
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {
			// leave it
		}
	});

	test('health, version and models answer', async () => {
		const health = await api.get('/api/v1/health');
		expect(health.status()).toBe(200);
		const version = await api.get('/api/v1/version');
		expect(version.status()).toBe(200);
		const models = await api.get('/api/v1/models');
		expect(models.status()).toBe(200);
		const body = await models.json();
		expect(JSON.stringify(body)).toMatch(/general/);
	});

	test('POST /api/v1/jobs analyze on bat_oas1 answers 202 with a 128-bit id', async () => {
		const alignment = readFileSync(join(GALLERY_INPUTS, 'bat_oas1.fasta'), 'utf8');
		const tree = readFileSync(join(GALLERY_INPUTS, 'bat_oas1.nwk'), 'utf8');
		const res = await api.post('/api/v1/jobs', {
			data: { analysis: 'analyze', alignment, tree, names: { alignment: 'bat_oas1.fasta', tree: 'bat_oas1.nwk' }, seed: 42 }
		});
		expect(res.status(), await res.text()).toBe(202);
		const body = await res.json();
		expect(body.id).toMatch(ID_RE);
		expect(['queued', 'running']).toContain(body.status);
		expect(body.analysis).toBe('analyze');
		jobId = body.id;
	});

	test('GET /events streams status, the runtime phases, sections (DMS progressively) and done', async () => {
		const events = await readSse(`${issuer}/api/v1/jobs/${jobId}/events`);
		const kinds = events.map((e) => e.event);
		expect(kinds.length).toBeGreaterThan(0);
		expect(kinds[0]).toBe('status');
		expect(kinds.at(-1)).toBe('done');
		expect(events.at(-1)!.data.status).toBe('completed');
		for (const p of new Set(events.filter((e) => e.event === 'progress').map((e) => e.data.phase))) expect(REPORT_PHASES).toContain(p);
		const names = events.filter((e) => e.event === 'section').map((e) => e.data.name);
		expect(names).toContain('sites');
		expect(names).toContain('gene');
		expect(names).toContain('epistasis');
		const dms = events.filter((e) => e.event === 'section' && e.data.name === 'dms');
		if (dms.length) {
			expect(dms.at(-1)!.data.final).toBe(true);
			expect(names.indexOf('dms')).toBeGreaterThan(names.indexOf('sites'));
			test.info().annotations.push({ type: 'dms-updates', description: `${dms.filter((e) => e.data.final === false).length} progressive + 1 final` });
		}
	});

	test('GET /jobs/:id is completed; GET /result is the report with every section and node-server provenance', async () => {
		const status = await api.get(`/api/v1/jobs/${jobId}`);
		expect(status.status()).toBe(200);
		const s = await status.json();
		expect(s.status).toBe('completed');
		expect(s.sections.sites).toBe('final');

		const res = await api.get(`/api/v1/jobs/${jobId}/result`);
		expect(res.status()).toBe(200);
		report = await res.json();
		expect(report.schema_version).toBe(2);
		expect(report.kind).toBe('report');
		expect(Object.keys(report.sections)).toEqual(expect.arrayContaining(['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype']));
		expect(report.sections.sites.sites).toHaveLength(351);
		expect(report.sections.gene.record.p_value_acat).toBeGreaterThan(0);
		expect(Array.isArray(report.sections.epistasis.edges)).toBe(true);
		expect(report.sections.dms.plasticity.length).toBeGreaterThan(0);
		expect(report.sections.phenotype).toBeNull();
		expect(report.provenance.surface).toBe('node-server');
		expect(report.provenance.seed ?? report.options.seed).toBe(42);

		const csv = await api.get(`/api/v1/jobs/${jobId}/result?format=csv`);
		expect(csv.status()).toBe(200);
		expect((await csv.text()).split('\n')[0]).toBe('site,hyphaeon_lrt,p_value,q_value,is_invariable');
	});

	test('parity: the server result matches the Python reference within the graph class', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixtures/e2e/meme_bat_oas1.json not found in the engine checkout');
		const sites = report.sections.sites.sites.map((r: any) => ({ site: Number(r.site), hyphaeon_lrt: Number(r.hyphaeon_lrt), p_value: Number(r.p_value), q_value: Number(r.q_value), is_invariable: Boolean(r.is_invariable) }));
		const cmp = compareLrt(sites, reference!.sites);
		test.info().annotations.push({ type: 'server-vs-python', description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}` });
		expect(cmp.violations, `graph-class violations: ${JSON.stringify(cmp.violations.slice(0, 5))}`).toEqual([]);
	});

	test('a job with an alignment and no tree completes, tree-free (D22)', async () => {
		const alignment = readFileSync(join(GALLERY_INPUTS, 'Smc6.fasta'), 'utf8');
		const res = await api.post('/api/v1/jobs', {
			data: { analysis: 'meme', alignment, names: { alignment: 'Smc6.fasta' }, seed: 42 }
		});
		expect(res.status(), await res.text()).toBe(202);
		const { id } = await res.json();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 300_000 });
		expect(events.at(-1)!.event).toBe('done');
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');

		const result = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		const pre = result.provenance.preprocessing;
		expect(pre.tree_source, 'no tree was supplied, so the model was given TN93 distances').toBe('tn93');
		expect(pre.tree_free?.reason).toBe('no_tree');
		expect(pre.branch_lengths_estimated).toBe(false);
		expect(result.sites ?? result.sections?.sites?.sites).toBeTruthy();
		const sites = result.sites ?? result.sections.sites.sites;
		expect(sites).toHaveLength(1097);
		expect(result.taxa_count ?? pre.taxa_used).toBe(20);
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('analysis: "phenotype" runs in the worker — no bridge, no Python', async () => {
		const alignment = readFileSync(join(GALLERY_INPUTS, 'Smc6.fasta'), 'utf8');
		const tree = readFileSync(join(GALLERY_INPUTS, 'Smc6.nwk'), 'utf8');
		const res = await api.post('/api/v1/jobs', {
			data: {
				analysis: 'phenotype',
				alignment,
				tree,
				names: { alignment: 'Smc6.fasta', tree: 'Smc6.nwk' },
				seed: 42,
				// The trait is the reader's, so it is the request's: four great apes as foreground.
				options: { phenotype: { foreground: 'hg18,homSap_293T,panTro4,panPan', permulations: 0, n_permutations: 0 } }
			}
		});
		expect(res.status(), await res.text()).toBe(202);
		const { id } = await res.json();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 300_000 });
		expect(events.at(-1)!.event).toBe('done');
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');

		const result = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		expect(result.phenotype_meta?.mode ?? result.sections?.phenotype?.phenotype_meta?.mode).toBe('discrete');
		const record = result.phenotype_meta ? result : result.sections.phenotype;
		expect(record.phenotype_meta.foreground_count).toBe(4);
		expect(record.phenotype_meta.background_count).toBe(16);
		expect(Array.isArray(record.sites)).toBe(true);
		expect(record.sites.length).toBeGreaterThan(0);
		expect(record.permulations_count, 'B = 0 was asked for').toBe(0);
		expect(record.gene_p_value_perm).toBeNull();
		expect(typeof record.p_evd_length_adjusted).toBe('number');
		expect(typeof record.compact_pars_signature).toBe('string');
		expect(result.provenance?.surface ?? record.provenance?.surface).toBe('node-server');
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('nothing on this surface can spawn Python: not in the sources, and not on PATH', async () => {
		// The bridge is deleted, not disabled.
		expect(existsSync(resolve(APP_DIR, 'mcp/src/bridge.js')), 'mcp/src/bridge.js still exists').toBe(false);
		// Everything this surface runs: the server, the MCP it mounts, and the runtime both call.
		const sources = ['server/src', 'server/bin', 'mcp/src', 'mcp/bin', 'runtime/src'].flatMap((d) => jsFiles(resolve(APP_DIR, d)));
		expect(sources.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const file of sources) {
			const body = code(readFileSync(file, 'utf8'));
			// Invocation, not prose: several tool descriptions say the words "no Python anywhere",
			// which is the claim, and must not be read as an attempt to run it.
			for (const pattern of SUBPROCESS_PATTERNS) {
				if (pattern.test(body)) offenders.push(`${file.slice(APP_DIR.length + 1)}: ${pattern}`);
			}
		}
		expect(offenders, `sources that could reach a subprocess: ${offenders.join(', ')}`).toEqual([]);
		// And the running server, which answered every request above, had nothing on its PATH:
		// `python`, `hyphaeon` and `hyphy` were all unreachable while those jobs completed.
		expect(child!.spawnargs.length).toBeGreaterThan(0);
		expect(readdirSync(join(dataDir, 'empty-path')), 'the PATH the server ran with is an empty directory').toEqual([]);
	});

	test('OAuth: register → authorize (PKCE, auto-approved) → token → /mcp tools/list lists hyphaeon_analyze', async () => {
		const discovery = await api.get('/.well-known/oauth-authorization-server');
		expect(discovery.status()).toBe(200);
		const meta = await discovery.json();
		expect(meta.issuer).toBe(issuer);
		expect(meta.code_challenge_methods_supported).toEqual(['S256']);
		const protectedResource = await api.get('/.well-known/oauth-protected-resource/mcp');
		expect((await protectedResource.json()).resource).toBe(`${issuer}/mcp`);

		// Without a bearer, /mcp answers 401 with the resource_metadata challenge.
		const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } };
		const anon = await api.post('/mcp', { data: initialize, headers: { Accept: 'application/json, text/event-stream' } });
		expect(anon.status()).toBe(401);
		expect(anon.headers()['www-authenticate']).toContain('resource_metadata=');

		const redirectUri = 'http://localhost:9999/cb';
		const reg = await api.post('/register', { data: { redirect_uris: [redirectUri], client_name: 'hyphaeon-e2e' } });
		expect(reg.status()).toBe(201);
		const client = await reg.json();
		expect(client.client_id).toBeTruthy();

		const { verifier, challenge } = pkce();
		const auth = await api.get('/authorize', {
			maxRedirects: 0,
			params: { client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e-state', resource: `${issuer}/mcp` }
		});
		expect(auth.status()).toBe(302);
		const loc = new URL(auth.headers()['location']);
		expect(loc.origin + loc.pathname).toBe(redirectUri);
		expect(loc.searchParams.get('state')).toBe('e2e-state');
		const code = loc.searchParams.get('code');
		expect(code).toBeTruthy();

		const tok = await api.post('/token', { form: { grant_type: 'authorization_code', code: code!, code_verifier: verifier, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri } });
		expect(tok.status(), await tok.text()).toBe(200);
		const token = await tok.json();
		expect(token.token_type).toBe('Bearer');
		expect(token.access_token).toBeTruthy();

		const bearer = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
		const init = await api.post('/mcp', { data: initialize, headers: bearer });
		expect(init.status(), await init.text()).toBe(200);
		const sid = init.headers()['mcp-session-id'];
		expect(sid).toBeTruthy();
		const initMsgs = rpcMessages(init.headers()['content-type'] ?? '', await init.text());
		expect(initMsgs[0].result.serverInfo.name).toBe('hyphaeon');

		const list = await api.post('/mcp', { data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers: { ...bearer, 'mcp-session-id': sid } });
		expect(list.status(), await list.text()).toBe(200);
		const msgs = rpcMessages(list.headers()['content-type'] ?? '', await list.text());
		const tools = msgs.find((m) => m.id === 2)?.result?.tools ?? [];
		const names = tools.map((t: any) => t.name);
		expect(names).toContain('hyphaeon_analyze');
		expect(names).toContain('hyphaeon_meme');
		expect(names).toContain('hyphaeon_epistasis');
		test.info().annotations.push({ type: 'mcp-tools', description: names.join(', ') });

		await api.delete('/mcp', { headers: { Authorization: bearer.Authorization, 'mcp-session-id': sid } });
	});

	test('DELETE /jobs/:id removes the job', async () => {
		const del = await api.delete(`/api/v1/jobs/${jobId}`);
		expect(del.status()).toBe(204);
		const after = await api.get(`/api/v1/jobs/${jobId}`);
		expect(after.status()).toBe(404);
	});
});
