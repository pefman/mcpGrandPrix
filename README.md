# MCP Grand Prix

A multiplayer Grand Prix tactics game where LLM agents race by submitting
**strategy packets** instead of driving. No keyboard, no mouse: an agent
chooses pace, tire management, attack/defend and pit strategy every lap, and
the server simulates the rest.

This repository currently contains **Slice 1** — the pure game server:
race simulation, the MCP tool surface, scripted test agents, JSONL decision
logging and a Vitest test suite. No graphics (the Three.js spectator client
is Slice 2).

## Quickstart

```bash
npm install

# run the acceptance race: 5 laps, 4 scripted agents, headless
npm run race

# run the test suite (36 tests: sim, strategies, MCP over HTTP, end-to-end)
npm test

# start a bare race server (MCP endpoint on http://127.0.0.1:3080/mcp)
npm start

# run one scripted agent against a running server
npm run agent -- --profile aggressive --name Aggro --url http://127.0.0.1:3080/mcp --seed 7
```

`npm run race` spawns the server plus four agent processes
(`aggressive`, `conservative`, `pitHeavy`, `random`), streams selected race
events, and prints final standings and the decision log path when the race
finishes. It exits 0 only if the race finished cleanly.

Server options (CLI args or env): port `3080`, laps `20` (race uses 5),
strategy window seconds `20` (race uses 2), tick wall delay `8`, seed `42`,
decision log path. The same seed and the same join order produce the exact
same race.

## The hybrid game loop

The race alternates between a **strategy window** and a **simulated lap**:

1. A strategy window opens (default 20 s; all cars pause).
2. Every agent reads the state and submits one strategy packet for the lap.
   Agents that never submit get a safe default (`normal` everything).
3. The window closes; the server simulates the lap tick by tick (0.25 s of
   race time per tick): tire wear, fuel burn, traffic drag, probabilistic
   overtakes and pit stops.
4. When every active car has crossed the line, the next window opens.
   After the final lap the race ends.

Reactive windows (short 8–15 s windows opened only for affected cars on
trigger events: close battles, weather, safety car, critical tire wear, pit
opportunities) arrive in Slice 3; the tool for them already exists as an
idempotent no-op.

## MCP tools

Transport: **Streamable HTTP** at `POST /mcp` (official `@modelcontextprotocol/sdk`).
One server instance per client session, all bound to the same authoritative
race. Every tool returns a JSON text result; errors are JSON with an `error`
field, never transport-level failures.

| Tool | Purpose | Idempotency |
| --- | --- | --- |
| `join_race` | Join with a display name. Returns `carId` (needed by other tools) and grid position. | Same name always returns the same car. |
| `get_race_state` | Full snapshot: phase, lap, window time left, all cars, standings. | Pure read. |
| `get_car_state` | Snapshot of one car plus its standing. | Pure read. |
| `get_standings` | Position, name, status, laps, gap to leader. | Pure read. |
| `submit_phase_strategy` | Strategy packet for the current window: `pace`, `tireManagement` (`push\|normal\|manage`), `aggression`, `defend` (`0\|1`), `pitNow` (`bool`). Omitted fields default. | First valid packet per window wins; repeats rejected as `duplicate_strategy`, never change state. |
| `submit_reactive_action` | React to a reactive window (Slice 3). | Always rejected with `reactive_windows_not_yet_available` in Slice 1 — a safe no-op, so retries are free. |

Game state is 100% server-authoritative: the simulation never reads from a
client, and nothing a client sends can corrupt the race.

## Layout

```
src/
  config.js              all tunables in one place
  rng.js                 seeded mulberry32 RNG (deterministic races)
  track.js               track definition (1 km, 5 sectors)
  sim/simulation.js      the authoritative race engine (pure, deterministic)
  sim/car.js             car model
  sim/strategies.js      the four scripted agent profiles (pure functions)
  logging/decisionLogger.js  JSONL append-only decision log
  server/main.js         CLI entry point (node src/server/main.js)
  server/http.js         HTTP server, mounts the MCP endpoint
  server/mcpServer.js    the MCP tool surface (one per session)
  server/raceSession.js  real-time owner: walls the clock, ticks the sim
agents/
  agentBase.js           MCP client loop: join, poll, submit once per lap
  run.js                 standalone agent process (npm run agent)
scripts/runRace.js       `npm run race` orchestrator (server + 4 agents)
test/                    Vitest: sim, strategies, MCP over HTTP, end-to-end
log/                     decision logs (gitignored)
```

## Decision log

Every race writes one JSONL file (path printed at the end of `npm run race`),
one line per event: `session_started`, `agent_joined`, `race_start`,
`window_opened`, `strategy_submitted`, `strategy_defaulted`, `window_closed`,
`lap_complete`, `overtake`, `pit_stop_enter`, `pit_stop_complete`, `finish`,
`retired`, `race_finished`, `session_finished` — plus agent-side lines
(`agent_decision`, `agent_strategy_rejected`) written by the agent processes.
Strategy decisions and pit actions are the lines an analyst (or a human
spectator in Slice 2) will care about.

## Testing

- `test/sim.test.js` — pure simulation: race flow, determinism, laps,
  fuel/tire retirement, pit stops, overtakes, standings.
- `test/strategies.test.js` — the four scripted profiles: output shape,
  determinism, and their pit logic.
- `test/mcp.test.js` — real MCP clients over real HTTP: join idempotency,
  read tools, strategy first-wins, a full race driven through the tools.
- `test/race.test.js` — end-to-end: the server process with four in-process
  scripted agents, asserting the hybrid loop actually runs (one window per
  lap), everyone submits, pits happen, and the race finishes with sane gaps.

All tests are deterministic (seeded RNG, `tickWallDelayMs: 0`, immediate
window closes) and run in ~10 s.

## Roadmap

- **Slice 1 (this)** — core sim, MCP tools, scripted agents, logging, tests.
- **Slice 2** — Three.js spectator client over WebSocket.
- **Slice 3** — reactive windows + first Vercel deploy.
- **Slice 4** — Playwright e2e suite (smoke race as the gate).
- **Slice 5** — demo + polish.
