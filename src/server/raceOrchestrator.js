/**
 * RaceOrchestrator: makes the server persistent across races (MCPG-34).
 *
 * Owns the current RaceSession and a FIFO pending queue. After each race the
 * results are held for `resultsHoldSeconds`, then a fresh session opens in
 * `setup`. An agent that tries to join outside `setup` is not rejected with a
 * dead end — it is queued (FIFO, capped by the grid size) and, when the next
 * session opens, its name claims its seat at join time (`agent_promoted`).
 *
 * Queue semantics (FIFO promise, not a reservation): an entry promises a seat
 * in the NEXT session only. It expires once that session's grace clock
 * (`pendingGraceSeconds`, counted from session open) passes without the name
 * re-joining. Settlement happens on every join and on every setup poll, so it
 * lands within one 100 ms poll of the deadline.
 *
 * The orchestrator looks like a session to the rest of the server: `state()`,
 * `raceId`, `logger` — so http.js / the spectator hub / the MCP layer share
 * one instance for the whole process lifetime.
 */
import { CONFIG } from '../config.js';
import { DecisionLogger } from '../logging/decisionLogger.js';
import { RaceSession } from './raceSession.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RaceOrchestrator {
  /**
   * @param {object} [opts] same timing options as RaceSession, plus:
   * @param {number} [opts.maxAgents]        pending-queue cap (default CONFIG.race.maxAgents)
   * @param {number} [opts.resultsHoldSeconds] hold results before next session (default CONFIG)
   * @param {number} [opts.pendingGraceSeconds] claim window per queued seat (default CONFIG)
   * @param {Function} [opts.delayFn]        injectable sleep (tests)
   * @param {object} [opts.logger]           shared DecisionLogger; created when omitted
   * @param {Function} [opts.onSession]      (session, seq) => void — a new session opened (hub reset)
   * @param {Function} [opts.onRaceComplete] (session, seq) => void — a race finished (hold begins)
   */
  constructor(opts = {}) {
    const {
      totalLaps,
      strategyWindowSeconds = CONFIG.timing.strategyWindowSeconds,
      reactiveWindowSeconds = CONFIG.timing.reactiveWindowSeconds,
      tickSeconds = CONFIG.timing.tickSeconds,
      tickWallDelayMs = CONFIG.timing.tickWallDelayMs,
      seed = 1,
      track = null,
      logFile = null,
      logToStdout = true,
      maxAgents = CONFIG.race.maxAgents,
      resultsHoldSeconds = CONFIG.timing.resultsHoldSeconds,
      pendingGraceSeconds = CONFIG.timing.pendingGraceSeconds,
      delayFn = sleep,
      logger = null,
      onSession = null,
      onRaceComplete = null,
    } = opts;
    this.opts = { totalLaps, strategyWindowSeconds, reactiveWindowSeconds, tickSeconds, tickWallDelayMs, seed, track, logToStdout };
    this.ownsLogger = !logger;
    this.logger = logger ?? new DecisionLogger({ file: logFile, stdout: logToStdout });
    this.maxAgents = maxAgents;
    this.resultsHoldSeconds = resultsHoldSeconds;
    this.pendingGraceSeconds = pendingGraceSeconds;
    this.delayFn = delayFn;
    this.onSession = onSession;
    this.onRaceComplete = onRaceComplete;
    this.pending = []; // FIFO of { name, queuedAtMs, raceSeq }
    this.session = null; // current RaceSession (null before run())
    this.raceSeq = 0;
    this._graceUntilMs = 0;
    this._graceSettled = true;
    this._graceTimer = null;
    this._closed = false;
    this._sleepAbort = null;
    this._runPromise = null;
  }

  /** Race id of the current session (GET /healthz). */
  get raceId() {
    return this.session ? this.session.raceId : null;
  }

  /**
   * Start the first session (synchronously) and the rotation loop.
   * Resolves only on shutdown; callers fire-and-forget.
   */
  run() {
    if (this._runPromise) return this._runPromise;
    this._runPromise = this._host();
    return this._runPromise;
  }

  /** Current race state + the pending queue (http /state, MCP get_race_state). */
  state() {
    if (!this.session) {
      return { phase: 'setup', cars: [], standings: [], pending: this.pendingView() };
    }
    return { ...this.session.state(), pending: this.pendingView() };
  }

  pendingView() {
    return this.pending.map((p, i) => ({ name: p.name, position: i + 1 }));
  }

  /**
   * Agent-facing join (MCP join_race). Outside `setup` the name goes to the
   * pending queue instead of failing; in `setup` a queued name claims its
   * seat on join (idempotent by name, as before).
   *
   * @returns {{status: 'joined', car: object, claimedFromQueue: boolean}
   *           |{status: 'queued', name: string, position: number, phase: string}
   *           |{status: 'queue_full', maxSize: number, phase: string}}
   */
  joinAgent(name, agentId = 'mcp-client') {
    this._settleGraceIfDue();
    const s = this.session;
    if (!s || s.sim.phase !== 'setup') {
      return this._enqueue(name);
    }
    try {
      const car = s.addAgent(name, agentId);
      const qi = this._queueIndex(name);
      if (qi !== -1) {
        this.pending.splice(qi, 1);
        this.logger.log({ type: 'agent_promoted', name, raceSeq: this.raceSeq, raceId: this.raceId, carId: car.id });
        return { status: 'joined', car, claimedFromQueue: true };
      }
      return { status: 'joined', car, claimedFromQueue: false };
    } catch (err) {
      if (/race is full/i.test(err.message)) return this._enqueue(name);
      throw err;
    }
  }

  /**
   * Auto-start gate for the session: while there are pending agents and the
   * grid is not yet at the hard cap, hold `setup` so they can claim their
   * seats. The moment the grid is full the hold lifts and the race starts.
   */
  _holdForPending() {
    this._settleGraceIfDue();
    if (this.pending.length === 0) return false;
    if (!this.session) return false;
    if (this.session.sim.cars.length >= CONFIG.race.maxAgents) return false;
    return true;
  }

  /**
   * Drop queue entries whose promised session has already passed without a
   * claim. Runs on every join, every setup poll, and at the grace deadline
   * itself (belt and suspenders); `_graceSettled` keeps it single-shot.
   */
  _settleGraceIfDue() {
    if (this._graceSettled || this._closed || !this.session) return;
    if (this.session.sim.phase === 'setup' && Date.now() < this._graceUntilMs) return;
    this._graceSettled = true;
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
    const expired = this.pending.filter((p) => p.raceSeq === this.raceSeq);
    if (expired.length > 0) {
      this.pending = this.pending.filter((p) => p.raceSeq !== this.raceSeq);
      this.logger.log({
        type: 'queue_expired',
        names: expired.map((p) => p.name),
        raceSeq: this.raceSeq,
        raceId: this.raceId,
      });
    }
  }

  _queueIndex(name) {
    return this.pending.findIndex((p) => p.name === name);
  }

  _enqueue(name) {
    const existing = this._queueIndex(name);
    if (existing !== -1) {
      return { status: 'queued', name, position: existing + 1, phase: this._phase() };
    }
    if (this.pending.length >= this.maxAgents) {
      return { status: 'queue_full', maxSize: this.maxAgents, phase: this._phase() };
    }
    // Promised the NEXT session: it opens after the current one's results hold.
    this.pending.push({ name, queuedAtMs: Date.now(), raceSeq: this.raceSeq + 1 });
    this.logger.log({ type: 'agent_queued', name, position: this.pending.length, phase: this._phase(), raceSeq: this.raceSeq });
    return { status: 'queued', name, position: this.pending.length, phase: this._phase() };
  }

  _phase() {
    return this.session ? this.session.sim.phase : 'setup';
  }

  /** Cancellable sleep for the results hold: shutdown() resolves it at once. */
  _interruptibleSleep(ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        if (this._sleepAbort === abort) this._sleepAbort = null;
        resolve();
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
      const abort = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this._sleepAbort === abort) this._sleepAbort = null;
        resolve();
      };
      this._sleepAbort = abort;
    });
  }

  /** Open the next session: drops stale queue entries, logs, notifies. */
  _openSession() {
    // Entries promised to sessions that have already started are stale.
    this.pending = this.pending.filter((p) => p.raceSeq >= this.raceSeq + 1);
    this.raceSeq += 1;
    const s = new RaceSession({ ...this.opts, logger: this.logger, autoStartGate: () => this._holdForPending() });
    this.session = s;
    this._graceUntilMs = Date.now() + this.pendingGraceSeconds * 1000;
    this._graceSettled = false;
    this._graceTimer = setTimeout(() => this._settleGraceIfDue(), this.pendingGraceSeconds * 1000);
    if (typeof this._graceTimer.unref === 'function') this._graceTimer.unref();
    this.logger.log({
      type: 'next_session_scheduled',
      raceSeq: this.raceSeq,
      raceId: s.raceId,
      pendingQueue: this.pendingView().map((p) => p.name),
    });
    if (this.onSession) this.onSession(s, this.raceSeq);
  }

  async _host() {
    try {
      while (!this._closed) {
        this._openSession();
        const seq = this.raceSeq;
        await this.session.run();
        if (this._closed) break;
        this.logger.log({ type: 'results_hold_started', raceSeq: seq, raceId: this.raceId, holdSeconds: this.resultsHoldSeconds });
        if (this.onRaceComplete) this.onRaceComplete(this.session, seq);
        await this._interruptibleSleep(this.resultsHoldSeconds * 1000);
      }
    } finally {
      if (this._graceTimer) {
        clearTimeout(this._graceTimer);
        this._graceTimer = null;
      }
      if (this.session) this.session.close();
    }
  }

  /**
   * Graceful shutdown (SIGTERM/SIGINT): abort the hold, close the session,
   * log `shutting_down` (NOT server_error — the run scripts watch stdout for
   * that marker), release the shared logger.
   */
  shutdown(signal = null) {
    if (this._closed) return;
    this._closed = true;
    if (this._sleepAbort) {
      this._sleepAbort();
      this._sleepAbort = null;
    }
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
    if (this.session) this.session.close();
    this.logger.log({ type: 'shutting_down', raceSeq: this.raceSeq, raceId: this.raceId, signal });
    if (this.ownsLogger) this.logger.close();
  }
}
