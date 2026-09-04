/**
 * entropy.ts — per-site codon and amino-acid Shannon entropy and amino-acid composition.
 *
 * WHY THIS FILE EXISTS. The Manhattan plot draws two overlays on a secondary axis — codon entropy
 * and amino-acid entropy in bits — and the site table draws an amino-acid composition spark bar
 * per row. Both come from the alignment columns the model saw, not from the model. Ported from
 * axomeme3/index.html (`calculateEntropy` and the per-site loop in step 6, lines 3028-3098 of the
 * live file): entropy is -Σ p·log2 p over the states present; a codon counts only when it is
 * three characters with no '-', 'N' or '?'; its amino acid counts only when it translates
 * (stops count as '*'). Entropy is 0 for an empty column.
 *
 * THE GENETIC CODE TABLE is the one-letter translation string of hyphaeon/dataset.py:41-50 in TCAG
 * row order, the same string `@veg/hyphaeon-js` builds CODON_TO_AA from (js/src/preprocess/
 * tokenizer.js). It is reproduced here rather than imported because the web package reaches the
 * library only through `@veg/hyphaeon-runtime`, which does not re-export the table, and the
 * standard code is not something that drifts.
 *
 * COLUMNS. `siteColumns` slices codon `s` as `seq.slice(3s, 3s+3)` for every sequence, the same
 * slice dataset.py:699 and the library's `siteVariability` use, so the states counted here are the
 * states the variability flag was judged on.
 */

const CODON_ORDER = 'TCAG';
const TRANSLATION =
	'FFLLSSSSYY**CC*W' + 'LLLLPPPPHHQQRRRR' + 'IIIMTTTTNNKKSSRR' + 'VVVVAAAADDEEGGGG';

/** codon -> amino acid ('*' for a stop); anything not a sense/stop codon is absent. */
export const CODON_TO_AA: ReadonlyMap<string, string> = (() => {
	const map = new Map<string, string>();
	let i = 0;
	for (const a of CODON_ORDER)
		for (const b of CODON_ORDER) for (const c of CODON_ORDER) map.set(a + b + c, TRANSLATION[i++]);
	return map;
})();

/** Translate one codon; '?' when it is gapped, ambiguous, short or not in the table. */
export function translateCodon(codon: string): string {
	const c = (codon ?? '').toUpperCase();
	if (c.length !== 3 || c.includes('-') || c.includes('N') || c.includes('?')) return '?';
	return CODON_TO_AA.get(c) ?? '?';
}

/** Shannon entropy in bits of a list of categorical states. */
export function shannonEntropy(states: readonly string[]): number {
	if (states.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
	let h = 0;
	const total = states.length;
	for (const c of counts.values()) {
		const p = c / total;
		h -= p * Math.log2(p);
	}
	return h;
}

export interface SiteComposition {
	/** 1-indexed site. */
	site: number;
	codonEntropy: number;
	aaEntropy: number;
	/** Amino-acid counts over translatable codons, insertion order = first seen. */
	aaCounts: Map<string, number>;
	/** Number of translatable codons at the site. */
	total: number;
	/** The codon of every sequence at this site (uppercased; may be short or gapped). */
	codons: string[];
}

/** The codon of every sequence at 1-indexed `site`. */
export function siteColumn(sequences: readonly string[], site: number): string[] {
	const start = (site - 1) * 3;
	return sequences.map((seq) => seq.slice(start, start + 3).toUpperCase());
}

/**
 * Entropy and composition for every site 1..L over the given aligned sequences.
 *
 * @param sequences the selected taxa's aligned nucleotide sequences, in model order
 * @param totalCodons L
 */
export function siteCompositions(sequences: readonly string[], totalCodons: number): SiteComposition[] {
	const out: SiteComposition[] = [];
	for (let site = 1; site <= totalCodons; site++) {
		const codons = siteColumn(sequences, site);
		const cleanCodons: string[] = [];
		const aas: string[] = [];
		for (const codon of codons) {
			if (codon.length !== 3 || codon.includes('-') || codon.includes('N') || codon.includes('?')) continue;
			cleanCodons.push(codon);
			const aa = CODON_TO_AA.get(codon) ?? '?';
			if (aa !== '?') aas.push(aa);
		}
		const aaCounts = new Map<string, number>();
		for (const aa of aas) aaCounts.set(aa, (aaCounts.get(aa) ?? 0) + 1);
		out.push({
			site,
			codonEntropy: shannonEntropy(cleanCodons),
			aaEntropy: shannonEntropy(aas),
			aaCounts,
			total: aas.length,
			codons
		});
	}
	return out;
}

/**
 * Amino-acid colours, verbatim from axomeme3/index.html `AA_COLORS` (line 1486), so the spark
 * bars and the tree modal's composition bar read the same as the site they were ported from.
 */
export const AA_COLORS: Readonly<Record<string, string>> = {
	A: '#10b981',
	R: '#3b82f6',
	N: '#8b5cf6',
	D: '#ec4899',
	C: '#f59e0b',
	E: '#ef4444',
	Q: '#14b8a6',
	G: '#64748b',
	H: '#a855f7',
	I: '#06b6d4',
	L: '#3b82f6',
	K: '#d946ef',
	M: '#06b6d4',
	F: '#6366f1',
	P: '#f43f5e',
	S: '#f59e0b',
	T: '#10b981',
	W: '#8b5cf6',
	Y: '#6366f1',
	V: '#14b8a6',
	'*': '#ef4444',
	'?': '#94a3b8'
};

export function aaColor(aa: string): string {
	return AA_COLORS[aa] ?? '#64748b';
}

/** Counts sorted descending, as axomeme3 orders both bars. */
export function sortedComposition(aaCounts: ReadonlyMap<string, number>): [string, number][] {
	return [...aaCounts.entries()].sort((a, b) => b[1] - a[1]);
}
