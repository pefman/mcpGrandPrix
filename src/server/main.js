/**
 * MCP Grand Prix — persistent game server entry point (MCPG-34).
 *
 *   node src/server/main.js [port] [totalLaps] [windowSeconds] [tickDelayMs] [seed] [logFile]
 *
 * One process for the whole site lifetime: the RaceOrchestrator rotates
 * race sessions (race -> hold results -> open next session -> setup -> ...),
 * so late-joining MCP agents always have a race to get into (pending queue)
 * and spectators keep one connection across races.
 *
 * Env overrides: PORT, LAPS, WINDOW_SECONDS, REACTIVE_WINDOW_SECONDS
 * (defaults to WINDOW_SECONDS), TICK_DELAY_MS, SEED, LOG_FILE, MIN_AGENTS
 * (cars required to leave setup; default 4 — use 1 for solo demo),
 * MCGP_TRACK (track id from the `tracks/` registry; default `coastal-palm`),
 * RESULTS_HOLD_SECONDS (hold the results screen before opening the next
 * session; default 60), PENDING_GRACE_SECONDS (claim window per queued seat;
 * default 30).
 * Prints one JSON object per line on stdout: server_ready, every logged
 * race event/decision, and race_complete with final standings (per race).
 *
 * Endpoints: /mcp (MCP agents), /spectate (WebSocket spectators),
 * /state + /healthz (JSON), / (spectator client, static).
 *
 * The DecisionLogger truncates its file on open, so one logger per process
 * (owned by the orchestrator) = one log per deployment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer } from './http.js';
import { createSpectatorHub, SPECTATE_PATH } from './spectator.js';
import { createTrackFromEnv } from '../tracks.js';
import { RaceOrchestrator } from './raceOrchestrator.js';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');

const [
  ,
  ,
  portArg = process.env.PORT ?? '3080',
  lapsArg = process.env.LAPS ?? '10',
  windowArg = process.env.WINDOW_SECONDS ?? '30',
  delayArg = process.env.TICK_DELAY_MS ?? '250', // 1x real time: ~10 s wall per lap
  seedArg = process.env.SEED ?? '42',
  logArg = process.env.LOG_FILE ?? '',
] = process.argv;

// MCGP-27: the active track comes from the `tracks/` registry (MCGP_TRACK).
// Unknown ids throw here — fail fast, before any client connects.
const track = createTrackFromEnv();

let spectatorHub = null;
const orchestrator = new RaceOrchestrator({
  totalLaps: Number(lapsArg),
  strategyWindowSeconds: Number(windowArg),
  // Own default (10 s, in the 8-15 s spec band) — deliberately NOT derived
  // from WINDOW_SECONDS, so a 30 s strategy window cannot silently stretch
  // reactive windows with it.
  reactiveWindowSeconds: Number(process.env.REACTIVE_WINDOW_SECONDS ?? '10'),
  tickWallDelayMs: Number(delayArg),
  seed: Number(seedArg),
  track,
  logFile: logArg || null,
  logToStdout: true,
  onSession: () => spectatorHub?.reset(),
  onRaceComplete: (session, raceSeq) => {
    // Send the final snapshot to every spectator synchronously, BEFORE
    // printing race_complete: runRace.js SIGTERMs the server the moment it
    // sees that line, so anything scheduled after it may never run.
    spectatorHub.finalize();
    console.log(
      JSON.stringify({
        type: 'race_complete',
        raceSeq,
        raceId: session.raceId,
        standings: session.standings(),
      }),
    );
  },
});

const server = createMcpHttpServer(orchestrator, { staticDir: clientDir });
spectatorHub = createSpectatorHub(server, orchestrator, {
  onEvent: (event) => orchestrator.logger.log(event), // spectator traffic in the decision log
});

orchestrator.run().catch((err) => {
  console.error(JSON.stringify({ type: 'server_error', error: err?.message ?? String(err) }));
  process.exit(1);
});

server.listen(Number(portArg), () => {
  console.log(JSON.stringify({
    type: 'server_ready',
    port: Number(portArg),
    track: track.info(),
    spectatorUrl: `http://127.0.0.1:${portArg}/`,
    spectateWs: `ws://127.0.0.1:${portArg}${SPECTATE_PATH}`,
  }));
});

// Graceful shutdown: SIGTERM/SIGINT (runRace.js, docker stop, VPS deploys).
// Emits `shutting_down` (never server_error — runRace.js watches stdout for
// the latter) and exits 0. A force-exit backstop covers a wedged close.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  orchestrator.shutdown(signal);
  spectatorHub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
