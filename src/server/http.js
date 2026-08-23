/**
 * Streamable HTTP MCP endpoint (official SDK). Multi-session: every client
 * session gets its own transport + McpServer, all sharing the single
 * RaceSession (server-authoritative state).
 *
 *   POST   /mcp   JSON-RPC messages (initialize starts a new session)
 *   GET    /mcp   SSE stream for server->client messages (session id required)
 *   DELETE /mcp   session termination (session id required)
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcpServer.js';

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

export function createMcpHttpServer(session, { path = '/mcp' } = {}) {
  const transports = new Map(); // sessionId -> transport

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          // New session: create transport + a fresh McpServer bound to the shared session
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          const mcp = createMcpServer(session);
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
