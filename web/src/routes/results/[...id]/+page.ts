/**
 * +page.ts (/results/[...id]) — a prerendered shell that loads its record in the browser.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 gives one route to two sources: `/results/<local-id>/` for
 * a run persisted in IndexedDB, and the gallery's prebaked records. Both are read in the
 * browser (results/load.ts), so `ssr = false`: there is no record to render at build time and
 * IndexedDB does not exist there.
 *
 * WHY A REST PARAMETER AND `entries`. The site is fully prerendered by adapter-static in strict
 * mode (svelte.config.js: no SPA fallback, a non-prerenderable route is a build error). A
 * dynamic route therefore has to say which pages it has. `entries()` lists `gallery/<name>` for
 * every gallery example whose prebaked run completed (`status: 'ok'` with a `result` file in
 * static/gallery/index.json, the same file the gallery page reads) plus `local`, so the build emits `/results/gallery/<name>/` and
 * `/results/local/`. A browser run is opened as `/results/<id>/` in dev (SvelteKit renders any
 * id on the fly) and as `/results/local/?id=<id>` on the static host, where nothing else can be
 * served for an id nobody knew at build time; +page.svelte reads both forms. Any other path on
 * the static host is a 404 by construction, not a blank page.
 */

import { base } from '$app/paths';
import type { GalleryIndex } from '$lib/gallery/types';
import type { EntryGenerator, PageLoad } from './$types';

export const prerender = true;
export const ssr = false;

export const entries: EntryGenerator = async () => {
	const out: { id: string }[] = [{ id: 'local' }];
	try {
		// `entries` runs only at build time, but this universal module is also bundled for the
		// browser, and a literal `import('node:fs/promises')` makes Vite externalise the module and
		// warn on every build. Holding the specifier in a variable keeps the bundler from following
		// it (the same trick runtime/src/manifest.js and createSession.js use).
		const fsName = 'node:fs/promises';
		const { readFile } = (await import(/* @vite-ignore */ fsName)) as typeof import('node:fs/promises');
		const text = await readFile(new URL('../../../../static/gallery/index.json', import.meta.url), 'utf8');
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
		recordId: id === 'local' && query ? query : id,
		base
	};
};
