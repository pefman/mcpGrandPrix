/**
 * The race simulation. 100% deterministic given a seed and a sequence of
 * inputs (strategies, ticks). No wall clock, no I/O — the RaceSession and
 * the HTTP layer own time and logging.
 *
 * Loop per lap:
 *   1. strategy window: each car may submit exactly one strategy packet
 *      (first submission wins; later ones are rejected as duplicates).
 *   2. simulation: the server ticks the lap forward until every running car
 *      has crossed the line, applying pace, tire wear, fuel, traffic drag
 *      and probabilistic overtaking.
 */
import { CONFIG } from '../config.js';
import { Track } from '../track.js';
import { carSnapshot, createCar, defaultStrategy, parseStrategy } from './car.js';
import { createRng } from '../rng.js';

export const PHASES = ['setup', 'strategy_window', 'simulation', 'finished'];

export class Simulation {
  constructor({
    totalLaps = CONFIG.race.totalLaps,
    strategyWindowSeconds = CONFIG.timing.strategyWindowSeconds,
    tickSeconds = CONFIG.timing.tickSeconds,
    seed = 1,
    track = new Track(),
    onEvent = null, // (eventObj) => void  — event sink for logging
  } = {}) {
    if (!Number.isInteger(totalLaps) || totalLaps < 1) throw new Error('totalLaps must be a positive integer');
    this.totalLaps = totalLaps;
    this.strategyWindowSeconds = strategyWindowSeconds;
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
    this.phase = 'strategy_window';
    this.currentLap = lapNumber;
    this.windowOpensAtMs = Date.now();
    for (const car of this.cars) car.submittedStrategy = false;
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

  /**
   * Reactive window actions (close battles, weather, safety car, critical
   * tire wear, pit opportunities). Slice 1: reactive windows are not yet
   * implemented — every submission is rejected cleanly so agents can call
   * the tool safely (idempotent no-op).
   */
  submitReactiveAction(carId, _action) {
    const car = this.carById(carId);
    if (!car) return { accepted: false, error: 'unknown_car' };
    return { accepted: false, error: 'reactive_windows_not_yet_available' };
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

    // 4) overtaking (only among running, non-pitting cars)
    for (let i = 0; i + 1 < running.length; i++) {
      const ahead = running[i];
      const behind = running[i + 1];
      if (ahead.status !== 'RUNNING' || behind.status !== 'RUNNING') continue;
      const gap = ahead.distTraveled - behind.distTraveled;
      if (gap > CONFIG.overtaking.opportunityDistanceM) continue;

      const key = `${behind.id}|${ahead.id}`;
      const lastAttempt = this._overdueCooldowns.get(key) ?? -Infinity;
      if (this.raceTimeS - lastAttempt < CONFIG.overtaking.cooldownTicks * this.tickSeconds) continue;
      if (behind.speedMs <= ahead.speedMs) continue;

      this._overdueCooldowns.set(key, this.raceTimeS);
      const dv = behind.speedMs - ahead.speedMs;
      let p =
        CONFIG.overtaking.baseProbability +
        CONFIG.overtaking.speedDeltaCoefficient * (dv / ahead.speedMs) +
        CONFIG.overtaking.attackBonus * behind.strategy.aggression -
        CONFIG.overtaking.defendPenalty * ahead.strategy.defend;
      p = Math.min(CONFIG.overtaking.maxProbability, Math.max(CONFIG.overtaking.minProbability, p));

      if (this.rng.chance(p)) {
        // overtake succeeds: behind jumps 1 m ahead of the car passed
        behind.distTraveled = ahead.distTraveled + 1;
        behind.position = this.track.lapPosition(behind.distTraveled);
        this._emit('overtake', {
          carId: behind.id,
          name: behind.name,
          overTakenCarId: ahead.id,
          overTakenName: ahead.name,
          probability: Math.round(p * 1000) / 1000,
        });
        overtakeEvents.push({ by: behind.name, on: ahead.name });
      }
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
      track: this.track.info(),
      cars,
      standings,
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
