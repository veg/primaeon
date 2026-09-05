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

## Files

| File | Purpose |
|---|---|
| `apache-hyphaeon.conf` | vhost: static root, COOP/COEP on HTML, `.onnx`/`.wasm` MIME types, immutable caching for model assets, `/api` + `/mcp` + OAuth proxied to 7040 with SSE unbuffered. |
| `ecosystem.config.cjs` | pm2 process file for the server (one instance, 30 s kill timeout, `--disable-warning=ExperimentalWarning`). |
| `Dockerfile`, `docker-compose.yml` | The server as a container instead of pm2; models and job data as volumes. |
| `rsync-web.sh` | Upload `web/build/` into a dated release directory and swap the `build` symlink. |

## First deployment

1. **Host**: Debian/Ubuntu with Apache 2.4 (`a2enmod proxy proxy_http headers rewrite ssl`), Node 22.13+
   (x86-64 — `onnxruntime-node` is pinned at 1.23.2 for x64, `CLAUDE.md`), `pm2` (`npm i -g pm2`), certbot.
2. **Checkout** the app and the library side by side, as the workspaces expect:
   ```bash
   sudo mkdir -p /opt && cd /opt
   git clone https://github.com/veg/HyphAeon.git && (cd HyphAeon && git checkout phase-2a)
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
