/**
 * Visual check for the pixel-art spectator (MCPG-27).
 *
 * For each track in `tracks/`: start the real server with that track, join 4
 * scripted MCP agents (so a full grid is on the scene), load the spectator
 * client in headless Chromium and save a screenshot to `.visual/<id>.png`.
 *
 *   node scripts/visualCheck.mjs                 # every track
 *   node scripts/visualCheck.mjs --track city-night
 *
 * Exits non-zero if any page reports a JS error or a screenshot looks
 * empty (uniform-color images compress to a few KB, real scenes to 100s of
 * KB). The screenshots land in `.visual/` — add that dir to .gitignore.
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

const only = process.argv.includes('--track')
  ? process.argv[process.argv.indexOf('--track') + 1]
  : null;

const tracks = fs
  .readdirSync(path.join(root, 'tracks'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'tracks', f), 'utf8')))
  .filter((def) => !only || def.id === only)
  .sort((a, b) => a.id.localeCompare(b.id));

if (tracks.length === 0) {
  console.error(`no track(s) matched --track ${only}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server on :${port} did not become healthy in ${timeoutMs}ms`);
}

async function joinAgents(port, names) {
  const clients = [];
  for (const name of names) {
    const client = new Client({ name: `visual-check`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    await client.callTool({ name: 'join_race', arguments: { name } });
    clients.push(client);
  }
  return clients;
}

async function shootTrack(browser, def, port) {
  const server = spawn(process.execPath, [path.join(root, 'src/server/main.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      MCGP_TRACK: def.id,
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

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  try {
    await waitForServer(port);
    const agents = await joinAgents(port, ['Check One', 'Check Two', 'Check Three', 'Check Four']);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => {
        const c = document.querySelector('#scene');
        return c && c.width > 0 && c.height > 0;
      },
      { timeout: 20000 },
    );
    // Let the scene init, fit the camera, place the grid and render a few frames.
    await sleep(4500);
    const out = path.join(outDir, `${def.id}.png`);
    await page.screenshot({ path: out });
    const bytes = fs.statSync(out).size;
    // dark themes (night) compress to smaller PNGs, so the floor is low
    const ok = bytes > 30_000 && errors.length === 0;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${def.id}  ${out}  ${bytes} bytes` +
        (errors.length ? `  ERRORS: ${errors.join(' | ')}` : ''),
    );
    for (const c of agents) await c.close().catch(() => {});
    return ok;
  } catch (err) {
    console.log(`FAIL ${def.id}  ${err.message}`);
    if (log.length) console.log(log.join(''));
    return false;
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    await page.close();
  }
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  // Software WebGL keeps this deterministic on headless/CI machines.
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

let allOk = true;
const basePort = Number(process.env.VISUAL_PORT ?? 3901);
try {
  for (let i = 0; i < tracks.length; i++) {
    allOk = (await shootTrack(browser, tracks[i], basePort + i)) && allOk;
  }
} finally {
  await browser.close();
}
process.exit(allOk ? 0 : 1);
