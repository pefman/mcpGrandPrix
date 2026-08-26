/**
 * The race simulation. 100% deterministic given a seed and a sequence of
 * inputs (strategies, ticks, reactive actions). No wall clock, no I/O — the
 * RaceSession and the HTTP layer own time and logging.
 *
 * Loop per lap:
 *   1. strategy window: each car may submit exactly one strategy packet
 *      (first submission wins; later ones are rejected as duplicates).
 *   2. simulation: the server ticks the lap forward until every running car
 *      has crossed the line, applying pace, tire wear, fuel, traffic drag
 *      and probabilistic overtaking.
 *   3. reactive window (Slice 3): when a trigger fires mid-lap, simulation
 *      pauses; only the affected cars may submit one reactive action. No
 *      response by timeout = no action. Outcome feeds the sim, then ticks resume.
 */
import { CONFIG } from '../config.js';
import { Track } from '../track.js';
import { carSnapshot, createCar, defaultStrategy, parseStrategy } from './car.js';
import { createRng } from '../rng.js';
import { colorForSlot } from './liveries.js';
import {
  allowedActionsFor,
  createReactiveWindow,
  detectTrigger,
  parseReactiveAction,
  reactiveWindowRemainingS,
  resolveCloseBattle,
} from './reactive.js';
import {
  isTacticEnvelope,
  planFromPlainPacket,
  recommendedProposal,
  stampProjections,
  validateTacticEnvelope,
} from './tactics.js';
import { juniorTeamPlan } from './strategies.js';

export const PHASES = ['setup', 'strategy_window', 'simulation', 'reactive_window', 'finished'];

export class Simulation {
  constructor({
    totalLaps = CONFIG.race.totalLaps,
    strategyWindowSeconds = CONFIG.timing.strategyWindowSeconds,
    reactiveWindowSeconds = CONFIG.timing.reactiveWindowSeconds,
    tickSeconds = CONFIG.timing.tickSeconds,
    seed = 1,
    track = new Track(),
    onEvent = null, // (eventObj) => void  — event sink for logging
    // MCPG-62: after this many window seconds without a team plan, the
    // scripted junior strategist fills in (0 disables the fallback).
    juniorFallbackSeconds = CONFIG.tactics.juniorFallbackSeconds,
    // MCPG-62: close a strategy window as soon as every active car has a
    // plan AND its driver seat is satisfied (autopilot never holds the race).
    earlyCloseStrategyWindows = CONFIG.timing.earlyCloseStrategyWindows,
  } = {}) {
    if (!Number.isInteger(totalLaps) || totalLaps < 1) throw new Error('totalLaps must be a positive integer');
    this.totalLaps = totalLaps;
    this.strategyWindowSeconds = strategyWindowSeconds;
    this.reactiveWindowSeconds = reactiveWindowSeconds;
    this.tickSeconds = tickSeconds;
    this.track = track;
    this.rng = createRng(seed);
    this.onEvent = onEvent ?? (() => {});

    this.phase = 'setup';
    this.raceTimeS = 0; // simulated race time
    this.juniorFallbackSeconds = juniorFallbackSeconds;
    this.earlyCloseStrategyWindows = earlyCloseStrategyWindows;
    this.cars = [];
    this.windowOpensAtMs = 0;
    this._juniorFallbackDone = false; // once per window
    // Separate RNG stream for the junior strategist: its draws must not
    // perturb the race rng's overtake sequence (and vice versa).
    this.juniorRng = createRng((seed * 1013 + 7) >>> 0);
    this._overdueCooldowns = new Map(); // `${behindId}|${aheadId}` -> last attempt raceTime
    this._results = []; // finished/retired order

    this.reactiveWindow = null; // active reactive window, or null
    this._nextReactiveId = 1;
    this._tireAlerted = new Set(); // carIds that already got critical_tire_wear this stint
    this._pitAlertedThisLap = new Set(); // carIds offered pit_opportunity this lap
    this._reactiveWindowsThisLap = 0;
  }

  // ---------------------------------------------------------------- agents

  /**
   * Join rule (MCPG-58): identity is keyed by the MCP session id
   * (`agentId`), the display name is cosmetic.
   *   - Same session re-joining → same car (true idempotent rejoin).
   *   - Name already taken by a DIFFERENT session → a new car is created and
   *     the display name gets a visible auto-suffix ("name#2", "#3", ...).
   * One `agent_joined` event is emitted per join attempt, so joins (and
   * collisions) are greppable in the decision log.
   */
  addAgent(name, agentId) {
    if (!agentId) throw new Error('addAgent requires an agentId (the MCP session id)');
    if (this.phase !== 'setup') {
      throw new Error(`race already in phase '${this.phase}'; joining is closed`);
    }
    const own = this.cars.find((c) => c.agentId === agentId);
    if (own) {
      this._emit('agent_joined', {
        carId: own.id,
        name: own.name,
        color: own.color,
        position: this.cars.indexOf(own) + 1,
        agentId,
        requestedName: name,
        suffixApplied: false,
        rejoined: true,
      });
      return own;
    }
    if (this.cars.length >= CONFIG.race.maxAgents) {
      throw new Error(`race is full (max ${CONFIG.race.maxAgents} agents)`);
    }
    const finalName = this._freeName(name);
    const suffixApplied = finalName !== name;
    // First joiner takes P1: the grid is staggered so that join order
    // equals grid position (later joiners start further behind on track).
    const distTraveled = (CONFIG.race.maxAgents + 1 - this.cars.length) * CONFIG.grid.formationGapM;
    const car = createCar({ name: finalName, agentId, distTraveled, color: colorForSlot(this.cars.length) });
    // Sector/lap timing state (MCPG-31). Lap 1 starts at race start (sim
    // time 0) from the car's grid position; its first "sector 1" split runs
    // from the grid to the first sector line (standard "splits start from
    // the grid" behavior).
    car.currentSector = this.track.sectorForPosition(car.position);
    car.currentSectorTimesS = new Array(this.track.sectorCount).fill(null);
    car.bestSectorTimesS = new Array(this.track.sectorCount).fill(null);
    car.lapStartDist = car.distTraveled;
    car.lapStartTimeS = 0;
    car.sectorStartDist = Math.floor(car.distTraveled / this.track.sectorLengthM) * this.track.sectorLengthM;
    car.sectorStartTimeS = 0;
    this.cars.push(car);
    // Grid slot = 1-based join order (index of the just-pushed car + 1).
    this._emit('agent_joined', {
      carId: car.id,
      name: finalName,
      color: car.color,
      position: this.cars.indexOf(car) + 1,
      agentId,
      requestedName: name,
      suffixApplied,
      rejoined: false,
    });
    return car;
  }

  /** First display name derived from `name` that no car uses yet. */
  _freeName(name) {
    if (!this.cars.some((c) => c.name === name)) return name;
    for (let n = 2; ; n += 1) {
      const candidate = `${name}#${n}`;
      if (!this.cars.some((c) => c.name === candidate)) return candidate;
    }
  }

  // ------------------------------------------------------------ phase flow

  start() {
    if (this.phase !== 'setup') throw new Error(`race already started (phase '${this.phase}')`);
    if (this.cars.length < CONFIG.race.minAgents) {
      throw new Error(`need at least ${CONFIG.race.minAgents} agents to start (have ${this.cars.length})`);
    }
    this._emit('race_start', { agents: this.cars.map((c) => ({ id: c.id, name: c.name })) });
    this.openStrategyWindow(1);
  }

  /** Opens the strategy window for `lapNumber` (1-based). */
  openStrategyWindow(lapNumber) {
    if (this.phase === 'finished') throw new Error('race is finished');
    if (this.phase === 'reactive_window') throw new Error('cannot open strategy window during a reactive window');
    this.phase = 'strategy_window';
    this.currentLap = lapNumber;
    this.windowOpensAtMs = Date.now();
    this._juniorFallbackDone = false;
    for (const car of this.cars) {
      car.submittedStrategy = false;
      car.teamPlan = null; // fresh window: last window's plan is gone
      // The DRIVER SEAT (claim + autopilot/manual mode) persists across
      // windows (MCPG-62); only this window's pending action is cleared.
      if (car.driverSeat) car.driverSeat.action = null;
    }
    this._pitAlertedThisLap = new Set();
    this._reactiveWindowsThisLap = 0;
    // `standings` lets the dossier (and clients) record the actual outcome
    // at each window open for the previous window's projections (MCPG-62).
    this._emit('window_opened', {
      lap: lapNumber,
      remainingS: this.strategyWindowSeconds,
      standings: this.standings().map((s) => ({
        carId: s.carId,
        name: s.name,
        position: s.position,
        gapToLeaderM: s.gapToLeaderM,
      })),
    });
  }

  /** Seconds left in the current strategy window (wall-clock based). */
  windowRemainingS() {
    if (this.phase !== 'strategy_window') return 0;
    const elapsed = (Date.now() - this.windowOpensAtMs) / 1000;
    return Math.max(0, this.strategyWindowSeconds - elapsed);
  }

  /** Test helper: pretend the window has elapsed. */
  forceCloseWindow() {
    if (this.phase === 'strategy_window') this.windowOpensAtMs = 0;
  }

  /**
   * Submit this window's plan for a car: a plain strategy packet (the
   * pre-MCPG-62 contract, unchanged) or a TACTIC ENVELOPE (radio + 1-3
   * archetype proposal cards, one recommended).
   *
   * The plan is held, not applied: at window close the car runs the
   * recommended packet unless the driver seat locked or overrode it
   * (MCPG-62 autopilot lifecycle). First valid submission wins; duplicates
   * are rejected (idempotent rule).
   * @returns {{accepted: boolean, carId?: number, error?: string, details?: string[], lap?: number, projections?: Array}}
   */
  submitPhaseStrategy(carId, raw) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    if (car.submittedStrategy) {
      return { accepted: false, error: 'duplicate_strategy', details: ['plan for this window was already submitted'] };
    }
    if (car.status === 'RETIRED' || car.status === 'FINISHED') return { accepted: false, error: 'car_retired' };

    if (isTacticEnvelope(raw)) {
      const { plan, errors } = validateTacticEnvelope(raw);
      if (errors.length) return { accepted: false, error: 'invalid_envelope', details: errors };
      plan.source = 'team';
      this._stampPlan(car, plan);
      this._emit('tactics_proposed', {
        carId: car.id,
        name: car.name,
        lap: this.currentLap,
        source: 'team',
        radio: plan.radio,
        proposals: plan.proposals,
      });
      return {
        accepted: true,
        carId: car.id,
        lap: this.currentLap,
        // The server-stamped projections, so the team sees the numbers the
        // cockpit shows (its own numbers are display-only, never simulated).
        projections: plan.proposals.map((p) => ({ key: p.key, label: p.label, recommend: p.recommend, projection: p.projection })),
      };
    }

    // Plain packet: exactly the pre-MCPG-62 behavior, normalized into the
    // single-card plan shape so snapshot/cockpit/dossier share one shape.
    const { strategy, errors } = parseStrategy(raw);
    if (errors.length) return { accepted: false, error: 'invalid_strategy', details: errors };

    const plan = planFromPlainPacket(strategy);
    plan.source = 'team';
    this._stampPlan(car, plan);
    this._emit('strategy_submitted', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      strategy: { ...strategy },
    });
    this._emit('tactics_proposed', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      source: 'team',
      radio: null,
      proposals: plan.proposals,
    });
    return { accepted: true, carId: car.id, lap: this.currentLap };
  }

  /** Normalize + projection-stamp a plan and attach it to the car. */
  _stampPlan(car, plan) {
    stampProjections(this._projectionCtx(car), plan);
    car.teamPlan = plan;
    car.submittedStrategy = true;
    // Display during the window: the recommended packet is what autopilot
    // would run; closeWindow() re-applies the actually chosen packet.
    const rec = recommendedProposal(plan);
    if (rec) car.strategy = { ...rec.packet };
    if (rec?.packet.pitNow) car.pitRequested = true;
  }

  /** Context the projection heuristics read from authoritative state. */
  _projectionCtx(car) {
    return {
      car,
      standings: this.standings(),
      totalCars: this.cars.length,
      track: this.track,
      currentLap: this.currentLap,
      totalLaps: this.totalLaps,
      lapsRemaining: Math.max(0, this.totalLaps - car.completedLaps),
    };
  }

  /**
   * Junior-strategist fallback (MCPG-62): once `juniorFallbackSeconds` of
   * the window have elapsed, every active car that has no team plan yet is
   * filled in by the scripted junior strategist, keeping autopilot
   * meaningful (and the window closable) with zero LLMs connected. One-shot
   * per window; deterministic per seed (dedicated juniorRng stream).
   * The RaceSession run-loop calls this on each poll; tests may call it
   * directly after `windowOpensAtMs` has been aged (see forceCloseWindow).
   */
  checkJuniorFallback() {
    if (this.juniorFallbackSeconds <= 0) return;
    if (this.phase !== 'strategy_window' || this._juniorFallbackDone) return;
    if ((Date.now() - this.windowOpensAtMs) / 1000 < this.juniorFallbackSeconds) return;
    this._juniorFallbackDone = true;
    for (const car of this.cars) {
      if (car.status !== 'RUNNING' && car.status !== 'PITTING') continue;
      if (car.submittedStrategy) continue;
      const plan = juniorTeamPlan(this._juniorView(car), this.juniorRng);
      plan.source = 'junior';
      this._stampPlan(car, plan);
      this._emit('tactics_proposed', {
        carId: car.id,
        name: car.name,
        lap: this.currentLap,
        source: 'junior',
        fallback: true,
        radio: plan.radio,
        proposals: plan.proposals,
      });
    }
  }

  /** buildView()-shaped facts for one car (the junior strategist's input). */
  _juniorView(car) {
    const standing = this.standings().find((s) => s.carId === car.id);
    const myGap = standing?.gapToLeaderM ?? null;
    let gapAhead = null;
    let gapBehind = null;
    if (myGap != null && standing) {
      const ahead = this.standings().find((s) => s.position === standing.position - 1);
      if (ahead) gapAhead = Math.max(0, myGap - (ahead.gapToLeaderM ?? 0));
      const behind = this.standings().find((s) => s.position === standing.position + 1);
      if (behind) gapBehind = (behind.gapToLeaderM ?? 0) - myGap;
    }
    return {
      car: {
        id: car.id,
        status: car.status,
        completedLaps: car.completedLaps,
        gapToLeaderM: myGap,
        gapToCarAheadM: gapAhead,
        gapToCarBehindM: gapBehind,
        tireWearPct: Math.round(car.tireWear * 10) / 10,
        fuelKg: Math.round(car.fuelKg * 10) / 10,
      },
      race: {
        phase: this.phase,
        currentLap: this.currentLap,
        totalLaps: this.totalLaps,
        lapsRemaining: Math.max(0, this.totalLaps - car.completedLaps),
        windowRemainingS: this.windowRemainingS(),
        position: standing?.position ?? null,
        gapToLeaderM: myGap,
      },
    };
  }

  /**
   * Release every seat held by a driver session (its WS disconnected).
   * A seat is bound to the lifetime of its driver connection: a dead
   * connection cannot hold a car in MANUAL forever, so the seat returns to
   * unclaimed (a fast reconnect re-claims it, claim-first; the autopilot
   * default is restored for any car that loses its driver mid-window).
   * @returns {number} number of seats released
   */
  releaseDriverSeats(driverSessionId) {
    let released = 0;
    for (const car of this.cars) {
      if (car.driverSeat && car.driverSeat.sessionId === driverSessionId) {
        car.driverSeat = null;
        released += 1;
        this._emit('autopilot_state', {
          carId: car.id,
          name: car.name,
          lap: this.currentLap,
          claimed: false,
          mode: 'unclaimed',
          change: 'release',
        });
      }
    }
    return released;
  }

  // ------------------------------------------------- driver seat (MCPG-62)

  /**
   * Claim the driver seat for a car (spectator WS). One driver per car,
   * claim-first; idempotent for the same driver session. The seat starts in
   * AUTOPILOT — the resting default state; tactic cards are how you
   * disengage it.
   */
  claimDriverSeat(carId, driverSessionId) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    const seat = car.driverSeat;
    if (seat) {
      if (seat.sessionId === driverSessionId) {
        return { accepted: true, idempotent: true, carId, mode: seat.mode };
      }
      return { accepted: false, error: 'seat_taken' };
    }
    car.driverSeat = { sessionId: driverSessionId, mode: 'autopilot', action: null };
    this._emit('autopilot_state', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      claimed: true,
      mode: 'autopilot',
      change: 'claim',
    });
    return { accepted: true, carId, mode: 'autopilot' };
  }

  /**
   * Lock in one of the team's proposed tactics (by key) for THIS window.
   * Counts as the car's submission; flips the seat to MANUAL for subsequent
   * windows until resumeAutopilot. Locking the recommended proposal is the
   * deliberate "trust the team" choice (mode `trusted` at close).
   */
  lockInTactic(carId, driverSessionId, proposalKey) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    const seat = car.driverSeat;
    if (!seat || seat.sessionId !== driverSessionId) {
      return { accepted: false, error: seat ? 'not_your_seat' : 'seat_not_claimed' };
    }
    if (!car.teamPlan) return { accepted: false, error: 'no_plan', details: ['no team plan posted in this window to lock'] };
    if (seat.action) return { accepted: false, error: 'already_acted', details: ['this seat already locked or overrode this window'] };
    const proposal = car.teamPlan.proposals.find((p) => p.key === proposalKey);
    if (!proposal) {
      return {
        accepted: false,
        error: 'unknown_proposal',
        details: [`proposal keys available: ${car.teamPlan.proposals.map((p) => p.key).join(', ')}`],
      };
    }
    seat.action = { kind: 'lock', proposalKey: proposal.key };
    seat.mode = 'manual';
    car.submittedStrategy = true; // the driver's choice IS the car's submission
    this._emit('driver_locked', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      proposalKey: proposal.key,
      label: proposal.label,
      trusted: proposal.recommend === true,
    });
    this._emit('autopilot_state', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      claimed: true,
      mode: 'manual',
      change: 'lock',
    });
    return { accepted: true, carId, mode: 'manual', trusted: proposal.recommend === true };
  }

  /**
   * Override with a raw strategy packet (validates like any submission).
   * Counts as the car's submission; flips the seat to MANUAL.
   */
  overrideTactic(carId, driverSessionId, packet) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    const seat = car.driverSeat;
    if (!seat || seat.sessionId !== driverSessionId) {
      return { accepted: false, error: seat ? 'not_your_seat' : 'seat_not_claimed' };
    }
    if (seat.action) return { accepted: false, error: 'already_acted', details: ['this seat already locked or overrode this window'] };
    const { strategy, errors } = parseStrategy(packet ?? {});
    if (errors.length) return { accepted: false, error: 'invalid_packet', details: errors };
    seat.action = { kind: 'override', packet: strategy };
    seat.mode = 'manual';
    car.submittedStrategy = true;
    this._emit('driver_override', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      packet: { ...strategy },
    });
    this._emit('autopilot_state', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      claimed: true,
      mode: 'manual',
      change: 'override',
    });
    return { accepted: true, carId, mode: 'manual', packet: { ...strategy } };
  }

  /**
   * Resume AUTOPILOT: the seat flips back (and, if the driver had already
   * acted this window, the pending action is withdrawn — the team's plan
   * runs this lap). Valid only while a strategy window is open.
   */
  resumeAutopilot(carId, driverSessionId) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    const seat = car.driverSeat;
    if (!seat || seat.sessionId !== driverSessionId) {
      return { accepted: false, error: seat ? 'not_your_seat' : 'seat_not_claimed' };
    }
    seat.mode = 'autopilot';
    const withdrew = seat.action != null;
    seat.action = null;
    this._emit('autopilot_state', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      claimed: true,
      mode: 'autopilot',
      change: 'resume',
      withdrew,
    });
    return { accepted: true, carId, mode: 'autopilot', withdrew };
  }

  /** Seconds left in the current reactive window (wall-clock based). */
  reactiveWindowRemainingS() {
    if (this.phase !== 'reactive_window' || !this.reactiveWindow) return 0;
    return reactiveWindowRemainingS(this.reactiveWindow);
  }

  /** Test helper: pretend the reactive window has elapsed. */
  forceCloseReactiveWindow() {
    if (this.phase === 'reactive_window' && this.reactiveWindow) {
      this.reactiveWindow.opensAtMs = 0;
    }
  }

  /**
   * Submit a reactive action for the open reactive window.
   * First valid submission per (carId, windowId) wins; duplicates rejected.
   * Cars not listed on the window are rejected. Idempotent no-op on reject.
   */
  submitReactiveAction(carId, raw) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'reactive_window' || !this.reactiveWindow) {
      return { accepted: false, error: 'no_reactive_window' };
    }
    const window = this.reactiveWindow;
    if (!window.carIds.includes(carId)) {
      return { accepted: false, error: 'car_not_in_window' };
    }
    if (window.actions.has(carId)) {
      return { accepted: false, error: 'duplicate_action', details: ['action for this window was already submitted'] };
    }
    if (car.status === 'RETIRED' || car.status === 'FINISHED') {
      return { accepted: false, error: 'car_not_active' };
    }

    const role = window.roles[carId] ?? 'subject';
    const allowed = allowedActionsFor(window.trigger, role);
    const { action, errors } = parseReactiveAction(raw, allowed);
    if (errors.length) return { accepted: false, error: 'invalid_action', details: errors };

    window.actions.set(carId, action);
    this._emit('reactive_action_submitted', {
      windowId: window.id,
      trigger: window.trigger,
      carId: car.id,
      name: car.name,
      action: { ...action },
    });
    return { accepted: true, carId: car.id, windowId: window.id, action };
  }

  /**
   * Open a reactive window from a detected trigger candidate. Pauses simulation.
   * @returns {boolean} true if a window was opened
   */
  openReactiveWindow(candidate) {
    if (this.phase !== 'simulation') return false;
    if (this.reactiveWindow) return false;
    if (this._reactiveWindowsThisLap >= CONFIG.reactive.maxWindowsPerLap) return false;

    const window = createReactiveWindow({
      id: this._nextReactiveId++,
      trigger: candidate.trigger,
      carIds: candidate.carIds,
      roles: candidate.roles,
      detail: candidate.detail,
      windowSeconds: this.reactiveWindowSeconds,
      pending: candidate.pending,
    });

    // Mark cooldowns / alert flags so the same trigger does not re-fire immediately.
    if (candidate.trigger === 'close_battle' && candidate.pending?.pairKey) {
      this._overdueCooldowns.set(candidate.pending.pairKey, this.raceTimeS);
    }
    if (candidate.trigger === 'critical_tire_wear') {
      for (const id of candidate.carIds) this._tireAlerted.add(id);
    }
    if (candidate.trigger === 'pit_opportunity') {
      for (const id of candidate.carIds) this._pitAlertedThisLap.add(id);
    }

    this.reactiveWindow = window;
    this._reactiveWindowsThisLap += 1;
    this.phase = 'reactive_window';
    this._emit('reactive_window_opened', {
      windowId: window.id,
      trigger: window.trigger,
      carIds: window.carIds,
      remainingS: window.windowSeconds,
      detail: window.detail,
      allowedByCar: Object.fromEntries(
        window.carIds.map((id) => [id, allowedActionsFor(window.trigger, window.roles[id])]),
      ),
    });
    return true;
  }

  /**
   * Close the reactive window: default missing actions to hold, apply outcome,
   * resume simulation.
   */
  closeReactiveWindow() {
    if (this.phase !== 'reactive_window' || !this.reactiveWindow) {
      throw new Error(`no reactive window open (phase '${this.phase}')`);
    }
    const window = this.reactiveWindow;

    for (const carId of window.carIds) {
      if (!window.actions.has(carId)) {
        const car = this.carById(carId);
        window.actions.set(carId, { type: 'hold' });
        this._emit('reactive_action_defaulted', {
          windowId: window.id,
          trigger: window.trigger,
          carId,
          name: car?.name ?? null,
          action: { type: 'hold' },
        });
      }
    }

    const outcome = this._applyReactiveOutcome(window);
    this._emit('reactive_window_closed', {
      windowId: window.id,
      trigger: window.trigger,
      carIds: window.carIds,
      actions: Object.fromEntries([...window.actions.entries()].map(([id, a]) => [id, a])),
      outcome,
    });

    this.reactiveWindow = null;
    this.phase = 'simulation';
    return outcome;
  }

  /**
   * Resolve the window (MCPG-62) and close it.
   *
   * Per active car the chosen packet is: the driver's pending action
   * (lock/override) if any — that choice IS the submission — otherwise the
   * team plan's recommended packet (autopilot default, whether or not a
   * driver sits in the seat). The resulting packet is what runs next lap;
   * each car's resolution is logged and carried on `window_closed.decisions`
   * for the dossier and the cockpit DEBRIEF strip.
   */
  closeWindow() {
    if (this.phase !== 'strategy_window') throw new Error(`no window open (phase '${this.phase}')`);
    const decisions = [];
    for (const car of this.cars) {
      if (car.status === 'RETIRED' || car.status === 'FINISHED') continue;
      const seat = car.driverSeat;
      const action = seat ? seat.action : null;
      if (seat) seat.action = null; // consumed: next window starts clean

      let mode = null;
      let source = null;
      let key = null;
      let label = null;
      let packet = null;
      let projection = null;

      if (action?.kind === 'lock') {
        const proposal = car.teamPlan?.proposals.find((p) => p.key === action.proposalKey) ?? null;
        if (proposal) {
          packet = { ...proposal.packet };
          key = proposal.key;
          label = proposal.label;
          projection = proposal.projection ?? null;
          source = 'driver_lock';
          // Deliberate trust (recommended) vs a hand-picked alternative.
          mode = proposal.recommend === true ? 'trusted' : 'overridden';
        }
      } else if (action?.kind === 'override') {
        packet = { ...action.packet };
        label = 'DRIVER OVERRIDE';
        projection = this._projectionFor(car, packet);
        source = 'driver_override';
        mode = 'overridden';
      }

      if (!packet && car.teamPlan) {
        const rec = recommendedProposal(car.teamPlan);
        packet = { ...(rec?.packet ?? car.teamPlan.proposals[0]?.packet ?? defaultStrategy()) };
        key = rec?.key ?? null;
        label = rec?.label ?? null;
        projection = rec?.projection ?? null;
        source = car.teamPlan.source; // 'team' | 'junior'
        // No driver action: the seat state decides the mode. Unclaimed seats
        // and autopilot seats are the auto_trusted path.
        mode = !seat || seat.mode === 'autopilot' ? 'autopilot' : 'manual';
      }

      if (packet) {
        car.strategy = packet;
        car.submittedStrategy = true;
        // Pit request is consumed on the first tick of the next sim phase.
        car.pitRequested = packet.pitNow;
        if (mode === 'autopilot') {
          this._emit('auto_trusted', {
            carId: car.id,
            name: car.name,
            lap: this.currentLap,
            source,
            key,
            label,
            projection,
            seat: seat ? seat.mode : 'unclaimed',
          });
        } else {
          this._emit('strategy_resolved', {
            carId: car.id,
            name: car.name,
            lap: this.currentLap,
            mode,
            source,
            key,
            label,
            strategy: { ...packet },
            projection,
          });
        }
      } else {
        // No plan, no driver action (fallback disabled + no team), or the
        // degenerate lock-without-plan case: pre-MCPG-62 default behavior.
        if (!car.submittedStrategy) {
          this._emit('strategy_defaulted', {
            carId: car.id,
            name: car.name,
            lap: this.currentLap,
            strategy: { ...car.strategy },
          });
        }
        mode = mode ?? 'default';
        source = source ?? 'default';
      }

      decisions.push({
        carId: car.id,
        name: car.name,
        mode,
        source,
        key,
        label,
        packet: packet ? { ...packet } : null,
        projection,
      });
    }
    this.phase = 'simulation';
    this._emit('window_closed', {
      lap: this.currentLap,
      submitted: this.cars.filter((c) => c.submittedStrategy).map((c) => c.name),
      defaulted: this.cars.filter((c) => !c.submittedStrategy).map((c) => c.name),
      decisions,
    });
  }

  /** Projection for an arbitrary (driver) packet, using the shared heuristics. */
  _projectionFor(car, packet) {
    const plan = { radio: null, source: 'driver', proposals: [{ key: null, label: '', narrative: '', packet, recommend: true, confidence: null }] };
    stampProjections(this._projectionCtx(car), plan);
    return plan.proposals[0].projection ?? null;
  }

  /**
   * MCPG-62 early close: every active car has a plan (team or junior)
   * — or a driver override standing in for one — AND its seat is satisfied:
   * unclaimed, autopilot, or already locked/overridden this window. An
   * autopilot or unclaimed seat never holds the race to the full countdown;
   * a MANUAL seat that has not acted yet must (the driver may still reach in).
   */
  canEarlyClose() {
    if (!this.earlyCloseStrategyWindows) return false;
    if (this.phase !== 'strategy_window') return false;
    return this.cars.every((car) => {
      if (car.status === 'RETIRED' || car.status === 'FINISHED') return true;
      const seat = car.driverSeat;
      const planReady = car.teamPlan != null || seat?.action?.kind === 'override';
      if (!planReady) return false;
      if (!seat || seat.mode === 'autopilot') return true;
      return seat.action != null;
    });
  }

  // --------------------------------------------------------------- ticking

  /**
   * Advance the simulation by one tick. Only valid in phase 'simulation'.
   * Returns the tick summary {overtakes, laps, finishes}.
   *
   * (MCPG-31) Sector/lap timing advances inside the move loop via
   * _advanceTiming(): a boundary crossed mid-tick is interpolated to its
   * exact sim time, because a car moves at constant speed during the tick.
   */
  tick() {
    if (this.phase !== 'simulation') throw new Error(`cannot tick in phase '${this.phase}'`);
    const dt = this.tickSeconds;
    const overtakeEvents = [];

    // 1) pit stops: countdown first (pitting cars do not move)
    for (const car of this.cars) {
      if (car.status === 'PITTING') {
        car.pitTimeLeftS -= dt;
        if (car.pitTimeLeftS <= 0) {
          car.status = 'RUNNING';
          car.pitTimeLeftS = 0;
          car.tireWear = 0;
          car.fuelKg = CONFIG.fuel.startKg;
          this._tireAlerted.delete(car.id); // fresh stint → critical wear can fire again
          this._emit('pit_stop_complete', { carId: car.id, name: car.name });
        }
      } else if (car.status === 'RUNNING' && car.pitRequested && this.currentLap < this.totalLaps) {
        // enter the pit lane at the first tick of the lap
        car.status = 'PITTING';
        car.pitRequested = false;
        car.pitTimeLeftS = CONFIG.pit.stopSeconds;
        car.speedMs = 0;
        this._emit('pit_stop_enter', { carId: car.id, name: car.name, lap: this.currentLap });
      }
    }

    // 2) speeds for moving cars
    const running = this.cars.filter((c) => c.status === 'RUNNING');
    running.sort((a, b) => b.distTraveled - a.distTraveled); // P1 first
    const tireGrip = (c) => 1 - CONFIG.physics.tireGripDrop * (c.tireWear / 100);
    for (let i = 0; i < running.length; i++) {
      const car = running[i];
      let speed = CONFIG.physics.baseSpeedMs * CONFIG.physics.paceMultipliers[car.strategy.pace] * tireGrip(car);
      const ahead = running[i - 1];
      if (ahead) {
        const gap = ahead.distTraveled - car.distTraveled;
        if (gap < CONFIG.physics.trafficDragDistanceM) {
          speed *= CONFIG.physics.trafficDragFactor; // traffic drag
        }
      }
      car.speedMs = speed;
    }

    // 3) move. t0..t0+dt is the sim-time span of this tick; the timing code
    // interpolates any sector/line crossing to the exact sim time it happened.
    const t0 = this.raceTimeS;
    let lapEvents = 0;
    for (const car of running) {
      const oldDist = car.distTraveled;
      car.distTraveled += car.speedMs * dt;
      this._advanceTiming(car, oldDist, car.distTraveled, t0, t0 + dt);
      const laps = this.track.lapsCompleted(car.distTraveled);
      if (laps > car.completedLaps) {
        this._onLapComplete(car, laps);
        lapEvents += laps - car.completedLaps;
        car.completedLaps = laps;
      }
      car.position = this.track.lapPosition(car.distTraveled);
    }

    // 4) triggers → reactive windows. Close battles replace the immediate
    //    overtake roll; tire/pit triggers open a window for the affected car.
    //    At most one window opens per tick; the race pauses until it closes.
    const candidate = detectTrigger({
      running,
      raceTimeS: this.raceTimeS,
      tickSeconds: this.tickSeconds,
      overtakeCooldowns: this._overdueCooldowns,
      tireAlerted: this._tireAlerted,
      pitAlertedThisLap: this._pitAlertedThisLap,
      currentLap: this.currentLap,
      totalLaps: this.totalLaps,
    });
    if (candidate && this.openReactiveWindow(candidate)) {
      // Clock still advances for this tick (movement already applied); the
      // RaceSession will wait out the reactive window before the next tick.
      this.raceTimeS += dt;
      return { overtakes: overtakeEvents, laps: lapEvents, finishes: 0, reactiveOpened: true };
    }

    // 5) clock, lap transition + end conditions.
    //    Hybrid loop: as soon as every active car has crossed the line, the
    //    race pauses and the next lap's strategy window opens (the spec's
    //    strategy-window-then-simulate-lap rhythm).
    this.raceTimeS += dt;
    const active = this.cars.filter((c) => c.status === 'RUNNING' || c.status === 'PITTING');
    if (active.length === 0) {
      this.phase = 'finished';
      this._emit('race_finished', { timeS: this.raceTimeS, standings: this.standings() });
    } else if (this.currentLap < this.totalLaps && active.every((c) => c.completedLaps >= this.currentLap)) {
      this.openStrategyWindow(this.currentLap + 1);
    }

    return { overtakes: overtakeEvents, laps: lapEvents, finishes: 0 };
  }

  /**
   * Apply the outcome of a closed reactive window to race state.
   * close_battle → resolve the pending overtake; tire/pit → optional pit request.
   */
  _applyReactiveOutcome(window) {
    if (window.trigger === 'close_battle' && window.pending) {
      const pending = window.pending;
      const result = resolveCloseBattle(pending, window.actions, this.rng);
      const behind = this.carById(pending.behindId);
      const ahead = this.carById(pending.aheadId);
      if (result.success && behind && ahead && behind.status === 'RUNNING' && ahead.status === 'RUNNING') {
        const oldDist = behind.distTraveled;
        behind.distTraveled = ahead.distTraveled + 1;
        // Same timing code path as the tick's move (MCPG-31); the jump is
        // instantaneous in sim time, so t0 === t1.
        this._advanceTiming(behind, oldDist, behind.distTraveled, this.raceTimeS, this.raceTimeS);
        behind.position = this.track.lapPosition(behind.distTraveled);
        this._emit('overtake', {
          carId: behind.id,
          name: behind.name,
          overTakenCarId: ahead.id,
          overTakenName: ahead.name,
          probability: result.probability,
          via: 'reactive',
          windowId: window.id,
        });
      } else {
        this._emit('overtake_failed', {
          carId: behind?.id ?? pending.behindId,
          name: behind?.name ?? null,
          defendedByCarId: ahead?.id ?? pending.aheadId,
          defendedByName: ahead?.name ?? null,
          probability: result.probability,
          via: 'reactive',
          windowId: window.id,
        });
      }
      return {
        type: 'close_battle',
        success: result.success,
        probability: result.probability,
        behindAction: result.behindAction,
        aheadAction: result.aheadAction,
      };
    }

    // critical_tire_wear / pit_opportunity: pit_now sets the pit flag for the next tick.
    const pitCars = [];
    for (const carId of window.carIds) {
      const action = window.actions.get(carId);
      if (action?.type === 'pit_now') {
        const car = this.carById(carId);
        if (car && car.status === 'RUNNING' && this.currentLap < this.totalLaps) {
          car.pitRequested = true;
          pitCars.push(carId);
        }
      }
    }
    return { type: window.trigger, pitRequestedCarIds: pitCars };
  }

  /**
   * Server-authoritative sector + lap timing (MCPG-31).
   *
   * Called from the tick's move loop (t0..t1 = the tick's sim-time span) and
   * from the reactive overtake jump (t0 === t1: instantaneous). A car moves
   * at constant speed within a tick, so a boundary crossed mid-tick is
   * interpolated to its exact sim time: time(d) = t0 + (d - oldDist) /
   * (newDist - oldDist) * (t1 - t0). Pure sim time — no wall clock — so the
   * deterministic-replay invariant holds.
   *
   * Sector boundaries sit at every multiple of sectorLengthM in total
   * distance. Because lengthM is a multiple of sectorLengthM (enforced by
   * the Track constructor), line crossings are a subset of those: crossing
   * a multiple of lengthM also completes the lap.
   *
   * PITTING cars never reach this method (0 m moved), so pit-stop time is
   * naturally included in the next sector/lap time. RETIRED cars keep
   * whatever timing they had — it is never wiped.
   */
  _advanceTiming(car, oldDist, newDist, t0, t1) {
    if (newDist <= oldDist) return; // no move — nothing crossed
    const { sectorLengthM, sectorCount } = this.track;
    const span = newDist - oldDist;
    const timeAt = (d) => t0 + ((d - oldDist) / span) * (t1 - t0);

    let k = Math.floor(oldDist / sectorLengthM) + 1; // boundary index: b = k * sectorLengthM
    while (k * sectorLengthM <= newDist) {
      const b = k * sectorLengthM;
      // Boundary b = k*SL ends 0-based sector (k-1) % sectorCount.
      const crossedIdx = (k - 1) % sectorCount;
      const sectorTimeS = timeAt(b) - car.sectorStartTimeS;
      car.currentSectorTimesS[crossedIdx] = sectorTimeS;
      if (car.bestSectorTimesS[crossedIdx] == null || sectorTimeS < car.bestSectorTimesS[crossedIdx]) {
        car.bestSectorTimesS[crossedIdx] = sectorTimeS;
      }
      // The car enters 0-based sector k % sectorCount (b = k*SL is its start).
      car.currentSector = (k % sectorCount) + 1;
      car.sectorStartDist = b;
      car.sectorStartTimeS = timeAt(b);

      // k % sectorCount === 0  <=>  b % lengthM === 0, i.e. the finish line
      // (integer modulo, avoiding float-modulo pitfalls).
      if (k % sectorCount === 0) {
        const lapTimeS = timeAt(b) - car.lapStartTimeS;
        car.lastLapTimeS = lapTimeS;
        if (car.bestLapTimeS == null || lapTimeS < car.bestLapTimeS) car.bestLapTimeS = lapTimeS;
        car.lapStartDist = b;
        car.lapStartTimeS = timeAt(b);
        car.currentSectorTimesS = new Array(sectorCount).fill(null);
        car.currentSector = 1;
        car.sectorStartDist = b;
        car.sectorStartTimeS = timeAt(b);
      }
      k += 1;
    }
  }

  _onLapComplete(car, laps) {
    const t = CONFIG.tires;
    const wear =
      t.wearPerLapBase * t.paceWearFactors[car.strategy.pace] * t.strategyWearFactors[car.strategy.tireManagement];
    car.tireWear = Math.min(100, car.tireWear + wear);
    car.fuelKg -= CONFIG.fuel.perLapNormalKg * CONFIG.fuel.paceFactors[car.strategy.pace];

    this._emit('lap_complete', {
      carId: car.id,
      name: car.name,
      lap: laps,
      tireWearPct: Math.round(car.tireWear * 10) / 10,
      fuelKg: Math.round(car.fuelKg * 10) / 10,
      // Server-timed lap (MCPG-31) so the decision log has timing without
      // replaying the sim. null until the first line crossing.
      lapTimeS: car.lastLapTimeS == null ? null : Math.round(car.lastLapTimeS * 100) / 100,
      bestLapTimeS: car.bestLapTimeS == null ? null : Math.round(car.bestLapTimeS * 100) / 100,
    });

    if (laps >= this.totalLaps) {
      car.status = 'FINISHED';
      car.finishTimeS = this.raceTimeS;
      car.speedMs = 0;
      this._emit('finish', { carId: car.id, name: car.name, timeS: this.raceTimeS });
      return;
    }

    if (car.fuelKg < -0.001) {
      car.status = 'RETIRED';
      car.speedMs = 0;
      this._emit('retired', { carId: car.id, name: car.name, reason: 'out_of_fuel' });
    }
  }

  // ---------------------------------------------------------------- views

  carById(id) {
    return this.cars.find((c) => c.id === id) ?? null;
  }

  /**
   * Public snapshot of the whole race, suitable for MCP responses.
   * @returns {object}
   */
  state() {
    const standings = this.standings();
    const leader = standings[0] ? this.carById(standings[0].carId) : null;
    const cars = this.cars.map((c) => {
      const snap = carSnapshot(c);
      snap.gapToLeaderM = leader && leader.id !== c.id ? this._gapToLeaderM(c, leader) : null;
      return snap;
    });
    return {
      phase: this.phase,
      currentLap: this.phase === 'setup' ? 0 : this.currentLap,
      totalLaps: this.totalLaps,
      minAgents: CONFIG.race.minAgents,
      maxAgents: CONFIG.race.maxAgents,
      raceTimeS: Math.round(this.raceTimeS * 100) / 100,
      strategyWindowSeconds: this.strategyWindowSeconds,
      windowRemainingS: Math.round(this.windowRemainingS() * 100) / 100,
      reactiveWindowSeconds: this.reactiveWindowSeconds,
      reactiveWindow: this._reactiveWindowView(),
      track: this.track.info(),
      cars,
      standings,
      // MCPG-62 driver-seat + tactic-plan views (reconnect-safe: a driver
      // (re)connecting reads the whole cockpit state from one snapshot).
      driverSeats: Object.fromEntries(
        this.cars.map((c) => [
          c.id,
          {
            claimed: c.driverSeat != null,
            mode: c.driverSeat ? c.driverSeat.mode : 'unclaimed',
            actionKind: c.driverSeat?.action?.kind ?? null,
          },
        ]),
      ),
      tactics: this.phase === 'strategy_window'
        ? Object.fromEntries(
            this.cars
              .filter((c) => c.teamPlan)
              .map((c) => [
                c.id,
                {
                  lap: this.currentLap,
                  source: c.teamPlan.source,
                  radio: c.teamPlan.radio,
                  proposals: c.teamPlan.proposals,
                },
              ]),
          )
        : null,
    };
  }

  /** Public view of the open reactive window (null when none). */
  _reactiveWindowView() {
    if (this.phase !== 'reactive_window' || !this.reactiveWindow) return null;
    const w = this.reactiveWindow;
    return {
      id: w.id,
      trigger: w.trigger,
      carIds: [...w.carIds],
      roles: { ...w.roles },
      detail: { ...w.detail },
      remainingS: Math.round(reactiveWindowRemainingS(w) * 100) / 100,
      submittedCarIds: [...w.actions.keys()],
      allowedByCar: Object.fromEntries(
        w.carIds.map((id) => [id, allowedActionsFor(w.trigger, w.roles[id])]),
      ),
    };
  }

  /**
   * Race standings. Finished cars first (by finish time), then running cars
   * by distance, then retired cars (by distance).
   */
  standings() {
    const done = this.cars
      .filter((c) => c.status === 'FINISHED')
      .sort((a, b) => a.finishTimeS - b.finishTimeS);
    const moving = this.cars
      .filter((c) => c.status === 'RUNNING' || c.status === 'PITTING')
      .sort((a, b) => b.distTraveled - a.distTraveled);
    const out = this.cars.filter((c) => c.status === 'RETIRED').sort((a, b) => b.distTraveled - a.distTraveled);
    const leader = done[0] ?? moving[0] ?? null;
    let position = 0;
    return [...done, ...moving, ...out].map((c) => {
      position += 1;
      return {
        position,
        carId: c.id,
        name: c.name,
        color: c.color,
        status: c.status,
        completedLaps: c.completedLaps,
        gapToLeaderM: leader && c.id === leader.id ? 0 : this._gapToLeaderM(c, leader),
        finishTimeS: c.finishTimeS,
      };
    });
  }

  /**
   * Gap to the leader in meters. Live cars: track distance. Finished cars:
   * the finish-time delta projected at base speed (documented approximation
   * — the sim has no physical position after the line).
   */
  _gapToLeaderM(car, leader) {
    if (!leader) return 0;
    if (car.status === 'FINISHED' && leader.status === 'FINISHED') {
      return Math.round((car.finishTimeS - leader.finishTimeS) * CONFIG.physics.baseSpeedMs * 100) / 100;
    }
    if (car.status === 'RETIRED') return 0;
    return Math.max(0, Math.round((leader.distTraveled - car.distTraveled) * 100) / 100);
  }

  _emit(type, data) {
    this.onEvent({ type, ...data, t: Math.round(this.raceTimeS * 100) / 100, phase: this.phase });
  }
}
