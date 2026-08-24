/**
 * Agent base: connects an MCP client to the race server and drives one car
 * through the hybrid loop. The "brain" is any `decide(view, rng) -> strategy`
 * function (see src/sim/strategies.js for the four scripted profiles), plus an
 * optional `decideReactive(view, window, rng) -> action` for Slice 3 windows.
 *
 * The agent:
 *   1. joins the race (idempotent by name); if the race is not in setup it
 *      lands in the pending queue and waits for the next session's setup
 *   2. polls get_race_state,
 *   3. at the start of each lap's strategy window, computes and submits a
 *      strategy packet (once per lap; retries only on unexpected errors),
 *   4. when a reactive window lists this car, submits one reactive action,
 *   5. exits cleanly when the race is finished.
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {string} opts.name        display name (join key)
 * @param {string} opts.serverUrl   e.g. http://127.0.0.1:3080/mcp
 * @param {(view: object, rng: object) => object} opts.decide
 * @param {(view: object, window: object, rng: object) => object} [opts.decideReactive]
 * @param {object} [opts.rng]       seeded RNG for stochastic profiles
 * @param {number} [opts.pollMs]    polling interval (default 150)
 * @param {(line: object) => void} [opts.onLog]  receives agent log lines
 * @param {string} [opts.logFile]   JSONL file agent lines are also appended to
 * @returns {Promise<{carId: number, submissions: number, reactiveSubmissions: number, name: string}>}
 */
export async function runAgent({
  name,
  serverUrl,
  decide,
  decideReactive = null,
  rng,
  pollMs = 150,
  onLog = () => {},
  logFile = null,
}) {
  const emit = (line) => {
    onLog(line);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${JSON.stringify(line)}\n`);
      } catch {
        /* decision log is best-effort; never fail the agent on a log error */
      }
    }
  };
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  let submissions = 0;
  let reactiveSubmissions = 0;
  let carId = null;

  try {
    await client.connect(transport);

    // Join loop (MCPG-34): outside `setup` (or with a full grid) the server
    // queues this name for the NEXT session instead of failing. Wait for
    // that session's setup, then re-join to claim the seat (idempotent by
    // name). `queue_full` just means: back off and retry.
    for (;;) {
      const joined = await callTool(client, 'join_race', { name });
      if (joined.queued) {
        emit({ type: 'agent_queued', name, position: joined.position, phase: joined.phase });
        await waitForSetup(client, { pollMs: Math.max(pollMs, 1000), timeoutMs: 5 * 60 * 1000 });
        continue;
      }
      if (joined.error === 'queue_full') {
        emit({ type: 'agent_queue_full', name, maxSize: joined.maxSize });
        await sleep(2000);
        continue;
      }
      if (joined.error) throw new Error(`join_race failed: ${joined.error}: ${joined.details ?? ''}`);
      carId = joined.carId;
      emit({ type: 'agent_joined', name, carId, claimedFromQueue: joined.claimedFromQueue === true });
      break;
    }

    let lastLapSubmitted = null;
    let lastReactiveWindowId = null;
    while (true) {
      let state;
      try {
        state = await callTool(client, 'get_race_state', {});
      } catch {
        break; // server went away
      }
      if (state.error) break;
      if (state.phase === 'finished') break;

      if (state.phase === 'strategy_window' && state.currentLap !== lastLapSubmitted) {
        const view = buildView(state, carId);
        if (view) {
          const strategy = decide(view, rng);
          const res = await callTool(client, 'submit_phase_strategy', { carId, strategy });
          if (res.accepted) {
            submissions += 1;
            lastLapSubmitted = state.currentLap;
            emit({ type: 'agent_decision', name, lap: state.currentLap, strategy });
          } else if (res.error !== 'duplicate_strategy') {
            emit({ type: 'agent_strategy_rejected', name, error: res.error, details: res.details });
          }
        }
      }

      if (
        state.phase === 'reactive_window' &&
        state.reactiveWindow &&
        state.reactiveWindow.id !== lastReactiveWindowId &&
        state.reactiveWindow.carIds?.includes(carId)
      ) {
        const view = buildView(state, carId);
        if (view) {
          const action = decideReactive
            ? decideReactive(view, state.reactiveWindow, rng)
            : { type: 'hold' };
          const res = await callTool(client, 'submit_reactive_action', {
            carId,
            type: action.type,
            detail: action.detail,
          });
          if (res.accepted) {
            reactiveSubmissions += 1;
            lastReactiveWindowId = state.reactiveWindow.id;
            emit({
              type: 'agent_reactive',
              name,
              windowId: state.reactiveWindow.id,
              trigger: state.reactiveWindow.trigger,
              action,
            });
          } else if (res.error !== 'duplicate_action') {
            // Window may have closed between poll and submit — move on.
            lastReactiveWindowId = state.reactiveWindow.id;
            emit({
              type: 'agent_reactive_rejected',
              name,
              error: res.error,
              details: res.details,
            });
          } else {
            lastReactiveWindowId = state.reactiveWindow.id;
          }
        }
      }
      await sleep(pollMs);
    }
  } finally {
    try {
      await client.close();
    } catch {
      /* transport already closed */
    }
  }

  return { name, carId, submissions, reactiveSubmissions };
}

/** Poll get_race_state until the next session is in `setup`. */
async function waitForSetup(client, { pollMs = 1000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await callTool(client, 'get_race_state', {});
      if (!state.error && state.phase === 'setup') return;
    } catch {
      /* transient (server restarting) — keep polling */
    }
    await sleep(pollMs);
  }
  throw new Error('timed out waiting for the next race setup phase');
}

/** MCP callTool wrapper: parses the JSON text result, tolerates tool-level errors. */
async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text;
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return { error: 'malformed_response', raw: text };
  }
}

/** Public view an agent is allowed to use for its decision. */
export function buildView(state, carId) {
  const car = state.cars.find((c) => c.id === carId);
  if (!car) return null;
  const standing = state.standings.find((s) => s.carId === carId);
  return {
    car: {
      id: car.id,
      status: car.status,
      completedLaps: car.completedLaps,
      positionM: car.positionM,
      gapToLeaderM: car.gapToLeaderM,
      tireWearPct: car.tireWearPct,
      fuelKg: car.fuelKg,
      pitRequested: car.pitRequested,
    },
    race: {
      phase: state.phase,
      currentLap: state.currentLap,
      totalLaps: state.totalLaps,
      lapsRemaining: Math.max(0, state.totalLaps - car.completedLaps),
      windowRemainingS: state.windowRemainingS,
      position: standing ? standing.position : null,
      gapToLeaderM: standing ? standing.gapToLeaderM : null,
    },
  };
}
