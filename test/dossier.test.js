/**
 * MCPG-62: team dossier persistence and the event-driven per-window record.
 *
 * The dossier consumes the same decision events as the JSONL log (the
 * session injects raceId), so these tests feed it the exact event shapes
 * the simulation emits and check the persisted file (atomic tmp+rename,
 * same pattern as season.json) plus the public per-race view.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamDossier, readDossiers, saveDossiers } from '../src/teamDossier.js';

let tmpDir;
let file;
let d;
const RACE = 'race-1';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-dossier-'));
  file = path.join(tmpDir, 'dossiers.json');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** The event shapes the simulation actually emits (abridged). */
function feed(events) {
  for (const e of events) d.onEvent({ ...e, raceId: RACE });
}

const STANDINGS_L2 = [
  { carId: 1, name: 'Aggro', position: 1, gapToLeaderM: 0 },
  { carId: 2, name: 'Turtle', position: 2, gapToLeaderM: 25 },
];
const STANDINGS_FINAL = [
  { carId: 2, name: 'Turtle', position: 1, gapToLeaderM: 0 },
  { carId: 1, name: 'Aggro', position: 2, gapToLeaderM: 40 },
];

describe('team dossier (MCPG-62)', () => {
  it('records each window from the decision events, with actuals from the next window open', () => {
    d = new TeamDossier({ file });
    d.beginRace(RACE);
    feed([
      { type: 'race_start', agents: [{ id: 1, name: 'Aggro' }, { id: 2, name: 'Turtle' }] },

      // lap 1: Aggro posts a plan (team), the seat is unclaimed -> autopilot
      {
        type: 'tactics_proposed',
        carId: 1, name: 'Aggro', lap: 1, source: 'team', radio: 'Box and clear.',
        proposals: [
          { key: 'undercut', label: 'Box & undercut', narrative: '', packet: {}, recommend: true, confidence: 82, projection: { projectedPos: 1, projectedDeltaS: 5.1, riskTag: 'moderate' } },
          { key: 'stay_out', label: 'Stay out', narrative: '', packet: {}, recommend: false, confidence: 61, projection: { projectedPos: 2, projectedDeltaS: 0.3, riskTag: 'safe' } },
        ],
      },
      { type: 'auto_trusted', carId: 1, name: 'Aggro', lap: 1, source: 'team', key: 'undercut', label: 'Box & undercut', projection: { projectedPos: 1, projectedDeltaS: 5.1, riskTag: 'moderate' } },

      // lap 2 opens: the lap-1 projection is scored against the actuals
      { type: 'window_opened', lap: 2, remainingS: 30, standings: STANDINGS_L2 },
      {
        type: 'tactics_proposed',
        carId: 1, name: 'Aggro', lap: 2, source: 'junior', fallback: true, radio: 'Save the rubber.',
        proposals: [
          { key: 'manage_tyres', label: 'Protect the set', narrative: '', packet: {}, recommend: true, confidence: 74, projection: { projectedPos: 1, projectedDeltaS: 0.8, riskTag: 'safe' } },
        ],
      },
      // the driver overrode with a raw packet
      { type: 'strategy_resolved', carId: 1, name: 'Aggro', lap: 2, mode: 'overridden', source: 'driver_override', key: null, label: 'DRIVER OVERRIDE', strategy: { pace: 'push', aggression: 1 }, projection: { projectedPos: 1, projectedDeltaS: -1.2, riskTag: 'moderate' } },

      // race end: the last window's actuals come from the final standings
      { type: 'race_finished', timeS: 600, standings: STANDINGS_FINAL },
    ]);

    const view = d.viewForRace(RACE);
    // both racers are registered (race_start); only Aggro ever posted a plan
    expect(Object.keys(view).sort()).toEqual(['Aggro', 'Turtle']);
    expect(view.Turtle.windows).toEqual([]);
    const aggro = view.Aggro;
    expect(aggro.windows).toHaveLength(2);

    const [w1, w2] = aggro.windows;
    expect(w1.lap).toBe(1);
    expect(w1.mode).toBe('autopilot');
    expect(w1.source).toBe('team');
    expect(w1.proposed.recommended).toEqual({ key: 'undercut', label: 'Box & undercut', confidence: 82 });
    expect(w1.chosen.key).toBe('undercut');
    // actuals from the NEXT window's standings (lap 2 open)
    expect(w1.actualAtNextWindow).toEqual({ position: 1, gapToLeaderM: 0 });
    // the projection (P1) matched the actual (P1)
    expect(aggro.archetypes.undercut).toEqual({ proposed: 1, chosen: 1, projectedOnTrack: 1 });

    expect(w2.lap).toBe(2);
    expect(w2.mode).toBe('overridden');
    expect(w2.chosen.label).toBe('DRIVER OVERRIDE');
    expect(w2.actualAtNextWindow).toEqual({ position: 2, gapToLeaderM: 40 });

    // trust stats: 1 autopilot lap, 1 override, streak of 1 unassisted lap
    expect(aggro.trust.autopilot).toBe(1);
    expect(aggro.trust.overridden).toBe(1);
    expect(aggro.trust.trusted).toBe(0);
    expect(aggro.trust.longestUnassistedStreak).toBe(1);
  });

  it('persists atomically beside season.json and reloads after a "restart"', () => {
    expect(fs.existsSync(file)).toBe(true);
    const reloaded = readDossiers(file);
    expect(reloaded.source).toBe('loaded');
    const race = reloaded.state.races[RACE];
    expect(race.cars.Aggro.windows).toHaveLength(2);
    expect(race.cars.Aggro.trust.overridden).toBe(1);
  });

  it('starts empty (never crashes) from a corrupt file', () => {
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const res = readDossiers(bad);
    expect(res.source).toBe('corrupt');
    expect(res.state.races).toEqual({});
    const fromBad = new TeamDossier({ file: bad });
    expect(fromBad.corrupt).toBe(true);
    expect(fromBad.viewForRace(RACE)).toBeNull();
  });

  it('keeps working in-memory when the path is not writable', () => {
    // A regular file blocks any path below it from ever existing.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    let persistErr = null;
    const probe = new TeamDossier({
      file: path.join(blocker, 'd.json'),
      onPersist: (err) => { persistErr = err; },
    });
    probe.beginRace('r2');
    expect(persistErr).toBeInstanceOf(Error); // the write failed and surfaced (never threw)
    probe.onEvent({ type: 'race_start', raceId: 'r2', agents: [{ id: 1, name: 'Aggro' }] });
    probe.onEvent({ type: 'tactics_proposed', raceId: 'r2', carId: 1, name: 'Aggro', lap: 1, source: 'team', radio: 'hi', proposals: [{ key: 'attack', label: 'Go', packet: {}, recommend: true, confidence: 80 }] });
    probe.onEvent({ type: 'auto_trusted', raceId: 'r2', carId: 1, name: 'Aggro', lap: 1, source: 'team', key: 'attack', label: 'Go', projection: null });
    // the in-memory dossier is intact despite every persist attempt failing
    expect(probe.viewForRace('r2').Aggro.windows).toHaveLength(1);
    expect(probe.viewForRace('r2').Aggro.trust.autopilot).toBe(1);
  });

  it('saveDossiers/readDossiers round-trip a multi-race state', () => {
    const f2 = path.join(tmpDir, 'multi.json');
    const st = { version: 1, races: { r1: { startedAt: 't', cars: { A: { windows: [{ lap: 1, mode: 'autopilot' }], trust: { autopilot: 1 }, archetypes: {} } } } } };
    saveDossiers(st, f2);
    const back = readDossiers(f2);
    expect(back.source).toBe('loaded');
    expect(back.state.races.r1.cars.A.windows[0].mode).toBe('autopilot');
  });
});