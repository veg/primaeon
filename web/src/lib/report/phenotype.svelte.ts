/**
 * phenotype.svelte.ts — the on-demand phenotype run: where its inputs come from, which presets are
 * worth offering, how the trait is resolved for a preview, and the one call into the analyze
 * worker that produces the section.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 row 8 (D21): every other pillar runs unasked, and this one
 * cannot, because the trait is the reader's. So the phenotype section is a small application of
 * its own inside the report — a form, a run, a result — and it must work on a report the browser
 * produced minutes ago, on a prebaked gallery record, and on a server job's record, none of which
 * carry the same things. Keeping that decision here means PhenotypeSection.svelte is a form and
 * not a data-provenance problem.
 *
 * WHERE THE INPUTS COME FROM, IN ORDER OF PREFERENCE.
 *
 *   1. `inputs.alignmentText` + `inputs.treeText`, the texts a browser run keeps in IndexedDB for
 *      "Re-run with…". These are the ORIGINAL inputs, so the runtime re-runs the same preparation
 *      with the same options — the same duplicate pruning, the same Faith's-PD selection, the same
 *      MDS — and the site indices of the result line up with the Sites section by construction.
 *   2. `sections.sites.alignment` (the taxa the model actually used, in its order, with their
 *      sequences) rebuilt as FASTA, plus `sections.sites.tree`. A gallery record is stripped of
 *      its input texts (they are 1.4 MB of the 7.8 MB the repository tracks) but keeps both of
 *      these, and they are the model's OWN view of the dataset: N and L already match, and the
 *      preparation has nothing left to subsample. This is the path RHO takes in the gallery.
 *
 * A record with neither cannot run the pillar, and the panel says which record that is rather than
 * failing at the worker.
 *
 * PERMULATIONS NEED A TREE WITH BRANCH LENGTHS. `hyphaeon phenotype`'s gene-level empirical p
 * comes from Brownian-motion permulations on the tree (phenotype.py:275-346), and a tree-free run
 * has no tree for the model and only a display tree afterwards — which is a topology inferred from
 * the same distances, not an independent object to draw a null from. So the offer is withheld
 * rather than made on the NJ tree, and `permulationsAvailable()` is the one place that decides.
 *
 * THE TRAIT PREVIEW runs in the MAIN THREAD, deliberately. `resolvePhenotypeVector` is string
 * matching over the taxon names — microseconds — and the panel needs its answer on every keystroke
 * to show the match count and the matched names. The library is imported dynamically so the
 * phenotype module is not in the report's first chunk.
 */

import type { PhenotypeRunOptions, ReportRecord, TraitSpec, TreeSource } from '$lib/api';
import { PHENOTYPE_DEFAULTS, traitToPhenotypeOptions } from '$lib/api';
import type { PhenotypeSection } from './types';
import { analyzeClient } from '$lib/workers/clients';
import type { PhenotypeResponse } from '$lib/workers/protocol';
import { savePhenotypeSection } from '$lib/storage/reports';

/** Absolute URL for a site path, so the worker (whose location is the bundle) resolves it right. */
function absolute(base: string, path: string): string {
	return new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost/').href;
}

export interface PhenotypeInputs {
	alignmentText: string;
	/** '' when the report ran tree-free. */
	treeText: string;
	treeSource: TreeSource;
	/** The taxa the trait will be matched against, in the model's order. */
	taxa: string[];
	/** Which of the two paths in the header produced these. */
	from: 'inputs' | 'sites';
}

/** The FASTA the model saw, rebuilt from the stored alignment block (path 2 in the header). */
export function fastaFromBlock(block: { names: string[]; sequences: string[] }): string {
	const out: string[] = [];
	for (let i = 0; i < block.names.length; i++) out.push(`>${block.names[i]}\n${block.sequences[i] ?? ''}`);
	return `${out.join('\n')}\n`;
}

/** The inputs the phenotype run needs, or null when this record cannot supply them. */
export function phenotypeInputs(record: ReportRecord): PhenotypeInputs | null {
	const sites = record.sections.sites;
	const treeSource = record.inputs.treeSource;
	const alignmentText = record.inputs.alignmentText;
	if (alignmentText && alignmentText.trim()) {
		return {
			alignmentText,
			treeText: record.inputs.treeText ?? '',
			treeSource,
			taxa: sites?.alignment?.names ?? [],
			from: 'inputs'
		};
	}
	const block = sites?.alignment;
	if (block && block.names.length > 0 && block.sequences.length === block.names.length) {
		return {
			alignmentText: fastaFromBlock(block),
			// The stored tree is the one the model was given; for a tree-free record it is the
			// DISPLAY tree, which must not be handed to the runtime as if the model had used it.
			treeText: treeSource === 'tn93' ? '' : (sites?.tree ?? ''),
			treeSource,
			taxa: block.names,
			from: 'sites'
		};
	}
	return null;
}

/** Why the pillar cannot run on this record, in one sentence, or null when it can. */
export function phenotypeBlockedReason(record: ReportRecord): string | null {
	if (!record.sections.sites) return 'The site-selection section has not finished yet; the phenotype pillar reads the same alignment and the same forward pass.';
	if (phenotypeInputs(record) === null) {
		return 'This record carries neither the alignment it was run on nor the taxa the model used, so there is nothing to match a trait against. Re-run the dataset to get a report that can.';
	}
	return null;
}

/**
 * Whether the gene-level Brownian-motion permulations can run: a tree WITH branch lengths, which is
 * exactly the case the report did not go tree-free in. See the header.
 */
export function permulationsAvailable(record: ReportRecord): boolean {
	const inputs = phenotypeInputs(record);
	return Boolean(inputs && inputs.treeSource !== 'tn93' && inputs.treeText.trim());
}

export const PERMULATIONS_UNAVAILABLE =
	'Permulations need a tree with branch lengths. This report ran tree-free (TN93 distances), and the tree drawn beside it is a neighbour-joining display tree built from those same distances — drawing a Brownian-motion null from it would test the distances against themselves. The gene-level p_evd is reported; the empirical one is not.';

// ---- presets ------------------------------------------------------------------------------------

export interface PresetMatch {
	key: string;
	title: string;
	description: string;
	/** How many of this report's taxa the preset's patterns match. */
	matched: number;
	/** The matched names, in the model's taxon order. */
	taxa: string[];
}

/**
 * The presets worth offering: the library's eight, resolved against THIS report's taxa, keeping
 * only those that match at least one and ordered by how many. PLAN.md §4.0 row 8: "presets appear
 * when the taxa match a preset's species" — an echolocation preset on a viral alignment is not an
 * option, it is a mistake waiting to be made.
 *
 * The count is the reference's own matching, quirks included (a preset pattern is `fnmatch`, and
 * for `echolocation`'s bare names also a substring test), because it is `resolvePhenotypeVector`
 * that produces it, not a re-implementation.
 */
export async function presetMatches(taxa: readonly string[]): Promise<PresetMatch[]> {
	if (taxa.length === 0) return [];
	const { PRESETS, resolvePhenotypeVector } = await import('@veg/hyphaeon-js');
	const names = Array.from(taxa);
	const out: PresetMatch[] = [];
	for (const [key, info] of Object.entries(PRESETS as Record<string, { title: string; description: string }>)) {
		let matched: string[];
		try {
			const vector = resolvePhenotypeVector(names, { preset: key });
			matched = names.filter((_, i) => vector.y[i] > 0);
		} catch {
			continue;
		}
		if (matched.length === 0) continue;
		out.push({ key, title: info.title, description: info.description, matched: matched.length, taxa: matched });
	}
	out.sort((a, b) => b.matched - a.matched || a.key.localeCompare(b.key));
	return out;
}

// ---- trait preview ------------------------------------------------------------------------------

export interface TraitPreview {
	ok: boolean;
	/** The library's own description of the trait — the sentence the CLI would print. */
	description: string;
	mode: string;
	foreground: string[];
	foregroundCount: number;
	backgroundCount: number;
	error: string | null;
}

/**
 * What the trait resolves to on this report's taxa, before anything is run. A continuous trait has
 * no foreground: the reference leaves both counts at 0 and z-scores the column, so the preview
 * reports the taxa it found a NUMBER for instead (the non-zero entries of the vector).
 */
export async function previewTrait(taxa: readonly string[], trait: TraitSpec): Promise<TraitPreview> {
	const empty: TraitPreview = { ok: false, description: '', mode: '', foreground: [], foregroundCount: 0, backgroundCount: 0, error: null };
	if (taxa.length === 0) return { ...empty, error: 'No taxa to match against yet.' };
	try {
		const { resolvePhenotypeVector } = await import('@veg/hyphaeon-js');
		const names = Array.from(taxa);
		const vector = resolvePhenotypeVector(names, traitToPhenotypeOptions(trait));
		const nonZero = names.filter((_, i) => vector.y[i] !== 0);
		return {
			ok: vector.mode === 'continuous' ? nonZero.length > 0 : vector.fgCount > 0,
			description: vector.description,
			mode: vector.mode,
			foreground: nonZero,
			foregroundCount: vector.fgCount,
			backgroundCount: vector.bgCount,
			error: null
		};
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The reference runs `re.search(pattern, taxon, re.IGNORECASE)` BEFORE it tries the glob
 * (phenotype.py:249-256), so a pattern typed as a shell glob is silently a regular expression:
 * `pan*` is `pa` followed by zero or more `n`, and it matches `papAnu`. True when the string the
 * reader typed contains a character that means something different to the two.
 */
export function looksLikeGlob(foreground: string): boolean {
	return /[*?[\]]/.test(foreground);
}

// ---- the run ------------------------------------------------------------------------------------

export interface PhenotypeRunRequest {
	record: ReportRecord;
	trait: TraitSpec;
	options?: Partial<PhenotypeRunOptions>;
	/** `$app/paths` base, for the model and runtime URLs. */
	base: string;
	numThreads: number;
	signal?: AbortSignal;
	onProgress?: (message: string, done: number, total: number) => void;
}

/**
 * Run the pillar in the analyze worker and return the section. Nothing is stored here: the caller
 * puts the section on its record and calls `persistPhenotype` when the record is one this browser
 * owns (a gallery record is read-only, and a section run against it lives for the visit).
 */
export async function runReportPhenotype(req: PhenotypeRunRequest): Promise<PhenotypeSection> {
	const inputs = phenotypeInputs(req.record);
	if (!inputs) throw new Error(phenotypeBlockedReason(req.record) ?? 'This report cannot run the phenotype pillar.');
	const options: PhenotypeRunOptions = { ...PHENOTYPE_DEFAULTS, ...req.options };
	if (!permulationsAvailable(req.record)) options.permulations = 0;
	const response = await analyzeClient().call<PhenotypeResponse>(
		{
			kind: 'phenotype',
			alignmentText: inputs.alignmentText,
			treeText: inputs.treeText,
			treeSource: inputs.treeSource,
			// Everything that crosses `postMessage` must be a plain object: the record the panel holds
			// is a Svelte `$state` proxy (the report page keeps it in reactive state so the section can
			// appear on the page the moment it exists), and a proxy is not structured-cloneable.
			trait: $state.snapshot(req.trait) as TraitSpec,
			options: $state.snapshot(req.record.options) as ReportRecord['options'],
			phenotypeOptions: options,
			inputs: { alignmentName: req.record.inputs.alignmentName ?? null, treeName: req.record.inputs.treeName ?? null },
			manifestUrl: absolute(req.base, '/models/manifest.json'),
			modelsBase: absolute(req.base, '/models/'),
			ortBase: absolute(req.base, '/ort/'),
			numThreads: req.numThreads
		},
		{
			signal: req.signal,
			onProgress: (_phase, done, total, message) => req.onProgress?.(message, done, total)
		}
	);
	return response.record;
}

/**
 * Store the phenotype section with the report it belongs to, when that report is one this browser
 * owns; `savePhenotypeSection` writes nothing and answers false for a gallery example or a server
 * job. Failure is not fatal — the section is on screen either way — for the same reason the run
 * loop's own persistence is best-effort.
 */
export async function persistPhenotype(record: ReportRecord, section: PhenotypeSection | null): Promise<boolean> {
	try {
		// A $state proxy cannot be structured-cloned into IndexedDB; store the plain snapshot.
		return await savePhenotypeSection(record.id, section ? ($state.snapshot(section) as PhenotypeSection) : null);
	} catch (err) {
		console.warn('phenotype section not saved:', err);
		return false;
	}
}
