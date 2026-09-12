/**
 * handoff.ts — carrying a dropped or pasted dataset from the landing page to the analysis page.
 *
 * WHY THIS FILE EXISTS. The landing page reads the reader's files as text and then navigates; the
 * analysis page needs that text. The first implementation parked it in `sessionStorage` and reported
 * a failure to write as "this browser blocks session storage". That message was wrong, and it was
 * wrong in the worst way: it sent a reader off to audit their browser settings for a problem that
 * was ours.
 *
 * WHAT ACTUALLY HAPPENS. `sessionStorage` is capped at about five megabytes per origin, and the
 * value being written is the whole alignment inside a JSON string. Measured against the deployed
 * site on 2026-09-11: an upload of 3.69 MB runs, 5.08 MB and 7.39 MB both fail, and the failure is a
 * `QuotaExceededError` from `setItem`, not a blocked API. The reporter's browser was fine. Their
 * dataset was simply bigger than the channel, which is a normal size for surveillance data and will
 * only become more normal now that the time-aware analyses are coming.
 *
 * THE CHANNEL IS MEMORY, NOT STORAGE. Navigation between these two routes is client-side, so a
 * module-scoped variable survives it and has no size limit at all. `sessionStorage` is kept only as
 * a best-effort fallback for the one case memory cannot serve — a hard reload of the analysis page —
 * and it is allowed to fail silently, because when it does the run still works. Nothing here throws,
 * and nothing here reports a browser problem that is not one.
 *
 * WHAT IS LOST. If the reader hard-reloads the analysis page with a dataset above the storage cap,
 * the hand-off is gone and the page shows its ordinary empty state. That is the correct trade: the
 * common path works at every size, and the rare path degrades instead of refusing.
 */

export type Handoff = {
	alignmentText: string;
	alignmentName: string | null;
	treeText: string | null;
	treeName: string | null;
	/**
	 * A metadata table carrying sampling dates, when the reader supplied one. Only /time sets these;
	 * every other caller leaves them undefined, and the analysis page ignores them.
	 */
	metadataText?: string | null;
	metadataName?: string | null;
};

/** The key the fallback uses. Unchanged, so a hand-off written by an older build is still read. */
export const HANDOFF_KEY = 'hyphaeon:handoff';

/**
 * The real channel: a module-scoped value. It survives client-side navigation, costs nothing to
 * write and has no ceiling.
 */
let pending: Handoff | null = null;

/**
 * Park a dataset for the analysis page. Never throws, and never reports a storage problem: the
 * durable copy is a convenience, not the mechanism.
 */
export function setHandoff(handoff: Handoff): void {
	pending = handoff;
	try {
		sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
	} catch {
		// Over the quota, or storage genuinely unavailable. Either way the in-memory hand-off above
		// is what the next page reads, so there is nothing to tell the reader and nothing to do.
	}
}

/**
 * Take the parked dataset, if there is one, and clear it. Memory wins over storage, so a hand-off
 * too large for the fallback is still delivered whole.
 *
 * @returns the dataset, or null when the page was opened without one
 */
export function takeHandoff(): Handoff | null {
	const fromMemory = pending;
	pending = null;

	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem(HANDOFF_KEY);
		sessionStorage.removeItem(HANDOFF_KEY);
	} catch {
		raw = null;
	}

	if (fromMemory) return fromMemory;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Handoff>;
		if (typeof parsed?.alignmentText !== 'string') return null;
		return {
			alignmentText: parsed.alignmentText,
			alignmentName: parsed.alignmentName ?? null,
			treeText: parsed.treeText ?? null,
			treeName: parsed.treeName ?? null
		};
	} catch {
		return null;
	}
}

/** Drop anything parked. For a page that decides not to consume the hand-off after all. */
export function clearHandoff(): void {
	pending = null;
	try {
		sessionStorage.removeItem(HANDOFF_KEY);
	} catch {
		// Nothing to clear if storage is unavailable.
	}
}
