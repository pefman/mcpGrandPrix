import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceOrchestrator } from '../src/server/raceOrchestrator.js';
import { SEASON_POINTS } from '../src/season.js';
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

let tmpDir;
let orchestrator;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let seasonFile;
let session1;
let session2;
let spec = null; // raw WS spectator: { ws, messages }
let clientConn = null; // the real browser client class
let clientResets = [];
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-persist-'));
  logFile = path.join(tmpDir, 'persistence.jsonl');
  seasonFile = path.join(tmpDir, 'season.json'); // MCPG-49

  orchestrator = new RaceOrchestrator({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S, // backstop only; windows close on submit
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 42,
    resultsHoldSeconds: HOLD_S,
    pendingGraceSeconds: GRACE_S,
    voteWindowSeconds: 0, // voting is MCPG-28; this test covers persistence only
    logFile,
    seasonFile, // MCPG-49: championship season persists in the temp dir
    logToStdout: false,
  });

  orchestrator.run(); // fire and forget; opens session 1 synchronously, resolves on shutdown
  session1 = orchestrator.session;

  server = createMcpHttpServer(orchestrator);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  hub = createSpectatorHub(server, orchestrator.session, {
    getSession: () => orchestrator.session,
    onEvent: (e) => orchestrator.logger.log(e),
  });

  orchestrator.onSession = () => hub.reset();
  orchestrator.onRaceComplete = () => hub.finalize();

  await connectSpectator();

  const { SpectatorConnection } = await import('../client/js/spectatorClient.js');
  clientConn = new SpectatorConnection(wsUrl);
  clientConn.addEventListener('reset', (e) => clientResets.push(e.detail));
  clientConn.connect();

  const race1Promises = RACE1_AGENTS.map((a) => startAgent(a));
  const drive1 = driveWindows(session1);

  // Mid-race: the grid is no longer in setup, so joins must queue, not fail.
  // 'Late' is a REAL MCP agent process: it queues through its own transport
  // session and later claims its seat with that same session id (MCPG-58).
  // 'Ghost' is a plain joinAgent call that never re-joins (seat expires).
  await waitFor(() => orchestrator.state().phase !== 'setup', 15000, 'race 1 to leave setup');
  const latePromise = runAgent({
    name: 'Late',
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS.random.decide,
    decideReactive: SCRIPTED_AGENTS.random.decideReactive,
    rng: createRng(208),
    pollMs: 50,
    onLog: (line) => lateAgentLog.push(line),
  });
  // Deterministic FIFO order: wait until Late's own join landed in the
  // queue before enqueueing Ghost behind it.
  await waitFor(
    () => orchestrator.state().pending?.some((p) => p.name === 'Late'),
    15000,
    'Late to land in the pending queue',
  );
  ghostRes = orchestrator.joinAgent('Ghost', 'test-session-ghost');

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

/**
 * MCPG-49 e2e: two back-to-back finished sessions accumulate championship
 * season points — awarded once per finished race from the final standings,
 * persisted to the season file, logged, and visible via the read-only
 * `get_season_standings` MCP tool and the spectator snapshot's `season`
 * field (no new WS message type).
 */
describe('championship season accumulates across back-to-back races (MCPG-49)', () => {
  // Expected totals recomputed from the two finished sessions' standings.
  const expectedTotals = () => {
    const totals = {};
    for (const session of [session1, session2]) {
      for (const e of session.standings()) {
        const t = (totals[e.name] ??= { points: 0, wins: 0, races: 0, dnf: 0 });
        t.races += 1;
        if (e.status === 'FINISHED') {
          if (e.position <= SEASON_POINTS.length) t.points += SEASON_POINTS[e.position - 1];
          if (e.position === 1) t.wins += 1;
        } else if (e.status === 'RETIRED') {
          t.dnf += 1;
        }
      }
    }
    return totals;
  };

  it('awards F1 top-8 points once per finished race and accumulates', () => {
    const view = orchestrator.seasonView();
    const totals = expectedTotals();
    // All eight starters across the two races (no overlap), one race each.
    expect(view).toHaveLength(8);
    expect(Object.keys(totals)).toHaveLength(8);
    for (const row of view) {
      expect(totals[row.name], `season has ${row.name}`).toBeTruthy();
      expect(row.points).toBe(totals[row.name].points);
      expect(row.races).toBe(1);
      expect(row.wins).toBe(totals[row.name].wins);
      expect(row.dnf).toBe(totals[row.name].dnf);
    }
    // Ranked by points desc (tiebreaks covered by unit tests).
    for (let i = 1; i < view.length; i++) {
      expect(view[i - 1].points).toBeGreaterThanOrEqual(view[i].points);
    }
    expect(view[0].points).toBe(Math.max(...Object.values(totals).map((t) => t.points)));
    // A season leader exists (the race-1 winner at least).
    expect(view[0].wins).toBeGreaterThanOrEqual(1);
  });

  it('logs season_points_awarded once per finished race with per-car awards', () => {
    const awarded = logLines().filter((l) => l.type === 'season_points_awarded');
    expect(awarded).toHaveLength(2); // exactly one per finished session, none for the open session 3
    expect(awarded[0].raceSeq).toBe(1);
    expect(awarded[1].raceSeq).toBe(2);

    const r2 = awarded[1].awards;
    expect(r2.map((a) => a.name).sort()).toEqual(['Late', 'R2B', 'R2C', 'R2D']);
    for (const a of r2) {
      const e = session2.standings().find((x) => x.name === a.name);
      const want = e.status === 'FINISHED' && e.position <= SEASON_POINTS.length ? SEASON_POINTS[e.position - 1] : 0;
      expect(a.pointsEarned).toBe(want);
    }
  });

  it('persists the season file and a fresh server loads it at startup', () => {
    const onDisk = JSON.parse(fs.readFileSync(seasonFile, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.drivers).toEqual(orchestrator.season.drivers);
    // A fresh orchestrator on the same file resumes the exact same season.
    const fresh = new RaceOrchestrator({ seed: 42, logToStdout: false, seasonFile });
    expect(fresh.season).toEqual(orchestrator.season);
  });

  it('serves the season via MCP get_season_standings (read-only, idempotent)', async () => {
    const client = new Client({ name: 'season-tool-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    const first = await client.callTool({ name: 'get_season_standings', arguments: {} });
    const second = await client.callTool({ name: 'get_season_standings', arguments: {} });
    await client.close();
    expect(JSON.parse(first.content[0].text)).toEqual(orchestrator.seasonView());
    expect(second).toEqual(first); // same answer twice, no state change
  });

  it('broadcasts the season inside the existing snapshot (no new WS message type)', () => {
    const snaps = spec.messages.filter((m) => m.type === 'snapshot');
    // Fresh season: the early snapshots carry an empty ranking.
    expect(snaps.filter((s) => Array.isArray(s.season) && s.season.length === 0).length).toBeGreaterThan(0);
    // Settled: the last finished snapshot carries the final totals.
    const finished = snaps.filter((s) => s.phase === 'finished');
    expect(finished.length).toBeGreaterThan(0);
    expect(finished[finished.length - 1].season).toEqual(orchestrator.seasonView());
  });
});

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
    const lines = logLines();
    const queued = lines.filter((l) => l.type === 'agent_queued');
    expect(queued).toHaveLength(2);
    // Late queued through its own MCP transport session; Ghost via a direct call.
    expect(queued[0]).toMatchObject({ name: 'Late', position: 1, raceSeq: 1 });
    expect(typeof queued[0].agentId).toBe('string');
    expect(queued[1]).toMatchObject({ name: 'Ghost', position: 2, raceSeq: 1, agentId: 'test-session-ghost' });
    expect(lines.filter((l) => l.type === 'join_failed')).toHaveLength(0);
    // The MCP agent that queued itself logged the queue position too.
    expect(lateAgentLog.some((l) => l.type === 'agent_queued' && l.position === 1)).toBe(true);
  });

  it('lets the queued agent claim its seat in session 2 and expires the ghost', () => {
    const lines = logLines();
    const promoted = lines.filter((l) => l.type === 'agent_promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ name: 'Late', raceSeq: 2, carId: lateSummary.carId });
    // The claim was made by the SAME session id that queued (MCPG-58).
    expect(promoted[0].agentId).toEqual(logLines().find((l) => l.type === 'agent_queued' && l.name === 'Late').agentId);

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
