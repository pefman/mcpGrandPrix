/**
 * Spectator client main loop.
 *
 * Data flow: WebSocket snapshots (10 Hz, self-contained) -> CarPositionBuffer
 * -> render ~150 ms behind (interpolated) -> Three.js scene + DOM overlays.
 */
import { SpectatorConnection, CarPositionBuffer } from './spectatorClient.js';
import { createSpectatorScene } from './scene.js';
import { createUi } from './ui.js';
import { createMinimap } from './minimap.js';
import { loadTrackDef } from './tracks.js';
import { buildHarnessPrompt, HARNESS_PROMPT_REVISION } from './harnessPrompt.js';
import { resolveServerOrigin } from './resolveUrl.js';
import { initFeaturesBadge } from './featuresBadge.js';

const RENDER_DELAY_MS = 150; // interpolation delay (see spectatorClient.js)

const canvas = document.getElementById('scene');
const ui = createUi();
initFeaturesBadge(); // "NEW" badge -> /features (MCPG-35); self-contained
const conn = new SpectatorConnection();

let scene = null;
let sceneStarting = false;
let minimap = null;
let buffer = null;
let lastSnapshot = null;
const carNameById = {};
const carColorById = {};

// Post-race track vote (MCPG-28): the server is authoritative, this is only
// local UI state — which track this browser voted for + the last vote view.
let myVote = null;
let lastVote = null;

ui.setVoteHandler((trackId) => {
  conn.send({ type: 'vote', trackId });
});

function renderVote(vote) {
  lastVote = vote;
  ui.showVotePanel(vote, { myVote });
}

function hideVotePanel() {
  lastVote = null;
  ui.hideVotePanel();
}

/** Register cars from the latest snapshot with a freshly-created scene. */
function registerKnownCars() {
  if (!scene || !lastSnapshot) return;
  const known = new Set(scene.carIds());
  lastSnapshot.cars.forEach((car, i) => {
    carNameById[car.id] = car.name;
    if (!known.has(car.id)) {
      carColorById[car.id] = scene.addCar(car.id, car.name, i, car.color);
    }
  });
  ui.setCarColors(carColorById);
}

function onSnapshot(msg) {
  const now = performance.now();
  if (!buffer) buffer = new CarPositionBuffer(msg.track.lengthM);
  buffer.push(msg, now);
  lastSnapshot = msg;

  // register newly-joined cars with the scene (join order = array order);
  // the scene may not exist yet (track def still loading) — init() will
  // register everyone from lastSnapshot once it does
  if (scene) {
    const known = new Set(scene.carIds());
    msg.cars.forEach((car, i) => {
      carNameById[car.id] = car.name;
      if (!known.has(car.id)) {
        carColorById[car.id] = scene.addCar(car.id, car.name, i, car.color);
        ui.setCarColors(carColorById);
      }
    });
  } else {
    for (const car of msg.cars) carNameById[car.id] = car.name;
  }

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

  if (msg.phase === 'voting') {
    // MCPG-28: live vote panel (counts refresh with each snapshot).
    renderVote(msg.vote);
  } else {
    hideVotePanel();
  }

  if (msg.phase === 'finished') {
    ui.showFinishedOverlay(msg.standings, carNameById);
  } else {
    // Rotation: the persistent server (MCPG-34) opens a new session — the
    // 'reset' event already cleared the scene; drop the finished overlay so
    // the next race's setup overlay / live view shows through.
    ui.hideFinishedOverlay();
  }

  ui.setPending(msg.pending);
}

conn.addEventListener('reset', () => {
  // A NEW race session started (server rotated after the results hold).
  myVote = null; // a new race's vote starts fresh
  scene?.dispose(); // main.js holds scene; it is null-guarded above
  scene = null;
  minimap?.dispose();
  minimap = null;
  sceneStarting = false;
  buffer?.clear?.();
  buffer = null;
  lastSnapshot = null;
  for (const k of Object.keys(carNameById)) delete carNameById[k];
  for (const k of Object.keys(carColorById)) delete carColorById[k];
  ui.reset();
  // init() runs on the next snapshot (same track def is cached/loaded there)
});

function frame() {
  requestAnimationFrame(frame);
  if (!scene) return;
  const now = performance.now();
  const renderAt = now - RENDER_DELAY_MS;

  if (buffer && lastSnapshot) {
    const carsById = new Map(lastSnapshot.cars.map((c) => [c.id, c]));
    const mmCars = [];
    for (const carId of scene.carIds()) {
      const smp = buffer.sample(carId, renderAt);
      if (!smp) continue;
      // lastSnapshot drives race-moment FX (overtake/start/finish/pit, MCPG-46)
      scene.setCar(carId, smp.s, smp.status, lastSnapshot);
      const car = carsById.get(carId);
      const extra = smp.status === 'PITTING' && car ? `PIT ${car.pitTimeLeftS?.toFixed(0)}s` : '';
      ui.placeLabel(carId, carNameById[carId] ?? carId, scene.labelScreenPos(carId), extra);
      // minimap (MCPG-31): same world spot the 3D view is showing right now
      const wp = scene.carWorldPos(carId);
      if (wp) mmCars.push({ x: wp.x, z: wp.z, color: carColorById[carId] || '#888', status: smp.status });
    }
    minimap?.draw(mmCars);
  } else {
    minimap?.draw([]); // outline only while the buffer is empty
  }
  scene.tick(now); // advance FX particles (runs even while the buffer is empty)
  scene.render();
}

async function init(snapshotMsg) {
  if (scene || sceneStarting) return;
  sceneStarting = true;
  // Resolve the visual track def from the server (fetch /tracks/<id>.json);
  // falls back to the legacy ring for pre-MCPG-27 servers.
  const def = await loadTrackDef(snapshotMsg.track);
  scene = createSpectatorScene(canvas, snapshotMsg.track, def);
  // 2D circuit minimap (MCPG-31), fed from scene.track.map (same curve as 3D)
  minimap = createMinimap(document.getElementById('minimap'), scene.track.map);
  ui.setTrack(def.name);
  registerKnownCars();
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
// ---- post-race track vote (MCPG-28) ----
conn.addEventListener('voting', (ev) => {
  // Window opened (or a (re)connect into an open window).
  renderVote(ev.detail);
});
conn.addEventListener('vote_ack', (ev) => {
  myVote = ev.detail.trackId;
  if (lastVote) renderVote(lastVote);
});
conn.addEventListener('vote_rejected', () => {
  // Server ignored it (e.g. no window open); the panel refreshes from
  // snapshots, so there is nothing to roll back locally.
});
conn.addEventListener('vote_result', (ev) => {
  // The window closed: keep the panel up as the results list (winner
  // highlighted) until the next session's rotation resets it.
  const winner = ev.detail.trackId;
  if (lastVote) renderVote({ ...lastVote, winner });
  myVote = null;
});

conn.addEventListener('status', (ev) => {
  // 'disconnected' during the results hold looks like a drop; keep the
  // finished overlay up (the snapshot feed resumes on reconnect).
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
