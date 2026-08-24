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
import {
  allowedActionsFor,
  createReactiveWindow,
  detectTrigger,
  parseReactiveAction,
  reactiveWindowRemainingS,
  resolveCloseBattle,
} from './reactive.js';

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
    this.cars = [];
    this.windowOpensAtMs = 0;
    this._overdueCooldowns = new Map(); // `${behindId}|${aheadId}` -> last attempt raceTime
    this._results = []; // finished/retired order

    this.reactiveWindow = null; // active reactive window, or null
    this._nextReactiveId = 1;
    this._tireAlerted = new Set(); // carIds that already got critical_tire_wear this stint
    this._pitAlertedThisLap = new Set(); // carIds offered pit_opportunity this lap
    this._reactiveWindowsThisLap = 0;
  }

  // ---------------------------------------------------------------- agents

  /** Idempotent join: same name re-joins the same car. */
  addAgent(name, agentId) {
    if (this.phase !== 'setup') {
      throw new Error(`race already in phase '${this.phase}'; joining is closed`);
    }
    const existing = this.cars.find((c) => c.name === name);
    if (existing) return existing;
    if (this.cars.length >= CONFIG.race.maxAgents) {
      throw new Error(`race is full (max ${CONFIG.race.maxAgents} agents)`);
    }
    // First joiner takes P1: the grid is staggered so that join order
    // equals grid position (later joiners start further behind on track).
    const distTraveled = (CONFIG.race.maxAgents + 1 - this.cars.length) * CONFIG.grid.formationGapM;
    const car = createCar({ name, agentId, distTraveled });
    this.cars.push(car);
    this._emit('agent_joined', { carId: car.id, name, position: this.cars.length + 1 });
    return car;
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
    for (const car of this.cars) car.submittedStrategy = false;
    this._pitAlertedThisLap = new Set();
    this._reactiveWindowsThisLap = 0;
    this._emit('window_opened', {
      lap: lapNumber,
      remainingS: this.strategyWindowSeconds,
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
   * Apply a strategy packet for the current window.
   * First valid submission wins; duplicates are rejected (idempotent rule).
   * @returns {{accepted: boolean, carId?: number, error?: string, details?: string[]}}
   */
  submitPhaseStrategy(carId, raw) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    if (this.phase !== 'strategy_window') {
      return { accepted: false, error: `not_in_window (phase: ${this.phase})` };
    }
    if (car.submittedStrategy) {
      return { accepted: false, error: 'duplicate_strategy', details: ['strategy for this window was already submitted'] };
    }
    if (car.status === 'RETIRED') return { accepted: false, error: 'car_retired' };

    const { strategy, errors } = parseStrategy(raw);
    if (errors.length) return { accepted: false, error: 'invalid_strategy', details: errors };

    car.strategy = strategy;
    car.submittedStrategy = true;
    // Pit request is consumed on the first tick of the next sim phase.
    car.pitRequested = strategy.pitNow;
    this._emit('strategy_submitted', {
      carId: car.id,
      name: car.name,
      lap: this.currentLap,
      strategy: { ...strategy },
    });
    return { accepted: true, carId: car.id };
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

  /** Called when the strategy window times out: cars without a submission
   *  keep their previous strategy (or the default for lap 1). */
  closeWindow() {
    if (this.phase !== 'strategy_window') throw new Error(`no window open (phase '${this.phase}')`);
    for (const car of this.cars) {
      if (!car.submittedStrategy && car.status !== 'RETIRED') {
        this._emit('strategy_defaulted', {
          carId: car.id,
          name: car.name,
          lap: this.currentLap,
          strategy: { ...car.strategy },
        });
      }
    }
    this.phase = 'simulation';
    this._emit('window_closed', {
      lap: this.currentLap,
      submitted: this.cars.filter((c) => c.submittedStrategy).map((c) => c.name),
      defaulted: this.cars.filter((c) => !c.submittedStrategy).map((c) => c.name),
    });
  }

  // --------------------------------------------------------------- ticking

  /**
   * Advance the simulation by one tick. Only valid in phase 'simulation'.
   * Returns the tick summary {overtakes, laps, finishes}.
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

    // 3) move
    let lapEvents = 0;
    for (const car of running) {
      car.distTraveled += car.speedMs * dt;
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
        behind.distTraveled = ahead.distTraveled + 1;
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
