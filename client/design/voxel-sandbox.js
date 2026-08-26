/**
 * voxel-sandbox.js — voxel-style design sandbox for MCP Grand Prix (MCPG-59).
 *
 * Renders the REAL `coastal-palm` track (waypoints, lake, theme, props,
 * scatter — `tracks/coastal-palm.json`) as a chunky all-instanced voxel
 * diorama with a mock spectator UI on top. No game logic, no networking:
 * this page exists to lock the visual direction before it is ported into
 * the real client.
 *
 * Rendering notes
 * - Every repeated voxel group is an InstancedMesh over ONE shared unit
 *   BoxGeometry (one draw call per group, per-instance color).
 * - The scene renders to an offscreen linear (half-float) target, then a
 *   small pure-Three.js bloom chain — bright-pass -> quarter-res ping-pong
 *   Gaussian -> additive composite with sRGB conversion — writes to screen.
 * - Camera is orthographic with the production framing (35 deg from the
 *   south), plus a slow auto-orbit, drag and wheel-zoom. `wide` and `cars`
 *   presets are exposed for screenshotting via `window.__voxelSandbox`.
 */
import * as THREE from '../vendor/three.module.js';

/* =========================================================================
 * 1. Track data
 * ======================================================================= */

// Live source of truth; the page fetches this first so edits to the track
// file show up immediately.
const TRACK_URL = new URL('../../tracks/coastal-palm.json', import.meta.url).href;

// Verbatim snapshot of tracks/coastal-palm.json (MCPG-59) — used when the
// page is opened without a server (file://) or the fetch fails.
const EMBEDDED_TRACK = {
  id: 'coastal-palm',
  name: 'Coastal Palm',
  lengthM: 1000,
  sectorLengthM: 200,
  roadWidthM: 13,
  // synthesized pit lane (the v1 track JSON predates the pitLane field):
  // same span/side as the original hardcoded pit slab (s 15-95, offset -20)
  pitLane: { fromFrac: 0.018, toFrac: 0.098, offsetM: -20, widthM: 9, boxSpacing: 22, accent: '#0a84ff' },
  waypoints: [
    [30, 148], [120, 146], [190, 118], [218, 45],
    [198, -35], [140, -95], [60, -128], [-10, -118],
    [-70, -132], [-140, -128], [-198, -85], [-216, -25],
    [-188, 35], [-125, 80], [-55, 118], [10, 140]
  ],
  water: [{ x: -55, z: 25, r: 60 }],
  theme: {
    sky: '#5ecdf6',
    ground: { base: '#f6de9a', spot: '#e3c276', patch: '#d3ab5e', tileM: 6 },
    road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
    curb: { red: '#e8362e', white: '#fdf6e8', threshold: 0.012 },
    water: '#19b8c9',
    pit: '#98a0b0',
    barriers: true,
    ambient: { sky: '#d8f4ff', ground: '#e8cf8e', intensity: 0.75 },
    sun: { color: '#fff3d6', intensity: 1.0 }
  },
  props: [
    { type: 'grandstand', x: 95, z: 112, rot: 0, w: 64, d: 12, h: 8 },
    { type: 'boat', x: -72, z: 12 },
    { type: 'boat', x: -45, z: 42 },
    { type: 'boat', x: -28, z: 14 },
    { type: 'palm', x: -244, z: -52 },
    { type: 'palm', x: -238, z: -8 },
    { type: 'palm', x: -228, z: 34 },
    { type: 'palm', x: 245, z: 60 },
    { type: 'palm', x: 250, z: 10 },
    { type: 'palm', x: 150, z: -160 },
    { type: 'sign', x: 40, z: 147.2, rot: 3.106 },
    { type: 'sign', x: 65.7, z: 147.6, rot: -3.134, color: '#ff2d55' },
    { type: 'sign', x: 137.6, z: -91.4, rot: -0.633, color: '#0a84ff' }
  ],
  scatter: { type: 'palm', count: 30, seed: 11, minOffsetM: 16 }
};

/* =========================================================================
 * 2. Geometry core (ported from client/js/rng.js, track.js, props.js so the
 *    sandbox uses byte-identical placement math)
 * ======================================================================= */

// Deterministic PRNG (mulberry32) — client mirror of src/rng.js
function createRng(seed = 1) {
  let a = seed >>> 0;
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      return min + Math.floor(this.next() * (max - min + 1));
    }
  };
}

// Waypoints -> closed centripetal Catmull-Rom, rescaled to lengthM
function createTrackCurve(def, lengthM) {
  const pts = def.waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve0 = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);

  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.divideScalar(pts.length);

  const rawLen = curve0.getLength();
  const scale = lengthM / rawLen;
  const scaled = pts.map((p) => {
    const d = p.clone().sub(c).multiplyScalar(scale);
    d.add(c);
    return d;
  });
  return new THREE.CatmullRomCurve3(scaled, true, 'centripetal', 0.5);
}

const CURB_MIN_RUN_M = 15;
const CURB_WIDTH_M = 2.2;
const CURB_STRIDE_M = 4;
const CURVATURE_SAMPLES = 240;

function curvatureSamples(curve, arclen) {
  const out = new Array(CURVATURE_SAMPLES);
  const t0 = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  for (let i = 0; i < CURVATURE_SAMPLES; i++) {
    t0.copy(curve.getTangentAt(i / CURVATURE_SAMPLES));
    t1.copy(curve.getTangentAt((i + 1) / CURVATURE_SAMPLES));
    const ang = Math.acos(THREE.MathUtils.clamp(t0.dot(t1), -1, 1));
    out[i] = ang / (arclen / CURVATURE_SAMPLES);
  }
  return out;
}

function curbRuns(curve, arclen, lengthM, threshold, minRunM = CURB_MIN_RUN_M) {
  const curv = curvatureSamples(curve, arclen);
  const hot = curv.map((c) => c >= threshold);
  const ds = lengthM / CURVATURE_SAMPLES;
  const runs = [];
  let i = 0;
  while (i < CURVATURE_SAMPLES) {
    if (!hot[i]) { i++; continue; }
    let j = i;
    while (j < CURVATURE_SAMPLES && hot[j]) j++;
    const lenM = (j - i) * ds;
    if (lenM >= minRunM) runs.push({ s0: i * ds, s1: i * ds + lenM });
    i = j;
  }
  if (hot[CURVATURE_SAMPLES - 1] && hot[0]) {
    const last = runs[runs.length - 1];
    const first = runs[0];
    if (last && first && Math.abs(last.s1 - lengthM) < ds + 1e-6 && first.s0 < ds + 1e-6) {
      runs.shift();
      runs.push({ s0: last.s0, s1: last.s1 + first.s1 });
    }
  }
  return runs;
}

// Seeded scatter (identical math to props.js: same seed, same candidate
// stream, same keep rules) — coastal-palm only scatters palms.
function scatterProps(def, samples, roadWidthM, water = []) {
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
    for (const s of samples) {
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
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
    out.push({ type: sc.type, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 });
  }
  return out;
}

/* =========================================================================
 * 3. Voxel palette — vibrant reinterpretation of the coastal-palm theme
 * ======================================================================= */

const PAL = {
  sky: '#3fc5ff',
  hemiSky: '#d8f4ff',
  hemiGround: '#ffd98a',
  sun: '#fff3d6',
  // sunlit beach: four light sand tones + one dune-dark
  sand: ['#ffd966', '#ffcf4f', '#f8c944', '#ffe28a', '#e8b83a'],
  road: ['#4a5165', '#454c5f', '#4f566b', '#414859'],
  curbRed: '#ff3b30',
  curbWhite: '#fdf6e8',
  pit: ['#96a0b8', '#8b95ad'],
  pitBox: '#c6cede',
  pitWall: '#39415a',
  barrierRed: '#ff3348',
  barrierWhite: '#f7f9ff',
  water: ['#14c8dc', '#0fb9cf', '#1fd9e2', '#0aa8bf'],
  waterGlint: '#b8fff4',
  foam: '#d9fff8',
  checkerW: '#f4f4f4',
  checkerD: '#15181f',
  lineWhite: '#e8ecf5',
  islandDirt: '#e2b45e',
  islandRock: '#a4702f',
  trunk: '#b5824d',
  leaf: ['#22c55e', '#2fd56e', '#45e884'],
  standBase: '#b6bed4',
  standStep: '#8f97b8',
  standRoof: '#333a4a',
  standPost: '#39415a',
  accent: '#ff2d78',
  hull: '#fff8ea',
  stripe: '#ff453a',
  signPost: '#39415a',
  carDark: '#1d222c',
  glass: '#9fc7dd'
};

/* =========================================================================
 * 3b. v2: five track styles + theme-driven palettes
 * ======================================================================= */

// The five design-track styles (new files under client/design/tracks/) plus
// the original coastal-palm kept as the v1 reference. Waypoints/water/props
// in the new files are pre-scaled to their lengthM, so the builder's
// rescale factor comes out ~1.0 for them.
const TRACK_LIST = [
  { id: 'harbor', name: 'Harbor Circuit', url: new URL('./tracks/harbor.json', import.meta.url).href },
  { id: 'dunes', name: 'Dune Grand Prix', url: new URL('./tracks/dunes.json', import.meta.url).href },
  { id: 'alpine', name: 'Alpine Pass', url: new URL('./tracks/alpine.json', import.meta.url).href },
  { id: 'night', name: 'Neon Night GP', url: new URL('./tracks/night.json', import.meta.url).href },
  { id: 'canyon', name: 'Canyon River', url: new URL('./tracks/canyon.json', import.meta.url).href },
  { id: 'coastal-palm', name: 'Coastal Palm (v1)', url: TRACK_URL, embedded: EMBEDDED_TRACK }
];

// HSL nudge — hex in, hex out, so palettes stay plain data.
function shiftHsl(hex, { h = 0, s = 0, l = 0 } = {}) {
  const c = new THREE.Color(hex);
  const o = { h: 0, s: 0, l: 0 };
  c.getHSL(o);
  c.setHSL(
    (o.h + h + 1) % 1,
    THREE.MathUtils.clamp(o.s + s, 0, 1),
    THREE.MathUtils.clamp(o.l + l, 0, 1)
  );
  return `#${c.getHexString()}`;
}

// 4 light-to-dark tones of a base (+ optional extra-dark dune tone).
function toneArray(base, { spread = 0.05, sat = 0, dark = null } = {}) {
  const offs = [-spread, 0, spread * 0.6, spread * 1.3];
  const out = offs.map((l) => shiftHsl(base, { s: sat, l }));
  if (dark != null) out.push(shiftHsl(base, { s: sat, l: dark }));
  return out;
}

/**
 * Turn a track def's theme into the palette the voxel builder uses.
 * Fixed colors (curbs, barriers, checker, island, cars, stand) stay in PAL;
 * everything environment-derived is theme-driven here, so each of the five
 * styles reads as a different world without touching the builder.
 */
// Production themes carry ground/road as { base, spot?, patch? } tone
// groups (see tracks/coastal-palm.json); flatten to the 5-tone / 4-tone
// arrays the builder picks from, deriving missing tones from the base.
function groundTones(g) {
  if (typeof g === 'string') return toneArray(g, { sat: 0.03, spread: 0.045, dark: -0.16 });
  const base = g?.base ?? '#efe0bd';
  return [
    base,
    g?.spot ?? shiftHsl(base, { l: -0.045 }),
    g?.patch ?? shiftHsl(base, { l: -0.09 }),
    shiftHsl(base, { l: 0.045 }),
    shiftHsl(base, { l: -0.16 })
  ];
}
function roadTones(r) {
  if (typeof r === 'string') return toneArray(r, { spread: 0.03 });
  const base = r?.base ?? '#3a3f4d';
  return [
    base,
    r?.spot ?? shiftHsl(base, { l: -0.03 }),
    shiftHsl(base, { l: 0.035 }),
    shiftHsl(base, { l: -0.055 })
  ];
}

function makePalette(def) {
  const th = def.theme ?? {};
  const pitTone = def.pitLane?.pit ?? th.pit ?? '#8b95ad';
  const water = typeof th.water === 'string' ? th.water : '#19b8c9';
  return {
    sky: th.sky ?? '#9fd8f8',
    hemiSky: th.ambient?.sky ?? '#d8f4ff',
    hemiGround: th.ambient?.ground ?? '#ffd98a',
    hemiIntensity: (th.ambient?.intensity ?? 0.75) * Math.PI,
    sun: th.sun?.color ?? '#fff3d6',
    sunIntensity: (th.sun?.intensity ?? 1.0) * Math.PI,
    sand: groundTones(th.ground),
    road: roadTones(th.road),
    pit: toneArray(pitTone, { spread: 0.03 }),
    pitBox: shiftHsl(pitTone, { l: 0.3 }),
    pitWall: shiftHsl(pitTone, { l: -0.35 }),
    water: toneArray(water, { sat: 0.05, spread: 0.055 }),
    waterGlint: shiftHsl(water, { s: -0.5, l: 0.45 }),
    foam: shiftHsl(water, { s: -0.8, l: 0.5 }),
    salt: th.salt ?? null,
    edgeLines: !!th.edgeLines,
    accent: def.pitLane?.accent ?? PAL.accent
  };
}

/* =========================================================================
 * 4. Voxel batch — InstancedMesh builder over a shared unit box
 * ======================================================================= */

// ONE geometry shared by every instanced group in the scene.
const unitBox = new THREE.BoxGeometry(1, 1, 1);

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _eul = new THREE.Euler();
const _col = new THREE.Color();

class VoxelBatch {
  /**
   * @param {string} name
   * @param {{cast?: boolean, receive?: boolean}} opts
   */
  constructor(name, { cast = false, receive = true, emissive = false } = {}) {
    this.name = name;
    this.cast = cast;
    this.receive = receive;
    // emissive: unlit MeshBasicMaterial — colors may exceed 1.0 so the
    // bloom bright-pass picks them up (neon, beacons, floodlights)
    this.emissive = emissive;
    // flat [x, y, z, sx, sy, sz, ry, Color]*
    this.items = [];
    this.count = 0;
  }

  add(x, y, z, sx, sy, sz, color, ry = 0) {
    this.items.push(x, y, z, sx, sy, sz, ry, color);
    this.count++;
  }

  build(parent) {
    if (this.count === 0) return null;
    const mat = this.emissive
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(unitBox, mat, this.count);
    mesh.name = this.name;
    for (let i = 0; i < this.count; i++) {
      const o = i * 8;
      _pos.set(this.items[o], this.items[o + 1], this.items[o + 2]);
      _eul.set(0, this.items[o + 6], 0);
      _quat.setFromEuler(_eul);
      _scl.set(this.items[o + 3], this.items[o + 4], this.items[o + 5]);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
      mesh.setColorAt(i, _col.copy(this.items[o + 7]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = this.cast;
    mesh.receiveShadow = this.receive;
    parent.add(mesh);
    return mesh;
  }
}

/* =========================================================================
 * 5. Voxel world
 * ======================================================================= */

// Layer heights (m). The road is a thick slab sitting just above the sand
// sea; water is a shallow step above the sand; curbs/barriers crown the
// road. The island slab top lip is exactly flush with the sand undersides.
const TILE = 6;            // ground/voxel grid
const TILE_GAP = 0.35;     // grout between sand cubes
const GROUND_TOP = -1.5;
const GROUND_H = 1.2;      // sand underside = -2.7 (island lip top)
const ROAD_TOP = 0;
const ROAD_H = 1.4;        // road underside -1.4: 0.1 above the sand
const CURB_TOP = 1.0;
const CURB_H = 0.8;
const WATER_TOP = -0.9;
const WATER_H = 0.55;
const FOAM_TOP = -0.72;
const FOAM_H = 0.6;
const BARRIER_H = 1.5;
const PIT_TOP = -0.15;
const PIT_H = 1.2;         // thick slab down to just above the sand
const ISLAND_H = 22;
const ISLAND_LIP = 16;
const GROUND_MARGIN_M = 160;

const N_ROAD_ROWS = 320;   // road tiles along the circuit
const N_ROAD_COLS = 4;
const N_BARRIERS = 500;    // barrier cubes around the circuit
const LABEL_Y = 6;         // car label height (production: y+6)

// The four mock cars — production palette, spread around the circuit.
const CARS = [
  { name: 'Slipstreamer', color: '#ff3b30', s: 120, lane: 2.0 },
  { name: 'Tirewrecker', color: '#ff9500', s: 340, lane: -2.2 },
  { name: 'Lapdancer', color: '#ffd60a', s: 610, lane: 1.5 },
  { name: 'Overtaker99', color: '#34c759', s: 840, lane: -1.8 }
];

// Glow tones (unlit batch; channel values > 1 clear the bloom threshold).
const GLOW = {
  warm: new THREE.Color(1.6, 1.35, 0.9),   // pit-lane lamps
  entry: new THREE.Color(3.4, 0.7, 0.5),   // pit entry beacon (red)
  exit: new THREE.Color(0.5, 2.5, 0.9),    // pit exit beacon (green)
  flood: new THREE.Color(1.9, 2.1, 2.6),   // circuit floodlights
  chand: new THREE.Color(1.8, 1.9, 2.4),   // track-side chandeliers
  edge: new THREE.Color(0.5, 1.55, 2.1),   // night-circuit edge lines
  beacon: new THREE.Color(2.4, 1.9, 0.7),  // lighthouse beacon
  winWarm: new THREE.Color(2.0, 1.45, 0.65),
  winCool: new THREE.Color(0.75, 1.55, 2.2),
  beaconRed: new THREE.Color(3.8, 0.55, 0.5), // tower aviation light
  fall: new THREE.Color(0.55, 2.0, 2.4)    // waterfall sheet
};

// Per-type vegetation tones (fixed — the species don't change per theme).
const VEGC = {
  cactus: new THREE.Color('#2f9e52'),
  cactus2: new THREE.Color('#3cb565'),
  spruce0: new THREE.Color('#1d6b46'),
  spruce1: new THREE.Color('#24805a'),
  snow: new THREE.Color('#f2f6fa'),
  brush0: new THREE.Color('#9c6b33'),
  brush1: new THREE.Color('#8a5a2b')
};

// Landmark tones (fixed per material, not per theme).
const LMC = {
  towerLight: new THREE.Color('#f5efe2'),
  towerRed: new THREE.Color('#e8362e'),
  towerDark: new THREE.Color('#232c47'),
  dune0: new THREE.Color('#f7d88b'),
  dune1: new THREE.Color('#eec06a'),
  cont0: new THREE.Color('#d1495b'),
  cont1: new THREE.Color('#2a9d8f'),
  cont2: new THREE.Color('#e9a03b'),
  cont3: new THREE.Color('#3a5fa8'),
  rock0: new THREE.Color('#7c8ba1'),
  rock1: new THREE.Color('#8fa0b5'),
  butte0: new THREE.Color('#b5623a'),
  butte1: new THREE.Color('#c97a4a'),
  butteTop: new THREE.Color('#d98e5f')
};

/**
 * Pit lane: gray slab parallel to the racing line, connected to the track
 * at entry/exit by road-edge links, pit boxes along the outer edge, wall
 * edging on both sides, pit lamps on the road edge and entry (red) / exit
 * (green) beacons. Returns info for the minimap, the barrier skip-zone and
 * the `pit` camera preset.
 */
function buildPitLane(def, ctx) {
  const { pointAt, tangentAt, lengthM, roadWidthM, lane, boxes, glow, pick, addAt } = ctx;
  const { cPit, cPitBox, cPitWall, cPost, cAccent, cWarm, cEntry, cExit } = ctx;
  const pitDef = def.pitLane;

  const s0 = (pitDef.fromFrac ?? 0.02) * lengthM;
  const s1 = (pitDef.toFrac ?? 0.12) * lengthM;
  const off = pitDef.offsetM ?? 15;
  const side = Math.sign(off);
  const widthM = pitDef.widthM ?? 9;
  const cols = Math.max(2, Math.round(widthM / 2.4));
  const colW = widthM / cols;

  // slab: rows of cubes hugging the centerline at `off` from the racing line
  const nRows = Math.max(8, Math.round(Math.abs(s1 - s0) / 3.5));
  const pitPoints = [];
  for (let i = 0; i <= nRows; i++) {
    const s = s0 + (s1 - s0) * (i / nRows);
    const p = pointAt(s);
    const t = tangentAt(s);
    const yaw = Math.atan2(t.x, t.z);
    pitPoints.push({ x: p.x - t.z * off, z: p.z + t.x * off });
    for (let c = 0; c < cols; c++) {
      const co = (c - (cols - 1) / 2) * colW;
      lane.add(p.x - t.z * (off + co), PIT_TOP - PIT_H / 2, p.z + t.x * (off + co),
        colW + 0.05, PIT_H, 3.7, pick(cPit), yaw);
    }
  }

  // entry/exit links: cubes stepping from the road edge across the turf to
  // the pit slab — the visual connection between track and pit lane
  for (const sEnd of [s0, s1]) {
    const p = pointAt(sEnd);
    const t = tangentAt(sEnd);
    const nx = -t.z, nz = t.x;
    const yaw = Math.atan2(t.x, t.z);
    const roadEdge = roadWidthM / 2 - 1.2;
    const span = Math.abs(off) - roadEdge;
    const steps = Math.max(2, Math.round(span / 2.6));
    for (let k = 0; k < steps; k++) {
      const d = roadEdge + span * (k / (steps - 1));
      lane.add(p.x + nx * d * side, PIT_TOP - PIT_H / 2, p.z + nz * d * side,
        3.2, PIT_H, 2.8, pick(cPit), yaw);
    }
  }

  // pit boxes on the outer edge: floor slab + outer wall + accent stripe
  const spacing = pitDef.boxSpacing ?? 22;
  for (let bs = s0 + 7; bs <= s1 - 7; bs += spacing) {
    const p = pointAt(bs);
    const t = tangentAt(bs);
    const yaw = Math.atan2(t.x, t.z);
    const bo = off + side * (widthM / 2 + 2.4);
    addAt(boxes, p.x, p.z, yaw, -bo, PIT_TOP + 0.25, 0, 5.2, 0.5, 6.4, cPitBox);
    addAt(boxes, p.x, p.z, yaw, -bo - side * 2.4, 1.05, 0, 0.8, 2.3, 6.4, cPitWall);
    addAt(boxes, p.x, p.z, yaw, -bo - side * 1.9, PIT_TOP + 0.95, 0, 0.9, 0.28, 6.4, cAccent);
  }

  // pit-wall edging along both long sides of the slab. The wall on the
  // road-edge side would sit across the entry/exit link — leave a gap there.
  const crossedEo = -(widthM / 2 + 0.2) * side;
  for (const eo of [-(widthM / 2 + 0.2), widthM / 2 + 0.2]) {
    for (let i = 0; i <= nRows; i += 2) {
      const s = s0 + (s1 - s0) * (i / nRows);
      if (eo === crossedEo && (s - s0 < 4.5 || s1 - s < 4.5)) continue;
      const p = pointAt(s);
      const t = tangentAt(s);
      const d = off + eo;
      boxes.add(p.x - t.z * d, PIT_TOP + 0.35, p.z + t.x * d, 0.6, 0.8, 7.0, cPitWall, Math.atan2(t.x, t.z));
    }
  }

  // pit lamps on the road edge (unlit glow batch)
  for (let ls = s0 + 4; ls < s1 - 4; ls += 13) {
    const p = pointAt(ls);
    const t = tangentAt(ls);
    const nx = -t.z, nz = t.x;
    const d = roadWidthM / 2 + 0.9;
    const lx = p.x + nx * d * side, lz = p.z + nz * d * side;
    glow.add(lx, 2.2, lz, 0.32, 2.5, 0.32, cPost);
    glow.add(lx, 3.55, lz, 1.15, 0.22, 0.7, cWarm);
  }

  // entry (red) / exit (green) beacon stacks on posts at the road edge
  for (const [sEnd, cBeacon] of [[s0, cEntry], [s1, cExit]]) {
    const p = pointAt(sEnd);
    const t = tangentAt(sEnd);
    const nx = -t.z, nz = t.x;
    const d = roadWidthM / 2 + 1.2;
    const bx = p.x + nx * d * side, bz = p.z + nz * d * side;
    glow.add(bx, 2.0, bz, 0.4, 3.0, 0.4, cPost);
    for (let k = 0; k < 3; k++) glow.add(bx, 3.9 + k * 0.75, bz, 1.3, 0.6, 1.3, cBeacon);
  }

  // camera target for the `pit` preset: between road edge and slab at entry
  const ep = pointAt(s0), et = tangentAt(s0);
  const entryMid = new THREE.Vector3(
    ep.x - et.z * (roadWidthM / 4 + Math.abs(off) / 2), 0,
    ep.z + et.x * (roadWidthM / 4 + Math.abs(off) / 2)
  );
  return { s0, s1, side, off, widthM, pitPoints, entryMid };
}

/**
 * Vegetation: hand-placed props + seeded scatter (identical candidate math
 * to the production client), per-type shapes: palm / cactus / spruce /
 * brush. Skips anything landing on the pit slab.
 */
function buildVegetation(def, ctx) {
  const { samples, roadWidthM, trunkBatch, vegA, vegB, vegC, pitInfo } = ctx;
  const all = (def.props ?? []).concat(
    scatterProps(def, samples, roadWidthM, def.water ?? [])
  );
  const nearPit = (x, z) => {
    if (!pitInfo?.pitPoints?.length) return false;
    const r = pitInfo.widthM / 2 + 4;
    for (const pp of pitInfo.pitPoints) {
      const dx = x - pp.x, dz = z - pp.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  const veg = all
    .filter((p) => ['palm', 'cactus', 'spruce', 'brush'].includes(p.type))
    .filter((p) => !nearPit(p.x, p.z));
  const rngH = createRng(99);
  for (const p of veg) {
    const y = GROUND_TOP;
    if (p.type === 'palm') {
      const h = rngH.int(6, 9);
      trunkBatch.add(p.x, y + h / 2, p.z, 1.2, h, 1.2, ctx.cTrunk);
      vegA.add(p.x, y + h + 0.2, p.z, 7, 1.2, 2.6, ctx.cLeaf0);
      vegB.add(p.x, y + h + 0.2, p.z, 2.6, 1.2, 7, ctx.cLeaf1);
      vegC.add(p.x, y + h + 1.2, p.z, 4.4, 1, 4.4, ctx.cLeaf2);
    } else if (p.type === 'cactus') {
      const h = rngH.int(5, 8);
      trunkBatch.add(p.x, y + h / 2, p.z, 1.5, h, 1.5, ctx.cCactus);
      vegA.add(p.x - 1.4, y + h * 0.55, p.z, 0.8, 1.5, 0.8, ctx.cCactus2);
      vegB.add(p.x + 1.4, y + h * 0.7, p.z, 0.8, 1.5, 0.8, ctx.cCactus2);
      vegC.add(p.x, y + h + 0.3, p.z, 1.5, 0.8, 1.5, ctx.cCactus);
    } else if (p.type === 'spruce') {
      const h = rngH.int(5, 8);
      trunkBatch.add(p.x, y + 0.8, p.z, 0.9, 1.6, 0.9, ctx.cTrunk);
      vegA.add(p.x, y + 1.6 + h * 0.25, p.z, 4.6, h * 0.5, 4.6, ctx.cSpruce0);
      vegB.add(p.x, y + 1.6 + h * 0.55, p.z, 3.2, h * 0.45, 3.2, ctx.cSpruce1);
      vegC.add(p.x, y + 1.6 + h * 0.8, p.z, 1.9, h * 0.35, 1.9, ctx.cSnow);
    } else { // brush
      const s = rngH.int(14, 20) / 10;
      vegA.add(p.x, y + 0.5 * s, p.z, 1.9 * s, 1.0 * s, 1.9 * s,
        rngH.next() < 0.5 ? ctx.cBrush0 : ctx.cBrush1);
    }
  }
}

/**
 * Resolve a prop's position: `{s, off}` props sit relative to the racing
 * line (s in arc meters, off in meters along the left normal); `{x, z}`
 * props are absolute (pre-scaled by the track generator). yaw always ends
 * up as the track heading at the site, so local +Z runs along the track.
 */
function placeProp(p, pointAt, tangentAt) {
  if (p.s != null) {
    const cp = pointAt(p.s);
    const t = tangentAt(p.s);
    const nx = -t.z, nz = t.x;
    const off = p.off ?? 0;
    return { x: cp.x + nx * off, z: cp.z + nz * off, yaw: Math.atan2(t.x, t.z) };
  }
  return { x: p.x, z: p.z, yaw: p.rot ?? 0 };
}

/**
 * Track landmarks (per type): lighthouse, pyramid, dune, container,
 * floodlight, chandelier, skyscraper, peak, butte, waterfall. Grandstands,
 * signs, boats and vegetation are handled by their own sections.
 */
function buildLandmarks(def, ctx) {
  const { lm, glow, pointAt, tangentAt, roadWidthM, cPost, cFoam, addAt } = ctx;
  const y0 = GROUND_TOP;
  for (const p of def.props ?? []) {
    const q = placeProp(p, pointAt, tangentAt);
    switch (p.type) {
      case 'lighthouse': {
        const w = p.w ?? 4.5;
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 5, 0, w, 10, w, ctx.cTowerLight);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 7.6, 0, w + 0.6, 1.6, w + 0.6, ctx.cTowerRed);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 8.9, 0, w + 1.6, 0.5, w + 1.6, ctx.cTowerLight);
        addAt(glow, q.x, q.z, q.yaw, 0, y0 + 9.8, 0, 1.6, 1.1, 1.6, GLOW.beacon);
        break;
      }
      case 'pyramid': {
        const h = p.h ?? 16, base = p.base ?? 14;
        const layers = 6;
        for (let i = 0; i < layers; i++) {
          const s = base * (1 - i / layers) + 1.5;
          addAt(lm, q.x, q.z, q.yaw, 0, y0 + (h / layers) * (i + 0.5), 0,
            s, h / layers, s, i % 2 === 0 ? ctx.cDune0 : ctx.cDune1);
        }
        addAt(glow, q.x, q.z, q.yaw, 0, y0 + h + 0.4, 0, 1.2, 0.8, 1.2,
          new THREE.Color(2.4, 2.0, 1.1));
        break;
      }
      case 'dune': {
        const w = p.w ?? 16, h = p.h ?? 5;
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 0.7, 0, w, 1.4, w * 0.62, ctx.cDune0);
        addAt(lm, q.x, q.z, q.yaw, -w * 0.08, y0 + 1.9, 0, w * 0.72, 1.2, w * 0.48, ctx.cDune1);
        addAt(lm, q.x, q.z, q.yaw, -w * 0.14, y0 + h * 0.62, 0, w * 0.42, 1.0, w * 0.3, ctx.cDune0);
        break;
      }
      case 'container': {
        const cols = [ctx.cCont0, ctx.cCont1, ctx.cCont2, ctx.cCont3];
        const n = 1 + (Math.abs(Math.round(q.x * 7)) % 3);
        for (let i = 0; i < n; i++) {
          addAt(lm, q.x, q.z, q.yaw,
            (i - (n - 1) / 2) * 6.4, y0 + 1.1 + Math.floor(i / 2) * 2.3,
            (i % 2) * 3.2 - 1.6, 6.0, 2.2, 2.6, cols[(i + Math.round(q.x)) % 4]);
        }
        break;
      }
      case 'floodlight': {
        const h = 14;
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h / 2, 0, 0.55, h, 0.55, cPost);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h + 0.4, 0, 2.6, 0.9, 1.2, cPost);
        for (let i = 0; i < 3; i++) {
          addAt(glow, q.x, q.z, q.yaw, -0.8 + i * 0.8, y0 + h + 0.45, 0, 0.5, 0.4, 0.5, GLOW.flood);
        }
        break;
      }
      case 'chandelier': {
        const half = roadWidthM / 2 + 2;
        for (const sgn of [-1, 1]) {
          addAt(lm, q.x, q.z, q.yaw, sgn * half, y0 + 3.5, 0, 0.5, 7, 0.5, cPost);
        }
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 6.8, 0, half * 2 + 1, 0.4, 0.6, cPost);
        for (const dx of [-half + 1.5, -half / 2, half / 2, half - 1.5]) {
          addAt(glow, q.x, q.z, q.yaw, dx, y0 + 6.2, 0, 0.9, 0.5, 0.9, GLOW.chand);
        }
        break;
      }
      case 'skyscraper': {
        const h = p.h ?? 22, w = p.w ?? 9;
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h / 2, 0, w, h, w, ctx.cTowerDark);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h + 1.2, 0, 0.5, 2.4, 0.5, cPost);
        for (let i = 0; i < 5; i++) {
          const warm = (i + Math.round(q.x + q.z)) % 2 === 0;
          addAt(glow, q.x, q.z, q.yaw, 0, y0 + 3 + i * (h - 5) / 5, 0,
            w + 0.3, 0.55, w + 0.3, warm ? GLOW.winWarm : GLOW.winCool);
        }
        addAt(glow, q.x, q.z, q.yaw, 0, y0 + h + 2.6, 0, 0.6, 0.6, 0.6, GLOW.beaconRed);
        break;
      }
      case 'peak': {
        const h = p.h ?? 30, base = p.base ?? 26;
        const layers = 8;
        for (let i = 0; i < layers; i++) {
          const s = base * (1 - i / layers) + 2;
          addAt(lm, q.x, q.z, q.yaw, 0, y0 + (h / layers) * (i + 0.5), 0,
            s, h / layers, s, i % 2 === 0 ? ctx.cRock0 : ctx.cRock1);
        }
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h + 0.6, 0, 4, 1.4, 4, ctx.cSnow);
        break;
      }
      case 'butte': {
        const h = p.h ?? 10, base = p.base ?? 18;
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h * 0.3, 0, base, h * 0.6, base, ctx.cButte0);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h * 0.75, 0, base * 0.66, h * 0.5, base * 0.66, ctx.cButte1);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h + 0.4, 0, base * 0.62, 0.9, base * 0.62, ctx.cButteTop);
        break;
      }
      case 'waterfall': {
        const w = p.w ?? 10, h = p.h ?? 8;
        for (let i = 0; i < 4; i++) {
          addAt(glow, q.x, q.z, q.yaw, (i - 1.5) * (w / 4), y0 + h / 2, 0,
            w / 4 + 0.05, h, 0.9, GLOW.fall);
        }
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + h + 0.4, 0, w + 2, 0.9, 1.4, ctx.cRock1);
        addAt(lm, q.x, q.z, q.yaw, 0, y0 + 0.25, 0, w + 3, 0.5, 2.5, cFoam);
        break;
      }
      default: break; // grandstand / sign / boat / vegetation: own sections
    }
  }
}

/**
 * Build the whole voxel world for a track def. Returns
 * { group, cars, trackCenter, fitBox, size, map, waterCircles, startLine,
 *   pit, palette, instanceCount }.
 */
function buildVoxelWorld(def) {
  const group = new THREE.Group();
  const lengthM = def.lengthM;
  const roadWidthM = def.roadWidthM;
  const theme = def.theme;

  const curve = createTrackCurve(def, lengthM);
  const arclen = curve.getLength();
  const wrap = (s) => ((s % lengthM) + lengthM) % lengthM;
  const pointAt = (s) => curve.getPointAt(wrap(s) / arclen);
  const tangentAt = (s) => curve.getTangentAt(wrap(s) / arclen);

  const hexC = (h) => new THREE.Color(h);
  const rng = createRng(7); // tone picking (visual only, fixed seed)
  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];
  const pal = makePalette(def);
  const sandC = pal.sand.map(hexC);
  const roadC = pal.road.map(hexC);
  const waterC = pal.water.map(hexC);
  const glintC = hexC(pal.waterGlint);
  const foamC = hexC(pal.foam);
  const pitC = pal.pit.map(hexC);
  const cCurbRed = new THREE.Color(PAL.curbRed);
  const cCurbWhite = new THREE.Color(PAL.curbWhite);
  const cBarRed = new THREE.Color(PAL.barrierRed);
  const cBarWhite = new THREE.Color(PAL.barrierWhite);
  const cLine = new THREE.Color(PAL.lineWhite);
  const cCheckW = new THREE.Color(PAL.checkerW);
  const cCheckD = new THREE.Color(PAL.checkerD);
  const cPitBox = hexC(pal.pitBox);
  const cPitWall = hexC(pal.pitWall);
  const cTrunk = new THREE.Color(PAL.trunk);
  const cLeaf = PAL.leaf.map((h) => new THREE.Color(h));
  const cStandBase = new THREE.Color(PAL.standBase);
  const cStandStep = new THREE.Color(PAL.standStep);
  const cStandRoof = new THREE.Color(PAL.standRoof);
  const cStandPost = new THREE.Color(PAL.standPost);
  const cAccent = hexC(pal.accent);
  const cHull = new THREE.Color(PAL.hull);
  const cStripe = new THREE.Color(PAL.stripe);
  const cWhite = new THREE.Color('#ffffff');
  const cPost = new THREE.Color(PAL.signPost);

  // ---- circuit bbox + ground extent (production: 100 samples + 160 m)
  const bbox = new THREE.Box3();
  const tv = new THREE.Vector3();
  for (let i = 0; i < 100; i++) bbox.expandByPoint(tv.copy(curve.getPointAt(i / 100)));
  const trackCenter = bbox.getCenter(new THREE.Vector3());
  const gsize = bbox.getSize(new THREE.Vector3());
  const groundSize = {
    x: gsize.x + 2 * GROUND_MARGIN_M,
    z: gsize.z + 2 * GROUND_MARGIN_M
  };

  // Rotate a local offset (lx, lz) by yaw around (px, pz) and add a cube.
  const addAt = (batch, px, pz, yaw, lx, ly, lz, sx, sy, sz, color) => {
    const cx = Math.cos(yaw), sxr = Math.sin(yaw);
    batch.add(px + lx * cx + lz * sxr, ly, pz - lx * sxr + lz * cx, sx, sy, sz, color, yaw);
  };

  // ---- island slab (floating diorama base, production layout)
  const island = new THREE.Group();
  const topLip = new THREE.Mesh(
    new THREE.BoxGeometry(groundSize.x + ISLAND_LIP, ISLAND_H * 0.45, groundSize.z + ISLAND_LIP),
    new THREE.MeshLambertMaterial({ color: PAL.islandDirt })
  );
  topLip.position.y = ISLAND_H * 0.45 / 2;
  const bottomRock = new THREE.Mesh(
    new THREE.BoxGeometry(groundSize.x - 8, ISLAND_H * 0.55, groundSize.z - 8),
    new THREE.MeshLambertMaterial({ color: PAL.islandRock })
  );
  bottomRock.position.y = -ISLAND_H * 0.55 / 2;
  topLip.receiveShadow = true;
  bottomRock.receiveShadow = true;
  island.add(topLip, bottomRock);
  island.position.set(trackCenter.x, -12.6, trackCenter.z);
  const islandBottomY = -12.6 - ISLAND_H * 0.55;
  group.add(island);

  // ---- sand sea (instanced cubes on the 6 m grid)
  const sand = new VoxelBatch('sand');
  {
    const x0 = Math.floor((trackCenter.x - groundSize.x / 2) / TILE);
    const x1 = Math.ceil((trackCenter.x + groundSize.x / 2) / TILE);
    const z0 = Math.floor((trackCenter.z - groundSize.z / 2) / TILE);
    const z1 = Math.ceil((trackCenter.z + groundSize.z / 2) / TILE);
    const t = TILE - TILE_GAP;
    for (let gx = x0; gx < x1; gx++) {
      for (let gz = z0; gz < z1; gz++) {
        let tone;
        const r = rng.next();
        if (r < 0.30) tone = sandC[0];
        else if (r < 0.55) tone = sandC[1];
        else if (r < 0.78) tone = sandC[2];
        else if (r < 0.97) tone = sandC[3];
        else tone = sandC[4];
        sand.add((gx + 0.5) * TILE, GROUND_TOP - GROUND_H / 2, (gz + 0.5) * TILE, t, GROUND_H, t, tone);
      }
    }
  }

  // ---- road (thick instanced slab band, 4 columns of cubes)
  const road = new VoxelBatch('road');
  {
    const colW = roadWidthM / N_ROAD_COLS;
    const step = lengthM / N_ROAD_ROWS;
    for (let i = 0; i < N_ROAD_ROWS; i++) {
      const s = i * step;
      const p = pointAt(s);
      const t = tangentAt(s);
      const nx = -t.z, nz = t.x;
      const yaw = Math.atan2(t.x, t.z);
      for (let cIdx = 0; cIdx < N_ROAD_COLS; cIdx++) {
        const off = (cIdx - (N_ROAD_COLS - 1) / 2) * colW;
        const tone = rng.next() < 0.85 ? pick(roadC) : roadC[3];
        road.add(p.x + nx * off, ROAD_TOP - ROAD_H / 2, p.z + nz * off, colW, ROAD_H, step + 0.02, tone, yaw);
      }
    }
  }

  // ---- centerline dashes
  const centerline = new VoxelBatch('centerline');
  {
    const dashStep = 8;
    const n = Math.floor(lengthM / dashStep);
    for (let k = 0; k < n; k++) {
      const s = k * dashStep + dashStep / 2;
      const p = pointAt(s);
      const t = tangentAt(s);
      centerline.add(p.x, ROAD_TOP + 0.06, p.z, 0.5, 0.12, 2.6, cLine, Math.atan2(t.x, t.z));
    }
  }

  // ---- start/finish checker (2 rows x 6 columns across the road)
  const checker = new VoxelBatch('checker');
  {
    const width = Math.max(4, roadWidthM - 1.5);
    const colW = width / 6;
    for (let r = 0; r < 2; r++) {
      const s = r === 0 ? -0.8 : 0.8;
      const p = pointAt(s);
      const t = tangentAt(s);
      const nx = -t.z, nz = t.x;
      const yaw = Math.atan2(t.x, t.z);
      for (let k = 0; k < 6; k++) {
        const off = (k - 2.5) * colW;
        const color = (k + r) % 2 === 0 ? cCheckW : cCheckD;
        checker.add(p.x + nx * off, ROAD_TOP + 0.06, p.z + nz * off, colW, 0.12, 1.6, color, yaw);
      }
    }
  }

  // ---- sector ticks (def.sectorLengthM)
  const ticks = new VoxelBatch('sector-ticks');
  {
    const sectorLen = def.sectorLengthM;
    if (sectorLen && sectorLen > 0) {
      for (let s = sectorLen; s < lengthM; s += sectorLen) {
        const p = pointAt(s);
        const t = tangentAt(s);
        const nx = -t.z, nz = t.x;
        const yaw = Math.atan2(t.x, t.z);
        for (let k = 0; k < 6; k++) {
          const off = (k - 2.5) * 2;
          ticks.add(p.x + nx * off, ROAD_TOP + 0.05, p.z + nz * off, 2, 0.1, 0.7, cLine, yaw);
        }
      }
    }
  }

  // ---- curbs on hard corners (outer edge, alternating red/white)
  const curbs = new VoxelBatch('curbs');
  if (theme.curb) {
    const curbOffset = roadWidthM / 2 + CURB_WIDTH_M / 2 - 0.4;
    for (const run of curbRuns(curve, arclen, lengthM, theme.curb.threshold ?? 0.021)) {
      let s = run.s0;
      let k = 0;
      while (s < run.s1 - 1e-9) {
        const p = pointAt(s);
        const t = tangentAt(s);
        curbs.add(
          p.x - t.z * curbOffset,
          CURB_TOP - CURB_H / 2,
          p.z + t.x * curbOffset,
          CURB_WIDTH_M, CURB_H, CURB_STRIDE_M,
          k % 2 === 0 ? cCurbRed : cCurbWhite,
          Math.atan2(t.x, t.z)
        );
        s += CURB_STRIDE_M;
        k++;
      }
    }
  }

  // ---- pit lane (def.pitLane): parallel slab + entry/exit links + pit
  // boxes + road-edge lamps + entry/exit beacons (coastal-palm carries a
  // synthesized pitLane in the embedded snapshot)
  const pit = new VoxelBatch('pit-lane');
  const pitBoxes = new VoxelBatch('pit-boxes', { cast: true });
  const glow = new VoxelBatch('glow', { emissive: true });
  const pitInfo = buildPitLane(def, {
    pointAt, tangentAt, lengthM, roadWidthM,
    lane: pit, boxes: pitBoxes, glow, pick, addAt,
    cPit: pitC, cPitBox, cPitWall, cPost, cAccent,
    cWarm: GLOW.warm, cEntry: GLOW.entry, cExit: GLOW.exit
  });

  // ---- barriers (dark base slab + red/white top cube, full circuit).
  // The base reaches the sand so the wall reads solid from any angle.
  const barriers = new VoxelBatch('barriers', { cast: true });
  if (theme.barriers) {
    const off = roadWidthM / 2 + 3;
    const step = lengthM / N_BARRIERS;
    const cBase = new THREE.Color('#2b3040');
    // keep the pit-side barriers clear around the pit links (only relevant
    // when the pit sits on the barrier side, i.e. normal(+))
    const pitSkip = pitInfo.side === 1
      ? (s) => Math.abs(s - pitInfo.s0) < 12 || Math.abs(s - pitInfo.s1) < 12
      : () => false;
    for (let i = 0; i < N_BARRIERS; i++) {
      const s = i * step;
      if (pitSkip(s)) continue;
      const p = pointAt(s);
      const t = tangentAt(s);
      const yaw = Math.atan2(t.x, t.z);
      const bx = p.x - t.z * off;
      const bz = p.z + t.x * off;
      barriers.add(bx, GROUND_TOP + BARRIER_H / 2, bz, step + 0.05, BARRIER_H, step + 0.05, cBase, yaw);
      barriers.add(bx, BARRIER_H / 2, bz, step + 0.05, BARRIER_H, step + 0.05, i % 2 === 0 ? cBarRed : cBarWhite, yaw);
    }
  }

  // ---- water (cube grid clipped to the circles) + bright foam edge;
  // `salt: true` circles are dry salt pans (dunes)
  const water = new VoxelBatch('water');
  const foam = new VoxelBatch('foam');
  const salt = new VoxelBatch('salt');
  {
    const circles = def.water ?? [];
    if (circles.length) {
      const x0 = Math.floor((trackCenter.x - groundSize.x / 2) / TILE);
      const x1 = Math.ceil((trackCenter.x + groundSize.x / 2) / TILE);
      const z0 = Math.floor((trackCenter.z - groundSize.z / 2) / TILE);
      const z1 = Math.ceil((trackCenter.z + groundSize.z / 2) / TILE);
      const t = TILE - TILE_GAP;
      const saltA = hexC(pal.salt ?? '#e9e2cc');
      const saltB = saltA.clone().offsetHSL(0, 0, 0.05);
      for (const w of circles) {
        const isSalt = !!w.salt;
        for (let gx = x0; gx < x1; gx++) {
          for (let gz = z0; gz < z1; gz++) {
            const cx = (gx + 0.5) * TILE;
            const cz = (gz + 0.5) * TILE;
            const d = Math.hypot(cx - w.x, cz - w.z);
            if (d < w.r - 3) {
              if (isSalt) {
                salt.add(cx, GROUND_TOP - 0.55, cz, t, 0.6, t, rng.next() < 0.12 ? saltB : saltA);
              } else {
                const color = rng.next() < 0.06 ? glintC : pick(waterC);
                water.add(cx, WATER_TOP - WATER_H / 2, cz, t, WATER_H, t, color);
              }
            } else if (d < w.r) {
              if (isSalt) salt.add(cx, GROUND_TOP - 0.45, cz, t, 0.5, t, saltB);
              else foam.add(cx, FOAM_TOP - FOAM_H / 2, cz, t, FOAM_H, t, foamC);
            }
          }
        }
      }
    }
  }

  // ---- palms: hand-placed + seeded scatter (identical placement to the
  // production client: scatter rng = seed 11, height rng = seed 99 drawn in
  // props-array order — the only rng consumer on this track)
  const vegTrunk = new VoxelBatch('veg-trunks', { cast: true });
  const vegA = new VoxelBatch('veg-a', { cast: true });
  const vegB = new VoxelBatch('veg-b', { cast: true });
  const vegC = new VoxelBatch('veg-c', { cast: true });
  {
    const samples = [];
    for (let i = 0; i < 160; i++) {
      const p = curve.getPointAt(i / 160);
      samples.push({ x: p.x, z: p.z });
    }
    buildVegetation(def, {
      samples, roadWidthM, pitInfo,
      trunkBatch: vegTrunk, vegA, vegB, vegC,
      cTrunk, cLeaf0: cLeaf[0], cLeaf1: cLeaf[1], cLeaf2: cLeaf[2],
      cCactus: VEGC.cactus, cCactus2: VEGC.cactus2,
      cSpruce0: VEGC.spruce0, cSpruce1: VEGC.spruce1,
      cSnow: VEGC.snow, cBrush0: VEGC.brush0, cBrush1: VEGC.brush1
    });
  }

  // ---- grandstand (production geometry, vibrant tones + accent trim)
  const stand = new VoxelBatch('grandstand', { cast: true });
  {
    let p = (def.props ?? []).find((q) => q.type === 'grandstand');
    if (p) {
      if (p.s != null) { // curve-relative: stand runs along the track at `off`
        const cp = pointAt(p.s); const t = tangentAt(p.s);
        const nx = -t.z, nz = t.x;
        const off = p.off ?? 18;
        p = { ...p, x: cp.x + nx * off, z: cp.z + nz * off, rot: Math.atan2(t.x, t.z) + Math.PI / 2 };
      }
      const w = p.w ?? 30;
      const d = p.d ?? 12;
      const h = p.h ?? 8;
      const y = GROUND_TOP;
      const yaw = p.rot ?? 0;
      addAt(stand, p.x, p.z, yaw, 0, y + 0.6, 0, w, 1.2, d, cStandBase);
      for (let i = 0; i < 3; i++) {
        addAt(stand, p.x, p.z, yaw, 0, y + 1.7 + i * 1.4, -d * 0.24 - i * d * 0.28, w, 1.4, d * 0.28, cStandStep);
      }
      addAt(stand, p.x, p.z, yaw, 0, y + h, 0, w, 0.7, d + 3, cStandRoof);
      addAt(stand, p.x, p.z, yaw, 0, y + h + 0.4, d / 2 + 1.2, w, 0.5, 0.8, cAccent);
      for (const px of [-w / 2 + 2, w / 2 - 2]) {
        addAt(stand, p.x, p.z, yaw, px, y + (h - 0.4) / 2 + 0.4, d / 2 - 1, 0.8, h - 0.4, 0.8, cStandPost);
      }
    }
  }

  // ---- boats (hull sits on the water top)
  const boats = new VoxelBatch('boats', { cast: true });
  {
    const yaws = [0.35, -0.6, 0.15];
    let i = 0;
    for (const p of def.props ?? []) {
      if (p.type !== 'boat') continue;
      const y = WATER_TOP;
      const yaw = yaws[i++ % yaws.length];
      addAt(boats, p.x, p.z, yaw, 0, y + 0.55, 0, 6, 1.1, 2.4, cHull);
      addAt(boats, p.x, p.z, yaw, 0, y + 1.25, 0, 5.6, 0.3, 2.0, cStripe);
      addAt(boats, p.x, p.z, yaw, -1, y + 1.95, 0, 1.8, 1.1, 1.6, cWhite);
      addAt(boats, p.x, p.z, yaw, 1.8, y + 2.9, 0, 0.3, 3, 0.3, cTrunk);
    }
  }

  // ---- sponsor signs.
  // Production quirk: two of the three sign props sit ON the racing line
  // (data places them ~0.5 m from the centerline). For the look shot any
  // sign closer than roadWidth/2 + 2 m to the centerline is pushed to
  // roadWidth/2 + 5 m on the outside — no signs in the racing line.
  const signs = new VoxelBatch('signs', { cast: true });
  {
    const near = (x, z) => {
      let best = { d2: Infinity, px: 0, pz: 0, tx: 1, tz: 0 };
      for (let i = 0; i < 100; i++) {
        const p = curve.getPointAt(i / 100);
        const t = curve.getTangentAt(i / 100);
        const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
        if (d2 < best.d2) best = { d2, px: p.x, pz: p.z, tx: t.x, tz: t.z };
      }
      return best;
    };
    for (const q of def.props ?? []) {
      if (q.type !== 'sign') continue;
      let p = q;
      if (p.s != null) { // curve-relative: panel parallel to the track at `off`
        const cp = pointAt(p.s); const t = tangentAt(p.s);
        const nx = -t.z, nz = t.x;
        const off = p.off ?? 16;
        p = { ...p, x: cp.x + nx * off, z: cp.z + nz * off, rot: Math.atan2(t.x, t.z) + Math.PI / 2 };
      }
      const w = p.w ?? 8;
      const h = p.h ?? 5;
      const ph = Math.min(2.2, h * 0.45);
      const y = GROUND_TOP;
      const yaw = p.rot ?? 0;
      const cPanel = new THREE.Color(p.color ?? '#ffc53d');
      let sx = p.x, sz = p.z;
      const b = near(p.x, p.z);
      if (b.d2 < (roadWidthM / 2 + 2) ** 2) {
        const nx = -b.tz, nz = b.tx;
        const side = (p.x - b.px) * nx + (p.z - b.pz) * nz >= 0 ? 1 : -1;
        const off = roadWidthM / 2 + 5;
        sx = b.px + nx * off * side;
        sz = b.pz + nz * off * side;
      }
      addAt(signs, sx, sz, yaw, 0, y + h / 2, 0, 0.8, h, 0.8, cPost);
      addAt(signs, sx, sz, yaw, 0, y + h - 0.3 - ph / 2, 0, w, ph, 0.7, cPanel);
    }
  }

  // ---- track landmarks (lighthouse, pyramid, dune, container, floodlight,
  // chandelier, skyscraper, peak, butte, waterfall)
  const lm = new VoxelBatch('landmarks', { cast: true });
  buildLandmarks(def, {
    lm, glow, pointAt, tangentAt, roadWidthM, cPost, cFoam: foamC, addAt,
    cTowerLight: LMC.towerLight, cTowerRed: LMC.towerRed, cTowerDark: LMC.towerDark,
    cDune0: LMC.dune0, cDune1: LMC.dune1,
    cCont0: LMC.cont0, cCont1: LMC.cont1, cCont2: LMC.cont2, cCont3: LMC.cont3,
    cRock0: LMC.rock0, cRock1: LMC.rock1,
    cButte0: LMC.butte0, cButte1: LMC.butte1, cButteTop: LMC.butteTop,
    cSnow: VEGC.snow
  });

  // ---- night-circuit edge lines (theme.edgeLines): glowing road edges
  if (pal.edgeLines) {
    const step = lengthM / 240;
    const off = roadWidthM / 2 - 0.9;
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 240; i++) {
        const s = i * step;
        const p = pointAt(s);
        const t = tangentAt(s);
        glow.add(p.x - t.z * off * sgn, ROAD_TOP + 0.09, p.z + t.x * off * sgn,
          0.32, 0.1, step + 0.06, GLOW.edge, Math.atan2(t.x, t.z));
      }
    }
  }

  // ---- the four cars (one InstancedMesh each, 10 cubes — production F1
  // silhouette scaled 2.1x, nose toward local +Z)
  const carBatches = [];
  for (const car of CARS) {
    const batch = new VoxelBatch(`car-${car.name}`, { cast: true });
    const p = pointAt(car.s);
    const t = tangentAt(car.s);
    const px = p.x - t.z * car.lane;
    const pz = p.z + t.x * car.lane;
    const yaw = Math.atan2(t.x, t.z);
    const body = new THREE.Color(car.color);
    const dark = new THREE.Color(PAL.carDark);
    const glass = new THREE.Color(PAL.glass);
    addAt(batch, px, pz, yaw, 0, 0.7, -0.1, 2.0, 0.85, 4.6, body);       // body
    addAt(batch, px, pz, yaw, 0, 1.5, 0.15, 1.1, 0.55, 1.5, glass);       // cockpit
    addAt(batch, px, pz, yaw, 0, 0.6, 2.55, 1.3, 0.35, 1.1, body);        // nose
    addAt(batch, px, pz, yaw, 0, 1.8, -2.55, 2.5, 0.3, 0.75, body);       // rear wing
    addAt(batch, px, pz, yaw, -0.62, 1.2, -2.5, 0.28, 0.9, 0.3, dark);    // pylon
    addAt(batch, px, pz, yaw, 0.62, 1.2, -2.5, 0.28, 0.9, 0.3, dark);     // pylon
    for (const wx of [-1.12, 1.12]) for (const wz of [-1.75, 1.75]) {
      addAt(batch, px, pz, yaw, wx, 0.525, wz, 0.95, 1.05, 1.35, dark);   // wheel
    }
    // bake a 2.1x car scale into every cube around the car origin (the
    // production makeCarMesh does g.scale.setScalar(1.9); 2.1 reads better
    // for static display) so we can keep the ONE shared unit box.
    for (let i = 0; i < batch.count; i++) {
      const o = i * 8;
      batch.items[o + 0] = px + (batch.items[o + 0] - px) * 2.1; // x
      batch.items[o + 1] *= 2.1;                                 // y (origin y = 0)
      batch.items[o + 2] = pz + (batch.items[o + 2] - pz) * 2.1; // z
      batch.items[o + 3] *= 2.1;
      batch.items[o + 4] *= 2.1;
      batch.items[o + 5] *= 2.1;
    }
    carBatches.push(batch);
    car.world = new THREE.Vector3(px, ROAD_TOP, pz);
    car.labelY = ROAD_TOP + LABEL_Y;
  }

  // ---- build everything
  let instanceCount = 0;
  for (const b of [sand, road, centerline, checker, ticks, curbs, pit, pitBoxes,
                   barriers, water, foam, salt, vegTrunk, vegA, vegB, vegC,
                   stand, boats, signs, lm, ...carBatches, glow]) {
    b.build(group);
    instanceCount += b.count;
  }

  // ---- camera fit box (production: whole island, road level at the top)
  const fitBox = new THREE.Box3(
    new THREE.Vector3(
      trackCenter.x - (groundSize.x + ISLAND_LIP) / 2,
      islandBottomY,
      trackCenter.z - (groundSize.z + ISLAND_LIP) / 2
    ),
    new THREE.Vector3(
      trackCenter.x + (groundSize.x + ISLAND_LIP) / 2,
      bbox.max.y,
      trackCenter.z + (groundSize.z + ISLAND_LIP) / 2
    )
  );

  // ---- minimap source (256 samples, same as the production client)
  const mapPoints = [];
  let mapMinX = Infinity, mapMaxX = -Infinity, mapMinZ = Infinity, mapMaxZ = -Infinity;
  for (let i = 0; i < 256; i++) {
    const p = curve.getPointAt(i / 256);
    mapPoints.push({ x: p.x, z: p.z });
    if (p.x < mapMinX) mapMinX = p.x;
    if (p.x > mapMaxX) mapMaxX = p.x;
    if (p.z < mapMinZ) mapMinZ = p.z;
    if (p.z > mapMaxZ) mapMaxZ = p.z;
  }

  return {
    group,
    cars: CARS.map((c) => ({ name: c.name, color: c.color, world: c.world, labelY: c.labelY })),
    trackCenter,
    size: gsize,
    fitBox,
    map: { points: mapPoints, min: { x: mapMinX, z: mapMinZ }, max: { x: mapMaxX, z: mapMaxZ } },
    waterCircles: def.water ?? [],
    startLine: { p: pointAt(0), t: tangentAt(0) },
    pit: pitInfo,
    palette: pal,
    def,
    lengthM,
    roadWidthM,
    pointAt,
    tangentAt,
    instanceCount
  };
}

/* =========================================================================
 * 6. Bloom chain — bright-pass -> quarter-res Gaussian -> additive
 *    composite (sRGB converted in the composite via the built-in
 *    colorspace_fragment chunk)
 * ======================================================================= */

const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FS = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float f = smoothstep(uThreshold - uKnee, uThreshold + uKnee, l);
  gl_FragColor = vec4(c.rgb * f, 1.0);
}
`;

const BLUR_FS = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture2D(tDiffuse, vUv + o1).rgb + texture2D(tDiffuse, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(tDiffuse, vUv + o2).rgb + texture2D(tDiffuse, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FS = /* glsl */`
uniform sampler2D tBase;
uniform sampler2D tBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tBase, vUv);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base.rgb + bloom * uStrength, 1.0);
  #include <colorspace_fragment>
}
`;

function makeQuadPass(fragmentShader, uniforms) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: QUAD_VS,
    fragmentShader,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, camera, mat };
}

/* =========================================================================
 * 7. Renderer, scene, lights, camera
 * ======================================================================= */

const ELEV0 = THREE.MathUtils.degToRad(35); // production camera elevation
const AUTO_ORBIT_RESUME_MS = 5000;
const AUTO_ORBIT_SPEED = 0.03; // rad/s

const _lv = new THREE.Vector3(); // label projection temp (no per-frame alloc)

let renderer, scene, camera, sun, world;
let rtScene, rtA, rtB;
let brightPass, blurHPass, blurVPass, compositePass;
let ready = false;
let trackSource = '';
let uiHidden = false;
const view = { az: 0, el: ELEV0, zoom: 1, target: null, auto: true };
let lastInteract = -Infinity;
let dragging = false;
let lastPX = 0, lastPY = 0;

function createRenderer() {
  const canvas = document.getElementById('scene');
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.setSize(window.innerWidth, window.innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.toneMapping = THREE.NoToneMapping; // linear pipeline; composite does sRGB
  r.info.autoReset = false;            // we reset per frame, stats = whole frame
  return r;
}

// NOTE: three r178's physically-based path divides light intensity by PI
// (verified with an isolated Lambert probe in vendor three.module.js), so
// intensities are expressed in legacy-equivalent units (value * PI).
let hemi = null;
function createLights(pal, trackCenter, size) {
  if (hemi) scene.remove(hemi);
  hemi = new THREE.HemisphereLight(
    new THREE.Color(pal.hemiSky),
    new THREE.Color(pal.hemiGround),
    pal.hemiIntensity
  );
  scene.add(hemi);
  const s = new THREE.DirectionalLight(new THREE.Color(pal.sun), pal.sunIntensity);
  // production shadow setup: cover the circuit, not the whole ground plane
  const spread = Math.max(size.x, size.z) + 60;
  s.position.set(trackCenter.x + spread * 0.45, 380, trackCenter.z + spread * 0.55);
  s.target.position.copy(trackCenter);
  scene.add(s, s.target);
  s.shadow.mapSize.set(2048, 2048);
  s.shadow.camera.near = 1;
  s.shadow.camera.far = 1500;
  s.shadow.camera.left = -spread;
  s.shadow.camera.right = spread;
  s.shadow.camera.top = spread;
  s.shadow.camera.bottom = -spread;
  s.shadow.bias = -0.0015;
  s.shadow.normalBias = 0.04;
  s.shadow.camera.updateProjectionMatrix(); // required after changing frustum bounds
  return s;
}

function createCamera(trackCenter, size) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000);
  const distance = (size.x + size.z) * 0.75 + 400; // production distance
  cam.near = 10;
  cam.far = distance + world.fitBox.getSize(new THREE.Vector3()).length() * 1.5 + 1000;
  cam.userData.distance = distance;
  cam.position.copy(trackCenter);
  cam.lookAt(trackCenter);
  return cam;
}

// Production fit: all 8 bbox corners inside the frustum, 5% breathing room.
const _fitCorner = new THREE.Vector3();
function fitCamera(bbox, aspect) {
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  let maxX = 1, maxY = 1;
  for (let i = 0; i < 8; i++) {
    _fitCorner.set(
      i & 1 ? bbox.max.x : bbox.min.x,
      i & 2 ? bbox.max.y : bbox.min.y,
      i & 4 ? bbox.max.z : bbox.min.z
    ).applyMatrix4(inv);
    maxX = Math.max(maxX, Math.abs(_fitCorner.x));
    maxY = Math.max(maxY, Math.abs(_fitCorner.y));
  }
  const halfH = Math.max(maxY, maxX / aspect) * 1.05;
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}

function applyView() {
  const R = camera.userData.distance;
  camera.position.set(
    view.target.x + R * Math.cos(view.el) * Math.sin(view.az),
    view.target.y + R * Math.sin(view.el),
    view.target.z + R * Math.cos(view.el) * Math.cos(view.az)
  );
  camera.lookAt(view.target);
  camera.zoom = view.zoom;
  camera.updateProjectionMatrix();
}

const PRESETS = {
  wide: {
    az: 0, el: ELEV0, zoom: 1, auto: true,
    target: () => world.trackCenter.clone()
  },
  cars: {
    az: THREE.MathUtils.degToRad(38), el: THREE.MathUtils.degToRad(30), zoom: 3.2, auto: false,
    // frame Tirewrecker + Slipstreamer from the inside of the start sweep
    target: () => world.cars[1].world.clone()
  },
  pit: {
    az: THREE.MathUtils.degToRad(35), el: THREE.MathUtils.degToRad(40), zoom: 2.7, auto: false,
    // frame the pit lane + entry beacons from between road edge and slab
    target: () => (world.pit ? world.pit.entryMid.clone() : world.trackCenter.clone())
  }
};

function setView(name) {
  const p = PRESETS[name] ?? PRESETS.wide;
  view.az = p.az;
  view.el = p.el;
  view.zoom = p.zoom;
  view.target = p.target();
  view.auto = p.auto;
  fitCamera(world.fitBox, window.innerWidth / window.innerHeight);
  applyView();
}

/* =========================================================================
 * 8. Targets, bloom passes, resize
 * ======================================================================= */

function createTargets() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const msaa = renderer.capabilities.isWebGL2 ? 4 : 0;
  const opts = (w, h, type, samples) => ({
    width: w, height: h, type, samples,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: samples > 0
  });
  rtScene = new THREE.WebGLRenderTarget(size.x, size.y,
    opts(size.x, size.y, THREE.HalfFloatType, msaa));
  const qw = Math.max(2, size.x >> 2);
  const qh = Math.max(2, size.y >> 2);
  rtA = new THREE.WebGLRenderTarget(qw, qh, opts(qw, qh, THREE.HalfFloatType, 0));
  rtB = new THREE.WebGLRenderTarget(qw, qh, opts(qw, qh, THREE.HalfFloatType, 0));

  brightPass = makeQuadPass(BRIGHT_FS, {
    tDiffuse: { value: null },
    // lit top-face luminance: sand ~1.0-1.06, white curb/foam/checker and
    // water glints ~1.2-1.35 — threshold sits between the two
    uThreshold: { value: 1.15 },
    uKnee: { value: 0.12 }
  });
  blurHPass = makeQuadPass(BLUR_FS, {
    tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() }
  });
  blurVPass = makeQuadPass(BLUR_FS, {
    tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() }
  });
  compositePass = makeQuadPass(COMPOSITE_FS, {
    tBase: { value: null },
    tBloom: { value: null },
    uStrength: { value: 0.5 }
  });
}

function resizeTargets() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  rtScene.setSize(size.x, size.y);
  rtA.setSize(Math.max(2, size.x >> 2), Math.max(2, size.y >> 2));
  rtB.setSize(Math.max(2, size.x >> 2), Math.max(2, size.y >> 2));
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  resizeTargets();
  fitCamera(world.fitBox, w / h);
  applyView();
}

function renderFrame() {
  renderer.info.reset();

  // 1. scene -> linear MSAA half-float target
  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);

  // 2. bright pass
  brightPass.mat.uniforms.tDiffuse.value = rtScene.texture;
  renderer.setRenderTarget(rtA);
  renderer.render(brightPass.scene, brightPass.camera);

  // 3. two blur iterations at 1/4 res, widening the kernel
  const bw = rtA.width, bh = rtA.height;
  const iters = [0.5, 1.2];
  let src = rtA, dst = rtB;
  for (const r of iters) {
    blurHPass.mat.uniforms.tDiffuse.value = src.texture;
    blurHPass.mat.uniforms.uDir.value.set(r / bw, 0);
    renderer.setRenderTarget(dst);
    renderer.render(blurHPass.scene, blurHPass.camera);

    blurVPass.mat.uniforms.tDiffuse.value = dst.texture;
    blurVPass.mat.uniforms.uDir.value.set(0, r / bh);
    renderer.setRenderTarget(src);
    renderer.render(blurVPass.scene, blurVPass.camera);
  }
  // (blur result ends in src; after even iterations that is rtA)

  // 4. additive composite to screen (sRGB conversion inside the shader)
  compositePass.mat.uniforms.tBase.value = rtScene.texture;
  compositePass.mat.uniforms.tBloom.value = rtA.texture;
  renderer.setRenderTarget(null);
  renderer.render(compositePass.scene, compositePass.camera);
}

/* =========================================================================
 * 9. Mock UI: minimap (drawn once), labels (projected)
 * ======================================================================= */

function drawMinimap() {
  const cv = document.getElementById('minimap');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 10;
  const { points, min, max } = world.map;
  const scale = Math.min(
    (W - 2 * pad) / (max.x - min.x),
    (H - 2 * pad) / (max.z - min.z)
  );
  const ox = (W - (max.x - min.x) * scale) / 2;
  const oz = (H - (max.z - min.z) * scale) / 2;
  const mx = (x) => (x - min.x) * scale + ox;
  const mz = (z) => (z - min.z) * scale + oz;

  ctx.fillStyle = '#0e1420';
  ctx.fillRect(0, 0, W, H);

  // lakes / salt pans
  for (const w of world.waterCircles) {
    ctx.beginPath();
    ctx.arc(mx(w.x), mz(w.z), w.r * scale, 0, Math.PI * 2);
    ctx.fillStyle = w.salt ? '#d9d2bc' : '#0fb9cf';
    ctx.fill();
  }

  // pit lane (under the circuit so the entry/exit links read as connections)
  if (world.pit?.pitPoints?.length) {
    ctx.beginPath();
    world.pit.pitPoints.forEach((p, i) => {
      if (i) ctx.lineTo(mx(p.x), mz(p.z));
      else ctx.moveTo(mx(p.x), mz(p.z));
    });
    ctx.strokeStyle = '#8b95ad';
    ctx.lineWidth = 3.5;
    ctx.stroke();
  }

  // circuit
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i) ctx.lineTo(mx(p.x), mz(p.z));
    else ctx.moveTo(mx(p.x), mz(p.z));
  });
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#262c3a';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = '#414a5e';
  ctx.lineWidth = 2;
  ctx.stroke();

  // start/finish tick
  const sl = world.startLine;
  const nx = -sl.t.z, nz = sl.t.x;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(mx(sl.p.x - nx * 7), mz(sl.p.z - nz * 7));
  ctx.lineTo(mx(sl.p.x + nx * 7), mz(sl.p.z + nz * 7));
  ctx.stroke();

  // cars
  for (const c of world.cars) {
    ctx.beginPath();
    ctx.arc(mx(c.world.x), mz(c.world.z), 4, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = '#0b0e13';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

let labelEls = [];
function createLabels() {
  const host = document.getElementById('labels');
  host.innerHTML = '';
  labelEls = world.cars.map((c) => {
    const el = document.createElement('div');
    el.className = 'car-label';
    el.textContent = c.name;
    el.style.borderColor = c.color;
    host.appendChild(el);
    return el;
  });
}

function updateLabels() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  for (let i = 0; i < world.cars.length; i++) {
    const c = world.cars[i];
    const el = labelEls[i];
    if (uiHidden) { el.style.display = 'none'; continue; }
    _lv.copy(c.world);
    _lv.y = c.labelY;
    _lv.project(camera);
    if (_lv.z > 1) { el.style.display = 'none'; continue; }
    el.style.display = 'block';
    el.style.left = `${(_lv.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-_lv.y * 0.5 + 0.5) * h}px`;
  }
}

/* =========================================================================
 * 10. Interaction (drag orbit, wheel zoom, auto-orbit)
 * ======================================================================= */

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function bindInteraction() {
  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    view.auto = false;
    lastPX = e.clientX;
    lastPY = e.clientY;
    lastInteract = performance.now();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    view.az -= (e.clientX - lastPX) * 0.005;
    view.el = clamp(view.el + (e.clientY - lastPY) * 0.004, 0.2, 1.35);
    lastPX = e.clientX;
    lastPY = e.clientY;
    lastInteract = performance.now();
    applyView();
  });
  const endDrag = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
    lastInteract = performance.now();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = clamp(view.zoom * Math.exp(-e.deltaY * 0.0012), 0.6, 9);
    lastInteract = performance.now();
    applyView();
  }, { passive: false });
}

/* =========================================================================
 * 11. Track switching + boot
 * ======================================================================= */

let currentTrackId = '';
let trackBusy = false;
let trackBtns = [];
let trackNameEl = null;

function disposeWorld() {
  if (world) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      // InstancedMesh: free instance buffers + material; the shared unit
      // box geometry must survive (every other mesh uses it).
      if (o.isInstancedMesh) { o.material.dispose(); o.dispose(); }
      else if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
    world = null;
  }
  if (hemi) { scene.remove(hemi); hemi = null; }
  if (sun) { scene.remove(sun, sun.target); sun = null; }
}

function applyWorld(def, source) {
  const pal = makePalette(def);
  disposeWorld();
  scene.background = new THREE.Color(pal.sky);
  world = buildVoxelWorld(def);
  scene.add(world.group);
  sun = createLights(pal, world.trackCenter, world.size);
  camera = createCamera(world.trackCenter, world.size);
  view.zoom = 1;
  view.auto = true;
  view.target = world.trackCenter.clone();
  fitCamera(world.fitBox, window.innerWidth / window.innerHeight);
  applyView();
  createLabels();
  drawMinimap();
  trackSource = source;
  console.info(`[voxel-sandbox] track: ${def.id ?? '?'} — ${def.name} (${source})`);
  console.info(`[voxel-sandbox] voxel instances: ${world.instanceCount}`);
}

async function fetchTrackDef(entry) {
  try {
    const res = await fetch(entry.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { def: await res.json(), source: `live: ${entry.url.split('/').pop()}` };
  } catch (err) {
    if (entry.embedded) {
      return { def: entry.embedded, source: `embedded snapshot (${err.message})` };
    }
    throw err;
  }
}

function setTrackActive(id) {
  for (const b of trackBtns) b.classList.toggle('active', b.dataset.track === id);
}

async function selectTrack(id) {
  if (trackBusy || id === currentTrackId) return;
  const entry = TRACK_LIST.find((t) => t.id === id);
  if (!entry) return;
  trackBusy = true;
  setTrackActive(id);
  try {
    const { def, source } = await fetchTrackDef(entry);
    currentTrackId = id;
    applyWorld(def, source);
    if (trackNameEl) trackNameEl.textContent = def.name;
  } catch (err) {
    console.error(`[voxel-sandbox] failed to load track "${id}"`, err);
  } finally {
    trackBusy = false;
  }
}

(async function boot() {
  renderer = createRenderer();
  scene = new THREE.Scene();

  // ---- track style selector (five F1 circuit styles + v1 reference)
  const selectEl = document.getElementById('track-select');
  trackNameEl = document.getElementById('track-line'); // HUD track line
  for (const t of TRACK_LIST) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ts-btn';
    b.dataset.track = t.id;
    b.textContent = t.name;
    b.addEventListener('click', () => selectTrack(t.id));
    selectEl.appendChild(b);
    trackBtns.push(b);
  }

  bindInteraction();
  createTargets();

  // first track: default is the first in TRACK_LIST; if a fetch fails the
  // page falls through the list so it always boots to something.
  const first = await (async () => {
    for (const t of TRACK_LIST) {
      try {
        setTrackActive(t.id);
        const r = await fetchTrackDef(t);
        return { t, def: r.def, source: r.source };
      } catch (err) { /* try the next style */ }
    }
    throw new Error('no track data available');
  })();
  currentTrackId = first.t.id;
  if (trackNameEl) trackNameEl.textContent = first.def.name;
  applyWorld(first.def, first.source);
  window.addEventListener('resize', onResize);

  // ---- main loop
  let lastT = performance.now();
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (view.auto) {
      view.az += dt * AUTO_ORBIT_SPEED;
      applyView();
    } else if (!dragging && now - lastInteract > AUTO_ORBIT_RESUME_MS) {
      view.auto = true;
    }
    renderFrame();
    updateLabels();
  }
  requestAnimationFrame(tick);

  ready = true;
  console.info(`[voxel-sandbox] track source: ${trackSource}`);
  console.info(`[voxel-sandbox] voxel instances: ${world.instanceCount}`);
  console.info(
    `[voxel-sandbox] render calls after first frame: ` +
    `${renderer.info.render.calls} (instanced)`
  );

  // screenshot / review API
  window.__voxelSandbox = {
    get ready() { return ready; },
    get source() { return trackSource; },
    get current() { return currentTrackId; },
    tracks: TRACK_LIST.map((t) => ({ id: t.id, name: t.name })),
    setTrack(id) { return selectTrack(id); },
    get world() { return world; },
    setView,
    setUiVisible(v) {
      uiHidden = !v;
      document.body.classList.toggle('ui-hidden', !v);
    },
    setOrbit({ azDeg, elDeg, zoom, tx, tz } = {}) {
      if (azDeg != null) view.az = THREE.MathUtils.degToRad(azDeg);
      if (elDeg != null) view.el = THREE.MathUtils.degToRad(elDeg);
      if (zoom != null) view.zoom = zoom;
      if (tx != null || tz != null) {
        view.target.x = tx ?? view.target.x;
        view.target.z = tz ?? view.target.z;
      }
      view.auto = false;
      fitCamera(world.fitBox, window.innerWidth / window.innerHeight);
      applyView();
    },
    stopOrbit() { view.auto = false; },
    renderOnce() {
      renderFrame();
      updateLabels();
    },
    getStats() {
      return {
        instances: world.instanceCount,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles
      };
    },
    // review handles (not part of the game API)
    get scene() { return scene; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    screenPos(x, y, z) {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return [
        Math.round((v.x * 0.5 + 0.5) * renderer.domElement.clientWidth),
        Math.round((-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight)
      ];
    },
    // debug: what does the ray through pixel (px,py) hit first?
    rayPixel(px, py) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(
        new THREE.Vector2((px / renderer.domElement.clientWidth) * 2 - 1, -(py / renderer.domElement.clientHeight) * 2 + 1),
        camera
      );
      return rc.intersectObject(world.group, true).slice(0, 5).map((h) => ({
        name: h.object.name || h.object.type,
        dist: +h.distance.toFixed(1),
        pt: [ +h.point.x.toFixed(1), +h.point.y.toFixed(2), +h.point.z.toFixed(1) ],
        instId: h.instanceId ?? null
      }));
    }
  };
})().catch((err) => {
  console.error('[voxel-sandbox] boot failed', err);
  window.__voxelSandbox = { ready: false, error: String(err) };
});
