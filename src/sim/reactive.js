/**
 * Reactive windows: short pause-the-sim windows opened for affected cars when
 * a trigger fires mid-lap. Agents answer with a small action set (or do
 * nothing); the server applies the outcome and resumes simulation.
 *
 * MVP triggers: close_battle, critical_tire_wear, pit_opportunity.
 * Nice-to-have (weather, safety car) are intentionally out of scope.
 */
import { CONFIG } from '../config.js';

export const REACTIVE_TRIGGERS = ['close_battle', 'critical_tire_wear', 'pit_opportunity'];

export const REACTIVE_ACTIONS = ['attack', 'defend', 'hold', 'pit_now'];

/** Actions legal for a given trigger + role in that trigger. */
export function allowedActionsFor(trigger, role) {
  if (trigger === 'close_battle') {
    if (role === 'attacker') return ['attack', 'hold'];
    if (role === 'defender') return ['defend', 'hold'];
    return ['hold'];
  }
  if (trigger === 'critical_tire_wear' || trigger === 'pit_opportunity') {
    return ['pit_now', 'hold'];
  }
  return ['hold'];
}

/**
 * Validate a reactive action submission.
 * @returns {{ action: {type: string, detail?: string}, errors: string[] }}
 */
export function parseReactiveAction(raw, allowed) {
  const errors = [];
  if (typeof raw !== 'object' || raw === null) {
    return { action: { type: 'hold' }, errors: ['action must be an object'] };
  }
  const type = raw.type;
  if (typeof type !== 'string' || !REACTIVE_ACTIONS.includes(type)) {
    errors.push(`type must be one of ${REACTIVE_ACTIONS.join(', ')}`);
  } else if (!allowed.includes(type)) {
    errors.push(`type '${type}' is not allowed for this trigger (allowed: ${allowed.join(', ')})`);
  }
  const action = { type: errors.length ? 'hold' : type };
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== 'string') errors.push('detail must be a string');
    else action.detail = raw.detail.slice(0, 500);
  }
  return { action, errors };
}

/**
 * Build a new reactive window record (not yet attached to the simulation).
 */
export function createReactiveWindow({
  id,
  trigger,
  carIds,
  roles,
  detail,
  windowSeconds,
  pending = null,
}) {
  return {
    id,
    trigger,
    carIds: [...carIds],
    roles: { ...roles }, // carId -> 'attacker'|'defender'|'subject'
    detail: detail ?? {},
    windowSeconds,
    opensAtMs: Date.now(),
    actions: new Map(), // carId -> { type, detail? }
    pending, // close_battle: { behindId, aheadId, baseP }
  };
}

export function reactiveWindowRemainingS(window) {
  if (!window) return 0;
  const elapsed = (Date.now() - window.opensAtMs) / 1000;
  return Math.max(0, window.windowSeconds - elapsed);
}

/**
 * Detect MVP triggers for the current tick context.
 * Returns at most one candidate (priority: close_battle > critical > pit).
 * Caller is responsible for cooldowns / "already open" gating.
 *
 * @param {object} ctx
 * @param {object[]} ctx.running  running cars sorted P1-first (dist desc)
 * @param {number} ctx.raceTimeS
 * @param {number} ctx.tickSeconds
 * @param {Map} ctx.overtakeCooldowns  same map the sim uses for pair attempts
 * @param {Set} ctx.tireAlerted        carIds already alerted this stint
 * @param {Set} ctx.pitAlertedThisLap  carIds already offered pit this lap
 * @param {number} ctx.currentLap
 * @param {number} ctx.totalLaps
 */
export function detectTrigger(ctx) {
  const cfg = CONFIG.reactive;
  const ot = CONFIG.overtaking;

  // 1) Close battle: same opportunity gate as overtakes, but opens a window
  //    instead of resolving immediately.
  for (let i = 0; i + 1 < ctx.running.length; i++) {
    const ahead = ctx.running[i];
    const behind = ctx.running[i + 1];
    if (ahead.status !== 'RUNNING' || behind.status !== 'RUNNING') continue;
    const gap = ahead.distTraveled - behind.distTraveled;
    if (gap > cfg.closeBattleGapM) continue;
    if (behind.speedMs <= ahead.speedMs) continue;

    const key = `${behind.id}|${ahead.id}`;
    const lastAttempt = ctx.overtakeCooldowns.get(key) ?? -Infinity;
    if (ctx.raceTimeS - lastAttempt < ot.cooldownTicks * ctx.tickSeconds) continue;

    const dv = behind.speedMs - ahead.speedMs;
    let p =
      ot.baseProbability +
      ot.speedDeltaCoefficient * (dv / ahead.speedMs) +
      ot.attackBonus * behind.strategy.aggression -
      ot.defendPenalty * ahead.strategy.defend;
    p = Math.min(ot.maxProbability, Math.max(ot.minProbability, p));

    return {
      trigger: 'close_battle',
      carIds: [behind.id, ahead.id],
      roles: { [behind.id]: 'attacker', [ahead.id]: 'defender' },
      detail: {
        gapM: Math.round(gap * 100) / 100,
        attackerId: behind.id,
        defenderId: ahead.id,
        attackerName: behind.name,
        defenderName: ahead.name,
      },
      pending: { behindId: behind.id, aheadId: ahead.id, baseP: p, pairKey: key },
    };
  }

  // 2) Critical tire wear (per stint; cleared on pit exit).
  for (const car of ctx.running) {
    if (car.tireWear < cfg.criticalTireWearPct) continue;
    if (ctx.tireAlerted.has(car.id)) continue;
    return {
      trigger: 'critical_tire_wear',
      carIds: [car.id],
      roles: { [car.id]: 'subject' },
      detail: {
        carId: car.id,
        name: car.name,
        tireWearPct: Math.round(car.tireWear * 10) / 10,
      },
      pending: null,
    };
  }

  // 3) Pit opportunity (strategy-driven): elevated wear, not yet offered this lap,
  //    and not already past the critical threshold (that fires first).
  if (ctx.currentLap < ctx.totalLaps) {
    for (const car of ctx.running) {
      if (car.pitRequested) continue;
      if (car.tireWear < cfg.pitOpportunityWearPct) continue;
      if (car.tireWear >= cfg.criticalTireWearPct) continue;
      if (ctx.pitAlertedThisLap.has(car.id)) continue;
      return {
        trigger: 'pit_opportunity',
        carIds: [car.id],
        roles: { [car.id]: 'subject' },
        detail: {
          carId: car.id,
          name: car.name,
          tireWearPct: Math.round(car.tireWear * 10) / 10,
          reason: 'elevated_tire_wear',
        },
        pending: null,
      };
    }
  }

  return null;
}

/**
 * Resolve a close-battle pending overtake given the submitted (or defaulted)
 * actions. Returns { success, probability, behindAction, aheadAction }.
 */
export function resolveCloseBattle(pending, actionsByCarId, rng) {
  const cfg = CONFIG.overtaking;
  const behindAction = actionsByCarId.get(pending.behindId)?.type ?? 'hold';
  const aheadAction = actionsByCarId.get(pending.aheadId)?.type ?? 'hold';

  let p = pending.baseP;
  // Reactive choices override / stack on the lap strategy posture.
  if (behindAction === 'attack') p += cfg.attackBonus;
  if (aheadAction === 'defend') p -= cfg.defendPenalty;
  // Explicit hold from the attacker softens the attempt.
  if (behindAction === 'hold') p -= cfg.attackBonus * 0.5;
  p = Math.min(cfg.maxProbability, Math.max(cfg.minProbability, p));

  return {
    success: rng.chance(p),
    probability: Math.round(p * 1000) / 1000,
    behindAction,
    aheadAction,
  };
}
