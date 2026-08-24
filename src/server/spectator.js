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
    spectators: spectatorCount,
  });
}

export function createSpectatorHub(httpServer, session, {
  path = SPECTATE_PATH,
  broadcastIntervalMs = 100, // 10 Hz — plenty for 8 cars, small JSON
  heartbeatIntervalMs = 30000,
  onEvent = () => {}, // (event) -> void, e.g. decision-logger sink
} = {}) {
  const wss = new WebSocketServer({ server: httpServer, path });
  const clients = new Set();
  let stopped = false;
  let finishedNotified = session.state().phase === 'finished';

  const sendToAll = (msg) => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  const sendFinalIfDue = () => {
    if (finishedNotified || session.state().phase !== 'finished') return;
    finishedNotified = true;
    onEvent({ type: 'spectator_final_broadcast', spectators: clients.size });
    sendToAll(buildSnapshotMessage(session, clients.size));
  };

  const broadcast = () => {
    if (stopped || clients.size === 0) return;
    if (session.state().phase === 'finished') {
      // Send the final snapshot exactly once on the transition, then stay
      // silent (the connection stays open for the results screen).
      sendFinalIfDue();
      return;
    }
    sendToAll(buildSnapshotMessage(session, clients.size));
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
    onEvent({ type: 'spectator_connected', spectators: clients.size, remote: req.socket.remoteAddress });

    // hello + immediate full snapshot: covers reconnects (snapshots are
    // self-contained, so no replay history is needed).
    ws.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      serverNowMs: Date.now(),
      track: session.state().track,
      totalLaps: session.state().totalLaps,
      phase: session.state().phase,
    }));
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
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      onEvent({ type: 'spectator_disconnected', spectators: clients.size });
    });
    ws.on('error', () => {}); // close follows
  });

  return {
    path,
    clientCount: () => clients.size,
    /**
     * Send the final snapshot right now, synchronously. The entry points
     * call this before they print `race_complete` and the orchestrator
     * (or the operator) kills the process: the frame must be flushed to the
     * sockets while the process is still alive.
     */
    finalize: sendFinalIfDue,
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
