/**
 * db.js — the SQLite job table, on Node's built-in `node:sqlite`.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5 gives jobs a 7-day TTL, so the job list must outlive the process: a client that
 * submitted an oversize alignment on Monday polls `GET /api/v1/jobs/:id` on Tuesday after a pm2
 * restart and must get "completed" and its result, not 404. A Map in memory (mcp/src/jobs.js,
 * right for a stdio server that dies with its client) cannot do that; a file per job can, but
 * "list what expired" and "what was running when we died" want a query. One table it is.
 *
 * WHY node:sqlite AND NOT better-sqlite3. Node 22.13+ ships `node:sqlite` (DatabaseSync,
 * synchronous like better-sqlite3, WAL-capable, no build step). The alternative, better-sqlite3,
 * is a second native addon beside onnxruntime-node in the same process, needs a prebuilt binary
 * for x64 Node under Rosetta (CLAUDE.md pins that Node) and node-gyp when there is none, and would
 * be the only compiled dependency `npm install` of this package pulls. node:sqlite's cost is an
 * ExperimentalWarning on stderr, which bin/hyphaeon-server.js and the pm2/Docker configs silence
 * with `--disable-warning=ExperimentalWarning`; its API surface used here (exec, prepare, run,
 * get, all) has been stable since 22.5 and is the same in Node 24 where the flag is gone.
 *
 * Only job METADATA lives here: status, timestamps, options, the latest progress record, the
 * error, the sizes. Inputs and results are files in the job's directory (src/jobs.js), because a
 * result JSON can be tens of megabytes and SQLite is not where those belong.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const STATUSES = Object.freeze(["queued", "running", "completed", "failed", "cancelled"]);
export const TERMINAL = Object.freeze(["completed", "failed", "cancelled"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  analysis      TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  expires_at    INTEGER NOT NULL,
  options       TEXT NOT NULL DEFAULT '{}',
  inputs        TEXT NOT NULL DEFAULT '{}',
  progress      TEXT,
  error         TEXT,
  warnings      TEXT,
  result_bytes  INTEGER,
  client_ip     TEXT
);
CREATE INDEX IF NOT EXISTS jobs_expires ON jobs (expires_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
`;

function parse(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysis: row.analysis,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    expires_at: Number(row.expires_at),
    options: parse(row.options, {}),
    inputs: parse(row.inputs, {}),
    progress: parse(row.progress, null),
    error: parse(row.error, null),
    warnings: parse(row.warnings, []),
    result_bytes: row.result_bytes === null ? null : Number(row.result_bytes),
    client_ip: row.client_ip
  };
}

/**
 * @param {string} dbPath  file path, or ":memory:"
 */
export function openDb(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare(
      "INSERT INTO jobs (id, analysis, status, created_at, expires_at, options, inputs, client_ip) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)"
    ),
    get: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    setStatus: db.prepare("UPDATE jobs SET status = ?, started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at) WHERE id = ?"),
    setProgress: db.prepare("UPDATE jobs SET progress = ? WHERE id = ?"),
    finish: db.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ?, warnings = ?, result_bytes = ? WHERE id = ?"),
    expired: db.prepare("SELECT id FROM jobs WHERE expires_at < ?"),
    unfinished: db.prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running')"),
    remove: db.prepare("DELETE FROM jobs WHERE id = ?"),
    count: db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
    all: db.prepare("SELECT id FROM jobs")
  };

  return {
    path: dbPath,
    insert({ id, analysis, createdAt, expiresAt, options, inputs, clientIp }) {
      stmts.insert.run(id, analysis, createdAt, expiresAt, JSON.stringify(options || {}), JSON.stringify(inputs || {}), clientIp || null);
    },
    get(id) {
      return rowToJob(stmts.get.get(id));
    },
    start(id, startedAt) {
      stmts.setStatus.run("running", startedAt, null, id);
    },
    progress(id, record) {
      stmts.setProgress.run(record ? JSON.stringify(record) : null, id);
    },
    finish(id, { status, finishedAt, error = null, warnings = null, resultBytes = null }) {
      stmts.finish.run(status, finishedAt, error ? JSON.stringify(error) : null, warnings ? JSON.stringify(warnings) : null, resultBytes, id);
    },
    expiredIds(now = Date.now()) {
      return stmts.expired.all(now).map((r) => r.id);
    },
    unfinishedIds() {
      return stmts.unfinished.all().map((r) => r.id);
    },
    allIds() {
      return stmts.all.all().map((r) => r.id);
    },
    remove(id) {
      stmts.remove.run(id);
    },
    counts() {
      const out = {};
      for (const r of stmts.count.all()) out[r.status] = Number(r.n);
      return out;
    },
    close() {
      db.close();
    }
  };
}
