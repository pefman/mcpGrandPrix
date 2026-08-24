/**
 * Shared helpers for the e2e-style tests (real RaceSession + localhost HTTP).
 *
 * The suite's wall-clock budget is bounded by the strategy/reactive windows,
 * so `driveWindows` closes each window as soon as every participant that can
 * submit has submitted. The configured window seconds act only as a backstop
 * (WINDOW_BACKSTOP_S) for the pathological case where an agent never submits.
 */
import { createRng } from '../src/rng.js';
import { Simulation } from '../src/sim/simulation.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { buildView } from '../agents/agentBase.js';

export const WINDOW_BACKSTOP_S = 2;
const DRIVER_POLL_MS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the session and close each window the moment every active
 * participant has submitted (a RETIRED/FINISHED car cannot submit and is
 * treated as satisfied — the server defaults it on close). Resolves when
 * the race finishes. Mirrors well-behaved agents (submit early; the server
 * only waits out stragglers up to the configured backstop).
 */
export async function driveWindows(session) {
  while (session.state().phase !== 'finished') {
    const state = session.state();
    try {
      if (state.phase === 'strategy_window') {
        const allIn = state.cars
          .filter((c) => c.status !== 'RETIRED')
          .every((c) => c.submittedStrategy);
        if (allIn) session.closeWindow();
      } else if (state.phase === 'reactive_window' && state.reactiveWindow) {
        const w = state.reactiveWindow;
        const status = (id) => state.cars.find((c) => c.id === id)?.status;
        const allIn = w.carIds.every(
          (id) => w.submittedCarIds.includes(id) || status(id) === 'RETIRED' || status(id) === 'FINISHED',
        );
        if (allIn) session.closeReactiveWindow();
      }
    } catch {
      // The race loop's backstop just closed the window under us.
    }
    await sleep(DRIVER_POLL_MS);
  }
}

/**
 * Close an HTTP server for test teardown. Plain server.close() waits for
 * open connections — undici's keep-alive pool and MCP stream sessions keep
 * some of them non-idle — which costs ~5 s per test file under Vitest.
 * closeAllConnections() drops them immediately (Node >= 18.2); only call
 * this once every request is done (afterAll).
 */
export function closeServer(server) {
  server.close();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.on('close', resolve));
}

/** Poll `cond` every 20 ms until truthy; throw after `timeoutMs`. */
export async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(DRIVER_POLL_MS);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Deterministic sim-level race driven by the same scripted agent policies
 * (and seeds) the e2e tests use — but with windows closed the moment every
 * car has submitted, so the whole race runs in milliseconds. This is where
 * acceptance criteria that depend on the window sequence (e.g. ">= 2 reactive
 * windows over 10 laps") belong: deterministic and cheap.
 */
export function runScriptedSim(totalLaps, seed, agents) {
  const events = [];
  const sim = new Simulation({
    totalLaps,
    strategyWindowSeconds: 0,
    reactiveWindowSeconds: 0,
    seed,
    onEvent: (e) => events.push(e),
  });
  for (const a of agents) sim.addAgent(a.name, a.profile);
  const rngs = agents.map((a) => createRng(a.seed));
  sim.start();
  let guard = 0;
  while (sim.phase !== 'finished' && guard++ < 100000) {
    if (sim.phase === 'strategy_window') {
      for (let i = 0; i < sim.cars.length; i++) {
        const car = sim.cars[i];
        if (car.status === 'RETIRED') continue;
        const view = buildView(sim.state(), car.id);
        const res = sim.submitPhaseStrategy(car.id, SCRIPTED_AGENTS[agents[i].profile].decide(view, rngs[i]));
        if (!res.accepted) throw new Error(`strategy rejected for ${car.name}: ${JSON.stringify(res)}`);
      }
      sim.closeWindow();
    } else if (sim.phase === 'reactive_window') {
      const w = sim.state().reactiveWindow;
      for (const id of w.carIds) {
        const car = sim.carById(id);
        if (car.status === 'RETIRED' || car.status === 'FINISHED') continue;
        const idx = sim.cars.findIndex((c) => c.id === id);
        const view = buildView(sim.state(), id);
        const res = sim.submitReactiveAction(
          id,
          SCRIPTED_AGENTS[agents[idx].profile].decideReactive(view, w, rngs[idx]),
        );
        if (!res.accepted) throw new Error(`reactive action rejected for ${car.name}: ${JSON.stringify(res)}`);
      }
      sim.closeReactiveWindow();
    } else {
      sim.tick();
    }
  }
  return { sim, events };
}
