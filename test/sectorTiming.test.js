/**
 * MCPG-31: server-authoritative sector + lap timing.
 *
 * The sim is 100% deterministic and wall-clock-free, so all timing
 * expectations are exact sim-time math:
 *   - tick = 0.25 s, normal pace + fresh tires = 100 m/s = 25 m per tick
 *   - a boundary crossed mid-tick is interpolated to time(d) =
 *     t0 + (d - oldDist) / (newDist - oldDist) * dt
 */
import { describe, expect, it } from 'vitest';
import { Track } from '../src/track.js';
import { Simulation } from '../src/sim/simulation.js';
import { CONFIG } from '../src/config.js';
import { loadTrackDefs } from '../src/tracks.js';

const DT = CONFIG.timing.tickSeconds; // 0.25
const SPEED = CONFIG.physics.baseSpeedMs; // 100 m/s (normal pace, fresh tires)
const PER_TICK = SPEED * DT; // 25 m

const makeSim = (opts = {}) =>
  new Simulation({
    totalLaps: 5,
    strategyWindowSeconds: 0,
    reactiveWindowSeconds: 0,
    seed: 7,
    ...opts,
  });

const addFour = (sim) => {
  sim.addAgent('A', 'a');
  sim.addAgent('B', 'b');
  sim.addAgent('C', 'c');
  sim.addAgent('D', 'd');
};

const startLap = (sim) => {
  sim.start();
  sim.forceCloseWindow();
  sim.closeWindow();
};

const leader = (sim) => sim.cars[0];
const snapshot = (sim, car) => sim.state().cars.find((c) => c.id === car.id);

// Grid: first joiner at (maxAgents+1-0)*15 = 135 m, next 120 / 105 / 90.
// Gaps of 15 m only cause traffic drag (equal speeds → no close_battle),
// so a bare race of four equal-speed cars never opens a reactive window.
const GRID_P1 = (CONFIG.race.maxAgents + 1) * CONFIG.grid.formationGapM; // 135

describe('sector timing (MCPG-31)', () => {
  it('interpolates a mid-tick sector crossing to the exact sim time', () => {
    const sim = makeSim();
    addFour(sim);
    startLap(sim);
    const car = leader(sim);

    // P1 starts the lap from the 135 m grid slot and drives 25 m per tick:
    // 160 (t=0.25), 185 (t=0.50), 210 (t=0.75). The 200 m line is crossed
    // inside tick 3 at t = 0.5 + (15/25)*0.25 = 0.65 s — not the tick start
    // (0.5) and not the tick end (0.75).
    for (let i = 0; i < 3; i++) sim.tick();

    expect(car.currentSector).toBe(2);
    expect(car.currentSectorTimesS).toHaveLength(5);
    expect(car.currentSectorTimesS[0]).toBeCloseTo(0.65, 9);
    expect(car.currentSectorTimesS[1]).toBeNull();
    expect(car.currentSectorTimesS[4]).toBeNull();
    expect(car.bestSectorTimesS[0]).toBeCloseTo(0.65, 9);

    const snap = snapshot(sim, car);
    expect(snap.currentSector).toBe(2);
    expect(snap.currentSectorTimesS[0]).toBe(0.65);
    expect(snap.currentSectorTimesS[1]).toBeNull();
    expect(snap.bestSectorTimesS[0]).toBe(0.65);
    expect(snap.lastLapTimeS).toBeNull();
    expect(snap.bestLapTimeS).toBeNull();
  });

  it('records lastLapTimeS / bestLapTimeS and resets splits on a mid-tick line crossing', () => {
    const sim = makeSim();
    const events = [];
    sim.onEvent = (e) => events.push(e);
    addFour(sim);
    startLap(sim);
    const car = leader(sim);
    // Teleport P1 to 985 m (sector 5); pre-seed a slower historical best so
    // the wrap must beat it. Lap bookkeeping says the lap started at sim t=0.
    car.distTraveled = 985;
    car.position = 985;
    car.lastLapTimeS = 5.0;
    car.bestLapTimeS = 5.0;

    // One tick: 985 -> 1010. Line (1000) crossed at t = (15/25)*0.25 = 0.15.
    sim.tick();

    expect(car.completedLaps).toBe(1);
    expect(car.lastLapTimeS).toBeCloseTo(0.15, 9);
    expect(car.bestLapTimeS).toBeCloseTo(0.15, 9); // beat the 5.0 seed
    expect(car.currentSector).toBe(1);
    expect(car.currentSectorTimesS).toEqual([null, null, null, null, null]);

    const lapEvent = events.find((e) => e.type === 'lap_complete');
    expect(lapEvent).toBeTruthy();
    expect(lapEvent.lapTimeS).toBeCloseTo(0.15, 9);
    expect(lapEvent.bestLapTimeS).toBeCloseTo(0.15, 9);
  });

  it('keeps the best lap when a later lap is slower', () => {
    const sim = makeSim();
    addFour(sim);
    startLap(sim);
    const car = leader(sim);
    car.distTraveled = 985;
    car.position = 985;
    sim.tick(); // lap 1: 0.15 s (see above); best = 0.15

    // Lap 2: cross the 2000 m line on the next tick (1985 -> 1985 + speed2*dt,
    // t0 = 0.25). Lap 1 wore the tires (18% at normal/normal), so lap 2 is
    // slower even at the same strategy — a genuine slower lap.
    car.distTraveled = 1985;
    car.position = 985;
    sim.tick();

    const t = CONFIG.tires;
    const wear = t.wearPerLapBase * t.paceWearFactors.normal * t.strategyWearFactors.normal;
    const speed2 = SPEED * (1 - CONFIG.physics.tireGripDrop * (wear / 100));
    const lap1CrossT = ((1000 - 985) / (SPEED * DT)) * DT; // 0.15
    const lap2CrossT = DT + ((2000 - 1985) / (speed2 * DT)) * DT;
    expect(car.completedLaps).toBe(2);
    expect(car.lastLapTimeS).toBeCloseTo(lap2CrossT - lap1CrossT, 9);
    expect(car.bestLapTimeS).toBeCloseTo(lap1CrossT, 9); // unchanged
  });

  it('includes the pit stop in the lap time (PITTING cars move 0 m)', () => {
    const sim = makeSim();
    addFour(sim);
    startLap(sim);
    const car = leader(sim);
    car.pitRequested = true; // enters the pit lane on the very first tick

    const maxTicks = 200;
    for (let i = 0; i < maxTicks && car.completedLaps < 1; i++) {
      if (sim.phase === 'reactive_window') sim.closeReactiveWindow();
      sim.tick();
    }

    expect(car.completedLaps).toBe(1);
    // The stop is CONFIG.pit.stopSeconds of 0 m movement: the car enters the
    // pit on tick 1 (countdown starts ticking from the next tick), so it
    // first moves on tick 1 + stopSeconds/dt, whose span starts exactly at
    // t = stopSeconds. Lap time = stop + (1000 - grid) / speed.
    const rejoinTick = 1 + Math.round(CONFIG.pit.stopSeconds / DT); // 73
    const expected = (rejoinTick - 1) * DT + (1000 - GRID_P1) / SPEED; // 18 + 8.65
    expect(car.lastLapTimeS).toBeCloseTo(expected, 6);
    expect(car.lastLapTimeS).toBeGreaterThan(CONFIG.pit.stopSeconds); // stop is inside it
    expect(car.bestLapTimeS).toBeCloseTo(car.lastLapTimeS, 9);
    // Splits of the finished lap are reset, and the pit lap's sector 1 split
    // (grid → first line) is exactly the driving time after the stop.
    expect(car.currentSectorTimesS).toEqual([null, null, null, null, null]);
  });

  it('keeps the last timing values on a RETIRED car (no throw, no wipe)', () => {
    const sim = makeSim();
    addFour(sim);
    startLap(sim);
    const car = leader(sim);
    // Mid-lap retirement with partial timing already recorded.
    car.currentSector = 3;
    car.currentSectorTimesS = [12.5, 14.1, null, null, null];
    car.lastLapTimeS = 73.25;
    car.bestLapTimeS = 71.5;
    car.bestSectorTimesS = [12.0, 14.1, null, null, null];
    car.status = 'RETIRED';

    expect(() => {
      for (let i = 0; i < 10; i++) sim.tick();
      const s = sim.state(); // snapshot of a retired car must not throw
      expect(s.phase).toBeTruthy();
    }).not.toThrow();

    const snap = snapshot(sim, car);
    expect(snap.status).toBe('RETIRED');
    expect(snap.currentSector).toBe(3);
    expect(snap.currentSectorTimesS).toEqual([12.5, 14.1, null, null, null]);
    expect(snap.lastLapTimeS).toBe(73.25);
    expect(snap.bestLapTimeS).toBe(71.5);
    expect(snap.bestSectorTimesS).toEqual([12.0, 14.1, null, null, null]);
  });

  it('exposes all-null timing in the first strategy window', () => {
    const sim = makeSim();
    addFour(sim);
    sim.start(); // still in the lap-1 strategy window
    const snap = snapshot(sim, leader(sim));
    expect(snap.currentSector).toBe(1);
    expect(snap.currentSectorTimesS).toEqual([null, null, null, null, null]);
    expect(snap.lastLapTimeS).toBeNull();
    expect(snap.bestLapTimeS).toBeNull();
    expect(snap.bestSectorTimesS).toEqual([null, null, null, null, null]);
  });
});

describe('timing works for any sector layout (no hardcoded counts)', () => {
  it('handles a 1200 m / 4-sector track end to end', () => {
    const track = new Track({ id: 'quad', name: 'Quad', lengthM: 1200, sectorLengthM: 300 });
    const sim = makeSim({ track, totalLaps: 3 });
    addFour(sim);
    startLap(sim);
    const car = leader(sim);
    expect(track.sectorCount).toBe(4);
    expect(car.currentSectorTimesS).toHaveLength(4);

    // 135 -> 300 m line: 135+25k >= 300 at tick 7 (285 -> 310),
    // t = 6*0.25 + (15/25)*0.25 = 1.65.
    for (let i = 0; i < 7; i++) sim.tick();
    expect(car.currentSector).toBe(2);
    expect(car.currentSectorTimesS[0]).toBeCloseTo(1.65, 9);
    expect(car.currentSectorTimesS).toHaveLength(4);

    // Finish line: 135+25k >= 1200 after 43 moves (tick 43: 1185 -> 1210),
    // t = 42*0.25 + (15/25)*0.25 = 10.65 = (1200 - 135) / 100 m/s.
    while (car.completedLaps < 1) {
      if (sim.phase === 'reactive_window') sim.closeReactiveWindow();
      sim.tick();
    }
    expect(car.lastLapTimeS).toBeCloseTo((1200 - GRID_P1) / SPEED, 9);
    expect(car.currentSectorTimesS).toEqual([null, null, null, null]);
    expect(car.currentSector).toBe(1);
  });

  it('runs a full race on every registered track without errors', () => {
    for (const def of loadTrackDefs()) {
      const track = new Track({
        id: def.id,
        name: def.name,
        lengthM: def.lengthM,
        sectorLengthM: def.sectorLengthM,
      });
      const sim = makeSim({ track, totalLaps: 2 });
      addFour(sim);
      startLap(sim);
      let guard = 0;
      while (sim.phase !== 'finished' && guard < 5000) {
        if (sim.phase === 'strategy_window') sim.closeWindow();
        else if (sim.phase === 'reactive_window') sim.closeReactiveWindow();
        else sim.tick();
        guard += 1;
      }
      expect(sim.phase, `race on ${def.id} must finish`).toBe('finished');
      // Every finisher has a best lap and a full best-sector array.
      for (const c of sim.cars) {
        if (c.status === 'FINISHED') {
          expect(c.bestLapTimeS, `${def.id}: finisher needs a best lap`).toBeGreaterThan(0);
          expect(c.bestSectorTimesS, `${def.id}: best sectors must be complete`).toHaveLength(
            track.sectorCount,
          );
          expect(c.bestSectorTimesS.every((t) => t != null && t > 0)).toBe(true);
        }
      }
    }
  });
});

describe('timing snapshot size (MCPG-31)', () => {
  it('keeps the spectator snapshot small (timing fields are a bounded delta)', () => {
    const sim = makeSim({ totalLaps: 10 });
    for (let i = 0; i < CONFIG.race.maxAgents; i++) sim.addAgent(`d${i}`, `a${i}`);
    startLap(sim);
    // A few ticks so several cars have splits / sector 2+ state.
    for (let i = 0; i < 5; i++) sim.tick();

    const state = sim.state();
    expect(state.cars).toHaveLength(CONFIG.race.maxAgents);
    const full = JSON.stringify(state).length;
    // Delta = the five new timing fields per car (worst case: all populated).
    const withoutTiming = JSON.stringify({
      ...state,
      cars: state.cars.map(({
        currentSector,
        currentSectorTimesS,
        lastLapTimeS,
        bestLapTimeS,
        bestSectorTimesS,
        ...rest
      }) => rest),
    }).length;
    // The research brief budgeted ~0.4 KB extra at 8 cars; keep the true
    // worst-case delta under 2 KB and the full 10 Hz payload under 6 KB.
    expect(full - withoutTiming).toBeLessThan(2048);
    expect(full).toBeLessThan(6144);
  });
});
