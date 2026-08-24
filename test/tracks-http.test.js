import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { createTrackFromEnv } from '../src/tracks.js';

/**
 * MCPG-27: GET /tracks/<id>.json — the spectator client fetches the full
 * visual definition from the game server. Only registry ids are served;
 * everything else is a clean 404 (no path traversal, no file listing).
 */
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let server;
let baseUrl;

async function get(urlPath) {
  const res = await fetch(baseUrl + urlPath);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

beforeAll(async () => {
  const track = createTrackFromEnv({ MCGP_TRACK: 'city-night' });
  const session = new RaceSession({ totalLaps: 5, logToStdout: false, track });
  server = createMcpHttpServer(session, { staticDir: clientDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 30000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /tracks/<id>.json', () => {
  it('serves every registered track definition', async () => {
    for (const id of ['coastal-palm', 'mountain-hairpins', 'city-night']) {
      const res = await get(`/tracks/${id}.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const def = JSON.parse(res.body);
      expect(def.id).toBe(id);
      expect(def.lengthM).toBe(1000);
      expect(def.waypoints.length).toBeGreaterThanOrEqual(6);
      expect(def.theme.sky).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('serves the active track id from /state track info', async () => {
    const res = await get('/state');
    const state = JSON.parse(res.body);
    expect(state.track.id).toBe('city-night');
    expect(state.track.lengthM).toBe(1000);
    expect(state.track.sectorCount).toBe(5);
  });

  it('unknown ids get a JSON 404', async () => {
    const res = await get('/tracks/does-not-exist.json');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it('rejects path traversal', async () => {
    const res = await get('/tracks/..%2fpackage.json');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('"name": "mcp-grand-prix"');

    const res2 = await get('/tracks/..%2f..%2fsrc%2ftrack.js');
    expect(res2.status).toBe(404);
    expect(res2.body).not.toContain('export class Track');
  });

  it('non-GET methods are not allowed', async () => {
    const res = await fetch(`${baseUrl}/tracks/coastal-palm.json`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('query strings do not break the lookup', async () => {
    const res = await get('/tracks/coastal-palm.json?v=2');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).id).toBe('coastal-palm');
  });
});

describe('session default track (no registry selection)', () => {
  it('RaceSession without a track keeps the legacy ring identity', async () => {
    // the spectator client's LEGACY_DEF fallback keys off id "ring"
    const session = new RaceSession({ totalLaps: 5, logToStdout: false });
    const bare = createMcpHttpServer(session, {});
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${bare.address().port}/state`);
      const state = await res.json();
      expect(state.track.id).toBe('ring');
      expect(state.track.lengthM).toBe(1000);
      expect(state.track.sectorCount).toBe(5);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });
});
