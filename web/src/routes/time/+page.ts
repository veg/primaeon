/**
 * +page.ts (/time) — a prerendered shell that reads everything in the browser.
 *
 * WHY THIS FILE EXISTS. The same pair as `/report/[...id]`, for the same reason: the files, the
 * date layer and the stored review are all browser-side, so there is nothing to render on a server
 * and `ssr = false`. Unlike the report route this one has NO dynamic segment, so adapter-static's
 * strict build emits it from the default `*` entry and no `entries()` is needed; a stored review is
 * addressed `/time/?id=<uuid>`, exactly as a local report is `/report/local/?id=<id>`.
 *
 * WHAT THIS ROUTE MUST NOT FETCH. No `*.onnx`, no `ort-*.wasm`, nothing off-origin. It reviews
 * dates and never loads a model, and that is enforced by the import boundary rather than by
 * intention: the page imports `@veg/hyphaeon-runtime/dates` and `@veg/hyphaeon-runtime/clock`, the
 * two subpaths that reach no ONNX session, and `e2e/time.spec.ts` asserts the request log.
 */

import { base } from '$app/paths';
import type { PageLoad } from './$types';

export const prerender = true;
export const ssr = false;

export const load: PageLoad = ({ url }) => ({
	timeSetId: url.searchParams.get('id'),
	base
});
