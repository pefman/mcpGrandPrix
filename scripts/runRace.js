/**
 * Race orchestrator for `npm run race`:
 *   1. starts the race server (5 laps, 4 scripted agents, short windows),
 *   2. starts one agent process per scripted profile,
 *   3. follows the server's event log,
 *   4. on race_complete prints final standings + where the decision log is,
 *   5. exits 0 only if the race finished cleanly.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const port = Number(process.env.PORT ?? '3080');
const laps = Number(process.env.LAPS ?? '5');
const windowSeconds = Number(process.env.WINDOW_SECONDS ?? '2');
const tickDelayMs = Number(process.env.TICK_DELAY_MS ?? '5');
const seed = Number(process.env.SEED ?? '42');
const url = `http://127.0.0.1:${port}/mcp`;
const logDir = path.join(root, 'log');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `race-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: seed + 1 },
  { profile: 'conservative', name: 'Turtle', seed: seed + 2 },
  { profile: 'pitHeavy', name: 'PitPete', seed: seed + 3 },
  { profile: 'random', name: 'Randy', seed: seed + 4 },
];

const children = [];

function startServer() {
  const server = spawn(
    process.execPath,
    [
      path.join(root, 'src/server/main.js'),
      String(port),
      String(laps),
      String(windowSeconds),
      String(tickDelayMs),
      String(seed),
      logFile,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], cwd: root },
  );
  children.push(server);
  return server;
}

function startAgent(a) {
  const proc = spawn(
    process.execPath,
    [path.join(root, 'agents/run.js'), '--profile', a.profile, '--name', a.name, '--url', url, '--seed', String(a.seed), '--log-file', logFile],
    { stdio: ['ignore', 'pipe', 'inherit'], cwd: root },
  );
  children.push(proc);
  return proc;
}

/**
 * Agents join one after another, in AGENTS order, and each next agent starts
 * only after the previous one's `agent_joined` line arrives. Join order is
 * the grid order, so this keeps a fixed seed fully reproducible.
 */
function startAgentsSequentially() {
  let idx = 0;
  const startNext = () => {
    if (idx >= AGENTS.length) return;
    const a = AGENTS[idx];
    idx += 1;
    const proc = startAgent(a);
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ type: 'run_error', error: `agent ${a.name} did not join in time` }));
      killAll(1);
    }, 15000);
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

function killAll(code) {
  for (const c of children) {
    if (c.exitCode === null) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

const server = startServer();
let agentsStarted = false;
let finished = false;
let exitCode = 0;

const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ type: 'run_error', error: 'watchdog timeout' }));
  killAll(1);
}, 180000);

server.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'server_ready') {
        console.log(`\n=== MCP Grand Prix: ${laps}-lap race, ${AGENTS.length} scripted agents ===`);
        startAgentsSequentially();
        agentsStarted = true;
      } else if (ev.type === 'race_complete') {
        finished = true;
        clearTimeout(watchdog);
        console.log('\n=== FINAL STANDINGS ===');
        for (const s of ev.standings) {
          console.log(
            `P${s.position}  ${s.name.padEnd(10)} ${s.status.padEnd(9)} laps=${s.completedLaps} finish=${s.finishTimeS ?? '-'}s gap=${s.gapToLeaderM}m`,
          );
        }
        console.log(`\nDecision log: ${logFile}`);
        killAll(0);
        exitCode = 0;
      } else if (ev.type === 'server_error') {
        exitCode = 1;
        clearTimeout(watchdog);
        killAll(1);
      } else {
        // pass through selected events so the race is visible
        if (['race_start', 'window_opened', 'window_closed', 'strategy_submitted', 'strategy_defaulted', 'pit_stop_enter', 'pit_stop_complete', 'overtake', 'finish', 'retired'].includes(ev.type)) {
          console.log(line);
        }
      }
    } catch {
      process.stdout.write(chunk.toString());
    }
  }
});

server.on('exit', (code) => {
  if (!finished) {
    if (code === 0) {
      console.error(JSON.stringify({ type: 'run_error', error: 'server exited before race_complete' }));
      killAll(1);
    }
  } else if (process.exitCode === undefined) {
    // agents may still be flushing; make sure we exit with the right code
    clearTimeout(watchdog);
    setTimeout(() => process.exit(exitCode), 1000).unref();
  }
});
