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
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_DIR, GALLERY_INPUTS, MODELS_DIR, compareLrt, referenceMeme } from './helpers';

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
		child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_BIN], {
			cwd: resolve(APP_DIR, 'server'),
			env: {
				...process.env,
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
