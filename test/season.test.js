/**
 * Unit tests for the championship season (MCPG-49): F1 top-8 scoring,
 * tiebreaks, persistence round-trip, corrupt-file handling, win streaks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SEASON_POINTS,
  applyRace,
  emptySeason,
  rankSeason,
  readSeason,
  saveSeason,
} from '../src/season.js';

const tmpSeasonFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcgp-season-')), 'season.json');

const finished = (names) => names.map((name, i) => ({ position: i + 1, name, status: 'FINISHED' }));

describe('season scoring (MCPG-49)', () => {
  it('awards F1 top-8 points 15/12/10/8/6/4/2/1 and 0 for P9+', () => {
    expect(SEASON_POINTS).toEqual([15, 12, 10, 8, 6, 4, 2, 1]);
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const { state, awards } = applyRace(emptySeason(), finished(names));
    expect(awards.map((a) => a.pointsEarned)).toEqual([15, 12, 10, 8, 6, 4, 2, 1, 0, 0]);
    expect(state.drivers.A.points).toBe(15);
    expect(state.drivers.H.points).toBe(1);
    expect(state.drivers.I.points).toBe(0);
    expect(state.drivers.J.points).toBe(0);
  });

  it('gives DNFs zero points and counts them; DNFs still score a position', () => {
    const standings = [
      { position: 1, name: 'A', status: 'FINISHED' },
      { position: 2, name: 'B', status: 'RETIRED' },
    ];
    const { state, awards } = applyRace(emptySeason(), standings);
    expect(state.drivers.A.points).toBe(15);
    expect(state.drivers.B.points).toBe(0);
    expect(state.drivers.B.dnf).toBe(1);
    expect(state.drivers.A.dnf).toBe(0);
    expect(awards.find((a) => a.name === 'B').pointsEarned).toBe(0);
  });

  it('counts a race for every starter (finished or not)', () => {
    const { state } = applyRace(emptySeason(), [
      { position: 1, name: 'A', status: 'FINISHED' },
      { position: 2, name: 'B', status: 'RETIRED' },
    ]);
    expect(state.drivers.A.races).toBe(1);
    expect(state.drivers.B.races).toBe(1);
  });

  it('tracks wins and win streaks; the streak resets on a non-win', () => {
    let { state } = applyRace(emptySeason(), [
      { position: 1, name: 'A', status: 'FINISHED' },
      { position: 2, name: 'B', status: 'FINISHED' },
    ]);
    ({ state } = applyRace(state, [
      { position: 1, name: 'A', status: 'FINISHED' },
      { position: 2, name: 'B', status: 'FINISHED' },
    ]));
    expect(state.drivers.A).toMatchObject({ wins: 2, streak: 2, points: 30 });
    expect(state.drivers.B).toMatchObject({ wins: 0, streak: 0, points: 24 });
    ({ state } = applyRace(state, [
      { position: 1, name: 'B', status: 'FINISHED' },
      { position: 2, name: 'A', status: 'FINISHED' },
    ]));
    expect(state.drivers.A).toMatchObject({ wins: 2, streak: 0 });
    expect(state.drivers.B).toMatchObject({ wins: 1, streak: 1 });
  });

  it('accumulates across back-to-back races', () => {
    let { state } = applyRace(emptySeason(), finished(['A', 'B']));
    ({ state } = applyRace(state, finished(['B', 'A'])));
    expect(state.drivers.A).toMatchObject({ points: 15 + 12, wins: 1, races: 2 });
    expect(state.drivers.B).toMatchObject({ points: 12 + 15, wins: 1, races: 2 });
  });

  it('is pure: does not mutate the input state', () => {
    const before = emptySeason();
    before.drivers.A = { points: 5, wins: 0, races: 1, dnf: 0, streak: 0 };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyRace(before, finished(['A', 'B']));
    expect(before).toEqual(snapshot);
  });
});

describe('rankSeason tiebreaks (MCG-49)', () => {
  it('points desc, then wins desc, then fewer DNFs, then name asc', () => {
    const state = {
      version: 1,
      drivers: {
        B: { points: 30, wins: 1, races: 4, dnf: 0, streak: 0 },
        A: { points: 30, wins: 1, races: 4, dnf: 1, streak: 0 }, // same pts+wins, more DNFs
        C: { points: 30, wins: 0, races: 4, dnf: 0, streak: 0 }, // same pts, fewer wins
        D: { points: 10, wins: 9, races: 10, dnf: 0, streak: 0 }, // many wins, fewer points
      },
    };
    const rows = rankSeason(state);
    expect(rows.map((r) => r.name)).toEqual(['B', 'A', 'C', 'D']);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });

  it('name asc is the final tiebreak (deterministic, plain string compare)', () => {
    const rec = { points: 20, wins: 1, races: 3, dnf: 0, streak: 0 };
    const state = { version: 1, drivers: { Zeta: { ...rec }, Mid: { ...rec }, Alpha: { ...rec } } };
    expect(rankSeason(state).map((r) => r.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('empty season -> empty ranking', () => {
    expect(rankSeason(emptySeason())).toEqual([]);
  });
});

describe('season persistence (MCPG-49)', () => {
  it('round-trips through the file', () => {
    const file = tmpSeasonFile();
    const { state } = applyRace(emptySeason(), finished(['A', 'B']));
    saveSeason(state, file);
    const res = readSeason(file);
    expect(res.source).toBe('loaded');
    expect(res.state).toEqual(state);
  });

  it('missing file -> empty season, no throw (first boot)', () => {
    const file = path.join(os.tmpdir(), `mcgp-missing-${Date.now()}-${Math.random()}.json`);
    const res = readSeason(file);
    expect(res.source).toBe('missing');
    expect(res.state).toEqual(emptySeason());
  });

  it('corrupt file -> empty season + source "corrupt", never crashes', () => {
    const file = tmpSeasonFile();
    fs.writeFileSync(file, '{not json');
    let res = readSeason(file);
    expect(res.source).toBe('corrupt');
    expect(res.state).toEqual(emptySeason());

    fs.writeFileSync(file, JSON.stringify({ nope: true })); // valid JSON, wrong shape
    res = readSeason(file);
    expect(res.source).toBe('corrupt');
    expect(res.state).toEqual(emptySeason());

    fs.writeFileSync(file, JSON.stringify({ drivers: 'oops' }));
    expect(readSeason(file).source).toBe('corrupt');
  });

  it('tolerates older records missing newer fields (defaults to 0)', () => {
    const file = tmpSeasonFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, drivers: { A: { points: 15, wins: 1, races: 1 } } }),
    );
    const res = readSeason(file);
    expect(res.source).toBe('loaded');
    expect(res.state.drivers.A).toEqual({ points: 15, wins: 1, races: 1, dnf: 0, streak: 0 });
  });
});
