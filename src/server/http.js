/**
 * Streamable HTTP MCP endpoint (official SDK). Multi-session: every client
 * session gets its own transport + McpServer, all sharing the single
 * RaceSession (server-authoritative state).
 *
 *   POST   /mcp   JSON-RPC messages (initialize starts a new session)
 *   GET    /mcp   SSE stream for server->client messages (session id required)
 *   DELETE /mcp   session termination (session id required)
 *   GET    /state current race state as JSON (spectator fallback, see below)
 *   GET    /healthz 200 + race status (null before anyone joins, then race
 *                   id + phase) — for container platform health checks
 *   GET    /tracks/<id>.json visual track definition (MCPG-27); only ids that
 *                   exist in the `tracks/` registry are served
 *
 * Non-MCP GETs may serve static files (`staticDir` option) — used for the
 * spectator client (Slice 2). The spectator WebSocket (`/spectate`, see
 * spectator.js) attaches to this server via its 'upgrade' event.
 *
 * `GET /state` returns the current race state as JSON. The spectator client
 * uses it as a fallback when its WebSocket closes before it has seen the
 * final (finished) snapshot — e.g. when the server process exits right
 * after the race and the last frame is lost in the shutdown race.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcpServer.js';
import { tryServeStatic } from './staticFiles.js';
import { tryServeTrackDef } from '../tracks.js';

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

export function createMcpHttpServer(session, { path = '/mcp', staticDir = null } = {}) {
  const transports = new Map(); // sessionId -> transport

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url.split('?')[0].split('#')[0];
      if (urlPath !== path) {
        if (urlPath === '/healthz' && req.method === 'GET') {
          const state = session.state();
          const race =
            state.cars.length === 0
              ? null // no race yet: nobody has joined
              : {
                  id: session.raceId,
                  phase: state.phase,
                  currentLap: state.currentLap,
                  totalLaps: state.totalLaps,
                };
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true, race }));
          return;
        }
        if (urlPath === '/state' && req.method === 'GET') {
          const state = session.state();
          state.finished = state.phase === 'finished';
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(state));
          return;
        }
        if (tryServeTrackDef(req, res)) return;
        if (staticDir && tryServeStatic(req, res, staticDir)) return;
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          // New session: one stable identity per MCP client session (MCPG-58).
          // The id is generated up front so the tool layer can key driver
          // identity to it — two clients that join with the same display
          // name still get two distinct cars.
          const sid = randomUUID();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sid,
            onsessioninitialized: (sidInitialized) => {
              transports.set(sidInitialized, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          const mcp = createMcpServer(session, { sessionId: sid });
          await mcp.connect(transport);
        }
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown session' }));
          return;
        }
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      } else {
        res.end();
      }
    }
  });

  return server;
}
