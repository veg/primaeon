/**
 * worker.js — the analysis worker thread: one runner, one job at a time, messages in and out.
 *
 * WHY THIS FILE EXISTS
 *
 * onnxruntime-node runs a forward pass on its own thread pool but the JavaScript around it (the
 * tokeniser, the MDS, the permutation null, the writers) runs on whichever event loop called it.
 * Run in the HTTP process, a 20-second RHO job would stall every `/api/v1/jobs/:id` poll and every
 * SSE heartbeat for twenty seconds. So analyses run in `node:worker_threads` workers (PLAN.md 3.5
 * "jobs run in a worker pool") and the HTTP loop only relays messages. This file is the worker
 * side: it builds one `createRunner` (its own ONNX sessions, memoised per variant), accepts one
 * `run` message at a time, streams `progress` and `section` messages back, and answers `done` or
 * `error`.
 *
 * Cancellation is cooperative first: `cancel` aborts the AbortController the runner's signal came
 * from, the runtime checks it between batches (runtime/src/predict.js `throwIfAborted`), and the
 * worker answers `error {kind:"cancelled"}`. If it has not answered within the pool's grace period
 * the pool terminates and replaces the worker (src/pool.js).
 *
 * Shutdown releases the ONNX sessions before the thread exits: onnxruntime-node 1.23.2 aborts
 * the whole process ("mutex lock failed", SIGABRT) when a session is still alive at exit
 * (PHASE1.md integration changes), and a worker's exit counts.
 */

import { parentPort, workerData, isMainThread } from "node:worker_threads";
import { createRunner } from "./runner.js";

if (isMainThread) {
  throw new Error("worker.js is the worker_threads entry; import src/pool.js instead");
}

const env = Object.assign({}, process.env, (workerData && workerData.env) || {});
const runner = createRunner({
  env,
  threads: workerData && workerData.threads,
  logger: {
    debug: (m) => post({ type: "log", level: "debug", message: m }),
    info: (m) => post({ type: "log", level: "info", message: m }),
    warn: (m) => post({ type: "log", level: "warn", message: m }),
    error: (m) => post({ type: "log", level: "error", message: m })
  }
});

/** @type {Map<string, AbortController>} */
const active = new Map();

function post(msg) {
  try {
    parentPort.postMessage(msg);
  } catch (err) {
    // A section payload that cannot be structured-cloned must not kill the run.
    parentPort.postMessage({ type: "log", level: "warn", message: "worker: could not post " + msg.type + ": " + err.message });
  }
}

function plain(value) {
  // Structured clone handles typed arrays and plain objects; class instances (library graphs,
  // Maps with prototype methods) are flattened through JSON so the parent always gets data.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function handleRun(msg) {
  const { id, task } = msg;
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const result = await runner.run(task, {
      signal: controller.signal,
      progress: (phase, done, total, message) => post({ type: "progress", id, phase, done, total, message }),
      onSection: (name, payload, meta) => post({ type: "section", id, name, payload: plain(payload), final: !!(meta && meta.final) })
    });
    post({ type: "done", id, result: plain(result) });
  } catch (err) {
    post({
      type: "error",
      id,
      error: {
        kind: controller.signal.aborted ? "cancelled" : err.kind || "server",
        message: err.message || String(err),
        hint: err.hint,
        code: err.code
      }
    });
  } finally {
    active.delete(id);
  }
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "run":
      handleRun(msg);
      break;
    case "cancel": {
      const c = active.get(msg.id);
      if (c) c.abort(new Error(msg.reason || "cancelled"));
      break;
    }
    case "status":
      runner.status().then(
        (status) => post({ type: "status", requestId: msg.requestId, status }),
        (err) => post({ type: "status", requestId: msg.requestId, error: err.message })
      );
      break;
    case "shutdown":
      for (const c of active.values()) c.abort(new Error("shutdown"));
      runner
        .close()
        .catch(() => {})
        .then(() => {
          post({ type: "shutdown-done" });
          // Let the message flush, then end the thread with the sessions released.
          setImmediate(() => process.exit(0));
        });
      break;
    default:
      break;
  }
});

post({ type: "ready" });
