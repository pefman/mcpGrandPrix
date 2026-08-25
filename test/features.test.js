import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { closeServer } from './helpers.js';

/**
 * MCPG-35: the /features changelog page.
 *
 * Covers the hand-edited content file (parses, ids strictly increase) and
 * the serving surface: /features, /features/ and /features.json are 200
 * from the game server with no server-code changes (tryServeStatic already
 * serves the whole client/ tree), and the page + badge modules are intact.
 */
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

describe('features.json content file', () => {
  const raw = fs.readFileSync(path.join(clientDir, 'features.json'), 'utf8');
  let entries;

  beforeAll(() => {
    entries = JSON.parse(raw);
  });

  it('parses as a non-empty array', () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('ids strictly increase (the id is the "new" cursor)', () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].id, `entry ${i}`).toBeGreaterThan(entries[i - 1].id);
      expect(Number.isInteger(entries[i].id)).toBe(true);
    }
  });

  it('every entry has a date, a title and note bullets', () => {
    for (const e of entries) {
      expect(typeof e.title).toBe('string');
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(e.notes)).toBe(true);
      expect(e.notes.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /features (static serving, no server-code changes)', () => {
  let server;
  let session;
  let baseUrl;

  function get(urlPath) {
    return fetch(baseUrl + urlPath).then(async (res) => ({
      status: res.status,
      headers: res.headers,
      body: await res.text(),
    }));
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

  it('serves the page at /features and /features/', async () => {
    for (const p of ['/features', '/features/']) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.body).toContain('WHAT');
      expect(res.body).toContain('/js/features.js');
    }
  });

  it('serves features.json next to the page (relative fetch target)', async () => {
    const res = await get('/features.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('serves the page renderer and the spectator badge module', async () => {
    const renderer = await get('/js/features.js');
    expect(renderer.status).toBe(200);
    expect(renderer.headers.get('content-type')).toContain('javascript');
    expect(renderer.body).toContain('features.json');
    expect(renderer.body).toContain('mgp-features-seen');

    const badge = await get('/js/featuresBadge.js');
    expect(badge.status).toBe(200);
    expect(badge.body).toContain('mgp-features-seen');
    expect(badge.body).toContain("target = '_blank'"); // new tab, never steal the race tab

    // the spectator actually wires the badge in
    const main = await get('/js/main.js');
    expect(main.body).toContain('featuresBadge.js');
  });
});
