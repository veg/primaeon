/**
 * vite.config.ts — Vite configuration for the HyphAeon web app (dev server, build, preview,
 * vitest).
 *
 * WHY THIS FILE EXISTS. Beyond registering the SvelteKit plugin, this file is where the two
 * cross-origin isolation headers are set for `vite dev` and `vite preview`:
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * WHY THE HEADERS. onnxruntime-web's multi-threaded WASM backend needs SharedArrayBuffer, and
 * browsers only expose SharedArrayBuffer on cross-origin-isolated pages, i.e. pages served with
 * both headers. DataMonkey could not set them on its host and so ran AxoMEME on a single thread;
 * PLAN.md §4.4 and D13 make them a requirement of this app's origin. In production they come from
 * the host (the `_headers` file that `scripts/copy-assets.mjs` writes into `static/`, or the
 * Apache vhost in `deploy/`); `_headers` is a Cloudflare/Netlify convention that Vite ignores, so
 * without this file dev and preview would silently run single-threaded and the e2e header
 * assertion would pass in production and fail locally, or the reverse. Setting them here keeps the
 * three environments alike.
 *
 * WHY A PLUGIN AND NOT `server.headers` / `preview.headers`. Measured, not assumed: with
 * `preview.headers` set, `vite preview` of this SvelteKit build returned neither header (the e2e
 * failed with `Received: undefined`). Vite applies those options inside its own static-file
 * middleware, but SvelteKit's `configurePreviewServer` hook serves the prerendered pages and
 * assets through its own `sirv` instance, registered earlier, which ends the response before
 * Vite's middleware runs. The plugin below is `enforce: 'pre'` so its hooks run before
 * SvelteKit's and its middleware sits at the front of the stack for both `vite dev` and
 * `vite preview`; it sets the headers and passes the request on.
 *
 * The cost of `require-corp` is that every sub-resource must be same-origin or carry a CORP header.
 * This app loads nothing cross-origin by design (PLAN.md D8: no CDNs; the e2e asserts it), so the
 * cost is zero here and the header is a guard rather than a constraint.
 *
 * vitest is configured in the same file (`test` block) so there is one config to read; it only runs
 * the unit tests under `src/`, never the Playwright specs in `../e2e/`.
 */

import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { defineConfig } from 'vitest/config';

/** See the header: required for SharedArrayBuffer and therefore for multi-threaded ORT. */
const CROSS_ORIGIN_ISOLATION: Record<string, string> = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp'
};

function crossOriginIsolation(): Plugin {
	const install = (server: ViteDevServer | PreviewServer) => {
		server.middlewares.use((_req, res, next) => {
			for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION)) res.setHeader(name, value);
			next();
		});
	};
	return {
		name: 'hyphaeon:cross-origin-isolation',
		enforce: 'pre',
		configureServer: install,
		configurePreviewServer: install
	};
}

export default defineConfig({
	plugins: [crossOriginIsolation(), sveltekit()],
	// The analysis workers (src/lib/workers/*.worker.ts) are module workers whose imports contain
	// dynamic `import()`s — the runtime's `import('onnxruntime-web/wasm')` inside loadSession(),
	// the prescreen's `?raw` model read — so Rollup must code-split the worker bundle, which the
	// default 'iife' worker format refuses ("UMD and IIFE output formats are not supported for
	// code-splitting builds"). 'es' emits the worker as an ES module with chunks under
	// _app/immutable/workers/, which `new Worker(url, { type: 'module' })` loads.
	worker: { format: 'es' },
	test: {
		include: ['src/**/*.{test,spec}.ts'],
		environment: 'node'
	}
});
