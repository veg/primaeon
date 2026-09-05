/**
 * +page.ts (/results/[...id]) — the Phase 1 results route, now a redirect to /report/….
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "`/results/…` redirects to `/report/…`". The shells this
 * route emitted in Phase 1 (`/results/local/` and `/results/gallery/<name>/`) are still built so
 * that a bookmarked link keeps working on the static host; each one, once its client-side `load`
 * runs, redirects to the same id under `/report/` (api.ts `reportPath`), where lib/report/load.ts
 * reads a v1 run through the store's legacy wrapper. `entries()` is Phase 1's, unchanged.
 *
 * THE REDIRECT IS IN THE PAGE, NOT HERE. A `redirect()` thrown from this `load` made the
 * prerenderer skip the gallery shells (measured: only `/results/local/` was written, and
 * `/results/gallery/Smc6/` was a 404 on the preview), so `load` only resolves the target and
 * +page.svelte performs the `goto` on mount with `replaceState`.
 */

import { base } from '$app/paths';
import { reportPath } from '$lib/api';
import type { GalleryIndex } from '$lib/gallery/types';
import type { EntryGenerator, PageLoad } from './$types';

export const prerender = true;
export const ssr = false;

export const entries: EntryGenerator = async () => {
	const out: { id: string }[] = [{ id: 'local' }];
	try {
		// Resolved from the working directory (`npm run build` runs in web/), not from
		// `import.meta.url`: at build time this module is the bundled server chunk under
		// .svelte-kit/output/, so a URL relative to it never finds static/. Measured: with the
		// relative URL the read failed silently and the gallery shells were only emitted when
		// another page happened to link to them.
		const fsName = 'node:fs/promises';
		const { readFile } = (await import(/* @vite-ignore */ fsName)) as typeof import('node:fs/promises');
		const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
		const text = await readFile(`${cwd}/static/gallery/index.json`, 'utf8');
		const index = JSON.parse(text) as GalleryIndex;
		for (const entry of index.entries) {
			if (entry.status === 'ok' && entry.result) out.push({ id: `gallery/${entry.id}` });
		}
	} catch {
		// No index at build time: only the local shell is emitted.
	}
	return out;
};

export const load: PageLoad = ({ params, url }) => {
	const id = params.id.replace(/\/+$/, '');
	const query = url.searchParams.get('id');
	const target = id === 'local' && query ? query : id;
	// `local` with no id: nothing to redirect to; the page says so.
	return { target: target === 'local' ? null : `${base}${reportPath(target)}` };
};
