import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read once by src/config.js at import time: keep the auto-start gate closed
// for this whole file so grid joins stay open no matter how many cars land.
vi.hoisted(() => {
  process.env.MIN_AGENTS = '99';
});

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpHttpServer } = await import('../src/server/http.js');
const { RaceOrchestrator } = await import('../src/server/raceOrchestrator.js');
const { DecisionLogger } = await import('../src/logging/decisionLogger.js');
const { closeServer } = await import('./helpers.js');

/**
 * MCPG-58 regression: driver identity is keyed by the MCP transport session,
 * not the display name. Four sessions that join with the identical premade
 * harness name must get four distinct cars (ids + liveries), a session that
 * re-joins must get its own car back, and the pending queue must be keyed by
 * session id too — two queued sessions with the same requested name stay
 * distinct and both claim their seats in the next session.
 */

const connect = async (label, baseUrl) => {
  const client = new Client({ name: label, version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  return client;
};

const call = async (client, tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  return JSON.parse(res.content[0].text);
};

describe('join identity is bound to the MCP session (MCPG-58)', () => {
  let orchestrator;
  let server;
  let baseUrl;
  let clients = [];

  beforeAll(async () => {
    orchestrator = new RaceOrchestrator({
      totalLaps: 2,
      strategyWindowSeconds: 30,
      reactiveWindowSeconds: 5,
      tickWallDelayMs: 0,
      seed: 7,
      logToStdout: false,
      voteWindowSeconds: 0,
      resultsHoldSeconds: 0,
    });
    server = createMcpHttpServer(orchestrator);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    orchestrator.run(); // opens session 1 synchronously; MIN_AGENTS keeps it in setup
  });

  afterAll(async () => {
    orchestrator.shutdown('test-teardown');
    await Promise.allSettled(clients.map((c) => c.close()));
    await closeServer(server);
  });

  it('4 concurrent joins with the SAME harness name from 4 transports -> 4 cars', async () => {
    // Promise.all preserves result order, so pairs stay (client, response).
    const pairs = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const c = await connect(`harness-${i}`, baseUrl);
        const r = await call(c, 'join_race', { name: 'opencode' });
        return [c, r];
      }),
    );
    clients = pairs.map((p) => p[0]);
    const joined = pairs.map((p) => p[1]);
    // four distinct carIds, one per session — never one shared car
    expect(new Set(joined.map((r) => r.carId)).size).toBe(4);
    // every response unambiguously says who you are
    for (const r of joined) {
      expect(r.requestedName).toBe('opencode');
      expect(r.youAre).toContain(`carId ${r.carId}`);
      expect(r.track.id).toBeTruthy();
    }
    // suffixed display names keep the grid readable
    expect([...joined].sort((a, b) => a.gridPosition - b.gridPosition).map((r) => r.name)).toEqual([
      'opencode',
      'opencode#2',
      'opencode#3',
      'opencode#4',
    ]);
    // unique liveries (MCPG-33) and unique grid slots
    expect(new Set(joined.map((r) => r.color)).size).toBe(4);
    expect(new Set(joined.map((r) => r.gridPosition)).size).toBe(4);

    const cars = orchestrator.session.sim.cars;
    expect(cars).toHaveLength(4);
    expect(new Set(cars.map((c) => c.agentId)).size).toBe(4);

    // re-joining from an existing session returns ITS car, nobody else's
    const mine = await call(clients[2], 'join_race', { name: 'opencode' });
    expect(mine.carId).toBe(joined[2].carId);
    const stateAfterRejoin = await call(clients[3], 'get_race_state', {});
    expect(stateAfterRejoin.cars).toHaveLength(4);
  });
});

describe('pending queue is keyed by session id (MCPG-58)', () => {
  it('same-name sessions queue distinctly and claim their seats in the next session', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-joinid-'));
    const orchestrator = new RaceOrchestrator({
      totalLaps: 2,
      strategyWindowSeconds: 30,
      reactiveWindowSeconds: 5,
      tickWallDelayMs: 0,
      seed: 11,
      logToStdout: false,
      voteWindowSeconds: 0,
      resultsHoldSeconds: 0,
      pendingGraceSeconds: 10,
      logFile: path.join(tmpDir, 'join.jsonl'),
    });

    // No run() yet: no session exists, so every join lands in the pending queue.
    const a = orchestrator.joinAgent('opencode', 'session-A');
    expect(a).toMatchObject({ status: 'queued', name: 'opencode', requestedName: 'opencode', position: 1 });

    // Same session again -> same queue entry, same position (re-confirm).
    expect(orchestrator.joinAgent('other-name', 'session-A'))
      .toMatchObject({ status: 'queued', name: 'opencode', position: 1 });

    // Different session, same requested name -> its own entry, suffixed display name.
    const b = orchestrator.joinAgent('opencode', 'session-B');
    expect(b).toMatchObject({ status: 'queued', name: 'opencode#2', requestedName: 'opencode', position: 2 });
    expect(orchestrator.pendingView().map((p) => p.name)).toEqual(['opencode', 'opencode#2']);

    // Open session 1; both entries were promised this session (raceSeq 1).
    orchestrator.run();
    expect(orchestrator.raceSeq).toBe(1);
    expect(orchestrator.session.sim.phase).toBe('setup');

    // Each session claims ITS seat during setup — by session id, regardless
    // of the display name it asks for now.
    const claimA = orchestrator.joinAgent('Whatever-A', 'session-A');
    expect(claimA).toMatchObject({ status: 'joined', claimedFromQueue: true });
    expect(claimA.car.name).toBe('Whatever-A');
    const claimB = orchestrator.joinAgent('Whatever-B', 'session-B');
    expect(claimB).toMatchObject({ status: 'joined', claimedFromQueue: true });

    const cars = orchestrator.session.sim.cars;
    expect(cars.map((c) => c.agentId)).toEqual(['session-A', 'session-B']);
    expect(cars.map((c) => c.name)).toEqual(['Whatever-A', 'Whatever-B']);
    expect(orchestrator.pendingView()).toEqual([]);

    orchestrator.shutdown('test-teardown');
  });
});

describe('DecisionLogger stamps wall-clock ts on every line (MCPG-58)', () => {
  it('adds ts without touching the event fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-logts-'));
    const file = path.join(tmpDir, 'ts.jsonl');
    const logger = new DecisionLogger({ file, stdout: false });
    logger.log({ type: 'agent_joined', carId: 3 });
    logger.close();
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(line.type).toBe('agent_joined');
    expect(line.carId).toBe(3);
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(line.ts).getTime()).not.toBeNaN();
  });
});
