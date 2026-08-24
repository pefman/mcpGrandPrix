import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../src/server/staticServe.js';
import { closeServer } from './helpers.js';

/**
 * Split-deploy static server: the same client build can be served by a
 * process separate from the game server (the Docker `client` service,
 * Vercel static, etc.) — same files, same 404 shape.
 */
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let server;
let baseUrl;

beforeAll(async () => {
  server = createStaticServer(clientDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 30000);

afterAll(async () => {
  await closeServer(server);
});

describe('createStaticServer (split deployment)', () => {
  it('serves the client page and its assets', async () => {
    const res = await fetch(baseUrl + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('MCP Grand Prix');

    const js = await fetch(baseUrl + '/js/main.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('404s unknown paths with the same JSON shape as the game server', async () => {
    const res = await fetch(baseUrl + '/nope.js');
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'not found' });
  });
});
