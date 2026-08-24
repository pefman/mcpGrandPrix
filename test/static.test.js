import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { closeServer } from './helpers.js';

/**
 * Slice 2: the game server serves the spectator client's static files
 * (same origin), so `npm start` -> open the port -> watch.
 */
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let server;
let session;
let baseUrl;

function get(urlPath, { method = 'GET', expectBody = true } = {}) {
  return fetch(baseUrl + urlPath, { method }).then(async (res) => {
    const body = expectBody ? await res.text() : '';
    return { status: res.status, headers: res.headers, body };
  });
}

beforeAll(async () => {
  session = new RaceSession({ totalLaps: 5, logToStdout: false });
  server = createMcpHttpServer(session, { staticDir: clientDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 30000);

afterAll(async () => {
  await closeServer(server);
});

describe('static serving of the spectator client', () => {
  it('GET / serves index.html', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.body).toContain('MCP Grand Prix');
    expect(res.body).toContain('importmap');
    // welcome screen carries the copy-paste harness prompt (MCPG-36)
    expect(res.body).toContain('id="harness-prompt"');
    expect(res.body).toContain('id="copy-harness-prompt"');
    expect(res.body).toContain('Paste this into your AI to get racing');
  });

  it('serves the welcome-screen harness prompt module', async () => {
    const res = await get('/js/harnessPrompt.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    // versioned constant + placeholders filled per-instance (never hardcoded URLs)
    expect(res.body).toContain('HARNESS_PROMPT_REVISION');
    expect(res.body).toContain('{mcp_url}');
    expect(res.body).toContain('{spectate_url}');
    expect(res.body).toContain('join_race');
    expect(res.body).not.toContain('gp.peterfrank.se');
  });

  it('serves JS and CSS with the right content types', async () => {
    const js = await get('/js/main.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.body).toContain('SpectatorConnection');

    const css = await get('/style.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const cfg = await get('/config.js');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toContain('MGP_SERVER_URL');
  });

  it('serves the vendored three.js (both modules the import map needs)', async () => {
    const three = await get('/vendor/three.module.js', { expectBody: false });
    expect(three.status).toBe(200);
    expect(three.headers.get('content-type')).toContain('javascript');
    expect(three.headers.get('cache-control')).toContain('max-age=86400');

    const core = await get('/vendor/three.core.js', { expectBody: false });
    expect(core.status).toBe(200);
  });

  it('rejects path traversal outside the client root', async () => {
    // encoded so the HTTP client does not normalize it away
    const res = await get('/..%2fpackage.json');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('"name": "mcp-grand-prix"');

    const res2 = await get('/js/../../package.json');
    expect(res2.status).toBe(404);
  });

  it('unknown paths and non-GET methods fall through to 404', async () => {
    expect((await get('/nope.js')).status).toBe(404);
    expect((await get('/', { method: 'POST' })).status).toBe(404);
  });

  it('GET /state returns the current race state as JSON (spectator fallback)', async () => {
    const res = await get('/state');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.phase).toBe('setup'); // session not started in this suite
    expect(body.finished).toBe(false);
    expect(body.track.lengthM).toBe(1000);
    expect(Array.isArray(body.cars)).toBe(true);
    expect(Array.isArray(body.standings)).toBe(true);
  });

  it('does not shadow the MCP endpoint', async () => {
    const res = await get('/mcp', { method: 'POST' });
    // Streamable HTTP answers initialize with a session; whatever it is,
    // it must not be a static 404 and must not leak client files.
    expect(res.status).not.toBe(404);
  });
});

describe('GET /healthz (container platform health check)', () => {
  it('200 with no race before anyone joins', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.race).toBeNull();
  });

  it('200 with race id + phase once an agent has joined', async () => {
    session.addAgent('HealthCheckCar', 'test');
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.race).not.toBeNull();
    expect(body.race.id).toHaveLength(36); // UUID v4
    expect(body.race.phase).toBe('setup');
    expect(body.race.currentLap).toBe(0);
    expect(body.race.totalLaps).toBe(5);
  });
});
