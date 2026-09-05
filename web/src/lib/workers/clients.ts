/**
 * clients.ts — the three worker clients, created lazily and shared by the page.
 *
 * WHY THIS FILE EXISTS. The `new Worker(new URL('./x.worker.ts', import.meta.url), { type:
 * 'module' })` form must be written literally for Vite to bundle the worker, and the URL is
 * relative to THIS file, so the constructors live beside the worker modules. Each client is a
 * module-level singleton: the analyze worker keeps its verified ORT session across runs (the
 * report's run and the phenotype run that follows it are two calls on that one worker) and the
 * prep worker is called on every input change. Nothing is created at import time; the first
 * `call()` starts the worker.
 */

import { WorkerClient } from './client';
import type {
	AnalyzeWorkerRequest,
	AnalyzeWorkerResponse,
	InferRequest,
	InferResponse,
	PrepRequest,
	PrepResponse
} from './protocol';

let prep: WorkerClient<PrepRequest, PrepResponse> | null = null;
let infer: WorkerClient<InferRequest, InferResponse> | null = null;
let analyze: WorkerClient<AnalyzeWorkerRequest, AnalyzeWorkerResponse> | null = null;

export function prepClient(): WorkerClient<PrepRequest, PrepResponse> {
	prep ??= new WorkerClient(() => new Worker(new URL('./prep.worker.ts', import.meta.url), { type: 'module' }));
	return prep;
}

export function inferClient(): WorkerClient<InferRequest, InferResponse> {
	infer ??= new WorkerClient(() => new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' }));
	return infer;
}

/** The one worker that runs every pillar and, on demand, the phenotype pillar (analyze.worker.ts). */
export function analyzeClient(): WorkerClient<AnalyzeWorkerRequest, AnalyzeWorkerResponse> {
	analyze ??= new WorkerClient(() => new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' }));
	return analyze;
}

/** True where Web Workers exist (a browser, not the prerenderer). */
export function workersAvailable(): boolean {
	return typeof Worker !== 'undefined';
}
