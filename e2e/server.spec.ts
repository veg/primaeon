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
 *
 * PHASE 6 ADDS THE THREE TIME ANALYSES, AND THEY BRING A SECOND INPUT. `dates`, `dating` and
 * `temporal` are driven here exactly as the seven before them: POST, stream, read the result, take
 * the downloads. Four things about them are only true at the wire, which is why they are here and
 * not left to server/test/time.test.js's supertest coverage:
 *
 *   - `dates_file` is a second document in the request body — an Auspice build, a name-to-date map
 *     or a CSV — and it has to survive JSON transport, the job directory and the worker boundary to
 *     reach the date layer. A run that quietly fell back to reading the sequence NAMES instead
 *     would still answer, with different numbers and no error: the temporal job below passes the
 *     H5N1 metadata table and the result must say `date_review.source === 'table'`.
 *   - A REFUSAL IS A 422 AT THE DOOR, before a worker is spent. The date layer is consulted on the
 *     HTTP thread, so an undatable alignment never reaches the pool; the code is its own
 *     (`DATES_NONE`) and the kind is `input`, not a server fault.
 *   - THE TEMPORAL NULL REFINES ON THE STREAM. `permutations` is re-emitted per chunk with the
 *     achieved draw count and a `calls_are_final` flag, and the payload is a PROJECTION: the
 *     runtime's own interim is the whole record. The bytes that actually cross the wire are
 *     measured here, on a real SSE connection, rather than on supertest's in-process one.
 *   - THE REFERENCE'S OWN FILES ARE DOWNLOADS. `?file=` serves temporal's four and dating's two
 *     with a `Content-Disposition`, which is the header a browser acts on and an in-process test
 *     cannot really exercise.
 *
 * And all of it runs on the SAME empty-PATH server as the seven before it, so the no-subprocess
 * claim now covers the date layer and both time pillars: neither reaches for a `python`, and the
 * last test in this file asserts that their sources were inside the scan that proves it.
 *
 * THE EXAMPLES ARE THE CHEAPEST HONEST ONES, and they live in the ENGINE checkout rather than the
 * web gallery (the gallery holds the five selection demos; korber / H5N1 / H1N1 are the dated
 * sets). H5N1_HA_geo is 98 sequences x 566 codons with a tree and a metadata CSV, and carries the
 * whole temporal pillar at T = 60, B = 200; korber_env_gp160 is the one shipped set with exactly
 * one undated sequence, which is what makes it the gate's own test case.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_DIR, ENGINE_DIR, GALLERY_INPUTS, MODELS_DIR, compareLrt, referenceMeme } from './helpers';

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
/** runtime/src/dating/ and runtime/src/temporal/ own phases of their own; prepareRun's two are shared. */
const DATING_PHASES = ['parse', 'prepare', 'dating', 'dating-model'];
const TEMPORAL_PHASES = ['parse', 'prepare', 'temporal-infer', 'temporal-smooth', 'temporal-null', 'temporal-waves'];
/** server/src/time.js TEMPORAL_SECTIONS — the vocabulary `?section=` serves on a finished record. */
const TEMPORAL_SECTIONS = ['summary', 'sites', 'curves', 'waves', 'permutations', 'dates', 'candidates', 'warnings', 'honesty', 'provenance'];

/** The DATED examples, which live in the engine checkout beside this repository (see the header). */
const EXAMPLES = resolve(ENGINE_DIR, 'examples');
const H5N1 = resolve(EXAMPLES, 'H5N1_HA_geo.fasta');
const H5N1_META = resolve(EXAMPLES, 'H5N1_HA_metadata.csv');
const H5N1_TREE = resolve(EXAMPLES, 'H5N1_HA.nwk');
const KORBER = resolve(EXAMPLES, 'korber_env_gp160.fasta');
const haveDatedExamples = [H5N1, H5N1_META, H5N1_TREE, KORBER].every((f) => existsSync(f));

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
	/** What this event's `data:` payload actually cost on the wire, in characters. */
	bytes: number;
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
				events.push({ event, data: JSON.parse(data), bytes: data.length });
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
		// PHASE 6: `deploy/README.md` tells an operator to read `dating_graph` here to know whether
		// this build can serve `use_model` at all, BEFORE a caller discovers it inside a run. The
		// value is read from the manifest without loading a graph, and it is one of two words.
		expect(body.engine.dating_graph, JSON.stringify(body.engine)).toBeTruthy();
		for (const state of Object.values(body.engine.dating_graph as Record<string, string>)) expect(['declared', 'absent']).toContain(state);
		expect(body.engine.date_layer.engine).toMatch(/no model/);
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

	test('analysis: "dates" reviews the H5N1 metadata table over the wire — no model, no graph', async () => {
		test.skip(!haveDatedExamples, `${EXAMPLES} has no dated examples (engine checkout)`);
		const res = await api.post('/api/v1/jobs', {
			data: {
				analysis: 'dates',
				alignment: readFileSync(H5N1, 'utf8'),
				dates_file: readFileSync(H5N1_META, 'utf8'),
				names: { alignment: 'H5N1_HA_geo.fasta', dates_file: 'H5N1_HA_metadata.csv' }
			}
		});
		expect(res.status(), await res.text()).toBe(202);
		const { id } = await res.json();
		expect(id).toMatch(ID_RE);

		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 120_000 });
		expect(events.at(-1)!.event).toBe('done');
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');

		const doc = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		expect(doc.analysis).toBe('dates');
		expect(doc.ok).toBe(true);
		// The METADATA DOCUMENT crossed the wire and was used: a run that silently fell back to the
		// sequence names would also answer 98 of 98 here, and say `headers` instead.
		expect(doc.date_review.source).toBe('table');
		expect(doc.date_review.coverage.dated).toBe(98);
		expect(doc.date_review.coverage.taxa_total).toBe(98);
		// A taxon is never omitted from the per-taxon table; that is the question the review answers.
		expect(doc.date_review.rows).toHaveLength(98);
		expect(doc.clock).toMatchObject({ has_clock: true, dating_possible: true, temporal_possible: true });
		expect(doc.gate.ok, JSON.stringify(doc.gate.blocking)).toBe(true);
		expect(doc.provenance.surface).toBe('node-server');
		expect(doc.provenance.engine).toBe('in-process (no model, no graph)');
		// No model was loaded and no section was published: there is no "during" in this analysis.
		const view = await (await api.get(`/api/v1/jobs/${id}`)).json();
		expect(view.sections).toBeUndefined();
		test.info().annotations.push({ type: 'dates-span', description: `${doc.date_review.span.min} – ${doc.date_review.span.max}, units ${doc.date_review.time_units}` });
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('the date layer refuses at the door: 422 with its own code, before a worker is spent', async () => {
		// Five sequences that carry no date in any rule, and no metadata document to rescue them.
		const undatable = '>alpha\nATGATGATGATG\n>beta\nATGATGATGCTG\n>gamma\nATGATGCTGATG\n>delta\nATGCTGATGATG\n>epsilon\nCTGATGATGATG\n';
		for (const analysis of ['dating', 'temporal']) {
			const res = await api.post('/api/v1/jobs', { data: { analysis, alignment: undatable } });
			expect(res.status(), `${analysis}: ${await res.text()}`).toBe(422);
			const body = await res.json();
			expect(body.error.kind, analysis).toBe('input');
			expect(body.error.code, analysis).toBe('DATES_NONE');
			// The hint must name the METADATA fix. Phase 3 classified exactly this shape of refusal
			// as a server fault and told the caller to report it to the operator; Phase 4 fixed that
			// for TN93 and Phase 6 extends the table to 23 more codes.
			expect(body.error.hint, analysis).toMatch(/dates_file|date_pattern/);
			expect(body.error.hint, analysis).not.toMatch(/report it to the operator/);
		}
		// And `analysis: "dates"` is the one that answers instead of refusing: reporting is its job.
		const review = await api.post('/api/v1/jobs', { data: { analysis: 'dates', alignment: undatable } });
		expect(review.status()).toBe(202);
		const { id } = await review.json();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 60_000 });
		// It fails — nothing could be dated at all — but with the review on the error, so a caller
		// can see which rules were tried without a second request.
		expect(events.at(-1)!.data.status).toBe('failed');
		expect(events.at(-1)!.data.error.code).toBe('DATES_NONE');
		expect(events.at(-1)!.data.error.details.date_review.coverage.dated).toBe(0);
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('the undated-sequence gate refuses a korber dating job until the override names itself', async () => {
		test.skip(!haveDatedExamples, `${EXAMPLES} has no dated examples (engine checkout)`);
		const alignment = readFileSync(KORBER, 'utf8');
		const names = { alignment: 'korber_env_gp160.fasta' };
		// 142 of 143 names carry a date; the odd one out is the sequence called CONSENSUS. Dropping
		// it silently is what the gate exists to prevent, and an HTTP job has nobody to ask.
		const blocked = await api.post('/api/v1/jobs', { data: { analysis: 'dating', alignment, names, options: { root_taxon: 'CONSENSUS' } } });
		expect(blocked.status(), await blocked.text()).toBe(422);
		const err = (await blocked.json()).error;
		expect(err.kind).toBe('input');
		expect(err.code).toBe('DATES_UNDATED_PRESENT');
		expect(err.message).toMatch(/1 of 143/);
		expect(err.hint).toMatch(/drop_undated/);
		// `dates` reports the same gate rather than refusing for it, and says the clock is still on.
		const res = await api.post('/api/v1/jobs', { data: { analysis: 'dates', alignment, names } });
		expect(res.status()).toBe(202);
		const { id } = await res.json();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 120_000 });
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');
		const doc = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		expect(doc.ok).toBe(true);
		expect(doc.gate.ok).toBe(false);
		expect(doc.gate.blocking.map((b: any) => b.code)).toEqual(['DATES_UNDATED_PRESENT']);
		expect(doc.clock.dating_possible).toBe(true);
		expect(doc.date_review.by_rule.korber_isolate).toBe(142);
		expect(doc.date_review.rows.filter((r: any) => r.value === null)).toHaveLength(1);
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('analysis: "dating" fits the H5N1 clock, streams its phases and writes the reference\'s two files', async () => {
		test.skip(!haveDatedExamples, `${EXAMPLES} has no dated examples (engine checkout)`);
		const res = await api.post('/api/v1/jobs', {
			data: { analysis: 'dating', alignment: readFileSync(H5N1, 'utf8'), names: { alignment: 'H5N1_HA_geo.fasta' }, seed: 42 }
		});
		expect(res.status(), await res.text()).toBe(202);
		const { id } = await res.json();
		const started = Date.now();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 300_000 });
		expect(events.at(-1)!.event).toBe('done');
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');
		const phases = [...new Set(events.filter((e) => e.event === 'progress').map((e) => e.data.phase))];
		expect(phases.length).toBeGreaterThan(0);
		for (const p of phases) expect(DATING_PHASES, `unexpected dating phase ${p}`).toContain(p);
		test.info().annotations.push({ type: 'dating-run', description: `${((Date.now() - started) / 1000).toFixed(1)} s, phases ${phases.join(', ')}` });

		const doc = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		expect(doc.analysis).toBe('dating');
		expect(doc.record.taxa_count).toBe(98);
		expect(doc.taxa_summary).toHaveLength(98);
		// Model-free by default, over pairwise TN93 distances — the estimator travels with the date.
		expect(doc.record.distance_mode).toBe('tn93');
		expect(doc.honesty.model_pass).toBe(false);
		// D34: this pillar takes no tree on any surface, and the record says so rather than leaving
		// it to be inferred from an absent field.
		expect(doc.provenance.preprocessing.tree_source).toBe('tn93');
		expect(doc.provenance.preprocessing.branch_lengths_estimated).toBe(false);
		expect(doc.provenance.surface).toBe('node-server');
		// The reproduction line is an OBJECT here and on `temporal`, not the argv array the other six
		// pillars stamp: a bare command string would promise a reproducibility this build declines.
		const ref = doc.provenance.reference_command;
		expect(Array.isArray(ref)).toBe(false);
		// The three fields the contract requires, asserted as a floor rather than a closed set: this
		// builder moved into `runtime/src/dating/results.js` in phase 6's review and gained a fourth,
		// `headline`. A closed key set pinned from the e2e pinned the runtime's return shape here.
		for (const k of ['caveats', 'command', 'reproduces']) expect(Object.keys(ref)).toContain(k);
		expect(ref.command).toMatch(/^hyphaeon dating -a H5N1_HA_geo\.fasta /);
		// The dates came from the headers, read by a parser wider than the reference's.
		expect(ref.reproduces).toBe(false);
		expect(ref.caveats.join(' ')).toMatch(/-d/);

		// WHICH DATE THIS SURFACE MAY QUOTE. `record.t_mrca` is `active_model`'s and the `/time` page
		// does not always print it — `datingHeadline` refuses a fit whose `ci_mrca` is a point
		// estimate `[x, x]`, which every spline fit is upstream. The rule is the runtime's and all
		// three surfaces read it; this is the server's copy of it, on the wire.
		const head = doc.honesty.headline;
		expect(head).toBeTruthy();
		expect(head.active_model).toBe(doc.record.active_model);
		expect(typeof head.key).toBe('string');
		expect(typeof head.departed).toBe('boolean');
		expect(typeof head.quotable).toBe('boolean');
		expect(ref.headline.key).toBe(head.key);
		if (!head.departed) expect(head.t_mrca).toBe(doc.record.t_mrca);
		else expect(ref.caveats.join(' ')).toMatch(/different numbers from the same run/);
		if (!head.quotable) expect(head.refutation).toMatch(/not a finding/);
		test.info().annotations.push({
			type: 'dating-clock',
			description: `t_mrca ${doc.record.t_mrca}, mu ${doc.record.mu}; quoted ${head.key} ${head.t_mrca} (departed ${head.departed})`
		});

		// THE DOWNLOADS: the reference's own two files, with the header a browser acts on.
		const csv = await api.get(`/api/v1/jobs/${id}/result?file=csv`);
		expect(csv.status()).toBe(200);
		expect(csv.headers()['content-type']).toMatch(/text\/csv/);
		expect(csv.headers()['content-disposition']).toMatch(/attachment; filename="dating-[0-9a-f]{8}\.csv"/);
		const lines = (await csv.text()).trim().split('\n');
		expect(lines[0]).toBe('taxon,sampling_date,root_divergence,fitted_divergence,predicted_date,divergence_residual,temporal_residual,z_score,is_outlier,is_holdout');
		expect(lines).toHaveLength(99);
		const json = await api.get(`/api/v1/jobs/${id}/result?file=json`);
		expect(json.status()).toBe(200);
		expect(json.headers()['content-type']).toMatch(/application\/json/);
		const parsed = JSON.parse(await json.text());
		expect(parsed.primaeon, 'the CLI\'s shape exactly: no provenance block').toBeUndefined();
		expect(parsed.t_mrca).toBeCloseTo(doc.record.t_mrca, 6);
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('analysis: "temporal" runs H5N1 end to end: a refining null on the stream, then every section and file', async () => {
		test.skip(!haveDatedExamples, `${EXAMPLES} has no dated examples (engine checkout)`);
		const res = await api.post('/api/v1/jobs', {
			data: {
				analysis: 'temporal',
				alignment: readFileSync(H5N1, 'utf8'),
				tree: readFileSync(H5N1_TREE, 'utf8'),
				dates_file: readFileSync(H5N1_META, 'utf8'),
				names: { alignment: 'H5N1_HA_geo.fasta', tree: 'H5N1_HA.nwk', dates_file: 'H5N1_HA_metadata.csv' },
				options: { time_points: 60, n_permutations: 200 },
				seed: 42
			}
		});
		expect(res.status(), await res.text()).toBe(202);
		const submitted = await res.json();
		const id = submitted.id;
		// A temporal job publishes two live sections and no more; `analyze`'s seven are not its.
		expect(submitted.sections).toEqual({ summary: 'pending', permutations: 'pending' });

		const started = Date.now();
		const events = await readSse(`${issuer}/api/v1/jobs/${id}/events`, { timeoutMs: 300_000 });
		const elapsed = (Date.now() - started) / 1000;
		expect(events.at(-1)!.event).toBe('done');
		expect(events.at(-1)!.data.status, JSON.stringify(events.at(-1)!.data)).toBe('completed');
		const phases = [...new Set(events.filter((e) => e.event === 'progress').map((e) => e.data.phase))];
		for (const p of phases) expect(TEMPORAL_PHASES, `unexpected temporal phase ${p}`).toContain(p);

		const sections = events.filter((e) => e.event === 'section');
		const perms = sections.filter((e) => e.data.name === 'permutations');
		expect(sections.filter((e) => e.data.name === 'summary').length).toBeGreaterThan(0);
		// The null REFINES: more than one payload, at least one non-final, exactly one final, last.
		expect(perms.length).toBeGreaterThan(1);
		expect(perms.filter((e) => e.data.final === false).length).toBeGreaterThan(0);
		expect(perms.filter((e) => e.data.final).length).toBe(1);
		expect(perms.at(-1)!.data.final).toBe(true);
		const counts = perms.map((e) => e.data.payload.permutations.completed);
		for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
		expect(counts.at(-1)).toBe(200);
		// A negative finding is not a result until the null is in, and every payload says which it is.
		expect(perms[0].data.payload.calls_are_final).toBe(false);
		expect(perms[0].data.payload.uncalled_because).toMatch(/has not (finished|been drawn)/);
		expect(perms.at(-1)!.data.payload.calls_are_final).toBe(true);
		expect(perms.at(-1)!.data.payload.null_state).toBe('finished');
		expect(perms.at(-1)!.data.payload.uncalled_because).toBeNull();
		// THE PROJECTION, measured on a real connection: the runtime's own interim payload is the
		// WHOLE record, and forwarding it would not error — it would just make the server unusable.
		const biggest = Math.max(...sections.map((e) => e.bytes));
		const total = sections.reduce((a, e) => a + e.bytes, 0);
		expect(biggest).toBeLessThan(128 * 1024);
		expect(total).toBeLessThan(512 * 1024);
		test.info().annotations.push({
			type: 'temporal-stream',
			description: `${elapsed.toFixed(1)} s, ${sections.length} section events, biggest ${(biggest / 1024).toFixed(1)} KB, total ${(total / 1024).toFixed(1)} KB, ${perms.length} permutation payloads`
		});

		const view = await (await api.get(`/api/v1/jobs/${id}`)).json();
		expect(view.sections).toEqual({ summary: 'final', permutations: 'final' });

		const doc = await (await api.get(`/api/v1/jobs/${id}/result`)).json();
		expect(doc.analysis).toBe('temporal');
		expect(doc.record.stage).toBe('complete');
		expect(doc.record.permutations.completed).toBe(200);
		expect(doc.record.permutations.cancelled).toBe(false);
		// The tree was used as given, and the DATES came from the document, not the headers.
		expect(doc.provenance.preprocessing.tree_source).toBe('user');
		expect(doc.date_review.source).toBe('table');
		expect(doc.provenance.preprocessing.date_coverage.dated).toBe(98);
		expect(doc.provenance.null_state).toBe('finished');
		expect(doc.provenance.surface).toBe('node-server');
		expect(doc.honesty.calls_are_final).toBe(true);
		expect(doc.honesty.reference_command.reproduces, 'numpy MT19937 upstream against xoshiro256** here (D17)').toBe(false);
		// THE NOTES THAT MUST TRAVEL WITH THE FILES, asserted by what each one SAYS rather than by how
		// many there are. `temporalDownloadNotes` is the runtime's and the runtime is free to add to it
		// — it gained the null's exchangeability assumption in phase 6's review, which turned a pinned
		// count of 5 red without a single sentence becoming less true. A count pinned from here also
		// pinned it in the wrong repository: `runtime/test/temporal-port.test.js` owns that number.
		const notes: string[] = doc.honesty.download_notes;
		expect(notes.length).toBeGreaterThanOrEqual(5);
		const joined = notes.join(' ');
		expect(joined, 'the FORMAT/CONTENT split').toMatch(/byte for byte/);
		expect(joined, 'the duplicated curves column, upstream').toMatch(/selection_intensity` and `sweep_velocity` from the same array/);
		expect(joined, "the reference's own p_perm fill").toMatch(/temporal\.py:620-621/);
		expect(joined, 'what the date-shuffling null assumes').toMatch(/shared ancestry|exchangeab/i);
		expect(joined, 'the wave-sign convention, D28').toMatch(/sign this page fixes by convention/);

		// EVERY SECTION, each inside the MCP's own 256 KiB inline limit so the two surfaces page alike.
		for (const name of TEMPORAL_SECTIONS) {
			const s = await api.get(`/api/v1/jobs/${id}/result?section=${name}`);
			expect(s.status(), name).toBe(200);
			const body = await s.json();
			expect(body.section, name).toBe(name);
			expect(body.honesty, name).toBeTruthy();
			expect(JSON.stringify(body).length, name).toBeLessThan(256 * 1024);
		}
		const curves = await (await api.get(`/api/v1/jobs/${id}/result?section=curves&sites=1,2,3`)).json();
		expect(curves.curves.map((c: any) => c.site)).toEqual([1, 2, 3]);
		expect(curves.curves[0].prevalence).toHaveLength(curves.time_points);
		const bad = await api.get(`/api/v1/jobs/${id}/result?section=curves&sites=99999`);
		expect(bad.status()).toBe(400);

		// THE DOWNLOADS: the reference's own four files.
		for (const [name, suffix, type] of [
			['sites', '_sites_summary.csv', /text\/csv/],
			['curves', '_curves.csv', /text\/csv/],
			['waves', '_waves.csv', /text\/csv/],
			['summary', '_summary.json', /application\/json/]
		] as Array<[string, string, RegExp]>) {
			const file = await api.get(`/api/v1/jobs/${id}/result?file=${name}`);
			expect(file.status(), name).toBe(200);
			expect(file.headers()['content-type'], name).toMatch(type);
			expect(file.headers()['content-disposition'], name).toMatch(new RegExp(`filename="temporal-[0-9a-f]{8}${suffix.replace(/\./g, '\\.')}"`));
			expect((await file.text()).length, name).toBeGreaterThan(100);
		}
		const sitesCsv = await (await api.get(`/api/v1/jobs/${id}/result?file=sites`)).text();
		expect(sitesCsv.split('\n')[0]).toMatch(/^site,ref_aa,derived_aa,mutation_label,domain,/);
		expect(sitesCsv.trim().split('\n')).toHaveLength(567); // 566 codons + header
		await api.delete(`/api/v1/jobs/${id}`);
	});

	test('nothing on this surface can spawn Python: not in the sources, and not on PATH', async () => {
		// The bridge is deleted, not disabled.
		expect(existsSync(resolve(APP_DIR, 'mcp/src/bridge.js')), 'mcp/src/bridge.js still exists').toBe(false);
		// Everything this surface runs: the server, the MCP it mounts, and the runtime both call.
		const sources = ['server/src', 'server/bin', 'mcp/src', 'mcp/bin', 'runtime/src'].flatMap((d) => jsFiles(resolve(APP_DIR, d)));
		expect(sources.length).toBeGreaterThan(0);
		// PHASE 6: the date layer and the two time pillars must be INSIDE this scan, not merely not
		// caught by it. A file moved out of these directories would silently drop out of the proof,
		// and `dates` is the one analysis on this surface that reads a user's metadata document —
		// exactly the sort of input a shell-out is tempting for.
		const scanned = new Set(sources.map((f) => f.slice(APP_DIR.length + 1)));
		for (const required of ['server/src/time.js', 'mcp/src/time.js', 'runtime/src/datingNeural.js', 'runtime/src/rootToTip.js']) {
			expect(scanned.has(required), `${required} is not in the no-subprocess scan`).toBe(true);
		}
		for (const dir of ['runtime/src/dates', 'runtime/src/dating', 'runtime/src/temporal']) {
			expect([...scanned].some((f) => f.startsWith(dir + '/')), `${dir}/ is not in the no-subprocess scan`).toBe(true);
		}
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
		// And the running server, which answered every request above — the report, the tree-free
		// meme, the phenotype, and Phase 6's date review, molecular clock and temporal null — had
		// nothing on its PATH: `python`, `hyphaeon` and `hyphy` were all unreachable throughout.
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
