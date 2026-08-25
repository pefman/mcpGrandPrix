import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { closeServer } from './helpers.js';
import { PALETTE } from '../src/sim/liveries.js';

let session;
let server;
let baseUrl;

const connect = async (name) => {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  return client;
};

const call = async (client, tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  return JSON.parse(res.content[0].text);
};

beforeAll(async () => {
  session = new RaceSession({
    totalLaps: 2,
    strategyWindowSeconds: 30, // long window; tests close it manually
    reactiveWindowSeconds: 30,
    tickWallDelayMs: 0,
    seed: 11,
    logToStdout: false,
  });
  server = createMcpHttpServer(session);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
}, 30000);

afterAll(async () => {
  session.close();
  await closeServer(server);
});

describe('MCP tools over Streamable HTTP', () => {
  let clients = [];
  let carA, carB, carC, carD;

  it('four agents can join, and join_race is idempotent by name', async () => {
    // sequential joins: grid position = join order (P1 first)
    const joined = [];
    for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      const client = await connect(n);
      clients.push(client);
      joined.push(await call(client, 'join_race', { name: n }));
    }
    [carA, carB, carC, carD] = joined;
    expect(new Set([carA.carId, carB.carId, carC.carId, carD.carId]).size).toBe(4);
    expect(carA.gridPosition).toBe(1);
    expect(carD.gridPosition).toBe(4);
    // liveries (MCPG-33): join-order colors, all distinct, carried in the join response
    expect([carA.color, carB.color, carC.color, carD.color]).toEqual([
      PALETTE[0], PALETTE[1], PALETTE[2], PALETTE[3],
    ]);

    // re-join with the same name -> same car, no new entry
    const again = await call(clients[0], 'join_race', { name: 'Alpha' });
    expect(again.carId).toBe(carA.carId);
    const state = await call(clients[0], 'get_race_state', {});
    expect(state.cars).toHaveLength(4);
  });

  it('get_race_state and get_standings are pure reads during setup', async () => {
    const state = await call(clients[1], 'get_race_state', {});
    expect(state.phase).toBe('setup');
    expect(state.totalLaps).toBe(2);
    expect(state.track.lengthM).toBe(1000);
    expect(state.cars).toHaveLength(4);

    const standings = await call(clients[2], 'get_standings', {});
    expect(standings).toHaveLength(4);
    expect(standings[0].position).toBe(1);
  });

  it('get_car_state returns a car and errors cleanly for unknown ids', async () => {
    const car = await call(clients[0], 'get_car_state', { carId: carA.carId });
    expect(car.id).toBe(carA.carId);
    expect(car.fuelKg).toBe(95);
    expect(car.status).toBe('RUNNING');

    const unknown = await call(clients[0], 'get_car_state', { carId: 9999 });
    expect(unknown.error).toBe('unknown_car');
  });

  it('submit_phase_strategy: first packet wins, duplicates rejected (idempotent)', async () => {
    session.start(); // opens the strategy window for lap 1

    const first = await call(clients[0], 'submit_phase_strategy', {
      carId: carA.carId,
      strategy: { pace: 'push', aggression: 1, defend: 1 },
    });
    expect(first.accepted).toBe(true);

    const duplicate = await call(clients[0], 'submit_phase_strategy', {
      carId: carA.carId,
      strategy: { pace: 'manage', pitNow: true },
    });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.error).toBe('duplicate_strategy');

    const car = await call(clients[0], 'get_car_state', { carId: carA.carId });
    expect(car.strategy.pace).toBe('push');
    expect(car.strategy.pitNow).toBe(false);
    expect(car.submittedStrategy).toBe(true);
  });

  it('submit_reactive_action rejects cleanly when no window is open', async () => {
    const res = await call(clients[3], 'submit_reactive_action', {
      carId: carD.carId,
      type: 'attack',
      detail: 'no window yet',
    });
    expect(res).toEqual({ accepted: false, error: 'no_reactive_window' });
    const again = await call(clients[3], 'submit_reactive_action', { carId: carD.carId, type: 'attack' });
    expect(again).toEqual(res);
  });

  it('a full race runs to completion through the tools', async () => {
    session.closeWindow(); // lap 1 starts (Alpha has pushed; others default)

    let guard = 0;
    while (session.state().phase !== 'finished' && guard < 5000) {
      const phase = session.state().phase;
      if (phase === 'strategy_window') session.closeWindow();
      else if (phase === 'reactive_window') session.closeReactiveWindow();
      else session.tickOnce();
      guard += 1;
    }
    expect(session.state().phase).toBe('finished');

    const standings = await call(clients[0], 'get_standings', {});
    expect(standings).toHaveLength(4);
    expect(standings.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    for (const s of standings) {
      expect(s.status).toBe('FINISHED');
      expect(s.completedLaps).toBe(2);
    }

    // post-finish reads still work
    const state = await call(clients[1], 'get_race_state', {});
    expect(state.phase).toBe('finished');
  });

  it('two clients see the same authoritative state', async () => {
    const a = await call(clients[0], 'get_standings', {});
    const b = await call(clients[3], 'get_standings', {});
    expect(a).toEqual(b);
  });

  it('tears down clients cleanly', async () => {
    for (const c of clients) await c.close();
    clients = [];
  });
});
