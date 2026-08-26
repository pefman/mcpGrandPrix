/**
 * MCPG-62: the 3-tactic lock-in loop, end to end — the acceptance smoke.
 *
 * Real server (MCP + spectator WS + static client) with four scripted MCP
 * agents on the grid (three plain-packet strategists + one junior strategist
 * that posts 2-3 card envelopes like an LLM team would) and a headless
 * Chromium browser playing the HUMAN DRIVER through the real cockpit UI:
 *
 *   lap 1  claim the junior car's seat (AUTOPILOT is the resting default)
 *   lap 2  lock in a NON-recommended card (deliberate manual choice)
 *   lap 3  override with a raw packet (pace PUSH)
 *   lap 4  resume AUTOPILOT
 *   lap 5  ride it out on autopilot
 *
 * Then the race must finish cleanly: no page errors, no server errors, all
 * four cars FINISHED, and the decision log shows the seat's mode history
 * [autopilot, overridden, overridden, autopilot, autopilot].
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceSession } from '../src/server/raceSession.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { closeServer, waitFor } from './helpers.js';

const TOTAL_LAPS = 5;
const WINDOW_S = 6; // headless click round-trips need a live window
const clientDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../client'); // the real client/ served by the MCP HTTP server

let session;
let logger;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let agentsDone;
let browser;
let page;

/** DOM assertion helper (bare `playwright` has no locator matchers). */
async function awaitDom(pred) {
  await page.waitForFunction(pred, null, { timeout: 15000 });
}
async function visible(elId) {
  return awaitDom(`() => {
    const el = document.getElementById('${elId}');
    return !!el && !el.classList.contains('hidden');
  }`);
}
async function chipMode(mode) {
  return awaitDom(`() => document.getElementById('cockpit-chip')?.dataset.mode === '${mode}'`);
}

const pageErrors = [];
let juniorId = null;

/** Wait for the cockpit's live state (exposed as window.__mcpGpCockpit). */
const cockpitState = () => page.evaluate(() => window.__mcpGpCockpit?.get() ?? null);
async function awaitWindow(lap) {
  await page.waitForFunction(
    (lapN) => {
      const s = window.__mcpGpCockpit?.get?.();
      return s && s.phase === 'strategy_window' && s.windowLap === lapN
        && s.plan && s.plan.proposals.length > 0;
    },
    lap,
    { timeout: 40000 },
  );
}

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-cockpit-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_S,
    reactiveWindowSeconds: 0.5,
    tickWallDelayMs: 0,
    seed: 42,
    juniorFallbackSeconds: 0, // the junior agent always posts; no timer needed
    earlyCloseStrategyWindows: false, // hold windows open for the human's clicks
    logFile,
    logToStdout: false,
  });
  logger = session.logger;

  server = createMcpHttpServer(session, { staticDir: clientDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  hub = createSpectatorHub(server, session, {
    getSession: () => session,
    onEvent: (event) => logger.log(event),
  });

  // The human driver's browser connects BEFORE the grid fills, so the race
  // cannot lap ahead of the cockpit.
  browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('/spectate')) {
      pageErrors.push(`console: ${m.text()}`);
    }
  });
  await page.goto(`${baseUrl}/`);
  await page.waitForFunction(() => window.__mcpGpCockpit != null, null, { timeout: 15000 });
  // the first snapshot (phase 'setup') reveals the cockpit
  await page.waitForFunction(
    () => {
      const s = window.__mcpGpCockpit?.get?.();
      return s && s.phase != null;
    },
    null,
    { timeout: 15000 },
  );

  session.run();

  // The grid: three plain strategists + the junior "AI team" strategist.
  const agents = [
    { profile: 'aggressive', name: 'Aggro', seed: 71 },
    { profile: 'conservative', name: 'Turtle', seed: 72 },
    { profile: 'pitHeavy', name: 'PitPete', seed: 73 },
    { profile: 'junior', name: 'JuniorJr', seed: 74 },
  ];
  agentsDone = Promise.all(agents.map((a) => runAgent({
    name: a.name,
    serverUrl: `${baseUrl}/mcp`,
    decide: SCRIPTED_AGENTS[a.profile].decide,
    decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
    rng: createRng(a.seed),
    pollMs: 50,
  })));
  await waitFor(() => session.state().phase === 'strategy_window', 30000, 'first strategy window');
  juniorId = session.state().cars.find((c) => c.name === 'JuniorJr')?.id;
  expect(juniorId).toBeTruthy();
}, 90000);

afterAll(async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  session?.close();
  hub?.close();
  if (server) await closeServer(server);
  logger?.close();
  await agentsDone.catch(() => {});
});

describe('cockpit smoke: the 3-tactic lock-in loop (MCPG-62)', () => {
  it('lap 1 — the cockpit claims the junior car; AUTOPILOT is the resting default', async () => {
    // the claim list shows every car; only the junior row's seat is ours to take
    const claimBtn = page.locator(`#cockpit-claim-list .ck-claim-row[data-car-id="${juniorId}"] button[data-action="claim"]`);
    await claimBtn.click({ timeout: 30000 });

    // the seat ack flips the cockpit into the driver panel (AUTOPILOT)
    await page.waitForFunction(
      (cid) => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.carId === cid && s.claimed && s.mode === 'autopilot';
      },
      juniorId,
      { timeout: 10000 },
    );
    await visible('cockpit-panel');
    await chipMode('autopilot');
    const chipText = await page.locator('#cockpit-chip').textContent();
    expect(chipText.toUpperCase()).toContain('AUTOPILOT');

    // the team plan of this window lands as cards with server-stamped projections
    await awaitWindow(1);
    const state = await cockpitState();
    expect(state.plan.source).toBe('team');
    expect(state.plan.proposals.length).toBeGreaterThanOrEqual(2);
    // lap 1 ends on autopilot: no driver action at all
  }, 60000);

  it('lap 2 — lock in a NON-recommended card: the seat flips to MANUAL', async () => {
    await awaitWindow(2);
    const cards = page.locator('#cockpit-cards .tactic-card');
    await cards.first().waitFor({ timeout: 10000 });
    const altBtn = page.locator('#cockpit-cards .tactic-card:not(.recommended) button[data-action="lock"]').first();
    await altBtn.click({ timeout: 10000 });

    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.mode === 'manual' && s.action?.kind === 'lock' && s.action.trusted === false;
      },
      null,
      { timeout: 10000 },
    );
    await chipMode('manual');
    // the radio feed records the driver's own call
    await awaitDom("() => !!document.querySelector('#cockpit-radio .ck-radio-line.driver')");
  }, 60000);

  it('lap 3 — override with a raw packet (pace PUSH)', async () => {
    await awaitWindow(3);
    // the MANUAL seat persisted across the window boundary
    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.windowLap === 3 && s.mode === 'manual' && s.plan;
      },
      null,
      { timeout: 15000 },
    );
    const pacePush = page.locator('#cockpit-override button[data-ov="pace"][data-val="push"]');
    await pacePush.waitFor({ timeout: 10000 });
    await pacePush.click();
    await awaitDom(() => !!document.querySelector('#cockpit-override button[data-ov="pace"][data-val="push"]')?.classList.contains('on'));
    await page.locator('#cockpit-override button[data-action="override-send"]').click({ timeout: 10000 });

    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.mode === 'manual' && s.action?.kind === 'override';
      },
      null,
      { timeout: 10000 },
    );
  }, 60000);

  it('lap 4 — resume AUTOPILOT: the resting default comes back', async () => {
    await awaitWindow(4);
    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.windowLap === 4 && s.mode === 'manual' && s.plan;
      },
      null,
      { timeout: 15000 },
    );
    const resume = page.locator('#cockpit-actions button[data-action="resume"]');
    await resume.waitFor({ timeout: 10000 });
    await resume.click();
    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.mode === 'autopilot' && s.action == null;
      },
      null,
      { timeout: 10000 },
    );
    await chipMode('autopilot');
  }, 60000);

  it('lap 5 + finish — autopilot carries it home; the race ends clean with the full mode history', async () => {
    await page.waitForFunction(
      () => {
        const s = window.__mcpGpCockpit?.get?.();
        return s && s.phase === 'finished';
      },
      null,
      { timeout: 90000 },
    );

    // no client-side errors (the /spectate noise on the static-only fallback is filtered)
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === 'server_error')).toBe(false);
    expect(lines.some((l) => l.type === 'race_finished')).toBe(true);

    // the driver's seat wrote its full mode history into the window resolutions
    const decisions = lines
      .filter((l) => l.type === 'window_closed')
      .flatMap((l) => l.decisions ?? [])
      .filter((d) => d.carId === juniorId);
    expect(decisions.length).toBe(TOTAL_LAPS);
    expect(decisions.map((d) => d.mode)).toEqual([
      'autopilot', // lap 1: the resting default (fresh claim)
      'overridden', // lap 2: the driver locked a non-recommended card
      'overridden', // lap 3: the driver's raw-packet override
      'autopilot', // lap 4: RESUME AUTOPILOT
      'autopilot', // lap 5: hands off
    ]);

    // the team dossier recorded the same windows (persisted beside season.json)
    const state = session.state();
    const dossier = state.dossiers?.['JuniorJr'];
    expect(dossier?.windows?.length).toBe(TOTAL_LAPS);
    expect(dossier.trust).toMatchObject({ overridden: 2, autopilot: 3 });

    const standings = session.standings();
    expect(standings.length).toBe(4);
    for (const s of standings) expect(s.status).toBe('FINISHED');

    // the results overlay lists the dossier rows for the proposing team
    await awaitDom(() => !!document.querySelector('#finished-dossiers .dos-row'));
  }, 150000);
});