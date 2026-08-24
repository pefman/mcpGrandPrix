/**
 * Spectator client main loop.
 *
 * Data flow: WebSocket snapshots (10 Hz, self-contained) -> CarPositionBuffer
 * -> render ~150 ms behind (interpolated) -> Three.js scene + DOM overlays.
 */
import { SpectatorConnection, CarPositionBuffer } from './spectatorClient.js';
import { createSpectatorScene } from './scene.js';
import { createUi } from './ui.js';
import { buildHarnessPrompt, HARNESS_PROMPT_REVISION } from './harnessPrompt.js';
import { resolveServerOrigin } from './resolveUrl.js';

const RENDER_DELAY_MS = 150; // interpolation delay (see spectatorClient.js)

const canvas = document.getElementById('scene');
const ui = createUi();
const conn = new SpectatorConnection();

let scene = null;
let buffer = null;
let lastSnapshot = null;
const carNameById = {};
const carColorById = {};

function onSnapshot(msg) {
  const now = performance.now();
  if (!buffer) buffer = new CarPositionBuffer(msg.track.lengthM);
  buffer.push(msg, now);
  lastSnapshot = msg;

  // register newly-joined cars with the scene (join order = array order)
  const known = new Set(scene.carIds());
  msg.cars.forEach((car, i) => {
    carNameById[car.id] = car.name;
    if (!known.has(car.id)) {
      carColorById[car.id] = scene.addCar(car.id, car.name, i);
      ui.setCarColors(carColorById);
    }
  });

  // --- HUD / overlays (driven by the newest snapshot) ---
  ui.setPhase(msg.phase);
  ui.setLap(msg.currentLap, msg.totalLaps);
  ui.setClock(msg.raceTimeS);
  ui.setSpectators(msg.spectators);
  ui.setStrategyBanner(msg);
  ui.setLeaderboard(msg);

  if (msg.phase === 'setup') {
    const need = msg.minAgents ?? 4;
    ui.showStartOverlay(
      'Waiting for the grid to fill…',
      `${msg.cars.length} of ${need} agents joined — the race starts automatically`,
    );
  } else {
    ui.hideStartOverlay();
  }

  if (msg.phase === 'finished') {
    ui.showFinishedOverlay(msg.standings, carNameById);
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (!scene) return;
  const renderAt = performance.now() - RENDER_DELAY_MS;

  if (buffer && lastSnapshot) {
    const carsById = new Map(lastSnapshot.cars.map((c) => [c.id, c]));
    for (const carId of scene.carIds()) {
      const smp = buffer.sample(carId, renderAt);
      if (!smp) continue;
      scene.setCar(carId, smp.s, smp.status);
      const car = carsById.get(carId);
      const extra = smp.status === 'PITTING' && car ? `PIT ${car.pitTimeLeftS?.toFixed(0)}s` : '';
      ui.placeLabel(carId, carNameById[carId] ?? carId, scene.labelScreenPos(carId), extra);
    }
  }
  scene.render();
}

function init(snapshotMsg) {
  if (scene) return;
  // The track comes from the server's hello (track info) — identical to the
  // snapshot's, but hello always arrives first.
  scene = createSpectatorScene(canvas, snapshotMsg.track);
}

conn.addEventListener('hello', (ev) => {
  // hello carries track info; but we defer scene creation until the first
  // snapshot (same shape) so everything initializes in one place.
  window.__mcpGpHello = ev.detail;
});
conn.addEventListener('snapshot', (ev) => {
  init(ev.detail);
  onSnapshot(ev.detail);
});
conn.addEventListener('status', (ev) => {
  ui.setConnection(ev.detail);
});

// ---- welcome-screen harness prompt (MCPG-36) ----
function initHarnessPrompt() {
  const promptEl = document.getElementById('harness-prompt');
  const copyBtn = document.getElementById('copy-harness-prompt');
  const origin = resolveServerOrigin();
  promptEl.textContent = buildHarnessPrompt({ mcpUrl: origin + '/mcp', spectateUrl: origin });
  document.getElementById('harness-prompt-rev').textContent = `Prompt v${HARNESS_PROMPT_REVISION}`;

  const fallbackCopy = () => {
    // non-secure contexts (e.g. LAN over plain http) have no navigator.clipboard
    const range = document.createRange();
    range.selectNodeContents(promptEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    return ok;
  };

  copyBtn.addEventListener('click', async () => {
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try {
        ok = await navigator.clipboard.writeText(promptEl.textContent);
      } catch {
        ok = false; // rejected (permissions / non-secure context)
      }
    }
    if (!ok) ok = fallbackCopy();
    copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed — select the text above manually';
    setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2000);
  });
}

initHarnessPrompt();

conn.connect();
requestAnimationFrame(frame);
