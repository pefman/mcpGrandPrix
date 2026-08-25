/**
 * Smoke test for the race FX + voxel UI skin (Step 4, MCPG-46).
 *
 * Loads the real spectator page against the real static server in headless
 * Chromium (same software-WebGL setup as scripts/visualCheck.mjs) and checks
 * the two deliverables that need a browser:
 *
 *  1. the FX module (client/js/fx.js) runs a full particle lifecycle in-page
 *     (spawn -> update -> drain -> dispose) for all four effect kinds,
 *     without a runtime error — driven by a blob module (page/blobfx.js,
 *     auto-served by the static server) that imports the REAL modules;
 *  2. the page renders with the voxel skin — major panels carry the chunky
 *     hard-edge border + offset drop shadow, no rounding — and reports zero
 *     unexpected console/page errors.
 *
 * No race is started: FX are driven from inside the page, which is enough
 * for a client-side smoke test; the live race moments they fire on (overtake
 * bursts, start/finish, pit) are driven from snapshot state that the sim's
 * own tests already cover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../src/server/staticServe.js';
import { closeServer } from './helpers.js';
import { chromium } from 'playwright';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

let server;
let baseUrl;
let browser;

beforeAll(async () => {
  server = createStaticServer(clientDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    // Software WebGL keeps this deterministic on headless/CI machines.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await closeServer(server);
});

describe('race FX + voxel UI skin (MCPG-46)', () => {
  let page;
  const errors = [];

  beforeAll(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // expected: the static server has no /spectate WebSocket endpoint
      if (m.text().includes('/spectate')) return;
      errors.push(`console: ${m.text()}`);
    });
    await page.goto(baseUrl, { waitUntil: 'load' });
  }, 30000);

  afterAll(async () => {
    await page?.close().catch(() => {});
  });

  it('serves the FX module', async () => {
    const res = await fetch(`${baseUrl}/js/fx.js`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('createFx');
  });

  it('runs a full FX particle lifecycle in-page for all four effects', async () => {
    // page/blobfx.js imports the real 'three' + client/js/fx.js (the page's
    // importmap resolves both), runs one burst of every effect kind,
    // advances the clock past the longest particle life, and records the
    // result on window.__fxResult. It is injected as a <script type=module>
    // (no dynamic import — vitest would rewrite it in the evaluated fn).
    await page.addScriptTag({ url: `${baseUrl}/blobfx.js`, type: 'module' });
    await page.waitForFunction(() => !!window.__fxResult, { timeout: 20000 });
    const result = await page.evaluate(() => window.__fxResult);
    expect(result).toBeTruthy();
    expect(result.saw).toBeGreaterThan(0);
    expect(result.drained).toBe(true);
  });

  it('renders the page with the voxel skin and no client errors', async () => {
    // wait for the canvas to actually be sized (scene initialized)
    await page.waitForFunction(
      () => {
        const c = document.querySelector('#scene');
        return c && c.width > 0 && c.height > 0;
      },
      { timeout: 20000 },
    );
    const skin = await page.evaluate(() => {
      const panel = getComputedStyle(document.querySelector('#leaderboard'));
      const chip = getComputedStyle(document.querySelector('#phase-chip'));
      return {
        panelRadius: panel.borderRadius,
        panelBorder: panel.borderTopWidth,
        panelShadow: panel.boxShadow,
        chipRadius: chip.borderRadius,
      };
    });
    // chunky skin: no rounding, a thick border, a hard offset shadow
    expect(skin.panelRadius).toBe('0px');
    expect(parseInt(skin.panelBorder, 10)).toBeGreaterThanOrEqual(2);
    expect(skin.panelShadow).not.toBe('none');
    expect(skin.chipRadius).toBe('0px');
    expect(errors).toEqual([]);
  });

  it('mounts the 2D minimap panel above the features badge (MCPG-31)', async () => {
    const ok = await page.evaluate(() => {
      const panel = document.querySelector('#minimap-panel');
      const badge = document.querySelector('#features-badge');
      const canvas = document.querySelector('#minimap');
      if (!panel || !canvas || !badge) return false;
      const p = panel.getBoundingClientRect();
      const b = badge.getBoundingClientRect();
      // the map panel must sit fully above the features badge
      return p.left >= 0 && p.bottom <= b.top && p.width > 0;
    });
    expect(ok).toBe(true);
  });
});
