/**
 * Local repro for MCPG-58: 4 simultaneous MCP clients join the same
 * orchestrator-backed server. Scenario A: all use the SAME name (what
 * identical premade-harness sessions converge on). Scenario B: distinct
 * names. Prints join_race responses + server-side car count.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceOrchestrator } from '../src/server/raceOrchestrator.js';

const connect = async (label, baseUrl) => {
  const client = new Client({ name: label, version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  return client;
};
const call = async (client, tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  return JSON.parse(res.content[0].text);
};

async function scenario(label, names) {
  console.log(`\n=== ${label}: joins with ${JSON.stringify(names)} ===`);
  const orchestrator = new RaceOrchestrator({
    totalLaps: 2,
    strategyWindowSeconds: 30,
    reactiveWindowSeconds: 5,
    tickWallDelayMs: 0,
    seed: 7,
    logToStdout: false,
    voteWindowSeconds: 0,
    resultsHoldSeconds: 0,
  });
  // Hold setup open long enough for all four joins.
  orchestrator.run().catch(() => {});
  const server = createMcpHttpServer(orchestrator);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  const clients = [];
  const responses = [];
  for (const n of names) {
    const c = await connect(`session-${names.indexOf(n) + 1}`, baseUrl);
    clients.push(c);
    const res = await call(c, 'join_race', { name: n });
    responses.push(res);
    console.log(`session ${names.indexOf(n) + 1} join_race(${JSON.stringify(n)}) ->`, JSON.stringify({ carId: res.carId, name: res.name, color: res.color, gridPosition: res.gridPosition }));
  }
  const ids = new Set(responses.map((r) => r.carId));
  console.log(`distinct MCP sessions: ${clients.length}; distinct carIds returned: ${ids.size}`);
  const state = await call(clients[0], 'get_race_state', {});
  console.log('server cars:', state.cars.map((c) => ({ id: c.id, name: c.name })));

  orchestrator.shutdown();
  await Promise.allSettled(clients.map((c) => c.close()));
  await new Promise((r) => server.close(r));
  return { sessions: clients.length, distinctCarIds: ids.size };
}

const a = await scenario('A (same harness default name)', ['opencode', 'opencode', 'opencode', 'opencode']);
const b = await scenario('B (distinct names)', ['Alpha', 'Bravo', 'Charlie', 'Delta']);
console.log('\nSUMMARY', JSON.stringify(a), JSON.stringify(b));
process.exit(0);
