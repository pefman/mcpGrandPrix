/**
 * Perf + stability probe for the spectator renderer (MCPG-66):
 *
 *   node scripts/perfCheck.mjs [track] [viewport]
 *   e.g.  node scripts/perfCheck.mjs coastal-palm 2560x1440
 *
 * Boots the real server with 4 agents, loads the spectator page in headless
 * Chromium (SwiftShader), and reports:
 *   - mean frame time / FPS over a 3 s window (rAF-driven render loop);
 *   - a z-fight/flicker check: the road band just ahead of the start line
 *     (static during setup) is sampled as a small crop across 3 frames ~0.5 s
 *     apart; any differing pixel there indicates depth fighting between the
 *     road overlays (checker / dashes / ticks).
 * Run the same script on the pre-MCPG-66 tree (origin/main) for the
 * relative perf comparison.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.VISUAL_PORT ?? 3955);
const track = process.argv[2] ?? 'coastal-palm';
const [vw, vh] = (process.argv[3] ?? '1280x720').split('x').map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(p, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${p}/healthz`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server not healthy');
}

const server = spawn(process.execPath, [path.join(root, 'src/server/main.js')], {
  env: { ...process.env, PORT: String(port), MCGP_TRACK: track, LAPS: '2', WINDOW_SECONDS: '60', TICK_DELAY_MS: '5', SEED: '42', MIN_AGENTS: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
let ok = true;
try {
  await waitForServer(port);
  const agents = [];
  for (const name of ['P One', 'P Two', 'P Three', 'P Four']) {
    const c = new Client({ name: 'perf', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await c.callTool({ name: 'join_race', arguments: { name } });
    agents.push(c);
  }
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mcpGpScene, null, { timeout: 20000 });
  await sleep(2500); // settle: scene built, shadows compiled, grid placed

  // ---- FPS over 3 s ----
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const loop = () => {
      frames++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(loop);
      else resolve({ fps: (frames / 3).toFixed(1), frameMs: (3000 / frames).toFixed(2) });
    };
    requestAnimationFrame(loop);
  }));
  console.log(`perf [${track} @ ${vw}x${vh}]:`, JSON.stringify(fps));

  // ---- flicker check on the road band ahead of the start line ----
  // Cars sit on the grid (s < 0) during setup, so the s ~ 400 m band (center
  // dashes, clear of the animated gantry at s = 0) is static there.
  const crop = await page.evaluate(() => {
    const s = window.__mcpGpScene;
    const cam = s.camera;
    const W = innerWidth, H = innerHeight;
    const p = s.track.pointAt(400);
    const v = cam.position.clone().set(p.x, 0.1, p.z);
    v.project(cam);
    return { x: Math.round((v.x * 0.5 + 0.5) * W), y: Math.round((-v.y * 0.5 + 0.5) * H), W, H };
  });
  const shot = path.join(root, '.visual', `perfcrop-${track}.png`);
  const b64 = async () => fs.readFileSync(shot).toString('base64');
  const sampleCrop = async () => {
    const bundle = { dataUrl: `data:image/png;base64,${await b64()}`, x: crop.x, y: crop.y };
    return page.evaluate(async (b) => {
      const img = new Image();
      img.src = b.dataUrl;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const w = 120, h = 80;
      const x0 = Math.max(0, Math.min(img.width - w, b.x - w / 2));
      const y0 = Math.max(0, Math.min(img.height - h, b.y - h / 2));
      const d = ctx.getImageData(x0, y0, w, h).data;
      return Array.from(d, (v, i) => (i % 4 === 3 ? 255 : v));
    }, bundle);
  };

  const frames = [];
  for (let i = 0; i < 3; i++) {
    await page.screenshot({ path: shot });
    frames.push(await sampleCrop());
    if (i < 2) await sleep(500);
  }
  const diff12 = frames[0].filter((v, i) => v !== frames[1][i]).length;
  const diff13 = frames[0].filter((v, i) => v !== frames[2][i]).length;
  const total = frames[0].length;
  console.log(`flicker check: diff(f0,f1) = ${diff12}/${total} px, diff(f0,f2) = ${diff13}/${total} px (expect ~0 — static road band)`);
  // locate the changed pixels (screen offsets within the crop)
  const where = frames[0].map((v, i) => (v !== frames[2][i] ? i : -1)).filter((i) => i >= 0).slice(0, 40);
  if (where.length) {
    const info = where.map((i) => {
      const cx = i % 120, cy = Math.floor(i / 120);
      const col = (f) => `#${[f[(i >> 2) * 4], f[(i >> 2) * 4 + 1], f[(i >> 2) * 4 + 2]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      return `(${cx},${cy}) ${col(frames[0])}->${col(frames[2])}`;
    });
    console.log('changed px:', info.join(' '));
  }
  if (errors.length) { ok = false; console.log('PAGE ERRORS:', errors.join(' | ')); }
  for (const c of agents) await c.close().catch(() => {});
} catch (err) {
  ok = false;
  console.log('FAIL', err.message);
} finally {
  server.kill('SIGTERM');
  await browser.close();
}
process.exit(ok ? 0 : 1);