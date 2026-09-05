#!/usr/bin/env bash
# rsync-web.sh — push the static SvelteKit build to the web host.
#
# WHY THIS FILE EXISTS. The web app is static (adapter-static); deploying it is copying
# web/build/ to the document root Apache serves (deploy/apache-hyphaeon.conf). This script does
# that with rsync, atomically enough for a static site (upload to a staging directory beside the
# live one, then swap the symlink), and refuses to run on a build that lacks the model assets,
# because a build made with HYPHAEON_PREBAKE=skip or without copy-assets has no /models and every
# analysis would fail in the browser. Nothing here touches the Node server; restart that with pm2.
#
# Usage: deploy/rsync-web.sh [user@host] [remote-root]
#   defaults: $HYPHAEON_DEPLOY_HOST (placeholder: deploy@silverback.example.org),
#             $HYPHAEON_DEPLOY_ROOT (placeholder: /var/www/hyphaeon)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/../web/build"
HOST="${1:-${HYPHAEON_DEPLOY_HOST:-deploy@silverback.example.org}}"
ROOT="${2:-${HYPHAEON_DEPLOY_ROOT:-/var/www/hyphaeon}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ ! -f "$BUILD/index.html" ]]; then
  echo "no build at $BUILD; run: npm -w web run build" >&2
  exit 1
fi
if [[ ! -f "$BUILD/models/manifest.json" ]]; then
  echo "build has no models/manifest.json (built with HYPHAEON_PREBAKE=skip or without copy-assets?)" >&2
  exit 1
fi
if ! ls "$BUILD"/ort/*.wasm >/dev/null 2>&1; then
  echo "build has no ONNX Runtime WASM under ort/ (built without copy-assets?)" >&2
  exit 1
fi

echo "uploading $BUILD -> $HOST:$ROOT/releases/$STAMP"
ssh "$HOST" "mkdir -p '$ROOT/releases/$STAMP'"
# Model and ORT assets are large and content-addressed: hard-link them from the current release
# when unchanged so a deploy moves only the app bundle.
rsync -az --delete \
  --link-dest="$ROOT/build/" \
  "$BUILD/" "$HOST:$ROOT/releases/$STAMP/"
ssh "$HOST" "ln -sfn '$ROOT/releases/$STAMP' '$ROOT/build.new' && mv -Tf '$ROOT/build.new' '$ROOT/build' && ls -1dt '$ROOT'/releases/* | tail -n +6 | xargs -r rm -rf"
echo "live: $HOST:$ROOT/build -> releases/$STAMP"
echo "verify: curl -sI https://<host>/ | grep -i cross-origin; curl -s https://<host>/api/v1/health"
