import { describe, expect, it } from 'vitest';
import {
  aggressiveStrategy,
  conservativeStrategy,
  pitHeavyStrategy,
  randomStrategy,
  SCRIPTED_AGENTS,
} from '../src/sim/strategies.js';
import { parseStrategy } from '../src/sim/car.js';
import { createRng } from '../src/rng.js';

const view = (overrides = {}) => ({
  car: {
    tireWearPct: 20,
    fuelKg: 95, // realistic lap-1 state (fresh tank)
    completedLaps: 0,
    status: 'RUNNING',
    ...overrides.car,
  },
  race: {
    currentLap: 1,
    totalLaps: 20,
    lapsRemaining: 20,
    position: 2,
    phase: 'strategy_window',
    ...overrides.race,
  },
});

const VALID = (s) => parseStrategy(s).errors.length === 0;

describe('scripted strategies: packet validity', () => {
  it('every profile emits a valid packet', () => {
    const rng = createRng(1);
    for (const [profile, agent] of Object.entries(SCRIPTED_AGENTS)) {
      for (const v of [view(), view({ car: { tireWearPct: 99, fuelKg: 1 } }), view({ car: { fuelKg: 50 } })]) {
        const s = agent.decide(v, rng);
        expect(VALID(s), `profile ${profile} produced an invalid packet: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });
});

describe('scripted strategies: behavior', () => {
  it('aggressive pushes pace and attacks, pits only when forced', () => {
    const s = aggressiveStrategy(view(), createRng(1));
    expect(s.pace).toBe('push');
    expect(s.aggression).toBe(1);
    expect(s.defend).toBe(1);
    expect(s.pitNow).toBe(false);

    const worn = aggressiveStrategy(view({ car: { tireWearPct: 95 } }), createRng(1));
    expect(worn.pitNow).toBe(true);

    const noFuel = aggressiveStrategy(view({ car: { fuelKg: 10 } }), createRng(1));
    expect(noFuel.pitNow).toBe(true);

    // high wear (but below the pit line) relaxes the pace
    const worn2 = aggressiveStrategy(view({ car: { tireWearPct: 75 } }), createRng(1));
    expect(worn2.pace).not.toBe('push');
  });

  it('conservative manages everything and never attacks', () => {
    const s = conservativeStrategy(view(), createRng(1));
    expect(s.pace).toBe('manage');
    expect(s.tireManagement).toBe('manage');
    expect(s.aggression).toBe(0);
    expect(s.defend).toBe(0);
    expect(s.pitNow).toBe(false);

    const worn = conservativeStrategy(view({ car: { tireWearPct: 60 } }), createRng(1));
    expect(worn.pitNow).toBe(true);
  });

  it('pit-heavy pits at the first sign of wear', () => {
    expect(pitHeavyStrategy(view({ car: { tireWearPct: 31 } }), createRng(1)).pitNow).toBe(true);
    expect(pitHeavyStrategy(view({ car: { tireWearPct: 10 } }), createRng(1)).pitNow).toBe(false);
    // low fuel also triggers a stop
    const lowFuel = pitHeavyStrategy(view({ car: { fuelKg: 30, tireWearPct: 5 } }), createRng(1));
    expect(lowFuel.pitNow).toBe(true);
  });

  it('random covers the option space across many draws', () => {
    const rng = createRng(99);
    const paces = new Set();
    const aggression = new Set();
    for (let i = 0; i < 50; i += 1) {
      const s = randomStrategy(view(), rng);
      expect(VALID(s)).toBe(true);
      paces.add(s.pace);
      aggression.add(s.aggression);
    }
    expect(paces.size).toBeGreaterThan(1);
    expect(aggression.size).toBeGreaterThan(1);
  });
});
