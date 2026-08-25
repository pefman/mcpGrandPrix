/**
 * Spectator WebSocket client: connection lifecycle, reconnect with backoff,
 * keep-alive pings, and a small snapshot buffer for render interpolation.
 *
 * Keep-alive (hosting decision 2026-08-23): the snapshot feed is outbound-
 * only, and free-tier hosts (Render free plan) sleep after ~15 min without
 * INBOUND traffic. A race with a 20 s strategy window per lap stays warm
 * only while agents are calling MCP tools — a spectator tab must contribute
 * its own inbound traffic, so while the tab is open and the race is running
 * we send a `ping` roughly every 30 s; the server answers with `pong`.
 * Browsers throttle background-tab timers to ~1/min, which is still far
 * inside the 15-minute idle window.
 */
import { resolveSpectatorWsUrl } from './resolveUrl.js';

export class SpectatorConnection extends EventTarget {
  constructor(url = resolveSpectatorWsUrl()) {
    super();
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.reconnectDelayMs = 1000;
    this.phase = null; // last known race phase (null until first snapshot)
    this.spectators = null;
    this.lastSnapshotAt = 0;
    this.raceId = null; // current race session id (null on old/single-race servers)
    this.endedAfterFails = 10; // failed reconnects before status 'ended' (tests lower this)
    this._sawFinished = false; // has this client seen a finished phase (rotation detector)
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._reconnectFails = 0;
    this._closedByUser = false;
  }

  connect() {
    this._closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let attemptConnected = false; // per-attempt flag (old sockets' close
                                  // events must not miscount new attempts)

    ws.addEventListener('open', () => {
      attemptConnected = true;
      this._reconnectFails = 0;
      this.connected = true;
      this.reconnectDelayMs = 1000;
      this.emit('status', 'connected');
      ws.send(JSON.stringify({ type: 'ping' })); // immediate inbound traffic
      this._startPingTimer();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        // Rotation detection (MCPG-34): a NEW raceId after having seen
        // `finished` means the persistent server opened the next session —
        // drop the finished overlay and re-init the scene.
        const rotated = msg.raceId != null && this.raceId != null && msg.raceId !== this.raceId && this._sawFinished;
        this.raceId = msg.raceId ?? null;
        if (rotated) {
          this._sawFinished = false;
          this.emit('reset', msg);
        }
        this.emit('hello', msg);
        return;
      }
      if (msg.type === 'snapshot') {
        this.lastSnapshotAt = performance.now();
        this.phase = msg.phase;
        this.spectators = msg.spectators ?? null;
        if (msg.phase === 'finished') this._sawFinished = true;
        this.emit('snapshot', msg);
        return;
      }
      if (msg.type === 'pong') {
        this.emit('pong', msg);
        return;
      }
      this.emit('message', msg);
    });

    ws.addEventListener('close', async () => {
      this.connected = false;
      this._stopPingTimer();
      if (this._closedByUser) return;
      if (!attemptConnected) this._reconnectFails += 1;
      if (attemptConnected && this.phase) {
        // We were watching the race but the socket died — ask the server
        // for the current state before deciding what happened.
        const state = await this._fetchState();
        if (state && state.phase === 'finished') {
          // MCPG-34: the persistent server keeps running after the race
          // (results hold, then the next session). Stay connected: the
          // reconnect will pick up the new session via the rotated hello.
          this.phase = 'finished';
          this.emit('snapshot', state);
          this.emit('status', 'disconnected');
          this._scheduleReconnect();
          return;
        }
        if (!state && this.phase === 'finished') {
          // Server unreachable AND the race is over: a single-race server
          // exits right after the final snapshot, so this is a clean end.
          // Retries continue in the background — a redeployed server flips
          // the status back to 'connected'.
          this.emit('status', 'ended');
          this._scheduleReconnect();
          return;
        }
      }
      // 'ended' after many failed attempts: stop claiming we are still
      // reconnecting (retrying continues in the background — a successful
      // reconnect flips back to 'connected').
      this.emit('status', this._reconnectFails >= this.endedAfterFails ? 'ended' : 'disconnected');
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {}); // close follows
  }

  close() {
    this._closedByUser = true;
    this._stopPingTimer();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) this.ws.close();
  }

  sendPing() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }
  }

  /**
   * Send an outbound message (keep-alive pings, MCPG-28 votes). Silently
   * drops when the socket is not open — the server is authoritative and
   * snapshot/vote_result events drive the UI either way.
   */
  send(msg) {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Fallback state fetch: GET /state on the same host as the WebSocket.
   * Returns the state object, or null when the server is unreachable (or
   * does not offer the endpoint — old servers).
   */
  async _fetchState() {
    try {
      // same host as the WebSocket, but plain http(s)
      const u = new URL(this.url);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      const res = await fetch(`${u.origin}/state`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const state = await res.json();
      return state && typeof state.phase === 'string' ? state : null;
    } catch {
      return null;
    }
  }

  _startPingTimer() {
    this._stopPingTimer();
    this._pingTimer = setInterval(() => {
      // Keep the host awake for as long as the tab is open: the persistent
      // server (MCPG-34) also serves the results hold and the next session.
      this.sendPing();
    }, 30000);
    if (typeof this._pingTimer.unref === 'function') this._pingTimer.unref();
  }

  _stopPingTimer() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._closedByUser || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10000);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * Per-car snapshot buffer for motion rendering (MCPG-52).
 *
 * The sim advances positions in 250 ms ticks while snapshots arrive every
 * 100 ms, so snapshot positions form a staircase (flat, flat, jump). Lerp
 * between adjacent snapshots renders that staircase as a stop-and-go pulse.
 * Instead we extrapolate from a per-car anchor sample at that sample's
 * `speedMs`: in steady state the rendered position is a straight
 * constant-velocity line. The anchor is kept until the next-sample clamp
 * fires — the extrapolation has drifted more than max(10 m, 25% of speed)
 * from the newest snapshot (corner, pit, DRS) — where it re-anchors to the
 * fresh baseline. When the feed is stale (>500 ms without a snapshot) the
 * extrapolation is clamped to 500 ms past the newest sample, so a dead feed
 * holds the car instead of extrapolating forever.
 */
export class CarPositionBuffer {
  constructor(trackLengthM) {
    this.trackLengthM = trackLengthM;
    this.cars = new Map(); // carId -> [{at, s, su, speed, status}]
    this.anchors = new Map(); // carId -> {at, su, speed}
    this._maxAgeMs = 2000;
    this._staleHoldMs = 500;
  }

  push(snapshot, receivedAt) {
    const L = this.trackLengthM;
    for (const car of snapshot.cars) {
      let entries = this.cars.get(car.id);
      let su = car.positionM;
      if (entries) {
        const prev = entries[entries.length - 1];
        if (su < prev.su - L / 2) su += L; // crossed the line since last sample
        else if (su > prev.su + L / 2) su -= L;
      }
      if (!entries) {
        entries = [];
        this.cars.set(car.id, entries);
        this.anchors.set(car.id, { at: receivedAt, su, speed: car.speedMs ?? 0 });
      }
      entries.push({ at: receivedAt, s: car.positionM, su, speed: car.speedMs ?? 0, status: car.status });
      const cutoff = receivedAt - this._maxAgeMs;
      while (entries.length > 2 && entries[0].at < cutoff) entries.shift();
    }
    // drop cars that vanished from the snapshot
    const seen = new Set(snapshot.cars.map((c) => c.id));
    for (const id of this.cars.keys()) {
      if (!seen.has(id)) {
        this.cars.delete(id);
        this.anchors.delete(id);
      }
    }
  }

  /**
   * Sample a car's track distance at `renderAt` (client clock, ms).
   * Returns { s, status } or null if the car is unknown.
   * Speed-based extrapolation from the car's anchor (see class doc):
   * next-sample clamp re-anchors, stale feed holds.
   */
  sample(carId, renderAt) {
    const entries = this.cars.get(carId);
    if (!entries || entries.length === 0) return null;
    const L = this.trackLengthM;
    const last = entries[entries.length - 1];
    let anchor = this.anchors.get(carId);
    if (!anchor) {
      anchor = { at: last.at, su: last.su, speed: last.speed };
      this.anchors.set(carId, anchor);
    }
    // Next-sample clamp: extrapolation drifted past the tolerance from the
    // newest snapshot -> the speed changed, re-anchor to the fresh baseline.
    const drifted = anchor.su + (anchor.speed * (last.at - anchor.at)) / 1000 - last.su;
    const tol = Math.max(10, Math.abs(anchor.speed) * 0.25);
    if (Math.abs(drifted) > tol) {
      anchor = { at: last.at, su: last.su, speed: last.speed };
      this.anchors.set(carId, anchor);
    }
    // Stale hold: never extrapolate more than _staleHoldMs past the feed.
    const t = Math.min(renderAt, last.at + this._staleHoldMs);
    const tt = Math.max(t, anchor.at); // before the first sample: stay put
    const s = ((anchor.su + (anchor.speed * (tt - anchor.at)) / 1000) % L + L) % L;
    return { s, status: last.status };
  }

  clear() {
    this.cars.clear();
    this.anchors.clear();
  }
}
