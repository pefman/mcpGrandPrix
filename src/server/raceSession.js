/**
 * RaceSession: the glue between the pure Simulation and real time.
 *
 * - Owns the DecisionLogger and forwards every simulation event to it.
 * - Runs the hybrid loop: strategy window (wall clock) -> simulation ticks
 *   (wall-clock paced so multiple agents can act while a lap is "running")
 *   -> reactive windows (wall clock, affected cars only) when triggers fire.
 * - Auto-starts the race once at least minAgents have joined.
 *
 * Tests can pass `strategyWindowSeconds: 0` / `reactiveWindowSeconds: 0` and
 * a fast `delayFn` to run a full race as fast as the event loop allows.
 */
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { DecisionLogger } from '../logging/decisionLogger.js';
import { Simulation } from '../sim/simulation.js';
import { Track } from '../track.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RaceSession {
  constructor({
    totalLaps,
    strategyWindowSeconds = CONFIG.timing.strategyWindowSeconds,
    reactiveWindowSeconds = CONFIG.timing.reactiveWindowSeconds,
    tickSeconds = CONFIG.timing.tickSeconds,
    tickWallDelayMs = CONFIG.timing.tickWallDelayMs,
    seed = 1,
    track = null, // optional Track instance (MCGP-27 track registry); defaults to the built-in ring
    logFile = null,
    logToStdout = true,
    delayFn = sleep,
  } = {}) {
    this.logger = new DecisionLogger({ file: logFile, stdout: logToStdout });
    this.raceId = randomUUID(); // identifies this server instance's race (GET /healthz)
    this.tickWallDelayMs = tickWallDelayMs;
    this.delayFn = delayFn;
    this.sim = new Simulation({
      totalLaps,
      strategyWindowSeconds,
      reactiveWindowSeconds,
      tickSeconds,
      seed,
      track: track ?? new Track(),
      onEvent: (event) => this.logger.log(event),
    });
    this._running = false;
  }

  addAgent(name, agentId) {
    return this.sim.addAgent(name, agentId);
  }

  /** Start the race (requires >= minAgents). Opens the first strategy window. */
  start() {
    this.sim.start();
  }

  /** Close the open strategy window and start simulating the lap. */
  closeWindow() {
    this.sim.closeWindow();
  }

  /** Close the open reactive window and resume simulation. */
  closeReactiveWindow() {
    return this.sim.closeReactiveWindow();
  }

  /** Advance the simulation by one tick (no-op outside the simulation phase). */
  tickOnce() {
    if (this.sim.phase === 'simulation') return this.sim.tick();
    return null;
  }

  state() {
    return this.sim.state();
  }

  carView(carId) {
    const car = this.sim.carById(carId);
    if (!car) return null;
    const standings = this.sim.standings();
    const entry = standings.find((s) => s.carId === carId);
    const view = this.sim.state().cars.find((c) => c.id === carId);
    return { ...view, position: entry ? entry.position : null };
  }

  standings() {
    return this.sim.standings();
  }

  submitPhaseStrategy(carId, strategy) {
    return this.sim.submitPhaseStrategy(carId, strategy);
  }

  submitReactiveAction(carId, action) {
    return this.sim.submitReactiveAction(carId, action);
  }

  /** Main race loop. Resolves when the race finishes (or is closed). */
  async run() {
    if (this._running) return;
    this._running = true;
    this.logger.log({ type: 'session_started', totalLaps: this.sim.totalLaps });
    try {
      while (true) {
        if (this.sim.phase === 'setup') {
          if (this.sim.cars.length >= CONFIG.race.minAgents) {
            this.start();
          } else {
            await this.delayFn(100);
          }
        } else if (this.sim.phase === 'strategy_window') {
          if (this.sim.windowRemainingS() <= 0) {
            this.closeWindow();
          } else {
            await this.delayFn(25);
          }
        } else if (this.sim.phase === 'reactive_window') {
          if (this.sim.reactiveWindowRemainingS() <= 0) {
            this.closeReactiveWindow();
          } else {
            await this.delayFn(25);
          }
        } else if (this.sim.phase === 'simulation') {
          this.tickOnce();
          await this.delayFn(this.tickWallDelayMs);
        } else {
          break; // finished
        }
        if (!this._running) break;
      }
    } finally {
      this._running = false;
      this.logger.log({ type: 'session_finished' });
    }
  }

  close() {
    this._running = false;
    this.logger.close();
  }
}
