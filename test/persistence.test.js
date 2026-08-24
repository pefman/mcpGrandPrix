import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceOrchestrator } from '../src/server/raceOrchestrator.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { driveWindows, closeServer, waitFor, WINDOW_BACKSTOP_S } from './helpers.js';

/**
 * MCPG-34 e2e: the server persists across races, and an agent that arrives
 * outside `setup` is not rejected — it is queued (FIFO) and claims a seat in
 * the next session.
 *
 * Scenario (2-lap races, 0 ms tick delay, windows close on submit):
 *   1. Four scripted agents race session 1 over MCP.
 *   2. Mid-race 1, 'Late' (a real MCP agent process) and 'Ghost' (a plain
 *      joinAgent call) join — both land in the pending queue (no join_failed).
 *   3. After the results hold, session 2 opens. 'Late' polls for setup and
 *      re-joins to claim its seat (agent_promoted). 'Ghost' never re-joins,
 *      so its seat expires when the grace clock passes (queue_expired) —
 *      which is also what releases the auto-start gate: the race cannot
 *      start while queued seats are still claimable.
 *   4. Three fresh agents join session 2's setup directly; the race finishes
 *      cleanly. The rotation then continues into session 3 on its own.
 *
 * Spectators (raw WS + the real browser client class) stay connected across
 * the rotation: the hub re-broadcasts hello + snapshot with the new raceId,
 * and the client class emits a `reset` event for the scene to rebuild.
 *
 * Wall-clock budget: hold 0.3 s + grace 2 s + two 2-lap races ≈ under 10 s.
 */
const TOTAL_LAPS = 2;
const GRACE_S = 2; // > Late's 1 s re-join poll; Ghost never re-joins
const HOLD_S = 0.3;

const RACE1_AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: 201 },
  { profile: 'conservative', name: 'Turtle', seed: 202 },
  { profile: 'pitHeavy', name: 'PitPete', seed: 203 },
  { profile: 'random', name: 'Randy', seed: 204 },
];
const RACE2_AGENTS = [
  { profile: 'aggressive', name: 'R2B', seed: 205 },
  { profile: 'conservative', name: 'R2C', seed: 206 },
  { profile: 'pitHeavy', name: 'R2D', seed: 207 },
];

let orchestrator;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let session1;
let session2;
let spec = null; // raw WS spectator: { ws, messages }
let clientConn = null; // the real browser client class
let clientResets = [];
let lateRes;
let ghostRes;
let lateSummary;
let race1Summaries = [];
let lateAgentLog = [];
let tSetup2 = 0;
let tRace2Start = 0;

function connectSpectator() {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    spec = { ws, messages: [] };
    ws.addEventListener('message', (ev) => spec.messages.push(JSON.parse(ev.data)));
    ws.addEventListener('open', () => resolve(spec));
  });
}

function startAgent(a) {
  return runAgent({
    name: a.name,
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS[a.profile].decide,
    decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
    rng: createRng(a.seed),
    pollMs: 50,
  });
}

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-persist-'));
  logFile = path.join(tmpDir, 'persistence.jsonl');

  orchestrator = new RaceOrchestrator({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S, // backstop only; windows close on submit
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 42,
    resultsHoldSeconds: HOLD_S,
    pendingGraceSeconds: GRACE_S,
    logFile,
    logToStdout: false,
    onSession: () => hub.reset(),
    onRaceComplete: () => hub.finalize(),
  });

  server = createMcpHttpServer(orchestrator);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  hub = createSpectatorHub(server, orchestrator, {
    onEvent: (e) => orchestrator.logger.log(e),
  });

  orchestrator.run(); // fire and forget; opens session 1 synchronously, resolves on shutdown
  session1 = orchestrator.session;

  await connectSpectator();

  const { SpectatorConnection } = await import('../client/js/spectatorClient.js');
  clientConn = new SpectatorConnection(wsUrl);
  clientConn.addEventListener('reset', (e) => clientResets.push(e.detail));
  clientConn.connect();

  const race1Promises = RACE1_AGENTS.map((a) => startAgent(a));
  const drive1 = driveWindows(session1);

  // Mid-race: the grid is no longer in setup, so joins must queue, not fail.
  await waitFor(() => orchestrator.state().phase !== 'setup', 15000, 'race 1 to leave setup');
  lateRes = orchestrator.joinAgent('Late');
  ghostRes = orchestrator.joinAgent('Ghost');
  const latePromise = runAgent({
    name: 'Late',
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS.random.decide,
    decideReactive: SCRIPTED_AGENTS.random.decideReactive,
    rng: createRng(208),
    pollMs: 50,
    onLog: (line) => lateAgentLog.push(line),
  });

  await drive1;
  race1Summaries = await Promise.all(race1Promises);

  // Session 2 opens after the results hold.
  await waitFor(() => orchestrator.state().phase === 'setup', 10000, 'session 2 to open');
  tSetup2 = Date.now();
  session2 = orchestrator.session;
  const drive2 = driveWindows(session2);
  const r2Promises = RACE2_AGENTS.map((a) => startAgent(a));
  await waitFor(() => session2.sim.phase !== 'setup', 15000, 'race 2 to start');
  tRace2Start = Date.now();

  await Promise.all([drive2, latePromise, ...r2Promises]);
  lateSummary = await latePromise;

  // The rotation does not stop at two sessions.
  await waitFor(() => orchestrator.raceSeq >= 3, 5000, 'rotation to continue into session 3');
}, 60000);

afterAll(async () => {
  orchestrator.shutdown('test-teardown');
  await new Promise((r) => setTimeout(r, 100)); // let the session loop wind down
  hub.close();
  spec.ws.close();
  clientConn.close();
  await closeServer(server);
});

function logLines() {
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('persistent server with a FIFO pending queue (MCPG-34)', () => {
  it('keeps the same server and spectators alive across two full races', () => {
    expect(session2).not.toBe(session1);
    expect(orchestrator.raceSeq).toBeGreaterThanOrEqual(3);

    for (const [label, session, names] of [
      ['race 1', session1, RACE1_AGENTS.map((a) => a.name)],
      ['race 2', session2, ['Late', ...RACE2_AGENTS.map((a) => a.name)]],
    ]) {
      const standings = session.standings();
      expect(standings, `${label} standings`).toHaveLength(4);
      for (const s of standings) {
        expect(s.status, `${label}: ${s.name}`).toBe('FINISHED');
        expect(s.completedLaps, `${label}: ${s.name} laps`).toBe(TOTAL_LAPS);
      }
      for (const n of names) expect(standings.map((s) => s.name), `${label} includes ${n}`).toContain(n);
    }
  });

  it('queued late joins instead of rejecting them (no join_failed, FIFO order)', () => {
    expect(lateRes.status).toBe('queued');
    expect(lateRes.position).toBe(1);
    expect(ghostRes.status).toBe('queued');
    expect(ghostRes.position).toBe(2);

    const lines = logLines();
    const queued = lines.filter((l) => l.type === 'agent_queued');
    expect(queued).toHaveLength(2);
    expect(queued[0]).toMatchObject({ name: 'Late', position: 1, raceSeq: 1 });
    expect(queued[1]).toMatchObject({ name: 'Ghost', position: 2, raceSeq: 1 });
    expect(lines.filter((l) => l.type === 'join_failed')).toHaveLength(0);
    // The MCP agent that queued itself logged the queue position too.
    expect(lateAgentLog.some((l) => l.type === 'agent_queued' && l.position === 1)).toBe(true);
  });

  it('lets the queued agent claim its seat in session 2 and expires the ghost', () => {
    const lines = logLines();
    const promoted = lines.filter((l) => l.type === 'agent_promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ name: 'Late', raceSeq: 2, carId: lateSummary.carId });

    const expired = lines.filter((l) => l.type === 'queue_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ names: ['Ghost'], raceSeq: 2 });

    // ...and Late actually raced: its car finished session 2.
    const lateStanding = session2.standings().find((s) => s.carId === lateSummary.carId);
    expect(lateStanding).toBeTruthy();
    expect(lateStanding.name).toBe('Late');
    expect(lateStanding.status).toBe('FINISHED');
    expect(lateStanding.completedLaps).toBe(TOTAL_LAPS);
  });

  it('held the auto-start gate until the queued seats were settled', () => {
    // The gate stays closed while any seat is still claimable: Ghost's seat
    // only expires when the grace clock (GRACE_S from session open) passes,
    // so race 2 must start at least GRACE_S after setup opened.
    expect(tRace2Start - tSetup2, 'gate held for the full grace window').toBeGreaterThanOrEqual(GRACE_S * 1000 - 200);

    // Log order: both queued before the new session opened, Late claimed
    // during setup, Ghost expired just before the race could start.
    const lines = logLines();
    const idx = (type, name) => lines.findIndex((l) => l.type === type && (name === undefined || l.name === name));
    const iQueuedLate = idx('agent_queued', 'Late');
    const iNextSession = lines.findIndex((l) => l.type === 'next_session_scheduled' && l.raceSeq === 2);
    const iPromoted = idx('agent_promoted', 'Late');
    const iExpired = lines.findIndex((l) => l.type === 'queue_expired');
    const iRaceStart2 = iNextSession + lines.slice(iNextSession).findIndex((l) => l.type === 'race_start');
    expect(iQueuedLate).toBeGreaterThanOrEqual(0);
    expect(iNextSession).toBeGreaterThan(iQueuedLate);
    expect(iPromoted).toBeGreaterThan(iNextSession);
    expect(iExpired).toBeGreaterThan(iPromoted);
    expect(iRaceStart2).toBeGreaterThan(iExpired);
  });

  it('broadcast the pending queue to spectators and reset them on rotation', () => {
    // hello on connect, then one per session-open reset: r1, r2, r3...
    const hellos = spec.messages.filter((m) => m.type === 'hello');
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    expect(hellos[0].raceId).toBe(session1.raceId);
    const r2Idx = hellos.findIndex((h) => h.raceId === session2.raceId);
    expect(r2Idx, 'a hello for the new session arrived after the first').toBeGreaterThan(0);

    const snaps = spec.messages.filter((m) => m.type === 'snapshot');
    const withBothQueued = snaps.filter((s) =>
      s.pending?.some((p) => p.name === 'Late') && s.pending?.some((p) => p.name === 'Ghost'),
    );
    expect(withBothQueued.length, 'spectators saw the pending queue during race 1').toBeGreaterThan(0);

    // The browser client class detected the rotation (and each further one)
    // and asked the scene to reset.
    expect(clientResets.length).toBeGreaterThanOrEqual(1);
    expect(clientResets[0].raceId).toBe(session2.raceId);
    for (let i = 1; i < clientResets.length; i++) {
      expect(clientResets[i].raceId).not.toBe(clientResets[i - 1].raceId); // each reset is a strictly new race
    }
  });

  it('shuts down gracefully (shutting_down, not server_error)', async () => {
    orchestrator.shutdown('test-teardown');
    await new Promise((r) => setTimeout(r, 100));
    const lines = logLines();
    const last = lines[lines.length - 1];
    expect(last.type).toBe('shutting_down');
    expect(last.signal).toBe('test-teardown');
  });
});
