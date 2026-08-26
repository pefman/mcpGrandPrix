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
import { ARCHETYPES } from './archetypes.js';

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

// --------------------------------------------------------------------------
// Junior strategist — the scripted "AI team" brain (MCPG-62).
//
// Emits a TACTIC ENVELOPE (radio + 2-3 archetype-based proposal cards) each
// strategy window: canned but situational, built from the archetype packet
// templates (archetypes.js) and tuned to the current situation (tire wear,
// battle gaps, laps/fuel left). The same function powers the server-side
// fallback that fills in when no team posts a plan, so races run end-to-end
// with zero LLMs connected. Projections are stamped by the server; the
// envelope itself carries no server-side numbers.
// --------------------------------------------------------------------------

const JUNIOR_RADIO = {
  undercut: [
    'Boxing now — fresh tires and we get clear before they box.',
    'Pit this lap. Rubber decides it, and fresh beats old.',
  ],
  overcut: [
    "We stay out and let their pit lap do our attacking for us.",
    'Hold position, stay out — overcut them through the traffic.',
  ],
  stay_out: [
    'Clean laps, no pit. We keep the tires and the position.',
    'No box, no drama. Stay out and keep the rhythm.',
  ],
  attack: [
    'They are beatable right now — push and get through.',
    'Attack the moment you have a gap. Do not waste the rubber on fear.',
  ],
  defend: [
    'They are on our bumper. Defend the inside and do not chase.',
    'Block the racing line, manage your speed, keep them behind.',
  ],
  manage_tyres: [
    'Protect the tires — we need them alive to the end of the stint.',
    'Soften the pace, save the rubber, finish the lap in one piece.',
  ],
};

function withTemplate(key, tweaks) {
  return { ...ARCHETYPES[key].packet, ...tweaks };
}

function clampConfidence(n) {
  return Math.min(99, Math.max(50, Math.round(n)));
}

/**
 * The junior strategist's window plan.
 * @param {object} view buildView() shape (agents/agentBase.js)
 * @param {object} rng  seeded RNG (radio lines / small confidence jitter)
 * @returns {{ radio: string, proposals: Array }} unprojected envelope
 */
export function juniorTeamPlan(view, rng) {
  const { car, race } = view;
  const lastLap = race.currentLap >= race.totalLaps;
  const wear = car.tireWearPct ?? 0;
  const gapAhead = car.gapToCarAheadM ?? null;
  const gapBehind = car.gapToCarBehindM ?? null;
  const chasing = gapBehind != null && gapBehind < CONFIG.reactive.closeBattleGapM;
  const beatable = race.position != null && race.position > 1 && gapAhead != null && gapAhead < CONFIG.reactive.closeBattleGapM;

  let primary;
  let secondary;
  let tertiary = null;
  let confidence;

  if (!lastLap && (wear >= 55 || outOfFuelRange(car.fuelKg, race.lapsRemaining, 'normal') && wear >= 30)) {
    // Tire (or fuel) crisis: fresh rubber is the play.
    primary = { key: 'undercut', label: 'Box & undercut', narrative: 'Pit now; clean lap on fresh tires before the car behind boxes.', packet: withTemplate('undercut', {}) };
    secondary = { key: 'manage_tyres', label: 'Stay out, save rubber', narrative: 'Skip the box and hold on with what we have.', packet: withTemplate('manage_tyres', {}) };
    tertiary = { key: 'stay_out', label: 'No pit, race flat', narrative: 'No stop at all — flat out on the old set.', packet: withTemplate('stay_out', { pace: 'normal', tireManagement: 'normal' }) };
    confidence = 72 + (wear >= 75 ? 12 : wear >= 65 ? 7 : 0);
  } else if (lastLap) {
    // Final lap: nobody pits. Manage the tires and the fight.
    primary = {
      key: chasing ? 'defend' : 'stay_out',
      label: chasing ? 'Defend to the line' : 'Clean run to the line',
      narrative: chasing ? 'Final lap — they are close. Defend and do not mistake.' : 'Final lap — no stops, take the line clean.',
      packet: chasing ? withTemplate('defend', {}) : withTemplate('stay_out', {}),
    };
    secondary = { key: 'manage_tyres', label: 'Protect the set', narrative: 'One last managed lap on the dying rubber.', packet: withTemplate('manage_tyres', {}) };
    confidence = 68 + (chasing ? 8 : 4);
  } else if (beatable) {
    primary = {
      key: 'attack',
      label: 'Push & attack',
      narrative: `They are ${Math.round(gapAhead)} m ahead — faster pace and we can get through.`,
      packet: withTemplate('attack', { pace: wear >= 60 ? 'normal' : 'push' }),
    };
    secondary = { key: 'overcut', label: 'Stay out, overcut', narrative: 'Stay out and overcut them when they box.', packet: withTemplate('overcut', { pace: wear >= 60 ? 'normal' : 'push' }) };
    tertiary = { key: 'stay_out', label: 'No risk, no stop', narrative: 'Keep position; do not spend the tires on a fight.', packet: withTemplate('stay_out', {}) };
    confidence = 66 + (gapAhead < 15 ? 14 : 6) + (wear < 40 ? 8 : 0);
  } else if (chasing) {
    primary = {
      key: 'defend',
      label: 'Defend the position',
      narrative: `Someone is ${Math.round(gapBehind)} m back and closing. Block and manage.`,
      packet: withTemplate('defend', {}),
    };
    secondary = { key: 'manage_tyres', label: 'Slow the fight', narrative: 'Managed pace to slow their approach, save the tires.', packet: withTemplate('manage_tyres', {}) };
    tertiary = { key: 'stay_out', label: 'Race on, stay out', narrative: 'Keep racing normally; ignore the car behind for now.', packet: withTemplate('stay_out', {}) };
    confidence = 70 + (gapBehind < 15 ? 10 : 4);
  } else if (wear >= 40) {
    primary = { key: 'manage_tyres', label: 'Manage the tires', narrative: 'Rubber is aging — save it for the end of the stint.', packet: withTemplate('manage_tyres', {}) };
    secondary = { key: 'stay_out', label: 'Race flat, no pit', narrative: 'Flat out, no box, race for position.', packet: withTemplate('stay_out', {}) };
    confidence = 60 + (wear >= 55 ? 10 : 4);
  } else {
    primary = { key: 'stay_out', label: 'Clean race, no pit', narrative: 'Tires are fresh — clean laps and no pit stop.', packet: withTemplate('stay_out', {}) };
    secondary = race.position != null && race.position > 1
      ? { key: 'attack', label: 'Hunt for a pass', narrative: 'Go for the car ahead before the tires age.', packet: withTemplate('attack', { pace: 'push' }) }
      : { key: 'defend', label: 'Settle in, defend', narrative: 'Lead the race; stay ready to defend the line.', packet: withTemplate('defend', {}) };
    confidence = 62 + (wear < 20 ? 6 : 0);
  }

  const lines = JUNIOR_RADIO[primary.key] ?? JUNIOR_RADIO.stay_out;
  const radio = rng.pick(lines);
  const jitter = (rng.next() * 6) - 3;
  const props = [];
  props.push({ ...primary, recommend: true, confidence: clampConfidence(confidence + jitter) });
  props.push({ ...secondary, recommend: false, confidence: clampConfidence(confidence - 14 + jitter) });
  if (tertiary) props.push({ ...tertiary, recommend: false, confidence: clampConfidence(confidence - 22 + jitter) });

  return { radio, proposals: props };
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
  // MCPG-62: the scripted "AI team" — submits a tactic envelope (radio +
  // archetype proposal cards) each window. `decide` returning an envelope is
  // handled by the server's submit_phase_strategy (packet OR envelope).
  junior: { profile: 'junior', decide: juniorTeamPlan, decideReactive: conservativeReactive },
};
