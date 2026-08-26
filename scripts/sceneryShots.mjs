/**
 * Scenery art-direction shots (MCPG-64, re-aimed for the crisp perspective
 * camera in MCPG-66): the four sign-off screenshots for the voxel circuit
 * look — island wide, pit lane close-up, start gantry mid-light-sequence,
 * grandstand close-up — plus per-map wides.
 *
 *   node scripts/sceneryShots.mjs            # -> .visual/shot-*.png
 *
 * Starts the real server with 4 scripted MCP agents, loads the spectator
 * page in headless Chromium and drives the documented
 * window.__mcpGpScene handle: the perspective camera is re-aimed at a
 * world point with a tighter framing (same fov, same reference azimuth —
 * just a shorter distance) for the close-ups.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.visual');
const port = Number(process.env.VISUAL_PORT ?? 3933);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server on :${port} not healthy in ${timeoutMs}ms`);
}

async function joinAgents(port, names) {
  const clients = [];
  for (const name of names) {
    const client = new Client({ name: 'scenery-shots', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await client.callTool({ name: 'join_race', arguments: { name } });
    clients.push(client);
  }
  return clients;
}

/**
 * Re-aim the perspective camera at a world point. `extent` is the visible
 * vertical span (meters) at the target: distance = extent / (2·tan 22.5°).
 * Same reference azimuth as the default framing (scene.js CAM_DIR).
 */
async function aimAt(page, target, extent, fromSouth = true) {
  const dist = extent / (2 * Math.tan((45 / 2) * Math.PI / 180));
  await page.evaluate(([t, d, south]) => {
    const s = window.__mcpGpScene;
    const dir = south ? [0.497, 0.392, 0.774] : [-0.497, 0.392, -0.774];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const cam = s.camera;
    cam.position.set(
      t[0] + (dir[0] / len) * d,
      t[1] + (dir[1] / len) * d,
      t[2] + (dir[2] / len) * d,
    );
    s.controls.target.set(t[0], t[1], t[2]);
    s.controls.update();
    s.render();
  }, [target, dist, fromSouth]);
}

const server = spawn(process.execPath, [path.join(root, 'src/server/main.js')], {
  env: {
    ...process.env,
    PORT: String(port),
    MCGP_TRACK: 'coastal-palm',
    LAPS: '5',
    WINDOW_SECONDS: '30',
    TICK_DELAY_MS: '5',
    SEED: '42',
    MIN_AGENTS: '4',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

let ok = true;
try {
  await waitForServer(port);
  const agents = await joinAgents(port, ['Shots One', 'Shots Two', 'Shots Three', 'Shots Four']);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mcpGpScene, null, { timeout: 20000 });
  // let the grid place, the overlay drop and the gantry sequence run
  await sleep(1800);

  // 1) island wide — the default fitted camera, right after the start
  await page.screenshot({ path: path.join(outDir, 'shot-1-island-wide.png') });
  console.log('shot-1-island-wide');

  // 2) pit lane close-up (garages + crew + slot boxes)
  const pit = await page.evaluate(() => {
    const t = window.__mcpGpScene.track;
    const c = t.pitBoxes[Math.floor(t.pitBoxes.length / 2)].pos;
    return [c.x, 0, c.z + 14];
  });
  await aimAt(page, pit, 110);
  await sleep(250);
  await page.screenshot({ path: path.join(outDir, 'shot-2-pit-lane.png') });
  console.log('shot-2-pit-lane');

  // 3) start gantry mid-light-sequence: reload -> the 6 s cycle restarts,
  // capture ~2.1 s in (four red, one dark)
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mcpGpScene, null, { timeout: 20000 });
  await sleep(2100);
  const gantry = await page.evaluate(() => {
    const t = window.__mcpGpScene.track;
    const p = t.pointAt(0);
    return [p.x, 8, p.z + 4];
  });
  await aimAt(page, gantry, 36);
  await sleep(250);
  await page.screenshot({ path: path.join(outDir, 'shot-3-start-gantry.png') });
  console.log('shot-3-start-gantry');

  // 4) grandstand close-up (the main-straight stand at s=40)
  const stand = await page.evaluate(() => {
    const t = window.__mcpGpScene.track;
    const p = t.pointAt(40);
    const tg = t.tangentAt(40);
    const nx = -tg.z;
    const nz = tg.x;
    // stand sits outside the straight; try both sides, pick the one farther
    // from the island center (same rule the scenery layer uses)
    const isl = t.island;
    const px = p.x + nx * 22;
    const pz = p.z + nz * 22;
    const qx = p.x - nx * 22;
    const qz = p.z - nz * 22;
    const rp = ((px - isl.cx) / isl.rx) ** 2 + ((pz - isl.cz) / isl.rz) ** 2;
    const rq = ((qx - isl.cx) / isl.rx) ** 2 + ((qz - isl.cz) / isl.rz) ** 2;
    const sgn = rp >= rq ? 1 : -1;
    return [p.x + nx * sgn * 20, 4, p.z + nz * sgn * 20];
  });
  // shoot from over the track so we see the seat rows, not the stand's back
  await aimAt(page, stand, 40, false);
  await sleep(250);
  await page.screenshot({ path: path.join(outDir, 'shot-4-grandstand.png') });
  console.log('shot-4-grandstand');

  if (errors.length) {
    ok = false;
    console.log('PAGE ERRORS:', errors.join(' | '));
  }
  await page.close();
  for (const c of agents) await c.close().catch(() => {});
} catch (err) {
  ok = false;
  console.log('FAIL', err.message);
} finally {
  server.kill('SIGTERM');
  await browser.close();
}
process.exit(ok ? 0 : 1);
