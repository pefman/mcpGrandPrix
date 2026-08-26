/**
 * MCPG-62 unit tests: tactic envelopes (validation + MCP schema parity),
 * archetype registry, projection stamping, the autopilot lifecycle and
 * driver-seat rules at the simulation level, and the junior fallback.
 */
import { describe, expect, it } from 'vitest';
import { Track } from '../src/track.js';
import { Simulation } from '../src/sim/simulation.js';
import {
  isTacticEnvelope,
  planFromPlainPacket,
  stampProjections,
  validateTacticEnvelope,
} from '../src/sim/tactics.js';
import { ARCHETYPES, ARCHETYPE_KEYS, isKnownArchetype, archetypeList } from '../src/sim/archetypes.js';
import { parseStrategy } from '../src/sim/car.js';
import { strategySchema, tacticEnvelopeSchema, strategyOrEnvelopeSchema } from '../src/server/mcpServer.js';
import { juniorTeamPlan } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';

// ------------------------------------------------------------- fixtures

/** One valid proposal card; `over` tweaks any field. */
const card = (over = {}) => ({
  key: 'attack',
  label: 'Go go go',
  narrative: 'We are faster than them.',
  packet: { pace: 'push', aggression: 1 },
  recommend: true,
  confidence: 80,
  ...over,
});

/** A valid two-card envelope. */
const ENV = (over = {}) => ({
  radio: 'Box and clear.',
  proposals: [
    card(),
    card({ key: 'stay_out', label: 'Play safe', recommend: false, confidence: 60, narrative: '' }),
  ],
  ...over,
});

function makeSim({ cars = 4, seed = 7, juniorFallbackSeconds = 0, earlyClose = true } = {}) {
  const events = [];
  const sim = new Simulation({
    totalLaps: 3,
    strategyWindowSeconds: 0,
    reactiveWindowSeconds: 0,
    tickSeconds: 0.25,
    seed,
    track: new Track(),
    onEvent: (e) => events.push(e),
    juniorFallbackSeconds,
    earlyCloseStrategyWindows: earlyClose,
  });
  for (let i = 0; i < cars; i += 1) sim.addAgent(`car-${i}`, `agent-${i}`);
  sim.start();
  return { sim, events };
}

const ids = (sim) => sim.cars.map((c) => c.id);
const planFor = (sim, carId) => sim.carById(carId).teamPlan;

/** Close the open window on sim (the resolution under test). */
function closeAndCollect(sim, events) {
  sim.closeWindow();
  return {
    autoTrusted: events.filter((e) => e.type === 'auto_trusted' && e.lap === sim.currentLap),
    resolved: events.filter((e) => e.type === 'strategy_resolved' && e.lap === sim.currentLap),
    defaulted: events.filter((e) => e.type === 'strategy_defaulted' && e.lap === sim.currentLap),
    decisions: events.find((e) => e.type === 'window_closed' && e.lap === sim.currentLap)?.decisions ?? [],
  };
}

// ---------------------------------------------------- envelope validation

describe('tactic envelope validation (simulation-level, zod-free)', () => {
  it('accepts a valid envelope and normalizes packets with defaults', () => {
    const { plan, errors } = validateTacticEnvelope(ENV());
    expect(errors).toEqual([]);
    expect(plan.radio).toBe('Box and clear.');
    expect(plan.proposals).toHaveLength(2);
    const rec = plan.proposals.find((p) => p.recommend);
    // the minimal packet got the sim's defaults filled in
    expect(rec.packet).toEqual({ pace: 'push', tireManagement: 'normal', aggression: 1, defend: 0, pitNow: false });
  });

  it('enforces the 1..3 proposal cap', () => {
    const three = ENV({ proposals: [card(), card({ key: 'defend', recommend: false }), card({ key: 'undercut', recommend: false, label: 'Pit stop' })] });
    expect(validateTacticEnvelope(three).errors).toEqual([]);
    const four = ENV({ proposals: [three.proposals[0], ...three.proposals, card({ key: 'overcut', recommend: false, label: 'Fourth' })] });
    expect(validateTacticEnvelope(four).errors.join(' ')).toContain('at most 3');
    expect(validateTacticEnvelope(ENV({ proposals: [] })).errors.join(' ')).toContain('at least one');
  });

  it('requires exactly one recommend: true', () => {
    expect(validateTacticEnvelope(ENV({ proposals: [card({ recommend: false }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('exactly one');
    expect(validateTacticEnvelope(ENV({ proposals: [card(), card({ key: 'defend', recommend: true })] })).errors.join(' ')).toContain('exactly one');
  });

  it('rejects unknown and duplicated archetype keys', () => {
    expect(validateTacticEnvelope(ENV({ proposals: [card({ key: 'moonshot' }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('must be one of');
    expect(validateTacticEnvelope(ENV({ proposals: [card(), card({ key: 'attack', recommend: false, label: 'Dup' })] })).errors.join(' ')).toContain('repeated');
  });

  it('enforces the text limits (radio 200, label 24, narrative 160)', () => {
    expect(validateTacticEnvelope(ENV({ radio: 'x'.repeat(201) })).errors.join(' ')).toContain('radio');
    expect(validateTacticEnvelope(ENV({ proposals: [card({ label: 'x'.repeat(25) }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('label');
    expect(validateTacticEnvelope(ENV({ proposals: [card({ narrative: 'x'.repeat(161) }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('narrative');
  });

  it('rejects confidence outside 50..99 (and non-integers)', () => {
    for (const c of [49, 100, 80.5]) {
      expect(validateTacticEnvelope(ENV({ proposals: [card({ confidence: c }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('confidence');
    }
  });

  it('rejects unknown fields (strict shape, like the MCP schema)', () => {
    expect(validateTacticEnvelope(ENV({ fuel: 5 })).errors.join(' ')).toContain('unknown envelope field');
    expect(validateTacticEnvelope(ENV({ proposals: [card({ turbo: true }), card({ key: 'defend', recommend: false })] })).errors.join(' ')).toContain('unknown field');
  });

  it('validates each card packet like any strategy submission (binary 0|1)', () => {
    const res = validateTacticEnvelope(ENV({ proposals: [card({ packet: { aggression: 0.5 } }), card({ key: 'defend', recommend: false })] }));
    expect(res.errors.join(' ')).toContain('aggression must be 0 or 1');
    expect(validateTacticEnvelope(ENV({ proposals: [card({ packet: { aggression: 1, defend: 1 } }), card({ key: 'defend', recommend: false })] })).errors).toEqual([]);
  });

  it('isTacticEnvelope discriminates envelopes from plain packets', () => {
    expect(isTacticEnvelope(ENV())).toBe(true);
    expect(isTacticEnvelope({ pace: 'push' })).toBe(false);
    expect(isTacticEnvelope({})).toBe(false);
    expect(isTacticEnvelope(null)).toBe(false);
  });

  it('planFromPlainPacket normalizes a plain packet into the single-card shape', () => {
    const plan = planFromPlainPacket({ pace: 'manage', pitNow: true });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0].recommend).toBe(true);
    expect(plan.proposals[0].key).toBeNull();
    expect(plan.proposals[0].packet.pitNow).toBe(true);
  });
});

// ------------------------------------------------------------- MCP schema

describe('MCP zod schema (parity with the sim validator, MCPG-62)', () => {
  it('accepts plain packets — including the minimal {} and binary levers', () => {
    expect(strategyOrEnvelopeSchema.parse({}).aggression).toBe(0); // bug fix: was 0.5
    expect(strategyOrEnvelopeSchema.parse({}).defend).toBe(0);
    expect(strategyOrEnvelopeSchema.parse({ aggression: 1, defend: 1, pitNow: true }).pitNow).toBe(true);
    const env = tacticEnvelopeSchema.parse(ENV());
    expect(env.proposals).toHaveLength(2);
    expect(env.proposals[0].packet.pace).toBe('push');
  });

  it('rejects fractional aggression/defend (the old 0..1 float advertisement is gone)', () => {
    expect(() => strategyOrEnvelopeSchema.parse({ aggression: 0.5 })).toThrow();
    expect(() => strategyOrEnvelopeSchema.parse({ defend: 0.25 })).toThrow();
    expect(() => strategyOrEnvelopeSchema.parse({ aggression: 2 })).toThrow();
  });

  it('rejects malformed envelopes through the union', () => {
    expect(() => strategyOrEnvelopeSchema.parse(ENV({ proposals: [card({ key: 'nope' }), card({ key: 'defend', recommend: false })] }))).toThrow();
    expect(() => strategyOrEnvelopeSchema.parse(ENV({ proposals: [card(), card({ key: 'defend', recommend: true })] }))).toThrow(); // two recommends
    expect(() => strategyOrEnvelopeSchema.parse(ENV({ confidence: 90 }))).toThrow(); // unknown top-level field
  });
});

// ------------------------------------------------------- archetype registry

describe('archetype registry (fixed vocabulary)', () => {
  it('exposes the six slice-1 archetypes with valid packet templates', () => {
    expect(ARCHETYPE_KEYS).toEqual(['undercut', 'overcut', 'stay_out', 'attack', 'defend', 'manage_tyres']);
    expect(archetypeList()).toHaveLength(6);
    for (const a of archetypeList()) {
      expect(isKnownArchetype(a.key)).toBe(true);
      expect(parseStrategy(a.packet).errors, `${a.key} template must be a valid packet`).toEqual([]);
    }
  });

  it('rejects anything outside the registry', () => {
    expect(isKnownArchetype('moonshot')).toBe(false);
    expect(isKnownArchetype('')).toBe(false);
  });
});

// ------------------------------------------------------------- projections

describe('server-side projection stamping (heuristics, state-derived)', () => {
  function simWithCar() {
    const { sim } = makeSim({ cars: 4, seed: 11 });
    const car = sim.carById(sim.cars[1].id); // P2 on the grid
    return { sim, car };
  }

  it('a pit stop dominates the delta (positive = slower than the reference)', () => {
    const { sim, car } = simWithCar();
    const plan = { radio: null, source: 'team', proposals: [{ key: 'undercut', label: 'x', narrative: '', packet: { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 0, pitNow: true }, recommend: true, confidence: 80 }] };
    stampProjections(sim._projectionCtx(car), plan);
    const p = plan.proposals[0].projection;
    expect(p.projectedDeltaS).toBeGreaterThan(10); // ~18 s pit stop
    expect(p.riskTag).toBe('safe'); // fresh car, fuel for the race
  });

  it('a faster lap than the reference gains a position, a slower one loses one', () => {
    const { sim, car } = simWithCar();
    const mk = (packet) => ({ radio: null, source: 'team', proposals: [{ key: 'attack', label: 'x', narrative: '', packet, recommend: true, confidence: 80 }] });
    const pushPlan = mk({ pace: 'push', aggression: 1, defend: 0, pitNow: false });
    stampProjections(sim._projectionCtx(car), pushPlan);
    expect(pushPlan.proposals[0].projection.projectedDeltaS).toBeLessThan(0); // faster lap
    expect(pushPlan.proposals[0].projection.projectedPos).toBe(1); // P2 -> P1
    const slowPlan = mk({ pace: 'manage', tireManagement: 'manage', aggression: 0, defend: 0, pitNow: false });
    stampProjections(sim._projectionCtx(car), slowPlan);
    expect(slowPlan.proposals[0].projection.projectedDeltaS).toBeGreaterThan(0); // slower lap
    expect(slowPlan.proposals[0].projection.projectedPos).toBe(3); // P2 -> P3
  });

  it('tags risk from tires, fuel and pointless final-lap pits', () => {
    const { sim, car } = simWithCar();
    car.tireWear = 95; // dying set
    const plan = { radio: null, source: 'team', proposals: [{ key: 'attack', label: 'x', narrative: '', packet: { pace: 'push', aggression: 1, defend: 0, pitNow: false }, recommend: true, confidence: 80 }] };
    stampProjections(sim._projectionCtx(car), plan);
    expect(plan.proposals[0].projection.riskTag).toBe('risky');

    car.tireWear = 20;
    const pitPlan = { radio: null, source: 'team', proposals: [{ key: 'undercut', label: 'x', narrative: '', packet: { pace: 'push', aggression: 1, defend: 0, pitNow: true }, recommend: true, confidence: 80 }] };
    sim.totalLaps = 3;
    sim.currentLap = 3; // final lap: a pit stop buys nothing
    stampProjections(sim._projectionCtx(car), pitPlan);
    expect(pitPlan.proposals[0].projection.riskTag).toBe('risky');
  });
});

// ---------------------------------------------------- autopilot lifecycle

describe('autopilot lifecycle (MCPG-62: autopilot is the resting default)', () => {
  it('unclaimed seat + team envelope: the recommended packet runs, logged as auto_trusted', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    const res = sim.submitPhaseStrategy(a, ENV());
    expect(res.accepted).toBe(true);
    expect(res.projections).toHaveLength(2);
    expect(events.some((e) => e.type === 'tactics_proposed' && e.source === 'team' && e.carId === a)).toBe(true);
    const out = closeAndCollect(sim, events);
    const d = out.decisions.find((x) => x.carId === a);
    expect(d.mode).toBe('autopilot'); // unclaimed seat = the auto_trusted path
    expect(d.source).toBe('team');
    expect(out.autoTrusted.some((e) => e.carId === a)).toBe(true);
    expect(sim.carById(a).strategy).toEqual(planFor(sim, a).proposals.find((p) => p.recommend).packet);
    // team-less cars keep the pre-MCPG-62 behavior: last strategy + 'default'
    expect(out.decisions.filter((x) => x.mode === 'default')).toHaveLength(3);
  });

  it('plain packets behave exactly as before the envelope existed', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    const res = sim.submitPhaseStrategy(a, { pace: 'push', aggression: 1 });
    expect(res.accepted).toBe(true);
    expect(events.some((e) => e.type === 'strategy_submitted' && e.carId === a)).toBe(true);
    const out = closeAndCollect(sim, events);
    const car = sim.carById(a);
    expect(car.strategy.pace).toBe('push');
    expect(car.pitRequested).toBe(false);
    const at = out.autoTrusted.find((e) => e.carId === a);
    expect(at.source).toBe('team');
    expect(car.teamPlan.proposals).toHaveLength(1); // normalized single card
  });

  it('duplicate plan submissions are rejected (first plan wins, idempotent)', () => {
    const { sim } = makeSim();
    const a = ids(sim)[0];
    expect(sim.submitPhaseStrategy(a, ENV()).accepted).toBe(true);
    const dup = sim.submitPhaseStrategy(a, ENV());
    expect(dup.accepted).toBe(false);
    expect(dup.error).toBe('duplicate_strategy');
  });

  it('driver lock of a NON-recommended card overrides the plan and flips the seat to MANUAL', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    expect(sim.claimDriverSeat(a, 'driver-1').accepted).toBe(true);
    sim.submitPhaseStrategy(a, ENV());
    const alt = planFor(sim, a).proposals.find((p) => !p.recommend);
    const res = sim.lockInTactic(a, 'driver-1', alt.key);
    expect(res).toMatchObject({ accepted: true, mode: 'manual', trusted: false });
    expect(events.some((e) => e.type === 'driver_locked' && e.carId === a && e.trusted === false)).toBe(true);
    expect(events.some((e) => e.type === 'autopilot_state' && e.carId === a && e.change === 'lock' && e.mode === 'manual')).toBe(true);
    const out = closeAndCollect(sim, events);
    expect(sim.carById(a).strategy).toEqual(alt.packet); // the locked card ran
    const d = out.decisions.find((x) => x.carId === a);
    expect(d.mode).toBe('overridden');
    expect(d.source).toBe('driver_lock');
  });

  it('locking the RECOMMENDED card is the deliberate "trust the team" (mode trusted)', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    const rec = planFor(sim, a).proposals.find((p) => p.recommend);
    expect(sim.lockInTactic(a, 'driver-1', rec.key)).toMatchObject({ accepted: true, trusted: true });
    const out = closeAndCollect(sim, events);
    expect(out.decisions.find((x) => x.carId === a).mode).toBe('trusted');
  });

  it('the MANUAL seat persists across windows until resume_autopilot (spec: stays manual)', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    const alt = planFor(sim, a).proposals.find((p) => !p.recommend);
    sim.lockInTactic(a, 'driver-1', alt.key);
    sim.closeWindow();

    // lap 2: same team plan, the driver does NOTHING — the seat is still manual
    sim.openStrategyWindow(2);
    sim.submitPhaseStrategy(a, ENV());
    for (const c of sim.cars) if (c.id !== a && c.status !== 'RETIRED') sim.submitPhaseStrategy(c.id, { pace: 'normal' });
    const out = closeAndCollect(sim, events);
    expect(out.decisions.find((x) => x.carId === a).mode).toBe('manual');
    expect(sim.carById(a).driverSeat.mode).toBe('manual');

    // lap 3: resume autopilot — the resting default comes back
    sim.openStrategyWindow(3);
    sim.submitPhaseStrategy(a, ENV());
    for (const c of sim.cars) if (c.id !== a && c.status !== 'RETIRED') sim.submitPhaseStrategy(c.id, { pace: 'normal' });
    expect(sim.resumeAutopilot(a, 'driver-1')).toMatchObject({ accepted: true, mode: 'autopilot' });
    const out3 = closeAndCollect(sim, events);
    expect(out3.decisions.find((x) => x.carId === a).mode).toBe('autopilot');
    expect(sim.carById(a).driverSeat.mode).toBe('autopilot');
  });

  it('override with a raw packet: that packet runs, mode overridden', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    const packet = { pace: 'manage', tireManagement: 'manage', aggression: 0, defend: 1, pitNow: false };
    const res = sim.overrideTactic(a, 'driver-1', packet);
    expect(res).toMatchObject({ accepted: true, mode: 'manual' });
    expect(events.some((e) => e.type === 'driver_override' && e.carId === a)).toBe(true);
    const out = closeAndCollect(sim, events);
    expect(sim.carById(a).strategy).toEqual(packet);
    expect(out.decisions.find((x) => x.carId === a).mode).toBe('overridden');
    expect(out.decisions.find((x) => x.carId === a).source).toBe('driver_override');
  });

  it('resume_autopilot withdraws a pending action from the same window', () => {
    const { sim, events } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    const rec = planFor(sim, a).proposals.find((p) => p.recommend);
    sim.lockInTactic(a, 'driver-1', rec.key);
    expect(sim.resumeAutopilot(a, 'driver-1')).toMatchObject({ accepted: true, withdrew: true });
    const out = closeAndCollect(sim, events);
    expect(out.decisions.find((x) => x.carId === a).mode).toBe('autopilot');
    expect(out.autoTrusted.some((e) => e.carId === a)).toBe(true);
  });
});

// ---------------------------------------------------------- driver seat rules

describe('driver seat claiming and action rules (one driver per car, claim-first)', () => {
  it('claiming outside a strategy window is rejected (valid only in-window)', () => {
    const { sim } = makeSim();
    sim.closeWindow(); // phase -> simulation
    const a = ids(sim)[0];
    expect(sim.claimDriverSeat(a, 'driver-1').error).toContain('not_in_window');
    expect(sim.lockInTactic(a, 'driver-1', 'attack').error).toContain('not_in_window');
    expect(sim.overrideTactic(a, 'driver-1', { pace: 'push' }).error).toContain('not_in_window');
    expect(sim.resumeAutopilot(a, 'driver-1').error).toContain('not_in_window');
  });

  it('one driver per car: the first claim wins, a second driver is rejected', () => {
    const { sim } = makeSim();
    const a = ids(sim)[0];
    expect(sim.claimDriverSeat(a, 'driver-1')).toMatchObject({ accepted: true, mode: 'autopilot' });
    expect(sim.claimDriverSeat(a, 'driver-2').error).toBe('seat_taken');
    // idempotent re-claim by the same session
    expect(sim.claimDriverSeat(a, 'driver-1')).toMatchObject({ accepted: true, idempotent: true });
    // other cars stay claimable
    expect(sim.claimDriverSeat(ids(sim)[1], 'driver-2').accepted).toBe(true);
  });

  it('unknown cars and unclaimed seats are rejected cleanly', () => {
    const { sim } = makeSim();
    expect(sim.claimDriverSeat(999, 'driver-1').error).toBe('unknown_car');
    const a = ids(sim)[0];
    expect(sim.lockInTactic(a, 'driver-1', 'attack').error).toBe('seat_not_claimed');
    sim.claimDriverSeat(a, 'driver-1');
    expect(sim.lockInTactic(a, 'driver-2', 'attack').error).toBe('not_your_seat');
  });

  it('lock_in validates against the posted plan (no plan / unknown key / already acted)', () => {
    const { sim } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    expect(sim.lockInTactic(a, 'driver-1', 'attack').error).toBe('no_plan');
    sim.submitPhaseStrategy(a, ENV());
    expect(sim.lockInTactic(a, 'driver-1', 'undercut').error).toBe('unknown_proposal');
    const alt = planFor(sim, a).proposals.find((p) => !p.recommend);
    expect(sim.lockInTactic(a, 'driver-1', alt.key).accepted).toBe(true);
    expect(sim.lockInTactic(a, 'driver-1', alt.key).error).toBe('already_acted');
  });

  it('override validates the packet like any strategy submission', () => {
    const { sim } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    expect(sim.overrideTactic(a, 'driver-1', { aggression: 0.5 }).error).toBe('invalid_packet');
    expect(sim.overrideTactic(a, 'driver-1', { pace: 'ludicrous' }).error).toBe('invalid_packet');
    expect(sim.overrideTactic(a, 'driver-1', { pace: 'push', aggression: 1 }).accepted).toBe(true);
  });

  it('a driver action counts as the car submission (late team plans are duplicates)', () => {
    const { sim } = makeSim();
    const a = ids(sim)[0];
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    const rec = planFor(sim, a).proposals.find((p) => p.recommend);
    sim.lockInTactic(a, 'driver-1', rec.key);
    expect(sim.submitPhaseStrategy(a, { pace: 'push' }).error).toBe('duplicate_strategy');
  });
});

// ------------------------------------------------------ junior fallback

describe('junior-strategist fallback (keeps autopilot meaningful LLM-free)', () => {
  it('fills in cars with no plan after the fallback deadline', () => {
    const { sim, events } = makeSim({ juniorFallbackSeconds: 0.05 });
    const a = ids(sim)[0];
    // only car a gets a real team plan; the others are team-less
    sim.submitPhaseStrategy(a, ENV());
    sim.windowOpensAtMs = Date.now() - 100; // age past the 50 ms deadline
    sim.checkJuniorFallback();
    const other = sim.carById(ids(sim)[1]);
    expect(other.teamPlan.source).toBe('junior');
    expect(other.submittedStrategy).toBe(true);
    expect(other.teamPlan.proposals.length).toBeGreaterThanOrEqual(2); // always offers choices
    expect(events.some((e) => e.type === 'tactics_proposed' && e.fallback === true && e.carId === other.id)).toBe(true);
    const out = closeAndCollect(sim, events);
    const d = out.decisions.find((x) => x.carId === other.id);
    expect(d.mode).toBe('autopilot');
    expect(d.source).toBe('junior');
    // the fallback is one-shot per window and never touches posted plans
    sim.openStrategyWindow(2);
    sim.submitPhaseStrategy(a, ENV()); // car a posts again in the new window
    sim.windowOpensAtMs = Date.now() - 100;
    sim.checkJuniorFallback();
    expect(sim.carById(a).teamPlan.source).toBe('team'); // posted plan untouched
    expect(sim.carById(ids(sim)[1]).teamPlan.source).toBe('junior'); // refilled for the new window
  });

  it('is disabled when juniorFallbackSeconds is 0 (pre-MCPG-62 defaults stand)', () => {
    const { sim, events } = makeSim({ juniorFallbackSeconds: 0 });
    sim.windowOpensAtMs = 0; // arbitrarily old
    sim.checkJuniorFallback();
    for (const c of sim.cars) expect(c.teamPlan).toBeNull();
    const out = closeAndCollect(sim, events);
    expect(out.defaulted.length).toBe(sim.cars.length);
    expect(out.decisions.every((d) => d.mode === 'default')).toBe(true);
  });
});

// ------------------------------------------------------------- early close

describe('early strategy-window close (config flag, default on)', () => {
  it('canEarlyClose: plans + satisfied seats only', () => {
    const { sim } = makeSim({ earlyClose: true });
    const [a, b] = ids(sim);
    const rest = () => ids(sim).filter((id) => id !== a && id !== b);
    const planRest = () => { for (const id of rest()) sim.submitPhaseStrategy(id, { pace: 'normal' }); };
    expect(sim.canEarlyClose()).toBe(false); // no plans
    sim.submitPhaseStrategy(a, ENV());
    expect(sim.canEarlyClose()).toBe(false); // b has no plan
    sim.submitPhaseStrategy(b, { pace: 'normal' });
    planRest();
    expect(sim.canEarlyClose()).toBe(true); // all planned, no seats

    sim.claimDriverSeat(a, 'driver-1');
    expect(sim.canEarlyClose()).toBe(true); // autopilot seat: satisfied
    sim.openStrategyWindow(2);
    sim.claimDriverSeat(a, 'driver-1'); // idempotent across windows
    sim.submitPhaseStrategy(a, ENV());
    sim.submitPhaseStrategy(b, { pace: 'normal' });
    planRest();
    expect(sim.canEarlyClose()).toBe(true);
    const alt = planFor(sim, a).proposals.find((p) => !p.recommend);
    sim.lockInTactic(a, 'driver-1', alt.key); // manual seat WITH an action
    expect(sim.canEarlyClose()).toBe(true);

    // manual seat WITHOUT an action holds the window to the full countdown
    sim.openStrategyWindow(3);
    sim.claimDriverSeat(a, 'driver-1');
    sim.submitPhaseStrategy(a, ENV());
    sim.submitPhaseStrategy(b, { pace: 'normal' });
    planRest();
    expect(sim.canEarlyClose()).toBe(false);
    sim.lockInTactic(a, 'driver-1', alt.key);
    expect(sim.canEarlyClose()).toBe(true);
  });

  it('early close is a no-op behind the config flag', () => {
    const { sim } = makeSim({ earlyClose: false });
    const a = ids(sim)[0];
    sim.submitPhaseStrategy(a, ENV());
    for (const c of sim.cars) if (c.id !== a) sim.submitPhaseStrategy(c.id, { pace: 'normal' });
    expect(sim.canEarlyClose()).toBe(false); // flag off: full countdown always
  });
});

// ------------------------------------------------------ junior team brain

describe('scripted junior strategist (the LLM-free team brain)', () => {
  const views = [
    { car: { tireWearPct: 10, fuelKg: 95, gapToLeaderM: 0, gapToCarAheadM: null, gapToCarBehindM: null }, race: { currentLap: 1, totalLaps: 10, lapsRemaining: 10, position: 1 } }, // P1, fresh
    { car: { tireWearPct: 20, fuelKg: 90, gapToLeaderM: 40, gapToCarAheadM: 20, gapToCarBehindM: 50 }, race: { currentLap: 3, totalLaps: 10, lapsRemaining: 8, position: 2 } }, // beatable
    { car: { tireWearPct: 20, fuelKg: 90, gapToLeaderM: 40, gapToCarAheadM: 80, gapToCarBehindM: 12 }, race: { currentLap: 3, totalLaps: 10, lapsRemaining: 8, position: 2 } }, // being chased
    { car: { tireWearPct: 70, fuelKg: 80, gapToLeaderM: 60, gapToCarAheadM: 40, gapToCarBehindM: 40 }, race: { currentLap: 6, totalLaps: 10, lapsRemaining: 5, position: 2 } }, // tire crisis
    { car: { tireWearPct: 40, fuelKg: 70, gapToLeaderM: 60, gapToCarAheadM: 40, gapToCarBehindM: 40 }, race: { currentLap: 6, totalLaps: 10, lapsRemaining: 5, position: 2 } }, // mid-race
    { car: { tireWearPct: 90, fuelKg: 50, gapToLeaderM: 30, gapToCarAheadM: 15, gapToCarBehindM: 10 }, race: { currentLap: 10, totalLaps: 10, lapsRemaining: 1, position: 2 } }, // final lap
  ];

  it('emits a valid envelope in every situation (2-3 cards, one recommend, known keys)', () => {
    for (const v of views) {
      for (let seed = 1; seed <= 5; seed += 1) {
        const plan = juniorTeamPlan(v, createRng(seed));
        const { errors } = validateTacticEnvelope({ radio: plan.radio, proposals: plan.proposals });
        expect(errors, `view ${JSON.stringify(v.car.tireWearPct)}/${v.race.currentLap} seed ${seed}: ${errors.join(', ')}`).toEqual([]);
        expect(plan.proposals.length).toBeGreaterThanOrEqual(2);
        expect(plan.proposals.length).toBeLessThanOrEqual(3);
        expect(plan.proposals.filter((p) => p.recommend)).toHaveLength(1);
        for (const p of plan.proposals) {
          expect(isKnownArchetype(p.key)).toBe(true);
          expect(p.confidence).toBeGreaterThanOrEqual(50);
          expect(p.confidence).toBeLessThanOrEqual(99);
          expect(parseStrategy(p.packet).errors).toEqual([]);
        }
      }
    }
  });

  it('situational: pits on a tire crisis (unless final lap), attacks a beatable car, defends when chased', () => {
    const keyOf = (v) => juniorTeamPlan(v, createRng(3)).proposals.find((p) => p.recommend).key;
    expect(keyOf(views[3])).toBe('undercut'); // wear 70, laps left
    expect(keyOf(views[1])).toBe('attack'); // 20 m behind, faster
    expect(keyOf(views[2])).toBe('defend'); // 12 m behind us
    expect(keyOf(views[5])).not.toBe('undercut'); // final lap: nobody pits
  });
});