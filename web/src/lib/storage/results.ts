/**
 * results.ts — browser-local persistence of finished runs, over IndexedDB.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "Local runs persist in IndexedDB under the user's control";
 * the analyze flow writes one `ResultRecord` per run and navigates to `/results/<id>/`, which
 * reads it back by id. Adapted from datamonkey3/src/lib/utils/indexedDBStorage.js (main@fac1330,
 * `analysisStorage`): the same promise-wrapped `indexedDB.open` with a non-destructive
 * `onupgradeneeded` (create a store only when it does not exist, so a version bump never wipes
 * stored runs), the same `onblocked` surfacing (an upgrade blocked by another tab is reported, not
 * hung on), and the same `QuotaExceededError` translation into a sentence the user can act on.
 *
 * WHAT CHANGED FROM DM3, AND WHY.
 *   - One store, `runs`, keyed by `id`, with a `createdAt` index so the listing is ordered by the
 *     database rather than sorted in memory. DM3 kept `files` and `analyses` as two stores because
 *     its file records were re-run against many methods; here a record IS its inputs' provenance
 *     (names, sizes, sha256 of the texts) plus the result, and the texts the model used travel
 *     inside `result` (PLAN.md §4.5's site tree and entropy overlays need them).
 *   - Ids are `crypto.randomUUID()` when available and a 128-bit hex string from
 *     `crypto.getRandomValues` otherwise (PLAN.md §3.5 asks for 128-bit ids on the server; the
 *     browser gets the same width so a local id and a job id are indistinguishable in a URL).
 *   - The listing omits the result document (`ResultListing`) so a history view never round-trips
 *     every site table into memory — DM3's `getAllFiles` strips `content` for the same reason.
 *   - No `console.error` on every failure: errors are thrown with their cause and the caller
 *     decides. The one console line kept is DM3's `onblocked` warning, which has no caller to reach.
 *   - Typed arrays (the attention matrix, if a runtime keeps it) survive structured cloning, so
 *     nothing is serialised to JSON on the way in or out.
 *
 * `isAvailable()` exists because `indexedDB` is absent under SSR/prerender and in some private
 * modes; the page renders with storage disabled rather than throwing at import time. Nothing here
 * runs at module load.
 */

import type { ResultListing, ResultRecord } from '$lib/api';

export const DB_NAME = 'hyphaeon';
/**
 * Bump when a store or index is added; `onupgradeneeded` below must stay additive. Version 2
 * (Phase 2) adds the `reports` store (lib/storage/reports.ts) beside `runs`; the v1 `runs` records
 * are kept and read through `reports.ts`'s legacy wrapper rather than migrated in place. Version 3
 * (PrimAeon phase 2, the /time route) adds `timesets` (lib/storage/timesets.ts), a reviewed set of
 * sampling dates for one DATASET — which outlives any one run, and so cannot live on a report.
 */
export const DB_VERSION = 3;
export const RUNS_STORE = 'runs';
export const REPORTS_STORE = 'reports';
export const TIMESETS_STORE = 'timesets';
export const CREATED_INDEX = 'createdAt';

/** The message DM3 showed on QuotaExceededError, reworded for this app's vocabulary. */
export const QUOTA_MESSAGE =
	'Not enough browser storage to save this run. Delete some previous runs from the results page, or clear site data for this origin, and try again.';

export const BLOCKED_MESSAGE =
	'Database upgrade blocked by another open tab. Close other tabs running HyphAeon and reload.';

/** True where IndexedDB exists (a browser, not the prerenderer). */
export function isAvailable(): boolean {
	return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** A 128-bit id: `randomUUID` where it exists (secure contexts), else 32 hex chars from getRandomValues. */
export function newRunId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	const bytes = new Uint8Array(16);
	if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** The shared connection; `reports.ts` uses the same database and the same additive upgrade. */
export function openDb(): Promise<IDBDatabase> {
	if (!isAvailable()) {
		return Promise.reject(new Error('IndexedDB is not available in this context'));
	}
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
		request.onblocked = () => {
			console.warn('IndexedDB upgrade blocked: another open connection holds the previous version.');
			reject(new Error(BLOCKED_MESSAGE));
		};
		request.onupgradeneeded = () => {
			const db = request.result;
			// Additive only (DM3's lesson): never delete a store here.
			if (!db.objectStoreNames.contains(RUNS_STORE)) {
				const store = db.createObjectStore(RUNS_STORE, { keyPath: 'id' });
				store.createIndex(CREATED_INDEX, 'createdAt', { unique: false });
			}
			if (!db.objectStoreNames.contains(REPORTS_STORE)) {
				const store = db.createObjectStore(REPORTS_STORE, { keyPath: 'id' });
				store.createIndex(CREATED_INDEX, 'createdAt', { unique: false });
			}
			if (!db.objectStoreNames.contains(TIMESETS_STORE)) {
				const store = db.createObjectStore(TIMESETS_STORE, { keyPath: 'id' });
				store.createIndex(CREATED_INDEX, 'createdAt', { unique: false });
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			// If another tab upgrades later, drop our handle so the next call reopens at the new version.
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
	});
	// A failed open must not poison every later call.
	dbPromise.catch(() => {
		dbPromise = null;
	});
	return dbPromise;
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(translate(request.error));
	});
}

export function translate(err: DOMException | null): Error {
	if (err && err.name === 'QuotaExceededError') return new Error(QUOTA_MESSAGE, { cause: err });
	return err instanceof Error ? err : new Error(String(err ?? 'IndexedDB request failed'));
}

/** Store a finished run; resolves to its id. `put`, so re-saving the same id replaces it. */
export async function saveResult(record: ResultRecord): Promise<string> {
	if (!record.id) throw new Error('saveResult: record.id is required');
	const db = await openDb();
	const tx = db.transaction(RUNS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(RUNS_STORE).put(record));
	return record.id;
}

/** The whole record, or null when the id is unknown. */
export async function getResult(id: string): Promise<ResultRecord | null> {
	const db = await openDb();
	const tx = db.transaction(RUNS_STORE, 'readonly');
	const record = await requestToPromise(tx.objectStore(RUNS_STORE).get(id));
	return (record as ResultRecord | undefined) ?? null;
}

/** Every stored run without its result document, newest first. */
export async function listResults(): Promise<ResultListing[]> {
	const db = await openDb();
	const tx = db.transaction(RUNS_STORE, 'readonly');
	const index = tx.objectStore(RUNS_STORE).index(CREATED_INDEX);
	const rows: ResultListing[] = [];
	await new Promise<void>((resolve, reject) => {
		const cursor = index.openCursor(null, 'prev');
		cursor.onerror = () => reject(translate(cursor.error));
		cursor.onsuccess = () => {
			const c = cursor.result;
			if (!c) return resolve();
			const { result, ...envelope } = c.value as ResultRecord;
			rows.push({
				...envelope,
				sites: result?.summary?.totalSites ?? result?.sites?.length ?? 0,
				taxaUsed: result?.summary?.speciesUsed ?? 0
			});
			c.continue();
		};
	});
	return rows;
}

export async function deleteResult(id: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(RUNS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(RUNS_STORE).delete(id));
}

export async function clearResults(): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(RUNS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(RUNS_STORE).clear());
}

/** Test hook: forget the cached connection so the next call reopens. */
export function _resetConnection(): void {
	dbPromise = null;
}
