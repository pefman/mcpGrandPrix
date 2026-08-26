/**
 * Team tactic plans (MCPG-62): validation of the optional "envelope" a team
 * plan can carry, and the server-side projection stamping.
 *
 * Envelope shape (what `submit_phase_strategy` also accepts, in addition to
 * a plain strategy packet):
 *
 *   {
 *     radio?: string            — <= 200 chars, the team's radio message
 *     proposals: [              — 1..3 tactic cards
 *       {
 *         key:        string    — a known archetype key (archetypes.js)
 *         label:      string    — <= 24 chars, card title
 *         narrative?: string    — <= 160 chars, card body
 *         packet:      strategy packet (same contract as a plain submission)
 *         recommend:  boolean   — exactly ONE proposal may recommend: true
 *         confidence: integer   — 50..99, team's self-reported confidence
 *       }
 *     ]
 *   }
 *
 * Projection stamping: before a plan is broadcast the server stamps each
 * proposal with { projectedPos, projectedDeltaS, riskTag } using the
 * car's authoritative state (gap/wear/pit-loss math). These numbers are
 * HEURISTICS for the cockpit UI — they are computed from the packet alone
 * (the LLM's own numbers, e.g. `confidence`, never drive them), and they
 * never feed the simulation.
 */
import { CONFIG } from '../config.js';
import { parseStrategy, defaultStrategy } from './car.js';
import { ARCHETYPE_KEYS, isKnownArchetype } from './archetypes.js';

export const TACTIC_LIMITS = {
  radioMax: 200,
  labelMax: 24,
  narrativeMax: 160,
  maxProposals: CONFIG.tactics.maxProposals,
  confidenceMin: 50,
  confidenceMax: 99,
};

/** The only fields a proposal card may carry (strict shape). */
const PROPOSAL_FIELDS = ['key', 'label', 'narrative', 'packet', 'recommend', 'confidence'];

/** True when a raw strategy argument is an envelope (vs a plain packet). */
export function isTacticEnvelope(raw) {
  return typeof raw === 'object' && raw !== null && Array.isArray(raw.proposals);
}

/**
 * Server-side validation of an envelope (the MCP zod schema mirrors these
 * rules; this is the simulation-level authority, zod-free).
 * @returns {{ plan: object|null, errors: string[] }}
 * On success `plan` is the normalized plan:
 *   { radio: string|null,
 *     proposals: [{ key, label, narrative, packet (full), recommend, confidence, projection }] }
 * (projections are NOT stamped here — the Simulation stamps them at
 * submission time, from live state.)
 */
export function validateTacticEnvelope(raw) {
  const L = TACTIC_LIMITS;
  const errors = [];
  if (typeof raw !== 'object' || raw === null) {
    return { plan: null, errors: ['envelope must be an object'] };
  }
  // strict shape: no unknown top-level fields (mirrors the MCP zod schema)
  for (const k of Object.keys(raw)) {
    if (k !== 'radio' && k !== 'proposals') errors.push(`unknown envelope field '${k}'`);
  }
  if (!Array.isArray(raw.proposals)) {
    return { plan: null, errors: ['envelope must contain a proposals array'] };
  }
  if (raw.radio !== undefined) {
    if (typeof raw.radio !== 'string') errors.push('radio must be a string');
    else if (raw.radio.length > L.radioMax) errors.push(`radio exceeds ${L.radioMax} chars`);
  }
  if (raw.proposals.length < 1) errors.push('envelope needs at least one proposal');
  if (raw.proposals.length > L.maxProposals) errors.push(`envelope allows at most ${L.maxProposals} proposals`);

  const proposals = [];
  const seenKeys = new Set();
  let recommends = 0;
  raw.proposals.forEach((p, i) => {
    const at = `proposals[${i}]`;
    if (typeof p !== 'object' || p === null) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of Object.keys(p)) {
      if (!PROPOSAL_FIELDS.includes(k)) errors.push(`${at} has unknown field '${k}'`);
    }
    if (typeof p.key !== 'string' || !isKnownArchetype(p.key)) {
      errors.push(`${at}.key must be one of ${ARCHETYPE_KEYS.join(', ')}`);
      return; // unknown archetype: packet below is still validated
    } else if (seenKeys.has(p.key)) {
      errors.push(`${at}.key '${p.key}' is repeated (one proposal per archetype)`);
    }
    if (typeof p.label !== 'string' || p.label.length < 1 || p.label.length > L.labelMax) {
      errors.push(`${at}.label must be a string of 1..${L.labelMax} chars`);
    }
    if (p.narrative !== undefined) {
      if (typeof p.narrative !== 'string') errors.push(`${at}.narrative must be a string`);
      else if (p.narrative.length > L.narrativeMax) errors.push(`${at}.narrative exceeds ${L.narrativeMax} chars`);
    }
    if (typeof p.recommend !== 'boolean') {
      errors.push(`${at}.recommend must be a boolean`);
    } else if (p.recommend) {
      recommends += 1;
    }
    if (typeof p.confidence !== 'number' || !Number.isInteger(p.confidence) ||
        p.confidence < L.confidenceMin || p.confidence > L.confidenceMax) {
      errors.push(`${at}.confidence must be an integer ${L.confidenceMin}-${L.confidenceMax}`);
    }
    const { strategy, errors: packetErrors } = parseStrategy(p.packet ?? {});
    for (const e of packetErrors) errors.push(`${at}.packet: ${e}`);

    if (errors.length === 0 || !errors.some((e) => e.startsWith(at))) {
      if (typeof p.key === 'string' && isKnownArchetype(p.key)) seenKeys.add(p.key);
      proposals.push({
        key: p.key,
        label: typeof p.label === 'string' ? p.label : 'Tactic',
        narrative: typeof p.narrative === 'string' ? p.narrative : '',
        packet: strategy,
        recommend: p.recommend === true,
        confidence: typeof p.confidence === 'number' ? p.confidence : null,
      });
    }
  });
  if (errors.length === 0) {
    if (recommends !== 1) {
      errors.push(`envelope must recommend exactly one proposal (got ${recommends})`);
    }
  }
  if (errors.length > 0) return { plan: null, errors };
  return { plan: { radio: typeof raw.radio === 'string' ? raw.radio : null, proposals }, errors: [] };
}

/** The one recommended proposal of a normalized plan (null if none). */
export function recommendedProposal(plan) {
  if (!plan) return null;
  return plan.proposals.find((p) => p.recommend) ?? null;
}

/**
 * Stamp a normalized plan's proposals with server-side projections.
 * Heuristic, state-derived, display-only (see module doc).
 *
 * @param {object} ctx
 * @param {import('./car.js').Car} ctx.car          the car the plan is for
 * @param {object}   ctx.standings                  sim.standings() rows
 * @param {number}   ctx.totalCars                  number of cars on the grid
 * @param {import('../track.js').Track} ctx.track   the race track
 * @param {number}   ctx.lapsRemaining              laps left incl. current
 * @param {number}   ctx.currentLap
 * @param {number}   ctx.totalLaps
 * @param {object}   ctx.plan                       normalized plan (mutates its proposals)
 */
export function stampProjections(ctx, plan) {
  if (!plan) return;
  const { car, standings, totalCars, track, currentLap, totalLaps } = ctx;
  const pos = standings.find((s) => s.carId === car.id)?.position ?? null;
  const wear = car.tireWear;

  for (const p of plan.proposals) {
    // Normalize: the sim always works with fully-defaulted packets (the
    // envelope path pre-normalizes; direct callers may pass raw packets).
    const s = parseStrategy(p.packet ?? {}).strategy;

    // Lap-time model: flat pace over the lap (the sim's own per-tick model
    // applies the same base*pace*grip product per tick).
    const grip = (w) => 1 - CONFIG.physics.tireGripDrop * (w / 100);
    const lapTime = (packet) => track.lengthM / (CONFIG.physics.baseSpeedMs * CONFIG.physics.paceMultipliers[packet.pace] * grip(packet.pitNow ? 0 : wear));
    let deltaS = lapTime(s) - lapTime(car.strategy);
    if (s.pitNow) deltaS += CONFIG.pit.stopSeconds; // the stop itself
    const deltaM = deltaS * CONFIG.physics.baseSpeedMs; // same delta in meters

    // Position projection: a clearly better (worse) lap than the reference
    // gains (loses) one position; ties hold. "Clearly" = 2% of a reference
    // lap (about a car length of racing at the sim's base speed) — tuned so
    // a real pace change (push vs manage is ~3%) moves the projection.
    // Clamped to the grid.
    let projectedPos = pos;
    if (pos != null) {
      const refLapS = lapTime(car.strategy);
      const band = 0.02 * refLapS;
      const shift = deltaS < -band ? -1 : deltaS > band ? 1 : 0;
      projectedPos = Math.min(Math.max(pos + shift, 1), Math.max(totalCars, 1));
    }

    // Risk: tires that cannot survive the lap, fuel that cannot reach the
    // finish, or a pointless pit stop on the final lap.
    const T = CONFIG.tires;
    const projectedWear = s.pitNow ? 0 : Math.min(100, wear + T.wearPerLapBase * T.paceWearFactors[s.pace] * T.strategyWearFactors[s.tireManagement]);
    const burnPerLap = CONFIG.fuel.perLapNormalKg * CONFIG.fuel.paceFactors[s.pace];
    const outOfFuelRange = car.fuelKg <= lapsRemainingBurn(ctx, burnPerLap);
    let riskTag = 'safe';
    if (s.pitNow && currentLap >= totalLaps) riskTag = 'risky';
    else if (projectedWear >= 90 || outOfFuelRange) riskTag = 'risky';
    else if (projectedWear >= 70 || (s.pace === 'push' && wear >= 50) || car.fuelKg < burnPerLap * 2) riskTag = 'moderate';

    p.projection = {
      projectedPos,
      projectedDeltaS: Math.round(deltaS * 10) / 10,
      projectedDeltaM: Math.round(deltaM * 10) / 10,
      riskTag,
    };
  }
}

function lapsRemainingBurn(ctx, burnPerLap) {
  return Math.max(0, ctx.totalLaps - ctx.currentLap + 1) * burnPerLap;
}

/**
 * Normalize a plain strategy packet into the single-card plan shape so the
 * rest of the stack (snapshot, cockpit, dossier) has ONE shape to consume.
 * Projections are stamped by the caller (the Simulation).
 */
export function planFromPlainPacket(packet) {
  const { strategy } = parseStrategy(packet);
  return {
    radio: null,
    proposals: [
      {
        key: null, // no archetype — a raw team packet
        label: 'TEAM PLAN',
        narrative: '',
        packet: strategy ?? defaultStrategy(),
        recommend: true,
        confidence: null,
      },
    ],
  };
}