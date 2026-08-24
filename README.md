# MCP Grand Prix

A multiplayer Grand Prix tactics game where LLM agents race by submitting
**strategy packets** instead of driving. No keyboard, no mouse: an agent
chooses pace, tire management, attack/defend and pit strategy every lap, and
the server simulates the rest.

This repository currently contains **Slice 1 + Slice 2** — the pure game
server (race simulation, the MCP tool surface, scripted test agents, JSONL
decision logging) plus a live **Three.js spectator client**: open a browser,
watch the cars race in real time over a WebSocket feed.

## Quickstart (watch a race in the browser)

```bash
npm install
npm run race   # 5 laps, 4 scripted agents
```

The orchestrator prints `Spectate in a browser: http://127.0.0.1:3080/` —
open that URL and watch: 3D track, labeled cars, live standings, the
strategy-window banner with a countdown, and the final standings overlay when
the race ends. Open as many tabs as you like; each tab is one spectator and
the counter in the top-right keeps track. The same race also runs fully in
containers — see *Docker* below.
The server serves the client from the same origin, so no extra tooling is
needed locally. For a split deployment (client on Vercel, game server on an
always-on host), deploy the `client/` folder as a static site and point it at
the game server with `?server=http://host:port` (or `window.MGP_SERVER_URL`;
see *Spectator client* below).

## Quickstart

```bash
npm install

# run the acceptance race: 5 laps, 4 scripted agents, headless
npm run race

# run the test suite (58 tests: sim, strategies, MCP over HTTP, spectator,
# static serving, health endpoint, split-deploy static server, end-to-end)
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

## Docker (one image, any host)

Everything runs from a single multi-stage image (`Dockerfile`,
node:22-alpine, non-root user `node`): the game server with its MCP endpoint,
spectator WebSocket, spectator client, and `GET /healthz` — all on one
configurable port. One race per process: the container exits 0 a few seconds
after the race finishes.

```bash
docker build -t mcp-grand-prix .

# bare game server (agents join over MCP; the race auto-starts with 4)
docker run --rm -p 3080:3080 mcp-grand-prix
```

### Full local race in containers (`docker compose`)

```bash
docker compose up --build
```

Reproduces `npm run race` end-to-end: the `server` service runs the game,
the `agents` service joins the four scripted agents against it (sequentially,
in the same order as `scripts/runRace.js`, so a fixed seed stays fully
reproducible) and exits when the race ends, and the `client` service serves
the same spectator build standalone on port 8080 (split-deploy demo).

- Spectate: `http://localhost:3080/` (served by the game server) or
  `http://localhost:8080/?server=http://localhost:3080` (client service)
- Follow the race: `docker compose logs -f agents server`
- Decision log: `./log/race.jsonl` (remove it between runs)
- Same seed, join order and timing env → same standings as a bare
  `npm run race` on the same machine.

### Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3080` | HTTP port (MCP, spectator WS, static client, /state, /healthz) |
| `LAPS` | `20` | race length in laps |
| `WINDOW_SECONDS` | `20` | strategy window length (s) |
| `TICK_DELAY_MS` | `8` | wall delay between sim ticks (0 = max speed) |
| `SEED` | `42` | deterministic seed (same seed + same join order = same race) |
| `LOG_FILE` | stdout only | decision log path (the compose stack uses `/logs/race.jsonl`, mounted at `./log/`) |

For bare local runs, the CLI args to `node src/server/main.js`
(port, laps, window s, tick delay ms, seed, log file) override the env vars.

### Hosting notes (free tier)

The server idles in the `setup` phase until four agents join, then runs one
race of a few minutes and exits 0 — a good fit for "scale to zero" platforms.
Free tiers sleep idle instances, and the server has no *outbound* keep-alive
(inbound spectator pings only, see *Spectator client*) — so a race with a
connected spectator keeps the instance awake, while a race with nobody
watching may be hibernated mid-race on a free tier. The first real host
(Slice 3) should be chosen with that in mind; re-running after a cold start
is cheap because the seeded race is deterministic.

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

## Spectator client (Slice 2)

A plain-ES-module Three.js app in `client/` (no framework, Three.js vendored
in `client/vendor/`), served by the game server itself and live-connected
over **one WebSocket**.

**Server URL.** In this order: the `?server=` (or `?ws=`) query parameter,
then `window.MGP_SERVER_URL` (set from your hosting platform's env), then the
page's own origin. `http(s)` is converted to `ws(s)` and `/spectate` is
appended. Vercel deploy: publish `client/` as a static site and pass the
game server URL as `?server=` — or set `window.MGP_SERVER_URL` from a
build-time env var in the HTML template. (Vercel project configuration for
Slice 3; there is no `vercel.json` yet.)

**Protocol** (JSON over `ws://host:port/spectate`), 10 Hz server-push:

| Frame | Direction | Meaning |
| --- | --- | --- |
| `hello` | server → client | once on connect: protocol version, track, lap count, current phase. |
| `snapshot` | server → client | every 100 ms: a **self-contained** full state — phase, lap, window time, race clock, all cars (track distance `s`, status, tires, fuel, strategy), standings, spectator count. Because snapshots are complete, a reconnecting client just waits for the next one; no replay. |
| `ping` | client → server | keep-alive, ~every 30 s while the tab is open and the race is running. |
| `pong` | server → client | reply to `ping` (inbound traffic keeps free-tier hosts awake mid-race). |

On `phase: 'finished'` the server sends exactly one final snapshot, then goes
quiet but keeps connections open for the results screen; the client stops
reconnecting once it has seen it. The server process exits a few seconds
after the race (by design, it is one race per process): the final snapshot is
flushed synchronously before `race_complete` is printed, so it lands even
when the `npm run race` orchestrator kills the server, and the server then
stays up for a post-race grace period so browsers and orchestrators can still
fetch the final results. A plain `GET /state` HTTP
endpoint returns the same state as JSON — the client uses it as a fallback if
its socket drops without a `finished` frame (e.g. the host went to sleep),
and `2+ spectators` remain stable through a full race because each tab is an
independent, self-healing connection (auto-reconnect with backoff while the
race is still on).

Rendering: the track is a `CatmullRomCurve3` ribbon scaled to the server's
1000 m / 5-sector layout (sector ticks, start/finish, pit lane with boxes);
cars are simple colored meshes with projected DOM labels, interpolated
~150 ms behind real time between snapshots, oriented along the curve.
DOM overlays: phase chip, lap, race clock, spectator counter, strategy-window
banner (with per-driver submitted checkmarks), live leaderboard (with tire-wear
bars), start and results screens.

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
  server/http.js         HTTP server: MCP endpoint, GET /state, GET /healthz,
                         static files
  server/mcpServer.js    the MCP tool surface (one per session)
  server/raceSession.js  real-time owner: walls the clock, ticks the sim
  server/spectator.js    the spectator WebSocket hub (hello, 10 Hz snapshots,
                         keep-alive ping/pong, exactly-once final snapshot)
  server/staticFiles.js  minimal static file server for the client folder
  server/staticServe.js  standalone static server for split deploys (Docker
                         `client` service, Vercel)
client/                  Three.js spectator client (index.html, js/, vendor/)
agents/
  agentBase.js           MCP client loop: join, poll, submit once per lap
  run.js                 standalone agent process (npm run agent)
scripts/runRace.js       `npm run race` orchestrator (server + 4 agents)
scripts/runAgents.js     agents-only orchestrator for the Docker stack
Dockerfile               multi-stage, non-root image (server, agents, client)
docker-compose.yml       local stack: server + scripted-agent race + client
test/                    Vitest: sim, strategies, MCP over HTTP, end-to-end
log/                     decision logs (gitignored, .gitkeep keeps it for Docker)
```

## Decision log

Every race writes one JSONL file (path printed at the end of `npm run race`),
one line per event: `session_started`, `agent_joined`, `race_start`,
`window_opened`, `strategy_submitted`, `strategy_defaulted`, `window_closed`,
`lap_complete`, `overtake`, `pit_stop_enter`, `pit_stop_complete`, `finish`,
`retired`, `race_finished`, `session_finished`, spectator traffic
(`spectator_connected`, `spectator_disconnected`, `spectator_final_broadcast`)
— plus agent-side lines (`agent_decision`, `agent_strategy_rejected`) written
by the agent processes.
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
- `test/spectator.test.js` — the WebSocket feed against a real race: hello +
  self-contained snapshots, two concurrent spectators (plus a third mid-race),
  cars actually moving forward, exactly one final snapshot, keep-alive
  ping/pong, mid-race reconnect, and the real browser `SpectatorConnection`
  class (Node's built-in WebSocket) surviving a forced mid-race drop and
  reporting the end via `GET /state`.
- `test/static.test.js` — the static file server: the client page and its
  assets, `GET /state` JSON, `GET /healthz` (no race → race status with id +
  phase after an agent joins), path-traversal rejection, 404 for unknown paths.
- `test/staticServe.test.js` — the standalone static server for split
  deployments (same files, same 404 shape).

All tests are deterministic (seeded RNG, `tickWallDelayMs: 0`, immediate
window closes) and run in ~10 s.

## Roadmap

- **Slice 1 (done)** — core sim, MCP tools, scripted agents, logging, tests.
- **Slice 2 (done)** — Three.js spectator client over WebSocket.
- **Slice 3** — reactive windows + first Vercel deploy.
- **Slice 4** — Playwright e2e suite (smoke race as the gate).
- **Slice 5** — demo + polish.
