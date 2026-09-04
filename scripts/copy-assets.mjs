/**
 * copy-assets.mjs — put every runtime asset the web app serves into web/static/ before a build or
 * a dev session.
 *
 * WHY THIS FILE EXISTS. The site must be self-contained: no CDN, no other origin (PLAN.md D8, §4.4;
 * the e2e asserts it). Four kinds of asset are therefore served by the site itself, and none of
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
 *   3. HYPHY WASM  (runtime/vendor/hyphy/<version>/ → static/wasm/hyphy/<version>/)
 *      HyPhy compiled to WASM, used for HKY85 branch-length fitting, NJ trees and format
 *      conversion (PLAN.md D5/D6). Vendored into runtime/vendor/hyphy/ (DataMonkey 3's build,
 *      provenance and hashes in runtime/vendor/hyphy/PROVENANCE.md) so the site is built from
 *      this repository alone; runtime/src/hyphy/index.js loads the same files under Node and
 *      names the version directory (HYPHY_WASM_VERSION), which is why the layout is preserved.
 *      The DataMonkey checkout is no longer consulted for it. Missing directory: warning.
 *
 *   4. _headers  (datamonkey3/static/_headers → static/_headers, plus COOP/COEP)
 *      DataMonkey's security headers, with Cross-Origin-Opener-Policy: same-origin and
 *      Cross-Origin-Embedder-Policy: require-corp appended so SharedArrayBuffer, and therefore
 *      multi-threaded ORT, is available (D13). DataMonkey's own file is copied verbatim rather
 *      than rewritten so a diff against it stays meaningful; note that it still allows
 *      https://unpkg.com in script-src/style-src and `connect-src https:`, which this app does not
 *      need. Tightening that is a deliberate change to make later, not a side effect of a copy.
 *
 * Sources are resolved relative to this repository (`../HyphAeon`, `../datamonkey3`,
 * `runtime/vendor/hyphy`) and can be overridden with HYPHAEON_ENGINE_DIR, DATAMONKEY3_DIR and
 * HYPHAEON_HYPHY_WASM_DIR. onnxruntime-web is located through
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
const dm3Dir = process.env.DATAMONKEY3_DIR ?? resolve(repo, '..', 'datamonkey3');
const hyphyWasmDir = process.env.HYPHAEON_HYPHY_WASM_DIR ?? join(repo, 'runtime', 'vendor', 'hyphy');

const log = (tag, msg) => console.log(`[copy-assets] ${tag}: ${msg}`);
const warn = (tag, msg) => console.warn(`[copy-assets] ${tag}: WARNING ${msg}`);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Copy one file, creating the destination directory. Returns bytes copied. */
function copy(src, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	return statSync(src).size;
}

/** Copy every regular file under `srcDir` (recursively) into `destDir`, preserving layout. */
function copyTree(srcDir, destDir) {
	let files = 0;
	let bytes = 0;
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		const src = join(srcDir, entry.name);
		const dest = join(destDir, entry.name);
		if (entry.isDirectory()) {
			const sub = copyTree(src, dest);
			files += sub.files;
			bytes += sub.bytes;
		} else if (entry.isFile()) {
			bytes += copy(src, dest);
			files += 1;
		}
	}
	return { files, bytes };
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

// 3. HyPhy WASM ---------------------------------------------------------------------------------

{
	const hyphySrc = hyphyWasmDir;
	if (!existsSync(hyphySrc)) {
		warn('hyphy', `${hyphySrc} does not exist; HyPhy WASM not copied (tree estimation will not run).`);
	} else {
		// Only the <version>/ directories: PROVENANCE.md and anything else at the top level is
		// documentation for the repository, not an asset to serve.
		const versions = readdirSync(hyphySrc, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
		let files = 0;
		let bytes = 0;
		for (const version of versions) {
			const sub = copyTree(join(hyphySrc, version), join(staticDir, 'wasm', 'hyphy', version));
			files += sub.files;
			bytes += sub.bytes;
		}
		if (versions.length === 0) {
			warn('hyphy', `${hyphySrc} has no <version>/ directory; HyPhy WASM not copied.`);
		} else {
			log('hyphy', `copied ${files} files (${mb(bytes)}) [${versions.join(', ')}] to web/static/wasm/hyphy/`);
		}
	}
}

// 4. _headers -----------------------------------------------------------------------------------

/** Appended to the catch-all block. See the file header for why. */
const CROSS_ORIGIN_ISOLATION = [
	'  Cross-Origin-Opener-Policy: same-origin',
	'  Cross-Origin-Embedder-Policy: require-corp'
];

{
	const headersSrc = join(dm3Dir, 'static', '_headers');
	const headersDest = join(staticDir, '_headers');
	let text;
	if (existsSync(headersSrc)) {
		text = readFileSync(headersSrc, 'utf8');
	} else {
		warn('headers', `${headersSrc} does not exist; writing a minimal _headers with COOP/COEP only.`);
		text = '/*\n  X-Content-Type-Options: nosniff\n';
	}

	// Insert after the `/*` block's existing header lines, before the next path block (or EOF).
	const lines = text.replace(/\s+$/, '').split('\n');
	const start = lines.findIndex((l) => l.trim() === '/*');
	if (start === -1) {
		lines.push('/*', ...CROSS_ORIGIN_ISOLATION);
	} else {
		let end = start + 1;
		while (end < lines.length && lines[end].startsWith('  ')) end += 1;
		const missing = CROSS_ORIGIN_ISOLATION.filter(
			(h) => !lines.slice(start + 1, end).some((l) => l.trim() === h.trim())
		);
		lines.splice(end, 0, ...missing);
	}
	mkdirSync(staticDir, { recursive: true });
	writeFileSync(headersDest, lines.join('\n') + '\n');
	log('headers', `wrote web/static/${basename(headersDest)} (COOP/COEP added)`);
}
