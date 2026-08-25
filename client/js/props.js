/**
 * Box-built props (MCPG-27): palms, pines, city blocks, grandstand, rocks,
 * boats, street lamps, sponsor signs (MCPG-45) — plus seeded scatter
 * placement so each track's scenery is identical on every load.
 */
import * as THREE from 'three';
import { createRng } from './rng.js';

function box(w, h, d, color, y = 0, { basic = false } = {}) {
  const mat = basic
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshLambertMaterial({ color });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = y;
  return m;
}

function place(m, x = 0, z = 0) {
  m.position.x = x;
  m.position.z = z;
  return m;
}

const BUILDING_COLORS = [0x2c3350, 0x3a3158, 0x252c44, 0x453a66, 0x232a3e];

const BUILDERS = {
  palm(p, g, rng) {
    const h = p.h ?? rng.int(6, 9);
    g.add(box(1.2, h, 1.2, 0x9a6f42, h / 2));
    g.add(box(7, 1.2, 2.6, 0x1e9e56, h + 0.2));
    g.add(box(2.6, 1.2, 7, 0x27ac62, h + 0.2));
    g.add(box(4.4, 1, 4.4, 0x34c474, h + 1.2));
  },

  pine(p, g, rng) {
    // base at y=0 so the uniform scale keeps the trunk on the ground
    g.add(place(box(1, 2.4, 1, 0x7a5636, 1.2)));
    g.add(place(box(4.6, 3, 4.6, 0x2e7d4a, 4.1)));
    g.add(place(box(3, 2.6, 3, 0x3d9758, 6.7)));
    g.scale.setScalar(0.85 + rng.next() * 0.5);
  },

  /** City block: tower + unlit window strips (+ optional neon roof band). */
  building(p, g, rng) {
    const w = p.w ?? 24;
    const d = p.d ?? 24;
    const h = p.h ?? 40;
    const color = p.color ?? BUILDING_COLORS[(Math.abs(Math.round(p.x)) * 31 + Math.abs(Math.round(p.z)) * 17) % BUILDING_COLORS.length];
    const win = 0xffd98a;
    g.add(box(w, h, d, color, h / 2));
    const t = 0.3;
    g.add(place(box(w * 0.72, h * 0.6, t, win, h * 0.55, { basic: true }), 0, d / 2 + t / 2));
    g.add(place(box(w * 0.72, h * 0.6, t, win, h * 0.55, { basic: true }), 0, -d / 2 - t / 2));
    g.add(place(box(t, h * 0.6, d * 0.72, win, h * 0.55, { basic: true }), w / 2 + t / 2, 0));
    g.add(place(box(t, h * 0.6, d * 0.72, win, h * 0.55, { basic: true }), -w / 2 - t / 2, 0));
    if (p.neon) g.add(box(w + 0.6, 0.8, d + 0.6, p.neon, h + 0.4, { basic: true }));
  },

  /**
   * Grandstand. Model convention: the front (where the crowd looks) faces
   * +z; rotate the group to face the track.
   */
  grandstand(p, g) {
    const w = p.w ?? 30;
    const d = p.d ?? 12;
    const h = p.h ?? 8;
    g.add(box(w, 1.2, d, 0x9aa1b2, 0.6));
    for (let i = 0; i < 3; i++) {
      g.add(place(box(w, 1.4, d * 0.28, 0x8088a0, 1.7 + i * 1.4), 0, -d * 0.24 - i * d * 0.28));
    }
    g.add(box(w, 0.7, d + 3, 0x2f3542, h));
    g.add(place(box(0.8, h - 0.4, 0.8, 0x2f3542, (h - 0.4) / 2 + 0.4), -w / 2 + 2, d / 2 - 1));
    g.add(place(box(0.8, h - 0.4, 0.8, 0x2f3542, (h - 0.4) / 2 + 0.4), w / 2 - 2, d / 2 - 1));
  },

  rock(p, g, rng) {
    const s = 0.8 + rng.next() * 0.6;
    const rock = new THREE.Group();
    rock.add(box(5, 3, 5, 0x83868e, 1.5));
    rock.add(place(box(2.6, 1.8, 2.6, 0x91949c, 3.6), 0.8, 0.4));
    rock.scale.setScalar(s);
    g.add(rock);
  },

  boat(p, g) {
    g.add(box(6, 1.1, 2.4, 0xf4f0e6, 0.9));
    g.add(box(5.6, 0.3, 2, 0xe0453a, 1.6));
    g.add(place(box(1.8, 1.1, 1.6, 0xffffff, 2.3), -1, 0));
    g.add(place(box(0.3, 3, 0.3, 0x9a6f42, 3.2), 1.8, 0));
  },

  /** Street lamp. The arm points local +x; scatter sets rot to face the road. */
  lamp(p, g) {
    g.add(box(0.5, 6.5, 0.5, 0x3a4152, 3.25));
    g.add(place(box(1.6, 0.4, 0.4, 0x3a4152, 6.4), 0.5, 0));
    g.add(place(box(0.9, 0.5, 0.9, 0xffdf96, 6.1, { basic: true }), 1.0, 0));
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
    g.add(box(0.8, h, 0.8, 0x3a4152, h / 2));
    g.add(box(w, ph, 0.7, p.color ?? 0xffc53d, h - 0.3 - ph / 2));
  },
};

/**
 * Build one prop def ({type, x, z, rot?, ...}) into a Group at (x, 0, z).
 * Returns null for unknown types (def files are versioned, be forgiving).
 */
export function buildProp(p, rng) {
  const build = BUILDERS[p.type];
  if (!build) return null;
  const g = new THREE.Group();
  build(p, g, rng);
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
 * kept only when clear of the road (roadWidthM/2 + minOffsetM) and the water.
 * `samples` are {x, z} points along the centerline.
 */
export function scatterProps(def, samples, roadWidthM, water = []) {
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
    if (!ok) continue;
    const prop = { type: sc.type, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
    if (sc.type === 'lamp') prop.rot = Math.atan2(-nearZ, nearX); // arm faces the road
    out.push(prop);
  }
  return out;
}
