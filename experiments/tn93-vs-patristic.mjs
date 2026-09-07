/**
 * tn93-vs-patristic.mjs — does the model care where the distance matrix comes from?
 *
 * WHY THIS FILE EXISTS. Today a run uses the reader's tree when it carries branch lengths, and
 * pairwise TN93 distances only when it does not (PLAN.md D22). The question this answers is
 * whether the tree is worth keeping in the model's input at all: if TN93 distances score the same
 * sites, one code path serves every upload and nothing in the product depends on a topology.
 *
 * The model was trained on PATRISTIC distances — `build_gene_npz` (hyphaeon/training_data.py:222)
 * calls `load_alignment_and_tree(alignment, tree)` with `use_tn93` at its default False — so TN93
 * at inference is a distribution shift, and the only honest test is against the target the model
 * was trained to reproduce: real HyPhy MEME.
 *
 * GROUND TRUTH. veg/HyphAeon carries a committed MEME cache, `model_eval/_cache/meme_<sha256 of
 * the alignment, 16 hex>_<sha256 of the tree, 16>_hyphy2.5.101(MP).json`, already reduced to
 * {site index: {lrt, p_value}} (model_eval/concordance/_common.py:58-122). Three of the five
 * bundled examples are in it: bat_oas1, Smc6 and camelid. RHO and HIV1_RT are not, so they are
 * reported as agreement between the two runs only, with no claim about which is right.
 *
 * METRICS are the team's own, ported from model_eval/concordance/_common.py:144-190 so the numbers
 * here can be read beside theirs: Spearman rho over sites where BOTH the run has a variable site
 * and MEME produced a result, Cohen's kappa and F1 on the p <= 0.05 calls. Ties in the rank
 * correlation use average ranks, as scipy does.
 *
 * USAGE: node experiments/tn93-vs-patristic.mjs [--examples a,b] [--threads N] [--json out.json]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createSession, runMeme } from '@veg/hyphaeon-runtime';
import { releaseSessions } from '@veg/hyphaeon-runtime/node';
import { tn93DistanceMatrix } from '@veg/hyphaeon-js';

const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? '../HyphAeon';
const EXAMPLES = join(ENGINE, 'examples');
const CACHE = join(ENGINE, 'model_eval', '_cache');

/** The five bundled examples; `tree` is the file beside the alignment, null when it is embedded. */
const ALL = [
	{ name: 'bat_oas1', alignment: 'bat_oas1.fasta', tree: 'bat_oas1.nwk' },
	{ name: 'Smc6', alignment: 'Smc6.fasta', tree: 'Smc6.nwk' },
	{ name: 'camelid', alignment: 'camelid.fasta', tree: 'camelid.nwk' },
	{ name: 'RHO', alignment: 'RHO.fasta', tree: null },
	{ name: 'HIV1_RT', alignment: 'HIV1_RT.fasta', tree: 'HIV1_RT.nwk' }
];

function parseArgs(argv) {
	const args = { examples: null, threads: 4, json: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--examples') args.examples = argv[++i].split(',');
		else if (a === '--threads') args.threads = Number(argv[++i]);
		else if (a === '--json') args.json = argv[++i];
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

const sha16 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

/** The cached HyPhy MEME run for this alignment+tree pair, or null when it was never run. */
function memeTruth(spec) {
	if (!spec.tree || !existsSync(CACHE)) return null;
	const key = `meme_${sha16(join(EXAMPLES, spec.alignment))}_${sha16(join(EXAMPLES, spec.tree))}_`;
	const file = readdirSync(CACHE).find((f) => f.startsWith(key));
	if (!file) return null;
	const raw = JSON.parse(readFileSync(join(CACHE, file), 'utf8'));
	const sites = new Map();
	for (const [k, v] of Object.entries(raw)) sites.set(Number(k), { lrt: Number(v.lrt), p: Number(v.p_value) });
	return { file, sites };
}

/** Average ranks, scipy's tie rule. */
function ranks(xs) {
	const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
	const out = new Array(xs.length);
	for (let i = 0; i < order.length; ) {
		let j = i;
		while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
		const rank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) out[order[k][1]] = rank;
		i = j + 1;
	}
	return out;
}

function spearman(a, b) {
	if (a.length < 3) return NaN;
	const ra = ranks(a), rb = ranks(b);
	const n = a.length;
	const mean = (v) => v.reduce((s, x) => s + x, 0) / n;
	const ma = mean(ra), mb = mean(rb);
	let num = 0, da = 0, db = 0;
	for (let i = 0; i < n; i++) {
		const x = ra[i] - ma, y = rb[i] - mb;
		num += x * y; da += x * x; db += y * y;
	}
	return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db);
}

/** Cohen's kappa and F1 for two boolean vectors, `truth` first. */
function callAgreement(truth, got) {
	let tp = 0, fp = 0, fn = 0, tn = 0;
	for (let i = 0; i < truth.length; i++) {
		if (truth[i] && got[i]) tp++;
		else if (!truth[i] && got[i]) fp++;
		else if (truth[i] && !got[i]) fn++;
		else tn++;
	}
	const n = truth.length;
	const po = (tp + tn) / n;
	const pe = ((tp + fn) * (tp + fp) + (fp + tn) * (fn + tn)) / (n * n);
	const kappa = pe === 1 ? 0 : (po - pe) / (1 - pe);
	const f1 = tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
	return { kappa, f1, tp, fp, fn, tn };
}

/** One pass of the model over one example, with the distances the options ask for. */
async function pass(spec, session, options, threads) {
	const alignmentText = readFileSync(join(EXAMPLES, spec.alignment), 'utf8');
	const treeText = spec.tree ? readFileSync(join(EXAMPLES, spec.tree), 'utf8') : undefined;
	const t0 = performance.now();
	const out = await runMeme({
		alignmentText,
		treeText,
		options: { maxSpecies: Infinity, ...options },
		session: session.backbone,
		surface: 'node-server'
	});
	return { out, wallMs: performance.now() - t0, threads };
}

function siteArrays(out) {
	const lrt = [], p = [], variable = [];
	for (const s of out.sites) {
		lrt.push(Number(s.hyphaeon_lrt ?? s.lrt ?? 0));
		p.push(Number(s.p_value ?? 1));
		variable.push(Boolean(s.isVariable ?? !s.is_invariable));
	}
	return { lrt, p, variable };
}

/** The team's concordance metrics against a cached MEME run. */
function versusMeme(arrays, truth) {
	const idx = [];
	for (let i = 0; i < arrays.lrt.length; i++) if (arrays.variable[i] && truth.sites.has(i)) idx.push(i);
	const a = idx.map((i) => arrays.lrt[i]);
	const m = idx.map((i) => truth.sites.get(i).lrt);
	const aSig = idx.map((i) => arrays.p[i] <= 0.05);
	const mSig = idx.map((i) => truth.sites.get(i).p <= 0.05);
	const agree = callAgreement(mSig, aSig);
	return {
		sites_compared: idx.length,
		spearman_rho: spearman(a, m),
		cohen_kappa_005: agree.kappa,
		f1_005: agree.f1,
		hyphaeon_significant_005: aSig.filter(Boolean).length,
		meme_significant_005: mSig.filter(Boolean).length,
		true_positive: agree.tp,
		false_positive: agree.fp,
		false_negative: agree.fn
	};
}

/** How far apart the two runs are from each other, on the sites both call variable. */
function versusEachOther(A, B) {
	const idx = [];
	for (let i = 0; i < A.lrt.length; i++) if (A.variable[i] && B.variable[i]) idx.push(i);
	const a = idx.map((i) => A.lrt[i]);
	const b = idx.map((i) => B.lrt[i]);
	let maxAbs = 0, maxRel = 0;
	for (let i = 0; i < a.length; i++) {
		maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
		maxRel = Math.max(maxRel, Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i])));
	}
	const aSig = idx.map((i) => A.p[i] <= 0.05);
	const bSig = idx.map((i) => B.p[i] <= 0.05);
	const agree = callAgreement(bSig, aSig);
	return {
		sites_compared: idx.length,
		spearman_rho: spearman(a, b),
		max_abs_delta_lrt: maxAbs,
		max_relative_delta_lrt: maxRel,
		calls_005_patristic: bSig.filter(Boolean).length,
		calls_005_tn93: aSig.filter(Boolean).length,
		calls_gained_by_tn93: agree.fp,
		calls_lost_by_tn93: agree.fn,
		call_kappa_005: agree.kappa,
		variable_sites_only_patristic: A.variable.filter((v, i) => !v && B.variable[i]).length,
		variable_sites_only_tn93: A.variable.filter((v, i) => v && !B.variable[i]).length
	};
}

const args = parseArgs(process.argv);
const specs = ALL.filter((s) => !args.examples || args.examples.includes(s.name));
const session = await createSession({
	modelsBase: join(ENGINE, 'models'),
	runtime: 'node',
	variant: 'general',
	threads: args.threads
});

const report = { engine: ENGINE, threads: args.threads, examples: [] };
for (const spec of specs) {
	const truth = memeTruth(spec);
	const patristic = await pass(spec, session, {}, args.threads);
	const tn93 = await pass(spec, session, { useTn93: true }, args.threads);
	const A = siteArrays(tn93.out), B = siteArrays(patristic.out);

	// The distance matrix on its own, to size the cost of computing TN93 in JavaScript.
	const seqs = tn93.out.provenance?.preprocessing?.taxa_used ?? null;
	const row = {
		example: spec.name,
		taxa: patristic.out.summary?.taxa ?? patristic.out.provenance?.preprocessing?.taxa_used ?? seqs,
		codons: patristic.out.sites.length,
		tree_source_default: patristic.out.provenance?.preprocessing?.tree_source ?? null,
		tree_source_forced: tn93.out.provenance?.preprocessing?.tree_source ?? null,
		wall_ms: { patristic: Math.round(patristic.wallMs), tn93: Math.round(tn93.wallMs) },
		agreement: versusEachOther(A, B),
		meme: truth
			? { cache: truth.file, patristic: versusMeme(B, truth), tn93: versusMeme(A, truth) }
			: null
	};
	report.examples.push(row);
	console.log(
		`${spec.name.padEnd(9)} ${String(row.taxa).padStart(4)} taxa x ${String(row.codons).padStart(4)} codons  ` +
			`default=${row.tree_source_default} forced=${row.tree_source_forced}  rho=${row.agreement.spearman_rho.toFixed(6)}  maxRel=${row.agreement.max_relative_delta_lrt.toExponential(2)}  ` +
			`calls ${row.agreement.calls_005_patristic}->${row.agreement.calls_005_tn93}` +
			(row.meme
				? `  vs MEME rho ${row.meme.patristic.spearman_rho.toFixed(3)} -> ${row.meme.tn93.spearman_rho.toFixed(3)}` +
					`, kappa ${row.meme.patristic.cohen_kappa_005.toFixed(3)} -> ${row.meme.tn93.cohen_kappa_005.toFixed(3)}`
				: '  (no MEME cache)')
	);
}

if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
await releaseSessions();
