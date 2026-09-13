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
 * The first row is why `auto` sizes the job: below the loader's break-even the compiled engine's
 * fixed load costs more than the whole matrix, so the port is the right answer there and is chosen
 * deliberately rather than by accident. The diagnosis itself is IDENTICAL either way — same warning
 * codes at the same severities, byte-identical summary, checked on all five bundled examples —
 * which is the only reason swapping the engine is allowed to be a quiet change.
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
	it('records the engine that ran, and the same diagnosis comes out either way', async () => {
		// camelid is 212 taxa: comfortably above the loader's measured break-even, so `auto` must
		// take the compiled engine here rather than the port.
		const alignment = example('camelid.fasta');

		const auto = await diagnoseUpload({ alignmentText: alignment, treeText: null });
		expect(auto.tn93_engine).toBe('wasm');

		const ported = await diagnoseUpload({ alignmentText: alignment, treeText: null, tn93Engine: 'js' });
		expect(ported.tn93_engine).toBe('js');

		// A label that can be right by accident proves nothing, so the NUMBERS are compared too:
		// the two engines' matrices are identical, so the whole diagnosis must be.
		const codes = (d: { warnings: Array<{ code: string; severity: string }> }) =>
			d.warnings.map((w) => `${w.code}:${w.severity}`).sort();
		expect(codes(auto)).toEqual(codes(ported));
		expect(JSON.stringify(auto.summary)).toBe(JSON.stringify(ported.summary));
		expect(auto.ok).toBe(ported.ok);

		// A run WITH usable branch lengths computes no matrix, so there is no engine to name. Null,
		// never a default label: a default would be a claim about work that never happened.
		const withTree = await diagnoseUpload({
			alignmentText: example('bat_oas1.fasta'),
			treeText: example('bat_oas1.nwk')
		});
		expect(withTree.tn93_engine).toBeNull();
	}, 120000);
});

describe('the prep worker asks for it, and the page hands it the URLs', () => {
	it('prep.worker.ts calls diagnoseUpload with the engine and reports what ran', () => {
		const src = read('lib/workers/prep.worker.ts');
		expect(src).toMatch(/import \{ diagnoseUpload \} from '@veg\/hyphaeon-runtime'/);
		expect(src).toMatch(/await diagnoseUpload\(\{/);
		// With no URLs there is nothing to load, so the port is asked for BY NAME rather than left to
		// `auto` to try, fail, and attach a fallback reason that says only "the page served no files".
		expect(src).toMatch(/tn93Engine: wasm \? 'auto' : 'js'/);
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
		expect(distanceProvenance(treeFree('js'))).toContain('JavaScript port');
		// An engine the run never reported is not silently promoted to the compiled one.
		expect(distanceProvenance(treeFree(null))).toContain('JavaScript port');
		expect(distanceProvenance({ tree_source: 'user', tree_free: null, tn93_engine: null })).toContain('branch lengths');
		// Nothing sent, nothing claimed.
		expect(distanceProvenance(null)).toBeNull();
	});
});
