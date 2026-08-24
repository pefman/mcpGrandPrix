# MCP Grand Prix game server — one image for every host.
#
#   docker build -t mcp-grand-prix .
#   docker run --rm -p 3080:3080 mcp-grand-prix
#
# One entrypoint serves everything on one configurable port (PORT, default
# 3080): MCP Streamable HTTP (POST /mcp), the spectator WebSocket
# (ws://host:port/spectate), the spectator client (static files at /),
# GET /state, and GET /healthz. The server is persistent: after each race it
# holds the result (RESULTS_HOLD_SECONDS) and opens the next session; it
# exits on SIGTERM (docker stop). All configuration via env vars — see
# README ("Docker" section).

# ---- deps: production node_modules only ---------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY agents ./agents
COPY client ./client
COPY scripts ./scripts
COPY tracks ./tracks
# decision-log volume (mounted at /logs by docker compose); pre-owned by the
# non-root user so the bind mount is writable from the first start
RUN mkdir -p /logs && chown node:node /logs
# non-root: the 'node' user (uid 1000) that ships with the official image
USER node
EXPOSE 3080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3080') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server/main.js"]
