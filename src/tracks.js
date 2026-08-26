/**
 * Track registry (MCPG-27).
 *
 * Visual track definitions live in `tracks/*.json` at the repo root. The
 * server only needs the identity fields (id / name / lengthM / sectorLengthM);
 * the spectator client fetches the full definition (waypoints, theme, props)
 * from `GET /tracks/<id>.json` and renders the scene.
 *
 * Every file is checked against the track contract (MCPG-63, see
 * tracks/README.md) when the registry loads: violations fail fast at
 * startup, unknown fields/types are stripped with a logged warning.
 *
 * The active track is chosen with the `MCGP_TRACK` env var (track id).
 * Unknown values fail fast at startup — a typo must not silently start a
 * race on the wrong circuit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Track } from './track.js';
import { sanitizeTrackDef, validateTrackDef } from './trackContract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRACKS_DIR = path.resolve(here, '..', 'tracks');
export const DEFAULT_TRACK_ID = 'coastal-palm';
// Where the post-race vote (MCPG-28) persists its winner. Lives on the
// LOG_FILE volume so it survives container restarts (Dockerfile + compose
// mount ./log at /logs; the VPS deploy does the same).
export const NEXT_TRACK_FILE =
  process.env.MCGP_NEXT_TRACK_FILE || '/logs/next_track.json';

/**
 * Validate + sanitize one raw map file against the track contract (MCPG-63).
 * Contract violations abort startup with every violation of the file listed;
 * unknown fields/types are stripped with a logged warning (forward compat).
 */
function checkedDef(raw, file) {
  const check = validateTrackDef(raw);
  if (!check.ok) {
    throw new Error(
      `tracks/${file}: invalid track contract\n  ${[...check.errors].join('\n  ')}`,
    );
  }
  for (const w of check.warnings) console.warn(`tracks/${file}: warning: ${w}`);
  const def = sanitizeTrackDef(raw);
  // identity must match the file name so GET /tracks/<id>.json stays honest
  if (def.id !== file.replace(/\.json$/, '')) {
    throw new Error(`tracks/${file}: "id" (${def.id}) must equal the file name stem`);
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
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(TRACKS_DIR, f), 'utf8'));
      } catch (e) {
        throw new Error(`tracks/${f}: not valid JSON (${e.message})`);
      }
      const def = checkedDef(raw, f);
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
/**
 * Persist the next-race track decision (MCPG-28): the winner of the
 * post-race spectator vote, or the deterministic fallback rotation when no
 * votes came in. `source` is 'vote' or 'fallback'. Written atomically (tmp
 * file + rename) so a crash mid-write cannot corrupt the file.
 */
export function persistNextTrack({ trackId, source, votes, file = NEXT_TRACK_FILE } = {}) {
  const payload = {
    trackId,
    source,
    votes: votes ?? {},
    raceId: null, // caller fills in
    decidedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return payload;
}

/** Read the persisted decision; null when missing/corrupt (first boot). */
export function readNextTrack(file = NEXT_TRACK_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw.trackId !== 'string' || !getTrackDef(raw.trackId)) return null;
    return raw;
  } catch {
    return null;
  }
}

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
