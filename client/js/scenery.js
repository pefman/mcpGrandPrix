/**
 * Voxel circuit scenery (MCPG-64) — the art direction from
 * client/design/reference/f1-track.html, generalized so every map drives
 * it from data (tracks/*.json stay pure data; zero per-map code).
 *
 * Everything voxel goes into ONE InstancedMesh (shared unit-box geometry,
 * per-instance color, Y rotation) — the reference's performance contract.
 * Only the animated start-gantry lights are separate meshes (they need
 * per-light emissive materials).
 *
 * Map-driven optional fields (all tolerate absence / unknown shapes):
 *
 *   "scenery": {
 *     "version": 1,
 *     "island":  { "marginM": 70 },                  // island footprint auto from bbox
 *     "garages": 8,                                  // pit garage count
 *     "stands":     [{ "atS": 40, "arcM": 90, "side": 1 }],
 *     "tireWalls":  [{ "atS": 210, "count": 6 }],    // omit -> auto apex detection
 *     "drs":        [{ "atS": 60,  "side": -1 }],    // omit -> auto
 *     "floodlights":[{ "x": -100, "z": -160 }],      // omit -> island corners
 *     "scatterExclusions": [[x, z, r]]               // keep scatter props out of zones
 *   }
 *
 * A map with no `scenery` field renders the full baseline (voxel grass
 * island, two-tone asphalt treatment, start gantry + grid boxes, pit
 * garages + crew, auto tire walls / DRS boards / floodlights) and simply
 * skips the pieces that need explicit placement. Unknown fields are
 * ignored (forward-compatible per the track contract).
 */
import * as THREE from 'three';
import { createRng } from './rng.js';

// ---- palette (reference values; themes re-tint what is map-specific) ----
const C = {
  rumble: 0xbfc3c9,
  dash: 0xf2f2f2,
  gridSlot: 0xf2f2f2,
  barrierWhite: 0xe8e8ea,
  barrierRed: 0xff2d1f,
  tireDark: 0x1c1e22,
  tireWhite: 0xd8dade,
  garageApron: 0xbfc3c9,
  garageWallA: 0xe8e8ea,
  garageWallB: 0xd8dade,
  garageRoof: 0x2b2e33,
  garagePillar: 0x55585e,
  roofStripeRed: 0xff2d1f,
  roofStripeWhite: 0xe8e8ea,
  crewShirts: [0xff2d1f, 0x1a56c4, 0xf2c53f],
  crewHead: 0xf2c53f,
  standSeat: [0xe84a3f, 0x3f7fe8, 0xf2c53f, 0x49c15b, 0xf2f2f2],
  standStepA: 0xd8d8dc,
  standStepB: 0xbfc3c9,
  standFascia: 0x3a3e44,
  standPost: 0x55585e,
  drsPole: 0x9aa0a8,
  drsPanel: 0x1a56c4,
  drsStripe: 0xf2f2f2,
  floodPole: 0x9aa0a8,
  floodLamp: 0xfffbe0,
  gantryPillar: 0x2b2e33,
  gantryBeam: 0x22252a,
  gantryBand: 0xe8412f,
};

const GRASS_TOP_Y = -0.5; // island surface, below the road ribbon (y = 0)
const ISLAND_CELL = 12;   // grass/dirt grid step (m)
const ROCK_CELL = 18;     // deep rock keel step (m)
const GANTRY_CYCLE_MS = 6000;

/** theme hex string -> int (tolerates numbers, falls back safely). */
function hex(c, fallback) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) return new THREE.Color(c).getHex();
  return fallback;
}

/**
 * Normalize a track def's optional `scenery` block into concrete values.
 * Pure data-in/data-out (unit-tested without THREE).
 */
export function resolveScenery(def = {}) {
  const sc = def.scenery && typeof def.scenery === 'object' ? def.scenery : {};
  const list = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    version: sc.version ?? 1,
    island: sc.island && typeof sc.island === 'object'
      ? { marginM: num(sc.island.marginM) ?? 85 }
      : { marginM: 85 },
    garages: num(sc.garages) ?? 8,
    stands: list(sc.stands),
    tireWalls: list(sc.tireWalls),
    drs: list(sc.drs),
    floodlights: list(sc.floodlights),
    // scatter exclusion zones may also come from the legacy scatter block
    scatterExclusions: list(sc.scatterExclusions) ?? list(def.scatter?.exclusions) ?? [],
  };
}

/** Collects voxels and bakes them into one InstancedMesh. */
class VoxelBatch {
  constructor() {
    this.items = [];
  }

  add(px, py, pz, sx, sy, sz, color, ry = 0) {
    this.items.push({ px, py, pz, sx, sy, sz, color, ry });
  }

  build() {
    const inst = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      this.items.length,
    );
    inst.castShadow = true;
    inst.receiveShadow = true;
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    this.items.forEach((v, i) => {
      eul.set(0, v.ry, 0);
      q.setFromEuler(eul);
      mtx.compose(new THREE.Vector3(v.px, v.py, v.pz), q, new THREE.Vector3(v.sx, v.sy, v.sz));
      inst.setMatrixAt(i, mtx);
      inst.setColorAt(i, col.setHex(v.color));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    return inst;
  }
}

/**
 * Build the full voxel scenery layer for a track.
 * @returns {{ group, update, island, pitSlots, stats, dispose }}
 */
export function buildScenery({ curve, arclen, lengthM, roadWidthM, theme, scenery }) {
  const N = 520;
  const pts = [];
  const tans = [];
  for (let i = 0; i < N; i++) {
    pts.push(curve.getPointAt(i / N));
    tans.push(curve.getTangentAt(i / N));
  }
  const segLen = (arclen / N) * 1.08; // slight overlap: no hairline gaps
  // lateral normal, same convention as the road ribbons in track.js
  const normals = tans.map((t) => new THREE.Vector3(-t.z, 0, t.x));
  const rys = tans.map((t) => Math.atan2(t.x, t.z) + Math.PI / 2);
  // curvature (rad/m) across a +-2 sample window
  const curv = [];
  for (let i = 0; i < N; i++) {
    const a = tans[(i - 2 + N) % N];
    const b = tans[(i + 2) % N];
    const ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    curv.push(ang / ((4 / N) * arclen));
  }
  // sign of the turn: crossY < 0 means the corner's INSIDE is on the +n side
  const insideSide = (i) => {
    const a = tans[(i - 2 + N) % N];
    const b = tans[(i + 2) % N];
    return Math.sign(a.z * b.x - a.x * b.z) < 0 ? 1 : -1;
  };
  const at = (s) => (((s % lengthM) + lengthM) % lengthM) / arclen;
  const distToTrack = (x, z) => {
    let d2 = Infinity;
    for (let i = 0; i < N; i += 4) {
      const dx = pts[i].x - x;
      const dz = pts[i].z - z;
      if (dx * dx + dz * dz < d2) d2 = dx * dx + dz * dz;
    }
    return Math.sqrt(d2);
  };
  /** side (+1/-1) whose offset moves AWAY from the island center */
  const outsideSide = (i) => {
    const px = pts[i].x + normals[i].x * 40;
    const pz = pts[i].z + normals[i].z * 40;
    const qx = pts[i].x - normals[i].x * 40;
    const qz = pts[i].z - normals[i].z * 40;
    const rp = ((px - cx) / rx) ** 2 + ((pz - cz) / rz) ** 2;
    const rq = ((qx - cx) / rx) ** 2 + ((qz - cz) / rz) ** 2;
    return rp >= rq ? 1 : -1;
  };

  const voxels = new VoxelBatch();
  const rng = createRng(424242);

  // ---------- island footprint ----------
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const rx = (maxX - minX) / 2 + scenery.island.marginM;
  const rz = (maxZ - minZ) / 2 + scenery.island.marginM;
  const inIsland = (x, z, f = 1) => {
    const dx = (x - cx) / (rx * f);
    const dz = (z - cz) / (rz * f);
    return dx * dx + dz * dz <= 1;
  };

  // ---- floating voxel island: two-tone top, dirt skirt, rock keel ----
  // Two top tones: the darker of (base, spot) + patch — themes disagree on
  // which of base/spot is the shading variant (night themes lighten "spot")
  const baseCol = new THREE.Color(hex(theme.ground.base, 0x58b649));
  const spotCol = new THREE.Color(hex(theme.ground.spot, 0x63cc2f));
  const hsl = { h: 0, s: 0, l: 0 };
  const toneA = (spotCol.getHSL(hsl).l < baseCol.getHSL(hsl).l ? spotCol : baseCol).getHex();
  const toneB = hex(theme.ground.patch, 0x5dbb2a);
  const dirtC = baseCol.clone().offsetHSL(0, 0.02, -0.14).getHex();
  const rockC = baseCol.clone().offsetHSL(0, 0.05, -0.32).getHex();

  for (let gx = cx - rx; gx <= cx + rx; gx += ISLAND_CELL) {
    for (let gz = cz - rz; gz <= cz + rz; gz += ISLAND_CELL) {
      const x = gx + ISLAND_CELL / 2;
      const z = gz + ISLAND_CELL / 2;
      if (!inIsland(x, z)) continue;
      // cells overlap by a hair: flush-but-gapped columns alias to black
      // vertical seams at the 1/4-res pixelated buffer (MCPG-64 finding)
      const cell = ISLAND_CELL + 0.05;
      voxels.add(x, GRASS_TOP_Y - 0.4, z, cell, 0.8, cell, rng.next() < 0.5 ? toneA : toneB);
      // dirt skirt: only the outer ring is visible (interior cells are
      // covered by grass above and neighbors beside) — perf: ~40% fewer
      // voxels for a zero-visual-change cut
      if (!inIsland(x, z, 0.90)) {
        voxels.add(x, -5.2, z, cell, 7.8, cell, dirtC);
      }
      if (!inIsland(x, z, 0.94)) {
        const j = rng.next();
        voxels.add(
          x + (rng.next() - 0.5) * 3, GRASS_TOP_Y - 1.3 - j * 1.5, z + (rng.next() - 0.5) * 3,
          ISLAND_CELL - 0.4, 2.2 + j * 2, ISLAND_CELL - 0.4,
          rng.next() < 0.5 ? toneA : toneB,
        );
      }
    }
  }
  let islandBottomY = -18;
  for (let gx = cx - rx; gx <= cx + rx; gx += ROCK_CELL) {
    for (let gz = cz - rz; gz <= cz + rz; gz += ROCK_CELL) {
      const x = gx + ROCK_CELL / 2;
      const z = gz + ROCK_CELL / 2;
      const r = ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2;
      if (r >= 0.92) continue;
      const depth = (1 - Math.sqrt(Math.max(0, r))) * 38 * (0.75 + rng.next() * 0.5);
      const h = depth + 10;
      const v = rng.next();
      const c = v < 0.12 ? 0x9aa0a8 : v < 0.3 ? 0x6e4423 : rockC;
      voxels.add(x, -9.1 - h / 2, z, ROCK_CELL + 4, h, ROCK_CELL + 4, c);
      islandBottomY = Math.min(islandBottomY, -9.1 - h);
      if (rng.next() < 0.09) {
        const bx = x + (rng.next() - 0.5) * 10;
        const bz = z + (rng.next() - 0.5) * 10;
        voxels.add(bx, -15.5 - h, bz, 5, 9, 5, 0x7a4f28);
        islandBottomY = Math.min(islandBottomY, -20 - h);
      }
    }
  }

  // ---- road dressing: outer rumble pads + center dash markings ----
  for (let i = 0; i < N; i += 6) {
    const off = roadWidthM / 2 + 2.4;
    for (const side of [-1, 1]) {
      voxels.add(
        pts[i].x + normals[i].x * side * off, -0.25, pts[i].z + normals[i].z * side * off,
        segLen * 6, 0.5, 1, C.rumble, rys[i],
      );
    }
  }
  for (let i = 0; i < N; i += 4) {
    voxels.add(pts[i].x, 0.65, pts[i].z, segLen * 1.6, 0.06, 0.35, C.dash, rys[i]);
  }

  // ---- red/white barriers (skip curve insides + tight passes) ----
  if (theme.barriers) {
    for (let i = 0; i < N; i += 2) {
      for (const side of [-1, 1]) {
        // run-off area: no barrier on the INSIDE of sharp corners (reference rule)
        if (curv[i] > 0.027 && side === insideSide(i)) continue;
        const bx = pts[i].x + normals[i].x * side * (roadWidthM / 2 + 9);
        const bz = pts[i].z + normals[i].z * side * (roadWidthM / 2 + 9);
        if (distToTrack(bx, bz) < 8) continue;
        voxels.add(
          bx, 1.1, bz, segLen * 4.6, 2.2, 0.7,
          i % 36 < 18 ? C.barrierWhite : C.barrierRed, rys[i],
        );
      }
    }
  }

  // ---- grid boxes behind the start line ----
  {
    const st = curve.getTangentAt(0);
    const sn = new THREE.Vector3(-st.z, 0, st.x);
    const sry = rys[0];
    for (let k = 0; k < 8; k++) {
      const gp = curve.getPointAt(at(lengthM - 28 - k * 8));
      for (const off of [-3.25, 3.25]) {
        voxels.add(gp.x + sn.x * off, 0.62, gp.z + sn.z * off, 4.5, 0.1, 2.4, C.gridSlot, sry);
      }
    }
  }

  // ---- pit garages, slot markings, crew ----
  const pitSlots = [];
  {
    const G = Math.max(2, Math.min(12, scenery.garages));
    for (let gi = 0; gi < G; gi++) {
      const s = 15 + ((gi + 0.5) * 80) / G; // lane span hardcoded in track.js ([15, 95])
      const u = at(s);
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      const n = new THREE.Vector3(-t.z, 0, t.x);
      const ry = rys[Math.min(N - 1, Math.round(u * N))];
      const lane = p.clone().addScaledVector(n, -20);
      pitSlots.push({ s, pos: lane.clone(), tangent: t.clone() });
      // white slot stripe on the lane
      voxels.add(lane.x, 0.62, lane.z, 13, 0.06, 2.2, C.gridSlot, ry);
      // garage shell behind the lane (further inside the circuit)
      const g = p.clone().addScaledVector(n, -32);
      voxels.add(g.x, GRASS_TOP_Y + 0.25, g.z, 15, 0.5, 12, C.garageApron, ry);
      voxels.add(g.x, 2.05, g.z, 15, 4.4, 0.9, gi % 2 ? C.garageWallA : C.garageWallB, ry);
      for (const px of [-6.5, 6.5]) {
        for (const pz of [-5.2, 5.2]) {
          voxels.add(g.x + t.x * px + n.x * pz, 3.2, g.z + t.z * px + n.z * pz, 1, 6.4, 1, C.garagePillar, ry);
        }
      }
      const roof = p.clone().addScaledVector(n, -30);
      voxels.add(roof.x, 6.7, roof.z, 16.4, 0.8, 13, C.garageRoof, ry);
      voxels.add(roof.x, 7.4, roof.z, 16.4, 0.6, 1.2, gi % 2 ? C.roofStripeRed : C.roofStripeWhite, ry);
      // pit crew trio between the lane and the garages
      for (let m = 0; m < 3; m++) {
        const mp = p.clone().addScaledVector(n, -24.5).addScaledVector(t, -4 + m * 4);
        voxels.add(mp.x, GRASS_TOP_Y + 1, mp.z, 0.9, 2, 0.9, C.crewShirts[m], ry);
        voxels.add(mp.x, GRASS_TOP_Y + 2.25, mp.z, 0.7, 0.7, 0.7, C.crewHead, ry);
      }
    }
  }

  // ---- curved grandstands with colored seat voxels ----
  const buildStand = (sMid, arcM, side) => {
    const rows = 7;
    const step = 2;
    const nSteps = Math.max(4, Math.floor(arcM / step));
    for (let r = 0; r < rows; r++) {
      for (let si = 0; si <= nSteps; si++) {
        const u = at(sMid + (si * step - arcM / 2));
        const p = curve.getPointAt(u);
        const t = curve.getTangentAt(u);
        const n = new THREE.Vector3(-t.z, 0, t.x);
        const ry = Math.atan2(t.x, t.z) + Math.PI / 2;
        const d = roadWidthM / 2 + 11 + r * 1.9;
        const x = p.x + n.x * side * d;
        const z = p.z + n.z * side * d;
        const h = 1.4 + r * 1.2;
        voxels.add(x, h / 2, z, step * 0.95, h, 1.9, r % 2 ? C.standStepA : C.standStepB, ry);
        if (rng.next() < 0.7) {
          voxels.add(x, h + 0.5, z, 1.1, 1.1, 1.1, C.standSeat[Math.floor(rng.next() * C.standSeat.length)], ry);
        }
      }
    }
    const cd = roadWidthM / 2 + 11 + ((rows - 1) * 1.9) / 2;
    for (let si = 0; si <= nSteps; si++) {
      const u = at(sMid + (si * step - arcM / 2));
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      const n = new THREE.Vector3(-t.z, 0, t.x);
      const ry = Math.atan2(t.x, t.z) + Math.PI / 2;
      // open-air terraces: from the spectator's high angle a roof slab would
      // hide the seats (the reference's orbit camera looks under it, ours
      // looks down on it) — a light back rail + posts keep the silhouette
      const x = p.x + n.x * side * cd;
      const z = p.z + n.z * side * cd;
      voxels.add(x, 8.2, z, step * 1.7, 0.5, 1.2, C.standFascia, ry);
      if (si % 6 === 0) {
        voxels.add(p.x + n.x * side * (roadWidthM / 2 + 10), 4, p.z + n.z * side * (roadWidthM / 2 + 10), 1, 8, 1, C.standPost, ry);
      }
    }
  };
  if (scenery.stands) {
    for (const st of scenery.stands) {
      if (!Number.isFinite(st.atS)) continue;
      const side = Number.isFinite(st.side) ? (st.side < 0 ? -1 : 1) : outsideSide(Math.round(at(st.atS) * N) % N);
      buildStand(st.atS, Number.isFinite(st.arcM) ? st.arcM : 70, side);
    }
  } else {
    // auto: main straight + the sharpest apex + one mid-lap point
    let hotI = Math.round(N * 0.3);
    for (let i = 0; i < N; i++) if (curv[i] > curv[hotI] && i > 40 && i < N - 40) hotI = i;
    buildStand(30, 90, outsideSide(Math.round(at(30) * N)));
    buildStand((hotI / N) * arclen, 55, outsideSide(hotI));
    buildStand(lengthM * 0.62, 60, outsideSide(Math.round(at(lengthM * 0.62) * N)));
  }

  // ---- apex tire walls (outside of corners) ----
  const tireWallAt = (s, count) => {
    const u = at(s);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    const t2 = curve.getTangentAt((u + 0.02) % 1);
    const side = Math.sign(t.z * t2.x - t.x * t2.z) < 0 ? -1 : 1;
    const n = new THREE.Vector3(-t.z, 0, t.x);
    const ry = Math.atan2(t.x, t.z) + Math.PI / 2;
    for (let k = 0; k < count; k++) {
      const x = p.x + n.x * side * (roadWidthM / 2 + 11 + k * 2.2);
      const z = p.z + n.z * side * (roadWidthM / 2 + 11 + k * 2.2);
      for (let hgt = 0; hgt < 2 + (k % 2); hgt++) {
        voxels.add(x, 0.55 + hgt * 1.4, z, 2, 1.3, 3.4, k % 2 ? C.tireDark : C.tireWhite, ry);
      }
    }
  };
  if (scenery.tireWalls) {
    for (const tw of scenery.tireWalls) {
      if (!Number.isFinite(tw.atS)) continue;
      tireWallAt(tw.atS, Math.max(2, Math.min(10, tw.count ?? 5)));
    }
  } else {
    // auto: strongest curvature peaks, >=60 m apart, capped at 5 walls
    const minGap = (60 / lengthM) * N;
    const peaks = [];
    for (let i = 0; i < N; i++) {
      if (curv[i] < 0.05) continue;
      let near = -1;
      for (let k = 0; k < peaks.length; k++) {
        if (Math.abs(peaks[k] - i) < minGap) { near = k; break; }
      }
      if (near === -1) peaks.push(i);
      else if (curv[i] > curv[peaks[near]]) peaks[near] = i;
    }
    peaks.sort((a, b) => curv[b] - curv[a]);
    for (const i of peaks.slice(0, 5)) tireWallAt((i / N) * arclen, 5 + (i % 2));
  }

  // ---- DRS boards ----
  const drsBoard = (s, side) => {
    const u = at(s);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    const n = new THREE.Vector3(-t.z, 0, t.x);
    const ry = Math.atan2(t.x, t.z) + Math.PI / 2;
    const base = p.clone().addScaledVector(n, side * (roadWidthM / 2 + 9));
    voxels.add(base.x, 4, base.z, 1.0, 8, 1.0, C.drsPole, ry);
    voxels.add(base.x, 9, base.z, 1.0, 3, 10, C.drsPanel, ry);
    const stripe = base.clone().addScaledVector(n, -side * 0.6);
    voxels.add(stripe.x, 9, stripe.z, 0.7, 1, 6, C.drsStripe, ry);
  };
  if (scenery.drs) {
    for (const d of scenery.drs) {
      if (!Number.isFinite(d.atS)) continue;
      const side = Number.isFinite(d.side) ? (d.side < 0 ? -1 : 1) : outsideSide(Math.round(at(d.atS) * N) % N);
      drsBoard(d.atS, side);
    }
  } else {
    for (const f of [0.05, 0.14, 0.52]) {
      drsBoard(lengthM * f, outsideSide(Math.round(at(lengthM * f) * N)));
    }
  }

  // ---- floodlights ----
  const floodlight = (x, z) => {
    voxels.add(x, 14, z, 2.2, 28, 2.2, C.floodPole);
    voxels.add(x, 27.4, z, 7, 1.6, 1.6, C.floodPole);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) voxels.add(x - 3 + c * 2, 29.4 + r * 2.2, z, 1.9, 1.9, 1.6, C.floodLamp);
    }
  };
  if (scenery.floodlights) {
    for (const f of scenery.floodlights) {
      if (!Number.isFinite(f.x) || !Number.isFinite(f.z)) continue;
      floodlight(f.x, f.z);
    }
  } else {
    for (const fx of [-0.68, 0.68]) {
      for (const fz of [-0.72, 0.72]) {
        const x = cx + rx * fx;
        const z = cz + rz * fz;
        if (inIsland(x, z, 0.95)) floodlight(Math.round(x), Math.round(z));
      }
    }
  }

  // ---- start gantry (static voxels) + animated light pods ----
  const gantryColumnMats = [];
  const pendingLights = [];
  {
    const sp = curve.getPointAt(0);
    const st = curve.getTangentAt(0);
    const sn = new THREE.Vector3(-st.z, 0, st.x);
    const sry = rys[0];
    for (const side of [-1, 1]) {
      voxels.add(sp.x + sn.x * side * (roadWidthM / 2 + 1.5), 5, sp.z + sn.z * side * (roadWidthM / 2 + 1.5), 1.6, 11, 1.6, C.gantryPillar, sry);
    }
    voxels.add(sp.x, 10.5, sp.z, roadWidthM + 6, 1.6, 2.2, C.gantryBeam, sry);
    voxels.add(sp.x, 9.2, sp.z, roadWidthM + 2, 1.4, 2.6, C.gantryBand, sry);
    // one shared material per column: both pods light together. The pods
    // hang BELOW the beam (buried boxes would be invisible from outside).
    // Lambert (not Standard as in the reference): same emissive look, one
    // less shader program — the scene stays Lambert-only, which software
    // GL rasterizers (CI, low-end devices) compile and run much cheaper.
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x550000, emissive: 0x330000 });
      gantryColumnMats.push(mat);
      for (const dn of [-0.9, 0.9]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.6), mat);
        m.position.set(sp.x + st.x * (i - 2) * 3 + sn.x * dn, 8.4, sp.z + st.z * (i - 2) * 3 + sn.z * dn);
        m.rotation.y = sry;
        m.castShadow = true;
        pendingLights.push(m);
      }
    }
  }

  const group = new THREE.Group();
  group.add(voxels.build());
  for (const m of pendingLights) group.add(m);

  let animStart = null;
  function update(nowMs) {
    if (animStart === null) animStart = nowMs;
    const phase = ((nowMs - animStart) % GANTRY_CYCLE_MS) / 1000;
    for (let i = 0; i < 5; i++) {
      const lit = phase >= i * 0.5 && phase < 4.0;
      const go = phase >= 4.0;
      const mat = gantryColumnMats[i];
      if (go) {
        mat.emissive.setHex(0x33ff66);
        mat.emissiveIntensity = 1.5;
      } else if (lit) {
        mat.emissive.setHex(0xff2211);
        mat.emissiveIntensity = 1.0;
      } else {
        mat.emissive.setHex(0x330000);
        mat.emissiveIntensity = 1.0;
      }
    }
  }

  return {
    group,
    update,
    island: { cx, cz, rx, rz, bottomY: islandBottomY, topY: GRASS_TOP_Y },
    pitSlots,
    stats: { voxels: voxels.items.length },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    },
  };
}
