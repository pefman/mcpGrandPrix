/**
 * Track rendering (MCPG-27 rewrite).
 *
 * Builds the visual track from a track *definition* (tracks/*.json):
 * Catmull-Rom centerline normalized to the sim's exact length, textured
 * road ribbon, curb runs on hard corners, checker start line, pit lane +
 * boxes, water, themed ground, and props (hand-placed + seeded scatter).
 *
 * Everything is plain boxes/ribbons sampled with NearestFilter textures —
 * the pixel-art direction lives here and in pixelTextures.js / props.js.
 */
import * as THREE from 'three';
import { makeGroundTexture, makeRoadTexture, makeCheckerTexture } from './pixelTextures.js';
import { buildProps, scatterProps } from './props.js';
import { createRng } from './rng.js';

const CURB_MIN_RUN_M = 15;
const CURB_WIDTH_M = 2.2;
const CURB_STRIDE_M = 4;
const CURVATURE_SAMPLES = 240;

/**
 * Waypoints -> closed centripetal Catmull-Rom curve, uniformly rescaled so
 * getLength() matches the sim's track length (s maps linearly to curve u).
 */
function createTrackCurve(def, lengthM) {
  const pts = def.waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve0 = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);

  // scale about the waypoints' center of mass (keeps the track centered)
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

/**
 * Flat ribbon along an arc of the base curve.
 * `offsetM` shifts the ribbon along the outward normal n = (-t.z, 0, t.x).
 * uvM = meters per one UV unit along the ribbon.
 */
function flatRibbon(curve, arclen, u0, u1, { widthM, y = 0, offsetM = 0, segs = 64, uvM = 3, colors = null }) {
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  const n = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const u = u0 + ((u1 - u0) * i) / segs;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    n.set(-t.z, 0, t.x);
    const cx = p.x + n.x * offsetM;
    const cz = p.z + n.z * offsetM;
    const hx = n.x * (widthM / 2);
    const hz = n.z * (widthM / 2);
    pos.push(cx - hx, y, cz - hz, cx + hx, y, cz + hz);
    const sMeters = u * arclen;
    uv.push(sMeters / uvM, 0);
    uv.push(sMeters / uvM, 1);
    if (colors) {
      const cc = colors(sMeters);
      for (let k = 0; k < 2; k++) col.push(cc.r, cc.g, cc.b);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Ribbon on an [s0, s1] arc in meters; splits the arc when it wraps past lengthM. */
function ribbonOnArc(base, arclen, lengthM, s0, s1, opts) {
  const pieces = [];
  let a = ((s0 % lengthM) + lengthM) % lengthM;
  let b = s1 - s0;
  while (b > 0) {
    const end = Math.min(b, lengthM - a);
    const u0 = a / arclen;
    const u1 = (a + end) / arclen;
    const segs = Math.max(4, Math.ceil((end / lengthM) * 220));
    pieces.push(flatRibbon(base, arclen, u0, u1, { ...opts, segs }));
    a = (a + end) % lengthM;
    b -= end;
  }
  return pieces;
}

/** Low wall (barrier) along an arc: quad from y to y+h on the outer edge. */
function wallRibbon(base, arclen, s0, s1, { h, y = 0, offsetM, segs = 120 }) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const u = s0 + ((s1 - s0) * i) / segs;
    const p = base.getPointAt(u);
    const t = base.getTangentAt(u);
    const nx = -t.z;
    const nz = t.x;
    const x = p.x + nx * offsetM;
    const z = p.z + nz * offsetM;
    pos.push(x, y, z, x, y + h, z);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Curvature (1/m) at each sample index. */
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

/** Contiguous arcs (in meters, s0/s1 with s1 possibly past lengthM) where curvature >= threshold. */
function curbRuns(curve, arclen, lengthM, threshold = 0.021, minRunM = CURB_MIN_RUN_M) {
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
    if (lenM >= minRunM) {
      runs.push({ s0: i * ds, s1: i * ds + lenM });
    }
    i = j;
  }
  // wrap case: hot spans the seam [a..end] + [0..b] -> one merged run
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

/**
 * Build the full visual track for a def. Returns
 * { group, pointAt(s), tangentAt(s), pitBoxes, bbox, theme, def, ground,
 *   groundSize, size, dispose() }. Pass opts.shadows to flag prop meshes
 * (cast) and the ground floor (receive) for the scene's shadow camera.
 */
export function buildTrack(scene, trackInfo, def, opts = {}) {
  const group = new THREE.Group();
  const lengthM = trackInfo.lengthM ?? def.lengthM;
  const roadWidthM = def.roadWidthM;
  const theme = def.theme;
  const rng = createRng(99);
  const shadowsOn = !!opts.shadows;

  const curve = createTrackCurve(def, lengthM);
  const arclen = curve.getLength();
  const wrap = (s) => ((s % lengthM) + lengthM) % lengthM;
  const pointAt = (s) => curve.getPointAt(wrap(s) / arclen);
  const tangentAt = (s) => curve.getTangentAt(wrap(s) / arclen);

  // ---- ground plane, sized once the bbox is known (see below) so the
  // theme sky stays visible around the circuit's edge
  const groundTex = makeGroundTexture(theme);
  // ground is a (tiny) group: it carries the sized floor mesh AND the
  // diorama island slab under it (Step 2, MCPG-44) — one unit to size,
  // place, traverse and dispose
  const ground = new THREE.Group();
  const groundFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshLambertMaterial({ map: groundTex }),
  );
  groundFloor.rotation.x = -Math.PI / 2;
  // 2 m below the road: at the spectator camera's shallow angle the road
  // surface sweeps ~0.4 m of depth per screen pixel, so separations must
  // exceed that or the surfaces z-fight
  groundFloor.position.y = -2;
  ground.add(groundFloor);
  group.add(ground);

  // ---- road (overlays sit >0.6 m above it, beyond the per-pixel depth
  // sweep, so they never z-fight; polygonOffset would push the road back
  // ~1.7 m at this camera angle and hide it under the ground)
  const roadMat = new THREE.MeshLambertMaterial({ map: makeRoadTexture(theme) });
  const roadGeo = flatRibbon(curve, arclen, 0, 1, {
    widthM: roadWidthM,
    y: 0,
    segs: 220,
    uvM: theme.road.tileM,
  });
  group.add(new THREE.Mesh(roadGeo, roadMat));

  // ---- curbs on hard corners (outer edge, alternating red/white)
  // gentle circuits (e.g. Coastal Palm) lower the threshold in their theme
  if (theme.curb) {
    const red = new THREE.Color(theme.curb.red);
    const white = new THREE.Color(theme.curb.white);
    const curbMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const curbOffset = roadWidthM / 2 + CURB_WIDTH_M / 2 - 0.4;
    for (const run of curbRuns(curve, arclen, lengthM, theme.curb.threshold ?? 0.021)) {
      for (const piece of ribbonOnArc(curve, arclen, lengthM, run.s0, run.s1, {
        widthM: CURB_WIDTH_M,
        y: 1.0,
        offsetM: curbOffset,
        uvM: CURB_STRIDE_M,
        colors: (s) => (Math.floor(s / CURB_STRIDE_M) % 2 === 0 ? red : white),
      })) {
        group.add(new THREE.Mesh(piece, curbMat));
      }
    }
  }

  // ---- start/finish checker (straddling s=0)
  // uvM=1.6 -> exactly the 2 texture rows over the 3.2 m band, and
  // lengthM % 1.6 === 0 so the rows align with the line
  const checkerTex = makeCheckerTexture('#f4f4f4', '#15181f', 6, 2);
  const checkerWidth = Math.max(4, roadWidthM - 1.5);
  for (const piece of ribbonOnArc(curve, arclen, lengthM, lengthM - 1.6, 1.6, {
    widthM: checkerWidth,
    y: 0.6,
    uvM: 1.6,
  })) {
    group.add(new THREE.Mesh(piece, new THREE.MeshLambertMaterial({ map: checkerTex })));
  }

  // ---- sector ticks
  const sectorTickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  if (trackInfo.sectorCount > 1) {
    const sectorLen = trackInfo.sectorLengthM ?? lengthM / trackInfo.sectorCount;
    for (let k = 1; k < trackInfo.sectorCount; k++) {
      const s = k * sectorLen;
      const piece = flatRibbon(curve, arclen, s / arclen, (s + 0.8) / arclen, {
        widthM: roadWidthM - 1,
        y: 0.8,
        segs: 1,
        uvM: 1,
      });
      group.add(new THREE.Mesh(piece, sectorTickMat));
    }
  }

  // ---- pit lane + boxes (inside of the start straight)
  const pitOffset = -20;
  class PitLaneCurve extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const s = 15 + (95 - 15) * t;
      const p = curve.getPointAt(wrap(s) / arclen);
      const tg = curve.getTangentAt(wrap(s) / arclen);
      return target.set(p.x + (-tg.z) * pitOffset, 0, p.z + tg.x * pitOffset);
    }
  }
  const pitCurve = new PitLaneCurve();
  const pitGeo = flatRibbon(pitCurve, pitCurve.getLength(), 0, 1, { widthM: 5, y: 0.5, uvM: 2 });
  group.add(new THREE.Mesh(pitGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(theme.pit) })));

  const pitBoxes = [];
  for (const s of [35, 55, 75]) {
    const p = curve.getPointAt(wrap(s) / arclen);
    const t = curve.getTangentAt(wrap(s) / arclen);
    pitBoxes.push({
      s,
      pos: new THREE.Vector3(p.x + (-t.z) * pitOffset, 0, p.z + t.x * pitOffset),
      tangent: t,
    });
  }

  // ---- barriers
  if (theme.barriers) {
    const barrierMat = new THREE.MeshLambertMaterial({ color: 0xd8dbe2, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(
      wallRibbon(curve, arclen, 0, 1, { h: 0.9, y: 0, offsetM: roadWidthM / 2 + 3 }),
      barrierMat,
    ));
  }

  // ---- water
  const waterCircles = def.water ?? [];
  if (waterCircles.length && theme.water) {
    const waterMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.water) });
    for (const w of waterCircles) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(w.r, 40), waterMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(w.x, -1.5, w.z);
      group.add(m);
    }
  }

  // ---- props: hand-placed + seeded scatter
  const samples = [];
  for (let i = 0; i < 160; i++) {
    const p = curve.getPointAt(i / 160);
    samples.push({ x: p.x, z: p.z });
  }
  const scattered = scatterProps(def, samples, roadWidthM, waterCircles);
  const propsGroup = buildProps((def.props ?? []).concat(scattered), rng);
  group.add(propsGroup);
  if (shadowsOn) {
    // only props cast: road/curb/pit overlays stay shadow-free (cheap and
    // no self-shadowing artifacts on the centimetre-scale layered road)
    propsGroup.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }

  // ---- bounding box (track only, ground excluded) with generous margin
  const bbox = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < 100; i++) {
    v.copy(curve.getPointAt(i / 100));
    bbox.expandByPoint(v);
  }
  // keep the ground plane centered on the circuit, not on the world origin
  const trackCenter = bbox.getCenter(new THREE.Vector3());
  ground.position.set(trackCenter.x, 0, trackCenter.z);
  const GROUND_MARGIN_M = 160; // of sky beyond the circuit on every side
  const gsize = bbox.getSize(new THREE.Vector3());
  const groundSize = {
    x: gsize.x + 2 * GROUND_MARGIN_M,
    z: gsize.z + 2 * GROUND_MARGIN_M,
  };
  // PlaneGeometry lies in local XY (normal +Z); after rotation.x = -PI/2
  // local Y becomes world -Z, so the floor's DEPTH goes in scale.y —
  // scale.z only stretches the (zero) thickness
  groundFloor.scale.set(groundSize.x, groundSize.z, 1);
  groundTex.repeat.set(
    groundSize.x / theme.ground.tileM,
    groundSize.z / theme.ground.tileM,
  );
  if (shadowsOn) groundFloor.receiveShadow = true;

  // ---- diorama island slab under the floor (Step 2, MCPG-44)
  // Two stacked boxes (not an ExtrudeGeometry skirt): one mesh-pair, hard
  // voxel silhouette. A slightly wider top lip (dirt) sits on a narrower,
  // darker bottom (rock) — the floating-tabletop read.
  const ISLAND_H = 16;
  const island = new THREE.Group();
  const dirt = new THREE.Color(theme.ground.base).offsetHSL(0, 0.02, -0.14);
  const rock = new THREE.Color(theme.ground.base).offsetHSL(0, 0.05, -0.32);
  const topLip = new THREE.Mesh(
    new THREE.BoxGeometry(groundSize.x + 12, ISLAND_H * 0.45, groundSize.z + 12),
    new THREE.MeshLambertMaterial({ color: dirt }),
  );
  topLip.position.y = ISLAND_H * 0.45 / 2;
  const bottomRock = new THREE.Mesh(
    new THREE.BoxGeometry(groundSize.x - 4, ISLAND_H * 0.55, groundSize.z - 4),
    new THREE.MeshLambertMaterial({ color: rock }),
  );
  bottomRock.position.y = -ISLAND_H * 0.55 / 2;
  island.add(topLip, bottomRock);
  // the floor sits at local y=-2 inside `ground`; island top just below it
  island.position.y = -2 - ISLAND_H / 2 + 0.4;
  ground.add(island);
  bbox.expandByScalar(roadWidthM / 2 + 28);
  // tall props (city towers) project above the flat circuit bbox —
  // lift the top so the camera fit keeps them in frame
  const maxPropH = (def.props ?? []).reduce((m, p) => Math.max(m, p.h ?? 0), 0);
  if (maxPropH > 0) bbox.max.y += maxPropH;

  function dispose() {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }

  // ---- minimap geometry (MCPG-31): the 2D HUD canvas draws the circuit
  // from the SAME curve as the 3D road, so the two views can't diverge.
  // Sampled once (the curve never changes); the canvas does the fitting.
  const MAP_SAMPLES = 256;
  const mapPoints = [];
  let mapMinX = Infinity;
  let mapMaxX = -Infinity;
  let mapMinZ = Infinity;
  let mapMaxZ = -Infinity;
  for (let i = 0; i < MAP_SAMPLES; i++) {
    const p = curve.getPointAt(i / MAP_SAMPLES);
    mapPoints.push({ x: p.x, z: p.z });
    if (p.x < mapMinX) mapMinX = p.x;
    if (p.x > mapMaxX) mapMaxX = p.x;
    if (p.z < mapMinZ) mapMinZ = p.z;
    if (p.z > mapMaxZ) mapMaxZ = p.z;
  }
  const sectorS = [];
  if (trackInfo.sectorCount > 1) {
    const sectorLen = trackInfo.sectorLengthM ?? lengthM / trackInfo.sectorCount;
    for (let k = 1; k < trackInfo.sectorCount; k++) sectorS.push(k * sectorLen);
  }
  const map = {
    points: mapPoints,
    pitPoints: pitBoxes.map((b) => ({ x: b.pos.x, z: b.pos.z })),
    min: { x: mapMinX, z: mapMinZ },
    max: { x: mapMaxX, z: mapMaxZ },
    sectorS,
    lengthM,
  };

  return {
    group,
    pointAt,
    tangentAt,
    pitBoxes,
    bbox,
    theme,
    def,
    // exposed for scene.js (Step 2, MCPG-44): island slab + shadow setup
    ground,
    groundSize,
    groundCenter: trackCenter,
    size: gsize,
    // minimap source data (MCPG-31)
    map,
    dispose,
  };
}
