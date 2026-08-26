/**
 * Team dossier (MCPG-62): the per-team (per-car) history of the 3-tactic
 * lock-in loop — "the AI team proposes, the driver locks in" — persisted
 * beside season.json on the log volume (same atomic-write pattern).
 *
 * For every strategy window of every race, per car:
 *   { lap, proposed, chosen, projected, actualAtNextWindow, mode }
 * where `proposed` is the team's plan (recommended card + radio), `chosen`
 * what actually ran (driver lock/override or the autopilot default),
 * `projected` the server-stamped projection of the chosen card, and
 * `actualAtNextWindow` the car's real position/gap when the NEXT window
 * opened (filled from final standings at race end for the last window).
 *
 * Plus per-archetype accuracy rollups (how often the projection was on the
 * mark, |actualPos - projectedPos| <= 1) and trust stats: autopilot laps,
 * deliberate "trust the team" clicks, overrides, and the longest unassisted
 * streak (consecutive windows the driver did not take over the seat).
 *
 * The dossier hangs off the decision-event stream (the same events that hit
 * the JSONL log), so the two can never disagree. Persistence is best-effort
 * per write (atomic tmp+rename like season.json): a non-writable path keeps
 * the dossier in memory and logs a warning instead of killing the server.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DOSSIER_FILE = process.env.MCGP_DOSSIER_FILE || '/logs/team_dossiers.json';
export const SCHEMA_VERSION = 1;
const MAX_RACES = 100; // the file trims to the most recent races
/** Projection "on the mark": actual position within one place of the stamp. */
export const PROJECTION_TOLERANCE_POS = 1;

function emptyCarDossier() {
  return {
    windows: [],
    trust: { autopilot: 0, trusted: 0, overridden: 0, manual: 0, default: 0, longestUnassistedStreak: 0 },
    archetypes: {}, // key -> { proposed, chosen, projectedOnTrack }
  };
}

/** Load the persisted dossiers. Missing file = first boot; corrupt = empty (never throws). */
export function readDossiers(file) {
  const f = file ?? DOSSIER_FILE;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: { version: SCHEMA_VERSION, races: {} }, source: 'missing' };
    return { state: { version: SCHEMA_VERSION, races: {} }, source: 'corrupt', error: err?.message ?? String(err) };
  }
  if (!raw || typeof raw !== 'object' || !raw.races || typeof raw.races !== 'object') {
    return { state: { version: SCHEMA_VERSION, races: {} }, source: 'corrupt', error: 'unexpected shape' };
  }
  const races = {};
  for (const [raceId, r] of Object.entries(raw.races)) {
    if (!r || typeof r !== 'object' || !r.cars || typeof r.cars !== 'object') continue;
    races[raceId] = { startedAt: r.startedAt ?? null, cars: {} };
    for (const [name, c] of Object.entries(r.cars)) {
      const d = emptyCarDossier();
      d.windows = Array.isArray(c.windows) ? c.windows : [];
      for (const k of Object.keys(d.trust)) d.trust[k] = Number.isFinite(c?.trust?.[k]) ? Math.floor(c.trust[k]) : 0;
      d.archetypes = c.archetypes && typeof c.archetypes === 'object' ? c.archetypes : {};
      races[raceId].cars[name] = d;
    }
  }
  return { state: { version: SCHEMA_VERSION, races }, source: 'loaded' };
}

/** Persist atomically (tmp + rename); returns the write error instead of throwing. */
export function saveDossiers(state, file) {
  const f = file ?? DOSSIER_FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const payload = { version: SCHEMA_VERSION, races: state.races ?? {} };
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

export class TeamDossier {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.file]  persistence file (null = in-memory only)
   * @param {Function} [opts.onPersist] (err | null) => void — write failures surface here
   */
  constructor({ file = null, onPersist = () => {} } = {}) {
    this.file = file ?? null;
    this.onPersist = onPersist;
    const loaded = this.file ? readDossiers(this.file) : { state: { version: SCHEMA_VERSION, races: {} }, source: 'missing' };
    this.state = loaded.state;
    this.source = loaded.source;
    this._corrupt = loaded.source === 'corrupt';
    this._corruptError = loaded.error ?? null;
    this._activeRace = null; // raceId currently collecting windows
  }

  /** The active race started collecting (the session's raceId). */
  beginRace(raceId) {
    this._activeRace = raceId;
    if (!this.state.races[raceId]) {
      this.state.races[raceId] = { startedAt: new Date().toISOString(), cars: {} };
      // Trim to the most recent MAX_RACES (insertion order = start order).
      const ids = Object.keys(this.state.races);
      if (ids.length > MAX_RACES) {
        for (const old of ids.slice(0, ids.length - MAX_RACES)) delete this.state.races[old];
      }
      this.persist();
    }
  }

  /**
   * Consume one decision-log event (raceId is injected by the session).
   * Only the tactic-lifecycle events matter; everything else is ignored.
   */
  onEvent(event) {
    const raceId = event.raceId ?? this._activeRace;
    const race = raceId ? this.state.races[raceId] : null;
    if (!race) return;
    switch (event.type) {
      case 'race_start':
        for (const a of event.agents ?? []) {
          if (!race.cars[a.name]) race.cars[a.name] = emptyCarDossier();
        }
        break;
      case 'tactics_proposed': {
        const d = this._car(race, event.name);
        const rec = (event.proposals ?? []).find((p) => p.recommend) ?? null;
        const pending = {
          lap: event.lap,
          radio: event.radio ?? null,
          source: event.source ?? 'team',
          fallback: event.fallback === true,
          proposed: {
            count: (event.proposals ?? []).length,
            recommended: rec ? { key: rec.key, label: rec.label, confidence: rec.confidence } : null,
          },
          // per-archetype "proposed" rollup (display: what the team floated)
          _proposedKeys: (event.proposals ?? []).map((p) => p.key).filter(Boolean),
          _pending: true,
        };
        d.windows.push(pending);
        for (const key of pending._proposedKeys) {
          const a = (d.archetypes[key] ??= { proposed: 0, chosen: 0, projectedOnTrack: 0 });
          a.proposed += 1;
        }
        break;
      }
      case 'auto_trusted':
      case 'strategy_resolved': {
        const d = this._car(race, event.name);
        const entry = d.windows.find((w) => w.lap === event.lap && w._pending) ?? null;
        if (!entry) break;
        entry._pending = false;
        entry.mode = event.type === 'auto_trusted' ? 'autopilot' : event.mode;
        entry.source = event.source ?? 'default';
        entry.chosen = {
          key: event.key ?? null,
          label: event.label ?? null,
          source: event.source ?? 'default',
          strategy: event.strategy ?? event.packet ?? null,
        };
        entry.projected = event.projection ?? null;
        this._updateTrust(d, entry.mode);
        if (entry.chosen.key) {
          const a = (d.archetypes[entry.chosen.key] ??= { proposed: 0, chosen: 0, projectedOnTrack: 0 });
          a.chosen += 1;
        }
        this.persist();
        break;
      }
      case 'window_opened': {
        // The previous window's projections are scored against reality:
        // the car's standings at this window open.
        const byName = new Map((event.standings ?? []).map((s) => [s.name, s]));
        for (const [name, d] of Object.entries(race.cars)) {
          for (const w of d.windows) {
            if (!w._pending && w.actualAtNextWindow == null) {
              const s = byName.get(name);
              if (s) {
                w.actualAtNextWindow = { position: s.position, gapToLeaderM: s.gapToLeaderM };
                this._scoreProjection(d, w);
              }
            }
          }
        }
        break;
      }
      case 'race_finished': {
        const byName = new Map((event.standings ?? []).map((s) => [s.name, s]));
        for (const [name, d] of Object.entries(race.cars)) {
          for (const w of d.windows) {
            if (!w._pending && w.actualAtNextWindow == null) {
              const s = byName.get(name);
              if (s) {
                w.actualAtNextWindow = { position: s.position, gapToLeaderM: s.gapToLeaderM };
                this._scoreProjection(d, w);
              }
            }
          }
        }
        for (const d of Object.values(race.cars)) for (const w of d.windows) delete w._pending;
        for (const d of Object.values(race.cars)) for (const w of d.windows) delete w._proposedKeys;
        this.persist();
        break;
      }
    }
  }

  _car(race, name) {
    if (!race.cars[name]) race.cars[name] = emptyCarDossier();
    return race.cars[name];
  }

  _updateTrust(d, mode) {
    if (mode in d.trust) d.trust[mode] += 1;
    // "Unassisted" = the driver did not take the seat over for this lap.
    const unassisted = mode === 'autopilot' || mode === 'manual' || mode === 'default';
    if (unassisted) {
      d.trust._streak = (d.trust._streak ?? 0) + 1;
      d.trust.longestUnassistedStreak = Math.max(d.trust.longestUnassistedStreak, d.trust._streak);
    } else {
      d.trust._streak = 0;
    }
  }

  /** Score this window's chosen-card projection against the actual outcome. */
  _scoreProjection(d, w) {
    const p = w.projected;
    const a = w.actualAtNextWindow;
    if (!p?.projectedPos || !a?.position || !w.chosen?.key) return;
    const rec = (d.archetypes[w.chosen.key] ??= { proposed: 0, chosen: 0, projectedOnTrack: 0 });
    if (Math.abs(a.position - p.projectedPos) <= PROJECTION_TOLERANCE_POS) rec.projectedOnTrack += 1;
  }

  /** Persist now (best-effort; failures surface via onPersist, never throw). */
  persist() {
    if (!this.file) return;
    try {
      saveDossiers(this.state, this.file);
      this.onPersist(null);
    } catch (err) {
      this.onPersist(err);
    }
  }

  /**
   * Public view of one race's dossiers for the snapshot / results overlay:
   * car name -> { windows (sanitized), trust, archetypes }.
   */
  viewForRace(raceId) {
    const race = this.state.races[raceId];
    if (!race) return null;
    const out = {};
    for (const [name, d] of Object.entries(race.cars)) {
      out[name] = {
        windows: d.windows.map((w) => ({
          lap: w.lap,
          radio: w.radio ?? null,
          source: w.source,
          proposed: w.proposed ?? null,
          chosen: w.chosen ?? null,
          projected: w.projected ?? null,
          actualAtNextWindow: w.actualAtNextWindow ?? null,
          mode: w.mode ?? null,
        })),
        trust: { ...d.trust },
        archetypes: d.archetypes,
      };
    }
    return out;
  }

  /** Corrupt-file flag for the boot warning/log (like the season loader). */
  get corrupt() {
    return this._corrupt;
  }
  get corruptError() {
    return this._corruptError;
  }
}