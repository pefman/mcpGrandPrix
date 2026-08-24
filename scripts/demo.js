/**
 * MCP Grand Prix — live demo session (Slice 5: demo + README).
 *
 * The demo is a race a HUMAN can watch: scripted agents make planned
 * (strategy-window) and reactive (trigger-window) decisions while you look
 * at the 3D spectator view in a browser. Every narrated line is a decision
 * the server also records in a JSONL decision log.
 *
 * Local mode (default):
 *   npm run demo
 *   Spawns the race server (5 laps, real-time 20s strategy windows, 10s
 *   reactive windows) plus four scripted agents and narrates the server's
 *   decision log line by line in this terminal.
 *
 * Public mode (deployed server):
 *   npm run demo:public
 *   node scripts/demo.js --url https://gp.peterfrank.se/mcp [--watch https://gp.peterfrank.se/]
 *   Waits for the server to be in its setup phase, joins the scripted
 *   agents, and narrates the race from the agents' decision logs plus a
 *   read-only get_race_state() poll.
 *
 * Exit codes: 0 clean finish, 1 error/watchdog, 130 Ctrl-C.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { narrateEvent, strategyLine } from './demoNarration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// The demo grid: the same four scripted agents used by the test suite.
const GRID = [
  { profile: 'aggressive', name: 'Aggro' },
  { profile: 'conservative', name: 'Turtle' },
  { profile: 'pitHeavy', name: 'PitPete' },
  { profile: 'random', name: 'Randy' },
];

const PUBLIC_URL = 'https://gp.peterfrank.se/mcp';
const PUBLIC_WATCH = 'https://gp.peterfrank.se/';

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const ts = () => new Date().toISOString().slice(11, 19);
const say = (line = '') => console.log(line);
const sayTs = (line) => console.log(`[${ts()}] ${line}`);

/** Spawn one scripted agent; routes its JSON log lines to onLine. */
function spawnAgent({ profile, name, url, seed, logFile, onLine }) {
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'agents', 'run.js'),
      '--profile', profile,
      '--name', name,
      '--url', url,
      '--seed', String(seed),
      ...(logFile ? ['--log-file', logFile] : []),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        onLine({ type: 'agent_raw', name, line });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) onLine({ type: 'agent_raw', name, line: text });
  });
  return child;
}

function printStandings(standings, title = 'FINAL STANDINGS') {
  say('');
  say(`════ ${title} ════`);
  const leaderTime = standings.find((s) => s.finishTimeS)?.finishTimeS ?? null;
  for (const s of standings) {
    let gap;
    if (leaderTime != null) {
      gap = s.finishTimeS ? (s.finishTimeS > leaderTime ? `+${(s.finishTimeS - leaderTime).toFixed(2)}s` : 'winner') : 'retired';
    } else {
      gap = s.gapToLeaderM > 0 ? `+${Math.round(s.gapToLeaderM)}m` : 'leader';
    }
    const time = s.finishTimeS ? `${s.finishTimeS}s` : `${s.completedLaps} laps`;
    say(`  P${s.position}  ${s.name.padEnd(10)} ${s.status.padEnd(9)} ${time.padStart(10)}  ${gap}`);
  }
}

function makeWatchdog(ms, onFire) {
  const timer = setTimeout(onFire, ms);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------- local mode

async function runLocal(opts) {
  const port = Number(opts.port ?? process.env.PORT ?? 3080);
  const laps = Number(opts.laps ?? 5);
  const windowS = Number(opts.window ?? 20);
  const reactiveS = Number(opts['reactive-window'] ?? 10);
  const tickMs = Number(opts.tick ?? 8);
  const seed = Number(opts.seed ?? 42);
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  mkdirSync(path.join(root, 'log'), { recursive: true });
  const logFile = path.join(root, 'log', `demo-${Date.now()}.jsonl`);

  say('════ MCP GRAND PRIX — LIVE DEMO (local) ════');
  say(`  Spectate the race in your browser:  http://127.0.0.1:${port}/`);
  say(`  MCP endpoint (for your own agent):  ${mcpUrl}`);
  say(`  ${laps} laps · ${GRID.length} scripted agents · ${windowS}s strategy windows · ${reactiveS}s reactive windows`);
  say(`  Decision log: ${path.relative(process.cwd(), logFile)}`);
  say('');

  const children = [];
  let exitCode = null;
  let exited = false;

  function killAll(code) {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const child of children) {
      try {
        child.kill(code === 0 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  process.on('SIGINT', () => killAll(130));
  makeWatchdog(10 * 60_000, () => {
    sayTs('watchdog: demo exceeded 10 minutes — aborting');
    killAll(1);
  });

  const server = spawn(
    process.execPath,
    [
      path.join(root, 'src', 'server', 'main.js'),
      String(port),
      String(laps),
      String(windowS),
      String(tickMs),
      String(seed),
      logFile,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, REACTIVE_WINDOW_SECONDS: String(reactiveS) },
    },
  );
  children.push(server);

  let buf = '';
  server.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        sayTs(line);
        continue;
      }
      if (ev.type === 'server_ready') {
        launchAgents();
      } else if (ev.type === 'race_complete') {
        printStandings(ev.standings ?? []);
        say('');
        say(`  Full decision log (every strategy + reactive decision): ${path.relative(process.cwd(), logFile)}`);
        say('  Replay it with:  grep -E "strategy_submitted|reactive_" ' + path.relative(process.cwd(), logFile));
        killAll(0);
      } else if (ev.type === 'server_error') {
        sayTs(`server error: ${ev.error}`);
        killAll(1);
      } else {
        const narrated = narrateEvent(ev);
        if (narrated !== null) sayTs(narrated);
      }
    }
  });
  server.on('exit', (code, signal) => {
    if (!exited) {
      sayTs(`server exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})`);
      killAll(1);
    }
    if (exitCode !== null) process.exit(exitCode);
  });

  async function launchAgents() {
    sayTs(`server ready — joining ${GRID.length} scripted agents (one per profile)`);
    for (const car of GRID) {
      const agent = spawnAgent({
        profile: car.profile,
        name: car.name,
        url: mcpUrl,
        seed,
        logFile,
        onLine: (line) => {
          if (line.type === 'agent_error') {
            sayTs(`agent ${line.name} failed: ${line.error}`);
            killAll(1);
          } else if (line.type === 'agent_raw') {
            sayTs(`agent ${line.name}: ${line.line}`);
          }
          // agent_joined / agent_decision / agent_reactive are already
          // narrated from the server's decision log — keep the terminal clean.
        },
      });
      children.push(agent);
      // Sequential join keeps the grid (join order = grid position) stable.
      await new Promise((resolve) => agent.once('spawn', resolve));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  await new Promise(() => {}); // until killed
}

// ---------------------------------------------------------------- public mode

async function runPublic(opts) {
  const url = opts.url ?? PUBLIC_URL;
  const watch = opts.watch ?? PUBLIC_WATCH;
  const seed = Number(opts.seed ?? 42);

  say('════ MCP GRAND PRIX — LIVE DEMO (public server) ════');
  say(`  Spectate the race in your browser:  ${watch}`);
  say(`  MCP endpoint: ${url}`);
  say(`  ${GRID.length} scripted agents · decisions narrated below`);
  say('');

  const children = [];
  let exitCode = null;
  let exited = false;

  function killAll(code) {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const child of children) {
      try {
        child.kill(code === 0 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  process.on('SIGINT', () => killAll(130));
  makeWatchdog(30 * 60_000, () => {
    sayTs('watchdog: demo exceeded 30 minutes — aborting');
    killAll(1);
  });

  let client = null;
  let busyNotified = false;
  let setupNotified = false;
  let lastLap = 0;
  let lastReactiveId = null;
  const lastCar = new Map(); // carId -> { status }
  let sawRacing = false;
  let raceEnded = false;
  let agentsStarted = false;

  async function connect() {
    if (client) await client.close().catch(() => {});
    client = new Client({ name: 'mcgp-demo', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
  }

  async function getState() {
    const res = await client.callTool({ name: 'get_race_state', arguments: {} });
    return JSON.parse(res.content?.[0]?.text ?? '{}');
  }

  function narrate(state) {
    // Strategy-window openings (a new lap begins).
    if (state.phase === 'strategy_window' && state.currentLap !== lastLap) {
      lastLap = state.currentLap;
      const line = narrateEvent({
        type: 'window_opened',
        lap: state.currentLap,
        remainingS: Math.ceil(state.windowRemainingS ?? state.strategyWindowSeconds),
      });
      if (line) sayTs(line);
      flushAgentLines();
    }
    if (state.phase === 'reactive_window' && state.reactiveWindow) {
      const rw = state.reactiveWindow;
      if (rw.id !== lastReactiveId) {
        lastReactiveId = rw.id;
        const line = narrateEvent({
          type: 'reactive_window_opened',
          trigger: rw.trigger,
          carIds: rw.carIds,
          remainingS: Math.ceil(rw.remainingS),
          detail: rw.detail,
        });
        if (line) sayTs(line);
        flushAgentLines();
      }
    }
    // Car status transitions (pit stops, finishes, retirements).
    for (const car of state.cars ?? []) {
      const prev = lastCar.get(car.id)?.status;
      lastCar.set(car.id, { status: car.status });
      if (prev === car.status) continue;
      let ev = null;
      if (car.status === 'PITTING' && prev !== 'PITTING') {
        ev = { type: 'pit_stop_enter', name: car.name, lap: state.currentLap };
      } else if (car.status === 'RUNNING' && prev === 'PITTING') {
        ev = { type: 'pit_stop_complete', name: car.name };
      } else if (car.status === 'FINISHED' && prev !== 'FINISHED') {
        ev = { type: 'finish', name: car.name, timeS: state.raceTimeS };
      } else if (car.status === 'RETIRED' && prev !== 'RETIRED') {
        ev = { type: 'retired', name: car.name, reason: 'out of fuel' };
      }
      if (ev) {
        const line = narrateEvent(ev);
        if (line) sayTs(line);
      }
    }
  }

  // Agent decision lines are held briefly until the state poll narrates
  // the window they belong to — at 1 s polling granularity a fast agent
  // would otherwise print its decision before the window-open line.
  const pendingAgent = [];
  let pendingTimer = null;

  function renderAgentLine(line, fallbackName) {
    if (line.type === 'agent_error') return `agent ${line.name ?? fallbackName ?? '?'} failed: ${line.error}`;
    if (line.type === 'agent_joined') return `  ${line.name} joined the race (car #${line.carId})`;
    if (line.type === 'agent_decision') return `  ${String(line.name).padEnd(10)} → ${strategyLine(line.strategy)}`;
    if (line.type === 'agent_reactive') return `  ${String(line.name).padEnd(10)} reacts: ${line.action?.type}`;
    if (line.type === 'agent_raw') return `agent ${fallbackName}: ${line.line}`;
    return null;
  }

  function flushAgentLines() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    for (const item of pendingAgent.splice(0)) {
      const rendered = renderAgentLine(item.line, item.name);
      if (rendered) sayTs(rendered);
    }
  }

  function onAgentLine(name) {
    return (line) => {
      const rendered = renderAgentLine(line, name);
      if (!rendered) return;
      if (line.type === 'agent_decision' || line.type === 'agent_reactive') {
        pendingAgent.push({ line, name });
        if (!pendingTimer) pendingTimer = setTimeout(flushAgentLines, 2500);
        return;
      }
      sayTs(rendered);
    };
  }

  async function startAgents(minAgents) {
    if (agentsStarted) return;
    agentsStarted = true;
    // The race starts as soon as minAgents cars have joined, and joining
    // closes after that — so bring exactly as many agents as the server
    // needs (up to the full demo grid). The race can never start before
    // every join we issue has landed, so this is safe in any order.
    const count = Math.max(1, Math.min(minAgents ?? GRID.length, GRID.length));
    const cars = GRID.slice(0, count);
    if (count < GRID.length) {
      sayTs(`server starts with ${count} car(s) (MIN_AGENTS=${count}) — demoing ${cars.map((c) => c.name).join(', ')}. For a full ${GRID.length}-car public race, set MIN_AGENTS=4 in the VPS env.`);
    }
    const join = (car) =>
      new Promise((resolve) => {
        const agent = spawnAgent({ profile: car.profile, name: car.name, url, seed, logFile: null, onLine: onAgentLine(car.name) });
        children.push(agent);
        agent.once('spawn', resolve);
      });
    if (count === GRID.length) {
      // Sequential join keeps the grid (join order = grid position) stable.
      for (const car of cars) await join(car);
    } else {
      await Promise.all(cars.map(join));
    }
  }

  // Main loop: poll the authoritative state, reconnecting across restarts.
  while (!raceEnded) {
    try {
      await connect();
      let pollMs = 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const state = await getState();
        if (state.phase === 'setup') {
          if (sawRacing) {
            sayTs('the race has ended and the server restarted for a new session');
            sawRacing = false;
            lastCar.clear();
          }
          if (!setupNotified) {
            sayTs(`server in setup — ${state.totalLaps} laps, minAgents=${state.minAgents}`);
            setupNotified = true;
          }
          if (!agentsStarted) {
            // Give the banner a beat, then join.
            await new Promise((r) => setTimeout(r, 1500));
            await startAgents(state.minAgents ?? GRID.length);
          }
        } else {
          if (!busyNotified && !agentsStarted) {
            sayTs(`server busy (phase '${state.phase}') — waiting for it to reset to setup…`);
            busyNotified = true;
          }
          sawRacing = true;
          narrate(state);
        }
        if (state.phase === 'finished') {
          printStandings(state.standings ?? [], 'FINAL STANDINGS');
          say('');
          say('  The server keeps a decision log of every strategy + reactive decision on the VPS.');
          raceEnded = true;
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (err) {
      // Connection dropped (server restart / network blip): back off and retry.
      await client?.close().catch(() => {});
      client = null;
      if (raceEnded) break;
      sayTs(`connection to server lost (${err.message ?? err}) — retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  killAll(0);
  process.exit(0);
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const mode = opts.url ? 'public' : 'local';

try {
  if (mode === 'public') await runPublic(opts);
  else await runLocal(opts);
} catch (err) {
  console.error(`demo failed: ${err.message ?? err}`);
  process.exit(1);
}
