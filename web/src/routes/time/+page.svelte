<!--
	+page.svelte (/time) — read the dates out of a dated dataset, show what was read and how, and
	say whether the dates carry a clock signal.

	WHY THIS ROUTE EXISTS. A dated dataset fails quietly upstream, in four ways this page exists to
	make visible: metadata names are compared to sequence names with nothing but a `strip()`, so a
	table keyed on accessions matches zero rows and the reference reports that by reporting nothing;
	a table covering 80 % of the taxa leaves the rest undated, because the header fallback is guarded
	by `len(dates) == 0` (temporal.py:323); a masked or partial date has its month silently set to
	June and its day to the 15th; and the same header parses to a different number depending on a
	time unit nobody was asked about. Every one of those is a row, a count and a sentence here.

	IT IS NOT A SECTION OF THE REPORT (PLAN-TEMPORAL D23) and it is not in the primary navigation:
	`e2e/smoke.spec.ts` fixes that to Methods, Evaluate, MCP. It is reached by one sentence on the
	landing page and one on /analyze.

	IT RUNS ONE THING, AND IT LOADS NO MODEL TO DO IT (phase 3). The gate in section 1 unlocks the
	ancestor-date estimate in section 3: TN93 divergence to a chosen root, a straight line through
	it, and a per-sequence table in section 4. That is the model-free half of `hyphaeon dating`; the
	two model-based estimators need a taxon-by-taxon attention matrix the current ONNX export does
	not emit, and section 3 says so in place rather than promising them (web/DESIGN.md §5 forbids
	"coming soon"). The temporal-selection pillar is still not ported and section 5 says so.

	THE DATE REVIEW IS SYNCHRONOUS; THE ESTIMATE IS NOT. The ingest is string work over text already
	in memory — at 143 sequences it is well under a millisecond, and the reader sees the table
	re-sort under the control they just changed, which is the whole point. The estimate is N pairwise
	TN93 comparisons over the full alignment width and runs in its own cancellable worker
	(`lib/workers/dating.worker.ts`), whose entire import graph is `@veg/hyphaeon-runtime/dating`.
	Nothing on this route loads ORT, a graph or any WebAssembly, and `e2e/time.spec.ts` asserts it by
	watching the network.

	LOOK. web/DESIGN.md: `--container` (an eight-column table needs the report's measure), three
	sections numbered by the `.numbered` CSS counter in app.css, a `<figure>` with a numbered caption
	per plot, a `<caption>` above each table, the warning treatment for what changes the answer and
	the black refusal treatment for a file that will not read. Purple appears on links and on the two
	marks in the clock figure that carry a fact, and nowhere else.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { goto, replaceState } from '$app/navigation';
	import { archival1959Candidates, compileDateRegex, ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
	import DropZone from '$lib/analyze/DropZone.svelte';
	import { digest, readText } from '$lib/analyze/inputs';
	import { setHandoff, takeHandoff } from '$lib/handoff';
	import { clockPreview } from '$lib/time/clock';
	import { crossCheckSentence, datingView, figureModel, modeShiftSentence, modelOffer, predictionCaveat, taxonRows } from '$lib/time/dating';
	import { DATING_CSV_NAME, DATING_DOWNLOAD_NOTE, DATING_JSON_NAME, datingCsv, datingJson } from '$lib/time/datingDownloads';
	import DatingSection from '$lib/time/DatingSection.svelte';
	import TaxonDatingTable from '$lib/time/TaxonDatingTable.svelte';
	import { datingClient, datingModelClient, workersAvailable } from '$lib/workers/clients';
	import type { DatingModelRequest, DatingRequest, DatingResponse } from '$lib/workers/protocol';
	import { DATING_NEURAL_MAX_TAXA } from '@veg/hyphaeon-runtime/dating';
	import {
		diagnosis,
		pageState,
		readyGate,
		reviewRows,
		spanSentence,
		unmatchedMetadataLine,
		bareNumberDates,
		bareNumbersDominate,
		type DateIngestLike,
		type ReviewRow
	} from '$lib/time/dateReview';
	import { DATES_CSV_COLUMNS, datesCsv, datesJson, saveText } from '$lib/time/downloads';
	import { buildRecord, fromStored } from '$lib/time/record';
	import { alignmentHeaders, classifyDropped, isDateSource } from '$lib/time/sources';
	import type { DatingResult, DatingRootChoice, TimeSetOptions, TimeSetRecord, TimeUnits } from '$lib/time/types';
	import DateReviewTable from '$lib/time/DateReviewTable.svelte';
	import CoverageFigure from '$lib/time/CoverageFigure.svelte';
	import ClockPreview from '$lib/time/ClockPreview.svelte';
	import MetadataDisclosure from '$lib/time/MetadataDisclosure.svelte';
	import {
		SAVE_INTERVAL_MS,
		isAvailable as storageAvailable,
		getTimeSet,
		saveTimeSet
	} from '$lib/storage/timesets';
	import type { InputDigest } from '$lib/api';

	let { data } = $props();

	// ---- inputs ----------------------------------------------------------------------------------
	let alignmentText = $state('');
	let alignmentName = $state<string | null>(null);
	let alignmentDigest = $state<InputDigest | null>(null);
	let treeText = $state<string | null>(null);
	let treeName = $state<string | null>(null);
	let metadataText = $state<string | null>(null);
	let metadataName = $state<string | null>(null);
	let metadataDigest = $state<InputDigest | null>(null);

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let storageNote = $state<string | null>(null);

	// ---- what the reader set ---------------------------------------------------------------------
	let units = $state<TimeUnits | null>(null); // null = let the layer infer and say so
	let idColumn = $state<string | null>(null);
	let dateColumn = $state<string | null>(null);
	let headerFallback = $state(true);
	let archival1959 = $state(false);
	let customPattern = $state('');
	let dropUndated = $state(false);
	// Set only by the tick below: the reader confirming that bare numbers in names really are the
	// time coordinate they chose. Cleared whenever the units change, because the claim is about them.
	let acceptBareNumbers = $state(false);

	let recordId = $state<string | null>(null);
	let visibleRows = $state<ReviewRow[]>([]);

	// ---- the dating run (phase 3) ----------------------------------------------------------------
	let datingRoot = $state<DatingRootChoice>('consensus');
	let rootTaxon = $state<string | null>(null);
	let excludedTaxa = $state<string[]>([]);
	let dating = $state<DatingResult | null>(null);
	let datingState = $state<'idle' | 'running'>('idle');
	let datingProgress = $state('');
	let datingFailure = $state<string | null>(null);
	let datingAbort: AbortController | null = null;

	// ---- the model-based half (phase 4) ----------------------------------------------------------
	/**
	 * `--distance-mode`, which with a model present is a decision about the WHOLE record and not
	 * just about which estimators exist: `auto` resolves to `latent` (dating.py:2520-2523) and then
	 * every estimator, the ordinary one included, is fitted against the latent root's divergences.
	 * The reader gets the choice because the reference has it and because the two answers are both
	 * defensible; the page's job is to name which one it is showing.
	 */
	let distanceMode = $state<'auto' | 'tn93'>('auto');
	/** What the LAST estimate did. Not a preference — the two runs produce different records. */
	let usedModel = $state(false);
	/**
	 * The previous run, kept for exactly one sentence: when the distance mode changed between two
	 * runs the reader made, the ordinary fit moves without its arithmetic changing, and that is the
	 * single most surprising consequence of turning the model on. It is NOT persisted — a comparison
	 * between a run you watched and a run you did not is not one this page should make for you.
	 */
	let priorDating = $state<DatingResult | null>(null);
	/**
	 * Whether this build ships a dating graph, read from `models/manifest.json` ONCE, and only after
	 * an alignment with usable dates is loaded — so the empty route still requests nothing at all.
	 * `'absent'` is a fact about the build and is said in place; it is not a failure.
	 */
	let modelProbe = $state<'idle' | 'checking' | 'ready' | 'absent' | 'failed'>('idle');
	let modelGraph = $state<{ variant: string; file: string; sha256: string } | null>(null);
	let modelProbeNote = $state<string | null>(null);

	// ---- derived: the whole review, re-derived on every edit --------------------------------------
	const names = $derived(alignmentText ? alignmentHeaders(alignmentText) : null);
	const taxa = $derived(alignmentText ? taxaForDates(alignmentText) : []);

	const pattern = $derived(customPattern.trim() ? compileDateRegex(customPattern.trim()) : null);
	const patternError = $derived(pattern && !pattern.valid ? (pattern.error ?? 'That pattern could not be used.') : null);

	const ingest = $derived.by((): DateIngestLike | null => {
		if (!alignmentText || taxa.length === 0) return null;
		try {
			return ingestDates({
				taxa,
				headerOf: names?.headerOf ?? null,
				source: metadataText,
				sourceName: metadataName ?? undefined,
				timeUnits: units,
				strainCol: idColumn,
				dateCol: dateColumn,
				dateRegex: pattern && pattern.valid ? customPattern.trim() : null,
				archival1959,
				headerFallback
			}) as unknown as DateIngestLike;
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
			return null;
		}
	});

	const tableLoaded = $derived(Boolean(metadataText));
	const rows = $derived(ingest ? reviewRows(ingest, tableLoaded) : []);
	const gate = $derived(readyGate(ingest, dropUndated, acceptBareNumbers));
	const viewState = $derived(pageState(ingest, failure, dropUndated, acceptBareNumbers));
	const strip = $derived(ingest ? diagnosis(ingest) : null);
	const unmatched = $derived(ingest ? unmatchedMetadataLine(ingest, metadataName) : null);
	const anchors = $derived(taxa.length ? archival1959Candidates(taxa) : []);
	const preview = $derived(clockPreview({ treeText, ingest }));
	const datingResult = $derived(datingView(dating, ingest?.time_units ?? 'years'));
	const datingFigure = $derived(figureModel(dating));
	const datingTaxa = $derived(taxonRows(dating, excludedTaxa));
	const datingCaveat = $derived(predictionCaveat(dating, ingest?.time_units ?? 'years'));
	/** What can be offered before a run, and the honest reason when nothing can. */
	const offer = $derived(
		modelOffer({
			workers: workersAvailable(),
			dated: ingest?.coverage.dated ?? 0,
			// The model-free run counted them; before one has been made the sentence says "every codon"
			// rather than guessing, which is why this is nullable rather than parsed here.
			codons: ((dating?.record?.primaeon ?? {}) as { codon_count?: number }).codon_count ?? null,
			maxTaxa: DATING_NEURAL_MAX_TAXA
		})
	);
	/** One sentence, and only when the reader's last two runs measured divergence differently. */
	const modeShift = $derived(modeShiftSentence(dating, priorDating, ingest?.time_units ?? 'years'));
	/**
	 * The one line that stops the page printing two ancestor numbers with nothing between them. The
	 * width it compares against is the interval section 3 quotes, so "they disagree by more than the
	 * interval" means what it says.
	 */
	const crossCheck = $derived.by(() => {
		const ols = (dating?.record?.ols ?? null) as Record<string, unknown> | null;
		const t = typeof ols?.t_mrca === 'number' ? ols.t_mrca : NaN;
		const ci = Array.isArray(ols?.ci_fieller) ? (ols.ci_fieller as number[]) : null;
		const width = ci && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? ci[1] - ci[0] : NaN;
		if (!preview.available || !preview.fit?.ok) return null;
		return crossCheckSentence(t, preview.fit.tMrca, width, ingest?.time_units ?? 'years');
	});

	const tableInfo = $derived(
		(ingest?.table ?? null) as {
			columns?: string[];
			strain_col?: string | null;
			strain_col_source?: string | null;
			date_col?: string | null;
			date_col_source?: string | null;
			delimiter?: string;
			delimiter_source?: string;
			rows_read?: number;
			numeric_names?: number;
		} | null
	);
	const delimiterLabel = $derived.by(() => {
		if (!tableInfo?.delimiter) return null;
		const named =
			tableInfo.delimiter === '\t' ? 'tab-separated' : tableInfo.delimiter === ',' ? 'comma-separated' : `separated by “${tableInfo.delimiter}”`;
		return tableInfo.delimiter_source === 'sniffed' ? `${named} (read from the file, not its name)` : named;
	});

	const refusals = $derived(ingest ? ingest.warnings.filter((w) => w.severity === 'refuse') : []);
	const warnings = $derived(ingest ? ingest.warnings.filter((w) => w.severity !== 'refuse') : []);

	const unitsEvidence = $derived.by(() => {
		const e = ingest?.time_units_evidence as
			{ reason?: string; yearsDated?: number; nonCalendarDated?: number; column?: string | null } | undefined;
		if (!e) return null;
		if (e.reason === 'column_name' && e.column) return `the date column is named “${e.column}”`;
		if (typeof e.yearsDated === 'number' && typeof e.nonCalendarDated === 'number') {
			return `read as years, ${e.yearsDated} of ${taxa.length} dated; read as generations, ${e.nonCalendarDated}`;
		}
		return null;
	});

	const headerFallbackCount = $derived(
		ingest && tableLoaded ? ingest.rows.filter((r) => r.source === 'header').length : (ingest?.coverage.from_header ?? 0)
	);

	// ---- reading files ---------------------------------------------------------------------------
	async function acceptFiles(list: FileList | File[] | null | undefined) {
		if (!list || list.length === 0) return;
		failure = null;
		busy = true;
		try {
			for (const file of Array.from(list).slice(0, 4)) {
				const text = await readText(file);
				const kind = classifyDropped(text, file.name);
				if (kind === 'alignment') {
					alignmentText = text;
					alignmentName = file.name;
					alignmentDigest = await digest(file.name, text);
				} else if (kind === 'tree') {
					treeText = text;
					treeName = file.name;
				} else if (isDateSource(kind)) {
					metadataText = text;
					metadataName = file.name;
					metadataDigest = await digest(file.name, text);
					idColumn = null;
					dateColumn = null;
				} else if (kind === 'beast') {
					failure = `${file.name} is a BEAST XML file. The reference reads taxon dates from one; PrimAeon does not yet. Export the taxon dates as a two-column CSV, or supply the alignment with dated headers.`;
				} else {
					failure = `${file.name} is not an alignment, a Newick tree, a delimited table or a Nextstrain JSON, so nothing could be read from it.`;
				}
			}
			if (!alignmentText) {
				failure = failure ?? 'Drop an alignment (FASTA, NEXUS or PHYLIP) — the review is one row per sequence in it.';
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onMetadataFile(files: FileList | null) {
		if (!files || files.length === 0) return;
		void acceptFiles(files);
	}

	function clearMetadata() {
		metadataText = null;
		metadataName = null;
		metadataDigest = null;
		idColumn = null;
		dateColumn = null;
	}

	function applyChange(patch: {
		idColumn?: string | null;
		dateColumn?: string | null;
		units?: TimeUnits;
		headerFallback?: boolean;
		archival1959?: boolean;
		customPattern?: string;
	}) {
		if ('idColumn' in patch) idColumn = patch.idColumn ?? null;
		if ('dateColumn' in patch) dateColumn = patch.dateColumn ?? null;
		if (patch.units) units = patch.units;
		if ('headerFallback' in patch) headerFallback = patch.headerFallback!;
		if ('archival1959' in patch) archival1959 = patch.archival1959!;
		if ('customPattern' in patch) customPattern = patch.customPattern!;
	}

	// ---- the record ------------------------------------------------------------------------------
	function options(): TimeSetOptions {
		return {
			units: ingest?.time_units ?? 'years',
			unitsInferred: ingest?.time_units_source === 'inferred',
			headerFallback,
			archival1959,
			customPattern: customPattern.trim() || null,
			idColumn: tableInfo?.strain_col ?? idColumn,
			dateColumn: tableInfo?.date_col ?? dateColumn,
			delimiter: tableInfo?.delimiter ?? null,
			dropUndated,
			rootMode: 'midpoint',
			outgroup: null,
			datingRoot,
			rootTaxon,
			clockModel: 'auto',
			ciMethod: 'fieller',
			excludedTaxa: [...excludedTaxa],
			useModel: usedModel,
			distanceMode
		};
	}

	function currentRecord() {
		if (!ingest) return null;
		return buildRecord({
			id: recordId ?? undefined,
			inputs: {
				alignmentName,
				alignmentText,
				alignmentDigest,
				treeName,
				treeText,
				metadataName,
				metadataText,
				metadataDigest
			},
			options: options(),
			ingest,
			ready: gate.ready,
			dating
		});
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		// Track what the reader can see change, then write at the store's own cadence.
		void ingest;
		void dropUndated;
		void dating;
		if (!ingest || !storageAvailable()) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const record = currentRecord();
			if (!record) return;
			if (!recordId) {
				recordId = record.id;
				try {
					replaceState(`${base}/time/?id=${record.id}`, {});
				} catch {
					// A prerendered shell opened without the router: the review still works, the URL
					// simply does not carry the id.
				}
			}
			// $state.snapshot: the record is assembled from runes, and IndexedDB cannot clone a Proxy.
			// This is the call site because the rune only exists in compiled Svelte files.
			saveTimeSet($state.snapshot({ ...record, id: recordId }) as TimeSetRecord).catch((err) => {
				storageNote = err instanceof Error ? err.message : String(err);
			});
		}, SAVE_INTERVAL_MS);
		return () => {
			if (saveTimer) clearTimeout(saveTimer);
		};
	});

	onMount(() => {
		const handoff = takeHandoff();
		if (handoff) {
			alignmentText = handoff.alignmentText;
			alignmentName = handoff.alignmentName;
			treeText = handoff.treeText;
			treeName = handoff.treeName;
			metadataText = handoff.metadataText ?? null;
			metadataName = handoff.metadataName ?? null;
			void (async () => {
				if (handoff.alignmentText) alignmentDigest = await digest(handoff.alignmentName ?? 'alignment', handoff.alignmentText);
			})();
			return;
		}
		const id = data.timeSetId;
		if (!id || !storageAvailable()) return;
		void (async () => {
			const stored = fromStored(await getTimeSet(id));
			if (!stored) return;
			recordId = stored.id;
			alignmentText = stored.inputs.alignmentText;
			alignmentName = stored.inputs.alignmentName;
			alignmentDigest = stored.inputs.alignmentDigest;
			treeText = stored.inputs.treeText;
			treeName = stored.inputs.treeName;
			metadataText = stored.inputs.metadataText;
			metadataName = stored.inputs.metadataName;
			metadataDigest = stored.inputs.metadataDigest;
			units = stored.options.unitsInferred ? null : stored.options.units;
			idColumn = stored.options.idColumn;
			dateColumn = stored.options.dateColumn;
			headerFallback = stored.options.headerFallback;
			archival1959 = stored.options.archival1959;
			customPattern = stored.options.customPattern ?? '';
			dropUndated = stored.options.dropUndated;
			datingRoot = stored.options.datingRoot;
			rootTaxon = stored.options.rootTaxon;
			excludedTaxa = [...stored.options.excludedTaxa];
			distanceMode = stored.options.distanceMode === 'tn93' ? 'tn93' : 'auto';
			usedModel = stored.options.useModel;
			dating = stored.dating;
		})();
	});

	/**
	 * Whether this build ships a dating graph. One same-origin read of `models/manifest.json`
	 * (about 1.5 kB), and only once the page has an alignment whose dates are usable — so the empty
	 * route, and a route whose dates are not ready, still request literally nothing. The manifest
	 * names no graph on a build that did not export one, and `'absent'` is then said in place rather
	 * than discovered by a reader who pressed a button.
	 */
	$effect(() => {
		if (!ingest || !gate.ready || modelProbe !== 'idle') return;
		modelProbe = 'checking';
		void (async () => {
			try {
				const res = await fetch(`${base}/models/manifest.json`, { cache: 'force-cache' });
				if (!res.ok) throw new Error(`models/manifest.json answered ${res.status}`);
				const doc = (await res.json()) as {
					variants?: Record<string, { taxa_onnx_sha256?: string; taxa_onnx_file?: string }>;
					default_variant?: string;
				};
				// The SAME rule the worker's `pickVariant` takes, so the probe cannot advertise a graph
				// the run would not load: `general` unless the manifest names another default.
				const name = doc.default_variant ?? 'general';
				const v = doc.variants?.[name];
				if (!v?.taxa_onnx_sha256) {
					modelProbe = 'absent';
					return;
				}
				modelGraph = { variant: name, file: v.taxa_onnx_file ?? `${name}_taxa.onnx`, sha256: v.taxa_onnx_sha256 };
				modelProbe = 'ready';
			} catch (err) {
				modelProbe = 'failed';
				modelProbeNote = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	// ---- the ancestor-date run -------------------------------------------------------------------

	/**
	 * The magic root strings the reference tests for (`dating.py:650`, `:659`) are passed through as
	 * `rootTaxon`, because that is the argument the reference itself uses for all four cases. Case 1
	 * is tested FIRST and case-sensitively, so a sequence actually named `earliest` wins — which is
	 * why the picker lists the sequence names separately rather than expecting a reader to type one.
	 */
	function rootArgument(): string | null {
		if (datingRoot === 'taxon') return rootTaxon;
		if (datingRoot === 'unweighted') return 'unweighted_consensus';
		if (datingRoot === 'earliest') return 'earliest';
		return null;
	}

	/** The dated rows, in alignment order — the one payload both estimates share. */
	function datedRows(): Array<{ taxon: string; value: number }> {
		return (ingest?.rows ?? [])
			.filter((r) => r.value != null && Number.isFinite(r.value))
			.map((r) => ({ taxon: r.taxon, value: r.value as number }));
	}

	/**
	 * What a finished run becomes. Both estimates land here, so the record's shape is identical
	 * whichever produced it and the section reads one object.
	 */
	function adopt(response: DatingResponse, model: boolean) {
		// The previous run is kept ONLY to compare distance modes; see `priorDating`'s declaration.
		priorDating = dating;
		usedModel = model;
		dating = {
			...response,
			ranAtIso: new Date().toISOString(),
			options: {
				root: datingRoot,
				rootTaxon,
				clockModel: 'auto',
				ciMethod: 'fieller',
				excludedTaxa: [...excludedTaxa],
				units: ingest?.time_units ?? 'years',
				useModel: model,
				distanceMode: model ? distanceMode : 'tn93'
			}
		};
	}

	async function estimateAncestor() {
		if (!ingest || !gate.ready || !workersAvailable()) return;
		datingFailure = null;
		datingProgress = 'Reading the alignment…';
		datingState = 'running';
		datingAbort = new AbortController();
		const request: DatingRequest = {
			alignmentText,
			alignmentName,
			dates: ingest.rows
				.filter((r) => r.value != null && Number.isFinite(r.value))
				.map((r) => ({ taxon: r.taxon, value: r.value as number })),
			rootTaxon: rootArgument(),
			excludedTaxa: [...excludedTaxa],
			clockModel: 'auto',
			ciMethod: 'fieller',
			timeUnits: ingest.time_units
		};
		try {
			const response = await datingClient().call<DatingResponse>(request, {
				signal: datingAbort.signal,
				onProgress: (_phase, done, total, message) => {
					datingProgress = total > 0 ? `${message} (${done} of ${total})` : message;
				}
			});
			adopt(response, false);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			// A cancel is not a failure, and it leaves whatever the previous run produced in place.
			if (e.name !== 'AbortError') datingFailure = e.message;
		} finally {
			datingState = 'idle';
			datingProgress = '';
			datingAbort = null;
		}
	}

	/**
	 * The same run WITH the model: a forward pass through `<variant>_taxa.onnx` over every codon,
	 * then the same estimator chain with the two matrices handed in. It is a second, separate action
	 * and not a checkbox on the first, for two reasons the section states in words: it downloads a
	 * 7.3 MB graph and takes seconds rather than milliseconds, and under the reference's own default
	 * it changes what divergence MEANS, so it produces a different record rather than more fields on
	 * the same one.
	 */
	async function estimateWithModel() {
		if (!ingest || !gate.ready || !workersAvailable()) return;
		datingFailure = null;
		datingProgress = 'Preparing the dating graph…';
		datingState = 'running';
		datingAbort = new AbortController();
		const request: DatingModelRequest = {
			alignmentText,
			alignmentName,
			dates: datedRows(),
			rootTaxon: rootArgument(),
			excludedTaxa: [...excludedTaxa],
			clockModel: 'auto',
			ciMethod: 'fieller',
			timeUnits: ingest.time_units,
			manifestUrl: absolute('/models/manifest.json'),
			modelsBase: absolute('/models/'),
			ortBase: absolute('/ort/'),
			numThreads: Math.max(1, Math.min(16, navigator?.hardwareConcurrency ?? 1)),
			distanceMode
		};
		try {
			const response = await datingModelClient().call<DatingResponse>(request, {
				signal: datingAbort.signal,
				onProgress: (_phase, done, total, message) => {
					datingProgress = total > 0 ? `${message} (${done} of ${total})` : message;
				}
			});
			adopt(response, true);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			if (e.name !== 'AbortError') datingFailure = e.message;
		} finally {
			datingState = 'idle';
			datingProgress = '';
			datingAbort = null;
		}
	}

	/** A worker's `location` is the bundle, so every URL it is handed has to be absolute. */
	function absolute(path: string): string {
		return new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost/').href;
	}

	function cancelEstimate() {
		datingAbort?.abort();
	}

	function setRoot(choice: DatingRootChoice, taxon: string | null) {
		datingRoot = choice;
		rootTaxon = taxon;
	}

	function toggleExcluded(taxon: string, on: boolean) {
		excludedTaxa = on ? [...excludedTaxa, taxon] : excludedTaxa.filter((t) => t !== taxon);
	}

	// ---- downloads and the hand-off back ---------------------------------------------------------
	function downloadCsv() {
		saveText('dates.csv', datesCsv(visibleRows.length ? visibleRows : rows), 'text/csv');
	}
	function downloadJson() {
		const record = currentRecord();
		if (record) saveText('dates.json', datesJson(record), 'application/json');
	}
	function downloadDatingJson() {
		if (dating?.ok) saveText(DATING_JSON_NAME, datingJson(dating), 'application/json');
	}
	function downloadDatingCsv() {
		if (dating?.ok) saveText(DATING_CSV_NAME, datingCsv(dating.rows), 'text/csv');
	}
	async function runSelection() {
		setHandoff({ alignmentText, alignmentName, treeText, treeName, metadataText, metadataName });
		await goto(`${base}/analyze/?autorun=1`);
	}
</script>

<svelte:head>
	<title>Dates — PrimAeon</title>
	<meta
		name="description"
		content="Review the sampling dates of a dated alignment before anything is run: which rule read each date, what was imputed, which metadata rows matched no sequence, and whether the dates carry a clock signal."
	/>
</svelte:head>

<article class="timepage numbered container">
	<header class="head">
		<h1>Dates</h1>
		<p class="meta">
			<span>{alignmentName ?? 'no alignment loaded'}</span>
			{#if treeName}<span>{treeName}</span>{/if}
			{#if metadataName}<span>{metadataName}</span>{/if}
			{#if ingest}<span>{ingest.coverage.taxa_total} sequences</span><span>{ingest.coverage.dated} dated</span
				><span>{ingest.time_units}</span>{/if}
		</p>
	</header>

	<section class="section" id="dates" aria-labelledby="dates-title">
		<header class="section__head">
			<h2 id="dates-title">Dates</h2>
			<p class="eyebrow">read by <code>@veg/hyphaeon-js</code>, the reference's own parsers</p>
		</header>

		<div class="review" data-state={viewState}>
			{#snippet dropHint()}
				FASTA, NEXUS or PHYLIP, optionally gzipped. Add a metadata CSV/TSV or a Nextstrain JSON if your
				dates are not in the headers, and a Newick tree with branch lengths if you have one. Or <u>choose files</u>.
			{/snippet}
			<DropZone
				title="Drop dated sequences here"
				hint={dropHint}
				accept=".fasta,.fa,.fna,.aln,.nex,.nexus,.phy,.phylip,.gz,.nwk,.newick,.tree,.tre,.csv,.tsv,.txt,.tab,.json"
				multiple
				{busy}
				onFiles={(files) => void acceptFiles(files)}
			/>

			{#if failure}
				<p class="notice--error" role="alert"><strong>Refused.</strong> {failure}</p>
			{/if}

			{#if ingest}
				{#each refusals as w (w.code)}
					<p class="notice--error" role="alert"><strong>Refused.</strong> {w.message}</p>
				{/each}

				{#if strip}
					<details class="strip">
						<summary><b>What we read from your files.</b> {strip.sentence}</summary>
						<table>
							<!-- NOT `<b>`, and that is the fix for a counter bug this phase inherited. `app.css`'s
							     `.numbered caption b::before` increments the table counter, but this caption lives
							     inside a CLOSED `<details>`, which is `display: none` and therefore increments
							     nothing — so the review table below was "Table 1" with the strip closed and
							     "Table 2" with it open, and two more tables on the page would have made that
							     visible. This caption keeps its look and leaves the counter alone; DESIGN.md §8
							     records the choice. -->
							<caption><span class="capname">Everything the date layer reported.</span> One row per diagnostic, in its own report order; severity is the same three-value scale the analysis report uses.</caption>
							<thead>
								<tr><th scope="col">Severity</th><th scope="col">Code</th><th scope="col">Message</th></tr>
							</thead>
							<tbody>
								{#each [...refusals, ...warnings] as w (w.code)}
									<tr>
										<td class="sev" class:sev--warn={w.severity === 'warn'}>{w.severity}</td>
										<td class="mono">{w.code}</td>
										<td>{w.message}</td>
									</tr>
								{/each}
								{#if refusals.length + warnings.length === 0}
									<tr><td colspan="3" class="faint">Nothing to report.</td></tr>
								{/if}
							</tbody>
						</table>
					</details>
				{/if}

				<MetadataDisclosure
					{metadataName}
					columns={tableInfo?.columns ?? []}
					idColumn={tableInfo?.strain_col ?? idColumn}
					idColumnSource={tableInfo?.strain_col_source ?? null}
					dateColumn={tableInfo?.date_col ?? dateColumn}
					dateColumnSource={tableInfo?.date_col_source ?? null}
					{delimiterLabel}
					units={ingest.time_units}
					unitsInferred={ingest.time_units_source === 'inferred'}
					{unitsEvidence}
					{headerFallback}
					{headerFallbackCount}
					{archival1959}
					archival1959Candidates={anchors}
					{customPattern}
					{patternError}
					patternMatches={(ingest.regex as { matched?: number } | null)?.matched ?? null}
					total={ingest.coverage.taxa_total}
					{onMetadataFile}
					onClearMetadata={clearMetadata}
					onChange={applyChange}
				/>

				<DateReviewTable rows={rows} tableName={metadataName} units={ingest.time_units} onVisible={(r) => (visibleRows = r)} />

				{#if unmatched}
					<p class="note note--warn">
						<strong>{unmatched.lead}</strong>, {unmatched.rest}
						<span class="mono">{unmatched.names.join(', ')}</span>{#if unmatched.more.length}
							<!-- The rest, behind a disclosure, because the first five are the diagnosis. -->
							<details class="more"><summary>and {unmatched.more.length} more</summary><span class="mono">{unmatched.more.join(', ')}</span></details>
						{/if}
						{#if (tableInfo?.numeric_names ?? 0) > 0}
							{tableInfo?.numeric_names} name{tableInfo?.numeric_names === 1 ? ' was' : 's were'} read as numbers
							(“12345” became “12345.0”); quote that column or export it as text.
						{/if}
					</p>
				{/if}

				<p class="gate">
					{#if gate.ready}
						These dates are ready to use: {ingest.coverage.dated} of {ingest.coverage.taxa_total} sequences
						dated, spanning {spanSentence(ingest.span, ingest.time_units)}.
					{:else}
						{#each gate.reasons as reason, i (i)}<span class="gate__reason">{reason}</span>{/each}
					{/if}
				</p>
				{#if bareNumbersDominate(ingest)}
					<label class="check">
						<input type="checkbox" bind:checked={acceptBareNumbers} />
						Those {bareNumberDates(ingest)} bare numbers really are {ingest.time_units}
					</label>
					<p class="hint">
						The rule that read them takes the first number in a name, whatever it means: an accession
						or an isolate index reads the same as a generation.
					</p>
				{/if}
				{#if ingest.coverage.undated > 0}
					<label class="check">
						<input type="checkbox" bind:checked={dropUndated} />
						Continue without the {ingest.coverage.undated} undated sequence{ingest.coverage.undated === 1 ? '' : 's'}
					</label>
					<p class="hint">
						The command line drops them silently; this page will record that it dropped them.
					</p>
				{/if}
			{:else if !failure}
				<p class="note">Nothing is loaded yet. Drop an alignment above and every sequence in it appears below, dated or not.</p>
			{/if}
		</div>
	</section>

	<section class="section" id="coverage" aria-labelledby="coverage-title">
		<header class="section__head">
			<h2 id="coverage-title">Coverage</h2>
			<p class="eyebrow">where the dates sit, and whether they carry a clock</p>
		</header>
		{#if ingest && ingest.coverage.dated > 0}
			<CoverageFigure rows={rows} units={ingest.time_units} span={ingest.span} />
			<ClockPreview preview={preview} {treeName} {crossCheck} />
		{:else}
			<p class="note">No sequence carries a date yet, so there is nothing to place on a time axis.</p>
		{/if}
	</section>

	<section class="section" id="dating" aria-labelledby="dating-title">
		<header class="section__head">
			<h2 id="dating-title">Ancestor date</h2>
			<p class="eyebrow"><code>hyphaeon dating --method all --no-tree</code>, ported</p>
		</header>
		{#if ingest}
			{#if datingFailure}
				<p class="notice--error" role="alert"><strong>The estimate failed.</strong> {datingFailure}</p>
			{/if}
			<DatingSection
				view={datingResult}
				figure={datingFigure}
				run={dating}
				units={ingest.time_units}
				ready={gate.ready}
				gateReasons={gate.reasons}
				state={datingState}
				progress={datingProgress}
				taxa={taxa}
				root={datingRoot}
				{rootTaxon}
				excludedCount={excludedTaxa.length}
				{alignmentName}
				{offer}
				{modelProbe}
				{modelGraph}
				{modelProbeNote}
				{modeShift}
				bind:distanceMode
				onRoot={setRoot}
				onRun={() => void estimateAncestor()}
				onRunModel={() => void estimateWithModel()}
				onCancel={cancelEstimate}
			/>
		{:else}
			<p class="note">Nothing is loaded yet, so there is nothing to date.</p>
		{/if}
	</section>

	<section class="section" id="taxa" aria-labelledby="taxa-title">
		<header class="section__head">
			<h2 id="taxa-title">Per-sequence dates</h2>
			<p class="eyebrow"><code>hyphaeon dating</code>'s per-taxon CSV, ported</p>
		</header>
		{#if dating?.ok && ingest}
			<p class="note">
				Every sequence the estimate saw, whether or not it was in the fit. Tick a row to leave it
				out and the button in section 3 re-reads; excluded sequences are named in the provenance below
				and in both downloads, so an estimate can never be quietly conditioned on a hidden exclusion.
			</p>
			{#if datingCaveat}
				<p class="note note--warn">
					<strong>The predicted dates are not dates here.</strong>
					{datingCaveat.text}
				</p>
			{/if}
			<TaxonDatingTable
				rows={datingTaxa}
				units={ingest.time_units}
				activeName={dating.activeName}
				excluded={excludedTaxa}
				onToggle={toggleExcluded}
			/>
			<div class="downloads">
				<button type="button" class="button button--secondary" onclick={downloadDatingCsv}>Dating (CSV)</button>
				<button type="button" class="button button--secondary" onclick={downloadDatingJson}>Dating (JSON)</button>
			</div>
			<p class="hint downloads__note">{DATING_DOWNLOAD_NOTE}</p>
		{:else}
			<p class="note">
				No estimate has been made yet. Section 3 starts one; this table is its per-sequence output —
				the label you supplied, the date the clock predicts, the gap between them, and whether the
				sequence was flagged or held out of the fit.
			</p>
		{/if}
	</section>

	<section class="section" id="data" aria-labelledby="data-title">
		<header class="section__head">
			<h2 id="data-title">Data and provenance</h2>
			<p class="eyebrow">what this page did, and what it did not do</p>
		</header>

		{#if ingest}
			<dl class="facts">
				<div><dt>Alignment</dt><dd>{alignmentName ?? 'pasted'} · {ingest.coverage.taxa_total} sequences{#if alignmentDigest?.sha256}<span class="qual mono">sha256 {alignmentDigest.sha256.slice(0, 12)}…</span>{/if}</dd></div>
				<div><dt>Dates from</dt><dd>{ingest.sources_used.join(', ') || 'nothing'}</dd></div>
				<div><dt>Time unit</dt><dd>{ingest.time_units} ({ingest.time_units_source})</dd></div>
				<div><dt>Name matching</dt><dd>{ingest.match_tier ?? 'not used'}{#if ingest.match_tier && ingest.match_tier !== 'exact'}<span class="qual">weaker than an exact comparison; every row says which tier matched it</span>{/if}</dd></div>
				<div><dt>Archival 1959 rule</dt><dd>{archival1959 ? 'applied' : 'off'}{#if anchors.length}<span class="qual">{anchors.length} sequence{anchors.length === 1 ? '' : 's'} would be affected</span>{/if}</dd></div>
				<div><dt>Tree</dt><dd>{treeName ?? 'none supplied'}{#if !preview.available}<span class="qual">no clock preview: {preview.code}</span>{/if}</dd></div>
				<div>
					<dt>Ancestor date</dt>
					<dd>
						{#if dating?.ok}
							{datingResult?.distanceMode === 'latent' ? 'latent-root divergences' : 'tree-free TN93'}, root {dating.rootDescription}
							<span class="qual"
								>{dating.selectedClock}; the page quotes {datingResult?.headline === 'pgls'
									? 'the generalised fit'
									: datingResult?.headline === 'spline'
										? 'the spline'
										: 'the straight line'}{datingResult && datingResult.headline !== datingResult.activeModel
									? ', because the selected model’s interval is degenerate upstream'
									: ''}. Excluded: {excludedTaxa.length === 0 ? 'none' : excludedTaxa.join(', ')}. No root
								search, no bootstrap, no random numbers anywhere on this path.</span
							>
						{:else}
							not estimated<span class="qual">section 3 starts it; the model-free estimate loads nothing</span>
						{/if}
					</dd>
				</div>
				<div>
					<dt>Dating graph</dt>
					<dd>
						{#if dating?.model}
							{dating.model.file} · {dating.model.variant}
							<span class="qual mono">sha256 {dating.model.sha256.slice(0, 12)}…</span>
							<span class="qual"
								>{dating.model.taxa} sequences × {dating.model.codons} codons in {dating.model.passSeconds.toFixed(1)} s at
								{dating.model.numThreads} thread{dating.model.numThreads === 1 ? '' : 's'}; every site, no taxon cap and
								no duplicate pruning, which is what the reference's dating pass reads.</span
							>
						{:else if modelProbe === 'absent'}
							not in this build<span class="qual">models/manifest.json declares no <span class="mono">taxa_onnx_sha256</span>, so the two model-based estimators cannot run</span>
						{:else if modelProbe === 'ready' && modelGraph}
							{modelGraph.file}, not loaded<span class="qual">section 3 offers it; nothing has been downloaded</span>
						{:else}
							not loaded<span class="qual">no graph has been requested on this route</span>
						{/if}
					</dd>
				</div>
			</dl>

			<div class="downloads">
				<button type="button" class="button button--secondary" onclick={downloadCsv} disabled={!gate.ready}>Dates (CSV)</button>
				<button type="button" class="button button--secondary" onclick={downloadJson} disabled={!gate.ready}>Dates (JSON)</button>
				<button type="button" class="button button--secondary" onclick={runSelection}>Run the selection report on this alignment</button>
			</div>
			<p class="hint downloads__note">
				Both files are PrimAeon's own: the CSV carries the columns <span class="mono">{DATES_CSV_COLUMNS.join(', ')}</span>,
				one row per sequence in the order the table is showing them, and the JSON carries a
				<span class="mono">{'{sequence: date}'}</span> map beside every option that produced it. Whether
				<span class="mono">hyphaeon dating</span> accepts a dates file, and in what shape, is not something
				this build has verified, so neither file claims to be a command-line input.
			</p>
			{#if storageNote}
				<p class="note note--warn"><strong>This review was not saved.</strong> {storageNote}</p>
			{/if}
		{/if}

		<p class="note">
			This page reads dates, shows what it read, and estimates an ancestor date from them. The
			default estimate loads nothing; the model-based one loads one graph and says so before it
			does. Four upstream quirks are replicated on purpose and worth naming here: the
			model-averaged row reads a deliberately skewed interval as a symmetric Gaussian one
			(<span class="mono">dating.py:2916</span>); the spline clock's own interval collapses to its
			point estimate because its bootstrap raises on every replicate
			(<span class="mono">dating.py:1917</span>); loading the model turns that same spline into a
			generalised fit on divergences that did not move
			(<span class="mono">dating.py:2844</span>); and the ridge the command line prints is not the
			ridge the generalised fit used — a fit built from Pagel's λ* ignores the ridge argument
			entirely (<span class="mono">dating.py:1352-1357</span>), so this page shows λ* and never both
			numbers under one word. The temporal-selection pillar — per-site trajectories, velocities and
			wave modes — is not ported; <span class="mono">hyphaeon temporal</span> computes it today at the
			command line.
		</p>
	</section>
</article>

<style>
	.timepage {
		margin-bottom: var(--space-10);
	}
	.head {
		border-bottom: 1px solid var(--text);
		padding-bottom: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.head h1 {
		margin: 0 0 var(--space-1);
	}
	.meta {
		margin: 0;
		max-width: none;
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.meta span + span::before {
		content: '\00b7';
		margin: 0 0.5rem;
		color: var(--text-faint);
	}
	.section {
		position: relative;
		padding-left: 2.5rem;
		margin-bottom: var(--space-10);
	}
	.section__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		border-bottom: 1px solid var(--rule);
		padding-bottom: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.section__head h2 {
		margin: 0;
	}
	.section__head h2::before {
		counter-increment: section;
		content: counter(section);
		position: absolute;
		left: 0;
		color: var(--text-muted);
		font-weight: 400;
	}
	.section__head .eyebrow {
		margin: 0 0 0 auto;
		font-size: var(--text-sm);
	}
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.strip {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.strip summary {
		max-width: var(--measure);
	}
	.strip table {
		margin-top: var(--space-3);
	}
	.sev {
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.gate {
		margin: 0;
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.gate__reason {
		display: block;
	}
	.check {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: var(--text-md);
	}
	.check input {
		accent-color: var(--brand);
		margin: 0;
	}
	.hint {
		margin: 0;
	}
	.more {
		display: inline;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-4);
		margin: 0 0 var(--space-5);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.facts div {
		margin: 0;
	}
	.facts dt {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	.qual {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
	.downloads__note {
		margin-bottom: var(--space-4);
	}
	.downloads {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.faint {
		color: var(--text-faint);
	}
	/* The strip caption's bold opening, which deliberately is not a `<b>`; see the markup. */
	.capname {
		color: var(--text);
		font-weight: 700;
	}
	@media (max-width: 40em) {
		.section {
			padding-left: 2rem;
		}
	}
</style>
