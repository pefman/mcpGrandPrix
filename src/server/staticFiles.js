/**
 * Minimal static file server for the spectator client (Slice 2).
 *
 * Serves the `client/` directory from the same HTTP server as the MCP
 * endpoint and the spectator WebSocket, so `npm start` gives a full local
 * experience: open http://127.0.0.1:3080/ in a browser and watch.
 *
 * The client is a plain static site — the same files deploy unchanged to
 * Vercel (Stage 3), where `client/` is served at the site root.
 *
 * No framework, no deps: path resolution with traversal protection and a
 * small MIME map.
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Try to serve a static file from `rootDir` for this GET/HEAD request.
 * Returns true when a file was found and sent, false otherwise (the caller
 * is free to 404 — traversal attempts and unknown paths all fall through).
 */
export function tryServeStatic(req, res, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!fs.existsSync(rootDir)) return false;

  const urlPath = req.url.split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(rootDir, relative));
  // Traversal protection: the resolved path must stay inside the root.
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    const indexFile = path.join(filePath, 'index.html');
    try {
      stat = fs.statSync(indexFile);
      filePath = indexFile;
    } catch {
      return false;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // index.html / config.js reload often; vendored libs are stable
    'Cache-Control': urlPath.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}
