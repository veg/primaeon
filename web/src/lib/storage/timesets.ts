/**
 * timesets.ts — browser-local persistence of a `/time` date review, over the same IndexedDB
 * connection the runs and the reports use.
 *
 * WHY A NEW STORE AND NOT A FIELD ON `ReportRecord`. A date set belongs to a DATASET; a report is
 * one selection RUN. Hanging the reviewed dates off a report would mean a reader who re-runs loses
 * their review, and a reader who has run nothing — which is every reader on `/time` in this phase —
 * would have nowhere to keep one at all.
 *
 * THE VERSION BUMP IS SAFE BECAUSE THE UPGRADE WAS ALWAYS ADDITIVE. `results.ts`'s
 * `onupgradeneeded` creates a store only when it does not already exist, which is the property its
 * header exists to record; `DB_VERSION` 2 → 3 therefore creates `timesets` and touches neither
 * `runs` nor `reports`, and a v2 database opened by this build keeps every stored report. Keep that
 * true.
 *
 * The API mirrors `reports.ts` name for name (`save` / `get` / `delete` / `list`, newest first, the
 * listing without the bulky field) so a reader of one file can read the other.
 */

import type { TimeSetListing, TimeSetRecord } from '$lib/time/types';
import { QUOTA_MESSAGE, isAvailable, newRunId, openDb, requestToPromise, translate } from './results';

export const TIMESETS_STORE = 'timesets';
export const CREATED_INDEX = 'createdAt';

/** How often the page rewrites the record while the reader edits; `reports.ts`'s own cadence. */
export const SAVE_INTERVAL_MS = 2000;

export { QUOTA_MESSAGE, isAvailable, newRunId };

/** Store a review; resolves to its id. `put`, so re-saving the same id replaces it. */
export async function saveTimeSet(record: TimeSetRecord): Promise<string> {
	if (!record.id) throw new Error('saveTimeSet: record.id is required');
	// THE RECORD MUST ALREADY BE PLAIN. IndexedDB stores through the structured clone algorithm,
	// which refuses a Proxy, and every value a Svelte 5 rune hands out is one: the write fails with
	// "#<Object> could not be cloned", the caller's catch reports that the review was not saved, and
	// nothing reaches the store. Measured on the /time route with the Korber alignment, where the id
	// reached the address bar and `timesets` stayed empty. The un-proxying belongs at the call site,
	// because `$state.snapshot` is a compiler rune and exists only inside .svelte and .svelte.ts —
	// calling it from this plain module throws "$state is not defined" at runtime, which is the
	// second way this same bug appeared.
	const db = await openDb();
	const tx = db.transaction(TIMESETS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(TIMESETS_STORE).put(record));
	return record.id;
}

export async function getTimeSet(id: string): Promise<TimeSetRecord | null> {
	const db = await openDb();
	const tx = db.transaction(TIMESETS_STORE, 'readonly');
	const record = await requestToPromise(tx.objectStore(TIMESETS_STORE).get(id));
	return (record as TimeSetRecord | undefined) ?? null;
}

export async function deleteTimeSet(id: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(TIMESETS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(TIMESETS_STORE).delete(id));
}

/** Every stored review without its entries, newest first. */
export async function listTimeSets(): Promise<TimeSetListing[]> {
	const db = await openDb();
	const tx = db.transaction(TIMESETS_STORE, 'readonly');
	const index = tx.objectStore(TIMESETS_STORE).index(CREATED_INDEX);
	const rows: TimeSetListing[] = [];
	await new Promise<void>((resolve, reject) => {
		const cursor = index.openCursor(null, 'prev');
		cursor.onerror = () => reject(translate(cursor.error));
		cursor.onsuccess = () => {
			const c = cursor.result;
			if (!c) return resolve();
			const { dates, inputs, ...envelope } = c.value as TimeSetRecord;
			rows.push({
				...envelope,
				dated: dates?.summary?.dated ?? 0,
				total: dates?.summary?.total ?? 0,
				alignmentName: inputs?.alignmentName ?? null
			});
			c.continue();
		};
	});
	return rows;
}
