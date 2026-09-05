/**
 * +page.ts (/gallery) — a retired route: redirect to the landing page.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 (D21): "`/analyze` and `/gallery` from Phase 1 fold into `/`
 * and `/report/gallery/…`". The five example cards this route showed are now the example chips on
 * `/`, each opening its prebaked report at `/report/gallery/<id>/`. The route is kept, as a
 * redirect, so a Phase 1 link or bookmark to `/gallery/` still lands somewhere useful.
 *
 * HOW THE REDIRECT IS SERVED. The site is fully prerendered by adapter-static (svelte.config.js,
 * strict, no fallback), so there is no server to answer 308. SvelteKit's prerenderer turns a
 * `redirect()` thrown in `load` into `gallery/index.html` carrying
 * `<meta http-equiv="refresh" content="0;url=…">` (kit/src/core/postbuild/prerender.js), which a
 * static host serves like any other page; in dev and on client-side navigation the same `load`
 * redirects immediately. The target goes through `base` so it holds under a sub-path deploy.
 */

import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	redirect(308, `${base}/`);
};
