/**
 * Server entry point.
 *
 *   node src/server/main.js [port] [totalLaps] [windowSeconds] [tickDelayMs] [seed] [logFile]
 *
 * Env overrides: PORT, LAPS, WINDOW_SECONDS, TICK_DELAY_MS, SEED, LOG_FILE.
 * Prints one JSON object per line on stdout: server_ready, every logged
 * race event/decision, and race_complete with final standings.
 */
import { createMcpHttpServer } from './http.js';
import { RaceSession } from './raceSession.js';

const [
  ,
  ,
  portArg = process.env.PORT ?? '3080',
  lapsArg = process.env.LAPS ?? '20',
  windowArg = process.env.WINDOW_SECONDS ?? '20',
  delayArg = process.env.TICK_DELAY_MS ?? '8',
  seedArg = process.env.SEED ?? '42',
  logArg = process.env.LOG_FILE ?? '',
] = process.argv;

const session = new RaceSession({
  totalLaps: Number(lapsArg),
  strategyWindowSeconds: Number(windowArg),
  tickWallDelayMs: Number(delayArg),
  seed: Number(seedArg),
  logFile: logArg || null,
  logToStdout: true,
});

const server = createMcpHttpServer(session);
server.listen(Number(portArg), () => {
  console.log(JSON.stringify({ type: 'server_ready', port: Number(portArg) }));
  session
    .run()
    .then(() => {
      console.log(JSON.stringify({ type: 'race_complete', standings: session.standings() }));
      session.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    })
    .catch((err) => {
      console.error(JSON.stringify({ type: 'server_error', error: err.message }));
      process.exit(1);
    });
});
