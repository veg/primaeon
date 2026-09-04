/**
 * clients.ts — the three worker clients, created lazily and shared by the page.
 *
 * WHY THIS FILE EXISTS. The `new Worker(new URL('./x.worker.ts', import.meta.url), { type:
 * 'module' })` form must be written literally for Vite to bundle the worker, and the URL is
 * relative to THIS file, so the constructors live beside the worker modules. Each client is a
 * module-level singleton: the inference worker keeps its verified ORT session across runs, the
 * tree worker its HyPhy instance, and the prep worker is called on every input change. Nothing
 * is created at import time; the first `call()` starts the worker.
 */

import { WorkerClient } from './client';
import type {
	InferRequest,
	InferResponse,
	PrepRequest,
	PrepResponse,
	TreeRequest,
	TreeResponse
} from './protocol';

let prep: WorkerClient<PrepRequest, PrepResponse> | null = null;
let tree: WorkerClient<TreeRequest, TreeResponse> | null = null;
let infer: WorkerClient<InferRequest, InferResponse> | null = null;

export function prepClient(): WorkerClient<PrepRequest, PrepResponse> {
	prep ??= new WorkerClient(() => new Worker(new URL('./prep.worker.ts', import.meta.url), { type: 'module' }));
	return prep;
}

export function treeClient(): WorkerClient<TreeRequest, TreeResponse> {
	tree ??= new WorkerClient(() => new Worker(new URL('./tree.worker.ts', import.meta.url), { type: 'module' }));
	return tree;
}

export function inferClient(): WorkerClient<InferRequest, InferResponse> {
	infer ??= new WorkerClient(() => new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' }));
	return infer;
}

/** True where Web Workers exist (a browser, not the prerenderer). */
export function workersAvailable(): boolean {
	return typeof Worker !== 'undefined';
}
