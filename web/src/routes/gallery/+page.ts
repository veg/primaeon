/**
 * +page.ts (/gallery) — load the gallery index at prerender time.
 *
 * WHY THIS FILE EXISTS. The index lives in static/gallery/index.json so it is served as a plain
 * file too (the MCP resource will read the same document). At build time SvelteKit's `fetch`
 * resolves the static asset locally and inlines the response into the prerendered page, so the
 * browser does not request the JSON again on hydration.
 */

import { base } from '$app/paths';
import type { GalleryIndex } from '$lib/gallery/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const response = await fetch(`${base}/gallery/index.json`);
	if (!response.ok) {
		throw new Error(`gallery index: ${response.status} ${response.statusText}`);
	}
	const index = (await response.json()) as GalleryIndex;
	return { index };
};
