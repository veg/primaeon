/**
 * bridge.js — runs the Python reference CLI (`hyphaeon <cmd>`) on behalf of an MCP tool.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6, "Bridge, then port": until a pillar's JavaScript port lands in veg/HyphAeon/js,
 * the MCP tool for that pillar shells out to the Python CLI the way datamonkey-js-server shells
 * out to hivtrace (app/hivtrace/*.sh), with the same tool schema and the same result shape it will
 * have after the port, and marks provenance.surface = "python-reference". Once a pillar is ported
 * its branch here is DELETED — this file is temporary by design (PLAN.md D16) and every result it
 * produces says so in `provenance`. Phase 1b deleted the meme, busted and evaluate branches
 * (src/engine.js runs them in-process); Phase 2 deleted epistasis and dms (the library's
 * epistasis.js / sectors.js / dms.js ports at veg/HyphAeon phase-2a, through runtime/). ONLY
 * hyphaeon_phenotype remains here, until Phase 3 ports phenotype.py (PLAN.md 8).
 *
 * What it does, in order:
 *   1. writes the inline inputs to a fresh temp directory (alignment.fasta, tree.nwk,
 *      phenotype.csv) — the CLI takes file paths only (hyphaeon/cli.py:1038-1094,
 *      veg/HyphAeon phase-1a);
 *   2. maps tool options one-to-one onto CLI flags (ARGS below cites the parser lines);
 *   3. spawns the executable from env HYPHAEON_PY_BIN, else `hyphaeon` on PATH, with no shell,
 *      captures stdout/stderr (bounded), and kills it after JOB_TIMEOUT_MS;
 *   4. reads the JSON the CLI wrote with `-o`, deletes the temp directory, and returns
 *      { result, provenance }.
 *
 * Two-class error taxonomy, kept from datamonkey-js-server lib/mcp/tools.js:672-690: a failure is
 * either a SERVER problem (the executable is missing, the weights cannot be loaded, torch is
 * broken, tn93 is not installed) that nothing in the caller's data can fix, or an INPUT problem
 * (unparseable alignment, no tree, taxon mismatch, bad option) the caller can act on. The CLI
 * prints its own `[!] ...` line before sys.exit(1) (cli.py:59, :82, :377, :635, :738, :864) and
 * `hyphaeon evaluate: error: ...` via argparse (exit 2), so classification is by message.
 *
 * Environment the child gets: the parent's, plus PYTHONIOENCODING=utf-8 because the CLI prints
 * emoji and box characters to stdout (cli.py:229 and elsewhere) and a C locale would turn a
 * successful run into a UnicodeEncodeError, and PYTHONUNBUFFERED=1 so progress lines arrive as
 * they are printed. HYPHAEON_WEIGHTS / HYPHAEON_VARIANT / HF_HUB_OFFLINE are passed through
 * untouched: the operator decides where weights come from, not this file.
 *
 * The phenotype parser takes --model-variant (cli.py:1038-1059) and, since phase-2a, --seed
 * (default 42: the permulations AND the trait-sector permutation null) and --mds-sign (default
 * canonical); all three are forwarded one to one.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JOB_TIMEOUT_MS } from "./caps.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const MAX_CAPTURE = 1024 * 1024; // keep the tail of stdout/stderr, 1 MiB each
const KILL_GRACE_MS = 5000;

export class BridgeError extends Error {
  /**
   * @param {"server"|"input"} kind
   * @param {string} message
   * @param {{hint?: string, stderr?: string, stdout?: string, exitCode?: number|null, command?: string[]}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind;
    this.hint = extra.hint;
    this.stderr = extra.stderr;
    this.stdout = extra.stdout;
    this.exitCode = extra.exitCode;
    this.command = extra.command;
  }
}

/**
 * The CLI's own input-error prefixes. Each handler catches the exception from the analysis,
 * prints one of these with the cause, and exits 1 (phenotype/epistasis/dms also print a
 * traceback, so a traceback alone does not mean a server problem). argparse errors go to stderr
 * as "hyphaeon evaluate: error: ..." with exit 2.
 */
const INPUT_MARKERS = [
  /\[!\]\s*Error loading alignment and tree:\s*(.+)/i, // cli.py:82
  /\[!\]\s*Error loading [^:]+:\s*(.+)/i, // cli.py:421 (busted)
  /\[!\]\s*Phenotype Association Error:\s*(.+)/i, // cli.py:632
  /\[!\]\s*Epistasis \/ ESSM Error:\s*(.+)/i, // cli.py:735
  /\[!\]\s*Digital DMS \/ ESSM Error:\s*(.+)/i, // cli.py:861
  /hyphaeon(?: evaluate)?: error: (.+)/i, // argparse
  /\[!\]\s*Error: You must specify either --alignment/i // cli.py:376
];

/**
 * A cause that names the environment rather than the data. Checked INSIDE the cause text of an
 * input marker (a missing tn93 package surfaces as "[!] Error loading alignment and tree:
 * ImportError ...") and against the whole output when no marker matched.
 */
const SERVER_CAUSES = [
  /No module named/i,
  /ImportError/i,
  /ModuleNotFoundError/i,
  /tn93.*(?:required|not found|install)/i,
  /could not (?:find|load|resolve|download) (?:the )?(?:model )?weights/i,
  /weights? (?:file )?(?:not found|does not exist)/i,
  /HF_TOKEN|huggingface_hub|Hugging Face|401 Client Error|gated/i,
  /CUDA (?:error|out of memory)|MPS backend|torch\.cuda|device-side/i,
  /MemoryError|Killed/i,
  /Permission denied/i
];

/** Everything else the CLI prints with a leading "[!]" that should be reported as a server fault. */
const SERVER_MARKERS = [/\[!\]\s*(Could not|Failed to|Unable to)[^\n]*(weights|model|download)[^\n]*/i];

function lastLines(s, n) {
  const lines = s.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

function lastMatch(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  let last = null;
  while ((m = g.exec(text)) !== null) last = m;
  return last;
}

/**
 * Two-class classification of a failed run.
 *
 * @returns {{kind: "server"|"input", cause: string}}
 */
export function classifyFailure(stdout, stderr, exitCode) {
  const text = stdout + "\n" + stderr;
  for (const re of INPUT_MARKERS) {
    const m = lastMatch(text, re);
    if (m) {
      const cause = (m[1] || m[0]).trim();
      const serverInside = SERVER_CAUSES.some((s) => s.test(cause));
      return { kind: serverInside ? "server" : "input", cause };
    }
  }
  for (const re of SERVER_MARKERS) {
    const m = lastMatch(text, re);
    if (m) return { kind: "server", cause: m[0].replace(/^\[!\]\s*/, "").trim() };
  }
  if (SERVER_CAUSES.some((s) => s.test(text))) {
    const bang = lastMatch(text, /\[!\]\s*(.+)/);
    const tail = lastLines(stderr, 2) || lastLines(stdout, 2);
    return { kind: "server", cause: (bang && bang[1].trim()) || tail || "exit code " + exitCode };
  }
  const bang = lastMatch(text, /\[!\]\s*(.+)/);
  const cause = (bang && bang[1].trim()) || lastLines(stderr, 3) || lastLines(stdout, 3) || "exit code " + exitCode;
  return { kind: exitCode === 2 ? "input" : "server", cause };
}

/**
 * Option -> CLI flag tables, one per subcommand, in the order of the argparse definitions.
 * `flag` entries are booleans; `value` entries carry an argument; `env` entries are set in the
 * child environment instead. Anything not listed here is not forwarded.
 */
const ARGS = {
  // cli.py:1038-1059 (phase-2a: + --seed, --mds-sign). The only bridged pillar left.
  phenotype: [
    ["use_tn93", "--use-tn93", "flag"],
    ["no_tree", "--no-tree", "flag"],
    ["model_variant", "--model-variant", "value"],
    ["preset", "--preset", "value"],
    ["foreground", "--foreground", "value"],
    ["background", "--background", "value"],
    ["trait_col", "--trait-col", "value"],
    ["species_col", "--species-col", "value"],
    ["continuous", "--continuous", "flag"],
    ["permulations", "--permulations", "value"],
    ["min_taxa", "--min-taxa", "value"],
    ["alpha", "--alpha", "value"],
    ["n_permutations", "--n-permutations", "value"],
    ["max_perm_p", "--max-perm-p", "value"],
    ["seed", "--seed", "value"],
    ["mds_sign", "--mds-sign", "value"],
    ["cpu", "--cpu", "flag"]
  ]
};

export const BRIDGED_ANALYSES = Object.freeze(Object.keys(ARGS));

function optionArgs(analysis, options) {
  const out = [];
  for (const [key, flag, kind] of ARGS[analysis]) {
    const v = options[key];
    if (v === undefined || v === null) continue;
    if (kind === "flag") {
      if (v === true) out.push(flag);
    } else {
      out.push(flag, String(v));
    }
  }
  return out;
}

/** Resolve the Python CLI executable. */
export function pythonBin(env = process.env) {
  return env.HYPHAEON_PY_BIN && env.HYPHAEON_PY_BIN.trim() ? env.HYPHAEON_PY_BIN.trim() : "hyphaeon";
}

let versionCache = new Map();

/**
 * Best-effort version of the installed `hyphaeon` package, for provenance.reference_version.
 * A console-script entry point starts with `#!<python>`; that interpreter can report the
 * distribution version. Anything else (a frozen binary, a wrapper) yields "unknown".
 */
export async function referenceVersion(env = process.env) {
  const bin = pythonBin(env);
  if (versionCache.has(bin)) return versionCache.get(bin);
  let version = "unknown";
  try {
    const head = await readFile(bin, { encoding: "utf8", flag: "r" }).catch(() => "");
    const shebang = /^#!\s*(\S+)/.exec(head.slice(0, 512));
    if (shebang && /python/i.test(shebang[1])) {
      const r = await runCapture(
        shebang[1],
        ["-c", "import importlib.metadata as m; print(m.version('hyphaeon'))"],
        { env, timeoutMs: 20000 }
      );
      if (r.code === 0 && r.stdout.trim()) version = r.stdout.trim();
    }
  } catch {
    version = "unknown";
  }
  versionCache.set(bin, version);
  return version;
}

function runCapture(cmd, args, { env, cwd, timeoutMs, signal, onLine }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    const append = (buf, chunk, which) => {
      let s = buf + chunk;
      if (s.length > MAX_CAPTURE) s = s.slice(s.length - MAX_CAPTURE);
      if (onLine) {
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(which, line);
      }
      return s;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout = append(stdout, d, "stdout")));
    child.stderr.on("data", (d) => (stderr = append(stderr, d, "stderr")));

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code, signal: sig, stdout, stderr, timedOut, aborted });
    });
  });
}

/**
 * Build the argv for one analysis. Exported so tests can check the mapping without Python.
 *
 * @param {string} analysis
 * @param {object} options
 * @param {{alignment?: string, tree?: string, phenotype_file?: string, prediction?: string, meme_result?: string, output: string}} files
 * @returns {string[]}
 */
export function buildArgv(analysis, options, files) {
  if (!ARGS[analysis]) throw new BridgeError("input", "Unknown analysis '" + analysis + "'.");
  const argv = [analysis];
  argv.push("-a", files.alignment);
  if (files.tree) argv.push("-t", files.tree);
  if (analysis === "phenotype" && files.phenotype_file) argv.push("--phenotype-file", files.phenotype_file);
  argv.push(...optionArgs(analysis, options));
  argv.push("-o", files.output);
  return argv;
}

/**
 * Run one analysis through the Python CLI.
 *
 * @param {object} req
 * @param {string} req.analysis          phenotype (the only bridged pillar since Phase 2)
 * @param {string} [req.alignment]       alignment text (FASTA/NEXUS/PHYLIP)
 * @param {string} [req.tree]            Newick/NEXUS tree text
 * @param {string} [req.phenotype_file]  CSV/TSV text for phenotype
 * @param {object} [req.options]         tool options, mapped by ARGS
 * @param {AbortSignal} [req.signal]
 * @param {object} [req.env]             defaults to process.env
 * @param {number} [req.timeoutMs]       defaults to JOB_TIMEOUT_MS
 * @param {(which: string, line: string) => void} [req.onLine]
 * @returns {Promise<{result: object, provenance: object}>}
 */
export async function runBridge(req) {
  const {
    analysis,
    options = {},
    signal,
    env = process.env,
    timeoutMs = JOB_TIMEOUT_MS,
    onLine
  } = req;
  if (!ARGS[analysis]) throw new BridgeError("input", "Unknown analysis '" + analysis + "'.");

  const bin = pythonBin(env);
  const dir = await mkdtemp(path.join(tmpdir(), "hyphaeon-mcp-"));
  const files = { output: path.join(dir, "result.json") };
  const t0 = Date.now();
  let argv;
  try {
    if (typeof req.alignment !== "string" || !req.alignment.trim()) {
      throw new BridgeError("input", "An alignment is required.");
    }
    files.alignment = path.join(dir, "alignment.fasta");
    await writeFile(files.alignment, req.alignment, "utf8");
    if (typeof req.tree === "string" && req.tree.trim()) {
      files.tree = path.join(dir, "tree.nwk");
      await writeFile(files.tree, req.tree, "utf8");
    }
    if (analysis === "phenotype" && typeof req.phenotype_file === "string" && req.phenotype_file.trim()) {
      files.phenotype_file = path.join(dir, "phenotype.csv");
      await writeFile(files.phenotype_file, req.phenotype_file, "utf8");
    }
    argv = buildArgv(analysis, options, files);

    const childEnv = Object.assign({}, env, { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" });
    let run;
    try {
      run = await runCapture(bin, argv, { env: childEnv, cwd: dir, timeoutMs, signal, onLine });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new BridgeError(
          "server",
          "The HyphAeon Python CLI could not be started: '" + bin + "' was not found. This is a " +
            "server-side installation problem, not a problem with your data.",
          {
            hint:
              "Install the reference package (pip install hyphaeon) so `hyphaeon` is on PATH, or " +
              "point HYPHAEON_PY_BIN at the executable.",
            command: redact([bin, ...argv], dir)
          }
        );
      }
      throw new BridgeError("server", "Could not start the Python CLI: " + err.message, {
        command: redact([bin, ...argv], dir)
      });
    }

    const command = redact([bin, ...argv], dir);
    if (run.aborted) {
      throw new BridgeError("input", "The run was cancelled.", { command });
    }
    if (run.timedOut) {
      throw new BridgeError(
        "input",
        "The run exceeded the " + Math.round(timeoutMs / 60000) + "-minute limit and was stopped.",
        {
          hint:
            "Submit fewer sequences or fewer sites, lower n_permutations / permulations, or set " +
            "no_dms for epistasis.",
          stderr: lastLines(run.stderr, 20),
          command
        }
      );
    }
    if (run.code !== 0) {
      const { kind, cause } = classifyFailure(run.stdout, run.stderr, run.code);
      if (kind === "server") {
        throw new BridgeError(
          "server",
          "The HyphAeon reference could not run on the server. This is a server-side problem " +
            "(weights, Python environment, or hardware), not a problem with your alignment or tree: " +
            cause,
          {
            hint: "Nothing about the submitted data will change this; report it to the operator.",
            stderr: lastLines(run.stderr, 30),
            exitCode: run.code,
            command
          }
        );
      }
      throw new BridgeError("input", "HyphAeon could not process this input: " + cause, {
        hint:
          "Check that the alignment is an in-frame codon alignment (FASTA, NEXUS or PHYLIP), that the " +
          "sequence names match the tree tips exactly, and that a tree is supplied (or use_tn93 is set). " +
          "Run hyphaeon_validate first for a full diagnosis.",
        stderr: lastLines(run.stderr, 30),
        exitCode: run.code,
        command
      });
    }

    let result;
    try {
      result = JSON.parse(await readFile(files.output, "utf8"));
    } catch (err) {
      throw new BridgeError(
        "server",
        "The Python CLI exited successfully but wrote no readable JSON result (" + err.message + ").",
        { stderr: lastLines(run.stderr, 30), stdout: lastLines(run.stdout, 30), command }
      );
    }
    scrubPaths(result, dir);

    const elapsed = (Date.now() - t0) / 1000;
    const provenance = {
      schema_version: 1,
      surface: "python-reference",
      bridge: "python-cli",
      reference_version: await referenceVersion(env),
      hyphaeon_mcp_version: PKG.version,
      model_variant: options.model_variant || env.HYPHAEON_VARIANT || "general",
      weights_source: env.HYPHAEON_WEIGHTS ? "local-file" : "huggingface-or-package",
      is_surrogate: true,
      surrogate_for: "MEME",
      elapsed_sec: Math.round(elapsed * 1000) / 1000,
      command,
      options: Object.assign({}, options),
      note: "Bridge to the Python reference; replaced pillar by pillar by @veg/hyphaeon-js (meme, busted, evaluate in-process since Phase 1b; epistasis, dms since Phase 2). Only phenotype remains bridged (Phase 3)."
    };
    return { result, provenance };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function redact(argv, dir) {
  return argv.map((a) => (typeof a === "string" && a.startsWith(dir) ? "<tmp>/" + path.basename(a) : a));
}

/** The CLI records the input paths in its JSON (cli.py:296-298, :513); those are temp paths here. */
function scrubPaths(obj, dir) {
  if (!obj || typeof obj !== "object") return;
  for (const key of ["alignment", "tree", "phenotype_file"]) {
    if (typeof obj[key] === "string" && obj[key].startsWith(dir)) obj[key] = path.basename(obj[key]);
  }
}
