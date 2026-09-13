/**
 * jobs.test.js — the in-process job store, and what a cancel keeps.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 6's review found a cancelled temporal job throwing away a record the runtime had already
 * finished: `runTemporalNull` catches its own abort, classifies at the draw count it reached and
 * `runTemporal` resolves with a complete record, and the store's pump early-returned on the
 * cancelled status and dropped the value. The end-to-end proof is in temporal.test.js, which stops
 * a real 10,000-draw null; this file pins the same rule at the store, where the race between the
 * cancel and the runner unwinding can be driven exactly rather than slept on — and where a runner
 * that REJECTS after a cancel, the other half of the rule, costs nothing to test.
 *
 * No model, no engine, no SDK: the store is a Map and five calls.
 */

import { describe, it, expect } from "vitest";
import { createJobStore } from "../src/jobs.js";

/**
 * One turn of the event loop. The store starts a runner on a microtask (`Promise.resolve().then`)
 * and settles it on another, so every assertion about "has it started" or "has it landed" is an
 * assertion about a later turn, not this one.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A job whose runner resolves (or rejects) only when the test says so. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createJobStore: a cancel that keeps the answer the runner finished anyway", () => {
  it("keeps a value that arrives after the cancel, labels it partial, and never calls it completed", async () => {
    const store = createJobStore();
    const d = deferred();
    let sawSignal = null;
    const job = store.create({ analysis: "temporal", run: (signal) => { sawSignal = signal; return d.promise; } });

    expect(store.get(job.job_id).status).toBe("running");
    await tick();
    const cancelled = store.cancel(job.job_id);
    expect(cancelled.status).toBe("cancelled");
    expect(sawSignal.aborted).toBe(true);
    // Between the cancel and the runner unwinding there is a window, and it is reported as itself:
    // not "nothing here" (which may be false in a moment) and not a result (which does not exist).
    expect(cancelled.partial_result).toBe(false);
    expect(cancelled.result_pending).toBe(true);
    expect(cancelled.result_available).toBe(false);
    expect(store.kept(job.job_id)).toBeUndefined();

    d.resolve({ record: { stage: "complete" }, permutations: { completed: 41, requested: 1000 } });
    await tick();

    const after = store.get(job.job_id);
    expect(after.status).toBe("cancelled");
    expect(after.partial_result).toBe(true);
    expect(after.result_pending).toBe(false);
    expect(after.result_available).toBe(true);
    // `result()` still means "the finished answer" and must never hand a partial to an old caller.
    expect(store.result(job.job_id)).toBeUndefined();
    const kept = store.kept(job.job_id);
    expect(kept.value.permutations.completed).toBe(41);
    expect(kept.settled).toBe(true);
    store.close();
  });

  it("keeps nothing when the runner rejects after the cancel, and says so", async () => {
    const store = createJobStore();
    const d = deferred();
    const job = store.create({ analysis: "temporal", run: () => d.promise });
    await tick();
    store.cancel(job.job_id);
    d.reject(new Error("HyphAeon run cancelled"));
    await tick();

    const after = store.get(job.job_id);
    expect(after.status).toBe("cancelled");
    expect(after.partial_result).toBe(false);
    expect(after.result_pending).toBe(false);
    expect(after.result_available).toBe(false);
    expect(store.kept(job.job_id)).toBeUndefined();
    // The job stays cancelled: a rejection after a cancel is not a failure to report to a client.
    expect(after.error).toBeUndefined();
    store.close();
  });

  it("a job cancelled while queued has nothing to settle, and does not hold up the queue", async () => {
    const store = createJobStore({ maxConcurrent: 1 });
    const first = deferred();
    const a = store.create({ analysis: "temporal", run: () => first.promise });
    const b = store.create({ analysis: "temporal", run: () => Promise.resolve("b") });
    expect(store.get(b.job_id).status).toBe("queued");

    const cancelled = store.cancel(b.job_id);
    expect(cancelled.status).toBe("cancelled");
    // Never started, so nothing is coming and nothing is pending — the surface can say "kept
    // nothing" at once rather than telling a client to poll for a record that cannot exist.
    expect(cancelled.result_pending).toBe(false);
    expect(cancelled.partial_result).toBe(false);

    first.resolve("a");
    await tick();
    expect(store.get(a.job_id).status).toBe("completed");
    expect(store.result(a.job_id)).toBe("a");
    store.close();
  });

  it("wait() does not return `cancelled, nothing here` while the record is still on its way", async () => {
    const store = createJobStore();
    const d = deferred();
    const job = store.create({ analysis: "temporal", run: () => d.promise });
    await tick();
    store.cancel(job.job_id);
    const waiting = store.wait(job.job_id, 1000, 5);
    setTimeout(() => d.resolve({ kept: true }), 20);
    const view = await waiting;
    expect(view.status).toBe("cancelled");
    expect(view.partial_result).toBe(true);
    expect(store.kept(job.job_id).value).toEqual({ kept: true });
    store.close();
  });

  it("a completed job is untouched by all of this", async () => {
    const store = createJobStore();
    const job = store.create({ analysis: "meme", run: () => Promise.resolve({ sites: [] }) });
    const done = await store.wait(job.job_id, 1000, 5);
    expect(done.status).toBe("completed");
    expect(done.result_available).toBe(true);
    expect(done.partial_result).toBeUndefined();
    expect(store.kept(job.job_id)).toBeUndefined();
    // Cancelling a finished job reports its final status and changes nothing.
    expect(store.cancel(job.job_id).status).toBe("completed");
    expect(store.result(job.job_id)).toEqual({ sites: [] });
    store.close();
  });
});
