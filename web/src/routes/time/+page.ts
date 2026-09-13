/**
 * +page.ts (/time) — a prerendered shell that reads everything in the browser.
 *
 * WHY THIS FILE EXISTS. The same pair as `/report/[...id]`, for the same reason: the files, the
 * date layer and the stored review are all browser-side, so there is nothing to render on a server
 * and `ssr = false`. Unlike the report route this one has NO dynamic segment, so adapter-static's
 * strict build emits it from the default `*` entry and no `entries()` is needed; a stored review is
 * addressed `/time/?id=<uuid>`, exactly as a local report is `/report/local/?id=<id>`.
 *
 * WHAT THIS ROUTE FETCHES, AND WHEN. Nothing off-origin, ever. Nothing heavy either — no `*.onnx`
 * and no `ort-*.wasm` — UNTIL a reader presses the one control that says it will load a graph.
 * Phase 3's claim was "this route loads no model"; phase 4's is narrower and has to be, because the
 * two model-based estimators cannot exist without one. The page imports
 * `@veg/hyphaeon-runtime/dates` and `@veg/hyphaeon-runtime/clock` and its default estimate runs in
 * a worker whose import graph is `@veg/hyphaeon-runtime/dating` alone; the model pass lives in a
 * SEPARATE worker that nothing constructs until it is asked for. `e2e/time.spec.ts` asserts both
 * halves against the request log: the date review and the model-free estimate fetch no heavy asset,
 * and the model estimate fetches exactly one graph and the ORT runtime.
 */

import { base } from '$app/paths';
import type { PageLoad } from './$types';

export const prerender = true;
export const ssr = false;

export const load: PageLoad = ({ url }) => ({
	timeSetId: url.searchParams.get('id'),
	base
});
