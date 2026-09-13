/**
 * jobs.js — the job manager: SQLite row + per-job directory + a worker-pool run + live events.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5 describes a job as `POST /api/v1/jobs -> 202 {id}`, then status / SSE progress /
 * result / DELETE, with a 10-minute timeout and a 7-day TTL. This module owns that lifecycle and
 * the two stores behind it:
 *
 *   - src/db.js (SQLite) for metadata that must survive a restart: status, timestamps, options,
 *     input sizes, the latest progress record, the error, the warnings;
 *   - one directory per job, `<jobsDir>/<id>/`, holding `alignment.fasta` (+ `tree.nwk`,
 *     `prediction.csv`, `meme.json`, `phenotype.csv` as submitted), `result.json` once the run completes and
 *     `sections/<name>.json` for every section of an `analyze` report as it finalises, so a
 *     report page attached mid-run can render the sections that exist (PLAN.md 4.5 "the page
 *     never waits for the slowest one").
 *
 * Ids are 128 bits from `crypto.randomBytes(16)` as hex (PLAN.md 3.5 "128-bit job ids"), the
 * same as mcp/src/jobs.js, and are the only handle a client has: there are no accounts.
 *
 * Live state the SSE route needs — progress ticks and progressive (non-final) DMS updates — is
 * kept in memory per job and broadcast through one EventEmitter; a listener that connects late
 * receives a snapshot first (src/app.js). Delivery is best-effort like the MCP's job notifier:
 * polling `GET /api/v1/jobs/:id` is the source of truth, and nothing in the run depends on a
 * listener being there.
 *
 * On start-up, rows left `queued`/`running` by a previous process are failed with a
 * `SERVER_RESTARTED` error (the inputs are on disk, so a client can resubmit them; the server
 * does not silently re-run jobs nobody may be waiting for). The sweep removes expired rows and
 * their directories, and any directory without a row.
 *
 * PHASE 6 CHANGES TWO THINGS HERE, both because of what the temporal pillar is.
 *
 *   - SECTIONS ARE PER-ANALYSIS. `sectionStates` used to be gated on `analysis === "analyze"` and
 *     iterate the report's seven names. It now reads `LIVE_SECTIONS` (src/runner.js): the report's
 *     seven for `analyze`, `summary` and `permutations` for `temporal`, and NOTHING for an analysis
 *     that publishes nothing mid-run — which is the honest answer for `dates` (3-24 ms; there is no
 *     "during") rather than an object full of "pending" for sections that will never arrive.
 *   - A RUN CAN BE STOPPED AND STILL HAVE AN ANSWER. `runTemporalNull` catches its own abort and
 *     `runTemporal` then RESOLVES with a record classified at the achieved draw count, so a
 *     cancelled or timed-out temporal job reaches the success handler rather than the failure one.
 *     That is the point (draw `b` is seeded from `splitmix64(seed, b)`, so a null stopped at 313
 *     draws is bit-identical to one configured at 313) and it must not be reported as though
 *     nothing had interrupted it: `stampStop` adds a `RUN_STOPPED_EARLY` warning naming the reason
 *     and the count. `cancel()` records the reason BEFORE aborting, because the resolving path has
 *     no error object to read it from. Every other pillar rejects on an abort, as before.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb, TERMINAL } from "./db.js";
import { LIVE_SECTIONS } from "./runner.js";

/**
 * The inputs written into `<jobsDir>/<id>/` exactly as submitted, so a client whose job died in a
 * restart can see what it sent. `dates_file` is `dates.txt` rather than `.csv` or `.json` because
 * it may honestly be either — an Auspice build, a name-to-date JSON object or a delimited table —
 * and naming it for one of them would be a claim about a file this server deliberately does not
 * interpret before the date layer sniffs it. The name a REPRODUCTION line prints is the caller's
 * own basename from `names.dates_file`, not this one.
 */
const INPUT_FILES = Object.freeze({
  alignment: "alignment.fasta",
  tree: "tree.nwk",
  prediction: "prediction.csv",
  meme_result: "meme.json",
  phenotype_file: "phenotype.csv",
  dates_file: "dates.txt"
});

const nowIso = () => new Date().toISOString();

function safeId(id) {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/**
 * @param {object} opts
 * @param {object} opts.config   from src/config.js (jobsDir, dbPath, jobTtlMs, jobTimeoutMs, sweepIntervalMs)
 * @param {object} opts.pool     from src/pool.js
 * @param {object} [opts.logger]
 */
export function createJobManager({ config, pool, logger }) {
  const log = logger || { debug() {}, info() {}, warn() {}, error() {} };
  mkdirSync(config.jobsDir, { recursive: true });
  const db = openDb(config.dbPath);
  const events = new EventEmitter();
  events.setMaxListeners(0);

  /** @type {Map<string, {handle: object|null, timer: any, sections: Map<string, {payload: any, final: boolean}>, progress: object|null, status: string, startedAt: string|null}>} */
  const live = new Map();

  const dirOf = (id) => path.join(config.jobsDir, id);

  // Rows a previous process left unfinished: fail them (header).
  for (const id of db.unfinishedIds()) {
    db.finish(id, {
      status: "failed",
      finishedAt: nowIso(),
      error: { kind: "server", code: "SERVER_RESTARTED", message: "The server restarted while this job was queued or running; submit it again." }
    });
  }

  function emit(id, type, data) {
    events.emit(id, { type, id, at: nowIso(), ...data });
  }

  function view(id) {
    const row = db.get(id);
    if (!row) return null;
    const l = live.get(id);
    const out = {
      id: row.id,
      job_id: row.id,
      analysis: row.analysis,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      expires_at: new Date(row.expires_at).toISOString(),
      inputs: row.inputs,
      options: row.options,
      progress: (l && l.progress) || row.progress || null,
      warnings: row.warnings || [],
      error: row.error || null,
      result_available: row.status === "completed",
      // The stored document's size in bytes, as written. It is on the view because a client should
      // be able to see what `GET /result` would hand it BEFORE asking for it, and because the route
      // itself needs it: a temporal record is megabytes (measured at 16.3 MB at time_points 2000)
      // and the whole-record answer is guarded on this number rather than on re-serialising the
      // document to find out how big it is.
      result_bytes: row.result_bytes === null || row.result_bytes === undefined ? null : row.result_bytes
    };
    if (row.started_at) {
      const end = row.finished_at ? Date.parse(row.finished_at) : Date.now();
      out.elapsed_sec = Math.round((end - Date.parse(row.started_at)) / 100) / 10;
    }
    if (row.status === "queued") out.queue_position = queuePosition(id);
    // Phase 6 widened this beyond the report: an analysis with a live section vocabulary reports
    // its states, one without (`dates`, `dating`, every per-pillar analysis) reports none rather
    // than an object full of "pending" for sections it will never publish.
    if (LIVE_SECTIONS[row.analysis]) out.sections = sectionStates(id, row);
    out.links = {
      self: "/api/v1/jobs/" + id,
      events: "/api/v1/jobs/" + id + "/events",
      result: "/api/v1/jobs/" + id + "/result"
    };
    return out;
  }

  function queuePosition(id) {
    let i = 0;
    for (const [jid, l] of live) {
      if (l.status !== "queued") continue;
      i++;
      if (jid === id) return i;
    }
    return null;
  }

  function sectionStates(id, row) {
    const l = live.get(id);
    const out = {};
    const dir = path.join(dirOf(id), "sections");
    for (const name of LIVE_SECTIONS[row.analysis] || []) {
      const s = l && l.sections.get(name);
      if (s) out[name] = s.payload === null ? "null" : s.final ? "final" : "partial";
      else if (row.status === "completed" && existsSync(path.join(dir, name + ".json"))) out[name] = "final";
      else out[name] = row.status === "completed" ? "null" : "pending";
    }
    return out;
  }

  function writeJson(file, value) {
    const text = JSON.stringify(value);
    writeFileSync(file, text);
    return Buffer.byteLength(text);
  }

  /**
   * A run that was ASKED TO STOP and answered with a result anyway.
   *
   * This is the temporal pillar and nothing else today: `runTemporalNull` catches its own abort,
   * records `{completed, cancelled, skipped, reason}` and leaves NaN — never 1.0 — at a candidate
   * it did not test, so `runTemporal` RESOLVES with a valid record classified at the achieved draw
   * count. Draw `b` is seeded from `splitmix64(seed, b)`, so a null stopped at 313 draws is
   * bit-identical to one configured at 313: the number on the record means the number it says.
   *
   * A job like that must not be reported as if nothing had interrupted it, and must not be thrown
   * away either (which is what DELETE-as-cancel did). It completes, and this warning says what
   * stopped it and where the truncation is visible. Every other pillar rejects on an abort and
   * never reaches here.
   */
  function stampStop(entry, result) {
    if (!entry || !entry.stopReason || !result || typeof result !== "object") return result;
    const perm = (result.record && result.record.permutations) || null;
    const warning = {
      code: "RUN_STOPPED_EARLY",
      severity: "warn",
      message:
        "This run was stopped (" + entry.stopReason + ") and answered with what it had. " +
        (perm
          ? "The permutation null completed " + perm.completed + " of " + perm.requested + " draws; every p-value and q-value on this record was computed at " +
            perm.completed + " draws and is exactly what a run configured at " + perm.completed + " would have produced. A candidate the null never reached carries NaN, not 1.0."
          : "Read `honesty.null_state` and `honesty.uncalled_because` before reading any call column."),
      data: { reason: entry.stopReason, permutations: perm }
    };
    const prov = result.provenance && typeof result.provenance === "object" ? result.provenance : {};
    const warnings = Array.isArray(prov.warnings) ? [...prov.warnings, warning] : [warning];
    return Object.assign({}, result, { provenance: Object.assign({}, prov, { warnings }) });
  }

  function finish(id, status, { error = null, result = null } = {}) {
    const l = live.get(id);
    if (l) {
      clearTimeout(l.timer);
      l.status = status;
    }
    let resultBytes = null;
    let warnings = null;
    if (result) {
      resultBytes = writeJson(path.join(dirOf(id), "result.json"), result);
      const prov = result.provenance || {};
      warnings = Array.isArray(prov.warnings) ? prov.warnings : null;
    }
    db.finish(id, { status, finishedAt: nowIso(), error, warnings, resultBytes });
    emit(id, "status", { status, error, result_available: status === "completed" });
    log.info("job " + id + " " + status + (error ? " (" + error.kind + ": " + error.message + ")" : resultBytes ? " (" + resultBytes + " bytes)" : ""));
    // Keep the live entry around briefly so an SSE client connecting right after sees the sections.
    setTimeout(() => {
      const cur = live.get(id);
      if (cur && cur.status === status) live.delete(id);
    }, 60 * 1000).unref();
  }

  const manager = {
    db,
    events,
    /**
     * @param {object} spec
     * @param {string} spec.analysis
     * @param {string} [spec.alignment]
     * @param {string} [spec.tree]
     * @param {string} [spec.prediction]
     * @param {string} [spec.meme_result]
     * @param {string} [spec.phenotype_file]  the phenotype table's TEXT
     * @param {string} [spec.dates_file]      the date metadata's TEXT (Auspice JSON, JSON map or CSV/TSV)
     * @param {object} [spec.options]
     * @param {number} [spec.seed]
     * @param {object} [spec.names]     {alignment, tree, demo}
     * @param {object} [spec.size]      {codons, sequences, work} as classified by the caps
     * @param {string} [spec.clientIp]
     * @returns {object} the job view
     */
    create(spec) {
      const id = randomBytes(16).toString("hex");
      const dir = dirOf(id);
      mkdirSync(path.join(dir, "sections"), { recursive: true });
      const inputs = { names: spec.names || {}, size: spec.size || null, files: {} };
      for (const [key, file] of Object.entries(INPUT_FILES)) {
        if (typeof spec[key] === "string" && spec[key].length) {
          writeFileSync(path.join(dir, file), spec[key]);
          inputs.files[key] = file;
        }
      }
      const createdAt = nowIso();
      const options = Object.assign({}, spec.options || {});
      if (spec.seed !== undefined) options.seed = spec.seed;
      db.insert({ id, analysis: spec.analysis, createdAt, expiresAt: Date.now() + config.jobTtlMs, options, inputs, clientIp: spec.clientIp });

      const entry = { handle: null, timer: null, sections: new Map(), progress: null, status: "queued", startedAt: null };
      live.set(id, entry);

      const task = {
        analysis: spec.analysis,
        alignment: spec.alignment,
        tree: spec.tree,
        prediction: spec.prediction,
        meme_result: spec.meme_result,
        phenotype_file: spec.phenotype_file,
        dates_file: spec.dates_file,
        options: spec.options || {},
        seed: spec.seed,
        names: spec.names || {}
      };
      entry.handle = pool.run(task, {
        onStart: () => {
          entry.status = "running";
          entry.startedAt = nowIso();
          db.start(id, entry.startedAt);
          emit(id, "status", { status: "running" });
          entry.timer = setTimeout(() => {
            log.warn("job " + id + " exceeded " + config.jobTimeoutMs + " ms; cancelling");
            entry.timedOut = true;
            entry.stopReason = "the " + Math.round(config.jobTimeoutMs / 1000) + " s job timeout";
            entry.handle.cancel("job timeout after " + Math.round(config.jobTimeoutMs / 1000) + " s");
          }, config.jobTimeoutMs);
          if (entry.timer.unref) entry.timer.unref();
        },
        progress: (phase, done, total, message) => {
          entry.progress = { phase, done, total, message, at: nowIso() };
          db.progress(id, entry.progress);
          emit(id, "progress", entry.progress);
        },
        onSection: (name, payload, meta) => {
          const final = !!(meta && meta.final);
          entry.sections.set(name, { payload, final });
          if (final) writeJson(path.join(dir, "sections", name + ".json"), payload);
          emit(id, "section", { name, final, payload });
        }
      });
      entry.handle.promise.then(
        (result) => finish(id, "completed", { result: stampStop(entry, result) }),
        (err) => {
          if (entry.timedOut) {
            finish(id, "failed", { error: { kind: "timeout", code: "JOB_TIMEOUT", message: "The job exceeded the " + Math.round(config.jobTimeoutMs / 1000) + " s limit and was stopped." } });
          } else if (err && err.kind === "cancelled") {
            finish(id, "cancelled", { error: { kind: "cancelled", message: err.message } });
          } else {
            // `details` is the bounded structured explanation the date layer attaches to a refusal
            // (which column was looked for, which names did not match). It is the difference between
            // "no sequence could be dated" and a client that can fix its metadata, so it survives
            // the worker boundary and the SQLite round trip with the rest of the error.
            finish(id, "failed", { error: { kind: (err && err.kind) || "server", code: err && err.code, message: (err && err.message) || String(err), hint: err && err.hint, details: err && err.details } });
          }
        }
      );
      emit(id, "status", { status: "queued" });
      log.info("job " + id + " queued (" + spec.analysis + (spec.size ? ", " + spec.size.sequences + " x " + spec.size.codons : "") + ")");
      return view(id);
    },

    get(id) {
      const sid = safeId(id);
      return sid ? view(sid) : null;
    },

    /** The completed result document, or undefined. */
    result(id) {
      const sid = safeId(id);
      if (!sid) return undefined;
      const row = db.get(sid);
      if (!row || row.status !== "completed") return undefined;
      const file = path.join(dirOf(sid), "result.json");
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8"));
    },

    /** Latest payload of one section (partial or final), or undefined when nothing has arrived. */
    section(id, name) {
      const sid = safeId(id);
      if (!sid) return undefined;
      const l = live.get(sid);
      const s = l && l.sections.get(name);
      if (s) return { payload: s.payload, final: s.final };
      const file = path.join(dirOf(sid), "sections", name + ".json");
      if (existsSync(file)) return { payload: JSON.parse(readFileSync(file, "utf8")), final: true };
      return undefined;
    },

    /** Snapshot for a late SSE subscriber: status, latest progress, and every section so far. */
    snapshot(id) {
      const v = manager.get(id);
      if (!v) return null;
      const l = live.get(v.id);
      const sections = [];
      if (l) for (const [name, s] of l.sections) sections.push({ name, final: s.final, payload: s.payload });
      return { view: v, sections };
    },

    subscribe(id, listener) {
      const sid = safeId(id);
      if (!sid) return () => {};
      events.on(sid, listener);
      return () => events.off(sid, listener);
    },

    cancel(id, reason = "cancelled by client") {
      const sid = safeId(id);
      const row = sid && db.get(sid);
      if (!row) return null;
      if (TERMINAL.includes(row.status)) return view(sid);
      const l = live.get(sid);
      if (l && l.handle) {
        // Recorded BEFORE the abort: a pillar that can answer partially (the temporal null) will
        // resolve rather than reject, and `stampStop` needs to know why on that path too.
        if (!l.stopReason) l.stopReason = reason;
        l.handle.cancel(reason);
      } else finish(sid, "cancelled", { error: { kind: "cancelled", message: reason } });
      return view(sid);
    },

    /** Early deletion (DELETE /jobs/:id): cancel if needed, remove row and directory. */
    delete(id) {
      const sid = safeId(id);
      const row = sid && db.get(sid);
      if (!row) return false;
      if (!TERMINAL.includes(row.status)) manager.cancel(sid, "deleted by client");
      const l = live.get(sid);
      if (l) {
        clearTimeout(l.timer);
        live.delete(sid);
      }
      db.remove(sid);
      rmSync(dirOf(sid), { recursive: true, force: true });
      emit(sid, "status", { status: "deleted" });
      events.removeAllListeners(sid);
      return true;
    },

    /** TTL sweep: expired rows and their directories, plus directories without a row. */
    sweep(now = Date.now()) {
      let removed = 0;
      for (const id of db.expiredIds(now)) {
        const l = live.get(id);
        if (l && !TERMINAL.includes(l.status)) continue; // never sweep a job that is still running
        db.remove(id);
        rmSync(dirOf(id), { recursive: true, force: true });
        live.delete(id);
        removed++;
      }
      const known = new Set(db.allIds());
      let orphans = 0;
      for (const name of readdirSync(config.jobsDir)) {
        if (known.has(name) || !safeId(name)) continue;
        try {
          if (statSync(path.join(config.jobsDir, name)).isDirectory()) {
            rmSync(path.join(config.jobsDir, name), { recursive: true, force: true });
            orphans++;
          }
        } catch {
          // raced with a delete
        }
      }
      if (removed || orphans) log.info("sweep: removed " + removed + " expired job(s), " + orphans + " orphan directory(ies)");
      return { removed, orphans };
    },

    stats() {
      return { counts: db.counts(), live: live.size, pool: { size: pool.size, active: pool.active, pending: pool.pending } };
    },

    async close() {
      clearInterval(sweepTimer);
      for (const l of live.values()) clearTimeout(l.timer);
      await pool.close();
      db.close();
    }
  };

  const sweepTimer = setInterval(() => {
    try {
      manager.sweep();
    } catch (err) {
      log.error("sweep failed: " + err.message);
    }
  }, config.sweepIntervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
  manager.sweep();

  return manager;
}
