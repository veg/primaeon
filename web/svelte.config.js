/**
 * svelte.config.js — SvelteKit configuration for the HyphAeon web app.
 *
 * WHY THIS FILE EXISTS. The app is a fully prerendered static site (PLAN.md §4): every route is
 * written to `build/` as HTML at build time and served by any static host, with no server-side
 * rendering at request time. Pattern taken from `datamonkey-metrics/svelte.config.js`, which is
 * deployed the same way (rsync to silverback), with one change:
 *
 *   paths.base COMES FROM THE ENVIRONMENT. datamonkey-metrics hard-codes `/datamonkey-metrics`
 *   because it only ever lives under that prefix. This app has two deploy shapes on the table
 *   (PLAN.md D1): its own origin (`hyphaeon.hyphy.org`, base '') and a sub-path under an existing
 *   host (`data.hyphy.org/web/hyphaeon`, base '/web/hyphaeon'). One build script serves both by
 *   setting HYPHAEON_BASE; the default is the empty string so a local `npm run build && npm run
 *   preview` works with nothing set. Every internal link and asset URL in `src/` must go through
 *   `$app/paths`' `base` for this to hold — a bare `/analyze` link breaks under a sub-path.
 *
 * `prerender` and `trailingSlash` live in `src/routes/+layout.ts`, where SvelteKit reads them.
 */

import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Must start with '/' and not end with one when set; '' means "served from the origin root". */
const base = (process.env.HYPHAEON_BASE ?? '').replace(/\/+$/, '');

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// No SPA fallback: every route is prerendered. A route that cannot be prerendered is a
			// build error, which is what we want — it means a page would 404 on the static host.
			fallback: undefined,
			precompress: false,
			strict: true
		}),
		paths: {
			base
		}
	}
};

export default config;
