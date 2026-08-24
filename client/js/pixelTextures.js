/**
 * Procedural pixel textures (MCPG-27).
 *
 * 16x16 canvases with base + spot colors and a few speckle pixels, sampled
 * with NearestFilter (no mips) — the entire pixel look is "few big pixels,
 * hard edges". Each track theme supplies its own palette, so no image
 * assets need to ship.
 */
import * as THREE from 'three';
import { createRng } from './rng.js';

/** Base fill + seeded speckle pixels -> canvas. */
function speckleCanvas({ base, spot }, { size = 16, seed = 1, count = 26, amount = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = spot;
  const rng = createRng(seed);
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = amount * (0.45 + 0.55 * rng.next());
    ctx.fillRect(Math.floor(rng.next() * size), Math.floor(rng.next() * size), 1, 1);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

function pixelTexture(canvas, { repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Repeating ground (grass / sand / asphalt) texture from theme.ground. */
export function makeGroundTexture(theme) {
  return pixelTexture(speckleCanvas(theme.ground, { size: 16, seed: 1, count: 28 }));
}

/** Repeating road texture from theme.road. */
export function makeRoadTexture(theme) {
  return pixelTexture(speckleCanvas(theme.road, { size: 16, seed: 7, count: 36 }));
}

/**
 * Checker strip for start/finish. `cols` squares across (v), `rows` squares
 * along (u); repeat along u, clamp across.
 */
export function makeCheckerTexture(c1 = '#f4f4f4', c2 = '#15181f', cols = 6, rows = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? c1 : c2;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = pixelTexture(canvas, { repeat: false });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
