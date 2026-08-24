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
 * Per-car snapshot buffer for interpolation. The client renders ~150 ms
 * behind the server's clock so it can always interpolate between the two
 * most recent snapshots instead of extrapolating (Leclerc, MCPG-12 Q4).
 */
export class CarPositionBuffer {
  constructor(trackLengthM) {
    this.trackLengthM = trackLengthM;
    this.cars = new Map(); // carId -> [{at, s, status}]
    this._maxAgeMs = 2000;
  }

  push(snapshot, receivedAt) {
    for (const car of snapshot.cars) {
      let entries = this.cars.get(car.id);
      if (!entries) {
        entries = [];
        this.cars.set(car.id, entries);
      }
      entries.push({ at: receivedAt, s: car.positionM, status: car.status });
      const cutoff = receivedAt - this._maxAgeMs;
      while (entries.length > 2 && entries[0].at < cutoff) entries.shift();
    }
    // drop cars that vanished from the snapshot
    const seen = new Set(snapshot.cars.map((c) => c.id));
    for (const id of this.cars.keys()) {
      if (!seen.has(id)) this.cars.delete(id);
    }
  }

  /**
   * Sample a car's track distance at `renderAt` (client clock, ms).
   * Returns { s, status } or null if the car is unknown.
   * No extrapolation: before the oldest or after the newest sample, the
   * nearest sample is returned (cars stay put while the buffer catches up).
   */
  sample(carId, renderAt) {
    const entries = this.cars.get(carId);
    if (!entries || entries.length === 0) return null;
    const L = this.trackLengthM;
    if (renderAt <= entries[0].at) {
      const e = entries[0];
      return { s: e.s, status: e.status };
    }
    const last = entries[entries.length - 1];
    if (renderAt >= last.at) return { s: last.s, status: last.status };
    for (let i = 0; i < entries.length - 1; i += 1) {
      const a = entries[i];
      const b = entries[i + 1];
      if (renderAt >= a.at && renderAt <= b.at) {
        let sb = b.s;
        if (sb < a.s - L / 2) sb += L; // crossed the line between samples
        const t = (renderAt - a.at) / Math.max(1e-6, b.at - a.at);
        let s = a.s + (sb - a.s) * t;
        if (s >= L) s -= L;
        return { s, status: b.status };
      }
    }
    return { s: last.s, status: last.status };
  }

  clear() {
    this.cars.clear();
  }
}
