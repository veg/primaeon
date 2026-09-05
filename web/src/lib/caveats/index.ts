/**
 * index.ts — typed access to web/caveats.json, the one place the site keeps numbers about the
 * model.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "/methods — one page per pillar; caveats generated from
 * caveats.json." The report (§4.5, "surrogate badge", the per-section notes) and the methods page
 * both need the same caveats for the same pillar, keyed by the model_version the run's provenance
 * carries, so neither types a number. This module loads the JSON once (Vite inlines it at build;
 * scripts/check-caveats.mjs has already validated it against the manifest by then) and exposes
 * three lookups: the caveat set for a model version, the caveats of one pillar in file order, and
 * the table or source a caveat points at. Pillar keys are the ReportRecord section names of the
 * orchestrator contract plus `diagnostics`, `evaluate` and `general`.
 *
 * Rendering lives in Caveats.svelte next to this file; the methods page and the report import
 * that component rather than formatting caveats themselves.
 */

import raw from '../../../caveats.json';

export const PILLAR_KEYS = [
	'general',
	'diagnostics',
	'sites',
	'gene',
	'epistasis',
	'attribution',
	'filter',
	'dms',
	'phenotype',
	'evaluate'
] as const;
export type PillarKey = (typeof PILLAR_KEYS)[number];

export interface CaveatNumber {
	label: string;
	value: string;
}

export interface Caveat {
	id: string;
	pillars: PillarKey[];
	headline: string;
	detail: string;
	/** What the reader should do about it, when there is something to do. */
	action?: string;
	/** Headline numbers, rendered as a definition list. */
	numbers?: CaveatNumber[];
	/** Key into CaveatSet.tables. */
	table?: string;
	/** Key into CaveatSet.sources. */
	source: string;
}

export interface CaveatTable {
	title: string;
	columns: string[];
	rows: string[][];
	note?: string;
	source: string;
}

export interface ModelCardVariant {
	trained_on: string;
	regime: string;
	onnx_sha256_prefix: string;
	busted_head_onnx_sha256_prefix?: string;
}

export interface ModelCard {
	what_it_is: string;
	is_surrogate: boolean;
	surrogate_for: string;
	evaluated_against: string;
	parameters_suite: number;
	heads: string[];
	inputs: string[];
	outputs: string[];
	genetic_code: string;
	taxon_cap: number;
	default_taxon_cap: number;
	prng: { algorithm: string; default_seed: number };
	mds_sign: string;
	variants: Record<string, ModelCardVariant>;
	source: string;
}

export interface CaveatSet {
	model_version: string;
	reference_version: string;
	reference_tag: string;
	sources: Record<string, string>;
	model_card: ModelCard;
	caveats: Caveat[];
	tables: Record<string, CaveatTable>;
}

type CaveatsFile = { schema_version: number } & Record<string, unknown>;

const file = raw as unknown as CaveatsFile;

/** Every model_version block in the file, keyed by version, in file order. */
export const CAVEAT_SETS: Readonly<Record<string, CaveatSet>> = Object.fromEntries(
	Object.entries(file).filter(
		([key, value]) => !key.startsWith('_') && key !== 'schema_version' && value !== null && typeof value === 'object'
	)
) as Record<string, CaveatSet>;

/** Model versions present, in file order (the last one is the newest). */
export const MODEL_VERSIONS: readonly string[] = Object.keys(CAVEAT_SETS);

/** The newest set in the file; what a page renders when it has no run to take a version from. */
export function latestCaveats(): CaveatSet {
	const version = MODEL_VERSIONS[MODEL_VERSIONS.length - 1];
	return CAVEAT_SETS[version];
}

/**
 * The set for a run's `provenance.model_version`, or null when this build has no caveats for
 * that version (a report saved by a newer or older build). Callers fall back to latestCaveats()
 * and should say so.
 */
export function caveatsForModel(version: string | null | undefined): CaveatSet | null {
	if (!version) return null;
	return CAVEAT_SETS[version] ?? null;
}

/** The caveats tagged with one pillar, in file order. */
export function caveatsFor(pillar: PillarKey, set: CaveatSet = latestCaveats()): Caveat[] {
	return set.caveats.filter((c) => c.pillars.includes(pillar));
}

/** One caveat by id, or null. */
export function caveatById(id: string, set: CaveatSet = latestCaveats()): Caveat | null {
	return set.caveats.find((c) => c.id === id) ?? null;
}

/** The table a caveat points at, or null. */
export function tableFor(caveat: Caveat, set: CaveatSet = latestCaveats()): CaveatTable | null {
	return caveat.table ? (set.tables[caveat.table] ?? null) : null;
}

/** The human-readable source string for a caveat or table (falls back to the key itself). */
export function sourceLabel(item: { source: string }, set: CaveatSet = latestCaveats()): string {
	return set.sources[item.source] ?? item.source;
}
