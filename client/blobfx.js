/**
 * FX lifecycle driver for test/fx-skin.test.js (MCPG-46).
 *
 * Lives under client/ so the split static server serves it. It imports the
 * REAL 'three' and client/js/fx.js (the page's importmap resolves both),
 * fires one burst of every effect kind, advances the clock past the longest
 * particle life, and records { saw, drained } on window.__fxResult.
 */
import * as THREE from 'three';
import { createFx } from './js/fx.js';

const fx = createFx(new THREE.Scene());
const p = new THREE.Vector3(0, 0, 0);
let saw = 0;
for (const kind of ['overtake', 'pit', 'start', 'finish']) {
  fx.burst(kind, p, { count: 8 });
}
for (let t = 0; t <= 4000; t += 100) {
  fx.update(t);
  saw = Math.max(saw, fx.liveCount());
}
fx.update(9000);
const drained = fx.liveCount() === 0;
fx.dispose();
window.__fxResult = { saw, drained };
