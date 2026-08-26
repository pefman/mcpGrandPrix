/**
 * Box-built props (MCPG-27): palms, pines, city blocks, grandstands, rocks,
 * boats, street lamps, sponsor signs — plus seeded scatter placement so each
 * track's scenery is identical on every load.
 *
 * MCPG-66: the palm matches the f1-track.html reference (2.2 m trunk,
 * 3x3x2 leaf-cube cluster with seeded dropout, per-tree leaf tone). To keep
 * the full-resolution renderer at the reference's 60 fps class, every prop's
 * plain boxes are baked into ONE merged geometry (vertex colors) — one draw
 * call per prop; only textured facades and unlit glow parts stay separate
 * meshes.
 */
import * as THREE from 'three';
import { createRng } from './rng.js';
import { makeWindowsTexture } from './pixelTextures.js';

// one base window-grid texture per wall color (16x16, shared image);
// each facade clones it with its own repeat
const windowsTexCache = new Map();
function windowsTextureFor(wallHex) {
  let tex = windowsTexCache.get(wallHex);
  if (!tex) {
    const seed = [...wallHex].reduce((a, ch, i) => a + ch.charCodeAt(0) * (i + 7), 0);
    tex = makeWindowsTexture({ wall: wallHex, seed });
    windowsTexCache.set(wallHex, tex);
  }
  return tex;
}

// unit box source data (BoxGeometry: 24 vertices, 36 indices) — reused to
// bake every prop's boxes into a single indexed geometry
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const unitPos = UNIT.attributes.position.array;
const unitNor = UNIT.attributes.normal.array;
const unitIdx = UNIT.index.array;

/** Bake a list of axis-aligned (Y-rotated) boxes into one geometry. */
function mergeBoxes(parts) {
  if (!parts.length) return null;
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const c = new THREE.Color();
  for (const p of parts) {
    const base = pos.length / 3;
    c.set(p.color);
    const cs = Math.cos(p.ry || 0);
    const sn = Math.sin(p.ry || 0);
    for (let i = 0; i < 24; i++) {
      const x = unitPos[i * 3] * p.w;
      const y = unitPos[i * 3 + 1] * p.h;
      const z = unitPos[i * 3 + 2] * p.d;
      pos.push(p.x + x * cs - z * sn, p.y + y, p.z + x * sn + z * cs);
      const nx = unitNor[i * 3];
      const nz = unitNor[i * 3 + 2];
      nor.push(nx * cs - nz * sn, unitNor[i * 3 + 1], nx * sn + nz * cs);
      col.push(c.r, c.g, c.b);
    }
    for (let i = 0; i < 36; i++) idx.push(base + unitIdx[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Builder context: `add` collects plain colored boxes (baked into the
 * prop's single merged geometry); `addMesh` keeps a special mesh separate
 * (textured facades, unlit glow parts).
 */
function makeCtx() {
  const parts = [];
  const extras = [];
  return {
    parts,
    extras,
    add(w, h, d, color, x = 0, y = 0, z = 0, ry = 0) {
      parts.push({ w, h, d, color, x, y, z, ry });
    },
    addMesh(m) {
      extras.push(m);
    },
  };
}

// Step 5 (MCPG-47): night-readable slate tones. The city towers are lit by
// the dim moon (Lambert / PI), so dark albedos rendered as near-black
// silhouettes that vanished into the sky; mid-slate reads as a city.
const BUILDING_COLORS = [0x8a90a8, 0x7d8399, 0x979db4, 0x737990, 0x848aa2];

const BUILDERS = {
  /**
   * Palm — the reference's voxel cluster: slim trunk, then a 3x3x2 grid of
   * 3.6 m leaf cubes (20% seeded dropout), one leaf tone per tree.
   */
  palm(p, ctx, rng) {
    const h = p.h ?? 2 + rng.next() * 3;
    const trunkH = 4 + h;
    ctx.add(2.2, trunkH, 2.2, 0x7a4a22, 0, trunkH / 2, 0);
    const leaf = [0x35c04a, 0x3fd455, 0x2fb542][Math.floor(rng.next() * 3)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2 || rng.next() < 0.2) continue;
          ctx.add(3.6, 3.6, 3.6, leaf, dx * 2.4, trunkH + 1.6 + dy * 2.4, dz * 2.4);
        }
      }
    }
  },

  pine(p, ctx, rng) {
    // base at y=0 so the group scale keeps the trunk on the ground
    ctx.add(1, 2.4, 1, 0x7a5636, 0, 1.2, 0);
    ctx.add(4.6, 3, 4.6, 0x2e7d4a, 0, 4.1, 0);
    ctx.add(3, 2.6, 3, 0x3d9758, 0, 6.7, 0);
    // per-prop scale applied to the merged mesh below
    ctx.scale = 0.85 + rng.next() * 0.5;
  },

  /**
   * City block: tower + pixel window-grid facades (+ optional neon roof
   * band). Step 5 (MCPG-47): solid glow strips became a mixed lit/unlit
   * window grid (makeWindowsTexture) so towers read as a city; the facade
   * tiles are MeshBasicMaterial, so the glow stays unlit and cheap.
   */
  building(p, g, rng) {
    const w = p.w ?? 24;
    const d = p.d ?? 24;
    const h = p.h ?? 40;
    const color = p.color ?? BUILDING_COLORS[(Math.abs(Math.round(p.x)) * 31 + Math.abs(Math.round(p.z)) * 17) % BUILDING_COLORS.length];
    g.add(w, h, d, color, 0, h / 2, 0);
    const base = windowsTextureFor(`#${new THREE.Color(color).getHexString()}`);
    const t = 0.3;
    const facade = (sx, sz, x, z) => {
      const tex = base.clone(); // per-facade repeat, shared 16x16 image
      tex.repeat.set(
        Math.max(1, Math.round(Math.max(sx, sz) / 12)), // one tile ~ 12 m -> ~ 3 m windows
        Math.max(1, Math.round((h * 0.6) / 12)),
      );
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(sx, h * 0.6, sz),
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      m.position.set(x, h * 0.55, z);
      g.addMesh(m);
    };
    facade(w * 0.72, t, 0, d / 2 + t / 2);
    facade(w * 0.72, t, 0, -d / 2 - t / 2);
    facade(t, d * 0.72, w / 2 + t / 2, 0);
    facade(t, d * 0.72, -w / 2 - t / 2, 0);
    if (p.neon) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.6, 0.8, d + 0.6),
        new THREE.MeshBasicMaterial({ color: p.neon }),
      );
      m.position.y = h + 0.4;
      g.addMesh(m);
    }
  },

  /**
   * Grandstand. Model convention: the front (where the crowd looks) faces
   * +z; rotate the group to face the track.
   */
  grandstand(p, g) {
    const w = p.w ?? 30;
    const d = p.d ?? 12;
    const h = p.h ?? 8;
    g.add(w, 1.2, d, 0x9aa1b2, 0, 0.6, 0);
    for (let i = 0; i < 3; i++) {
      g.add(w, 1.4, d * 0.28, 0x8088a0, 0, 1.7 + i * 1.4, -d * 0.24 - i * d * 0.28);
    }
    g.add(w, 0.7, d + 3, 0x2f3542, 0, h, 0);
    g.add(0.8, h - 0.4, 0.8, 0x2f3542, -w / 2 + 2, (h - 0.4) / 2 + 0.4, d / 2 - 1);
    g.add(0.8, h - 0.4, 0.8, 0x2f3542, w / 2 - 2, (h - 0.4) / 2 + 0.4, d / 2 - 1);
  },

  rock(p, g, rng) {
    const s = 0.8 + rng.next() * 0.6;
    g.add(5, 3, 5, 0x83868e, 0, 1.5, 0);
    g.add(2.6, 1.8, 2.6, 0x91949c, 0.8, 3.6, 0.4);
    g.scale = s;
  },

  boat(p, g) {
    g.add(6, 1.1, 2.4, 0xf4f0e6, 0, 0.9, 0);
    g.add(5.6, 0.3, 2, 0xe0453a, 0, 1.6, 0);
    g.add(1.8, 1.1, 1.6, 0xffffff, -1, 2.3, 0);
    g.add(0.3, 3, 0.3, 0x9a6f42, 1.8, 3.2, 0);
  },

  /**
   * Street lamp. The arm points local +x; scatter sets rot to face the
   * road. Step 5 (MCPG-47): pole/arm thickened ~3x so the lamps read at
   * diorama distance instead of vanishing into the buildings. The warm
   * lamp head stays an unlit (basic) mesh so it glows at night.
   */
  lamp(p, g) {
    g.add(1.6, 6.5, 1.6, 0x3a4152, 0, 3.25, 0);
    g.add(2.4, 0.6, 1.0, 0x3a4152, 0.8, 6.2, 0);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.7, 1.5),
      new THREE.MeshBasicMaterial({ color: 0xffdf96 }),
    );
    m.position.set(1.7, 5.9, 0);
    g.addMesh(m);
  },

  /**
   * Roadside sponsor sign: post + panel. Model convention: the panel faces
   * local +z; track defs set `rot` to face the road. `color` tints the
   * panel (sponsor brand); defaults to the amber used by the pit FX.
   */
  sign(p, g) {
    const w = p.w ?? 8;
    const h = p.h ?? 5;
    const ph = Math.min(2.2, h * 0.45); // panel height
    g.add(0.8, h, 0.8, 0x3a4152, 0, h / 2, 0);
    g.add(w, ph, 0.7, p.color ?? 0xffc53d, 0, h - 0.3 - ph / 2, 0);
  },
};

/**
 * Build one prop def ({type, x, z, rot?, ...}) into a Group at (x, 0, z):
 * one merged mesh for all colored boxes + special meshes (facades, glows).
 * Returns null for unknown types (def files are versioned, be forgiving).
 */
export function buildProp(p, rng) {
  const build = BUILDERS[p.type];
  if (!build) return null;
  const ctx = makeCtx();
  build(p, ctx, rng);
  const g = new THREE.Group();
  const geo = mergeBoxes(ctx.parts);
  if (geo) {
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    if (ctx.scale) m.scale.setScalar(ctx.scale);
    g.add(m);
  }
  for (const m of ctx.extras) g.add(m);
  g.position.set(p.x, p.y ?? 0, p.z);
  if (p.rot != null) g.rotation.y = p.rot;
  return g;
}

/** Build all props (hand-placed + scattered) into a group. */
export function buildProps(propDefs, rng) {
  const g = new THREE.Group();
  for (const p of propDefs) {
    const prop = buildProp(p, rng);
    if (prop) g.add(prop);
  }
  return g;
}

/**
 * Seeded scatter: random candidates inside the circuit's bounding box,
 * kept only when clear of the road (roadWidthM/2 + minOffsetM), the water,
 * and any exclusion zones ([x, z, r] circles — MCPG-64, keeps scenery out
 * of garages/stands/etc.). `samples` are {x, z} points along the centerline.
 */
export function scatterProps(def, samples, roadWidthM, water = [], exclusions = []) {
  const sc = def.scatter;
  if (!sc) return [];
  const rng = createRng(sc.seed);
  const need = roadWidthM / 2 + (sc.minOffsetM ?? 14);
  const need2 = need * need;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
  }
  const pad = 45;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;

  const zones = (exclusions ?? []).filter((z) => Array.isArray(z) && z.length >= 3);
  const out = [];
  let tries = (sc.count ?? 0) * 30;
  while (out.length < (sc.count ?? 0) && tries-- > 0) {
    const x = minX + rng.next() * (maxX - minX);
    const z = minZ + rng.next() * (maxZ - minZ);
    let ok = true;
    let nearX = 0, nearZ = 0, nearD2 = Infinity;
    for (const s of samples) {
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearD2) { nearD2 = d2; nearX = s.x - x; nearZ = s.z - z; }
      if (d2 < need2) { ok = false; break; }
    }
    if (ok) {
      for (const w of water) {
        const dx = x - w.x;
        const dz = z - w.z;
        const wn = w.r + 4;
        if (dx * dx + dz * dz < wn * wn) { ok = false; break; }
      }
    }
    if (ok) {
      for (const [zx, zz, zr] of zones) {
        const dx = x - zx;
        const dz = z - zz;
        if (dx * dx + dz * dz < zr * zr) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const prop = { type: sc.type, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
    if (sc.type === 'lamp') prop.rot = Math.atan2(-nearZ, nearX); // arm faces the road
    out.push(prop);
  }
  return out;
}
