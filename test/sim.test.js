import { describe, expect, it } from 'vitest';
import { Track } from '../src/track.js';
import { parseStrategy, createCar, resetCarIdCounter } from '../src/sim/car.js';
import { Simulation } from '../src/sim/simulation.js';
import { CONFIG } from '../src/config.js';

const runUntilFinished = (sim, maxTicks = 100000) => {
  let ticks = 0;
  let guard = 0;
  while (sim.phase !== 'finished' && guard < maxTicks) {
    if (sim.phase === 'strategy_window') {
      sim.closeWindow(); // tests never let a window time out; close immediately
    } else {
      sim.tick();
      ticks += 1;
    }
    guard += 1;
  }
  expect(sim.phase, 'race did not finish within maxTicks').toBe('finished');
  return ticks;
};

const makeSim = (opts = {}) =>
  new Simulation({
    totalLaps: 5,
    strategyWindowSeconds: 0,
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
};

describe('Track', () => {
  it('computes laps and lap position', () => {
    const t = new Track();
    expect(t.lengthM).toBe(1000);
    expect(t.lapsCompleted(0)).toBe(0);
    expect(t.lapsCompleted(999)).toBe(0);
    expect(t.lapsCompleted(1000)).toBe(1);
    expect(t.lapsCompleted(2500.5)).toBe(2);
    expect(t.lapPosition(1000)).toBe(1000);
    expect(t.lapPosition(1250.5)).toBe(250.5);
  });

  it('assigns sectors', () => {
    const t = new Track();
    expect(t.sectorForPosition(0)).toBe(1);
    expect(t.sectorForPosition(199.9)).toBe(1);
    expect(t.sectorForPosition(200)).toBe(2);
    expect(t.sectorForPosition(999)).toBe(5);
  });

  it('rejects non-divisible sectors', () => {
    expect(() => new Track({ lengthM: 1000, sectorLengthM: 300 })).toThrow();
  });
});

describe('parseStrategy', () => {
  it('accepts a full valid strategy', () => {
    const { strategy, errors } = parseStrategy({
      pace: 'push',
      tireManagement: 'manage',
      aggression: 1,
      defend: 1,
      pitNow: true,
    });
    expect(errors).toEqual([]);
    expect(strategy).toEqual({ pace: 'push', tireManagement: 'manage', aggression: 1, defend: 1, pitNow: true });
  });

  it('defaults missing fields', () => {
    const { strategy, errors } = parseStrategy({});
    expect(errors).toEqual([]);
    expect(strategy).toEqual({ pace: 'normal', tireManagement: 'normal', aggression: 0, defend: 0, pitNow: false });
  });

  it('reports each invalid field', () => {
    const { errors } = parseStrategy({ pace: 'fast', aggression: 2, defend: 'yes', pitNow: 'maybe' });
    expect(errors).toHaveLength(4);
    expect(errors.join(' ')).toContain('pace');
  });

  it('rejects non-objects', () => {
    const { errors } = parseStrategy(null);
    expect(errors).toEqual(['strategy must be an object']);
  });
});

describe('Simulation: strategy window idempotency', () => {
  it('first submission wins, duplicates are rejected', () => {
    const sim = makeSim();
    addFour(sim);
    sim.start();
    const carId = sim.cars[0].id;

    const first = sim.submitPhaseStrategy(carId, { pace: 'push', aggression: 1 });
    expect(first.accepted).toBe(true);

    const second = sim.submitPhaseStrategy(carId, { pace: 'manage', pitNow: true });
    expect(second.accepted).toBe(false);
    expect(second.error).toBe('duplicate_strategy');

    // state must reflect only the first packet
    expect(sim.cars[0].strategy.pace).toBe('push');
    expect(sim.cars[0].strategy.pitNow).toBe(false);
  });

  it('rejects submissions outside the window and for unknown cars', () => {
    const sim = makeSim();
    addFour(sim);
    const carId = sim.cars[0].id;
    const outside = sim.submitPhaseStrategy(carId, { pace: 'push' });
    expect(outside.accepted).toBe(false);
    expect(outside.error).toBe('not_in_window (phase: setup)');

    const unknown = sim.submitPhaseStrategy(999, { pace: 'push' });
    expect(unknown.accepted).toBe(false);
    expect(unknown.error).toBe('unknown_car');
  });

  it('cars without a submission keep their previous strategy and are logged', () => {
    const events = [];
    const sim = makeSim({ onEvent: (e) => events.push(e) });
    addFour(sim);
    sim.start();
    sim.forceCloseWindow();
    sim.closeWindow();
    const defaulted = events.filter((e) => e.type === 'strategy_defaulted');
    expect(defaulted).toHaveLength(4);
  });
});

describe('Simulation: race mechanics', () => {
  it('completes a 5-lap race with 4 cars and a sane standings order', () => {
    const sim = makeSim();
    addFour(sim);
    sim.start();
    sim.forceCloseWindow();
    sim.closeWindow();
    runUntilFinished(sim);

    const standings = sim.standings();
    expect(standings).toHaveLength(4);
    expect(standings.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    for (const s of standings) {
      expect(s.status).toBe('FINISHED');
      expect(s.completedLaps).toBe(5);
      expect(s.finishTimeS).toBeGreaterThan(0);
    }
    // P1 must be at least as far as P2, which at least as far as P3...
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i - 1].finishTimeS).toBeLessThanOrEqual(standings[i].finishTimeS + 1e-9);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const run = () => {
      const sim = makeSim({ seed: 123 });
      addFour(sim);
      sim.start();
      sim.forceCloseWindow();
      sim.closeWindow();
      runUntilFinished(sim);
      return sim.standings().map((s) => `${s.name}:${s.finishTimeS}`);
    };
    expect(run()).toEqual(run());
  });

  it('produces different results for different seeds (probabilistic overtakes)', () => {
    const results = new Set();
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = makeSim({ seed });
      addFour(sim);
      sim.start();
      sim.forceCloseWindow();
      sim.closeWindow();
      runUntilFinished(sim);
      results.add(sim.standings().map((s) => s.name).join(','));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('overtakes happen when a faster car closes in on a slower one', () => {
    const events = [];
    const sim = makeSim({ onEvent: (e) => events.push(e) });
    addFour(sim);
    sim.start();
    // grid: A leads, D is last. D pushes hard; A manages and defends not at all.
    sim.submitPhaseStrategy(sim.cars[0].id, { pace: 'manage', defend: 0 });
    sim.submitPhaseStrategy(sim.cars[3].id, { pace: 'push', aggression: 1 });
    sim.forceCloseWindow();
    sim.closeWindow();
    runUntilFinished(sim);

    const overtakes = events.filter((e) => e.type === 'overtake');
    expect(overtakes.length).toBeGreaterThan(0);
    // the overtake event names both cars and the probability used
    const o = overtakes[0];
    expect(o.name).toBeTruthy();
    expect(o.overTakenName).toBeTruthy();
    expect(o.probability).toBeGreaterThan(0);
    expect(o.probability).toBeLessThanOrEqual(0.9);
  });

  it('pit stops reset tires and refill fuel, and slow the car down', () => {
    const events = [];
    const sim = makeSim({ onEvent: (e) => events.push(e) });
    addFour(sim);
    sim.start();
    // P1 and P2 push every lap; P1 pits at the start of lap 4. Without the
    // tire/fuel reset, P1 would finish at 100% wear on ~20kg of fuel; with
    // it, only the two post-pit laps accumulate (2 x 27% wear).
    let guard = 0;
    while (sim.phase !== 'finished' && guard < 100000) {
      if (sim.phase === 'strategy_window') {
        const p1packet = sim.currentLap === 4 ? { pitNow: true, pace: 'push' } : { pace: 'push' };
        sim.submitPhaseStrategy(sim.cars[0].id, p1packet);
        sim.submitPhaseStrategy(sim.cars[1].id, { pace: 'push' });
        sim.closeWindow();
      } else {
        sim.tick();
      }
      guard += 1;
    }
    expect(sim.phase).toBe('finished');

    const p1 = sim.cars[0];
    const pitEnter = events.find((e) => e.type === 'pit_stop_enter' && e.carId === p1.id);
    const pitDone = events.find((e) => e.type === 'pit_stop_complete' && e.carId === p1.id);
    expect(pitEnter).toBeTruthy();
    expect(pitDone).toBeTruthy();
    expect(p1.tireWear).toBeCloseTo(
      2 * CONFIG.tires.wearPerLapBase * CONFIG.tires.paceWearFactors.push * CONFIG.tires.strategyWearFactors.normal,
      1,
    );
    expect(p1.fuelKg).toBeCloseTo(
      CONFIG.fuel.startKg - 2 * CONFIG.fuel.perLapNormalKg * CONFIG.fuel.paceFactors.push,
      1,
    );
    // pit loss (~18s) is decisive: P2 wins despite driving on worn tires
    expect(sim.standings()[0].name).not.toBe(p1.name);
  });

  it('retires a car that runs out of fuel (DNF)', () => {
    const events = [];
    const sim = makeSim({ totalLaps: 25, onEvent: (e) => events.push(e) });
    addFour(sim);
    sim.start();
    // force every lap through a window with all-normal strategies (normal fuel burn)
    let guard = 0;
    while (sim.phase !== 'finished' && guard < 5000) {
      if (sim.phase === 'strategy_window') {
        for (const car of sim.cars) sim.submitPhaseStrategy(car.id, { pace: 'normal' });
        sim.forceCloseWindow();
        sim.closeWindow();
      } else if (sim.phase === 'simulation') {
        sim.tick();
      }
      guard += 1;
    }
    expect(sim.phase).toBe('finished');
    // 95kg / 4kg per lap = 23.75 laps -> everyone must retire before lap 25
    for (const car of sim.cars) {
      expect(car.status).toBe('RETIRED');
      const ret = events.find((e) => e.type === 'retired' && e.carId === car.id);
      expect(ret).toBeTruthy();
      expect(ret.reason).toBe('out_of_fuel');
    }
    // standings still rank retired cars
    const standings = sim.standings();
    expect(standings).toHaveLength(4);
    expect(standings.every((s) => s.status === 'RETIRED')).toBe(true);
  });

  it('tire wear depends on pace and tire management', () => {
    const mk = (pace, tire) => {
      const sim = makeSim({ totalLaps: 2 });
      sim.addAgent('X', 'x');
      sim.addAgent('Y', 'y');
      sim.addAgent('Z', 'z');
      sim.addAgent('W', 'w');
      sim.start();
      sim.submitPhaseStrategy(sim.cars[0].id, { pace, tireManagement: tire });
      sim.forceCloseWindow();
      sim.closeWindow();
      runUntilFinished(sim);
      return sim.cars[0].tireWear;
    };
    const pushPush = mk('push', 'push');
    const normalNormal = mk('normal', 'normal');
    const manageManage = mk('manage', 'manage');
    expect(pushPush).toBeGreaterThan(normalNormal);
    expect(normalNormal).toBeGreaterThan(manageManage);
  });

  it('does not allow more than 8 agents or starting with fewer than 4', () => {
    const sim = makeSim();
    for (let i = 0; i < 4; i += 1) sim.addAgent(`C${i}`, `a${i}`);
    expect(() => sim.start()).not.toThrow();

    const small = makeSim();
    small.addAgent('Only', 'o');
    expect(() => small.start()).toThrow(/at least 4/);

    const full = makeSim();
    for (let i = 0; i < 8; i += 1) full.addAgent(`F${i}`, `f${i}`);
    expect(() => full.addAgent('TooMany', 't')).toThrow(/full/);
  });
});

describe('Simulation: reactive window stub', () => {
  it('rejects reactive actions without side effects', () => {
    const sim = makeSim();
    addFour(sim);
    sim.start();
    const r = sim.submitReactiveAction(sim.cars[0].id, { type: 'attack' });
    expect(r).toEqual({ accepted: false, error: 'reactive_windows_not_yet_available' });
    expect(sim.submitReactiveAction(999, { type: 'attack' })).toEqual({ accepted: false, error: 'unknown_car' });
  });
});
