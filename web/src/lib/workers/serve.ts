/**
 * serve.ts — the worker side of the envelope in protocol.ts: dispatch requests to a handler,
 * post progress, answer once per id, honour cancel.
 *
 * WHY THIS FILE EXISTS. The three workers differ only in what they compute; the message plumbing
 * (id bookkeeping, error serialisation, an AbortController per request that `cancel` trips) is
 * identical and lives here once. A handler receives `(payload, ctx)` where `ctx.progress`
 * posts a progress event and `ctx.signal` is the request's abort signal; whatever it returns is
 * the `result` payload, whatever it throws becomes an `error` message with the Error's name kept
 * (so an `AbortError` from the runtime reaches the page as one).
 *
 * Requests on one worker run one at a time, in order. The prep worker is called on every input
 * change, and running two diagnoses concurrently would only make both slower; the inference worker
 * must never interleave two `runMeme`s on one ORT session.
 */

import type { FromWorker, ToWorker } from './protocol';

export interface HandlerContext {
	progress: (phase: string, done: number, total: number, message: string) => void;
	signal: AbortSignal;
}

export type Handler<Req, Res> = (payload: Req, ctx: HandlerContext) => Promise<Res> | Res;

function post<Res>(msg: FromWorker<Res>, transfer?: Transferable[]): void {
	if (transfer && transfer.length) (self as unknown as Worker).postMessage(msg, transfer);
	else (self as unknown as Worker).postMessage(msg);
}

/** Install the handler on `self`. Call once at the top level of a worker module. */
export function serve<Req, Res>(handler: Handler<Req, Res>): void {
	const controllers = new Map<number, AbortController>();
	let queue: Promise<void> = Promise.resolve();

	self.onmessage = (event: MessageEvent<ToWorker<Req>>) => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;
		if (msg.kind === 'cancel') {
			controllers.get(msg.id)?.abort();
			return;
		}
		if (msg.kind !== 'request') return;
		const { id, payload } = msg;
		const controller = new AbortController();
		controllers.set(id, controller);
		queue = queue.then(async () => {
			try {
				if (controller.signal.aborted) throw abortError();
				const result = await handler(payload, {
					signal: controller.signal,
					progress: (phase, done, total, message) => post<Res>({ id, kind: 'progress', phase, done, total, message })
				});
				post<Res>({ id, kind: 'result', payload: result });
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				post<Res>({ id, kind: 'error', name: e.name || 'Error', message: e.message, stack: e.stack });
			} finally {
				controllers.delete(id);
			}
		});
	};
}

export function abortError(message = 'Cancelled'): Error {
	const err = new Error(message);
	err.name = 'AbortError';
	return err;
}
