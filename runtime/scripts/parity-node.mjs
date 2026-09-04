#!/usr/bin/env node
/**
 * parity-node.mjs — the `node` surface of ../HyphAeon/scripts/parity.py.
 *
 * WHY THIS FILE EXISTS. PARITY.md: "`parity.py` never produces a non-Python surface ... the app
 * repository's runner writes the files into the layout below and `parity.py` compares." This is
 * that runner for the surface `node`: `@veg/hyphaeon-js` + `runtime/` under Node with
 * onnxruntime-node, on every `examples/*.fasta` (with `examples/<name>.nwk` when it exists; RHO
 * carries its tree embedded and is run without one, exactly as parity.py does), writing
 * `parity/node/<example>.<analysis>.json` in the Python CLI's own schema through the library's
 * writers (results.js), plus a `provenance` key parity.py ignores.
 *
 * WHAT IT RUNS, mirroring parity.py's commands:
 *   meme    `hyphaeon meme -a <fasta> -t <nwk> --cpu -o ...`   -> runMeme with the CLI's defaults:
 *           NO taxon cap (cli.py:1025 `--max-species` default None -> `maxSpecies: Infinity`),
 *           duplicates pruned, no filter, no attribution.
 *   busted  `hyphaeon busted -a <fasta> -t <nwk> --cpu -o ...` -> runBusted with `--max-species`
 *           512 (cli.py:1108) and the busted head from the manifest.
 *
 * BRANCH LENGTHS. examples/camelid.nwk and examples/HIV1_RT.nwk have no branch lengths; the
 * reference shells out to HyPhy (dataset.py:224-287, HKY85). When runtime/src/hyphy is present
 * and can run under Node, its `estimateBranchLengths` is handed to the pipeline as the
 * `estimateTree` hook (HyPhy 2.5.98 WASM against the reference's native 2.5.65 — the optimiser
 * may differ at the last digits, which propagates into every distance). Without it the run takes
 * the reference's "HyPhy not found" branch (dataset.py:609-614 defaults) and the file is still
 * written, with a note, so parity.py reports the expected mismatch rather than a missing surface.
 *
 * Usage:
 *   node scripts/parity-node.mjs [--examples Smc6,bat_oas1] [--analyses meme,busted]
 *        [--variant general] [--threads N] [--engine ../HyphAeon] [--out <engine>/parity/node]
 *        [--no-hyphy] [--busted-examples Smc6,HIV1_RT]
 * Then, from the engine repository:
 *   python scripts/parity.py --examples Smc6,bat_oas1,RHO --surfaces python,node
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { availableParallelism } from 'node:os';

import { createSession } from '../src/createSession.js';
import { runMeme } from '../src/pipeline.js';
import { runBusted } from '../src/busted.js';
import { memeJsonText, bustedJsonText } from '../src/results.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { examples: 'all', analyses: 'meme,busted', variant: 'general', threads: null, engine: null, out: null, hyphy: true, bustedExamples: 'Smc6,HIV1_RT' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--examples') args.examples = next();
		else if (a === '--analyses') args.analyses = next();
		else if (a === '--variant') args.variant = next();
		else if (a === '--threads') args.threads = Number(next());
		else if (a === '--engine') args.engine = next();
		else if (a === '--out') args.out = next();
		else if (a === '--no-hyphy') args.hyphy = false;
		else if (a === '--busted-examples') args.bustedExamples = next();
		else if (a === '--help' || a === '-h') {
			console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
			process.exit(0);
		} else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

async function loadHyPhy() {
	const modulePath = join(HERE, '..', 'src', 'hyphy', 'index.js');
	if (!existsSync(modulePath)) return { hook: null, note: 'runtime/src/hyphy not present' };
	try {
		const mod = await import(modulePath);
		if (typeof mod.createHyPhy !== 'function') return { hook: null, note: 'runtime/src/hyphy has no createHyPhy' };
		const hyphy = await mod.createHyPhy();
		const version = await hyphy.hyphyVersion();
		const hook = async (alignmentText, treeText) => {
			const r = await hyphy.estimateBranchLengths(alignmentText, treeText);
			return { treeText: r.result, source: 'hyphy-hky85' };
		};
		return { hook, note: `branch lengths via ${version.result}` };
	} catch (err) {
		return { hook: null, note: `runtime/src/hyphy failed to load under Node: ${err?.message ?? err}` };
	}
}

function discoverExamples(examplesDir) {
	const out = {};
	for (const f of readdirSync(examplesDir).sort()) {
		if (!f.endsWith('.fasta')) continue;
		const name = basename(f, '.fasta');
		const nwk = join(examplesDir, `${name}.nwk`);
		out[name] = { alignment: join(examplesDir, f), tree: existsSync(nwk) ? nwk : null };
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const engine = resolve(args.engine ?? join(HERE, '..', '..', '..', 'HyphAeon'));
	const outDir = resolve(args.out ?? join(engine, 'parity', 'node'));
	const modelsBase = join(engine, 'models');
	const examples = discoverExamples(join(engine, 'examples'));
	const wanted = args.examples === 'all' ? Object.keys(examples) : args.examples.split(',').map((s) => s.trim()).filter(Boolean);
	for (const ex of wanted) if (!examples[ex]) throw new Error(`unknown example ${ex} (have ${Object.keys(examples).join(', ')})`);
	const analyses = args.analyses.split(',').map((s) => s.trim()).filter(Boolean);
	const bustedExamples = new Set(args.bustedExamples === 'all' ? wanted : args.bustedExamples.split(',').map((s) => s.trim()));
	const threads = args.threads ?? Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
	mkdirSync(outDir, { recursive: true });

	const t0 = Date.now();
	const s = await createSession({ modelsBase, variant: args.variant, threads, bustedHead: analyses.includes('busted') });
	console.log(`[parity-node] ${s.variant.name} ${s.backbone.sha256.slice(0, 12)} (${s.backbone.bytes} bytes), head ${s.head ? s.head.sha256.slice(0, 12) : 'none'}, ${threads} thread(s), library ${s.libraryVersion}, ${Date.now() - t0} ms`);
	const hyphy = args.hyphy ? await loadHyPhy() : { hook: null, note: 'HyPhy disabled (--no-hyphy)' };
	console.log(`[parity-node] ${hyphy.note}`);

	const summary = { generated_at: new Date().toISOString(), surface: 'node', variant: s.variant.name, artifact_sha256: s.backbone.sha256, threads, hyphy: hyphy.note, runs: [] };
	let failed = 0;
	for (const ex of wanted) {
		const spec = examples[ex];
		const alignmentText = readFileSync(spec.alignment, 'utf8');
		const treeText = spec.tree ? readFileSync(spec.tree, 'utf8') : null;
		for (const analysis of analyses) {
			if (analysis === 'busted' && !bustedExamples.has(ex)) continue;
			if (analysis !== 'meme' && analysis !== 'busted') {
				console.log(`[parity-node] ${ex} ${analysis}: not implemented on this surface (Phase 2)`);
				continue;
			}
			const outPath = join(outDir, `${ex}.${analysis}.json`);
			const run = { example: ex, analysis, path: outPath, status: 'ok', seconds: null, notes: [] };
			const tStart = Date.now();
			// One line per finished phase (the output is usually piped; no carriage-return games).
			const progress = (phase, done, total, message) => {
				if (done === total && total > 0) console.log(`[parity-node] ${ex} ${analysis}: ${phase} ${message ?? ''}`);
			};
			try {
				const common = {
					alignmentText,
					treeText,
					session: s.backbone,
					surface: 'node-server',
					progress,
					options: {
						alignmentName: `${ex}.fasta`,
						treeName: spec.tree ? `${ex}.nwk` : undefined,
						estimateTree: hyphy.hook ?? undefined,
						diagnose: false
					}
				};
				let text;
				let result;
				if (analysis === 'meme') {
					result = await runMeme({ ...common, options: { ...common.options, maxSpecies: Infinity } });
					text = memeJsonText(result);
				} else {
					result = await runBusted({ ...common, head: s.head, options: { ...common.options, maxSpecies: 512, gene: ex } });
					text = bustedJsonText(result);
				}
				const pp = result.provenance.preprocessing;
				if (pp.branch_lengths_missing && !pp.branch_lengths_estimated) {
					run.notes.push('tree without branch lengths and no HyPhy: dataset.py defaults applied; the reference used HyPhy HKY85, so LRTs are expected to differ');
				}
				if (pp.branch_lengths_estimated) run.notes.push(`branch lengths estimated by ${pp.tree_source} (HyPhy WASM 2.5.98 vs the reference's native 2.5.65)`);
				if (pp.taxa_used > 500 && analysis === 'meme') run.notes.push(`N = ${pp.taxa_used} > 500: the reference uses Lanczos MDS (dataset.py:360-381), the library runs dense`);
				if (analysis === 'busted' && s.head) run.notes.push('neural head fields come from busted_head.onnx (one seeded draw); the reference draws them unseeded, so they are expected to differ');
				writeFileSync(outPath, text);
				run.seconds = (Date.now() - tStart) / 1000;
				run.taxa = pp.taxa_used;
				run.codons = analysis === 'meme' ? result.codon_count : result.record.sites;
				console.log(`[parity-node] ${ex.padEnd(10)} ${analysis.padEnd(8)} ok (${run.seconds.toFixed(1)} s, ${run.taxa} taxa, ${run.codons} codons)${run.notes.length ? ' -- ' + run.notes.join('; ') : ''}`);
			} catch (err) {
				run.status = 'failed';
				run.error = err?.stack ?? String(err);
				run.seconds = (Date.now() - tStart) / 1000;
				failed++;
				console.log(`[parity-node] ${ex.padEnd(10)} ${analysis.padEnd(8)} FAILED: ${err?.message ?? err}`);
			}
			summary.runs.push(run);
		}
	}
	writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
	console.log(`[parity-node] wrote ${summary.runs.length} file(s) to ${outDir}; ${failed} failed. Next: cd ${engine} && python scripts/parity.py --no-run --surfaces python,node --examples ${wanted.join(',')}`);
	// Release the native sessions BEFORE the process ends: with intra-op threads > 1,
	// onnxruntime-node 1.23.2 aborts at exit ("mutex lock failed: Invalid argument" from libc++abi)
	// when a session is still alive on the thread pool, and `process.exit()` skips the release.
	await Promise.all([s.backbone, s.head].filter(Boolean).map((h) => h.session.release?.()));
	process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
