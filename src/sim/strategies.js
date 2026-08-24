/**
 * The four scripted test agents. Each is a pure function:
 *
 *     strategy = f(stateView)
 *
 * where stateView is the car's public snapshot plus a few race facts.
 * These same functions drive the agents in `agents/` when the server runs,
 * and can be unit-tested directly.
 *
 * Reactive policies (`*Reactive`) answer Slice 3 reactive windows with a
 * small action set: attack | defend | hold | pit_now.
 */
import { CONFIG } from '../config.js';

const FUEL = CONFIG.fuel;
const burn = (pace) => FUEL.perLapNormalKg * FUEL.paceFactors[pace];
/** Pit when the current tank cannot carry the car to the finish. */
const outOfFuelRange = (fuelKg, lapsRemaining, pace) => fuelKg <= lapsRemaining * burn(pace);

/**
 * Shared reactive helper: pick a legal action for this car's role in the window.
 * `prefer` is tried first when allowed; otherwise the first allowed action.
 */
function pickReactive(window, carId, prefer) {
  const allowed = window.allowedByCar?.[String(carId)] ?? window.allowedByCar?.[carId] ?? ['hold'];
  if (prefer && allowed.includes(prefer)) return { type: prefer };
  return { type: allowed[0] ?? 'hold' };
}

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

function roleOf(window, carId) {
  return window.roles?.[carId] ?? window.roles?.[String(carId)] ?? null;
}

/** Aggressive: attack hard, defend hard, refuse early pits unless critical. */
export function aggressiveReactive(view, window, _rng) {
  const role = roleOf(window, view.car.id);
  if (window.trigger === 'close_battle') {
    if (role === 'attacker') return pickReactive(window, view.car.id, 'attack');
    if (role === 'defender') return pickReactive(window, view.car.id, 'defend');
  }
  if (window.trigger === 'critical_tire_wear') return pickReactive(window, view.car.id, 'pit_now');
  // pit_opportunity: stay out and push
  return pickReactive(window, view.car.id, 'hold');
}

/** Conservative: yield fights, pit at the first opportunity. */
export function conservativeReactive(view, window, _rng) {
  if (window.trigger === 'close_battle') {
    // Never escalate: hold as attacker, hold (yield) as defender.
    return pickReactive(window, view.car.id, 'hold');
  }
  if (window.trigger === 'critical_tire_wear' || window.trigger === 'pit_opportunity') {
    return pickReactive(window, view.car.id, 'pit_now');
  }
  return pickReactive(window, view.car.id, 'hold');
}

/** Pit-heavy: always take the box when offered; otherwise hold. */
export function pitHeavyReactive(view, window, _rng) {
  if (window.trigger === 'critical_tire_wear' || window.trigger === 'pit_opportunity') {
    return pickReactive(window, view.car.id, 'pit_now');
  }
  return pickReactive(window, view.car.id, 'hold');
}

/** Random: uniform pick among the actions allowed for this car. */
export function randomReactive(view, window, rng) {
  const allowed =
    window.allowedByCar?.[String(view.car.id)] ?? window.allowedByCar?.[view.car.id] ?? ['hold'];
  return { type: rng.pick(allowed) };
}

export const SCRIPTED_AGENTS = {
  aggressive: { profile: 'aggressive', decide: aggressiveStrategy, decideReactive: aggressiveReactive },
  conservative: {
    profile: 'conservative',
    decide: conservativeStrategy,
    decideReactive: conservativeReactive,
  },
  pitHeavy: { profile: 'pitHeavy', decide: pitHeavyStrategy, decideReactive: pitHeavyReactive },
  random: { profile: 'random', decide: randomStrategy, decideReactive: randomReactive },
};
