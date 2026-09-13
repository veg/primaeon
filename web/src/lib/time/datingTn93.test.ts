/**
 * datingTn93.test.ts — the /time route's two dating workers compute their distances with veg/tn93's
 * own compiled code, and the record says which engine ran.
 *
 * WHY THIS FILE EXISTS. Root-to-tip divergence in this pillar IS a TN93 distance, and until
 * 2026-09-13 both dating workers called `runDating` with no distance options at all: the library
 * fell to its JavaScript port while `ProvenancePanel.svelte` stood ready to name the compiled
 * engine. Every suite passed throughout, because a missing hook is not an error — it is a slower
 * run with the same numbers. The whole product's `web/static/tn93/` files were being served to the
 * analyze and temporal workers and to nobody else on this route.
 *
 * TWO KINDS OF ASSERTION, because neither alone would have caught it:
 *
 *   1. BEHAVIOURAL, on the real chain. `runDating` with the resolved options must actually reach
 *      the provider — checked with a counting wrapper the library cannot ignore — and must record
 *      `wasm`; with nothing handed in it must record `js`. A label that can be right by accident
 *      proves nothing, so both directions are asserted.
 *   2. WIRING, on the worker sources. The behaviour above lives in the runtime; what this workspace
 *      owns is whether its two workers ASK for it and whether the page hands them the URLs. Vitest
 *      here runs in Node and cannot start a module worker with `new Worker`, and `e2e/time.spec.ts`
 *      watches for `*.onnx` and `ort-*.wasm` rather than for a 250 KB tn93 build, so the source
 *      scan is the mechanism — the same one `runtime/test/no-hyphy.test.js` uses to keep HyPhy
 *      deleted. It is deliberately specific: it names the symbol, the request field and the shape.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { runDating } from '@veg/hyphaeon-runtime/dating';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import { resolveTn93Options } from '@veg/hyphaeon-runtime/tn93-wasm';

import { divergenceSentence, tn93EngineName } from './dating';
import type { DatingResult } from './types';
import { available, example } from './fixtures';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(HERE, '..', '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe.skipIf(!available())('the dating run reaches the compiled TN93', () => {
	it('calls the hook, records `wasm`, and records `js` when there is nothing to call', async () => {
		// The web workspace resolves `@veg/hyphaeon-runtime/tn93-wasm` — the subpath the workers
		// import. Under Node the loader finds runtime/vendor/tn93/ and verifies its sha256; in the
		// browser the workers hand it the three URLs under `static/tn93/`.
		const resolved = await resolveTn93Options({ shape: 'cross' });
		expect(resolved.tn93Engine).toBe('wasm');

		let calls = 0;
		const inner = (resolved.tn93Options as { pairwiseDistances: (...a: unknown[]) => ArrayLike<number> }).pairwiseDistances;
		const counted = {
			...resolved.tn93Options,
			pairwiseDistances: (...args: unknown[]) => {
				calls += 1;
				return inner(...args);
			}
		};

		const text = example('H5N1_HA_geo.fasta');
		const ingest = ingestDates({ taxa: taxaForDates(text), headerOf: null, timeUnits: 'years' });
		const dates = { rows: ingest.rows.map((r) => ({ taxon: r.taxon, value: r.value })) };

		const engineOf = (record: Record<string, unknown>) => (record.primaeon as Record<string, unknown>).tn93_engine;

		const compiled = runDating({ alignmentText: text, dates, tn93Options: counted, tn93Engine: 'wasm' });
		expect(compiled.ok).toBe(true);
		expect(calls, 'the library never reached the provider').toBeGreaterThan(0);
		expect(engineOf(compiled.record)).toBe('wasm');

		const ported = runDating({ alignmentText: text, dates });
		expect(engineOf(ported.record)).toBe('js');

		// And the numbers are the same either way, which is the only reason swapping the engine is
		// allowed to be a quiet change at all.
		let worst = 0;
		for (let i = 0; i < ported.divergences.length; i++) {
			worst = Math.max(worst, Math.abs(ported.divergences[i] - compiled.divergences[i]));
		}
		expect(worst).toBe(0);
		expect(compiled.record.t_mrca).toBe(ported.record.t_mrca);

		// And the page says which engine it was, from the record rather than from the request. A
		// sentence that named the compiled engine on a run that fell back would be the same defect
		// one layer up.
		const view = (run: typeof compiled) => ({ record: run.record }) as unknown as DatingResult;
		expect(tn93EngineName(view(compiled))).toMatch(/compiled code/);
		expect(tn93EngineName(view(ported))).toMatch(/JavaScript port/);
		expect(divergenceSentence(view(compiled), 'years')).toContain("veg/tn93's compiled code");
		expect(divergenceSentence(view(ported), 'years')).toContain('JavaScript port');
	}, 120000);
});

describe('both dating workers ask for it, and the page hands them the URLs', () => {
	it('dating.worker.ts resolves the RECTANGULAR hook and passes it to runDating', () => {
		const src = read('lib/workers/dating.worker.ts');
		expect(src).toMatch(/import \{ resolveTn93Options \} from '@veg\/hyphaeon-runtime\/tn93-wasm'/);
		// `'cross'` is not decoration: `computeTreeFreeDivergences` calls the rectangular hook, and
		// the square provider would answer it with row 0 of a square matrix and no error.
		expect(src).toMatch(/shape: 'cross'/);
		expect(src).toMatch(/tn93Options: tn93\.tn93Options/);
		expect(src).toMatch(/tn93Engine: tn93\.tn93Engine/);
		// A fallback must reach the record rather than being swallowed.
		expect(src).toMatch(/tn93EngineFallbackReason/);
	});

	it('datingModel.worker.ts resolves BOTH shapes: the pass builds a square matrix of its own', () => {
		const src = read('lib/workers/datingModel.worker.ts');
		expect(src).toMatch(/import \{ resolveTn93Options \} from '@veg\/hyphaeon-runtime\/tn93-wasm'/);
		expect(src).toMatch(/shape: 'cross'/);
		expect(src).toMatch(/tn93Options: tn93Cross\.tn93Options/);
		// The forward pass's own TN93 matrix is a MODEL INPUT (datingNeural.js note 4), so the graph
		// reads different numbers depending on which engine built it — it gets the URLs too.
		expect(src).toMatch(/tn93Wasm: wasmSources/);
		expect(src).toMatch(/tn93Engine: wasmSources \? 'auto' : 'js'/);
	});

	it('/time sets tn93Base on both requests, and the protocol declares it', () => {
		const page = read('routes/time/+page.svelte');
		const requests = page.match(/const request: Dating(Model)?Request = \{[\s\S]*?\n\t\t\};/g) ?? [];
		expect(requests, 'both dating requests must be found to be checked').toHaveLength(2);
		for (const req of requests) expect(req).toMatch(/tn93Base: absolute\('\/tn93\/'\)/);
		expect(read('lib/workers/protocol.ts')).toMatch(/interface DatingRequest \{[\s\S]*?\ttn93Base\?: string;[\s\S]*?\n\}/);
	});
});
