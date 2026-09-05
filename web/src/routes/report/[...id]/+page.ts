/**
 * +page.ts (/report/[...id]) — a prerendered shell that loads its report in the browser.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: `/report/[local-id]` and `/report/gallery/[name]` are one
 * route over several sources, all read in the browser (lib/report/load.ts: the live job, IndexedDB,
 * a static gallery file, or the server's job API), so `ssr = false`.
 *
 * WHY A REST PARAMETER AND `entries`. As for /results in Phase 1: the site is prerendered by
 * adapter-static in strict mode, so this route must name its pages. `entries()` lists
 * `gallery/<name>` for every example the gallery index marks `ok`, plus `local`, so the build emits
 * `/report/gallery/<name>/` and `/report/local/`; a browser run or a server job is opened as
 * `/report/local/?id=<id>` (api.ts `reportPath`), which the static host can serve for an id nobody
 * knew at build time. In dev, `/report/<id>/` also renders.
 */

import { base } from '$app/paths';
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
	return {
		reportId: id === 'local' && query ? query : id,
		base
	};
};
