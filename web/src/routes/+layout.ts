/**
 * +layout.ts — prerender every route and normalise URLs to a trailing slash.
 *
 * WHY THIS FILE EXISTS. Same two lines as `datamonkey-metrics/src/routes/+layout.js`, for the same
 * reason: the site is served from a plain directory by a static host (PLAN.md §3.2, rsync to
 * silverback). `prerender = true` makes adapter-static write every route as HTML at build time.
 * `trailingSlash = 'always'` makes each route a directory with an `index.html`
 * (`/analyze/index.html` rather than `/analyze.html`), which is what Apache and `vite preview` both
 * resolve without rewrite rules; without it, `/analyze` would 404 on the host while working in dev.
 */

export const prerender = true;
export const trailingSlash = 'always';
