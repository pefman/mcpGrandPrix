/**
 * The four scripted test agents. Each is a pure function:
 *
 *     strategy = f(stateView)
 *
 * where stateView is the car's public snapshot plus a few race facts.
 * These same functions drive the agents in `agents/` when the server runs,
 * and can be unit-tested directly.
 */
import { CONFIG } from '../config.js';

const FUEL = CONFIG.fuel;
const burn = (pace) => FUEL.perLapNormalKg * FUEL.paceFactors[pace];
/** Pit when the current tank cannot carry the car to the finish. */
const outOfFuelRange = (fuelKg, lapsRemaining, pace) => fuelKg <= lapsRemaining * burn(pace);

/**
 * AGGRESSIVE — wants to be first. Pushes pace, attacks hard, pits only when
 * forced by wear or fuel range.
 */
export function aggressiveStrategy(view, _rng) {
  const { car, race } = view;
  const pitNow = car.tireWearPct >= 92 || outOfFuelRange(car.fuelKg, race.lapsRemaining, 'push');
  return {
    pace: car.tireWearPct < 70 ? 'push' : 'normal',
    tireManagement: 'normal',
    aggression: 1,
    defend: 1,
    pitNow,
  };
}

/**
 * CONSERVATIVE — wants a clean, reliable finish. Manages pace and tires,
 * never initiates attacks, pits early on tires to keep a margin.
 */
export function conservativeStrategy(view, _rng) {
  const { car, race } = view;
  const pitNow = car.tireWearPct >= 55 || outOfFuelRange(car.fuelKg, race.lapsRemaining, 'manage');
  return {
    pace: 'manage',
    tireManagement: 'manage',
    aggression: 0,
    defend: 0,
    pitNow,
  };
}

/**
 * PIT-HEAVY — believes in fresh rubber above all. Pits at the first sign of
 * wear and manages everything else around it.
 */
export function pitHeavyStrategy(view, _rng) {
  const { car, race } = view;
  const pitNow = car.tireWearPct >= 30 || outOfFuelRange(car.fuelKg, race.lapsRemaining, 'normal');
  return {
    pace: car.tireWearPct < 15 ? 'normal' : 'manage',
    tireManagement: 'manage',
    aggression: 0,
    defend: 0,
    pitNow,
  };
}

/**
 * RANDOM — full chaos. Every value is redrawn each lap from a seeded RNG.
 * Used to smoke out hidden assumptions in the simulator.
 */
export function randomStrategy(view, rng) {
  const { car, race } = view;
  const pace = rng.pick(['push', 'normal', 'manage']);
  const tireManagement = rng.pick(['push', 'normal', 'manage']);
  const pitNow = car.tireWearPct >= 95 || outOfFuelRange(car.fuelKg, race.lapsRemaining, 'push');
  return {
    pace,
    tireManagement,
    aggression: rng.int(0, 1),
    defend: rng.int(0, 1),
    pitNow,
  };
}

export const SCRIPTED_AGENTS = {
  aggressive: { profile: 'aggressive', decide: aggressiveStrategy },
  conservative: { profile: 'conservative', decide: conservativeStrategy },
  pitHeavy: { profile: 'pitHeavy', decide: pitHeavyStrategy },
  random: { profile: 'random', decide: randomStrategy },
};
