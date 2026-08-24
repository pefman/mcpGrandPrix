/**
 * Track registry (MCPG-27).
 *
 * Visual track definitions live in `tracks/*.json` at the repo root. The
 * server only needs the identity fields (id / name / lengthM / sectorLengthM);
 * the spectator client fetches the full definition (waypoints, theme, props)
 * from `GET /tracks/<id>.json` and renders the scene.
 *
 * The active track is chosen with the `MCGP_TRACK` env var (track id).
 * Unknown values fail fast at startup — a typo must not silently start a
 * race on the wrong circuit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Track } from './track.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRACKS_DIR = path.resolve(here, '..', 'tracks');
export const DEFAULT_TRACK_ID = 'coastal-palm';

function validateDef(def, file) {
  const err = (msg) => new Error(`tracks/${file}: ${msg}`);
  if (typeof def.id !== 'string' || !/^[a-z0-9-]+$/.test(def.id)) throw err('bad "id"');
  if (typeof def.name !== 'string' || !def.name) throw err('bad "name"');
  if (!Number.isFinite(def.lengthM) || def.lengthM <= 0) throw err('bad "lengthM"');
  if (!Number.isFinite(def.sectorLengthM) || def.sectorLengthM <= 0) throw err('bad "sectorLengthM"');
  if (def.lengthM % def.sectorLengthM !== 0) throw err('sectorLengthM must divide lengthM');
  if (!Array.isArray(def.waypoints) || def.waypoints.length < 6) throw err('needs >= 6 waypoints');
  for (const wp of def.waypoints) {
    if (!Array.isArray(wp) || wp.length !== 2 || !wp.every((n) => Number.isFinite(n))) {
      throw err('bad waypoint (expected [x, z] numbers)');
    }
  }
  if (def.roadWidthM != null && (!Number.isFinite(def.roadWidthM) || def.roadWidthM <= 0)) {
    throw err('bad "roadWidthM"');
  }
  return def;
}

let cachedDefs = null;

/** Load and validate all `tracks/*.json` definitions (cached after first read). */
export function loadTrackDefs() {
  if (cachedDefs) return cachedDefs;
  const defs = fs
    .readdirSync(TRACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const def = validateDef(JSON.parse(fs.readFileSync(path.join(TRACKS_DIR, f), 'utf8')), f);
      def.__file = f; // remembered for GET /tracks/<id>.json (http.js)
      return def;
    });
  const ids = new Set();
  for (const d of defs) {
    if (ids.has(d.id)) throw new Error(`tracks/: duplicate id "${d.id}"`);
    ids.add(d.id);
  }
  cachedDefs = defs;
  return defs;
}

/** Look up a definition by id (undefined when unknown). */
export function getTrackDef(id) {
  return loadTrackDefs().find((d) => d.id === id);
}

/**
 * Build the server-side `Track` for the active environment.
 * `MCGP_TRACK` selects the track id; falls back to `coastal-palm`.
 */
export function createTrackFromEnv(env = process.env) {
  const wanted = (env.MCGP_TRACK || DEFAULT_TRACK_ID).trim();
  const def = getTrackDef(wanted);
  if (!def) {
    const known = loadTrackDefs()
      .map((d) => d.id)
      .join(', ');
    throw new Error(`MCGP_TRACK "${wanted}" is not a known track (known: ${known})`);
  }
  return new Track({
    id: def.id,
    name: def.name,
    lengthM: def.lengthM,
    sectorLengthM: def.sectorLengthM,
  });
}

/**
 * Try to answer `GET /tracks/<id>.json` on a Node HTTP request (MCPG-27).
 * Returns true when a response was sent (200 for a known track id, 404
 * otherwise — only registry ids are served, no path traversal), false for
 * any other request so the caller can fall through to its other routes.
 */
export function tryServeTrackDef(req, res) {
  const urlPath = (req.url ?? '').split('?')[0].split('#')[0];
  if (!urlPath.startsWith('/tracks/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  const file = urlPath.slice('/tracks/'.length);
  const looksSafe = /^\w[\w.-]*\.json$/.test(file) && !file.includes('..');
  const def = looksSafe ? getTrackDef(file.slice(0, -'.json'.length)) : undefined;
  if (!def) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown track' }));
    return true;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(TRACKS_DIR, def.__file)));
  return true;
}
