/**
 * record.ts — turn what the runtime's `runMeme` returns into the `MemeRecord` the results page
 * reads. Runs inside the inference worker, so the library is at hand and nothing heavy crosses
 * to the main thread twice.
 *
 * WHY THIS FILE EXISTS. The results page consumes one shape (lib/results/types.ts `MemeRecord`:
 * the CLI's site columns, the provenance block, the alignment the model saw, the tree it used).
 * The runtime's result is being rewritten in Phase 1b (loadAlignmentAndTree, p/q, --filter,
 * --attribute) and its Phase 0 form carried DM3's site rows (`lrt`, `isVariable`, `refCodon`,
 * `zScore`, `percentile`, `call`) with no p/q. This is the ONE place that reads the runtime's
 * shape, so both forms are accepted:
 *
 *   - rows with `hyphaeon_lrt` are already the CLI's (Appendix B) and pass through;
 *   - rows with `lrt` are DM3's and are renamed; p and q are then computed with the library's
 *     `memeSitePq` — the exact float32 cast order `cmd_meme` writes (cli.py:99-100): p =
 *     float32(pvals_from_lrt_meme(lrt)), q = float32(BH(p)) on the float32 p. Invariable sites
 *     carry lrt 0 on every surface (inference.py:170-186 never scores them), so their p is 2/3
 *     and their q follows BH, exactly as the reference file has them.
 *
 * THE ALIGNMENT BLOCK. The site tree and the entropy overlays need the selected taxa in the
 * order the model saw them. When the runtime reports them (`result.alignment` or
 * `result.taxa`) they are used; otherwise the order is reconstructed the way the library builds
 * it — `matchTaxa(treeTaxa(tree), names)` gives the tree-terminal order (dataset.py:616-643) and
 * `provenance.preprocessing.dropped_taxa` removes what duplicate pruning and Faith's PD dropped.
 * That reconstruction is exact for the taxa the runtime kept, and it is labelled `reconstructed`
 * in the provenance so a reader knows which path produced it.
 */

import { extractTree, matchTaxa, memeSitePq, parseAlignmentSequences, treeTaxa } from '@veg/hyphaeon-js';
import type { RuntimeMemeResult } from '@veg/hyphaeon-runtime';
import type { MemeRecord, RunOptions, TreeSource } from '$lib/api';
import type { AlignmentBlock, AttributionRecord, FilterMetrics, MaskedPatch, SiteRecord } from '$lib/results/types';
import { embeddedNewick } from './newick';

/**
 * The pre-filter per-site arrays the runtime keeps under `arrays.raw` when a patch was masked
 * (cli.py:214-218 replaces the raw arrays with the cleaned ones), as the results page's
 * `filter.raw_sites`.
 */
function filterRawSites(raw: RuntimeMemeResult): { raw_sites?: NonNullable<MemeRecord['filter']>['raw_sites'] } {
	const arrays = raw.arrays as { raw?: { lrt: ArrayLike<number>; pvals: ArrayLike<number>; qvals: ArrayLike<number> } | null } | undefined;
	const r = arrays?.raw;
	if (!r || !r.lrt) return {};
	const out = [];
	for (let i = 0; i < r.lrt.length; i++) {
		out.push({ site: i + 1, raw_lrt: Number(r.lrt[i]), raw_p_value: Number(r.pvals[i]), raw_q_value: Number(r.qvals[i]) });
	}
	return { raw_sites: out };
}

export interface RecordContext {
	alignmentText: string;
	treeText: string;
	treeSource: TreeSource;
	options: RunOptions;
	name: string;
	createdAtIso: string;
	/** Free-form runtime facts to merge into `provenance.versions`. */
	versions?: Record<string, string | number | null>;
}

const ESTIMATED_SOURCES: ReadonlySet<string> = new Set(['hyphy-hky85', 'nj', 'tn93']);

function num(v: unknown, fallback = 0): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/** Site rows in the CLI's columns, from either form the runtime may return. */
export function toSiteRecords(rows: Array<Record<string, unknown>>): SiteRecord[] {
	if (rows.length === 0) return [];
	const cli = 'hyphaeon_lrt' in rows[0];
	if (cli) {
		const havePq = 'p_value' in rows[0] && 'q_value' in rows[0];
		const pq = havePq ? null : memeSitePq(rows.map((r) => num(r.hyphaeon_lrt)));
		return rows.map((r, i) => {
			// The runtime merges DM3's view columns (camelCase) into the CLI row; keep them under the
			// record's names and drop the duplicates so the stored row is one vocabulary.
			const { refCodon, refAa, logLrt, zScore, isVariable, lrt, ...rest } = r;
			void isVariable;
			void lrt;
			const out: SiteRecord = {
				...(rest as unknown as SiteRecord),
				site: num(r.site, i + 1),
				hyphaeon_lrt: num(r.hyphaeon_lrt),
				p_value: pq ? pq.pvals[i] : num(r.p_value),
				q_value: pq ? pq.qvals[i] : num(r.q_value),
				is_invariable: Boolean(r.is_invariable)
			};
			if (out.ref_codon === undefined && typeof refCodon === 'string') out.ref_codon = refCodon;
			if (out.ref_aa === undefined && typeof refAa === 'string') out.ref_aa = refAa;
			if (out.log_lrt === undefined && typeof logLrt === 'number') out.log_lrt = logLrt;
			if (out.z_score === undefined && typeof zScore === 'number') out.z_score = zScore;
			return out;
		});
	}
	// DM3 rows: lrt / isVariable / refCodon / refAa / logLrt / zScore / percentile / call.
	const lrts = Float32Array.from(rows, (r) => num(r.lrt));
	const { pvals, qvals } = memeSitePq(lrts);
	return rows.map((r, i) => ({
		site: num(r.site, i + 1),
		hyphaeon_lrt: lrts[i],
		p_value: pvals[i],
		q_value: qvals[i],
		is_invariable: !Boolean(r.isVariable),
		ref_codon: typeof r.refCodon === 'string' ? r.refCodon : undefined,
		ref_aa: typeof r.refAa === 'string' ? r.refAa : undefined,
		log_lrt: typeof r.logLrt === 'number' ? r.logLrt : Math.log1p(lrts[i]),
		z_score: typeof r.zScore === 'number' ? r.zScore : undefined,
		percentile: typeof r.percentile === 'number' ? r.percentile : undefined,
		call: typeof r.call === 'string' ? r.call : undefined
	}));
}

/**
 * The taxa the model saw, in its order, with their sequences. Reconstructed from the inputs when
 * the runtime does not report them; see the header.
 */
export function alignmentBlock(
	raw: RuntimeMemeResult,
	alignmentText: string,
	treeText: string
): { block: AlignmentBlock | null; reconstructed: boolean } {
	const reported = raw.alignment as AlignmentBlock | undefined;
	if (reported && Array.isArray(reported.names) && Array.isArray(reported.sequences)) {
		return { block: reported, reconstructed: false };
	}
	let seqs: Map<string, string>;
	try {
		seqs = parseAlignmentSequences(alignmentText);
	} catch {
		return { block: null, reconstructed: false };
	}
	let order: string[];
	const reportedTaxa = raw.taxa as string[] | undefined;
	if (Array.isArray(reportedTaxa) && reportedTaxa.length) {
		order = reportedTaxa;
	} else {
		const tree = extractTree(treeText);
		const names = Array.from(seqs.keys());
		let matched = names;
		if (tree) {
			try {
				matched = matchTaxa(treeTaxa(tree), names).taxa;
			} catch {
				matched = names;
			}
		}
		const dropped = new Set(((raw.provenance?.preprocessing?.dropped_taxa as string[] | undefined) ?? []).map(String));
		order = matched.filter((n) => !dropped.has(n));
	}
	const names: string[] = [];
	const sequences: string[] = [];
	for (const n of order) {
		const s = seqs.get(n);
		if (s === undefined) continue;
		names.push(n);
		sequences.push(s);
	}
	return { block: names.length ? { names, sequences } : null, reconstructed: true };
}

/** The whole record. */
export function toMemeRecord(raw: RuntimeMemeResult, ctx: RecordContext): MemeRecord {
	const sites = toSiteRecords(raw.sites ?? []);
	const { block, reconstructed } = alignmentBlock(raw, ctx.alignmentText, ctx.treeText);
	const provenance = { ...(raw.provenance ?? {}) } as MemeRecord['provenance'];
	const preprocessing = { ...(provenance.preprocessing ?? {}) } as MemeRecord['provenance']['preprocessing'];
	preprocessing.tree_source = ctx.treeSource;
	preprocessing.branch_lengths_estimated = ESTIMATED_SOURCES.has(ctx.treeSource);
	if (reconstructed) preprocessing.alignment_block = 'reconstructed';
	provenance.preprocessing = preprocessing;
	provenance.surface = provenance.surface ?? 'browser';
	provenance.options = { ...(provenance.options ?? {}), ...ctx.options };
	provenance.warnings = Array.isArray(provenance.warnings) ? provenance.warnings : [];
	if (ctx.versions) provenance.versions = { ...(provenance.versions ?? {}), ...ctx.versions };

	const summary = { ...(raw.summary ?? {}) } as MemeRecord['summary'];
	if (typeof summary.totalSites !== 'number') summary.totalSites = sites.length;
	if (typeof summary.variableSites !== 'number') summary.variableSites = sites.filter((s) => !s.is_invariable).length;
	if (typeof summary.speciesUsed !== 'number') summary.speciesUsed = num(preprocessing.taxa_used, block?.names.length ?? 0);
	if (typeof summary.speciesInAlignment !== 'number') summary.speciesInAlignment = num(preprocessing.taxa_in_alignment, 0);
	if (summary.callMode === undefined) summary.callMode = ctx.options.callMode;

	// `attributions` is a Map keyed by the 1-based site as a string (writers.js
	// attributionsOneIndexed); the record stores a plain object so JSON export and the page's
	// property access both work.
	let attributions: MemeRecord['attributions'] = null;
	const rawAttr = raw.attributions as Map<string, AttributionRecord> | Record<string, AttributionRecord> | undefined;
	if (rawAttr instanceof Map) {
		if (rawAttr.size) attributions = Object.fromEntries(rawAttr);
	} else if (rawAttr && typeof rawAttr === 'object' && Object.keys(rawAttr).length) {
		attributions = rawAttr;
	}

	let filter: MemeRecord['filter'] = null;
	const rawFilter = raw.filter as Record<string, unknown> | undefined;
	if (ctx.options.filter) {
		filter = {
			enabled: true,
			artifacts_masked: (rawFilter?.artifacts_masked as MaskedPatch[] | undefined) ?? [],
			...(rawFilter?.masked_codon_ranges_1idx_by_taxon
				? { masked_codon_ranges_1idx_by_taxon: rawFilter.masked_codon_ranges_1idx_by_taxon as Record<string, number[][]> }
				: {}),
			...(rawFilter?.raw_metrics ? { raw_metrics: rawFilter.raw_metrics as FilterMetrics } : {}),
			...(rawFilter?.cleaned_metrics ? { cleaned_metrics: rawFilter.cleaned_metrics as FilterMetrics } : {}),
			...filterRawSites(raw)
		};
	}

	// The tree the model used: the runtime's when it reports one, else the text handed in, else
	// (embedded case) the Newick cut out of the alignment.
	const reportedTree = typeof raw.tree === 'string' && raw.tree.trim().startsWith('(') ? raw.tree : null;
	const tree = reportedTree || ctx.treeText || embeddedNewick(ctx.alignmentText);

	return {
		name: ctx.name,
		created_at: ctx.createdAtIso,
		schema_version: num(raw.schema_version, 1),
		method: 'meme',
		is_surrogate: raw.is_surrogate !== false,
		surrogate_for: typeof raw.surrogate_for === 'string' ? raw.surrogate_for : 'MEME',
		sites,
		summary,
		provenance,
		tree,
		alignment: block,
		filter,
		attributions,
		callModes: ['percentile', 'zscore', 'pvalue']
	};
}
