/**
 * jobs.js — in-process job store for analysis runs that do not fit inside a tool call.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: an analysis tool answers in the call under the synchronous caps and otherwise
 * "returns a job id". The run happens in THIS process (src/engine.js over onnxruntime-node) and
 * this process is the only place that knows about it, so the store is a Map in memory — no redis,
 * no scheduler. That is deliberate: datamonkey-js-server's SLURM path was rejected for v1 because
 * scheduling latency exceeds the runtimes (PLAN.md 3.1, option D). The store is written so that
 * `server/` can later replace it with something durable behind the same five calls.
 *
 * Contract:
 *   - ids are 128-bit hex (PLAN.md 3.5 "128-bit job ids"); they are the only handle a client has;
 *   - statuses: queued -> running -> completed | failed | cancelled;
 *   - a job runs at most MAX_CONCURRENT at a time (two loaded ONNX sessions on a laptop is
 *     already ~1 GB of RSS, PLAN.md 1); the rest wait in FIFO order as "queued";
 *   - cancel aborts the runner's AbortSignal (the runtime checks it between batches) and marks
 *     the job;
 *   - completed jobs expire after JOB_TTL_MS and the map is bounded by MAX_JOBS (oldest
 *     terminal jobs evicted first), because a process-local map has no other ceiling.
 *
 * Completion notifications over the transport are best-effort, exactly as datamonkey-js-server's
 * job-notifier.js documents: polling job_status is the source of truth. The store exposes an
 * `onTerminal` hook the server uses for that; a missed notification never loses a job.
 *
 * PARTIAL RESULTS (Phase 2, hyphaeon_analyze). The report of PLAN.md 4.0 streams section by
 * section — sites, gene, epistasis, attribution, filter, then DMS last and slowest — and the
 * runtime's `runEverything` fires `onSection(name, payload, {final})` as each lands. A runner
 * may hand those to the store through the third argument of `run`, `publish(partial)`, and
 * `partial(id)` returns the latest one while the job is still running, so `get_results
 * section=sites` answers before DMS has finished and `job_status` lists `sections_ready`. The
 * final `result` replaces the partial when the run resolves; a partial is never returned for a
 * completed job.
 *
 * A CANCELLED RUN MAY STILL HAVE AN ANSWER, AND THE STORE KEEPS IT (Phase 6). Every pillar before
 * this one answered a cancel by throwing, so "cancelled" and "nothing to show" were the same fact
 * and the pump could drop whatever the runner settled with. `runTemporal` is built the other way
 * round: `runTemporalNull` CATCHES its own abort, classifies at the draw count it reached and
 * `runTemporal` resolves with a COMPLETE record (`stage: 'complete'`, `permutations.cancelled`
 * true, `completed < requested`, and a TEMPORAL_NULL_TRUNCATED warning), because per-draw
 * substreams make a stopped run bit-identical to one configured at that B — the whole reason the
 * runtime is written that way. MEASURED through the running tool in this session (H5N1_HA_geo,
 * 98 x 566, time_points 60, -B 10,000, cancelled 1.5 s into the null): the run resolved with a
 * `stage: "complete"` record at 4,364 of 10,000 draws, 168 stage-one candidates, 16 confirmed
 * sweeps and a p-grid of 2.29e-4. Dropping that value threw away an answer the machine had already
 * paid for, so the pump now KEEPS a value that arrives after a cancel:
 *
 *   - `job.result` is set and `result_partial` is true (never `status: "completed"`: the run did
 *     not do what it was asked, and the surface must say so at what count — src/time.js
 *     `temporalPartialNote` supplies the sentence, the store only carries the flag);
 *   - `publicView` exposes `result_available` / `partial_result` / `result_pending`, the last of
 *     these for the window between the cancel and the runner unwinding (measured at 75-78 ms on
 *     that run, which is why `wait` keeps waiting for a cancelled job to settle rather than
 *     answering "cancelled, nothing here" while the record is still on its way);
 *   - a runner that REJECTS after a cancel (the abort reached one of `runTemporal`'s
 *     `throwIfAborted` calls before the null began — measured by cancelling 30 ms in) keeps
 *     nothing, `result_pending` goes false and the surface says so plainly instead of offering a
 *     result that does not exist.
 *
 * The server's job store keeps a cancelled record too (server/src/jobs.js); this is the same rule
 * on the process-local map.
 */

import { randomBytes } from "node:crypto";
import { JOB_TTL_MS, MAX_JOBS } from "./caps.js";

export const MAX_CONCURRENT = 2;

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {{ttlMs?: number, maxJobs?: number, maxConcurrent?: number, onTerminal?: (job: object) => void}} [opts]
 */
export function createJobStore(opts = {}) {
  const ttlMs = opts.ttlMs ?? JOB_TTL_MS;
  const maxJobs = opts.maxJobs ?? MAX_JOBS;
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT;
  const onTerminal = typeof opts.onTerminal === "function" ? opts.onTerminal : null;

  /** @type {Map<string, object>} */
  const jobs = new Map();
  const queue = [];
  let running = 0;

  const sweep = setInterval(() => reap(), Math.min(ttlMs, 60 * 60 * 1000));
  if (sweep.unref) sweep.unref();

  function reap() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of jobs) {
      if (job._terminalAt && job._terminalAt < cutoff) jobs.delete(id);
    }
    if (jobs.size > maxJobs) {
      const terminal = [...jobs.values()]
        .filter((j) => j._terminalAt)
        .sort((a, b) => a._terminalAt - b._terminalAt);
      for (const j of terminal) {
        if (jobs.size <= maxJobs) break;
        jobs.delete(j.id);
      }
    }
  }

  function publicView(job) {
    const out = {
      job_id: job.id,
      analysis: job.analysis,
      status: job.status,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at
    };
    if (job.started_at) {
      const end = job.finished_at ? Date.parse(job.finished_at) : Date.now();
      out.elapsed_sec = Math.round((end - Date.parse(job.started_at)) / 100) / 10;
    }
    if (job.status === "queued") out.queue_position = queue.indexOf(job.id) + 1;
    if (job.progress) out.progress = job.progress;
    if (job.error) out.error = job.error;
    out.result_available = job.status === "completed" || (job.status === "cancelled" && job.result !== undefined);
    if (job.status === "cancelled") {
      // Three facts, not one: whether a record survived the cancel, whether one may still arrive,
      // and — when it did — that it is PARTIAL. A `result_available: true` with no `partial_result`
      // beside it would let a client read a stopped run as a finished one.
      out.partial_result = job.result !== undefined;
      out.result_pending = job.result === undefined && !job._settled;
      if (job.cancelled_at) out.cancelled_at = job.cancelled_at;
    }
    if (job.status === "running" && job.partial && Array.isArray(job.partial.sections_ready)) {
      out.sections_ready = [...job.partial.sections_ready];
    }
    return out;
  }

  function finish(job, status, patch) {
    job.status = status;
    job.finished_at = nowIso();
    job._terminalAt = Date.now();
    Object.assign(job, patch);
    running--;
    if (onTerminal) {
      try {
        onTerminal(publicView(job));
      } catch {
        // notification is best-effort
      }
    }
    pump();
  }

  function pump() {
    while (running < maxConcurrent && queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== "queued") continue;
      job.status = "running";
      job.started_at = nowIso();
      running++;
      // The runner may report progress in the runtime's `(phase, done, total, message)` shape;
      // the latest report is what job_status shows. Advisory: a throwing sink never fails a run.
      const report = (phase, done, total, message) => {
        job.progress = { phase, done, total, message, at: nowIso() };
      };
      // `publish({value, sections_ready})` stores an intermediate result (see the header). The
      // store keeps only the latest; the caller decides what a partial holds. Advisory as well.
      const publish = (partial) => {
        if (job.status !== "running") return;
        job.partial = partial && typeof partial === "object" ? Object.assign({ at: nowIso() }, partial) : null;
      };
      Promise.resolve()
        .then(() => job._run(job._controller.signal, report, publish))
        .then(
          (value) => {
            if (job.status === "cancelled") {
              // THE ANSWER THE RUNTIME FINISHED ANYWAY. See the header: a cancelled temporal run
              // resolves with a complete record at the achieved draw count, and dropping it threw
              // away work that had already been done. Kept, flagged partial, never "completed".
              job.partial = null;
              job.result = value;
              job.result_partial = true;
              job.result_at = nowIso();
              job._settled = true;
              return;
            }
            job.partial = null;
            finish(job, "completed", { result: value });
          },
          (err) => {
            if (job.status === "cancelled") {
              // The abort reached a `throwIfAborted` instead: nothing usable was produced, and the
              // surface must not offer a result that does not exist.
              job._settled = true;
              job.cancel_error = { kind: (err && err.kind) || "server", message: (err && err.message) || String(err) };
              return;
            }
            finish(job, "failed", {
              error: {
                kind: (err && err.kind) || "server",
                message: (err && err.message) || String(err),
                hint: err && err.hint
              }
            });
          }
        );
    }
  }

  return {
    /**
     * @param {{analysis: string, options?: object,
     *   run: (signal: AbortSignal, report: Function, publish: (partial: {value: any, sections_ready?: string[]}) => void) => Promise<any>}} spec
     * @returns {object} public view of the new job
     */
    create(spec) {
      reap();
      const id = randomBytes(16).toString("hex");
      const job = {
        id,
        analysis: spec.analysis,
        options: spec.options || {},
        status: "queued",
        created_at: nowIso(),
        started_at: null,
        finished_at: null,
        result: undefined,
        result_partial: false,
        result_at: null,
        partial: null,
        error: undefined,
        cancelled_at: null,
        cancel_error: null,
        _run: spec.run,
        _controller: new AbortController(),
        _terminalAt: null,
        // Only meaningful once `status` is "cancelled": whether the runner's promise has settled.
        _settled: false
      };
      jobs.set(id, job);
      queue.push(id);
      pump();
      return publicView(job);
    },
    get(id) {
      const job = jobs.get(id);
      return job ? publicView(job) : null;
    },
    result(id) {
      const job = jobs.get(id);
      return job && job.status === "completed" ? job.result : undefined;
    },
    /**
     * The value a CANCELLED job's runner resolved with after the cancel, or undefined when it
     * rejected, has not unwound yet, or the job was never cancelled. Deliberately a separate call
     * from `result(id)`: every existing caller of that one means "the finished answer", and a
     * partial record must never reach one of them by accident.
     *
     * @returns {{value: any, at: string, settled: boolean, error: object|null}|undefined}
     */
    kept(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "cancelled" || job.result === undefined) return undefined;
      return { value: job.result, at: job.result_at, settled: !!job._settled, error: job.cancel_error || null };
    },
    /** Has a cancelled job's runner finished unwinding (so `kept` is final)? */
    settled(id) {
      const job = jobs.get(id);
      return job ? !!job._settled : false;
    },
    /** The latest published partial of a RUNNING job (`{value, sections_ready, at}`), else undefined. */
    partial(id) {
      const job = jobs.get(id);
      return job && job.status === "running" && job.partial ? job.partial : undefined;
    },
    /**
     * Resolve when the job reaches a terminal state or `timeoutMs` elapses; returns the public
     * view either way (the caller reads `status`). Used by hyphaeon_analyze to answer inside the
     * call when the report finishes in time and to hand back the id otherwise.
     */
    async wait(id, timeoutMs, stepMs = 50) {
      const t0 = Date.now();
      for (;;) {
        const job = jobs.get(id);
        if (!job) return null;
        // A CANCELLED JOB IS NOT DONE UNTIL ITS RUNNER HAS UNWOUND. `cancel` marks the job the
        // instant it is asked to, so a caller waiting inside the tool call would otherwise return
        // "cancelled, nothing here" in the 75-78 ms the record measured to arrive in on the H5N1
        // run. Bounded by the same timeout as everything else.
        const settling = job.status === "cancelled" && !job._settled;
        if (job.status !== "queued" && job.status !== "running" && !settling) return publicView(job);
        if (Date.now() - t0 >= timeoutMs) return publicView(job);
        await new Promise((r) => setTimeout(r, Math.min(stepMs, Math.max(1, timeoutMs - (Date.now() - t0)))));
      }
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return publicView(job);
      }
      const wasRunning = job.status === "running";
      const qi = queue.indexOf(id);
      if (qi !== -1) queue.splice(qi, 1);
      job._controller.abort();
      job.status = "cancelled";
      job.cancelled_at = nowIso();
      // A job that never started has no runner to settle, so nothing is pending and nothing can
      // arrive; one that WAS running settles when its promise does (see `pump`).
      job._settled = !wasRunning;
      job.finished_at = nowIso();
      job._terminalAt = Date.now();
      if (wasRunning) running--;
      pump();
      return publicView(job);
    },
    list() {
      return [...jobs.values()].map(publicView);
    },
    close() {
      clearInterval(sweep);
      for (const job of jobs.values()) {
        if (job.status === "running" || job.status === "queued") job._controller.abort();
      }
    }
  };
}
