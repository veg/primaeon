/**
 * pool.js — a small fixed pool of analysis workers with a FIFO queue.
 *
 * WHY THIS FILE EXISTS
 *
 * The job manager (src/jobs.js) needs "run this task somewhere off the HTTP event loop, tell me
 * about progress and sections, let me cancel it, and survive a worker dying". This is that, and
 * nothing else: `size` workers built from src/worker.js, one task each, the rest queued in
 * arrival order; `run(task, hooks)` resolves with the worker's result or rejects with its
 * classified error; `cancel` sends a cooperative abort and, after `cancelGraceMs`, terminates and
 * replaces the worker. A worker that exits or errors while holding a task rejects that task with
 * `kind: "server"` and is replaced, so one crashing run never takes the queue down with it.
 *
 * Why not one worker per job: each worker holds its own ONNX sessions (~100 MB per variant) and
 * loading them takes seconds; a pool keeps them warm across jobs, which is what makes a 300 ms
 * bat_oas1 job possible after the first one. The default size is 1 (src/config.js): the model
 * already uses every ORT thread it is given, and two concurrent RHO jobs would each be slower
 * than the two run in sequence.
 *
 * Shutdown asks each worker to release its sessions first (worker.js `shutdown`): a worker
 * terminated with a live onnxruntime-node session can abort the process (PHASE1.md).
 */

import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./worker.js", import.meta.url);

/**
 * @param {object} opts
 * @param {number} [opts.size]           workers, default 1
 * @param {object} [opts.env]            environment for the workers (HYPHAEON_MODELS_DIR, ...)
 * @param {number} [opts.threads]        ORT threads per worker
 * @param {number} [opts.temporalPermBudget}  work cap on the temporal null (src/config.js)
 * @param {number} [opts.cancelGraceMs]  default 5000
 * @param {object} [opts.logger]
 */
export function createPool(opts = {}) {
  const size = Math.max(1, opts.size || 1);
  const logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const cancelGraceMs = opts.cancelGraceMs ?? 5000;
  const workers = [];
  const queue = [];
  let seq = 0;
  let closed = false;
  let statusSeq = 0;
  const statusWaiters = new Map();

  function spawn() {
    const w = {
      worker: new Worker(WORKER_URL, { workerData: { env: opts.env || {}, threads: opts.threads, temporalPermBudget: opts.temporalPermBudget } }),
      ready: false,
      task: null
    };
    w.worker.on("message", (msg) => onMessage(w, msg));
    w.worker.on("error", (err) => {
      logger.error("worker error: " + (err && err.message));
      failTask(w, { kind: "server", message: "The analysis worker crashed: " + ((err && err.message) || err) });
      replace(w);
    });
    w.worker.on("exit", (code) => {
      if (w.task) failTask(w, { kind: "server", message: "The analysis worker exited (code " + code + ") while running the job." });
      replace(w);
    });
    workers.push(w);
    return w;
  }

  function replace(w) {
    const i = workers.indexOf(w);
    if (i !== -1) workers.splice(i, 1);
    if (!closed) {
      spawn();
      pump();
    }
  }

  function failTask(w, error) {
    const t = w.task;
    if (!t) return;
    w.task = null;
    if (t.graceTimer) clearTimeout(t.graceTimer);
    t.reject(Object.assign(new Error(error.message), error));
  }

  function onMessage(w, msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        w.ready = true;
        pump();
        break;
      case "log":
        if (typeof logger[msg.level] === "function") logger[msg.level]("worker: " + msg.message);
        break;
      case "status": {
        const waiter = statusWaiters.get(msg.requestId);
        if (waiter) {
          statusWaiters.delete(msg.requestId);
          msg.error ? waiter.reject(new Error(msg.error)) : waiter.resolve(msg.status);
        }
        break;
      }
      case "progress":
      case "section":
      case "done":
      case "error": {
        const t = w.task;
        if (!t || t.id !== msg.id) return;
        if (msg.type === "progress") {
          try {
            t.hooks.progress && t.hooks.progress(msg.phase, msg.done, msg.total, msg.message);
          } catch (err) {
            logger.warn("progress hook threw: " + err.message);
          }
        } else if (msg.type === "section") {
          try {
            t.hooks.onSection && t.hooks.onSection(msg.name, msg.payload, { final: msg.final });
          } catch (err) {
            logger.warn("section hook threw: " + err.message);
          }
        } else {
          w.task = null;
          if (t.graceTimer) clearTimeout(t.graceTimer);
          if (msg.type === "done") t.resolve(msg.result);
          else t.reject(Object.assign(new Error(msg.error.message), msg.error));
          pump();
        }
        break;
      }
      default:
        break;
    }
  }

  function pump() {
    if (closed) return;
    for (const w of workers) {
      if (!w.ready || w.task) continue;
      const t = queue.shift();
      if (!t) return;
      t.worker = w;
      w.task = t;
      try {
        t.hooks.onStart && t.hooks.onStart();
      } catch {
        // advisory
      }
      w.worker.postMessage({ type: "run", id: t.id, task: t.task });
    }
  }

  for (let i = 0; i < size; i++) spawn();

  return {
    size,
    /** Queued tasks not yet started. */
    get pending() {
      return queue.length;
    },
    /** Tasks currently on a worker. */
    get active() {
      return workers.filter((w) => w.task).length;
    },
    /**
     * @param {object} task   structured-cloneable job description (src/runner.js `run`)
     * @param {{progress?: Function, onSection?: Function, onStart?: Function}} [hooks]
     * @returns {{id: string, promise: Promise<object>, cancel: (reason?: string) => void}}
     */
    run(task, hooks = {}) {
      if (closed) throw new Error("pool is closed");
      const id = String(++seq);
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = { id, task, hooks, resolve, reject, worker: null, graceTimer: null };
      queue.push(entry);
      pump();
      return {
        id,
        promise,
        cancel(reason = "cancelled") {
          const qi = queue.indexOf(entry);
          if (qi !== -1) {
            queue.splice(qi, 1);
            reject(Object.assign(new Error(reason), { kind: "cancelled", message: reason }));
            return;
          }
          const w = entry.worker;
          if (!w || w.task !== entry) return;
          w.worker.postMessage({ type: "cancel", id, reason });
          entry.graceTimer = setTimeout(() => {
            if (w.task !== entry) return;
            logger.warn("worker did not acknowledge cancel within " + cancelGraceMs + " ms; terminating it");
            failTask(w, { kind: "cancelled", message: reason });
            w.worker.terminate().catch(() => {});
          }, cancelGraceMs);
          if (entry.graceTimer.unref) entry.graceTimer.unref();
        }
      };
    },
    /** The first ready worker's engine status (models, runtime, ORT version). */
    status(timeoutMs = 15000) {
      const w = workers.find((x) => x.ready) || workers[0];
      if (!w) return Promise.reject(new Error("no worker"));
      const requestId = String(++statusSeq);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          statusWaiters.delete(requestId);
          reject(new Error("worker status timed out"));
        }, timeoutMs);
        if (timer.unref) timer.unref();
        statusWaiters.set(requestId, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          }
        });
        w.worker.postMessage({ type: "status", requestId });
      });
    },
    async close(graceMs = 10000) {
      closed = true;
      for (const t of queue.splice(0)) t.reject(Object.assign(new Error("server shutting down"), { kind: "cancelled" }));
      await Promise.all(
        workers.splice(0).map(
          (w) =>
            new Promise((resolve) => {
              const timer = setTimeout(() => {
                w.worker.terminate().catch(() => {});
                resolve();
              }, graceMs);
              w.worker.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              if (w.task) failTask(w, { kind: "cancelled", message: "server shutting down" });
              try {
                w.worker.postMessage({ type: "shutdown" });
              } catch {
                w.worker.terminate().catch(() => {});
              }
            })
        )
      );
    }
  };
}
