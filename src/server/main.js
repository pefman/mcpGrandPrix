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
 * MCGP_TRACK (track id from the `tracks/` registry; default `coastal-palm`;
 * seeds the FIRST race only — afterwards the post-race spectator vote
 * decides, MCPG-28), RESULTS_HOLD_SECONDS (hold the results screen before
 * opening the next session; default 60), PENDING_GRACE_SECONDS (claim window
 * per queued seat; default 30), VOTE_WINDOW_SECONDS (post-race track-voting
 * window; default 30, 0 disables), MCGP_SEASON_FILE (championship season
 * persistence file; default /logs/season.json on the log volume, MCPG-49),
 * MCGP_DOSSIER_FILE (team dossiers; default /logs/team_dossiers.json on
 * the log volume, MCPG-62). Prints one JSON object per line on stdout: server_ready, every logged
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
import { createTrackFromEnv, NEXT_TRACK_FILE } from '../tracks.js';
import { SEASON_FILE } from '../season.js';
import { DOSSIER_FILE } from '../teamDossier.js';
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
// Unknown ids throw here — fail fast, before any client connects. From the
// second race on the post-race vote decides the track instead (MCPG-28).
const track = createTrackFromEnv();

let spectatorHub = null;
const orchestrator = new RaceOrchestrator({
  // MCPG-28: the vote winner is persisted on the log volume so a container
  // restart between races cannot lose the decision.
  nextTrackFile: NEXT_TRACK_FILE,
  // MCPG-49: the championship season persists on the same log volume.
  seasonFile: SEASON_FILE,
  // MCPG-62: the team dossiers (autopilot vs driver choices) persist beside
  // the season on the same log volume.
  dossierFile: DOSSIER_FILE,
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
    // MCPG-28: the voting window opens right away; the hub notices the
    // phase change and broadcasts the voting state + snapshots itself.
    spectatorHub.finalize();
  },
  onVoteEnd: (result) => spectatorHub?.finalizeVote(result),
});

const server = createMcpHttpServer(orchestrator, { staticDir: clientDir });
spectatorHub = createSpectatorHub(server, orchestrator.session, {
  getSession: () => orchestrator.session, // rebind across session rotations (MCPG-34)
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
