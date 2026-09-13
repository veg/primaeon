/**
 * prepTn93.test.ts — the "Before you run" diagnosis computes its TN93 with the engine the RUN uses,
 * and the temporal run says which engine computed its distances.
 *
 * WHY THIS FILE EXISTS. Two halves of one defect, found by review after the dating pillar's half of
 * it was fixed.
 *
 *   1. `diagnose()` does a full model-level load of its own (diagnostics.js:654), so a tree-free
 *      check computes the WHOLE N x N TN93 matrix — on every upload, on a debounce, before anything
 *      else runs — and the library's signature has no `tn93Options`, so it computed that matrix with
 *      the JavaScript port while the analyze worker two clicks later used veg/tn93's compiled build.
 *      Nothing failed. The check was simply slower than the run it was checking.
 *   2. `prepareRun` sets `preprocessing.tn93_engine` for the temporal pillar too, but
 *      `temporal.worker.ts` returned only the record, so `/time` chose an engine and threw the fact
 *      away: its provenance could describe the request and never the run.
 *
 * MEASURED, per process, median of 7, this machine, alignment only and no tree, through
 * `diagnoseUpload` with each engine forced:
 *
 *                              taxa   pairs    compiled       port
 *     bat_oas1.fasta             18     153       44 ms      14 ms   <- compiled LOSES
 *     korber_env_gp160.fasta    143  10,153      200 ms     373 ms
 *     HIV1_RT.fasta             475 113,050      981 ms   2,776 ms
 *
 * The first row is the price of one engine, and it is paid: the JavaScript port was deleted from
 * @veg/hyphaeon-js on 2026-09-13 (one implementation, veg/tn93, rather than two kept in step by
 * hand), so there is nothing to size the job against and nothing to fall back to. The comparison in
 * the third column is what the port measured on the day it went.
 *
 * WHAT THAT MADE OF THIS FILE. The "same diagnosis either way" case had two engines to compare and
 * now has one; in its place is the property the deletion created — a page that cannot load the
 * engine gets a `refuse`-level TN93_ENGINE_UNAVAILABLE row in the panel rather than a diagnosis, a
 * throw, or a quietly different set of numbers.
 *
 * TWO KINDS OF ASSERTION, as `datingTn93.test.ts` uses for the same reason: behavioural on the real
 * chain (the engine is reached and reported, both directions), and a source scan of the workers and
 * the page, because vitest here runs in Node and cannot start a module worker.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { diagnoseUpload } from '@veg/hyphaeon-runtime';

import { distanceProvenance } from '$lib/time/temporal';
import { available, example } from '$lib/time/fixtures';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(HERE, '..', '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe.skipIf(!available())('the upload diagnosis reaches the compiled TN93', () => {
	it('records the engine that ran, and produces a real diagnosis with it', async () => {
		// camelid is 212 taxa and has no usable branch lengths, so this is the tree-free path and the
		// compiled engine is the only thing that can compute its matrix.
		const alignment = example('camelid.fasta');

		const auto = await diagnoseUpload({ alignmentText: alignment, treeText: null });
		expect(auto.tn93_engine).toBe('wasm');
		// A label proves nothing on its own: the model-level half of the diagnosis must be there,
		// which is what the matrix is computed for.
		expect(auto.summary.taxaUsed).toBeGreaterThan(0);
		expect(auto.warnings.some((w) => w.code === 'TREE_FREE_TN93')).toBe(true);
		expect(auto.tn93_engine_error).toBeNull();

		// A run WITH usable branch lengths computes no matrix, so there is no engine to name. Null,
		// never a default label: a default would be a claim about work that never happened.
		const withTree = await diagnoseUpload({
			alignmentText: example('bat_oas1.fasta'),
			treeText: example('bat_oas1.nwk')
		});
		expect(withTree.tn93_engine).toBeNull();
	}, 120000);

	it('reports a page that served no TN93 files as a refusal in the panel, not as a throw', async () => {
		// THE CASE THE BROWSER CAN ACTUALLY MEET. In Node the vendored build is on disk; in a browser
		// it is three files fetched from `static/tn93/` and sha256-verified, so a failed fetch or a
		// mismatched hash means a tree-free upload cannot be measured at all. `diagnose()` is the
		// function a surface runs to find out what is wrong with an upload, so it must not be the
		// thing that explodes: the refusal arrives as a diagnostic the panel already knows how to
		// render, at `refuse` severity, carrying a hint.
		const out = await diagnoseUpload({
			alignmentText: example('camelid.fasta'),
			treeText: null,
			tn93Wasm: { glueUrl: 'https://example.invalid/tn93.mjs', wasmUrl: 'https://example.invalid/tn93.wasm', manifestUrl: 'https://example.invalid/MANIFEST.json' }
		});
		expect(out.ok).toBe(false);
		expect(out.tn93_engine).toBeNull();
		const row = out.warnings.find((w) => w.code === 'TN93_ENGINE_UNAVAILABLE');
		expect(row).toBeTruthy();
		expect(row!.severity).toBe('refuse');
		expect((row!.data as { hint?: string }).hint).toBeTruthy();
		// And NOT dressed up as a property of the reader's alignment.
		expect(out.warnings.some((w) => w.code === 'TN93_SATURATED_PAIRS')).toBe(false);
	}, 120000);
});

describe('the prep worker asks for it, and the page hands it the URLs', () => {
	it('prep.worker.ts calls diagnoseUpload with the engine and reports what ran', () => {
		const src = read('lib/workers/prep.worker.ts');
		expect(src).toMatch(/import \{ diagnoseUpload \} from '@veg\/hyphaeon-runtime'/);
		expect(src).toMatch(/await diagnoseUpload\(\{/);
		// THERE IS NO PORT TO ASK FOR. The URLs are handed over when the page served them and omitted
		// when it did not; only a TREE-FREE diagnosis loads the engine, so an upload with branch
		// lengths is unaffected and one without gets the loader's own refusal as a diagnostic row.
		expect(src).not.toMatch(/'js'/);
		expect(src).toMatch(/tn93Wasm: wasm/);
		// The run's answer, not the request's.
		expect(src).toMatch(/tn93_engine/);
		// And the library's own `diagnose` is no longer imported here: two ways to diagnose an upload
		// is how one of them goes quietly back to the port.
		expect(src).not.toMatch(/import \{[^}]*\bdiagnose\b[^}]*\} from '@veg\/hyphaeon-js'/);
	});

	it('/analyze hands the prep worker the tn93 URLs', () => {
		expect(read('routes/analyze/+page.svelte')).toMatch(/tn93Base: new URL\(`\$\{base\}\/tn93\/`/);
		expect(read('lib/workers/protocol.ts')).toMatch(/interface PrepRequest \{[\s\S]*?\ttn93Base\?: string;[\s\S]*?\n\}/);
	});

	it('temporal.worker.ts returns the prepare block, and the protocol declares it', () => {
		const src = read('lib/workers/temporal.worker.ts');
		expect(src).toMatch(/prepared\.preprocessing/);
		// On BOTH returns: a refusal is still a run that prepared an alignment, and which engine
		// computed its distances is part of why it refused.
		expect(src.match(/\bpreprocessing,/g)?.length ?? 0).toBe(2);
		expect(read('lib/workers/protocol.ts')).toMatch(/preprocessing: TemporalPreprocessing \| null;/);
	});

	it('/time holds the block and the section prints it', () => {
		expect(read('routes/time/+page.svelte')).toMatch(/temporalPreprocessing = response\.preprocessing \?\? null/);
		expect(read('routes/time/+page.svelte')).toMatch(/preprocessing=\{temporalPreprocessing\}/);
		expect(read('lib/time/TemporalSection.svelte')).toMatch(/distanceProvenance\(preprocessing\)/);
	});
});

describe('distanceProvenance names the engine from the run, never from the request', () => {
	it('says which TN93 computed the distances, or that the tree did', () => {
		const treeFree = (engine: string | null) => ({ tree_source: 'tn93', tree_free: { reason: 'no_tree' }, tn93_engine: engine });
		expect(distanceProvenance(treeFree('wasm'))).toContain("veg/tn93's compiled code");
		expect(distanceProvenance(treeFree('custom'))).toContain('handed');
		// An engine the run never reported is not silently promoted to the compiled one — and it is
		// not described as the JavaScript port either, which no longer exists to have run.
		expect(distanceProvenance(treeFree(null))).toContain('does not name');
		expect(distanceProvenance(treeFree(null))).not.toContain('JavaScript port');
		// A record written BEFORE the port was deleted is answered honestly rather than relabelled:
		// that run really did use it.
		expect(distanceProvenance(treeFree('js'))).toContain('JavaScript port');
		expect(distanceProvenance({ tree_source: 'user', tree_free: null, tn93_engine: null })).toContain('branch lengths');
		// Nothing sent, nothing claimed.
		expect(distanceProvenance(null)).toBeNull();
	});
});
