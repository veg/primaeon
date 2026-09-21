/**
 * beast.ts — what a dropped BEAST XML fills, what it does not, and the sentences that say so.
 *
 * WHY THIS FILE EXISTS. Every other file `/time` accepts answers one question: this is the
 * alignment, or the tree, or the dates. A BEAST XML can answer all three from one document
 * (`parse_beast_xml`, dataset.py:84-233, returns `sequences`, `dates` AND `tree_newick`), so
 * dropping one file can fill three slots at once. Two consequences, and this module is both:
 *
 * ONE, THE PRECEDENCE RULE IS THE REFERENCE'S OWN AND IT IS NOT "LAST FILE WINS". `run_mrca_dating`
 * (dating.py:2455-2471) and `cmd_autoclock` (cli.py:1591-1598) fill each slot from the XML only
 * `if <slot> is None` — an explicitly named alignment, tree or dates file always beats the XML. A
 * CLI has argument names; a drop zone has only the order the browser happened to enumerate the
 * files in, so the page classifies everything first, assigns the explicitly-typed files, and only
 * then calls `placeBeast` with the slots that are still empty. Without that two-pass order,
 * dropping a FASTA and an XML together would give a different alignment depending on drop order —
 * a wrong answer with a green light.
 *
 * TWO, A READER WHO DROPS ONE FILE AND GETS AN ALIGNMENT, 98 DATES AND A TREE HAS TO BE TOLD THAT
 * IS WHAT HAPPENED. `intake()` is that sentence, and it names every slot the XML offered, including
 * the ones it did NOT get to fill and why. It is printed unconditionally above the review, not
 * inside the `details` strip, because a fact about what the page did with your file is not a
 * disclosure.
 *
 * AND THE DATE ARITHMETIC IS NOT THE APP'S. `_parse_numeric_or_calendar_date` (dataset.py:62-81) is
 * the reference's fourth string-to-time function and it is the one a BEAST date goes through:
 * `YYYY-MM-DD` becomes `year + (month-1)/12 + (day-1)/365.25` and `YYYY-MM` becomes
 * `year + (month-0.5)/12`, neither of which is a decimal year. MEASURED by the runtime's port
 * against the library's own conversion over all 731 dates of 2019-2020: mean offset 0.001988 yr =
 * 0.726 days, worst 0.007706 yr = 2.815 days (2019-03-31, BEAST 2019.2488021902807 against
 * 2019.2410958904109). `dateScaleLine()` says so in the review, beside the table, because a reader
 * comparing this page against `hyphaeon dating --beast` must be able to find out which arithmetic
 * produced their numbers without opening a disclosure — and `beastCalendarOf()` renders the "Reads
 * as" column by INVERTING the reference's formula rather than the library's, so column 4 agrees
 * with the string in column 7 instead of landing two days away from it (measured: 2019-03-31 comes
 * back out of the library's inverse as 2019-04-02).
 */

import type { BeastDocument, BeastSummary } from '@veg/hyphaeon-runtime/dates';

export type { BeastDocument, BeastSummary };

/** The three slots a BEAST XML can fill, and whether each was already occupied when it landed. */
export interface OccupiedSlots {
	alignment: boolean;
	tree: boolean;
	dates: boolean;
}

/**
 * What happened to one slot.
 *
 * `taken` — the XML filled it; `already-supplied` — the XML offered it and an explicitly-typed file
 * had it first (dating.py's `if … is None`); `not-offered` — this XML carries nothing for it;
 * `discarded` — it filled the slot and the reader then cleared that file. The last one exists
 * because the metadata slot has a Clear button and the XML may BE what is in it: forgetting that
 * the file ever carried dates would leave the intake note describing a page that no longer exists.
 */
export type SlotOutcome = 'taken' | 'already-supplied' | 'not-offered' | 'discarded';

export interface BeastPlacement {
	fileName: string;
	version: string;
	alignment: SlotOutcome;
	tree: SlotOutcome;
	dates: SlotOutcome;
	/** Counts, for the sentence: how many sequences and how many dates the file actually holds. */
	sequences: number;
	dateCount: number;
	treePresent: boolean;
	/**
	 * Whether this document is the page's DATE SOURCE — which is not the same question as whether
	 * `dates` is `taken`. An XML that holds no date at all still occupies the empty dates slot, so
	 * the date layer is the one that says `DATES_BEAST_NO_DATES` or `DATES_BEAST_NOT_BEAST` about it.
	 * Measured before this existed: dropping a FASTA and a non-BEAST XML together produced the
	 * generic "no sequence could be dated" and not one word about the XML.
	 */
	dateSource: boolean;
}

/**
 * Place one parsed XML against the slots that are still empty. Pure: it decides, the caller
 * assigns.
 */
export function placeBeast(parsed: BeastDocument, occupied: OccupiedSlots, fileName = 'the XML'): BeastPlacement {
	const sequences = parsed.sequences?.size ?? 0;
	const dateCount = parsed.dates?.size ?? 0;
	const treePresent = Boolean(parsed.tree_newick);
	const decide = (offered: boolean, taken: boolean): SlotOutcome =>
		!offered ? 'not-offered' : taken ? 'taken' : 'already-supplied';
	return {
		fileName,
		version: parsed.version,
		alignment: decide(sequences > 0, !occupied.alignment),
		tree: decide(treePresent, !occupied.tree),
		dates: decide(dateCount > 0, !occupied.dates),
		sequences,
		dateCount,
		treePresent,
		dateSource: !occupied.dates
	};
}

export interface BeastIntake {
	/** The bold opening: how many things came out of the one file. */
	lead: string;
	/** The rest of the sentence: what they were. */
	rest: string;
	/** One clause per slot the XML offered and did not get, or an empty list. */
	notTaken: string[];
}

const SLOT_WORDS = {
	alignment: 'the alignment',
	dates: 'the sampling dates',
	tree: 'the starting tree'
} as const;

function capitalise(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `"a, b and c"`. */
function list(parts: string[]): string {
	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The sentence above the review: what the page took out of the XML, in the words of the slots.
 *
 * Returns `null` when the file contributed nothing at all — a document that parsed but held nothing
 * has already been refused by `DATES_BEAST_NOT_BEAST`, and repeating that as an intake note would
 * be two voices on one fact.
 */
export function intake(placement: BeastPlacement | null): BeastIntake | null {
	if (!placement) return null;
	const took: string[] = [];
	if (placement.alignment === 'taken') took.push(`${SLOT_WORDS.alignment} (${placement.sequences} sequences)`);
	if (placement.dates === 'taken') took.push(`${placement.dateCount} sampling dates`);
	if (placement.tree === 'taken') took.push(SLOT_WORDS.tree);
	// Whole sentences, capitalised, because the page prints them one per line under the lead and a
	// caller that had to punctuate them would be writing copy in the markup.
	const notTaken: string[] = [];
	for (const slot of ['alignment', 'dates', 'tree'] as const) {
		const word = capitalise(SLOT_WORDS[slot]);
		if (placement[slot] === 'already-supplied') {
			notTaken.push(`${word} in it was not used, because you supplied one yourself.`);
		} else if (placement[slot] === 'discarded') {
			notTaken.push(`${word} in it was used and then cleared by you.`);
		}
	}
	if (took.length === 0 && notTaken.length === 0) return null;
	const count = took.length === 1 ? 'one thing' : took.length === 2 ? 'two things' : 'three things';
	return {
		lead:
			took.length === 0
				? `${placement.fileName} was read as ${placement.version}, and nothing from it is in use.`
				: `${placement.fileName} was read as ${placement.version}, and ${count} came out of it:`,
		rest:
			took.length === 0
				? ''
				: `${list(took)}. The reference composes the same file the same way — each slot is taken only when you have not supplied one yourself (dating.py:2467-2471), which is its \`--beast\` door. The MCP tools and the HTTP server take the same file through the OTHER one, \`-d run.xml\` (dating.py:433-442): the dates and nothing else, with whatever else it carried reported rather than used. Same dates there, fewer inputs, deliberately.`,
		notTaken
	};
}

/**
 * `ingestDates(...).beast` for a document the ingest never saw.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND SUMMARY. Everything the page says about a BEAST file
 * — the intake note, the provenance lines, the date-scale line, the whole diagnostics table — hangs
 * off `ingest.beast`, and `ingest` is `null` until there is an ALIGNMENT: `/time` reviews one row
 * per sequence, so with no sequences there is no review and nothing to hang a warning on. That is
 * exactly the state a namespaced BEAST 2 file leaves the page in.
 *
 * MEASURED on `<beast xmlns="http://beast2.org" version="2.6">` with two `<sequence>` elements and
 * a date `<trait>`, dropped by itself: `parseBeastXml` returns version "BEAST 2", 0 sequences,
 * 0 dates, `namespaced: true` — the reference's own answer, because `parse_beast_xml` searches for
 * unqualified tags (`root.findall('.//data')`, dataset.py:123-127) and ElementTree names every
 * element of a namespaced document `{uri}local`. The reader is right and says so with
 * `DATES_BEAST_NAMESPACED`; the PAGE then threw the whole diagnosis away, because no alignment
 * meant no ingest, and printed "Drop an alignment (FASTA, NEXUS or PHYLIP)" — not one word about
 * the file the reader had just dropped.
 *
 * So this projects the parsed document into the shape the display helpers already read. It is not a
 * new summary: `provenance` is spread whole, so a field added to the runtime's own `beastSummary`
 * flows through here without an edit, and the four keys below it are the ones that live outside
 * `provenance` on the document (`version`, the two Map sizes and the tree).
 */
export function beastSummaryOfDocument(doc: BeastDocument | null | undefined): BeastSummary | null {
	if (!doc) return null;
	const p = doc.provenance;
	return {
		...p,
		version: doc.version,
		sequences: doc.sequences?.size ?? 0,
		dates: doc.dates?.size ?? 0,
		taxa: doc.taxa?.length ?? 0,
		tree_present: Boolean(doc.tree_newick),
		tree_newick: doc.tree_newick,
		entities: p.doctype_entities
	} as unknown as BeastSummary;
}

/**
 * The refusal when a dropped XML leaves the page with no alignment: what the reference read out of
 * the file, why it read that, and what to do about it.
 *
 * THE NAMESPACE CLAUSE IS THE COMMON CASE, NOT THE EDGE ONE. A BEAST 2 document whose root carries
 * `xmlns=` is read as EMPTY by `parse_beast_xml` — not refused, not warned about: `root.findall`
 * with unqualified tags matches nothing in it, so the function returns 0 sequences and 0 dates and
 * the reference dates nothing. PrimAeon replicates that arithmetic exactly (the port's rule: never
 * improve during a port) and the whole value of doing so is that the reader is TOLD, here, rather
 * than handed the same silent zero with a different font.
 *
 * Returns `null` when the file did supply an alignment — then the page has an ingest and the date
 * layer is the one voice.
 */
export function noAlignmentRefusal(beast: BeastSummary | null | undefined, fileName: string | null): string | null {
	if (!beast || beast.sequences > 0) return null;
	const name = fileName ?? 'The XML';
	const read =
		`${name} was read as ${beast.version} and carries no sequences ` +
		`(${beast.dates} date${beast.dates === 1 ? '' : 's'}, ${beast.tree_present ? 'a starting tree' : 'no starting tree'}), ` +
		`so there is nothing for the review to be one row per.`;
	if (beast.namespaced) {
		return (
			`${read} It declares an XML NAMESPACE on its root element, and that is why: \`parse_beast_xml\` searches ` +
			`for unqualified tags (dataset.py:123-127), so a namespaced document matches nothing in it and the ` +
			`reference reads the same 0 sequences and 0 dates out of this file — silently. PrimAeon replicates the ` +
			`reference rather than improving on it, and says so instead. Remove the \`xmlns\` attribute from the root ` +
			`element and \`hyphaeon dating --beast\` will read it too, or export the alignment as FASTA and the dates ` +
			`as a two-column CSV.`
		);
	}
	return `${read} Drop an alignment (FASTA, NEXUS or PHYLIP) beside it, or export this document's sequences yourself.`;
}

/**
 * The date-scale line: printed whenever ANY date came from a calendar string, because that is
 * exactly when the reference's arithmetic and the app's decimal year disagree. A file of bare
 * decimal years (`1980.0`) round-trips through both unchanged and gets no line, which is why the
 * count and not the source is the trigger.
 */
export function dateScaleLine(beast: BeastSummary | null | undefined): string | null {
	const n = beast?.calendar_dates ?? 0;
	if (!n) return null;
	const total = beast?.dates ?? n;
	return (
		`${n} of ${total} date${total === 1 ? '' : 's'} came from a calendar string, and the BEAST reader ` +
		`converts one with its OWN arithmetic (dataset.py:71-80): “YYYY-MM-DD” becomes ` +
		`year + (month−1)/12 + (day−1)/365.25, and “YYYY-MM” becomes year + (month−0.5)/12. ` +
		`Neither is the decimal year every other source on this page is converted to ` +
		`(temporal.py:137-141): measured over all 731 dates of 2019–2020 the two differ by 0.73 days on ` +
		`average and by 2.815 days at worst. These numbers are the reference's own, so ` +
		`“hyphaeon dating --beast” will agree with them — and the same dates in a CSV will not.`
	);
}

/**
 * A BEAST date back to a calendar date, by inverting THE REFERENCE'S formula.
 *
 * `dateReview.calendarOf` inverts the library's `year + (days since 1 Jan)/daysInYear`, which is
 * the right inverse for every other source and the WRONG one here: 2019-03-31 enters as
 * 2019.2488021902807 and comes back out of `calendarOf` as 2019-04-02. Showing a reader a day they
 * did not write, beside the string they did, reads as a bug and hides the real divergence. So the
 * `beast_ymd` and `beast_year_month` rules are inverted with their own arithmetic:
 *
 *   ymd:        frac = (m-1)/12 + (d-1)/365.25, and (d-1)/365.25 <= 30/365.25 = 0.0821 < 1/12,
 *               so m-1 = floor(frac*12) is exact and d follows from the remainder.
 *   year-month: frac = (m-0.5)/12, so m = round(frac*12 + 0.5); the day was never in the string.
 *
 * `beast_float` has no calendar meaning at all — the reference takes `float(s)` and stops — so it
 * returns `null` and the caller renders the number itself.
 */
export function beastCalendarOf(value: number, rule: string): string | null {
	if (!Number.isFinite(value)) return null;
	const year = Math.floor(value);
	const frac = value - year;
	if (rule === 'beast_year_month') {
		const month = Math.round(frac * 12 + 0.5);
		return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
	}
	if (rule !== 'beast_ymd') return null;
	const month = Math.floor(frac * 12) + 1;
	const day = Math.round((frac - (month - 1) / 12) * 365.25) + 1;
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The provenance lines for the strip: how the file was read, in the order a reader asks.
 *
 * Every one of these is something `parse_beast_xml` decides silently, and three of them can change
 * every number on the page: which `<alignment>` block won, whether `direction="backwards"` was
 * ignored (it always is — dataset.py never reads the attribute), and whether the `seq_` prefix
 * renamed a sequence.
 */
export function beastProvenanceLines(beast: BeastSummary | null | undefined, fileName: string | null): string[] {
	if (!beast) return [];
	const lines: string[] = [];
	lines.push(
		`${fileName ?? 'The XML'} was read as ${beast.version}: ${beast.sequences} sequence(s), ${beast.dates} date(s)` +
			`${beast.tree_present ? `, and a starting tree from ${beast.tree_from ?? 'an element of the document'}` : ', and no starting tree'}.`
	);
	if (beast.alignments.seen > 1) {
		const sizes = beast.alignments.sizes.map((s) => `${s.size}`).join(', ');
		lines.push(
			`It holds ${beast.alignments.seen} alignment blocks (${sizes} sequences); the reference keeps only the ` +
				`largest and discards the rest without a word (dataset.py:152, “max(candidates, key=len)”, ties to the first).`
		);
	}
	if (beast.dates_from.beast1 && beast.dates_from.beast2) {
		lines.push(
			`${beast.dates_from.beast1} date(s) came from BEAST 1 “<taxon><date>” elements and ` +
				`${beast.dates_from.beast2} from a BEAST 2 date trait; the trait pass runs second and overwrites on a clash.`
		);
	}
	if (beast.direction_attrs > 0 || beast.units_attrs > 0) {
		lines.push(
			`${beast.direction_attrs} “direction” and ${beast.units_attrs} “units” attribute(s) were present and ` +
				`read by nothing: the reference converts the “value” string alone, so “direction=backwards” ` +
				`(ages before present) is stored as a forward year.`
		);
	}
	if (beast.reconciliation.renamed.length) {
		lines.push(
			`${beast.reconciliation.renamed.length} sequence(s) were RENAMED across the “seq_” prefix to match a ` +
				`date (dataset.py:196-198), so the taxon names below are not the XML's sequence ids.`
		);
	}
	if (beast.namespaced) {
		lines.push(
			`This document declares an XML namespace. The reference searches for unqualified tags ` +
				`(dataset.py:123), so a namespaced BEAST file reads as empty upstream; PrimAeon reads it the ` +
				`same way and says so rather than showing you a silent zero.`
		);
	}
	return lines;
}
