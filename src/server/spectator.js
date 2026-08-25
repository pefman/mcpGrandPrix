/**
 * Spectator hub: the live WebSocket feed for browser viewers (Slice 2).
 *
 *   ws://host:port/spectate
 *
 * Each spectator connection receives:
 *   - `hello`     once, on connect: protocol version + track + race config.
 *   - `snapshot`  every broadcastIntervalMs (default 10 Hz) while the race is
 *                 not finished: a self-contained full state (phase, lap,
 *                 window time, all cars with their track distance `s`,
 *                 standings, viewer count). Because snapshots are complete,
 *                 a (re)connecting client never needs history.
 *   - `pong`      reply to a client keep-alive `ping`. The snapshot feed is
 *                 outbound-only, so without inbound client pings a quiet race
 *                 would let a free-tier host sleep mid-race (hosting decision
 *                 2026-08-23). The client pings ~every 30 s while the race is
 *                 running; we answer so the traffic is guaranteed inbound.
 *
 * Post-race track voting (MCPG-28): while the orchestrator's voting window
 * is open the hub broadcasts { type: 'voting', ... } once per window and
 * snapshots carry phase 'voting' + a vote block (options with live counts,
 * countdown). A spectator sends { type: 'vote', trackId } — one vote per WS
 * session, re-voting replaces it, the server is authoritative. When the
 * window closes the hub broadcasts { type: 'vote_result', ... } and finalizes
 * (the next race resets it as usual).
 *
 * The hub also runs a protocol-level heartbeat (WS ping every 30 s, dead
 * sockets terminated) so the client set stays clean.
 *
 * Spectators are pure observers: the hub only reads the shared RaceSession,
 * and nothing a spectator sends can affect the race.
 */
import { WebSocketServer, WebSocket } from 'ws';

export const SPECTATE_PATH = '/spectate';

/**
 * Serialize the spectator broadcast payload from the authoritative state.
 * `cars[].s` is meters into the current lap (0..track length), ready for the
 * client's (lap, s) -> 3D mapping. Snapshots are self-contained: a
 * (re)connecting client needs no history, just the next one.
 */
export function buildSnapshotMessage(session, spectatorCount) {
  const state = session.state();
  return JSON.stringify({
    type: 'snapshot',
    ...state,
    serverNowMs: Date.now(),
    finished: state.phase === 'finished',
    pending: state.pending ?? [],
    spectators: spectatorCount,
  });
}

/**
 * Connect/rotation greeting. `raceId` (MCPG-34) lets a persistent server's
 * clients notice when a NEW race session replaces the old one: a different
 * raceId after having seen `finished` means reset the scene and overlays.
 * Bare sessions (no orchestrator) report null, so old clients ignore it.
 */
export function buildHelloMessage(session) {
  const state = session.state();
  return JSON.stringify({
    type: 'hello',
    protocol: 1,
    raceId: session.raceId ?? null,
    serverNowMs: Date.now(),
    track: state.track,
    totalLaps: state.totalLaps,
    phase: state.phase,
  });
}

export function createSpectatorHub(httpServer, initialSession, {
  /**
   * MCPG-34 rotation support: a getter for the CURRENT session. When the
   * orchestrator opens a new race session it calls `reset()`, which rebinds
   * `session` to `getSession()` so voting (MCPG-28) and snapshots keep
   * working across rotations. Bare single-session usage can omit it.
   */
  getSession = () => initialSession,

  path = SPECTATE_PATH,
  broadcastIntervalMs = 100, // 10 Hz — plenty for 8 cars, small JSON
  heartbeatIntervalMs = 30000,
  onEvent = () => {}, // (event) -> void, e.g. decision-logger sink
} = {}) {
  const wss = new WebSocketServer({ server: httpServer, path });
  let session = initialSession;
  const clients = new Set();
  const clientIds = new Map(); // ws -> id; the vote is keyed per session (MCPG-28)
  let stopped = false;
  let finishedNotified = session.state().phase === 'finished';
  let votingActive = false; // a voting window is open (MCPG-28)

  const sendToAll = (msg) => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  const sendFinalIfDue = () => {
    const s = getSession();
    if (finishedNotified || s.state().phase !== 'finished') return;
    finishedNotified = true;
    onEvent({ type: 'spectator_final_broadcast', spectators: clients.size });
    sendToAll(buildSnapshotMessage(s, clients.size));
  };

  const broadcast = () => {
    if (stopped || clients.size === 0) return;
    // MCPG-34: always read from the current session (the closure's `session`
    // is rebound by reset() on rotation). phaseView overlays 'voting' while
    // the orchestrator's vote window is open (MCPG-28).
    const s = getSession();
    const phase = s.phaseView;
    if (phase === 'voting') {
      // MCPG-28: first finished snapshot of the window carries the vote
      // block (counts = 0, full countdown) and starts the per-window vote
      // broadcast; later ticks refresh the live block until it is gone.
      const st = s.stateView;
      if (!votingActive) {
        votingActive = true;
        finishedNotified = true; // the finished snapshot is the voting one
        const vote = st.vote;
        onEvent({ type: 'voting_broadcast', raceId: vote.raceId, raceSeq: vote.raceSeq, spectators: clients.size });
        sendToAll(JSON.stringify({ type: 'voting', ...vote }));
      }
      sendToAll(JSON.stringify({
        type: 'snapshot',
        ...st,
        serverNowMs: Date.now(),
        finished: true,
        pending: st.pending ?? [],
        vote: { ...st.vote, remainingS: Math.max(0, Math.round(st.vote.remainingS * 100) / 100) },
        spectators: clients.size,
      }));
      return;
    }
    if (votingActive) {
      votingActive = false; // the phase left 'voting' (window closed)
    }
    if (phase === 'finished') {
      // Send the final snapshot exactly once on the transition, then stay
      // silent (the connection stays open for the results screen).
      sendFinalIfDue();
      return;
    }
    sendToAll(buildSnapshotMessage(s, clients.size));
  };

  const broadcastTimer = setInterval(broadcast, broadcastIntervalMs);
  broadcastTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    clients.add(ws);
    clientIds.set(ws, `spec-${clients.size + 1}-${Date.now().toString(36)}`);
    onEvent({ type: 'spectator_connected', spectators: clients.size, remote: req.socket.remoteAddress });

    // hello + immediate full snapshot: covers reconnects (snapshots are
    // self-contained, so no replay history is needed).
    ws.send(buildHelloMessage(session));
    if (session.votingInfo) {
      // (Re)connected into an open voting window (MCPG-28): get the window
      // state now, like the hello on connect.
      ws.send(JSON.stringify({ type: 'voting', ...session.votingInfo }));
    }
    ws.send(buildSnapshotMessage(session, clients.size));

    ws.on('message', (raw) => {
      ws.isAlive = true; // any inbound traffic counts as keep-alive
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // spectators are observers; malformed input is ignored
      }
      if (msg && msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      } else if (msg && msg.type === 'vote' && typeof session.castVote === 'function') {
        // MCPG-28: one vote per WS session (idempotent; re-voting replaces).
        const res = session.castVote(clientIds.get(ws), msg.trackId);
        ws.send(JSON.stringify(res.accepted
          ? { type: 'vote_ack', trackId: res.trackId, totalVotes: res.totalVotes }
          : { type: 'vote_rejected', error: res.error }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      clientIds.delete(ws);
      onEvent({ type: 'spectator_disconnected', spectators: clients.size });
    });
    ws.on('error', () => {}); // close follows
  });

  /**
   * A new race session opened (MCPG-34): re-broadcast hello + snapshot to
   * every connected client so they reset (drop the finished overlay, re-init
   * the scene from the new raceId). Also resets the final-broadcast guard so
   * the new session's finished snapshot is sent exactly once again.
   */
  const reset = () => {
    finishedNotified = false;
    votingActive = false;
    session = getSession(); // rebind to the new session (MCPG-34)
    const hello = buildHelloMessage(session);
    const snap = buildSnapshotMessage(session, clients.size);
    sendToAll(hello);
    sendToAll(snap);
    onEvent({ type: 'spectator_reset_broadcast', raceId: session.raceId ?? null, spectators: clients.size });
  };

  return {
    path,
    clientCount: () => clients.size,
    reset,
    /**
     * Send the final snapshot right now, synchronously. The entry points
     * call this before they print `race_complete` and the orchestrator
     * (or the operator) kills the process: the frame must be flushed to the
     * sockets while the process is still alive.
     */
    finalize: sendFinalIfDue,
    /**
     * MCPG-28: the voting window closed — broadcast the result to everyone,
     * log it, then send the one post-vote finished snapshot (the results
     * screen with the decided track). Idempotent per window.
     */
    finalizeVote: (result) => {
      sendToAll(JSON.stringify({ type: 'vote_result', ...result }));
      onEvent({ type: 'vote_result_broadcast', raceId: result.raceId, raceSeq: result.raceSeq, winner: result.trackId, source: result.source, totalVotes: result.totalVotes, spectators: clients.size });
      votingActive = false;
      finishedNotified = false; // let sendFinalIfDue fire once more
      sendFinalIfDue();
    },
    close: () => {
      stopped = true;
      clearInterval(broadcastTimer);
      clearInterval(heartbeatTimer);
      // The run() promise can resolve before the 100 ms tick notices the
      // finished transition — guarantee the final snapshot lands exactly
      // once here, so the results screen renders even on immediate shutdown.
      sendFinalIfDue();
      for (const client of clients) client.close(1000, 'server shutting down');
      clients.clear();
      wss.close();
    },
  };
}
