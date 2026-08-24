/**
 * Car state and strategy validation. Cars are the atomic unit of race state.
 * All mutation happens through the Simulation; this module defines the shape
 * and the pure helpers.
 */
import { CONFIG, PACES, TIRE_STRATEGIES } from '../config.js';

/**
 * @typedef {object} CarStrategy
 * @property {'push'|'normal'|'manage'} pace
 * @property {'push'|'normal'|'manage'} tireManagement
 * @property {0|1} aggression   // 0 = avoid fights, 1 = initiate attacks
 * @property {0|1} defend       // 0 = yield, 1 = defend position
 * @property {boolean} pitNow   // request a pit stop at the start of the next tick
 */

/**
 * @typedef {object} Car
 * @property {number} id
 * @property {string} name        // agent display name (also the join key)
 * @property {number} agentId     // MCP session id of the controlling agent
 * @property {'RUNNING'|'PITTING'|'RETIRED'} status
 * @property {number} distTraveled  // total meters since the grid
 * @property {number} completedLaps
 * @property {number} position      // meters into the current lap
 * @property {number} speedMs       // current speed, m/s
 * @property {number} tireWear      // 0..100 (%)
 * @property {number} fuelKg        // remaining fuel
 * @property {number} pitTimeLeftS  // seconds left in the current pit stop
 * @property {boolean} pitRequested
 * @property {CarStrategy} strategy // active strategy for the current lap
 * @property {boolean} submittedStrategy // whether this car has submitted for the current window
 * @property {number} finishTimeS   // race time of finishing (RUNNING only: null)
 */

let nextCarId = 1;

export function createCar({ name, agentId, distTraveled = 0 }) {
  const car = {
    id: nextCarId++,
    name,
    agentId,
    status: 'RUNNING',
    distTraveled,
    completedLaps: 0,
    position: distTraveled,
    speedMs: 0,
    tireWear: 0,
    fuelKg: CONFIG.fuel.startKg,
    pitTimeLeftS: 0,
    pitRequested: false,
    strategy: defaultStrategy(),
    submittedStrategy: false,
    finishTimeS: null,
  };
  return car;
}

export function resetCarIdCounter() {
  nextCarId = 1;
}

export function defaultStrategy() {
  return { pace: 'normal', tireManagement: 'normal', aggression: 0, defend: 0, pitNow: false };
}

const STRATEGY_ERROR = { accepted: false, error: 'invalid_strategy', details: [] };

/**
 * Validate a raw strategy object coming from an MCP call.
 * Unknown keys are ignored (forward compatibility); the returned object
 * contains only known keys. Returns { strategy, errors } where errors is a
 * list of human-readable problems (empty when valid).
 */
export function parseStrategy(raw) {
  const details = [];
  const out = defaultStrategy();
  if (typeof raw !== 'object' || raw === null) {
    return { strategy: out, errors: ['strategy must be an object'] };
  }

  if (raw.pace !== undefined) {
    if (PACES.includes(raw.pace)) out.pace = raw.pace;
    else details.push(`pace must be one of ${PACES.join(', ')}`);
  }
  if (raw.tireManagement !== undefined) {
    if (TIRE_STRATEGIES.includes(raw.tireManagement)) out.tireManagement = raw.tireManagement;
    else details.push(`tireManagement must be one of ${TIRE_STRATEGIES.join(', ')}`);
  }
  for (const key of ['aggression', 'defend']) {
    if (raw[key] !== undefined) {
      if (raw[key] === 0 || raw[key] === 1) out[key] = raw[key];
      else details.push(`${key} must be 0 or 1`);
    }
  }
  if (raw.pitNow !== undefined) {
    if (typeof raw.pitNow === 'boolean') out.pitNow = raw.pitNow;
    else details.push('pitNow must be a boolean');
  }

  return { strategy: out, errors: details };
}

/** Public, MCP-safe view of a car. */
export function carSnapshot(car) {
  return {
    id: car.id,
    name: car.name,
    status: car.status,
    positionM: round2(car.position),
    gapToLeaderM: null, // filled in by the session
    completedLaps: car.completedLaps,
    speedMs: round2(car.speedMs),
    tireWearPct: round1(car.tireWear),
    fuelKg: round1(car.fuelKg),
    pitTimeLeftS: round1(car.pitTimeLeftS),
    pitRequested: car.pitRequested,
    strategy: { ...car.strategy },
    submittedStrategy: car.submittedStrategy,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
