/**
 * Spectator client main loop.
 *
 * Data flow: WebSocket snapshots (10 Hz, self-contained) -> CarPositionBuffer
 * -> render ~150 ms behind (interpolated) -> Three.js scene + DOM overlays.
 */
import { SpectatorConnection, CarPositionBuffer } from './spectatorClient.js';
import { createSpectatorScene } from './scene.js';
import { createUi } from './ui.js';
import { loadTrackDef } from './tracks.js';

const RENDER_DELAY_MS = 150; // interpolation delay (see spectatorClient.js)

const canvas = document.getElementById('scene');
const ui = createUi();
const conn = new SpectatorConnection();

let scene = null;
let sceneStarting = false;
let buffer = null;
let lastSnapshot = null;
const carNameById = {};
const carColorById = {};

/** Register cars from the latest snapshot with a freshly-created scene. */
function registerKnownCars() {
  if (!scene || !lastSnapshot) return;
  const known = new Set(scene.carIds());
  lastSnapshot.cars.forEach((car, i) => {
    carNameById[car.id] = car.name;
    if (!known.has(car.id)) {
      carColorById[car.id] = scene.addCar(car.id, car.name, i);
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
        carColorById[car.id] = scene.addCar(car.id, car.name, i);
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

async function init(snapshotMsg) {
  if (scene || sceneStarting) return;
  sceneStarting = true;
  // Resolve the visual track def from the server (fetch /tracks/<id>.json);
  // falls back to the legacy ring for pre-MCPG-27 servers.
  const def = await loadTrackDef(snapshotMsg.track);
  scene = createSpectatorScene(canvas, snapshotMsg.track, def);
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
conn.addEventListener('status', (ev) => {
  ui.setConnection(ev.detail);
});

conn.connect();
requestAnimationFrame(frame);
