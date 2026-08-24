import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { driveWindows, closeServer, waitFor, WINDOW_BACKSTOP_S } from './helpers.js';

/**
 * Slice 2 e2e: real browser-style WebSocket spectators (Node's built-in
 * WebSocket client) watching a 5-lap scripted race over a real HTTP listener.
 *
 * Acceptance covered here: two concurrent spectators stay connected through
 * the whole race, receive self-contained 10 Hz snapshots, keep-alive pings
 * get pong replies, a mid-race reconnect gets a full state immediately, the
 * final snapshot is sent exactly once, and the real browser client class
 * (client/js/spectatorClient.js) survives a mid-race drop by reconnecting
 * and queries GET /state as its end-of-race fallback.
 *
 * Windows close on submit (driveWindows) so the race takes a couple of
 * seconds; the browser client's reconnect backoff is shortened to 100 ms in
 * the test and the wait for the drop->reconnect is event-based.
 */
const TOTAL_LAPS = 5;
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let session;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let runPromise;
let drivePromise;
let agentSummaries = [];
let spectators = []; // [{name, messages, ws, pongs}]
let clientConn = null; // the real browser client class (s4)
let clientStatuses = [];
let clientSnaps = [];

function connectSpectator(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const spec = { name, ws, messages: [], pongs: 0 };
    spectators.push(spec);
    ws.addEventListener('open', () => {
      // keep-alive ping (the ~30 s client ping in spectatorClient.js, fired
      // once immediately here for the test)
      ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'pong') spec.pongs += 1;
      spec.messages.push(msg);
    });
    ws.addEventListener('open', () => resolve(spec));
  });
}

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-spec-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S, // backstop only; windows close on submit
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 42,
    logFile,
    logToStdout: false,
  });
  server = createMcpHttpServer(session, { staticDir: clientDir });
  hub = createSpectatorHub(server, session, {
    onEvent: (e) => session.logger.log(e),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  // two spectators from the very start
  await connectSpectator('s1');
  await connectSpectator('s2');

  // s4: the actual browser client class, running in Node (built-in
  // WebSocket/fetch/EventTarget). Its socket is dropped mid-race to prove
  // the reconnect + /state fallback path end to end.
  const { SpectatorConnection } = await import('../client/js/spectatorClient.js');
  clientConn = new SpectatorConnection(wsUrl);
  clientConn.addEventListener('status', (e) => clientStatuses.push(e.detail));
  clientConn.addEventListener('snapshot', (e) => clientSnaps.push(e.detail));
  clientConn.connect();

  runPromise = session.run();
  drivePromise = driveWindows(session);

  // drop the browser client's socket once the race is in simulation
  const dropClient = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (clientSnaps.some((s) => s.phase === 'simulation')) {
        clearInterval(timer);
        clientConn.reconnectDelayMs = 100; // test: shrink the reconnect backoff
        clientConn.ws.close(); // server-side drop (as seen by the client)
        resolve();
      }
    }, 20);
    timer.unref();
  });

  // mid-race reconnect: watch s1's snapshots and join when lap 2 simulates
  const midRace = new Promise((resolve) => {
    const timer = setInterval(() => {
      const inLap2 = spectators[0].messages.some(
        (m) => m.type === 'snapshot' && m.phase === 'simulation' && m.currentLap >= 2,
      );
      if (inLap2) {
        clearInterval(timer);
        connectSpectator('s3').then(resolve);
      }
    }, 50);
    timer.unref();
  });

  agentSummaries = await Promise.all(
    [
      { profile: 'aggressive', name: 'Aggro', seed: 101 },
      { profile: 'conservative', name: 'Turtle', seed: 102 },
      { profile: 'pitHeavy', name: 'PitPete', seed: 103 },
      { profile: 'random', name: 'Randy', seed: 104 },
    ].map((a) =>
      runAgent({
        name: a.name,
        serverUrl: baseUrl,
        decide: SCRIPTED_AGENTS[a.profile].decide,
        decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
        rng: createRng(a.seed),
        pollMs: 50,
      }),
    ),
  );
  await midRace;
  await dropClient;
  // event-based wait: the browser client dropped and reconnected (100 ms
  // backoff in the test), no fixed sleep
  await waitFor(
    () => {
      const i = clientStatuses.indexOf('disconnected');
      return i >= 0 && clientStatuses[i + 1] === 'connected';
    },
    5000,
    'browser client to drop and reconnect',
  );
  await drivePromise;
  await runPromise;
  // the hub sends the final 'finished' snapshot on its next 100 ms tick;
  // wait for it to actually land (event-based, no fixed sleep)
  await waitFor(
    () => {
      const snaps = snapshots(spectators[0]);
      return snaps.length > 0 && snaps[snaps.length - 1].phase === 'finished';
    },
    5000,
    'finished snapshot to reach spectators',
  );
}, 30000);

afterAll(async () => {
  for (const spec of spectators) spec.ws.close();
  hub.close();
  session.close();
  await closeServer(server);
});

const snapshots = (spec) => spec.messages.filter((m) => m.type === 'snapshot');

describe('spectator WebSocket feed (Slice 2)', () => {
  it('every spectator got a hello with track + race config', () => {
    for (const spec of spectators) {
      const hello = spec.messages.find((m) => m.type === 'hello');
      expect(hello, `${spec.name} got no hello`).toBeTruthy();
      expect(hello.protocol).toBe(1);
      expect(hello.track.lengthM).toBe(1000);
      expect(hello.track.sectorCount).toBe(5);
      expect(hello.totalLaps).toBe(TOTAL_LAPS);
    }
  });

  it('both original spectators stayed connected through the whole race', () => {
    for (const name of ['s1', 's2']) {
      const spec = spectators.find((s) => s.name === name);
      const snaps = snapshots(spec);
      expect(snaps.length, `${name} snapshots`).toBeGreaterThan(10);
      // connected start to finish: first snapshot in setup, last finished
      expect(snaps[0].phase).toBe('setup');
      expect(snaps[snaps.length - 1].phase).toBe('finished');
    }
  });

  it('snapshots are self-contained full state', () => {
    const spec = spectators[0];
    // first in-race snapshot: all 4 cars are joined by then
    const snap = snapshots(spec).find((s) => s.phase === 'simulation');
    expect(snap, 'no simulation snapshot').toBeTruthy();
    for (const key of ['phase', 'currentLap', 'totalLaps', 'raceTimeS', 'windowRemainingS', 'track', 'cars', 'standings', 'spectators']) {
      expect(snap[key], `missing ${key}`).toBeDefined();
    }
    expect(snap.cars).toHaveLength(4);
    for (const car of snap.cars) {
      expect(car.id).toBeGreaterThan(0);
      expect(typeof car.name).toBe('string');
      expect(car.positionM).toBeGreaterThanOrEqual(0);
      expect(car.positionM).toBeLessThan(1000);
      expect(['RUNNING', 'PITTING', 'FINISHED', 'RETIRED']).toContain(car.status);
    }
    expect(snap.standings).toHaveLength(4);
  });

  it('cars move forward on the track (distance is monotonic per car)', () => {
    for (const spec of spectators.slice(0, 2)) {
      const snaps = snapshots(spec);
      const dist = new Map(); // carId -> last completedLaps*1000 + positionM
      for (const snap of snaps) {
        if (snap.phase === 'setup') continue;
        for (const car of snap.cars) {
          const d = car.completedLaps * 1000 + car.positionM;
          const prev = dist.get(car.id);
          if (prev !== undefined) {
            expect(d, `${spec.name}: car ${car.id} moved backwards (${prev} -> ${d})`).toBeGreaterThanOrEqual(prev - 1e-6);
          }
          dist.set(car.id, d);
        }
      }
      // by the end every car had travelled 5 full laps
      for (const [, d] of dist) expect(d).toBeGreaterThanOrEqual(TOTAL_LAPS * 1000 - 1e-6);
    }
  });

  it('the final snapshot is sent exactly once per spectator', () => {
    for (const spec of spectators) {
      const finished = snapshots(spec).filter((s) => s.phase === 'finished');
      expect(finished.length, `${spec.name} finished snapshots`).toBe(1);
      expect(finished[0].finished).toBe(true);
      expect(finished[0].spectators).toBeGreaterThanOrEqual(3);
    }
  });

  it('keep-alive pings get pong replies', () => {
    for (const spec of spectators.slice(0, 2)) {
      expect(spec.pongs, `${spec.name} pongs`).toBeGreaterThanOrEqual(1);
    }
  });

  it('a mid-race reconnect immediately receives hello + full snapshot', () => {
    const spec = spectators.find((s) => s.name === 's3');
    expect(spec, 's3 never connected').toBeTruthy();
    expect(spec.messages[0].type).toBe('hello');
    const first = spec.messages.find((m) => m.type === 'snapshot');
    expect(first.cars).toHaveLength(4);
    // connected mid-race, so its first snapshot is already in-race
    expect(first.phase).not.toBe('setup');
    expect(first.currentLap).toBeGreaterThanOrEqual(2);
    // it also saw the finish
    expect(snapshots(spec).some((s) => s.phase === 'finished')).toBe(true);
  });

  it('the decision log recorded spectator traffic', () => {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    expect(types.filter((t) => t === 'spectator_connected').length).toBeGreaterThanOrEqual(3);
    expect(types).toContain('spectator_final_broadcast');
  });

  it('the race itself still finished cleanly (spectators are observers)', () => {
    const standings = session.standings();
    expect(standings).toHaveLength(4);
    for (const s of standings) {
      expect(s.status).toBe('FINISHED');
      expect(s.completedLaps).toBe(TOTAL_LAPS);
    }
    expect(session.state().phase).toBe('finished');
  });

  it('the browser client class survived its mid-race drop (reconnect, then finished)', () => {
    const idx = clientStatuses.indexOf('disconnected');
    expect(idx, 'client never saw a drop').toBeGreaterThanOrEqual(0);
    expect(clientStatuses[idx + 1], 'reconnected after the drop').toBe('connected');
    const snaps = clientSnaps;
    expect(snaps.length, 'client received snapshots').toBeGreaterThan(10);
    expect(snaps.some((s) => s.phase === 'simulation'), 'client saw the race').toBe(true);
    expect(
      snaps.filter((s) => s.phase === 'finished').length,
      'client got exactly one final snapshot',
    ).toBe(1);
  });

  it('the browser client class sees /state and reconnects after the race (persistent server)', async () => {
    const { SpectatorConnection } = await import('../client/js/spectatorClient.js');
    // direct check of the fallback endpoint through the client's own code
    const state = await clientConn._fetchState();
    expect(state).toBeTruthy();
    expect(state.phase).toBe('finished');
    expect(state.finished).toBe(true);

    // MCPG-34: a client watching the finished race while the server is still
    // alive does NOT treat a socket drop as the end — it reconnects (the
    // persistent server holds the results, then opens the next session).
    const c = new SpectatorConnection(wsUrl);
    const statuses = [];
    let phase = null;
    c.addEventListener('status', (e) => statuses.push(e.detail));
    c.addEventListener('snapshot', (e) => { phase = e.detail.phase; });
    c.connect();
    await waitFor(() => phase === 'finished', 5000, 'client to see the finished state');
    c.reconnectDelayMs = 50;
    c.ws.close(); // raw-socket close: a server-side drop as seen by the client
    // (bypasses the user-initiated flag, like the mid-race drop above)
    await waitFor(
      () => {
        const i = statuses.indexOf('disconnected');
        return i >= 0 && statuses[i + 1] === 'connected';
      },
      5000,
      'client to reconnect after the post-race drop',
    );
    c.close();
  });

  it('the browser client class reports ended only when the server is gone', async () => {
    const { SpectatorConnection } = await import('../client/js/spectatorClient.js');
    // obtain a guaranteed-dead port: listen once, then close the listener
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const c = new SpectatorConnection(`ws://127.0.0.1:${deadPort}/spectate`);
    c.reconnectDelayMs = 50;
    c.endedAfterFails = 3; // test: shrink the ~10-failure threshold
    const statuses = [];
    c.addEventListener('status', (e) => statuses.push(e.detail));
    c.connect();
    await waitFor(() => statuses.includes('ended'), 5000, 'client to report ended');
    expect(statuses.slice(0, statuses.indexOf('ended') + 1).join(','), 'ended after repeated failures')
      .toBe('disconnected,disconnected,ended');
    // Retries keep running after 'ended' — a redeployed server would flip
    // the status back to 'connected'.
    await waitFor(
      () => statuses.filter((st) => st === 'ended').length >= 2,
      2000,
      'background retries to continue after ended',
    );
    c.close(); // stop the background retries
  });
});
