/**
 * Pack screenshot set (MCPG-72) — per-track sign-off shots for the first
 * procedural 5-pack: island wide, start/pit lane close-up, and the map's
 * signature corner (max-curvature feature). For each track id it starts the
 * real server, joins 4 scripted MCP agents (full grid on scene), loads the
 * spectator page in headless Chromium and drives the documented
 * window.__mcpGpScene handle (same camera re-aim as scripts/sceneryShots.mjs).
 *
 *   node scripts/packShots.mjs gen-flow-000024 gen-technical-000025 ...
 *   PACK_TRACKS="a,b,c" node scripts/packShots.mjs
 *
 *   -> .visual/<id>-island.png, <id>-start.png, <id>-corner.png
 *
 * Engine/sim/network untouched: this only points a camera at already-rendered
 * scene geometry.
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
const basePort = Number(process.env.VISUAL_PORT ?? 3951);

// Track ids to shoot: positional args, else the comma-list in PACK_TRACKS.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = positional.length
  ? positional
  : (process.env.PACK_TRACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (ids.length === 0) {
  console.error('usage: node scripts/packShots.mjs <id> [<id> ...]   (or PACK_TRACKS="a,b,c")');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server on :${port} not healthy in ${timeoutMs}ms`);
}

async function joinAgents(port, names) {
  const clients = [];
  for (const name of names) {
    const client = new Client({ name: 'pack-shots', version: '1.0.0' });
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
    s.camera.position.set(
      t[0] + (dir[0] / len) * d,
      t[1] + (dir[1] / len) * d,
      t[2] + (dir[2] / len) * d,
    );
    s.controls.target.set(t[0], t[1], t[2]);
    s.controls.update();
    s.render();
  }, [target, dist, fromSouth]);
}

/**
 * Find the arc-length position (s, meters) of the map's sharpest corner:
 * sample tangents along the curve, score turn angle per meter, take argmax.
 * Runs in the page where the track's curve/tangent helpers live.
 */
async function signatureCornerS(page) {
  return page.evaluate(() => {
    const t = window.__mcpGpScene.track;
    const L = t.def.lengthM;
    const N = 400;
    let best = 0, bestS = 0;
    let prev = t.tangentAt(0);
    for (let i = 1; i <= N; i++) {
      const s = (i / N) * L;
      const tang = t.tangentAt(s);
      const ang = Math.acos(Math.min(1, Math.max(-1, prev.x * tang.x + prev.y * tang.y + prev.z * tang.z)));
      const score = ang / (L / N);
      if (score > best) { best = score; bestS = s; }
      prev = tang;
    }
    return bestS;
  });
}

const browser = await chromium.launch({
  // Software WebGL keeps this deterministic on headless/CI machines.
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

let allOk = true;
try {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const port = basePort + i * 7; // isolate ports per sequential server
    const server = spawn(process.execPath, [path.join(root, 'src/server/main.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        MCGP_TRACK: id,
        LAPS: '5',
        WINDOW_SECONDS: '30', // long window: cars hold on the grid, stable scene
        TICK_DELAY_MS: '5',
        SEED: '42',
        MIN_AGENTS: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    server.stdout.on('data', (d) => log.push(d.toString()));
    server.stderr.on('data', (d) => log.push(d.toString()));

    let ok = true;
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    try {
      await waitForServer(port);
      const agents = await joinAgents(port, ['Pack One', 'Pack Two', 'Pack Three', 'Pack Four']);
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await page.waitForFunction(
        () => {
          const c = document.querySelector('#scene');
          return c && c.width > 0 && c.height > 0 && window.__mcpGpScene;
        },
        { timeout: 20000 },
      );
      // let the scene fit, the grid place, and the gantry light-sequence run
      await sleep(4500);

      // 1) island wide — the default fitted camera
      const island = path.join(outDir, `${id}-island.png`);
      await page.screenshot({ path: island });

      // 2) start / pit lane close-up (gantry at s=0, raised for a 3/4 view)
      const start = await page.evaluate(() => {
        const t = window.__mcpGpScene.track;
        const p = t.pointAt(2);
        return [p.x, 12, p.z];
      });
      await aimAt(page, start, 52);
      await sleep(250);
      const pit = path.join(outDir, `${id}-start.png`);
      await page.screenshot({ path: pit });

      // 3) signature corner close-up (sharpest feature on the map)
      const sMax = await signatureCornerS(page);
      const corner = await page.evaluate((s) => {
        const t = window.__mcpGpScene.track;
        const p = t.pointAt(s);
        return [p.x, 6, p.z];
      }, sMax);
      await aimAt(page, corner, 34);
      await sleep(250);
      const cornerShot = path.join(outDir, `${id}-corner.png`);
      await page.screenshot({ path: cornerShot });

      for (const c of agents) await c.close().catch(() => {});
      if (errors.length) {
        ok = false;
        console.log(`FAIL ${id}: ${errors.join(' | ')}`);
      } else {
        console.log(`PASS ${id}: island ${fs.statSync(island).size}B, start ${fs.statSync(pit).size}B, corner(s=${Math.round(sMax)}m) ${fs.statSync(cornerShot).size}B`);
      }
    } catch (err) {
      ok = false;
      console.log(`FAIL ${id}: ${err.message}`);
      if (log.length) console.log(log.join(''));
    } finally {
      server.kill('SIGTERM');
      await sleep(300);
      await page.close();
    }
    allOk = allOk && ok;
  }
} finally {
  await browser.close();
}
process.exit(allOk ? 0 : 1);