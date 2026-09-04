/**
 * jobs.js — in-process job store for analysis runs that do not fit inside a tool call.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: an analysis tool answers in the call under the synchronous caps and otherwise
 * "returns a job id". In Phase 0 the run is a Python subprocess (src/bridge.js) and this process
 * is the only place that knows about it, so the store is a Map in memory — no redis, no
 * scheduler. That is deliberate: datamonkey-js-server's SLURM path was rejected for v1 because
 * scheduling latency exceeds the runtimes (PLAN.md 3.1, option D). The store is written so that
 * `server/` can later replace it with something durable behind the same five calls.
 *
 * Contract:
 *   - ids are 128-bit hex (PLAN.md 3.5 "128-bit job ids"); they are the only handle a client has;
 *   - statuses: queued -> running -> completed | failed | cancelled;
 *   - a job runs at most MAX_CONCURRENT at a time (two Python processes on a laptop is already
 *     ~1 GB of RSS, PLAN.md 1); the rest wait in FIFO order as "queued";
 *   - cancel aborts the runner's AbortSignal (the bridge kills the child) and marks the job;
 *   - completed jobs expire after JOB_TTL_MS and the map is bounded by MAX_JOBS (oldest
 *     terminal jobs evicted first), because a process-local map has no other ceiling.
 *
 * Completion notifications over the transport are best-effort, exactly as datamonkey-js-server's
 * job-notifier.js documents: polling job_status is the source of truth. The store exposes an
 * `onTerminal` hook the server uses for that; a missed notification never loses a job.
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
    out.result_available = job.status === "completed";
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
      Promise.resolve()
        .then(() => job._run(job._controller.signal, report))
        .then(
          (value) => {
            if (job.status === "cancelled") return; // cancelled while running; already finished
            finish(job, "completed", { result: value });
          },
          (err) => {
            if (job.status === "cancelled") return;
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
     * @param {{analysis: string, options?: object, run: (signal: AbortSignal) => Promise<any>}} spec
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
        error: undefined,
        _run: spec.run,
        _controller: new AbortController(),
        _terminalAt: null
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
