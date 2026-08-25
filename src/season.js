/**
 * Championship season points (MCPG-49).
 *
 * A persistent F1-style championship accumulates across every completed
 * race session on the server. Scoring is top-8 only — 15/12/10/8/6/4/2/1
 * for P1..P8, 0 for P9+ and DNF — computed ONCE per finished race from its
 * final standings. No simulation changes: the points are derived from the
 * existing `race_finished` standings, so determinism is untouched.
 *
 * Persistence: one JSON file on the log volume (same pattern as
 * next_track.json, MCPG-28 — survives container restarts):
 *
 *   { version: 1, drivers: { [name]: { points, wins, races, dnf, streak } } }
 *
 * A missing file is a first boot; a CORRUPT file starts an empty season
 * with a warning and never crashes the server.
 *
 * Standings tiebreak: points desc, then wins desc, then fewer DNFs, then
 * name asc (plain string compare — deterministic across runs).
 *
 * Reset (manual, no admin UI): delete the file (default `/logs/season.json`,
 * override with `MCGP_SEASON_FILE`) and restart the server.
 */
import fs from 'node:fs';
import path from 'node:path';

/** F1 top-8 scoring; P9+ and DNF score 0. */
export const SEASON_POINTS = [15, 12, 10, 8, 6, 4, 2, 1];
export const SCHEMA_VERSION = 1;

/** Where the season persists (log volume, same mount as next_track.json). */
export const SEASON_FILE = process.env.MCGP_SEASON_FILE || '/logs/season.json';

/** A fresh empty season. */
export function emptySeason() {
  return { version: SCHEMA_VERSION, drivers: {} };
}

/** Coerce one driver record to the known shape (defensive on old files). */
function sanitizeDriver(d) {
  if (!d || typeof d !== 'object') return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    points: num(d.points),
    wins: num(d.wins),
    races: num(d.races),
    dnf: num(d.dnf),
    streak: num(d.streak),
  };
}

/**
 * Read the persisted season.
 * @returns {{state: object, source: 'missing'|'loaded'|'corrupt', error?: string}}
 *   `missing` — no file yet (first boot), empty season.
 *   `loaded`  — valid file; missing per-driver fields default to 0.
 *   `corrupt` — unreadable JSON or unexpected shape; EMPTY season, caller
 *               should warn. Never throws.
 */
export function readSeason(file) {
  const f = file ?? SEASON_FILE;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: emptySeason(), source: 'missing' };
    return { state: emptySeason(), source: 'corrupt', error: err?.message ?? String(err) };
  }
  const drivers = {};
  if (
    raw &&
    typeof raw === 'object' &&
    raw.drivers &&
    typeof raw.drivers === 'object' &&
    !Array.isArray(raw.drivers)
  ) {
    for (const [name, d] of Object.entries(raw.drivers)) {
      const rec = sanitizeDriver(d);
      if (rec) drivers[name] = rec;
    }
    return { state: { version: SCHEMA_VERSION, drivers }, source: 'loaded' };
  }
  return { state: emptySeason(), source: 'corrupt', error: 'unexpected shape' };
}

/**
 * Persist the season atomically (tmp file + rename — a crash mid-write
 * cannot corrupt the file, same as persistNextTrack).
 */
export function saveSeason(state, file) {
  const f = file ?? SEASON_FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const payload = { version: SCHEMA_VERSION, drivers: state.drivers ?? {} };
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

/**
 * Apply one finished race's final standings to a season state (pure —
 * returns a new state; the input is not mutated).
 *
 * @param {object} state season state
 * @param {Array}  standings final standings entries `{ position, name, status }`
 *   (status 'FINISHED' | 'RETIRED')
 * @returns {{state: object, awards: Array}} `awards` has one entry per car:
 *   `{ name, position, status, pointsEarned, pointsTotal, wins, races, dnf, streak }`
 */
export function applyRace(state, standings) {
  const drivers = {};
  for (const [name, d] of Object.entries(state?.drivers ?? {})) drivers[name] = { ...d };
  const awards = [];
  for (const entry of standings ?? []) {
    const d = drivers[entry.name] ?? { points: 0, wins: 0, races: 0, dnf: 0, streak: 0 };
    d.races += 1;
    const won = entry.status === 'FINISHED' && entry.position === 1;
    if (won) {
      d.wins += 1;
      d.streak += 1; // consecutive wins
    } else {
      d.streak = 0;
    }
    if (entry.status === 'RETIRED') d.dnf += 1;
    const pointsEarned =
      entry.status === 'FINISHED' && entry.position >= 1 && entry.position <= SEASON_POINTS.length
        ? SEASON_POINTS[entry.position - 1]
        : 0;
    d.points += pointsEarned;
    drivers[entry.name] = d;
    awards.push({
      name: entry.name,
      position: entry.position,
      status: entry.status,
      pointsEarned,
      pointsTotal: d.points,
      wins: d.wins,
      races: d.races,
      dnf: d.dnf,
      streak: d.streak,
    });
  }
  return { state: { version: SCHEMA_VERSION, drivers }, awards };
}

/**
 * Rank the season: points desc, wins desc, fewer DNFs, name asc.
 * @returns {Array<{position, name, points, wins, races, dnf, streak}>}
 */
export function rankSeason(state) {
  const rows = Object.entries(state?.drivers ?? {}).map(([name, d]) => ({ name, ...d }));
  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      a.dnf - b.dnf ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return rows.map((r, i) => ({
    position: i + 1,
    name: r.name,
    points: r.points,
    wins: r.wins,
    races: r.races,
    dnf: r.dnf,
    streak: r.streak,
  }));
}
