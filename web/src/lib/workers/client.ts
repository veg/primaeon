/**
 * client.ts — the main-thread side of a worker conversation: one call, progress callbacks, a
 * promise for the result, cancel through an AbortSignal.
 *
 * WHY THIS FILE EXISTS. Three workers share one envelope (protocol.ts); this is the one place
 * that turns `postMessage` traffic into a typed `call()`. The worker is created lazily on the
 * first call and kept for later ones, because the inference worker memoises its ORT session and
 * the tree worker its HyPhy module: terminating after every run would re-download nothing (the
 * browser caches) but would re-instantiate ~20 MB of WASM each time.
 *
 * CANCEL IS COOPERATIVE FIRST, DESTRUCTIVE SECOND. An aborted call posts `cancel`; the worker
 * aborts its own AbortController, which `runMeme` checks between batches and the diagnostics
 * loop cannot check at all (it is one synchronous call). If the worker has not answered within
 * `TERMINATE_AFTER_MS` of the cancel, it is terminated and every pending call is rejected with an
 * AbortError; the next call starts a fresh worker. The grace period exists so a routine cancel
 * during inference keeps the loaded session.
 *
 * Progress events for an id arrive on the callback that made the call; events for an unknown id
 * (a late message from a terminated conversation) are dropped.
 */

import type { FromWorker, ToWorker } from './protocol';

export const TERMINATE_AFTER_MS = 1500;

export type ProgressHandler = (phase: string, done: number, total: number, message: string) => void;
/** A finished (or, for DMS, partially filled) report section from the analyze worker. */
export type SectionHandler = (name: string, payload: unknown, final: boolean) => void;

export interface CallOptions {
	onProgress?: ProgressHandler;
	onSection?: SectionHandler;
	signal?: AbortSignal;
	/**
	 * Grace after a cancel before the worker is terminated; default TERMINATE_AFTER_MS. The analyze
	 * worker asks for much longer: a cancel during the DMS phase is scoped to the DMS by the
	 * orchestrator, which then finishes the record and returns it, and terminating the worker in the
	 * meantime would lose both the response and the warm ORT session.
	 */
	terminateAfterMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	onProgress?: ProgressHandler;
	onSection?: SectionHandler;
	cleanup: () => void;
}

export function abortError(message = 'Cancelled'): Error {
	const err = new Error(message);
	err.name = 'AbortError';
	return err;
}

export class WorkerClient<Req, Res> {
	private worker: Worker | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();

	/**
	 * @param factory creates the Worker; must be a static `new Worker(new URL('./x.worker.ts',
	 *   import.meta.url), { type: 'module' })` so Vite bundles it.
	 */
	constructor(private readonly factory: () => Worker) {}

	/** True while a worker exists (a session or module may be warm). */
	get alive(): boolean {
		return this.worker !== null;
	}

	call(payload: Req, options: CallOptions = {}): Promise<Res> {
		const { signal, onProgress, onSection, terminateAfterMs = TERMINATE_AFTER_MS } = options;
		if (signal?.aborted) return Promise.reject(abortError());
		const worker = this.ensureWorker();
		const id = this.nextId++;
		return new Promise<Res>((resolve, reject) => {
			let terminateTimer: ReturnType<typeof setTimeout> | null = null;
			const onAbort = () => {
				try {
					worker.postMessage({ id, kind: 'cancel' } satisfies ToWorker<Req>);
				} catch {
					// The worker may already be gone; the timer below finishes the job.
				}
				terminateTimer = setTimeout(() => {
					if (this.pending.has(id)) this.terminate(abortError());
				}, terminateAfterMs);
			};
			const cleanup = () => {
				signal?.removeEventListener('abort', onAbort);
				if (terminateTimer) clearTimeout(terminateTimer);
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				onProgress,
				onSection,
				cleanup
			});
			worker.postMessage({ id, kind: 'request', payload } satisfies ToWorker<Req>);
		});
	}

	/** Kill the worker and reject everything in flight. */
	terminate(reason: Error = new Error('Worker terminated')): void {
		const w = this.worker;
		this.worker = null;
		if (w) w.terminate();
		for (const [, p] of this.pending) {
			p.cleanup();
			p.reject(reason);
		}
		this.pending.clear();
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = this.factory();
		worker.onmessage = (event: MessageEvent<FromWorker<Res>>) => this.onMessage(event.data);
		worker.onerror = (event: ErrorEvent) => {
			// A script-level failure (the worker could not even load) has no id: fail every call.
			const err = new Error(event.message || 'Worker failed to start');
			this.terminate(err);
		};
		this.worker = worker;
		return worker;
	}

	private onMessage(msg: FromWorker<Res>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (msg.kind === 'progress') {
			p.onProgress?.(msg.phase, msg.done, msg.total, msg.message);
			return;
		}
		if (msg.kind === 'section') {
			p.onSection?.(msg.name, msg.payload, msg.final);
			return;
		}
		this.pending.delete(msg.id);
		p.cleanup();
		if (msg.kind === 'result') {
			p.resolve(msg.payload);
		} else {
			const err = new Error(msg.message);
			err.name = msg.name || 'Error';
			if (msg.stack) err.stack = msg.stack;
			p.reject(err);
		}
	}
}
