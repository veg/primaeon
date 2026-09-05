/**
 * sweep.test.js — the TTL sweep, orphan directories, cancellation, timeout and restart recovery
 * of the job manager, on a fake pool so no model is loaded.
 *
 * WHY THIS FILE EXISTS. PLAN.md 3.5: "TTL 7 days", "job timeout 10 min". Those are the job
 * manager's timers, independent of what the workers compute, so they are tested against a pool
 * stub that resolves, hangs or fails on demand. The SQLite row and the job directory must go
 * together, a running job must never be swept, a directory without a row must be reaped, and a
 * process restart must fail what it cannot resume rather than leave it "running" forever.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { createJobManager } from "../src/jobs.js";
import { openDb } from "../src/db.js";
import { silentLogger, sleep, testConfig } from "./helpers.js";

/** A pool whose tasks finish the way the test says. */
function fakePool(behaviour = "resolve") {
  let seq = 0;
  const pool = {
    size: 1,
    active: 0,
    pending: 0,
    run(task, hooks = {}) {
      const id = String(++seq);
      let cancelled = null;
      const promise = new Promise((resolve, reject) => {
        setTimeout(() => {
          hooks.onStart && hooks.onStart();
          hooks.progress && hooks.progress("infer", 1, 2, "half");
          if (behaviour === "resolve") {
            hooks.onSection && hooks.onSection("sites", { sites: [{ site: 1, hyphaeon_lrt: 2 }] }, { final: true });
            setTimeout(() => resolve({ analysis: task.analysis, sites: [{ site: 1, hyphaeon_lrt: 2 }], provenance: { surface: "node-server", warnings: [{ code: "X", severity: "info", message: "m", data: {} }] } }), 5);
          } else if (behaviour === "fail") {
            setTimeout(() => reject(Object.assign(new Error("bad alignment"), { kind: "input", hint: "fix it" })), 5);
          } else {
            // hang until cancelled
            cancelled = (reason) => reject(Object.assign(new Error(reason), { kind: "cancelled" }));
          }
        }, 5);
      });
      return {
        id,
        promise,
        cancel(reason) {
          if (cancelled) cancelled(reason);
          else cancelled = () => {};
        }
      };
    },
    status: async () => ({ available: true }),
    close: async () => {}
  };
  return pool;
}

const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function manager(behaviour, overrides = {}) {
  const config = testConfig(Object.assign({ jobTtlMs: 1000, sweepIntervalMs: 60 * 60 * 1000, jobTimeoutMs: 1000 }, overrides));
  const m = createJobManager({ config, pool: fakePool(behaviour), logger: silentLogger });
  cleanups.push(async () => {
    await m.close();
    config.cleanup();
  });
  return { m, config };
}

async function untilTerminal(m, id) {
  for (let i = 0; i < 200; i++) {
    const v = m.get(id);
    if (["completed", "failed", "cancelled"].includes(v.status)) return v;
    await sleep(10);
  }
  throw new Error("job did not finish");
}

describe("job manager", () => {
  it("writes inputs, sections and the result to the job directory and sweeps them after the TTL", async () => {
    const { m, config } = manager("resolve");
    const job = m.create({ analysis: "meme", alignment: ">a\nATG\n", tree: "(a,b);", options: { x: 1 }, seed: 7, names: { alignment: "x.fasta" } });
    expect(job.id).toMatch(/^[0-9a-f]{32}$/);
    const dir = path.join(config.jobsDir, job.id);
    expect(existsSync(path.join(dir, "alignment.fasta"))).toBe(true);
    expect(existsSync(path.join(dir, "tree.nwk"))).toBe(true);
    const v = await untilTerminal(m, job.id);
    expect(v.status).toBe("completed");
    expect(v.options).toEqual({ x: 1, seed: 7 });
    expect(v.warnings).toEqual([{ code: "X", severity: "info", message: "m", data: {} }]);
    expect(v.progress.phase).toBe("infer");
    expect(existsSync(path.join(dir, "result.json"))).toBe(true);
    expect(existsSync(path.join(dir, "sections", "sites.json"))).toBe(true);
    expect(m.result(job.id).sites).toHaveLength(1);
    expect(m.section(job.id, "sites").final).toBe(true);

    // Not expired yet.
    expect(m.sweep(Date.now())).toEqual({ removed: 0, orphans: 0 });
    expect(m.get(job.id)).not.toBeNull();
    // Past the TTL: row and directory go together.
    expect(m.sweep(Date.now() + 2000).removed).toBe(1);
    expect(m.get(job.id)).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("reaps a directory without a row and leaves foreign names alone", async () => {
    const { m, config } = manager("resolve");
    const orphan = path.join(config.jobsDir, "f".repeat(32));
    mkdirSync(orphan, { recursive: true });
    mkdirSync(path.join(config.jobsDir, "not-a-job"), { recursive: true });
    expect(m.sweep().orphans).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(config.jobsDir)).toContain("not-a-job");
  });

  it("never sweeps a job that is still running; cancel ends it", async () => {
    const { m } = manager("hang", { jobTimeoutMs: 60_000 });
    const job = m.create({ analysis: "meme", alignment: ">a\nATG\n" });
    await sleep(30);
    expect(m.get(job.id).status).toBe("running");
    expect(m.sweep(Date.now() + 10_000).removed).toBe(0);
    const v = m.cancel(job.id, "test");
    await sleep(20);
    expect(m.get(job.id).status).toBe("cancelled");
    expect(v.status).toBe("running"); // the cancel is acknowledged asynchronously
    expect(m.get(job.id).error.kind).toBe("cancelled");
  });

  it("times a hung job out with a JOB_TIMEOUT failure", async () => {
    const { m } = manager("hang", { jobTimeoutMs: 100 });
    const job = m.create({ analysis: "meme", alignment: ">a\nATG\n" });
    const v = await untilTerminal(m, job.id);
    expect(v.status).toBe("failed");
    expect(v.error.code).toBe("JOB_TIMEOUT");
    expect(v.error.kind).toBe("timeout");
  });

  it("records an input failure with its hint", async () => {
    const { m } = manager("fail");
    const job = m.create({ analysis: "meme", alignment: ">a\nATG\n" });
    const v = await untilTerminal(m, job.id);
    expect(v.status).toBe("failed");
    expect(v.error).toMatchObject({ kind: "input", message: "bad alignment", hint: "fix it" });
    expect(m.result(job.id)).toBeUndefined();
  });

  it("fails rows a previous process left running, with SERVER_RESTARTED", async () => {
    const config = testConfig({ jobTtlMs: 60_000 });
    cleanups.push(async () => config.cleanup());
    const db = openDb(config.dbPath);
    const id = "a".repeat(32);
    db.insert({ id, analysis: "analyze", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000, options: {}, inputs: {} });
    db.start(id, new Date().toISOString());
    expect(db.get(id).status).toBe("running");
    db.close();

    const m = createJobManager({ config, pool: fakePool("resolve"), logger: silentLogger });
    cleanups.push(() => m.close());
    const v = m.get(id);
    expect(v.status).toBe("failed");
    expect(v.error.code).toBe("SERVER_RESTARTED");
    expect(m.stats().counts.failed).toBe(1);
  });

  it("emits status/progress/section events and snapshots them for a late subscriber", async () => {
    const { m } = manager("resolve");
    const seen = [];
    const job = m.create({ analysis: "analyze", alignment: ">a\nATG\n" });
    const off = m.subscribe(job.id, (ev) => seen.push(ev.type));
    await untilTerminal(m, job.id);
    off();
    expect(seen).toContain("progress");
    expect(seen).toContain("section");
    expect(seen.at(-1)).toBe("status");
    const snap = m.snapshot(job.id);
    expect(snap.view.status).toBe("completed");
    expect(snap.sections.map((s) => s.name)).toEqual(["sites"]);
    expect(snap.view.sections.sites).toBe("final");
    expect(snap.view.sections.dms).toBe("null");
  });
});
