/**
 * Server entry point.
 *
 *   node src/server/main.js [port] [totalLaps] [windowSeconds] [tickDelayMs] [seed] [logFile]
 *
 * Env overrides: PORT, LAPS, WINDOW_SECONDS, REACTIVE_WINDOW_SECONDS (defaults
 * to WINDOW_SECONDS), TICK_DELAY_MS, SEED, LOG_FILE, MIN_AGENTS (cars required
 * to leave setup; default 4 — use 1 for solo demo), MCGP_TRACK (track id from
 * the `tracks/` registry; default `coastal-palm`).
 * Prints one JSON object per line on stdout: server_ready, every logged
 * race event/decision, and race_complete with final standings.
 *
 * Also serves the Slice 2 spectator client (static files at /, live
 * WebSocket feed at /spectate) so the race can be watched in a browser.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer } from './http.js';
import { RaceSession } from './raceSession.js';
import { createSpectatorHub, SPECTATE_PATH } from './spectator.js';
import { createTrackFromEnv } from '../tracks.js';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');

// After the race ends, keep accepting connections for a few seconds so
// spectators and orchestrators (e.g. the Docker agents service polling
// GET /state) can fetch the final standings before the container exits.
const POST_RACE_GRACE_MS = 3000;

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

const session = new RaceSession({
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
});

const server = createMcpHttpServer(session, { staticDir: clientDir });
const spectator = createSpectatorHub(server, session, {
  onEvent: (event) => session.logger.log(event), // spectator traffic in the decision log
});
server.listen(Number(portArg), () => {
  console.log(JSON.stringify({
    type: 'server_ready',
    port: Number(portArg),
    track: track.info(),
    spectatorUrl: `http://127.0.0.1:${portArg}/`,
    spectateWs: `ws://127.0.0.1:${portArg}${SPECTATE_PATH}`,
  }));
  session
    .run()
    .then(async () => {
      // Send the final snapshot to every spectator synchronously, BEFORE
      // printing race_complete: the `npm run race` orchestrator SIGTERMs
      // the server the moment it sees that line, so anything scheduled
      // after it (timers, close handshakes) may never run. Frames written
      // now are flushed to the sockets while the process is alive.
      spectator.finalize();
      console.log(JSON.stringify({ type: 'race_complete', standings: session.standings() }));
      // Post-race grace: final frames already flushed above; stay up so the
      // final state remains fetchable (see POST_RACE_GRACE_MS).
      await new Promise((resolve) => setTimeout(resolve, POST_RACE_GRACE_MS));
      session.close();
      spectator.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    })
    .catch((err) => {
      console.error(JSON.stringify({ type: 'server_error', error: err.message }));
      process.exit(1);
    });
});
