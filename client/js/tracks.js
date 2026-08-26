/**
 * Track definitions — client loader (MCPG-27, contract since MCPG-63).
 *
 * The race server's snapshot carries track.info() (with id since MCPG-27).
 * When the id is known we fetch the full def (waypoints + theme + props)
 * from the same server that serves this page. Old servers (no id / unknown
 * id / fetch failure) fall back to LEGACY_DEF: the pre-MCPG-27 control
 * points and dark theme, so the client keeps working against them.
 *
 * A fetched def must satisfy the track contract before it reaches the scene
 * builders: violations fall back to LEGACY_DEF with a console warning (a
 * broken map degrades to a plain ring, never to NaN geometry or a dead
 * page). Unknown fields/prop types are stripped with warnings — forward
 * compatibility.
 */
import { sanitizeTrackDef, validateTrackDef } from './trackContract.js';

/** Pre-MCPG-27 look: the original 12 control points, dark palette. */
export const LEGACY_DEF = {
  id: 'ring',
  name: 'Grand Prix Ring (legacy)',
  lengthM: 1000,
  sectorLengthM: 200,
  roadWidthM: 14,
  waypoints: [
    [0, 170], [150, 130], [168, 0], [150, -130], [0, -170],
    [-150, -130], [-168, 0], [-150, 130], [-75, 155],
    [0, 150], [75, 155], [120, 100],
  ],
  water: [],
  props: [],
  scatter: null,
  theme: {
    sky: '#0b1018',
    ground: { base: '#16202c', spot: '#1c2836', patch: '#101923', tileM: 6 },
    road: { base: '#2e3747', spot: '#28303e', tileM: 3 },
    curb: { red: '#e8362e', white: '#fdf6e8' },
    pit: '#374152',
    barriers: false,
    ambient: { sky: '#6f88b0', ground: '#141c28', intensity: 1.0 },
    sun: { color: '#9fb4ff', intensity: 0.95 },
  },
};

/**
 * Resolve the visual def for a snapshot's track info.
 * @param {object} trackInfo  track info from the snapshot (may lack id)
 * @returns {Promise<object>} track def (validated + sanitized, or LEGACY_DEF)
 */
export async function loadTrackDef(trackInfo) {
  const id = trackInfo?.id;
  if (!id || id === 'ring') return LEGACY_DEF;
  try {
    const res = await fetch(`/tracks/${encodeURIComponent(id)}.json`);
    if (!res.ok) {
      console.warn(`tracks/${id}.json: fetch failed (${res.status}) — using legacy ring`);
      return LEGACY_DEF;
    }
    const def = await res.json();
    const check = validateTrackDef(def);
    if (!check.ok) {
      // a broken map must never reach the scene builders: degrade loudly
      console.warn(`tracks/${id}.json: invalid track contract — using legacy ring`, check.errors);
      return LEGACY_DEF;
    }
    for (const w of check.warnings) console.warn(`tracks/${id}.json: ${w}`);
    const clean = sanitizeTrackDef(def);
    // prefer the server's authoritative numbers (name/length) if present
    if (trackInfo.name) clean.name = trackInfo.name;
    if (trackInfo.lengthM) clean.lengthM = trackInfo.lengthM;
    return clean;
  } catch (e) {
    console.warn(`tracks/${id}: could not load (${e?.message ?? e}) — using legacy ring`);
    return LEGACY_DEF;
  }
}
