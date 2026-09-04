/**
 * inputs.ts — getting an alignment and a tree into the page: file reads with gzip inflation,
 * the input digest the record keeps, the reference-sequence default, and the demo loader.
 *
 * WHY THIS FILE EXISTS. These are the main-thread pieces of the upload card that are not
 * parsing (the library parses, in the prep worker) and not UI. Kept out of the component so
 * the unit tests can drive them and so the gallery's "run in browser" path can reuse
 * `loadDemo`.
 *
 *   readText     File -> string, inflating gzip first (RFC 1952 magic 1f 8b; pako, lazily
 *                imported so a plain FASTA never pays for it). From the Phase 0 upload card.
 *   digest       {name, size, sha256} of a text: UTF-8 byte length and a Web Crypto SHA-256.
 *                The record stores the digest, never the text (PLAN.md §2 hard truth 8), so a
 *                stored run can be matched against a file on disk without holding the file.
 *                Web Crypto is used directly rather than through the runtime's `sha256Hex` so
 *                the main bundle does not import the runtime (and, through it, the library).
 *   chooseReference   DM3's rule (datamonkey3 src/lib/services/axomeme/assemble.js
 *                `chooseReference`, main@fac1330): a sequence named hg38 / hg / human, matched
 *                case-insensitively as a whole name or a name prefix, else the first sequence.
 *                The library dropped this in Phase 1a because dataset.py has no reference
 *                sequence; it is APP policy for which frame the site table reports in, so it
 *                lives here.
 *   loadDemo     the bundled example's alignment (and tree when it has one) from
 *                `static/gallery/inputs/<id>.{fasta,nwk}`, which web/scripts/prebake-gallery.mjs
 *                copies from HyphAeon/examples at build time. A 404 on the tree means the tree
 *                is embedded in the alignment (RHO) or absent.
 */

import type { InputDigest } from '$lib/api';

/** Gzip magic bytes, RFC 1952 §2.3.1: ID1 = 0x1f, ID2 = 0x8b. */
export function looksLikeGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Read a File as text, inflating it first when it is gzipped. */
export async function readText(file: File): Promise<string> {
	const buffer = new Uint8Array(await file.arrayBuffer());
	if (looksLikeGzip(buffer)) {
		const pako = await import('pako');
		return pako.ungzip(buffer, { to: 'string' });
	}
	return new TextDecoder().decode(buffer);
}

/** Hex SHA-256 of a string's UTF-8 bytes; null where Web Crypto is unavailable (insecure context). */
export async function sha256Text(text: string): Promise<string | null> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle || typeof subtle.digest !== 'function') return null;
	const bytes = new TextEncoder().encode(text);
	const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
	let s = '';
	for (const b of hash) s += b.toString(16).padStart(2, '0');
	return s;
}

/** The digest the record keeps. `name` is what the user saw (file name, `pasted.fasta`, demo id). */
export async function digest(name: string, text: string): Promise<InputDigest> {
	return {
		name,
		size: new TextEncoder().encode(text).length,
		sha256: await sha256Text(text)
	};
}

/** DM3's reference heuristic; see the header. */
export function chooseReference(names: readonly string[]): string | null {
	if (names.length === 0) return null;
	const preferred = ['hg38', 'hg', 'human'];
	for (const want of preferred) {
		const exact = names.find((n) => n.toLowerCase() === want);
		if (exact) return exact;
	}
	for (const want of preferred) {
		const prefix = names.find((n) => n.toLowerCase().startsWith(want));
		if (prefix) return prefix;
	}
	return names[0];
}

export interface DemoInputs {
	id: string;
	alignmentName: string;
	alignmentText: string;
	treeName: string | null;
	treeText: string | null;
}

/**
 * Fetch a bundled example. `base` is `$app/paths` base; `fetchImpl` is a test seam.
 * Throws when the alignment is missing; a missing tree is null (embedded or none).
 */
export async function loadDemo(id: string, base: string, fetchImpl: typeof fetch = fetch): Promise<DemoInputs> {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Not a demo id: ${id}`);
	const alignmentName = `${id}.fasta`;
	const treeName = `${id}.nwk`;
	const alignmentResponse = await fetchImpl(`${base}/gallery/inputs/${alignmentName}`);
	if (!alignmentResponse.ok) {
		throw new Error(`The ${id} example is not bundled in this build (${alignmentResponse.status}).`);
	}
	const alignmentText = await alignmentResponse.text();
	let treeText: string | null = null;
	try {
		const treeResponse = await fetchImpl(`${base}/gallery/inputs/${treeName}`);
		if (treeResponse.ok) {
			const text = await treeResponse.text();
			// A static host may answer a missing file with an HTML page; only a Newick counts.
			if (/^\s*[(#]/.test(text) || /\(/.test(text.slice(0, 200))) treeText = text;
		}
	} catch {
		treeText = null;
	}
	return { id, alignmentName, alignmentText, treeName: treeText ? treeName : null, treeText };
}

/** Demo buttons on the upload card: the examples bundled with a tree or an embedded one. */
export const DEMOS: ReadonlyArray<{ id: string; label: string; note: string }> = [
	{ id: 'bat_oas1', label: 'Bat OAS1', note: '18 taxa × 351 codons, chronogram tree' },
	{ id: 'Smc6', label: 'Smc6', note: '20 primates × 1,097 codons' },
	{ id: 'camelid', label: 'Camelid VHH', note: '212 taxa × 96 codons, tree without lengths' },
	{ id: 'HIV1_RT', label: 'HIV-1 RT', note: '476 taxa × 335 codons, tree without lengths' },
	{ id: 'RHO', label: 'Rhodopsin', note: '710 taxa × 349 codons, embedded tree' }
];
