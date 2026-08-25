import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceOrchestrator } from '../src/server/raceOrchestrator.js';
import { DecisionLogger } from '../src/logging/decisionLogger.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { closeServer, driveWindows, waitFor, WINDOW_BACKSTOP_S } from './helpers.js';

/**
 * MCPG-40 regression: the server crash-looped on `main` because
 * `createSpectatorHub` dereferenced `initialSession.state()` at construction
 * — but with a persistent orchestrator (MCPG-34) `main.js` passes
 * `orchestrator.session`, which is null until `run()` opens the first
 * session. The hub must construct, tick, and serve a spectator with a null
 * session, then serve normally once the orchestrator opens session 1.
 */
const TOTAL_LAPS = 2;

let orchestrator;
let logger;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let drivePromise;
let specMessages = [];
let specWs = null;

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-hubboot-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  orchestrator = new RaceOrchestrator({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S, // backstop only; windows close on submit
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 42,
    resultsHoldSeconds: 0.3,
    voteWindowSeconds: 0,
    logger: new DecisionLogger({ file: logFile, stdout: false }),
    onSession: () => hub?.reset(),
    onRaceComplete: () => hub?.finalize(),
  });
  logger = orchestrator.logger;

  // The exact main.js order: build the HTTP server and the spectator hub
  // with a NULL current session, only then kick off the rotation loop.
  server = createMcpHttpServer(orchestrator);
  expect(orchestrator.session).toBeNull();
  hub = createSpectatorHub(server, orchestrator.session, {
    getSession: () => orchestrator.session,
    onEvent: (event) => logger.log(event),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  orchestrator.run(); // opens session 1 synchronously

  // A spectator connecting right after boot (the session now exists, but
  // the hub was built before it did) must still get hello + a live snapshot.
  await new Promise((resolve) => {
    specWs = new WebSocket(wsUrl);
    specWs.addEventListener('message', (ev) => specMessages.push(JSON.parse(ev.data)));
    specWs.addEventListener('open', () => resolve());
  });
  await waitFor(() => specMessages.some((m) => m.type === 'hello'), 2000, 'hello');

  const agents = [
    { profile: 'aggressive', name: 'A1', seed: 71 },
    { profile: 'conservative', name: 'A2', seed: 72 },
    { profile: 'pitHeavy', name: 'A3', seed: 73 },
    { profile: 'random', name: 'A4', seed: 74 },
  ];
  await Promise.all(agents.map((a) => runAgent({
    name: a.name,
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS[a.profile].decide,
    decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
    rng: createRng(a.seed),
    pollMs: 50,
  })));
  drivePromise = driveWindows(orchestrator.session);
  await waitFor(() => orchestrator.session.state().phase === 'finished', 30000, 'race to finish');
}, 60000);

afterAll(async () => {
  orchestrator.shutdown('test-teardown');
  await drivePromise.catch(() => {});
  hub.close();
  specWs?.close();
  await closeServer(server);
  logger.close();
});

describe('spectator hub boots before the orchestrator has a session (MCPG-40)', () => {
  it('constructed with a null session and ran the race without a crash', () => {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === 'server_error')).toBe(false);
    expect(lines.some((l) => l.type === 'race_start')).toBe(true);
  });

  it('served the late-arriving spectator (hello + snapshots) after session 1 opened', () => {
    const hellos = specMessages.filter((m) => m.type === 'hello');
    expect(hellos.length).toBeGreaterThanOrEqual(1);
    // The hello carries the session's raceId: proof the hub read the CURRENT
    // session (null at construction time) rather than a stale bound one.
    expect(hellos[0].raceId).toBe(orchestrator.session.raceId);
    const snaps = specMessages.filter((m) => m.type === 'snapshot');
    expect(snaps.length, 'spectator kept receiving snapshots').toBeGreaterThan(5);
  });

  it('sent the final finished snapshot exactly once', () => {
    const finishedSnaps = specMessages.filter((m) => m.type === 'snapshot' && m.finished);
    expect(finishedSnaps, 'final snapshot delivered').toHaveLength(1);
    const finalEvents = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === 'spectator_final_broadcast');
    expect(finalEvents).toHaveLength(1);
  });
});
