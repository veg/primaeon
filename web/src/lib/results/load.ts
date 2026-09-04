/**
 * load.ts — where a results page gets its record from.
 *
 * WHY THIS FILE EXISTS. One route renders two sources (PLAN.md §4.1: "/results/[local-id]" for
 * browser runs persisted in IndexedDB, and the gallery's prebaked records), and the page should
 * not know which store it is reading. `loadRecord(id)`:
 *
 *   gallery/<name>   fetches static/gallery/<name>.json, written by the gallery build. A missing
 *                    file is a 404 the page reports as "no such example".
 *   anything else    reads IndexedDB through web/src/lib/storage/results.ts, the analyze
 *                    pipeline's store. That module is resolved with `import.meta.glob` rather
 *                    than a static import so this file builds before the store exists and picks
 *                    the store up, with no change here, once it does; the store's read function
 *                    is looked up by the names it is expected to export (`getResult`, `loadResult`,
 *                    `get`), first found wins. Until it exists a local id reports "not stored".
 *
 * The record is normalised (`normaliseRecord`) so a bare CLI document — `hyphaeon meme` JSON with
 * no provenance, which is what the gallery agent converts — renders with a python-reference
 * provenance rather than crashing on a missing block.
 */

import { base } from '$app/paths';
import type {
	AttributionRecord,
	FilterBlock,
	MaskedPatch,
	MemeRecord,
	Provenance,
	ResultSummary,
	SiteRecord
} from './types';

export const GALLERY_PREFIX = 'gallery/';

type StoreModule = Record<string, unknown>;

/**
 * What a source hands the normaliser: any of a runtime record, a stored envelope's `result`, or
 * a bare CLI document (whose `alignment` and `tree` are file NAMES, hence `unknown` here).
 */
export type RawRecord = Record<string, unknown> & {
	sites?: SiteRecord[];
	summary?: Partial<ResultSummary>;
	provenance?: Partial<Provenance> & { surface?: string };
	filter?: FilterBlock | null;
	attributions?: Record<string, AttributionRecord> | null;
	callModes?: string[];
	cli?: Record<string, unknown>;
	schema_version?: number;
	is_surrogate?: boolean;
	surrogate_for?: string;
	id?: string;
	name?: string;
	created_at?: string;
};
const storeModules = import.meta.glob<StoreModule>('../storage/results.ts');

/** The IndexedDB store's read function, when the store module exists. */
async function storeReader(): Promise<((id: string) => Promise<unknown>) | null> {
	const loaders = Object.values(storeModules);
	if (loaders.length === 0) return null;
	const mod = await loaders[0]();
	for (const name of ['getResult', 'loadResult', 'readResult', 'get']) {
		const fn = mod[name];
		if (typeof fn === 'function') return fn as (id: string) => Promise<unknown>;
	}
	return null;
}

export class RecordNotFound extends Error {
	constructor(
		message: string,
		public readonly source: 'gallery' | 'local' | 'none'
	) {
		super(message);
		this.name = 'RecordNotFound';
	}
}

export async function loadRecord(id: string, fetchImpl: typeof fetch = fetch): Promise<MemeRecord> {
	if (id.startsWith(GALLERY_PREFIX)) {
		const name = id.slice(GALLERY_PREFIX.length).replace(/\/+$/, '');
		const response = await fetchImpl(`${base}/gallery/${encodeURIComponent(name)}.json`);
		if (!response.ok) throw new RecordNotFound(`No gallery record named "${name}".`, 'gallery');
		const raw = (await response.json()) as RawRecord;
		return normaliseRecord(raw, { id, name: raw.name ?? name });
	}
	const read = await storeReader();
	if (!read) {
		throw new RecordNotFound(
			'Local results are not available: the results store has not been initialised in this build.',
			'none'
		);
	}
	const raw = (await read(id)) as RawRecord | null | undefined;
	if (!raw) throw new RecordNotFound(`No stored result with id "${id}" in this browser.`, 'local');
	const inner = (raw.result ?? raw.record ?? raw) as RawRecord;
	const createdAt = raw.createdAtIso ?? raw.created_at ?? raw.createdAt;
	return normaliseRecord(inner, {
		id,
		name: raw.name ?? inner.name,
		created_at:
			typeof createdAt === 'number' ? new Date(createdAt).toISOString() : (createdAt as string | undefined)
	});
}

const EMPTY_PROVENANCE = (surface: string): Provenance => ({
	schema_version: 1,
	surface,
	hyphaeon_js_version: null,
	reference_version: null,
	model_version: null,
	model_variant: null,
	artifact_sha256: null,
	is_surrogate: true,
	surrogate_for: 'MEME',
	seed: null,
	elapsed_sec: null,
	options: {},
	preprocessing: {
		taxa_in_alignment: 0,
		taxa_used: 0,
		dropped_taxa: [],
		duplicates_collapsed: 0,
		pd_subsampled: false,
		reference_sequence: null,
		tree_source: 'user',
		branch_lengths_estimated: false,
		distance_rescaled: false,
		codons_trimmed: 0,
		unknown_codon_fraction: 0,
		in_frame_stops: null
	},
	warnings: []
});

/**
 * Accept a runtime record, a stored wrapper, or a bare `hyphaeon meme` document and return a
 * MemeRecord with every block the page reads present.
 */
export function normaliseRecord(raw: RawRecord, overrides: Partial<MemeRecord> = {}): MemeRecord {
	const sites = (raw.sites ?? []) as SiteRecord[];
	const isCli = raw.provenance === undefined && typeof raw.taxa_count === 'number';
	const provenance: Provenance = raw.provenance
		? ({ ...EMPTY_PROVENANCE(raw.provenance.surface ?? 'browser'), ...raw.provenance } as Provenance)
		: EMPTY_PROVENANCE(isCli ? 'python-reference' : 'browser');
	if (isCli) {
		provenance.preprocessing = {
			...provenance.preprocessing,
			taxa_in_alignment: raw.taxa_count as number,
			taxa_used: raw.taxa_count as number,
			tree_source: raw.tree === 'embedded_in_alignment' ? 'embedded' : 'user'
		};
		if (typeof raw.runtime_sec === 'number') provenance.elapsed_sec = raw.runtime_sec;
	}
	const variable = sites.filter((s) => !s.is_invariable).length;
	const summary = {
		totalSites: sites.length,
		variableSites: variable,
		speciesUsed: provenance.preprocessing.taxa_used,
		speciesInAlignment: provenance.preprocessing.taxa_in_alignment,
		referenceSequence: provenance.preprocessing.reference_sequence,
		...(raw.summary ?? {})
	};
	const attributions = raw.attributions ?? null;
	const filter: FilterBlock | null =
		raw.filter ??
		(raw.filter_enabled || (Array.isArray(raw.artifacts_masked) && raw.artifacts_masked.length > 0)
			? {
					enabled: Boolean(raw.filter_enabled),
					artifacts_masked: (raw.artifacts_masked as MaskedPatch[] | undefined) ?? []
				}
			: null);
	// The CLI document's top-level names, kept for the download's `alignment` / `tree` fields. A
	// `tree` that is Newick text is the tree itself (MemeRecord.tree), not the CLI's file name.
	const cli: Record<string, unknown> = { ...(raw.cli ?? {}) };
	for (const k of ['alignment', 'tree', 'taxa_count', 'codon_count', 'runtime_sec']) {
		const v = raw[k];
		if (v === undefined || cli[k] !== undefined) continue;
		if ((k === 'alignment' || k === 'tree') && (typeof v !== 'string' || v.includes('('))) continue;
		cli[k] = v;
	}
	return {
		schema_version: raw.schema_version ?? 1,
		method: 'meme',
		is_surrogate: raw.is_surrogate ?? true,
		surrogate_for: raw.surrogate_for ?? 'MEME',
		sites,
		summary,
		provenance,
		tree: typeof raw.tree === 'string' && raw.tree.includes('(') ? raw.tree : ((raw.newick as string | undefined) ?? null),
		alignment:
			typeof raw.alignment === 'object' && raw.alignment !== null ? (raw.alignment as MemeRecord['alignment']) : null,
		arrays: (raw.arrays as MemeRecord['arrays']) ?? null,
		attributionRecords: (raw.attributionRecords as MemeRecord['attributionRecords']) ?? null,
		filter,
		attributions,
		callModes: raw.callModes,
		cli,
		id: raw.id,
		name: raw.name,
		created_at: raw.created_at,
		...overrides
	};
}
