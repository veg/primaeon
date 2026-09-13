/**
 * match.js — deciding which metadata row belongs to which sequence, and saying how it decided.
 *
 * WHY THIS FILE EXISTS. Upstream compares `str(row[strain_col]).strip()` to a FASTA name and
 * nothing else (temporal.py:314, dating.py:467). A GISAID table keyed on `EPI_ISL_402124` against
 * headers reading `hCoV-19/Wuhan/IVDC-HB-01/2019|EPI_ISL_402124|2019-12-30` matches ZERO rows —
 * and the reference reports zero rows matched by reporting nothing at all: the dates dict is empty,
 * the taxa are "missing", and they are dropped. That is the failure this layer exists to make
 * visible, and the ladder below is what turns it from a mystery into either a match or a named
 * mismatch.
 *
 * THE LADDER, WEAKEST LAST. Tiers 1-4 are the house ladder the library's `matchTaxa` already
 * speaks (`js/src/preprocess/tree.js:398-443`), so this layer says the same three words about
 * metadata names that the report already says about tree tips. Tiers 5-7 are this layer's.
 *
 *   1 exact                 `pyStrip` both sides                      the only tier upstream has
 *   2 quote_stripped        surrounding ' and " removed               matchTaxa tier 2
 *   3 whitespace_collapsed  internal whitespace runs -> one space     a spreadsheet export
 *   4 case_insensitive      tier 3, then lower-cased                  matchTaxa tier 3
 *   5 first_token           the first whitespace-delimited token,     the library names a sequence
 *                           taken on BOTH sides                       by its first token, so a
 *                                                                     table keyed on the full
 *                                                                     header would otherwise miss
 *   6 sanitized             both sides through `sanitizeName`         THE APP CREATES THIS
 *                                                                     MISMATCH ITSELF by rewriting
 *                                                                     names on upload; a table
 *                                                                     keyed on the original must
 *                                                                     still match
 *   7 field_containment     the metadata name equals one WHOLE        the GISAID case, and the only
 *                           `| / _`-or-whitespace-delimited field     tier that fixes it
 *                           of the taxon name
 *
 * FOUR RULES, NONE NEGOTIABLE.
 *
 *  1. PER-TAXON CASCADE, NOT ALL-OR-NOTHING. `matchTaxa` stops at the first tier that produced any
 *     match at all; this does not. A real surveillance table mixes conventions, and losing the rows
 *     that matched exactly because some other rows needed tier 4 is a worse answer than reporting
 *     both. `tiers` therefore carries per-tier counts and `tier` is the WEAKEST tier that
 *     contributed. That is a deliberate divergence from `matchTaxa`'s shape; the summary key keeps
 *     the name `match_tier` so a consumer already reading the tree's tier reads this one the same
 *     way.
 *  2. TIER 7 ONLY WHEN IT IS A BIJECTION. If one metadata name claims two taxa, or one taxon is
 *     claimed by two metadata names, NEITHER is assigned: the pair goes into `ambiguous` and
 *     `DATES_AMBIGUOUS_MATCH` fires at warn naming both sides. Guessing here dates a sequence from
 *     its neighbour's record, which is a plausible wrong date — the exact failure mode that is
 *     invisible downstream.
 *  3. ANYTHING BEYOND `exact` IS REPORTED, NEVER SILENT. Every assignment carries its own tier, so
 *     the review table shows the reader which inference was made per row rather than asking for
 *     trust.
 *  4. SUBSTRING MATCHING IS NEVER A TIER. Tier 7 is WHOLE-FIELD equality. `EPI_ISL_4021` must not
 *     match `EPI_ISL_402124`, and no prefix, suffix or edit-distance tier is offered at any
 *     strength, behind any flag.
 */

import { pyStrip } from './library.js';
import { sanitizeName } from '../fastaValidation.js';
import { DATE_MATCH_TIERS } from './codes.js';

/** Strip surrounding single or double quotes, as `stripQuotes` does in the library's tree matcher. */
function stripQuotes(name) {
	let s = String(name);
	while (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) {
		s = s.slice(1, -1);
	}
	return s;
}

/**
 * The normalisation one tier applies. Exported so the review table can show a reader the key two
 * names were compared on, which is the only way to argue with a match that looks wrong.
 *
 * @param {string} name
 * @param {string} tier a `DATE_MATCH_TIERS` member
 * @returns {string}
 */
export function normalizeForTier(name, tier) {
	const base = pyStrip(String(name ?? ''));
	switch (tier) {
		case 'exact':
			return base;
		case 'quote_stripped':
			return stripQuotes(base);
		case 'whitespace_collapsed':
			return stripQuotes(base).replace(/\s+/g, ' ').trim();
		case 'case_insensitive':
			return stripQuotes(base).replace(/\s+/g, ' ').trim().toLowerCase();
		case 'first_token':
			return stripQuotes(base).split(/\s+/)[0] ?? '';
		case 'sanitized':
			return sanitizeName(stripQuotes(base)) ?? '';
		case 'field_containment':
			// The key for this tier is the whole name; the FIELDS are enumerated separately, because
			// one taxon offers many keys and the others offer exactly one.
			return stripQuotes(base);
		default:
			return base;
	}
}

/**
 * The delimited fields of a taxon name: split on `|`, `/` and whitespace, empties dropped.
 *
 * `_` IS DELIBERATELY NOT A SEPARATOR HERE, and this is the one place this layer's field set
 * departs from the library's calendar delimiter class (`[|/_\s]`, temporal.py:218-239). The reason
 * is the very case tier 7 exists for: a GISAID accession IS `EPI_ISL_402124`, underscores and all,
 * so splitting on `_` shatters the key into `EPI`, `ISL` and `402124` and the tier can never match
 * the thing it was written to match. MEASURED: with `_` in the class, a table keyed on
 * `EPI_ISL_402124` against `hCoV-19/Wuhan/IVDC-HB-01/2019|EPI_ISL_402124|2019-12-30` matched 0 of
 * 3; without it, 3 of 3. The fragments it would have produced are also exactly the wrong shape —
 * `402124` is a bare number that could equal an unrelated table key by accident, and tier 7's whole
 * safety argument is that it compares WHOLE fields.
 *
 * `-` is absent for the same reason it is absent from the library's calendar delimiter class:
 * splitting on it would shatter `hCoV-19` and `B.1.1.7` into fragments that then match short
 * accessions by accident.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function nameFields(name) {
	return String(name ?? '')
		.split(/[|/\s]+/)
		.filter((f) => f !== '');
}

/**
 * @typedef {{
 *   assignments: Map<string, {name: string, tier: string}>,
 *   unmatchedMetadata: string[],
 *   unmatchedTaxa: string[],
 *   tiers: Record<string, number>,
 *   tier: string|null,
 *   ambiguous: Array<{name: string, taxa: string[], tier: string}>,
 *   examples: Array<{taxon: string, metadataName: string, tier: string}>
 * }} DateNameMatch
 */

/**
 * Match metadata names to alignment taxa.
 *
 * @param {Iterable<string>} metadataNames the names the source produced — table strain values,
 *   Auspice tip names, JSON map keys
 * @param {readonly string[]} taxa the alignment's taxon names, in alignment order
 * @param {{tiers?: readonly string[]}} [options]
 * @returns {DateNameMatch}
 */
export function matchDateNames(metadataNames, taxa, options = {}) {
	const tiersWanted = options.tiers ?? DATE_MATCH_TIERS;
	const names = Array.from(metadataNames ?? []);
	const taxaList = Array.from(taxa ?? []);

	/** @type {DateNameMatch} */
	const out = {
		assignments: new Map(),
		unmatchedMetadata: [],
		unmatchedTaxa: [],
		tiers: {},
		tier: null,
		ambiguous: [],
		examples: []
	};
	for (const t of DATE_MATCH_TIERS) out.tiers[t] = 0;
	if (names.length === 0 || taxaList.length === 0) {
		out.unmatchedMetadata = names.slice();
		out.unmatchedTaxa = taxaList.slice();
		return out;
	}

	// One index per tier: normalised metadata key -> the distinct original names carrying it. A key
	// carried by two different names is ambiguous at that tier and is never used.
	/** @type {Map<string, Map<string, string[]>>} */
	const index = new Map();
	for (const tier of tiersWanted) {
		if (tier === 'field_containment') continue;
		/** @type {Map<string, string[]>} */
		const m = new Map();
		for (const n of names) {
			const key = normalizeForTier(n, tier);
			if (key === '') continue;
			const bucket = m.get(key);
			if (bucket) {
				if (!bucket.includes(n)) bucket.push(n);
			} else m.set(key, [n]);
		}
		index.set(tier, m);
	}

	const ladder = tiersWanted.filter((t) => t !== 'field_containment');
	const wantsFields = tiersWanted.includes('field_containment');
	// Tier 7 is decided only after every taxon has had its turn at tiers 1-6, because its bijection
	// test needs the whole candidate set.
	/** @type {Array<{taxon: string, metadataName: string}>} */
	const fieldCandidates = [];
	/** @type {Array<{taxon: string, names: string[]}>} */
	const fieldCollisions = [];

	for (const taxon of taxaList) {
		let assigned = false;
		for (const tier of ladder) {
			const m = index.get(tier);
			if (!m) continue;
			const key = normalizeForTier(taxon, tier);
			if (key === '') continue;
			const hit = m.get(key);
			if (!hit) continue;
			if (hit.length > 1) {
				// Two metadata names normalise onto this taxon at this tier: neither is assigned, and
				// the ladder does NOT continue to a weaker tier, because a weaker tier cannot resolve
				// an ambiguity a stronger one created.
				out.ambiguous.push({ name: key, taxa: [taxon], tier });
				assigned = true; // "decided": decided not to guess
				break;
			}
			out.assignments.set(taxon, { name: hit[0], tier });
			out.tiers[tier]++;
			if (tier !== 'exact' && out.examples.length < 50) {
				out.examples.push({ taxon, metadataName: hit[0], tier });
			}
			assigned = true;
			break;
		}
		if (assigned || !wantsFields) continue;

		// Tier 7: does exactly one metadata name equal exactly one whole field of this taxon's name?
		const fields = nameFields(taxon);
		const claimed = [];
		for (const f of fields) {
			for (const n of names) {
				if (pyStrip(n) === f && !claimed.includes(n)) claimed.push(n);
			}
		}
		if (claimed.length === 1) fieldCandidates.push({ taxon, metadataName: claimed[0] });
		else if (claimed.length > 1) fieldCollisions.push({ taxon, names: claimed });
	}

	// The reverse half of the bijection: a metadata name that would claim two taxa claims neither.
	/** @type {Map<string, string[]>} */
	const byName = new Map();
	for (const c of fieldCandidates) {
		const bucket = byName.get(c.metadataName);
		if (bucket) bucket.push(c.taxon);
		else byName.set(c.metadataName, [c.taxon]);
	}
	for (const [metadataName, claimants] of byName) {
		if (claimants.length > 1) {
			out.ambiguous.push({ name: metadataName, taxa: claimants, tier: 'field_containment' });
			continue;
		}
		const taxon = claimants[0];
		out.assignments.set(taxon, { name: metadataName, tier: 'field_containment' });
		out.tiers.field_containment++;
		if (out.examples.length < 50) {
			out.examples.push({ taxon, metadataName, tier: 'field_containment' });
		}
	}
	for (const c of fieldCollisions) {
		out.ambiguous.push({ name: c.names.join(' / '), taxa: [c.taxon], tier: 'field_containment' });
	}

	const used = new Set(Array.from(out.assignments.values(), (a) => a.name));
	out.unmatchedMetadata = names.filter((n) => !used.has(n));
	out.unmatchedTaxa = taxaList.filter((t) => !out.assignments.has(t));

	// The WEAKEST tier that contributed, so a run whose dates came from tier 7 says tier 7.
	for (let i = DATE_MATCH_TIERS.length - 1; i >= 0; i--) {
		const t = DATE_MATCH_TIERS[i];
		if (out.tiers[t] > 0) {
			out.tier = t;
			break;
		}
	}
	return out;
}

/** Did any tier beyond `exact` contribute? `DATES_FUZZY_MATCH` fires on this. */
export function usedFuzzyTier(match) {
	return DATE_MATCH_TIERS.some((t) => t !== 'exact' && (match?.tiers?.[t] ?? 0) > 0);
}
