/**
 * copy-assets.mjs — put every runtime asset the web app serves into web/static/ before a build or
 * a dev session.
 *
 * WHY THIS FILE EXISTS. The site must be self-contained: no CDN, no other origin (PLAN.md D8, §4.4;
 * the e2e asserts it). Three kinds of asset are therefore served by the site itself, and none of
 * them belongs in git:
 *
 *   1. ONNX RUNTIME WASM  (node_modules/onnxruntime-web/dist → static/ort/)
 *      Mirrors datamonkey3/scripts/copy-ort-wasm.mjs. onnxruntime-web does not bundle its WASM
 *      binary; with no `wasmPaths` it resolves to a jsDelivr URL, which fails offline and reports
 *      "no available backend found" as if the model were broken. Only the plain SIMD+threads build
 *      and its loader are copied (13 MB); the JSEP/asyncify/JSPI variants are 15–27 MB each and
 *      unused. Copying at build time, rather than committing, keeps the served binary equal to the
 *      installed package.
 *
 *   2. MODELS  (<engine>/models/*.onnx + manifest.json → static/models/)
 *      The ONNX graphs and the weights manifest come from veg/HyphAeon (PLAN.md §3.3), produced
 *      by `hyphaeon export-onnx`. Absent until upstream PR 1 lands, so a missing directory is a
 *      warning, never a failure: the Phase 0 site has no run path that needs them.
 *
 *   3. _headers  (written here → static/_headers)
 *      The site's own security headers for a static host that honours a `_headers` file, kept in
 *      step with deploy/apache-hyphaeon.conf: Cross-Origin-Opener-Policy: same-origin and
 *      Cross-Origin-Embedder-Policy: require-corp so SharedArrayBuffer, and therefore
 *      multi-threaded ORT, is available (D13); a same-origin Content-Security-Policy in which
 *      'wasm-unsafe-eval' is onnxruntime-web's and 'unsafe-inline' in script-src is SvelteKit's
 *      inline start script on every prerendered page (adapter-static, no `kit.csp`). Phases 0–2
 *      copied datamonkey3/static/_headers verbatim, which grants https://unpkg.com, `connect-src
 *      https:` and the bare 'unsafe-eval' the HyPhy glue needed in a module worker; PLAN.md D22
 *      removed the only consumer of 'unsafe-eval' (PHASE2.md gap 12) and this app has never loaded
 *      from another origin (the e2e asserts every request is same-origin), so the file is now
 *      authored here rather than inherited. DATAMONKEY3_DIR is no longer read.
 *
 * THERE IS NO FOURTH KIND ANY MORE. Phase 2 copied a vendored HyPhy WebAssembly build into
 * `static/wasm/hyphy/<version>/`, because the app fitted HKY85 branch lengths and built NJ trees
 * with it when an upload's tree was unusable. PLAN.md D22 (resolved 2026-09-05) replaced that with
 * the reference's own tree-free path: no tree, or a tree without usable branch lengths, now means
 * pairwise TN93 distances straight into the MDS (`@veg/hyphaeon-js`), and the display topology is
 * a neighbour-joining tree computed in JavaScript from those same distances
 * (`runtime/src/nj.js`). HyPhy is gone from the product — `runtime/src/hyphy/`,
 * `runtime/vendor/hyphy/` and the `./hyphy` export of `@veg/hyphaeon-runtime` were deleted in
 * Phase 3 — so nothing is copied to `web/static/wasm/` and HYPHAEON_HYPHY_WASM_DIR is no longer
 * read. A `web/static/wasm/` directory left over from a Phase 2 build is stale: it is gitignored
 * output of a step that no longer exists, and deleting it is safe.
 *
 * Sources are resolved relative to this repository (`../HyphAeon`) and can be overridden with
 * HYPHAEON_ENGINE_DIR. onnxruntime-web is located through
 * Node's resolver from web/, so it is found whether npm hoisted it to the workspace root or not.
 *
 * Wired as web's `predev` and `prebuild`. Runs in well under a second when nothing has changed.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');
const staticDir = join(web, 'static');

const engineDir = process.env.HYPHAEON_ENGINE_DIR ?? resolve(repo, '..', 'HyphAeon');

const log = (tag, msg) => console.log(`[copy-assets] ${tag}: ${msg}`);
const warn = (tag, msg) => console.warn(`[copy-assets] ${tag}: WARNING ${msg}`);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Copy one file, creating the destination directory. Returns bytes copied. */
function copy(src, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	return statSync(src).size;
}

// 1. ONNX Runtime WASM ---------------------------------------------------------------------------

/** The plain SIMD+threads build and its loader. Nothing else is used at runtime. */
const ORT_ASSETS = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

/**
 * Locate onnxruntime-web's package directory from web/. Its `exports` map does not expose
 * `./package.json`, so `require.resolve('onnxruntime-web/package.json')` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED; instead resolve the entry point and walk up to the directory
 * whose package.json names the package. Falls back to the two places npm puts it (web/ or the
 * workspace root) when resolution itself fails.
 */
function findOrtPackage() {
	try {
		const require = createRequire(join(web, 'package.json'));
		let dir = dirname(require.resolve('onnxruntime-web'));
		for (let i = 0; i < 6; i += 1) {
			const pkg = join(dir, 'package.json');
			if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'onnxruntime-web') {
				return dir;
			}
			dir = dirname(dir);
		}
	} catch {
		// fall through to the fixed candidates
	}
	for (const candidate of [
		join(web, 'node_modules', 'onnxruntime-web'),
		join(repo, 'node_modules', 'onnxruntime-web')
	]) {
		if (existsSync(join(candidate, 'package.json'))) return candidate;
	}
	return null;
}

{
	const ortPackage = findOrtPackage();
	const ortDist = ortPackage ? join(ortPackage, 'dist') : null;

	if (!ortDist || !existsSync(ortDist)) {
		// Not fatal, as in DM3: a build without the dependency should say so rather than emit a
		// site whose inference path fails at the last moment.
		warn('ort', 'onnxruntime-web is not installed; skipping. Inference will not run.');
	} else {
		let total = 0;
		for (const name of ORT_ASSETS) {
			const src = join(ortDist, name);
			if (!existsSync(src)) {
				console.error(
					`[copy-assets] ort: expected ${name} in onnxruntime-web/dist — has the package layout changed?`
				);
				process.exit(1);
			}
			total += copy(src, join(staticDir, 'ort', name));
		}
		log('ort', `copied ${ORT_ASSETS.length} files (${mb(total)}) to web/static/ort/`);
	}
}

// 2. Models and manifest ------------------------------------------------------------------------

{
	const modelsDir = join(engineDir, 'models');
	if (!existsSync(modelsDir)) {
		warn('models', `${modelsDir} does not exist; no ONNX graphs or manifest copied.`);
	} else {
		const names = readdirSync(modelsDir).filter(
			(n) => n.endsWith('.onnx') || n === 'manifest.json'
		);
		if (names.length === 0) {
			warn('models', `${modelsDir} has no *.onnx or manifest.json; nothing copied.`);
		} else {
			let total = 0;
			for (const name of names) total += copy(join(modelsDir, name), join(staticDir, 'models', name));
			log('models', `copied ${names.length} files (${mb(total)}) to web/static/models/`);
			if (!names.includes('manifest.json')) {
				warn('models', 'manifest.json is missing; the runtime refuses to score without it.');
			}
		}
	}
}

// 2b. tn93 WebAssembly ---------------------------------------------------------------------------
//
// runtime/vendor/tn93 holds veg/tn93's published WebAssembly build (MANIFEST.json records the
// release and the sha256 of each file). The browser cannot require() the CommonJS glue, and the
// page's CSP has no 'unsafe-eval' to evaluate it by hand, so the glue is rewritten here as an ES
// module — the file verbatim plus one export line — which a worker loads with a plain dynamic
// import from this origin. The .wasm is copied unchanged and its bytes are verified at load
// against the manifest copied beside it, exactly as the ONNX graphs are.
{
	const vendor = join(repo, 'runtime', 'vendor', 'tn93');
	const manifestPath = join(vendor, 'MANIFEST.json');
	if (!existsSync(manifestPath)) {
		warn('tn93', `${vendor} has no MANIFEST.json; skipping. Tree-free runs will use the library's JavaScript.`);
	} else {
		const dest = join(staticDir, 'tn93');
		mkdirSync(dest, { recursive: true });
		let total = copy(join(vendor, 'tn93.wasm'), join(dest, 'tn93.wasm'));
		total += copy(manifestPath, join(dest, 'MANIFEST.json'));
		const glue = readFileSync(join(vendor, 'tn93.cjs'), 'utf8');
		const esm = `${glue}\nexport default create_tn93;\n`;
		writeFileSync(join(dest, 'tn93.mjs'), esm);
		total += Buffer.byteLength(esm);
		log('tn93', `copied the v${JSON.parse(readFileSync(manifestPath, 'utf8')).version.replace(/^v/, '')} build (${mb(total)}) to web/static/tn93/`);
	}
}

// 3. _headers -----------------------------------------------------------------------------------

/**
 * The catch-all block. See the file header for why each line is here; the CSP mirrors
 * deploy/apache-hyphaeon.conf and must change together with it.
 */
const HEADERS = [
	'/*',
	'  X-Frame-Options: DENY',
	'  X-Content-Type-Options: nosniff',
	'  Referrer-Policy: strict-origin-when-cross-origin',
	'  Permissions-Policy: camera=(), microphone=(), geolocation=()',
	"  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
	'  Strict-Transport-Security: max-age=31536000; includeSubDomains',
	'  Cross-Origin-Opener-Policy: same-origin',
	'  Cross-Origin-Embedder-Policy: require-corp',
	'',
	'/assets/*',
	'  Cache-Control: public, max-age=31536000, immutable',
	'',
	'/models/*',
	'  Cache-Control: public, max-age=31536000, immutable',
	'  Cross-Origin-Resource-Policy: same-origin',
	'',
	'/ort/*',
	'  Cache-Control: public, max-age=31536000, immutable',
	'  Cross-Origin-Resource-Policy: same-origin'
];

{
	const headersDest = join(staticDir, '_headers');
	mkdirSync(staticDir, { recursive: true });
	writeFileSync(headersDest, HEADERS.join('\n') + '\n');
	log('headers', `wrote web/static/${basename(headersDest)} (COOP/COEP + same-origin CSP)`);
}

