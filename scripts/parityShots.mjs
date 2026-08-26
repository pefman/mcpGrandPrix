/**
 * Design-parity pairs for MCPG-66 (Peter's sign-off artifact): renders
 * client/design/reference/f1-track.html (left) and the game scene (right)
 * at the same camera angle (reference azimuth/elevation, fov 45) for each
 * circuit feature, and composes labeled side-by-side PNGs:
 *
 *   node scripts/parityShots.mjs               # all pairs -> .visual/parity-*-pair.png
 *
 * The reference is loaded byte-faithful (its CDN import map) through a
 * runtime wrapper that only appends `window.__ref = {...}` so the camera
 * can be re-aimed per feature. The game side drives window.__mcpGpScene.
 * Both sides run headless Chromium (SwiftShader) so the pairs are directly
 * comparable; the reference is the crispness bar (60 fps on a GPU laptop).
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
const port = Number(process.env.VISUAL_PORT ?? 3937);
const REF_PATH = path.join(root, 'client/design/reference/f1-track.html');
const VIEWPORT = process.env.VIEWPORT ?? '1280x720'; // e.g. 2560x1440 for the sharpness pair

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(p, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${p}/healthz`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server not healthy');
}

/** Reference wrapper: byte-faithful module code + one exposure line. */
function writeRefWrapper() {
  const html = fs.readFileSync(REF_PATH, 'utf8');
  if (!html.includes('<script type="module">')) throw new Error('reference module script not found');
  const i = html.lastIndexOf('</script>');
  if (i === -1) throw new Error('reference closing script tag not found');
  const wrapped = html.slice(0, i) + 'window.__ref = { camera, controls, scene, curve };\n' + html.slice(i);
  const p = path.join(outDir, 'ref-exposed.html');
  fs.writeFileSync(p, wrapped);
  return p;
}

/**
 * Camera presets per feature. `target` is the world point, `extent` the
 * visible vertical span (m) -> distance = extent / (2·tan 22.5°). `from`
 * is the azimuth: 'south' = the reference direction, 'north' = mirrored,
 * or an explicit [x, y, z] direction.
 */
const FEATURES = {
  wide:     { from: 'south', extent: null /* default fitted camera */ },
  pit:      { from: 'south', extent: 110, target: null }, // set from scene state
  gantry:   { from: 'south', extent: 36, target: null },
  stand:    { from: 'north', extent: 40, target: null },
  tirewall: { from: 'south', extent: 50, target: null },
  drs:      { from: 'south', extent: 30, target: null },
  flood:    { from: 'south', extent: 55, target: null },
  curbs:    { from: 'south', extent: 45, target: null },
};

const [vw, vh] = VIEWPORT.split('x').map(Number);
const only = process.env.PARITY_ONLY ? process.env.PARITY_ONLY.split(',') : null; // e.g. "wide"
const doFeature = (k) => !only || only.includes(k);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });

async function aimRef(page, target, dir, extent) {
  const d = extent / (2 * Math.tan((45 / 2) * Math.PI / 180));
  await page.evaluate(([t, dx, dy, dz, dist]) => {
    const r = window.__ref;
    const len = Math.hypot(dx, dy, dz);
    r.camera.position.set(t[0] + (dx / len) * dist, t[1] + (dy / len) * dist, t[2] + (dz / len) * dist);
    r.controls.target.set(t[0], t[1], t[2]);
    r.controls.update();
    r.scene.updateMatrixWorld();
  }, [target, dir[0], dir[1], dir[2], d]);
}

async function aimGame(page, target, extent, from) {
  const d = extent / (2 * Math.tan((45 / 2) * Math.PI / 180));
  const dir = from === 'south' ? [0.497, 0.392, 0.774] : [-0.497, 0.392, -0.774];
  await page.evaluate(([t, dx, dy, dz, dist]) => {
    const s = window.__mcpGpScene;
    const len = Math.hypot(dx, dy, dz);
    s.camera.position.set(t[0] + (dx / len) * dist, t[1] + (dy / len) * dist, t[2] + (dz / len) * dist);
    s.controls.target.set(t[0], t[1], t[2]);
    s.controls.update();
    s.render();
  }, [target, dir[0], dir[1], dir[2], d]);
}

/** Compose two PNGs side-by-side with labels into one pair image. */
async function makePair(browser, refPng, gamePng, label, outPng) {
  const page = await browser.newPage();
  const refB64 = fs.readFileSync(refPng).toString('base64');
  const gameB64 = fs.readFileSync(gamePng).toString('base64');
  await page.setContent(`
    <style>body{margin:0;background:#141821} .row{display:flex;gap:6px;padding:6px}
    .cell{position:relative} .tag{position:absolute;top:8px;left:8px;background:rgba(10,13,20,.85);
    color:#e8ecf2;font:600 13px monospace;padding:3px 8px;border:1px solid rgba(255,255,255,.2)}
    .title{color:#e8ecf2;font:700 14px monospace;padding:6px 14px 0}</style>
    <div class="title">${label}</div>
    <div class="row">
      <div class="cell"><img src="data:image/png;base64,${refB64}"><div class="tag">REFERENCE · f1-track.html</div></div>
      <div class="cell"><img src="data:image/png;base64,${gameB64}"><div class="tag">GAME · ${label}</div></div>
    </div>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  await page.screenshot({ path: outPng, clip: { x: 0, y: 0, width: vw * 2 + 18, height: vh + 46 } });
  await page.close();
  return outPng;
}

let ok = true;
let wideDone = false;
const server = spawn(process.execPath, [path.join(root, 'src/server/main.js')], {
  env: { ...process.env, PORT: String(port), MCGP_TRACK: 'coastal-palm', LAPS: '5', WINDOW_SECONDS: '30', TICK_DELAY_MS: '5', SEED: '42', MIN_AGENTS: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(port);
  const agents = [];
  for (const name of ['Par One', 'Par Two', 'Par Three', 'Par Four']) {
    const c = new Client({ name: 'parity', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await c.callTool({ name: 'join_race', arguments: { name } });
    agents.push(c);
  }

  // ---- game page ----
  const game = await browser.newPage({ viewport: { width: vw, height: vh } });
  const gameErrors = [];
  game.on('pageerror', (e) => gameErrors.push(String(e)));
  await game.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await game.waitForFunction(() => window.__mcpGpScene, null, { timeout: 20000 });
  await sleep(1500);

  // ---- reference page (byte-faithful wrapper) ----
  const refPageUrl = 'file://' + writeRefWrapper();
  const ref = await browser.newPage({ viewport: { width: vw, height: vh } });
  const refErrors = [];
  ref.on('pageerror', (e) => refErrors.push(String(e)));
  await ref.goto(refPageUrl, { waitUntil: 'load' });
  await ref.waitForFunction(() => window.__ref, null, { timeout: 30000 });
  await sleep(1200); // scene build (voxel bake) + light settle

  // Feature targets: the game side is read from the live scene state, the
  // reference side from the reference circuit's known coordinates.
  const gameTargets = await game.evaluate(() => {
    const s = window.__mcpGpScene;
    const t = s.track;
    // sharpest apex for the tire-wall / curb pair (coarse curvature scan)
    let apexS = 0, apexTurn = 0;
    for (let s0 = 0; s0 < t.map.lengthM; s0 += 8) {
      const a = t.tangentAt(s0 - 12);
      const b = t.tangentAt(s0 + 12);
      const turn = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.z * b.z)));
      if (turn > apexTurn && s0 > 60 && s0 < t.map.lengthM - 60) { apexTurn = turn; apexS = s0; }
    }
    const pit = t.pitBoxes[Math.floor(t.pitBoxes.length / 2)].pos;
    const start = t.pointAt(0);
    const drsS = s.track.def.scenery?.drs?.[0]?.atS ?? 120;
    const drs = t.pointAt(drsS);
    const flood = s.track.def.scenery?.floodlights?.[0];
    return {
      pit: [pit.x, 0, pit.z + 10],
      gantry: [start.x, 8, start.z + 4],
      stand: [t.pointAt(40).x, 4, t.pointAt(40).z],
      tirewall: [t.pointAt(apexS).x, 0, t.pointAt(apexS).z],
      drs: [drs.x, 6, drs.z],
      flood: flood ? [flood.x, 14, flood.z] : [0, 14, 0],
      curbs: [t.pointAt(apexS - 25).x, 0, t.pointAt(apexS - 25).z],
    };
  });
  // reference circuit feature coordinates (f1-track.html layout)
  const refTargets = {
    wide: null,
    pit: [-35, 0, -108],
    gantry: [-20, 8, -126],
    stand: [-40, 4, -126],
    tirewall: [112, 0, -68],
    drs: [70, 6, -122],
    flood: [-100, 14, -158],
    curbs: [26, 0, -46],
  };
  // The reference's main-straight stand sits on the north side of its
  // straight -> view it from the track side (south azimuth); the game's
  // coastal stand sits on the south side -> view it from the north.
  const refStandFrom = 'south';

  // ---- 1) island wide: both default fitted cameras ----
  if (doFeature('wide')) {
    await ref.screenshot({ path: path.join(outDir, 'parity-ref-wide.png') });
    await game.screenshot({ path: path.join(outDir, 'parity-game-wide.png') });
    await makePair(browser, path.join(outDir, 'parity-ref-wide.png'), path.join(outDir, 'parity-game-wide.png'),
      'Island wide — default camera', path.join(outDir, 'parity-wide-pair.png'));
    console.log('pair: wide');
    wideDone = true;
  }

  // ---- 2) gantry mid light-sequence (fresh loads, capture ~2.1 s in) ----
  if (doFeature('gantry')) {
    await Promise.all([
      ref.reload({ waitUntil: 'load' }).then(() => ref.waitForFunction(() => window.__ref, null, { timeout: 30000 })),
      game.reload({ waitUntil: 'networkidle' }).then(() => game.waitForFunction(() => window.__mcpGpScene, null, { timeout: 20000 })),
    ]);
    await sleep(2100);
    const gGantry = await game.evaluate(() => { const p = window.__mcpGpScene.track.pointAt(0); return [p.x, 8, p.z + 4]; });
    await aimRef(ref, refTargets.gantry, [0.497, 0.392, 0.774], 36);
    await aimGame(game, gGantry, 36, 'south');
    await ref.screenshot({ path: path.join(outDir, 'parity-ref-gantry.png') });
    await game.screenshot({ path: path.join(outDir, 'parity-game-gantry.png') });
    await makePair(browser, path.join(outDir, 'parity-ref-gantry.png'), path.join(outDir, 'parity-game-gantry.png'),
      'Start gantry + 5-light sequence (mid red phase)', path.join(outDir, 'parity-gantry-pair.png'));
    console.log('pair: gantry');
  } else if (wideDone) {
    console.log('skip: gantry (and remainder — PARITY_ONLY)');
  }

  // ---- 3..8) the remaining features ----
  for (const key of ['pit', 'stand', 'tirewall', 'drs', 'flood', 'curbs']) {
    if (!doFeature(key)) continue;
    const f = FEATURES[key];
    const dirGame = f.from === 'south' ? [0.497, 0.392, 0.774] : [-0.497, 0.392, -0.774];
    const dirRef = (key === 'stand' ? refStandFrom : 'south') === 'south' ? [0.497, 0.392, 0.774] : [-0.497, 0.392, -0.774];    await aimRef(ref, refTargets[key], dirRef, f.extent);
    await aimGame(game, gameTargets[key], f.extent, f.from);
    await sleep(200);
    await ref.screenshot({ path: path.join(outDir, `parity-ref-${key}.png`) });
    await game.screenshot({ path: path.join(outDir, `parity-game-${key}.png`) });
    const labels = {
      pit: 'Pit lane + garages + striped roofs + crew',
      stand: 'Curved grandstand with colored seats + canopy',
      tirewall: 'Apex tire walls (inside of the corner)',
      drs: 'DRS board',
      flood: 'Floodlight tower',
      curbs: 'Two-tone asphalt + curvature curbs + rumble strips',
    };
    await makePair(browser, path.join(outDir, `parity-ref-${key}.png`), path.join(outDir, `parity-game-${key}.png`),
      labels[key], path.join(outDir, `parity-${key}-pair.png`));
    console.log(`pair: ${key}`);
  }

  if (gameErrors.length) { ok = false; console.log('GAME PAGE ERRORS:', gameErrors.join(' | ')); }
  if (refErrors.length) { ok = false; console.log('REF PAGE ERRORS:', refErrors.join(' | ')); }
  for (const c of agents) await c.close().catch(() => {});
} catch (err) {
  ok = false;
  console.log('FAIL', err.stack);
} finally {
  server.kill('SIGTERM');
  await browser.close();
}
process.exit(ok ? 0 : 1);