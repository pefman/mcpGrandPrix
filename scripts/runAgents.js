/**
 * Agents-only race orchestrator for the Docker stack (`docker compose up`):
 *
 *   MCP_URL=http://server:3080/mcp SEED=42 LOG_FILE=/logs/race.jsonl \
 *     node scripts/runAgents.js
 *
 * Unlike scripts/runRace.js (which also starts the game server as a local
 * child), this assumes a RUNNING game server and only:
 *   1. starts the four scripted agents, one after another in fixed order
 *      (join order is grid order, so a fixed seed stays reproducible),
 *   2. polls GET <server>/state until the race is finished,
 *   3. exits 0 only if the race finished cleanly (watchdog otherwise).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3080/mcp';
const stateUrl = mcpUrl.replace(/\/mcp$/, '') + '/state';
const seed = Number(process.env.SEED ?? '42');
const logFile = process.env.LOG_FILE || null;
const watchdogMs = Number(process.env.WATCHDOG_MS ?? '180000');

const AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: seed + 1 },
  { profile: 'conservative', name: 'Turtle', seed: seed + 2 },
  { profile: 'pitHeavy', name: 'PitPete', seed: seed + 3 },
  { profile: 'random', name: 'Randy', seed: seed + 4 },
];

const children = [];

function killAll(code) {
  for (const c of children) {
    if (c.exitCode === null) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

function startAgent(a) {
  const args = [
    path.join(root, 'agents/run.js'),
    '--profile', a.profile,
    '--name', a.name,
    '--url', mcpUrl,
    '--seed', String(a.seed),
  ];
  if (logFile) args.push('--log-file', logFile);
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], cwd: root });
  children.push(proc);
  return proc;
}

/**
 * Agents join one after another, in AGENTS order, and each next agent starts
 * only after the previous one's `agent_joined` line arrives. Join order is
 * the grid order, so this keeps a fixed seed fully reproducible.
 */
function startAgentsSequentially(done) {
  let idx = 0;
  const startNext = () => {
    if (idx >= AGENTS.length) {
      done();
      return;
    }
    const a = AGENTS[idx];
    idx += 1;
    const proc = startAgent(a);
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ type: 'run_error', error: `agent ${a.name} did not join in time` }));
      killAll(1);
    }, 30000);
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'agent_joined') {
          clearTimeout(timeout);
          startNext();
          return;
        }
        if (ev.type === 'agent_error') {
          clearTimeout(timeout);
          console.error(line);
          killAll(1);
          return;
        }
      }
    });
  };
  startNext();
}

const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ type: 'run_error', error: 'watchdog timeout' }));
  killAll(1);
}, watchdogMs);

async function waitForRaceEnd() {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const res = await fetch(stateUrl);
      if (!res.ok) continue;
      const state = await res.json();
      if (state.phase === 'finished') return;
    } catch {
      // server momentarily unreachable — keep polling until the watchdog
    }
  }
}

startAgentsSequentially(async () => {
  console.log(JSON.stringify({ type: 'agents_ready', agents: AGENTS.map((a) => a.name) }));
  await waitForRaceEnd();
  clearTimeout(watchdog);
  console.log(JSON.stringify({ type: 'race_finished' }));
  killAll(0);
});
