/**
 * Voxel cars + pit transition (Step 3, MCPG-45) — browser level.
 *
 * Two things in one real-race harness (5 laps, 4 MCP agents, headless
 * Chromium on the LIVE spectator page):
 *
 *   1. the live page: four cars with the SERVER-assigned livery colors,
 *      a car actually observed in PITTING state (the 3rd agent pits at
 *      the first tick of every lap), zero page/console JS errors over the
 *      whole race;
 *   2. the voxel model itself, driven through the real scene.js via
 *      client/blobcars.js: 10 boxes per car, exactly body/splitter/wing
 *      livery-painted, 4 wheels, the pit tween parks the car in its pit
 *      box (no teleport: position is driven by setCar over time), and
 *      RETIRED fades the livery to the dim color.
 *
 * The sim is untouched by this step — pit stops keep their real behavior
 * (car frozen at its entry point); only the client renders the drive-in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMcpHttpServer } from '../src/server/http.js';
import { RaceSession } from '../src/server/raceSession.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { driveWindows, closeServer, waitFor, WINDOW_BACKSTOP_S } from './helpers.js';

const TOTAL_LAPS = 5;
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let session;
let server;
let hub;
let baseUrl; // http://127.0.0.1:port/  (spectator page)
let wsUrl;
let logFile;
let browser;
let page;
let observerWs; // Node WS spectator used to watch for PITTING

let pageErrors = [];
let consoleErrors = [];
let carColors = {};   // carId -> '#rrggbb' (server-assigned, join order kept)
let swatchColors = []; // the live leaderboard swatches (inline styles)
let pitObserved = []; // carIds seen with status PITTING in live snapshots
let carsResult = null; // blob result (window.__carsResult)

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-voxel-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S, // backstop only; windows close on submit
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 42,
    logFile,
    logToStdout: false,
  });
  server = createMcpHttpServer(session, { staticDir: clientDir });
  hub = createSpectatorHub(server, session, {
    onEvent: (e) => session.logger.log(e),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  // Node spectator: records every car ever observed PITTING
  observerWs = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'snapshot' || !msg.cars) return;
      for (const c of msg.cars) if (c.status === 'PITTING') pitObserved.push(c.id);
    });
    ws.addEventListener('open', () => resolve(ws));
  });

  // the live spectator page
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // 3rd to join: pits at the first tick of every lap (deterministic pitter)
  const alwaysPit = {
    profile: 'alwaysPit',
    decide: () => ({ pace: 'normal', tireManagement: 'normal', aggression: 0, defend: 0, pitNow: true }),
    decideReactive: () => ({ type: 'hold' }),
  };
  const agents = [
    { name: 'Aggro', ...SCRIPTED_AGENTS.aggressive, seed: 101 },
    { name: 'Turtle', ...SCRIPTED_AGENTS.conservative, seed: 102 },
    { name: 'PitPete', ...alwaysPit, seed: 103 },
    { name: 'Randy', ...SCRIPTED_AGENTS.random, seed: 104 },
  ];

  const runPromise = session.run();
  const drivePromise = driveWindows(session);
  await Promise.all(
    agents.map((a) =>
      runAgent({
        name: a.name,
        serverUrl: `${baseUrl}mcp`,
        decide: a.decide,
        decideReactive: a.decideReactive,
        rng: createRng(a.seed),
        logFile,
      }),
    ),
  );

  // all four cars on the live leaderboard, each with its livery swatch
  await page.waitForFunction(
    () => document.querySelectorAll('#lb-rows .lb-swatch').length >= 4,
    null,
    { timeout: 15000 },
  );
  swatchColors = await page.evaluate(() =>
    [...document.querySelectorAll('#lb-rows .lb-swatch')].map((el) => el.style.background),
  );
  await waitFor(() => session.state().cars.length === 4, 15000, 'server to register 4 cars');
  carColors = {};
  for (const c of session.state().cars) carColors[c.id] = c.color;

  // drive the real scene.js through the page (hidden canvas, own scene)
  await page.evaluate((colors) => {
    window.__testColors = colors;
  }, Object.values(carColors)); // join order
  await page.addScriptTag({ url: `${baseUrl}blobcars.js`, type: 'module' });
  carsResult = await page
    .waitForFunction(() => window.__carsResult, null, { timeout: 20000 })
    .then((h) => h.jsonValue());

  // the pitter actually entered the pit lane in the live race
  await waitFor(() => pitObserved.length > 0, 30000, 'a live PITTING snapshot');

  await Promise.all([drivePromise, runPromise]);
}, 90000);

afterAll(async () => {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  observerWs?.close();
  if (server) await closeServer(server);
});

const norm = (c) => String(c).toLowerCase().trim();
const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('live page (MCPG-45)', () => {
  it('the race finished with four cars and no page or console JS errors', () => {
    expect(session.state().phase).toBe('finished');
    expect(Object.keys(carColors)).toHaveLength(4);
    const errors = [...pageErrors, ...consoleErrors];
    expect(errors).toEqual([]);
  });

  it('shows four leaderboard swatches matching the server-assigned livery colors', () => {
    expect(swatchColors.length).toBeGreaterThanOrEqual(4);
    // the browser normalizes inline hex to rgb() on read-back
    const pageSet = new Set(swatchColors.map(norm));
    const serverSet = new Set(Object.values(carColors).map(rgbOf));
    expect(pageSet).toEqual(serverSet);
  });

  it('a car was actually observed PITTING in the live snapshot feed', () => {
    expect(pitObserved.length).toBeGreaterThan(0);
    expect(carColors[pitObserved[0]]).toBeTruthy();
  });
});

describe('voxel car model through the real scene.js (MCPG-45)', () => {
  it('built four 10-box cars, each with exactly body/splitter/wing livery-painted per server color', () => {
    expect(carsResult.carCount).toBe(4);
    for (let i = 0; i < 4; i++) {
      const car = carsResult.cars[i];
      expect(car.parts, `car ${i} part count`).toBe(10);
      expect(car.wheels, `car ${i} wheel count`).toBe(4);
      expect(car.livery, `car ${i} livery parts`).toHaveLength(3);
    }
    // cars 0-2 keep their livery; car 3 was RETIRED during the drive (see below)
    for (let i = 0; i < 3; i++) {
      for (const c of carsResult.cars[i].livery) {
        expect(norm(c), `car ${i} livery color`).toBe(norm(carsResult.expected[i]));
      }
    }
  });

  it('pit transition: the pitting car is parked in its pit box after the tween', () => {
    expect(carsResult.pitDistanceM).toBeLessThan(0.5);
    expect(carsResult.pitBox).toBeTruthy();
  });

  it('non-pitting cars sit exactly on the track centerline', () => {
    expect(carsResult.onTrackDistanceM).toBeLessThan(0.5);
  });

  it('RETIRED fades the livery to the dim color (and only the livery)', () => {
    expect(carsResult.retiredLivery).toHaveLength(3);
    for (const c of carsResult.retiredLivery) expect(norm(c)).toBe('#3a3f48');
    expect(carsResult.nonLiveryDimmed).toBe(false);
  });
});
