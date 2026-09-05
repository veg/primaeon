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
 *   meme      `hyphaeon meme -a <fasta> -t <nwk> --cpu -o ...`   -> runMeme with the CLI's defaults:
 *             NO taxon cap (cli.py:1025 `--max-species` default None -> `maxSpecies: Infinity`),
 *             duplicates pruned, no filter, no attribution.
 *   busted    `hyphaeon busted -a <fasta> -t <nwk> --cpu -o ...` -> runBusted with `--max-species`
 *             512 (cli.py:1108) and the busted head from the manifest.
 *   epistasis `hyphaeon epistasis -a <fasta> -t <nwk> --cpu --n-permutations B --seed S -o ...`
 *             -> runEpistasis with `cmd_epistasis`'s thresholds (min_sim 0.30, min_shared 2,
 *             max_fdr 0.05, min_lrt 1.0, min_cesi 2.0, min_clique_size 3, min_coherence 0.50)
 *             and the sector-site DMS the CLI runs unless `--no-dms`. It takes the REFERENCE's
 *             all-sites attention loop rather than the report's shared meme pass: the two give
 *             the same edges and sectors (runtime/test/epistasis.test.js), but a parity file
 *             should be produced the way the reference produces it.
 *   dms       `hyphaeon dms -a <fasta> -t <nwk> --cpu -o ...` -> runDms over every codon with no
 *             work budget. `parity.py` has no `dms` analysis (its ANALYSES are meme, busted,
 *             epistasis), so the file is written into the layout for a future comparator and for
 *             a by-hand diff against `hyphaeon dms -o`; only Smc6 is run by default, because
 *             19 x L forward passes on the larger examples is minutes, not seconds.
 *
 * B AND THE STATISTICAL CLASS. `--permutations` defaults to 10,000 — `parity.py`'s own DEFAULT_B,
 * which is both what it passes to `hyphaeon epistasis --n-permutations` and the B its bound
 * `|dp| <= 3*sqrt(p(1-p)/B)` is computed with. Writing this surface at B = 1,000 against a
 * reference at B = 10,000 would fail that bound by construction (PHASE2A.md measures +/-0.03 of
 * Monte Carlo error per side at B = 1,000), so a smaller B here must be matched by
 * `parity.py --n-permutations`.
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
 *   node scripts/parity-node.mjs [--examples Smc6,bat_oas1] [--analyses meme,busted,epistasis]
 *        [--variant general] [--threads N] [--engine ../HyphAeon] [--out <engine>/parity/node]
 *        [--no-hyphy] [--busted-examples Smc6,HIV1_RT] [--dms-examples Smc6]
 *        [--permutations 10000] [--seed 42]
 * Then, from the engine repository:
 *   python scripts/parity.py --examples Smc6,bat_oas1,RHO --surfaces python,node
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { availableParallelism } from 'node:os';

import { createSession } from '../src/createSession.js';
import { runMeme, prepareRun } from '../src/pipeline.js';
import { runBusted } from '../src/busted.js';
import { runEpistasis } from '../src/epistasis.js';
import { runDms } from '../src/dms.js';
import { memeJsonText, bustedJsonText } from '../src/results.js';
import { epistasisJsonText, dmsJsonText } from '../src/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { examples: 'all', analyses: 'meme,busted,epistasis', variant: 'general', threads: null, engine: null, out: null, hyphy: true, bustedExamples: 'Smc6,HIV1_RT', dmsExamples: 'Smc6', permutations: 10000, seed: 42 };
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
		else if (a === '--dms-examples') args.dmsExamples = next();
		else if (a === '--permutations' || a === '--n-permutations') args.permutations = Number(next());
		else if (a === '--seed') args.seed = Number(next());
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
	const dmsExamples = new Set(args.dmsExamples === 'all' ? wanted : args.dmsExamples.split(',').map((s) => s.trim()).filter(Boolean));
	const threads = args.threads ?? Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
	mkdirSync(outDir, { recursive: true });

	const t0 = Date.now();
	const s = await createSession({ modelsBase, variant: args.variant, threads, bustedHead: analyses.includes('busted') });
	console.log(`[parity-node] ${s.variant.name} ${s.backbone.sha256.slice(0, 12)} (${s.backbone.bytes} bytes), head ${s.head ? s.head.sha256.slice(0, 12) : 'none'}, ${threads} thread(s), library ${s.libraryVersion}, ${Date.now() - t0} ms`);
	const hyphy = args.hyphy ? await loadHyPhy() : { hook: null, note: 'HyPhy disabled (--no-hyphy)' };
	console.log(`[parity-node] ${hyphy.note}`);

	const summary = { generated_at: new Date().toISOString(), surface: 'node', variant: s.variant.name, artifact_sha256: s.backbone.sha256, threads, hyphy: hyphy.note, n_permutations: args.permutations, seed: args.seed, runs: [] };
	let failed = 0;
	for (const ex of wanted) {
		const spec = examples[ex];
		const alignmentText = readFileSync(spec.alignment, 'utf8');
		const treeText = spec.tree ? readFileSync(spec.tree, 'utf8') : null;
		for (const analysis of analyses) {
			if (analysis === 'busted' && !bustedExamples.has(ex)) continue;
			if (analysis === 'dms' && !dmsExamples.has(ex)) continue;
			if (!['meme', 'busted', 'epistasis', 'dms'].includes(analysis)) {
				console.log(`[parity-node] ${ex} ${analysis}: not implemented on this surface`);
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
				let pp;
				if (analysis === 'meme') {
					result = await runMeme({ ...common, options: { ...common.options, maxSpecies: Infinity } });
					text = memeJsonText(result);
					pp = result.provenance.preprocessing;
				} else if (analysis === 'busted') {
					result = await runBusted({ ...common, head: s.head, options: { ...common.options, maxSpecies: 512, gene: ex } });
					text = bustedJsonText(result);
					pp = result.provenance.preprocessing;
				} else {
					// epistasis / dms: `run_epistatic_analysis` and `run_digital_dms_analysis` both call
					// `load_alignment_and_tree(prune_duplicates=True)` with NO max_species
					// (epistasis.py:660-663, 742-745), so the front half runs once with no cap.
					const prep = await prepareRun({
						alignmentText,
						treeText,
						options: { ...common.options, maxSpecies: Infinity },
						progress,
						defaultMaxSpecies: null
					});
					pp = {
						taxa_in_alignment: prep.preprocessing.taxa_in_alignment,
						taxa_used: prep.loaded.N,
						branch_lengths_missing: prep.preprocessing.branch_lengths_missing,
						branch_lengths_estimated: prep.branchLengthsEstimated,
						tree_source: prep.treeSource
					};
					const inputs = { alignment: `examples/${ex}.fasta`, tree: spec.tree ? `examples/${ex}.nwk` : null };
					if (analysis === 'epistasis') {
						result = await runEpistasis({
							loaded: prep.loaded,
							session: s.backbone,
							options: { nPermutations: args.permutations, seed: args.seed, dms: true },
							inputs,
							progress
						});
						text = epistasisJsonText(result);
						run.notes.push(`B = ${args.permutations}, seed ${args.seed}; p_perm and the null moments are statistical (PARITY.md)`);
						run.edges = result.edges.length;
						run.sectors = result.sectors.length;
					} else {
						result = await runDms({
							loaded: prep.loaded,
							session: s.backbone,
							options: { workBudget: Infinity },
							inputs,
							progress
						});
						text = dmsJsonText(result);
						run.notes.push('parity.py has no dms comparator yet; written for the layout');
						run.mutants = result.total_mutations;
					}
				}
				if (pp.branch_lengths_missing && !pp.branch_lengths_estimated) {
					run.notes.push('tree without branch lengths and no HyPhy: dataset.py defaults applied; the reference used HyPhy HKY85, so LRTs are expected to differ');
				}
				if (pp.branch_lengths_estimated) run.notes.push(`branch lengths estimated by ${pp.tree_source} (HyPhy WASM 2.5.98 vs the reference's native 2.5.65)`);
				if (pp.taxa_used > 500 && analysis !== 'busted') run.notes.push(`N = ${pp.taxa_used} > 500: the reference uses Lanczos MDS (dataset.py:360-381), the library runs dense`);
				if (analysis === 'busted' && s.head) run.notes.push('neural head fields come from busted_head.onnx (one seeded draw); the reference draws them unseeded, so they are expected to differ');
				writeFileSync(outPath, text);
				run.seconds = (Date.now() - tStart) / 1000;
				run.taxa = pp.taxa_used;
				run.codons = analysis === 'busted' ? result.record.sites : result.codon_count;
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
