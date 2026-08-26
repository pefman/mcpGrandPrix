/**
 * RaceSession: the glue between the pure Simulation and real time.
 *
 * - Owns the DecisionLogger and forwards every simulation event to it.
 * - Runs the hybrid loop: strategy window (wall clock) -> simulation ticks
 *   (wall-clock paced so multiple agents can act while a lap is "running")
 *   -> reactive windows (wall clock, affected cars only) when triggers fire.
 * - Auto-starts the race once at least minAgents have joined (unless the
 *   `autoStartGate` holds it, e.g. queued agents still have time to claim
 *   their seats — MCPG-34).
 *
 * Options (MCPG-34):
 *   `logger`        — shared DecisionLogger (persistent server: one log
 *                     across all races). When omitted the session creates and
 *                     owns its own.
 *   `autoStartGate` — `() => boolean`, polled while in `setup`; `true` holds
 *                     the auto-start.
 *   `dossier`       — shared TeamDossier (MCPG-62): the per-team tactic
 *                     history (autopilot vs driver choices, projection
 *                     accuracy) persists beside season.json on the
 *                     persistent server; bare sessions omit it or keep an
 *                     in-memory copy.
 *
 * Tests can pass `strategyWindowSeconds: 0` / `reactiveWindowSeconds: 0` and
 * a fast `delayFn` to run a full race as fast as the event loop allows.
 */
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { DecisionLogger } from '../logging/decisionLogger.js';
import { TeamDossier } from '../teamDossier.js';
import { Simulation } from '../sim/simulation.js';
import { Track } from '../track.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MCPG-62: the tactic/driver events the spectator hub must push to clients
 * immediately (besides the 10 Hz snapshots that carry the same state for
 * (re)connecting drivers).
 */
const HUB_EVENT_TYPES = new Set([
  'tactics_proposed',
  'driver_locked',
  'driver_override',
  'autopilot_state',
  'auto_trusted',
  'strategy_resolved',
]);

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
    logger = null,
    autoStartGate = null,
    dossier = null, // MCPG-62 shared TeamDossier (null = a private in-memory one)
    // MCPG-62: forwarded to the simulation
    juniorFallbackSeconds = CONFIG.tactics.juniorFallbackSeconds,
    earlyCloseStrategyWindows = CONFIG.timing.earlyCloseStrategyWindows,
  } = {}) {
    this.ownsLogger = !logger;
    this.logger = logger ?? new DecisionLogger({ file: logFile, stdout: logToStdout });
    // Every session records its teams' tactic history; the orchestrator
    // injects the shared (persisted) dossier, bare sessions keep an
    // in-memory one so the results overlay works in every flavor.
    this.dossier = dossier ?? new TeamDossier({ file: null });
    this.autoStartGate = autoStartGate;
    this.raceId = randomUUID(); // identifies this server instance's race (GET /healthz)
    this.tickWallDelayMs = tickWallDelayMs;
    this.delayFn = delayFn;
    this.hubSink = null; // (event) => void — spectator-hub broadcast hook (MCPG-62)
    this.sim = new Simulation({
      totalLaps,
      strategyWindowSeconds,
      reactiveWindowSeconds,
      tickSeconds,
      seed,
      track: track ?? new Track(),
      juniorFallbackSeconds,
      earlyCloseStrategyWindows,
      onEvent: (event) => {
        this.logger.log(event);
        // The dossier consumes the same event stream as the JSONL log, so
        // the two can never disagree (MCPG-62). raceId is injected because
        // the sim's events are race-scoped, not race-labeled.
        if (this.dossier) this.dossier.onEvent({ ...event, raceId: this.raceId });
        if (HUB_EVENT_TYPES.has(event.type) && this.hubSink) this.hubSink(event);
      },
    });
    if (this.dossier) this.dossier.beginRace(this.raceId);
    this._running = false;
    this._orchestrator = null; // set by RaceOrchestrator._openSession (MCPG-28)
  }

  addAgent(name, agentId) {
    return this.sim.addAgent(name, agentId);
  }

  /**
   * Post-race track voting (MCPG-28): when the session sits behind the
   * orchestrator, the hub asks for the open vote window's info (for
   * (re)connecting spectators) and routes inbound `{ type: 'vote' }` messages
   * to `castVote(sessionId, trackId)`. Bare sessions report no window.
   */
  get votingInfo() {
    return this._orchestrator?.votingInfo ?? null;
  }

  /**
   * The phase as the spectator hub sees it: 'voting' when the orchestrator
   * is in its post-race vote window (MCPG-28), otherwise the simulation's
   * own phase. The hub's broadcast loop uses this to decide what to send.
   */
  get phaseView() {
    return this.votingInfo ? 'voting' : this.sim.phase;
  }

  /**
   * The full state view for the spectator hub: the simulation's state,
   * with the orchestrator's phase + vote block overlaid during the voting
   * window (MCPG-28). The hub's broadcast loop sends this to clients.
   */
  get stateView() {
    if (this.votingInfo) {
      const remainingS = Math.max(0, (this._orchestrator?._voteDeadline ?? 0) - Date.now()) / 1000;
      return {
        ...this.sim.state(),
        pending: this._orchestrator?.pendingView() ?? [],
        phase: 'voting',
        vote: this._orchestrator?.voteView(remainingS),
        season: this._orchestrator?.seasonView() ?? null, // MCPG-49
        dossiers: this.dossier?.viewForRace(this.raceId) ?? null, // MCPG-62
      };
    }
    return {
      ...this.sim.state(),
      pending: this._orchestrator?.pendingView() ?? [],
      season: this._orchestrator?.seasonView() ?? null,
      dossiers: this.dossier?.viewForRace(this.raceId) ?? null,
    };
  }

  castVote(sessionId, trackId) {
    if (this._orchestrator) return this._orchestrator.castVote(sessionId, trackId);
    return { accepted: false, error: 'no vote window open' };
  }

  // ---------------------------------------------------- driver seat (MCPG-62)

  /** Spectator hub hook: broadcast tactic/driver events immediately. */
  setHubSink(fn) {
    this.hubSink = fn;
  }

  /** Claim the driver seat for a car (one driver per car, claim-first). */
  claimDriverSeat(carId, driverSessionId) {
    return this.sim.claimDriverSeat(carId, driverSessionId);
  }

  /** Lock in one of the team's proposed tactics for this window. */
  lockInTactic(carId, driverSessionId, proposalKey) {
    return this.sim.lockInTactic(carId, driverSessionId, proposalKey);
  }

  /** Override with a raw strategy packet for this window. */
  overrideTactic(carId, driverSessionId, packet) {
    return this.sim.overrideTactic(carId, driverSessionId, packet);
  }

  /** Flip the seat back to AUTOPILOT (resting default state). */
  resumeAutopilot(carId, driverSessionId) {
    return this.sim.resumeAutopilot(carId, driverSessionId);
  }

  /** Release the seats a driver session held (its WS disconnected). */
  releaseDriverSeats(driverSessionId) {
    return this.sim.releaseDriverSeats(driverSessionId);
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
    // `season` (MCPG-49): the ranked all-time championship standings, or
    // null for bare sessions (no orchestrator / no persistence).
    // `dossiers` (MCPG-62): this race's per-team tactic history.
    return {
      ...this.sim.state(),
      pending: this._orchestrator?.pendingView() ?? [],
      season: this._orchestrator?.seasonView() ?? null,
      dossiers: this.dossier?.viewForRace(this.raceId) ?? null,
    };
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

  /** Junior-strategist fallback poll (MCPG-62); no-op outside the window. */
  checkJuniorFallback() {
    this.sim.checkJuniorFallback();
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
          // Poll the gate even while the grid is not full: the orchestrator
          // settles expired pending-queue entries through it (MCPG-34).
          const held = this.autoStartGate ? this.autoStartGate() : false;
          if (this.sim.cars.length >= CONFIG.race.minAgents && !held) {
            this.start();
          } else {
            await this.delayFn(100); // idle poll while waiting for agents
          }
        } else if (this.sim.phase === 'strategy_window') {
          this.checkJuniorFallback(); // MCPG-62: fill in teams that never post
          if (this.sim.windowRemainingS() <= 0 || this.sim.canEarlyClose()) {
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
    if (this.ownsLogger) this.logger.close();
  }
}
