import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';

/**
 * End-to-end: the exact acceptance scenario from the issue — a 5-lap race
 * with 4 scripted agents driving over MCP, finishing cleanly. Agents run
 * in-process (same client stack the standalone agent processes use); the
 * server runs as a real HTTP listener.
 */
const TOTAL_LAPS = 5;
const WINDOW_SECONDS = 1; // real-time window; agents poll at 100ms

let session;
let server;
let baseUrl;
let logFile;
let runPromise;
let agentSummaries = [];

const AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: 101 },
  { profile: 'conservative', name: 'Turtle', seed: 102 },
  { profile: 'pitHeavy', name: 'PitPete', seed: 103 },
  { profile: 'random', name: 'Randy', seed: 104 },
];

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_SECONDS,
    reactiveWindowSeconds: WINDOW_SECONDS,
    tickWallDelayMs: 0,
    seed: 42,
    logFile,
    logToStdout: false,
  });
  server = createMcpHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  runPromise = session.run();

  agentSummaries = await Promise.all(
    AGENTS.map(async (a) =>
      runAgent({
        name: a.name,
        serverUrl: baseUrl,
        decide: SCRIPTED_AGENTS[a.profile].decide,
        decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
        rng: createRng(a.seed),
        pollMs: 100,
      }),
    ),
  );
  await runPromise;
}, 120000);

afterAll(async () => {
  session.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('5-lap race with 4 scripted agents (e2e over MCP)', () => {
  it('every agent connected, joined and submitted strategies', () => {
    expect(agentSummaries).toHaveLength(4);
    for (const s of agentSummaries) {
      expect(s.carId).toBeGreaterThan(0);
      expect(s.submissions).toBeGreaterThan(0);
    }
  });

  it('the race finished cleanly with all four cars', () => {
    const state = session.state();
    expect(state.phase).toBe('finished');
    expect(state.raceTimeS).toBeGreaterThan(0);

    const standings = session.standings();
    expect(standings).toHaveLength(4);
    expect(standings.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    for (const s of standings) {
      expect(s.status).toBe('FINISHED');
      expect(s.completedLaps).toBe(TOTAL_LAPS);
      expect(s.finishTimeS).toBeGreaterThan(0);
    }
    // gaps are sensible: P1 has gap 0, others positive
    expect(standings[0].gapToLeaderM).toBe(0);
    for (let i = 1; i < standings.length; i += 1) {
      expect(standings[i].gapToLeaderM).toBeGreaterThan(0);
    }
  });

  it('the decision log recorded every decision and key event', () => {
    const lines = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);

    // one window_opened per lap (5) and one window_closed per lap
    expect(types.filter((t) => t === 'window_opened').length).toBe(TOTAL_LAPS);
    expect(types.filter((t) => t === 'window_closed').length).toBe(TOTAL_LAPS);

    // each agent's decisions must be recorded by the server (agents poll at
    // 100ms vs a 1s window, so every agent must have submitted at least once)
    for (const a of AGENTS) {
      const count = lines.filter((l) => l.type === 'strategy_submitted' && l.name === a.name).length;
      expect(count, `no strategy_submitted events for agent ${a.name}`).toBeGreaterThan(0);
    }
    expect(types.filter((t) => t === 'finish').length).toBe(4);
    expect(types).toContain('race_finished');
    // pit decisions from pit-heavy or fuel logic must have been recorded as pit events or pitNow=true strategies
    const anyPitRequested = lines.some((l) => l.type === 'strategy_submitted' && l.strategy?.pitNow === true);
    const anyPitStop = lines.some((l) => l.type === 'pit_stop_enter');
    expect(anyPitRequested || anyPitStop).toBe(true);
  });

  it('standings are ordered by finish time (server-authoritative)', () => {
    const standings = session.standings();
    for (let i = 1; i < standings.length; i += 1) {
      expect(standings[i - 1].finishTimeS).toBeLessThanOrEqual(standings[i].finishTimeS + 1e-9);
    }
  });
});
