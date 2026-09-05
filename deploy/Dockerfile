# Dockerfile — the HyphAeon Node server (API + MCP) as one image.
#
# WHY THIS FILE EXISTS. deploy/docker-compose.yml is the alternative to pm2 for a host without
# Node installed: the same server, the same environment variables, the models and the job data
# as volumes. The build context is the repository root (the server depends on ../runtime, ../mcp
# and the sibling ../HyphAeon/js library by path), so the compose file sets `context: ..` and
# the library is expected checked out beside the app at build time.
#
# x86-64 only: onnxruntime-node 1.23.2 is pinned for x64 (CLAUDE.md); on Apple silicon build with
# `docker build --platform linux/amd64`.
FROM node:22-bookworm-slim AS build
WORKDIR /opt
COPY HyphAeon/js ./HyphAeon/js
COPY hyphaeon-app/runtime ./hyphaeon-app/runtime
COPY hyphaeon-app/mcp ./hyphaeon-app/mcp
COPY hyphaeon-app/server ./hyphaeon-app/server
WORKDIR /opt/hyphaeon-app/server
RUN npm install --no-workspaces --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HYPHAEON_SERVER_PORT=7040 \
    HYPHAEON_DATA_DIR=/data \
    HYPHAEON_MODELS_DIR=/models \
    HYPHAEON_TRUST_PROXY=1
COPY --from=build /opt /opt
WORKDIR /opt/hyphaeon-app/server
VOLUME ["/data", "/models"]
EXPOSE 7040
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:7040/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "bin/hyphaeon-server.js"]
