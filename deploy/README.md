# Deploying HyphAeon — runbook

<!--
WHY THIS FILE EXISTS. PLAN.md 3.5 and 3.6 describe what the server does; this page says how to
put the static web build and the Node server on a host, what to check afterwards, and what to do
when something is wrong. Nothing in this directory deploys anything by itself: the operator runs
these steps.
-->

Two deliverables go to the host:

| What | Built from | Served by | Path on host |
|---|---|---|---|
| The web app (static, runs analyses in the browser) | `npm -w web run build` → `web/build/` | Apache | `/var/www/hyphaeon/build` |
| The Node server (REST jobs + MCP over HTTP behind OAuth) | `server/` | Node 22 under pm2 (or Docker) on `127.0.0.1:7040` | `/opt/hyphaeon-app` |

Apache is the only public listener: it serves the build, terminates TLS, and reverse-proxies
`/api/`, `/mcp`, the OAuth endpoints and the `/.well-known/` documents to Node
(`apache-hyphaeon.conf`). The browser therefore sees one origin, which is what the server's
same-origin rule (`HYPHAEON_SERVER_ISSUER`) and the OAuth `resource` (`<issuer>/mcp`) assume.

## What the host needs: Node and the model files. Nothing else.

**No Python and no HyPhy are installed anywhere in this deployment.** Every analysis — site
selection, the omnibus, epistasis and sectors, the digital DMS, and phenotype association since
Phase 3 — is JavaScript running under `onnxruntime-node` in the server's worker threads, over the
ported library (`@veg/hyphaeon-js`). The server starts no subprocess: there is no `hyphaeon` CLI
to install, no interpreter path to point an environment variable at, no torch, no Hugging Face
download, and no WebAssembly tree tool to vendor (PLAN.md 8 phase 3, D16, D22). If a runbook, a Dockerfile or a systemd unit anywhere in
your infrastructure still installs Python for HyphAeon, it is stale — delete it.

Two consequences worth stating, because they used to be true and are not any more:

- **A tree is optional on every route** (PLAN.md D22). A tree with branch lengths is used as it
  is; with no tree, or a tree with no usable branch lengths, the run computes pairwise Tamura-Nei
  93 distances from the sequences and feeds those to the model — the reference's own `--use-tn93`
  path. Every result records which happened in `provenance.preprocessing.tree_source`
  (`user` | `embedded` | `tn93`). Nothing on the host estimates branch lengths, so a job that used
  to fail for want of a tree now succeeds, and `POST /api/v1/validate` reports a missing tree as
  `TREE_FREE_TN93` at *info* level rather than refusing it.
- **`analysis: "phenotype"` is a normal job**, and `analysis: "analyze"` with an
  `options.phenotype` trait block fills the report's phenotype section from the run's own forward
  pass. Neither needs anything extra installed.

## Files

| File | Purpose |
|---|---|
| `apache-hyphaeon.conf` | vhost: static root, COOP/COEP on HTML, `.onnx`/`.wasm` MIME types, immutable caching for model and ORT assets, `/api` + `/mcp` + OAuth proxied to 7040 with SSE unbuffered. The CSP no longer grants `'unsafe-eval'`: only `'wasm-unsafe-eval'`, for onnxruntime-web. |
| `ecosystem.config.cjs` | pm2 process file for the server (one instance, 30 s kill timeout, `--disable-warning=ExperimentalWarning`). |
| `Dockerfile`, `docker-compose.yml` | The server as a container instead of pm2; models and job data as volumes. |
| `rsync-web.sh` | Upload `web/build/` into a dated release directory and swap the `build` symlink. |

## First deployment

1. **Host**: Debian/Ubuntu with Apache 2.4 (`a2enmod proxy proxy_http headers rewrite ssl`), Node 22.13+
   (x86-64 — `onnxruntime-node` is pinned at 1.23.2 for x64, `CLAUDE.md`), `pm2` (`npm i -g pm2`), certbot.
   That is the whole list: no Python interpreter, no `pip install hyphaeon`, no HyPhy binary.
2. **Checkout** the app and the library side by side, as the workspaces expect:
   ```bash
   sudo mkdir -p /opt && cd /opt
   git clone https://github.com/veg/HyphAeon.git && (cd HyphAeon && git checkout phase-3a)
   git clone https://github.com/veg/hyphaeon-app.git
   cd hyphaeon-app && npm install          # links @veg/hyphaeon-js from ../HyphAeon/js
   ```
   Until `server` is in the root workspaces, install it on its own: `cd server && npm install --no-workspaces --omit=dev`.
3. **Models**: the server reads `manifest.json` + the `.onnx` graphs from `HYPHAEON_MODELS_DIR`.
   `npm -w web run build` copies them into `web/build/models/`; point the server at that directory
   (as `ecosystem.config.cjs` does) or at `HyphAeon/models`. The sha256 in the manifest is verified
   at load, so a wrong file fails loudly at the first job.
4. **Web build** on the build machine, then upload:
   ```bash
   npm -w web run build && npm -w web run check
   HYPHAEON_DEPLOY_HOST=deploy@silverback.example.org HYPHAEON_DEPLOY_ROOT=/var/www/hyphaeon deploy/rsync-web.sh
   ```
5. **Server**: edit the `env` block in `ecosystem.config.cjs` (`HYPHAEON_SERVER_ISSUER` is the public
   `https://` origin — it becomes the OAuth issuer and the only allowed Origin), create the data and
   log directories, start:
   ```bash
   sudo mkdir -p /var/lib/hyphaeon /var/log/hyphaeon && sudo chown $USER /var/lib/hyphaeon /var/log/hyphaeon
   pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
   ```
6. **Apache**: copy `apache-hyphaeon.conf` to `/etc/apache2/sites-available/`, replace the host name
   and paths, `a2ensite hyphaeon && apachectl configtest && systemctl reload apache2`; `certbot --apache`.

### Docker instead of pm2

```bash
docker compose -f deploy/docker-compose.yml up -d --build      # context is the directory above the app
docker compose -f deploy/docker-compose.yml logs -f
```
The compose file binds `127.0.0.1:7040` only; Apache in front is unchanged.

## Verify

```bash
# static site + isolation headers (onnxruntime-web threads need both)
curl -sI https://HOST/ | grep -iE 'cross-origin-(opener|embedder)'
curl -sI https://HOST/models/manifest.json | grep -i content-type          # application/json
curl -sI https://HOST/ort/ort-wasm-simd-threaded.wasm | grep -i content-type   # application/wasm

# server
curl -s https://HOST/api/v1/health | jq .
curl -s https://HOST/api/v1/version | jq .
curl -s https://HOST/api/v1/models | jq '.available, .engine.available, .engine.onnxruntime_node'

# a job end to end (bat_oas1 from the gallery inputs)
jq -n --rawfile a web/static/gallery/inputs/bat_oas1.fasta --rawfile t web/static/gallery/inputs/bat_oas1.nwk \
   '{analysis:"analyze", alignment:$a, tree:$t, names:{alignment:"bat_oas1.fasta", tree:"bat_oas1.nwk"}}' \
 | curl -s -H 'content-type: application/json' -d @- https://HOST/api/v1/jobs | tee /tmp/job.json
ID=$(jq -r .id /tmp/job.json)
curl -sN https://HOST/api/v1/jobs/$ID/events | head -40       # SSE: status, progress, section, done
curl -s "https://HOST/api/v1/jobs/$ID/result?top=10" | jq '.sections.sites.sites[0], .provenance.surface'
curl -s "https://HOST/api/v1/jobs/$ID/result?format=csv" | head -3

# a tree-less job: the same alignment with no tree must succeed and record tree_source "tn93"
jq -n --rawfile a web/static/gallery/inputs/bat_oas1.fasta \
   '{analysis:"meme", alignment:$a, names:{alignment:"bat_oas1.fasta"}}' \
 | curl -s -H 'content-type: application/json' -d @- https://HOST/api/v1/jobs | jq -r .id
# ... then: curl -s https://HOST/api/v1/jobs/$ID/result | jq '.provenance.preprocessing.tree_source'   # "tn93"

# a phenotype job (no Python involved)
jq -n --rawfile a web/static/gallery/inputs/RHO.fasta \
   '{analysis:"phenotype", alignment:$a, options:{phenotype:{preset:"marine"}}}' \
 | curl -s -H 'content-type: application/json' -d @- https://HOST/api/v1/jobs | jq -r .id

# OAuth discovery (resource MUST be <issuer>/mcp) and the bearer challenge
curl -s https://HOST/.well-known/oauth-protected-resource/mcp | jq .
curl -si -X POST https://HOST/mcp -H 'content-type: application/json' -d '{}' | grep -iE '^(HTTP|WWW-Authenticate)'
```

Add the connector in Claude Code: `claude mcp add --transport http hyphaeon https://HOST/mcp`; the
OAuth flow auto-approves (there are no accounts) and a headless machine gets the copy-paste page
through `urn:ietf:wg:oauth:2.0:oob`.

## Operating

- **Logs**: `pm2 logs hyphaeon-server`; lines are prefixed `[hyphaeon-server]`, `[hyphaeon-server][jobs]`,
  `[hyphaeon-server][oauth]`, `[hyphaeon-server][mcp]`. `HYPHAEON_SERVER_LOG=debug` for the worker's engine lines.
- **Jobs on disk**: `HYPHAEON_DATA_DIR/jobs.sqlite` (metadata) and `HYPHAEON_DATA_DIR/jobs/<id>/`
  (inputs as submitted, `result.json`, `sections/*.json`). The sweep runs every 10 minutes and removes
  rows past the 7-day TTL together with their directories, and any directory without a row. Rows left
  `queued`/`running` by a crash are failed with `SERVER_RESTARTED` at the next start; the client resubmits.
- **No interpreter to keep current**: the only third-party runtime on the host is Node and the
  pinned `onnxruntime-node`. Upgrading the science means checking out a new `HyphAeon` tag and
  re-running `npm install`; there is no second language to keep in step.
- **Capacity**: one worker by default (`HYPHAEON_SERVER_WORKERS`), each holding its own ONNX sessions
  (~1 GB RSS with the general graph and the head, more with `viral`). `HYPHAEON_SERVER_THREADS` is the
  ORT intra-op thread count per worker; a laptop-class x64 core count of 4 makes bat_oas1's full report
  (with the 19·L DMS sweep) about 30 s and RHO's site pass about 20 s. Two workers only help when
  jobs arrive faster than they finish and memory allows.
- **Caps** are the MCP's (`mcp/src/caps.js`): alignment ≤ 8 MiB, 3 ≤ taxa ≤ 1,000, codons ≤ 30,000
  (≤ 3,000 for `dms`), work `L·N²` ≤ 2.5e9, permutations ≤ 10,000, job timeout 10 min. A refused upload
  is `422 {error:{kind:"input", code:"CAPS_EXCEEDED"}}` before any worker runs.
- **Rate limits** per IP per minute: 120 on `/api`, 20 job submissions, 120 on `/mcp`, 60 on the OAuth
  endpoints (`HYPHAEON_RATE_*`). Apache's `X-Forwarded-For` is trusted from loopback only
  (`HYPHAEON_TRUST_PROXY`).
- **Rotate the server**: `pm2 reload hyphaeon-server` (SIGTERM → workers release their sessions → exit 0;
  a `mutex lock failed` abort in the log means a session was still alive at exit — raise `kill_timeout`).
- **Rotate the web build**: `deploy/rsync-web.sh` keeps the last five releases under `releases/`; roll back by
  re-pointing the `build` symlink.

## MCP notifications are best-effort

When an MCP tool hands back a job id (above the synchronous caps, or `run_async`), the server sends a
`notifications/message` on the session's standalone GET stream when the job ends. The transport has
no event store: a notification sent before the client opened that stream, or during a reconnect gap,
is dropped and never retried (datamonkey-js-server `lib/mcp/job-notifier.js` documents the same).
`job_status` polling is the source of truth; nothing is lost by missing the message.

## Do not

- Do not expose port 7040 directly, or run with `HYPHAEON_MCP_AUTH=0`, on a public host: anyone could
  run analyses and read finished reports. The server logs a banner when the mount is unauthenticated.
- Do not put the server on a different origin from the web app without adding that origin to
  `HYPHAEON_SERVER_EXTRA_ORIGINS`: the API refuses foreign `Origin` headers.
- Do not run two server processes on one data directory; SQLite is per-process here.
- Do not install Python, `pip install hyphaeon`, HyPhy or a `tn93` binary "so the server can fall
  back to them". Nothing looks for them, nothing would use them, and a host that has them
  invites the belief that a result came from the reference implementation when it did not.
