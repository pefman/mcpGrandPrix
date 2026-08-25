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
  constructor(name, { cast = false, receive = true } = {}) {
    this.name = name;
    this.cast = cast;
    this.receive = receive;
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
    const mesh = new THREE.InstancedMesh(
      unitBox,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      this.count
    );
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

/**
 * Build the whole voxel world for a track def. Returns
 * { group, cars, trackCenter, fitBox, size, map, waterCircles, startLine,
 *   instanceCount }.
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

  const rng = createRng(7); // tone picking (visual only, fixed seed)
  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];
  const sandC = PAL.sand.map((h) => new THREE.Color(h));
  const roadC = PAL.road.map((h) => new THREE.Color(h));
  const waterC = PAL.water.map((h) => new THREE.Color(h));
  const glintC = new THREE.Color(PAL.waterGlint);
  const foamC = new THREE.Color(PAL.foam);
  const pitC = PAL.pit.map((h) => new THREE.Color(h));
  const cCurbRed = new THREE.Color(PAL.curbRed);
  const cCurbWhite = new THREE.Color(PAL.curbWhite);
  const cBarRed = new THREE.Color(PAL.barrierRed);
  const cBarWhite = new THREE.Color(PAL.barrierWhite);
  const cLine = new THREE.Color(PAL.lineWhite);
  const cCheckW = new THREE.Color(PAL.checkerW);
  const cCheckD = new THREE.Color(PAL.checkerD);
  const cPitBox = new THREE.Color(PAL.pitBox);
  const cPitWall = new THREE.Color(PAL.pitWall);
  const cTrunk = new THREE.Color(PAL.trunk);
  const cLeaf = PAL.leaf.map((h) => new THREE.Color(h));
  const cStandBase = new THREE.Color(PAL.standBase);
  const cStandStep = new THREE.Color(PAL.standStep);
  const cStandRoof = new THREE.Color(PAL.standRoof);
  const cStandPost = new THREE.Color(PAL.standPost);
  const cAccent = new THREE.Color(PAL.accent);
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

  // ---- pit lane + boxes (inside of the start straight)
  const pit = new VoxelBatch('pit-lane');
  const pitBoxes = new VoxelBatch('pit-boxes', { cast: true });
  {
    const pitOffset = -20;
    const rows = 32;
    const step = (95 - 15) / rows;
    for (let i = 0; i < rows; i++) {
      const s = 15 + i * step;
      const p = pointAt(s);
      const t = tangentAt(s);
      const yaw = Math.atan2(t.x, t.z);
      for (let c = 0; c < 2; c++) {
        const off = pitOffset + (c - 0.5) * 2.5;
        pit.add(p.x - t.z * off, PIT_TOP - PIT_H / 2, p.z + t.x * off, 2.5, PIT_H, 2.5, pick(pitC), yaw);
      }
    }
    for (const s of [35, 55, 75]) {
      const p = pointAt(s);
      const t = tangentAt(s);
      const yaw = Math.atan2(t.x, t.z);
      addAt(pitBoxes, p.x, p.z, yaw, 0, PIT_TOP + 0.25, -20, 6, 0.5, 5, cPitBox);
      addAt(pitBoxes, p.x, p.z, yaw, 0, 1.0, -24.5, 6.5, 2.4, 1.2, cPitWall);
    }
  }

  // ---- barriers (dark base slab + red/white top cube, full circuit).
  // The base reaches the sand so the wall reads solid from any angle.
  const barriers = new VoxelBatch('barriers', { cast: true });
  if (theme.barriers) {
    const off = roadWidthM / 2 + 3;
    const step = lengthM / N_BARRIERS;
    const cBase = new THREE.Color('#2b3040');
    for (let i = 0; i < N_BARRIERS; i++) {
      const s = i * step;
      const p = pointAt(s);
      const t = tangentAt(s);
      const yaw = Math.atan2(t.x, t.z);
      const bx = p.x - t.z * off;
      const bz = p.z + t.x * off;
      barriers.add(bx, GROUND_TOP + BARRIER_H / 2, bz, step + 0.05, BARRIER_H, step + 0.05, cBase, yaw);
      barriers.add(bx, BARRIER_H / 2, bz, step + 0.05, BARRIER_H, step + 0.05, i % 2 === 0 ? cBarRed : cBarWhite, yaw);
    }
  }

  // ---- lake (cube grid clipped to the circle) + bright foam edge
  const water = new VoxelBatch('water');
  const foam = new VoxelBatch('foam');
  {
    const circles = def.water ?? [];
    if (circles.length) {
      const x0 = Math.floor((trackCenter.x - groundSize.x / 2) / TILE);
      const x1 = Math.ceil((trackCenter.x + groundSize.x / 2) / TILE);
      const z0 = Math.floor((trackCenter.z - groundSize.z / 2) / TILE);
      const z1 = Math.ceil((trackCenter.z + groundSize.z / 2) / TILE);
      const t = TILE - TILE_GAP;
      for (const w of circles) {
        for (let gx = x0; gx < x1; gx++) {
          for (let gz = z0; gz < z1; gz++) {
            const cx = (gx + 0.5) * TILE;
            const cz = (gz + 0.5) * TILE;
            const d = Math.hypot(cx - w.x, cz - w.z);
            if (d < w.r - 3) {
              const color = rng.next() < 0.06 ? glintC : pick(waterC);
              water.add(cx, WATER_TOP - WATER_H / 2, cz, t, WATER_H, t, color);
            } else if (d < w.r) {
              foam.add(cx, FOAM_TOP - FOAM_H / 2, cz, t, FOAM_H, t, foamC);
            }
          }
        }
      }
    }
  }

  // ---- palms: hand-placed + seeded scatter (identical placement to the
  // production client: scatter rng = seed 11, height rng = seed 99 drawn in
  // props-array order — the only rng consumer on this track)
  const palmTrunk = new VoxelBatch('palm-trunks', { cast: true });
  const crownA = new VoxelBatch('palm-crown-a', { cast: true });
  const crownB = new VoxelBatch('palm-crown-b', { cast: true });
  const crownC = new VoxelBatch('palm-crown-c', { cast: true });
  {
    const samples = [];
    for (let i = 0; i < 160; i++) {
      const p = curve.getPointAt(i / 160);
      samples.push({ x: p.x, z: p.z });
    }
    const all = (def.props ?? []).concat(
      scatterProps(def, samples, roadWidthM, def.water ?? [])
    );
    const palms = all.filter((p) => p.type === 'palm');
    const rngH = createRng(99);
    for (const p of palms) {
      const h = rngH.int(6, 9);
      const y = GROUND_TOP;
      palmTrunk.add(p.x, y + h / 2, p.z, 1.2, h, 1.2, cTrunk);
      crownA.add(p.x, y + h + 0.2, p.z, 7, 1.2, 2.6, cLeaf[0]);
      crownB.add(p.x, y + h + 0.2, p.z, 2.6, 1.2, 7, cLeaf[1]);
      crownC.add(p.x, y + h + 1.2, p.z, 4.4, 1, 4.4, cLeaf[2]);
    }
  }

  // ---- grandstand (production geometry, vibrant tones + accent trim)
  const stand = new VoxelBatch('grandstand', { cast: true });
  {
    const p = (def.props ?? []).find((q) => q.type === 'grandstand');
    if (p) {
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
    for (const p of def.props ?? []) {
      if (p.type !== 'sign') continue;
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
                   barriers, water, foam, palmTrunk, crownA, crownB, crownC,
                   stand, boats, signs, ...carBatches]) {
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
function createLights(trackCenter, size) {
  scene.add(new THREE.HemisphereLight(
    new THREE.Color(PAL.hemiSky),
    new THREE.Color(PAL.hemiGround),
    0.75 * Math.PI
  ));
  const s = new THREE.DirectionalLight(new THREE.Color(PAL.sun), 1.0 * Math.PI);
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

  // lake
  for (const w of world.waterCircles) {
    ctx.beginPath();
    ctx.arc(mx(w.x), mz(w.z), w.r * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#0fb9cf';
    ctx.fill();
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
 * 11. Boot
 * ======================================================================= */

(async function boot() {
  // ---- track def: live file first, embedded snapshot as fallback
  let def;
  try {
    const res = await fetch(TRACK_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    def = await res.json();
    trackSource = 'live: tracks/coastal-palm.json';
  } catch (err) {
    def = EMBEDDED_TRACK;
    trackSource = `embedded snapshot (${err.message})`;
  }

  renderer = createRenderer();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.sky);

  world = buildVoxelWorld(def);
  scene.add(world.group);
  sun = createLights(world.trackCenter, world.size);
  camera = createCamera(world.trackCenter, world.size);

  view.target = world.trackCenter.clone();
  createTargets();
  fitCamera(world.fitBox, window.innerWidth / window.innerHeight);
  applyView();
  bindInteraction();
  createLabels();
  drawMinimap();
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
    source: trackSource,
    world,
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
    }
  };
})().catch((err) => {
  console.error('[voxel-sandbox] boot failed', err);
  window.__voxelSandbox = { ready: false, error: String(err) };
});
