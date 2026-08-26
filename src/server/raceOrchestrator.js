/**
 * RaceOrchestrator: makes the server persistent across races (MCPG-34).
 *
 * Owns the current RaceSession and a FIFO pending queue. After each race the
 * results are held for `resultsHoldSeconds`, then a fresh session opens in
 * `setup`. An agent that tries to join outside `setup` is not rejected with a
 * dead end — it is queued (FIFO, capped by the grid size) and, when the next
 * session opens, its MCP session id claims its seat at join time
 * (`agent_promoted`; display names are cosmetic and auto-suffixed on
 * collisions, MCPG-58).
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
import { Track } from '../track.js';
import { DEFAULT_TRACK_ID, getTrackDef, loadTrackDefs, persistNextTrack, readNextTrack } from '../tracks.js';
import { applyRace, readSeason, saveSeason, rankSeason } from '../season.js';
import { TeamDossier } from '../teamDossier.js';

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
   * @param {number}   [opts.voteWindowSeconds] post-race track-voting window (MCPG-28); 0 disables voting
   * @param {string}   [opts.nextTrackFile]  where the vote winner is persisted (restart-safe)
   * @param {string}   [opts.seasonFile]     where the championship season persists (MCPG-49);
   *                                         log-volume default, same pattern as nextTrackFile
   * @param {string|null} [opts.dossierFile]  where the team dossiers persist (MCPG-62);
   *                                         log-volume default (same volume as season),
   *                                         null = in-memory only
   * @param {Function} [opts.onVoteStart]    (info) => void — voting window opened (hub broadcasts)
   * @param {Function} [opts.onVoteEnd]      (result) => void — voting window closed (hub finalizes)
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
      voteWindowSeconds = CONFIG.timing.voteWindowSeconds,
      nextTrackFile = null, // defaults to the log volume (see tracks.js)
      seasonFile = null, // defaults to the log volume (see season.js, MCPG-49)
      dossierFile = null, // defaults to the log volume (see teamDossier.js, MCPG-62)
      delayFn = sleep,
      logger = null,
      onSession = null,
      onRaceComplete = null,
      onVoteStart = null,
      onVoteEnd = null,
    } = opts;
    this.opts = { totalLaps, strategyWindowSeconds, reactiveWindowSeconds, tickSeconds, tickWallDelayMs, seed, track, logToStdout };
    this.onVoteStart = onVoteStart;
    this.onVoteEnd = onVoteEnd;
    // MCPG-28: post-race spectator voting. The env MCGP_TRACK seeds the
    // first session; from session 2 on the vote (or the fallback rotation
    // when nobody voted) decides the track, persisted in nextTrackFile so a
    // restart between races cannot lose the decision.
    this.voteWindowSeconds = voteWindowSeconds;
    this.nextTrackFile = nextTrackFile ?? null;
    this.nextTrackId = this._envTrackId(); // env-selected seed for session 1
    this._votes = null; // current window's { sessionId -> trackId }
    this.votingInfo = null; // what the snapshot broadcasts while voting
    this._voteDeadline = 0; // wall time the current window closes/closed
    this.ownsLogger = !logger;
    this.logger = logger ?? new DecisionLogger({ file: logFile, stdout: logToStdout });
    // MCPG-49: the championship season. Loaded at startup; a corrupt file
    // starts an empty season with a warning (logged, never crashes).
    this.seasonFile = seasonFile ?? null;
    const loaded = readSeason(this.seasonFile);
    this.season = loaded.state;
    this._seasonSettledSeq = 0; // highest raceSeq already settled (idempotency)
    if (loaded.source === 'corrupt') {
      this.logger.log({ type: 'season_file_corrupt', file: this.seasonFile, error: loaded.error, action: 'started_empty' });
      console.warn(`[season] corrupt season file ${this.seasonFile} — starting an empty season (${loaded.error})`);
    } else if (loaded.source === 'loaded') {
      this.logger.log({ type: 'season_loaded', file: this.seasonFile, drivers: Object.keys(this.season.drivers).length });
    }
    // MCPG-62: the team dossiers (per-window autopilot/driver history) live
    // beside the season on the log volume, same atomic-write pattern. The
    // entry point (main.js) passes DOSSIER_FILE; tests and bare local runs
    // leave it null to keep the dossiers in memory only.
    this.dossier = new TeamDossier({
      file: dossierFile,
      onPersist: (err) => {
        if (err) {
          this.logger.log({ type: 'dossier_save_failed', file: this.dossier.file, error: err?.message ?? String(err) });
          console.warn(`[dossier] could not persist ${this.dossier.file}: ${err?.message ?? err} — dossier kept in memory`);
        }
      },
    });
    if (this.dossier.corrupt) {
      this.logger.log({ type: 'dossier_file_corrupt', file: this.dossier.file, error: this.dossier.corruptError, action: 'started_empty' });
      console.warn(`[dossier] corrupt dossier file ${this.dossier.file} — starting empty dossiers (${this.dossier.corruptError})`);
    }
    this.maxAgents = maxAgents;
    this.resultsHoldSeconds = resultsHoldSeconds;
    this.pendingGraceSeconds = pendingGraceSeconds;
    this.delayFn = delayFn;
    this.onSession = onSession;
    this.onRaceComplete = onRaceComplete;
    this.pending = []; // FIFO of { name(display), agentId (MCP session id), queuedAtMs, raceSeq }
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
      return { phase: 'setup', cars: [], standings: [], pending: this.pendingView(), season: this.seasonView() };
    }
    if (this.votingInfo) {
      // Voting window (MCPG-28): the session sits in 'finished' behind the
      // result hold, but spectators are told the phase is 'voting'.
      const remainingS = Math.max(0, (this._voteDeadline - Date.now()) / 1000);
      return { ...this.session.state(), pending: this.pendingView(), phase: 'voting', vote: this.voteView(remainingS) };
    }
    return { ...this.session.state(), pending: this.pendingView() };
  }

  /** The vote block broadcast inside snapshots while the window is open. */
  voteView(remainingS) {
    const counts = this._voteCounts();
    const options = this.voteWindowOptions().map((o) => ({ ...o, votes: counts[o.id] ?? 0 }));
    return {
      raceId: this.raceId,
      raceSeq: this.raceSeq,
      options,
      // MCPG-57: while the window is open no winner exists — the decision
      // happens at close and travels in the vote_result broadcast. A
      // provisional winner here made the client show DECIDED for the whole
      // window and never render the Vote buttons.
      winner: null,
      defaultId: this.votingInfo?.defaultId ?? null,
      totalVotes: Object.keys(this._votes ?? {}).length,
      windowSeconds: this.voteWindowSeconds,
      remainingS: remainingS !== undefined ? Math.round(remainingS * 100) / 100 : this.voteWindowSeconds,
    };
  }

  _voteCounts() {
    const counts = {};
    for (const trackId of Object.values(this._votes ?? {})) counts[trackId] = (counts[trackId] ?? 0) + 1;
    return counts;
  }

  /** Tracks offered in the window: every registry id except the one just raced. */
  voteWindowOptions() {
    const racedId = this.session ? this.session.sim.track.id : null;
    // Only the identity trio the vote panel renders (MCPG-63: the full def
    // — palette included — belongs to GET /tracks/<id>.json, not to every
    // snapshot broadcast).
    return loadTrackDefs()
      .filter((d) => d.id !== racedId)
      .map((d) => ({ id: d.id, name: d.name, lengthM: d.lengthM }));
  }

  /**
   * Cast (or change) one spectator's vote. Idempotent per WS session id:
   * a repeated vote replaces the previous one, it never accumulates. The
   * server is authoritative — only the tally at window close matters.
   */
  castVote(sessionId, trackId) {
    if (!this._votes || !sessionId || typeof trackId !== 'string') {
      return { accepted: false, error: 'no vote window open' };
    }
    if (!this.voteWindowOptions().some((o) => o.id === trackId)) {
      return { accepted: false, error: `unknown track: ${trackId}` };
    }
    this._votes[sessionId] = trackId;
    const totalVotes = Object.keys(this._votes).length;
    this.logger.log({ type: 'track_vote', raceId: this.raceId, raceSeq: this.raceSeq, sessionId, trackId, totalVotes });
    return { accepted: true, trackId, totalVotes };
  }

  /** Fallback pick when no vote came in: one step forward in the registry. */
  _fallbackTrackId() {
    const defs = loadTrackDefs();
    const racedId = this.session ? this.session.sim.track.id : defs[0].id;
    const i = Math.max(0, defs.findIndex((d) => d.id === racedId));
    return defs[(i + 1) % defs.length].id;
  }

  /**
   * Highest vote count wins; ties go to the option listed first (registry
   * order). Deterministic for a given vote map.
   */
  _tallyWinner(votes) {
    const counts = {};
    for (const t of Object.values(votes)) counts[t] = (counts[t] ?? 0) + 1;
    let best = null;
    let bestCount = 0;
    for (const o of this.voteWindowOptions()) {
      const n = counts[o.id] ?? 0;
      if (n > bestCount) {
        best = o.id;
        bestCount = n;
      }
    }
    return best ?? this._fallbackTrackId();
  }

  /**
   * Open the post-race voting window and wait for it to close. Resolves
   * with the next track id (logged + persisted). Skipped entirely when the
   * window is disabled (voteWindowSeconds = 0).
   */
  async _runVoteWindow(seq) {
    const windowSeconds = this.voteWindowSeconds;
    if (!windowSeconds || windowSeconds <= 0) return this._fallbackTrackId();
    const options = this.voteWindowOptions();
    const racedId = this.session ? this.session.sim.track.id : null;
    this._votes = {};
    // MCPG-57: no provisional `winner` in the open-window info — the
    // fallback pick is only applied at close (and is not the decision
    // until it is). Everything reading the window state goes through
    // voteView(), which reports winner: null while the window is open.
    this.votingInfo = {
      raceId: this.raceId,
      raceSeq: seq,
      options,
      defaultId: racedId,
      windowSeconds,
    };
    this.logger.log({
      type: 'voting_window_opened',
      raceId: this.raceId,
      raceSeq: seq,
      options: options.map((o) => o.id),
      windowSeconds,
    });
    if (this.onVoteStart) this.onVoteStart(this.votingInfo);

    this._voteDeadline = Date.now() + windowSeconds * 1000;
    await this._interruptibleVoteSleep(windowSeconds * 1000);
    const interrupted = this._closed;

    const votes = this._votes;
    const total = Object.keys(votes).length;
    const winnerId = total > 0 ? this._tallyWinner(votes) : this._fallbackTrackId();
    const source = total > 0 ? 'vote' : 'fallback';
    const counts = this._voteCountsFor(votes);
    this.logger.log({
      type: 'track_vote_result',
      raceId: this.raceId,
      raceSeq: seq,
      winner: winnerId,
      source,
      votes: counts,
      totalVotes: total,
    });
    if (!interrupted) {
      // Persist BEFORE the next session opens: a restart during the results
      // hold must still reproduce the decided track.
      const payload = { trackId: winnerId, source, votes: counts, raceId: this.raceId, decidedAt: new Date().toISOString() };
      persistNextTrack({ ...payload, file: this.nextTrackFile });
    }
    const finalOptions = this.voteWindowOptions().map((o) => ({ ...o, votes: counts[o.id] ?? 0 }));
    this.votingInfo = null;
    this.nextTrackId = winnerId;
    if (this.onVoteEnd) this.onVoteEnd({ raceId: this.raceId, raceSeq: seq, trackId: winnerId, source, votes: counts, totalVotes: total, options: finalOptions });
    return winnerId;
  }

  _voteCountsFor(votes) {
    const counts = {};
    for (const t of Object.values(votes)) counts[t] = (counts[t] ?? 0) + 1;
    return counts;
  }

  /** Cancellable sleep for the voting window (reuses the hold's abort). */
  _interruptibleVoteSleep(ms) {
    return this._interruptibleSleep(ms);
  }

  pendingView() {
    return this.pending.map((p, i) => ({ name: p.name, position: i + 1 }));
  }

  /**
   * MCPG-49: the ranked all-time season standings. Broadcast inside the
   * spectator snapshots (the `season` field) and served by the read-only
   * `get_season_standings` MCP tool.
   */
  seasonView() {
    return rankSeason(this.season);
  }

  /** MCPG-62 driver-seat routing: the hub asks the orchestrator, which
   *  forwards to the current session (mirrors the castVote pattern). */
  claimDriverSeat(carId, driverSessionId) {
    return this.session?.claimDriverSeat(carId, driverSessionId) ?? { accepted: false, error: 'no_race_session' };
  }

  lockInTactic(carId, driverSessionId, proposalKey) {
    return this.session?.lockInTactic(carId, driverSessionId, proposalKey) ?? { accepted: false, error: 'no_race_session' };
  }

  overrideTactic(carId, driverSessionId, packet) {
    return this.session?.overrideTactic(carId, driverSessionId, packet) ?? { accepted: false, error: 'no_race_session' };
  }

  resumeAutopilot(carId, driverSessionId) {
    return this.session?.resumeAutopilot(carId, driverSessionId) ?? { accepted: false, error: 'no_race_session' };
  }

  releaseDriverSeats(driverSessionId) {
    return this.session?.releaseDriverSeats(driverSessionId) ?? 0;
  }

  /**
   * MCPG-49: award championship points for a finished race (once per
   * session), persist the season, and log `season_points_awarded`. Called
   * right after `session.run()` resolves — BEFORE the results hold opens —
   * so the finished snapshot / results overlay already show the new totals.
   * A race aborted by shutdown never settles: incomplete results are not
   * championship results.
   */
  _settleSeason(seq) {
    if (seq <= this._seasonSettledSeq) return; // already settled
    const s = this.session;
    if (!s || s.sim.phase !== 'finished') return;
    const standings = s.standings();
    if (standings.length === 0) return;
    const { state, awards } = applyRace(this.season, standings);
    this.season = state;
    this._seasonSettledSeq = seq;
    try {
      saveSeason(this.season, this.seasonFile);
    } catch (err) {
      // A non-writable season path (e.g. a bare local run with no /logs)
      // must not kill the rotation loop: the award stays in memory and the
      // next settle retries the write. Logged, warned, never fatal.
      this.logger.log({ type: 'season_save_failed', file: this.seasonFile, error: err?.message ?? String(err) });
      console.warn(`[season] could not persist ${this.seasonFile}: ${err?.message ?? err} — season kept in memory`);
    }
    this.logger.log({ type: 'season_points_awarded', raceId: this.raceId, raceSeq: seq, awards });
  }

  /**
   * Agent-facing join (MCP join_race). Outside `setup` the session goes to
   * the pending queue instead of failing; in `setup` a queued session claims
   * its seat on join (idempotent by MCP session id — MCPG-58; names are
   * display-only and auto-suffixed on collisions).
   *
   * @returns {{status: 'joined', car: object, claimedFromQueue: boolean}
   *           |{status: 'queued', name: string, requestedName: string, position: number, phase: string}
   *           |{status: 'queue_full', maxSize: number, phase: string}}
   */
  joinAgent(name, agentId) {
    if (!agentId) throw new Error('joinAgent requires an agentId (the MCP session id)');
    this._settleGraceIfDue();
    const s = this.session;
    if (!s || s.sim.phase !== 'setup') {
      return this._enqueue(name, agentId);
    }
    try {
      const car = s.addAgent(name, agentId);
      const qi = this._queueIndex(agentId);
      if (qi !== -1) {
        this.pending.splice(qi, 1);
        this.logger.log({
          type: 'agent_promoted',
          name: car.name,
          agentId,
          raceSeq: this.raceSeq,
          raceId: this.raceId,
          carId: car.id,
        });
        return { status: 'joined', car, claimedFromQueue: true };
      }
      return { status: 'joined', car, claimedFromQueue: false };
    } catch (err) {
      if (/race is full/i.test(err.message)) return this._enqueue(name, agentId);
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
        agentIds: expired.map((p) => p.agentId),
        raceSeq: this.raceSeq,
        raceId: this.raceId,
      });
    }
  }

  _queueIndex(agentId) {
    return this.pending.findIndex((p) => p.agentId === agentId);
  }

  /**
   * Queue a session for the NEXT race (MCPG-58: keyed by MCP session id,
   * display names auto-suffixed so two sessions with the same requested
   * name stay distinguishable on the ticker and in the log).
   */
  _enqueue(name, agentId) {
    const existing = this._queueIndex(agentId);
    if (existing !== -1) {
      const p = this.pending[existing];
      return { status: 'queued', name: p.name, requestedName: name, position: existing + 1, phase: this._phase() };
    }
    if (this.pending.length >= this.maxAgents) {
      return { status: 'queue_full', maxSize: this.maxAgents, phase: this._phase() };
    }
    const displayName = this._freeQueueName(name);
    // Promised the NEXT session: it opens after the current one's results hold.
    this.pending.push({ name: displayName, agentId, queuedAtMs: Date.now(), raceSeq: this.raceSeq + 1 });
    this.logger.log({
      type: 'agent_queued',
      name: displayName,
      agentId,
      position: this.pending.length,
      phase: this._phase(),
      raceSeq: this.raceSeq,
    });
    return { status: 'queued', name: displayName, requestedName: name, position: this.pending.length, phase: this._phase() };
  }

  /** First display name derived from `name` unused by pending entries or current cars. */
  _freeQueueName(name) {
    const taken = new Set([...this.pending.map((p) => p.name), ...(this.session?.sim.cars ?? []).map((c) => c.name)]);
    if (!taken.has(name)) return name;
    for (let n = 2; ; n += 1) {
      const candidate = `${name}#${n}`;
      if (!taken.has(candidate)) return candidate;
    }
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
    const track = this._nextTrackInstance();
    this.opts.track = track;
    const s = new RaceSession({ ...this.opts, logger: this.logger, dossier: this.dossier, autoStartGate: () => this._holdForPending() });
    this.session = s;
    s._orchestrator = this; // votes + voting info route back here (MCPG-28)
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

  /** The Track instance the next session will race (MCPG-28: vote-decided). */
  _nextTrackInstance() {
    const id = this.raceSeq === 0 ? this._envTrackId() : this._trackIdForNextSession();
    const def = getTrackDef(id);
    return new Track({ id: def.id, name: def.name, lengthM: def.lengthM, sectorLengthM: def.sectorLengthM });
  }

  /** Session 1: env MCGP_TRACK. Later sessions: the persisted vote winner. */
  _trackIdForNextSession() {
    const persisted = readNextTrack(this.nextTrackFile);
    if (persisted) return persisted.trackId;
    return this._envTrackId();
  }

  /** The env-selected track id, or the registry default when unset/unknown. */
  _envTrackId() {
    const env = (process.env.MCGP_TRACK || DEFAULT_TRACK_ID).trim();
    return getTrackDef(env) ? env : DEFAULT_TRACK_ID;
  }

  async _host() {
    try {
      while (!this._closed) {
        this._openSession();
        const seq = this.raceSeq;
        await this.session.run();
        if (this._closed) break;
        // MCPG-49: settle the championship before the hold, so the results
        // overlay and the final snapshot carry the fresh season totals.
        this._settleSeason(seq);
        // MCPG-28: the post-race vote decides the next session's track.
        this.logger.log({ type: 'results_hold_started', raceSeq: seq, raceId: this.raceId, holdSeconds: this.resultsHoldSeconds });
        if (this.onRaceComplete) this.onRaceComplete(this.session, seq);
        await this._runVoteWindow(seq);
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
