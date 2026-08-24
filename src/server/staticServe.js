/**
 * Standalone static file server for the spectator client (split deployment).
 *
 *   node src/server/staticServe.js <dir> [port]     (PORT env also works)
 *
 * Serves <dir> at / with the same tryServeStatic() the game server uses.
 * For stacks where the client is hosted separately from the game server —
 * the Docker `client` service, Vercel static, etc. — point the page at the
 * game server with ?server=http://host:port.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryServeStatic } from './staticFiles.js';

export function createStaticServer(dir) {
  const root = path.resolve(dir);
  return http.createServer((req, res) => {
    if (!tryServeStatic(req, res, root)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    }
  });
}

// CLI: node src/server/staticServe.js <dir> [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? '.';
  const port = Number(process.argv[3] ?? process.env.PORT ?? '8080');
  createStaticServer(dir, port).listen(port, () => {
    console.log(JSON.stringify({ type: 'static_ready', dir: path.resolve(dir), port }));
  });
}
