import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import {
  aggressiveReactive,
  conservativeReactive,
  pitHeavyReactive,
  randomReactive,
} from '../src/sim/strategies.js';
import { allowedActionsFor, parseReactiveAction } from '../src/sim/reactive.js';

describe('reactive action helpers', () => {
  it('allowedActionsFor covers MVP triggers', () => {
    expect(allowedActionsFor('close_battle', 'attacker')).toEqual(['attack', 'hold']);
    expect(allowedActionsFor('close_battle', 'defender')).toEqual(['defend', 'hold']);
    expect(allowedActionsFor('critical_tire_wear', 'subject')).toEqual(['pit_now', 'hold']);
    expect(allowedActionsFor('pit_opportunity', 'subject')).toEqual(['pit_now', 'hold']);
  });

  it('parseReactiveAction rejects illegal types for the window', () => {
    const { errors } = parseReactiveAction({ type: 'attack' }, ['pit_now', 'hold']);
    expect(errors[0]).toMatch(/not allowed/);
    const ok = parseReactiveAction({ type: 'pit_now' }, ['pit_now', 'hold']);
    expect(ok.errors).toEqual([]);
    expect(ok.action.type).toBe('pit_now');
  });

  it('scripted reactive policies return legal actions', () => {
    const rng = createRng(9);
    const window = {
      trigger: 'close_battle',
      roles: { 1: 'attacker', 2: 'defender' },
      allowedByCar: { 1: ['attack', 'hold'], 2: ['defend', 'hold'] },
    };
    const atk = aggressiveReactive({ car: { id: 1 } }, window, rng);
    expect(['attack', 'hold']).toContain(atk.type);
    const def = aggressiveReactive({ car: { id: 2 } }, window, rng);
    expect(['defend', 'hold']).toContain(def.type);

    const tireWin = {
      trigger: 'critical_tire_wear',
      roles: { 3: 'subject' },
      allowedByCar: { 3: ['pit_now', 'hold'] },
    };
    expect(pitHeavyReactive({ car: { id: 3 } }, tireWin, rng).type).toBe('pit_now');
    expect(conservativeReactive({ car: { id: 3 } }, tireWin, rng).type).toBe('pit_now');
    expect(['pit_now', 'hold']).toContain(randomReactive({ car: { id: 3 } }, tireWin, rng).type);
  });
});

/**
 * Acceptance (MCPG-15): a 10-lap scripted race produces ≥2 reactive windows,
 * every trigger/response is logged, and the race finishes cleanly.
 */
const TOTAL_LAPS = 10;
const WINDOW_SECONDS = 0.8;

let session;
let server;
let baseUrl;
let logFile;
let runPromise;
let agentSummaries = [];

const AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: 201 },
  { profile: 'conservative', name: 'Turtle', seed: 202 },
  { profile: 'pitHeavy', name: 'PitPete', seed: 203 },
  { profile: 'random', name: 'Randy', seed: 204 },
];

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-rw-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_SECONDS,
    reactiveWindowSeconds: WINDOW_SECONDS,
    tickWallDelayMs: 0,
    seed: 77,
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
        pollMs: 80,
      }),
    ),
  );
  await runPromise;
}, 180000);

afterAll(async () => {
  session.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('10-lap race with reactive windows (MCPG-15 acceptance)', () => {
  it('finishes cleanly with all four cars', () => {
    const state = session.state();
    expect(state.phase).toBe('finished');
    const standings = session.standings();
    expect(standings).toHaveLength(4);
    for (const s of standings) {
      expect(s.status).toBe('FINISHED');
      expect(s.completedLaps).toBe(TOTAL_LAPS);
    }
  });

  it('opens at least 2 reactive windows and logs every decision', () => {
    const lines = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const opened = lines.filter((l) => l.type === 'reactive_window_opened');
    const closed = lines.filter((l) => l.type === 'reactive_window_closed');
    expect(opened.length, 'expected ≥2 reactive windows in a 10-lap race').toBeGreaterThanOrEqual(2);
    expect(closed.length).toBe(opened.length);

    // Every opened window has a logged response path (submitted and/or defaulted).
    for (const w of opened) {
      const responses = lines.filter(
        (l) =>
          (l.type === 'reactive_action_submitted' || l.type === 'reactive_action_defaulted') &&
          l.windowId === w.windowId,
      );
      expect(responses.length, `window ${w.windowId} has no logged actions`).toBeGreaterThanOrEqual(1);
      expect(responses.length).toBe(w.carIds.length);
    }

    // Triggers are from the MVP set.
    for (const w of opened) {
      expect(['close_battle', 'critical_tire_wear', 'pit_opportunity']).toContain(w.trigger);
    }
  });

  it('scripted agents participated (strategy + reactive when affected)', () => {
    expect(agentSummaries).toHaveLength(4);
    for (const s of agentSummaries) {
      expect(s.submissions).toBeGreaterThan(0);
    }
    // At least one agent should have answered a reactive window over MCP.
    const anyReactive = agentSummaries.some((s) => s.reactiveSubmissions > 0);
    expect(anyReactive).toBe(true);
  });
});
