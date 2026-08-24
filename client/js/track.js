/**
 * Track geometry for the spectator scene.
 *
 * The Slice 1 server track is a 1-D loop: 1000 m, five 200 m sectors
 * (src/track.js). The server never stores a shape, so the client draws a
 * simple, readable circuit and normalizes its arc length to the server's
 * track length: (lap, s) -> curve.getPointAt(s / lengthM) gives the exact
 * meter position, and all relative gaps are preserved (Leclerc, MCPG-12 Q3).
 */
import * as THREE from 'three';

const ROAD_WIDTH_M = 13;

// Closed circuit control points (x, z) in meters, counter-clockwise on
// screen, start/finish on the bottom straight travelling +x.
const CONTROL_POINTS = [
  [150, 130], // s=0: start/finish
  [210, 90],
  [226, 10],
  [200, -70],
  [130, -120],
  [30, -132],
  [-60, -112],
  [-132, -70],
  [-192, 0],
  [-170, 80],
  [-100, 122],
  [20, 136],
];

/** Build the centerline curve, scaled so its arc length is exactly lengthM. */
export function createTrackCurve(lengthM) {
  const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  // Uniform scaling scales arc length by the same factor.
  const scale = lengthM / curve.getLength();
  pts.forEach((p) => p.multiplyScalar(scale));
  return curve;
}

function ribbonGeometry(curve, widthM, y = 0.02, samples = 400) {
  const left = new Float32Array((samples + 1) * 3);
  const right = new Float32Array((samples + 1) * 3);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= samples; i += 1) {
    const u = i / samples;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    // outward normal for a counter-clockwise loop (see module notes)
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const half = widthM / 2;
    left[i * 3] = p.x + n.x * half;
    left[i * 3 + 1] = y;
    left[i * 3 + 2] = p.z + n.z * half;
    right[i * 3] = p.x - n.x * half;
    right[i * 3 + 1] = y;
    right[i * 3 + 2] = p.z - n.z * half;
  }
  const positions = new Float32Array((samples + 1) * 2 * 3);
  const indices = [];
  for (let i = 0; i <= samples; i += 1) {
    positions.set(left.slice(i * 3, i * 3 + 3), (i * 2) * 3);
    positions.set(right.slice(i * 3, i * 3 + 3), (i * 2 + 1) * 3);
    if (i < samples) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function stripeAt(curve, sM, lengthM, color, widthScale = 1) {
  const u = (sM % lengthM) / lengthM;
  const p = curve.getPointAt(u);
  const t = curve.getTangentAt(u);
  const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_WIDTH_M * widthScale, 0.12, 1.6),
    new THREE.MeshBasicMaterial({ color }),
  );
  stripe.position.set(p.x, 0.06, p.z);
  // orient the long axis along the road normal (across the road)
  stripe.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), n);
  return stripe;
}

/**
 * Build the full track (road, ground, start line, sector ticks, pit lane)
 * and return lookup helpers.
 */
export function buildTrack(scene, trackInfo) {
  const lengthM = trackInfo.lengthM;
  const curve = createTrackCurve(lengthM);

  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1100),
    new THREE.MeshLambertMaterial({ color: 0x10141b }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  // road
  const road = new THREE.Mesh(
    ribbonGeometry(curve, ROAD_WIDTH_M),
    new THREE.MeshLambertMaterial({ color: 0x232a35, side: THREE.DoubleSide }),
  );
  scene.add(road);

  // start/finish line (white + accent halves)
  const startLine = new THREE.Group();
  const halfA = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_WIDTH_M / 2 - 0.2, 0.12, 1.8),
    new THREE.MeshBasicMaterial({ color: 0xf2f5f9 }),
  );
  const halfB = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_WIDTH_M / 2 - 0.2, 0.12, 1.8),
    new THREE.MeshBasicMaterial({ color: 0x10141b }),
  );
  const p0 = curve.getPointAt(0);
  const t0 = curve.getTangentAt(0);
  const n0 = new THREE.Vector3(-t0.z, 0, t0.x).normalize();
  halfA.position.set(n0.x * (ROAD_WIDTH_M / 4), 0.07, n0.z * (ROAD_WIDTH_M / 4));
  halfB.position.set(-n0.x * (ROAD_WIDTH_M / 4), 0.07, -n0.z * (ROAD_WIDTH_M / 4));
  startLine.add(halfA, halfB);
  startLine.position.set(p0.x, 0, p0.z);
  startLine.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), n0);
  scene.add(startLine);

  // sector boundary ticks (at sectorLengthM multiples)
  const sectorLen = trackInfo.sectorLengthM ?? lengthM / (trackInfo.sectorCount ?? 1);
  for (let i = 1; i < (trackInfo.sectorCount ?? 1); i += 1) {
    scene.add(stripeAt(curve, i * sectorLen, lengthM, 0xffb020, 0.35));
  }

  // pit lane: a straight strip on the inside of the start straight,
  // s = 15..95, offset 20 m inside. One pit box per car (grid order).
  const PIT_FROM_S = 15;
  const PIT_TO_S = 95;
  const PIT_OFFSET_M = 20;
  const pitCurve = new THREE.Curve();
  pitCurve.getPoint = (t) => {
    const s = PIT_FROM_S + (PIT_TO_S - PIT_FROM_S) * t;
    const u = s / lengthM;
    const p = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    return p.clone().addScaledVector(n, -PIT_OFFSET_M);
  };
  const pitLane = new THREE.Mesh(
    ribbonGeometry(pitCurve, 6, 0.03, 24),
    new THREE.MeshLambertMaterial({ color: 0x2e3644, side: THREE.DoubleSide }),
  );
  scene.add(pitLane);

  const pitBoxes = [];
  const pitBoxCount = 8; // max agents
  for (let i = 0; i < pitBoxCount; i += 1) {
    const s = PIT_FROM_S + 12 + i * ((PIT_TO_S - PIT_FROM_S - 24) / (pitBoxCount - 1));
    const u = s / lengthM;
    const p = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    const pos = p.clone().addScaledVector(n, -PIT_OFFSET_M);
    pitBoxes.push({ position: pos, tangent: tan.clone() });
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.14, 8),
      new THREE.MeshBasicMaterial({ color: 0x3b4456 }),
    );
    box.position.set(pos.x, 0.05, pos.z);
    box.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan.clone().setY(0).normalize());
    scene.add(box);
  }

  return {
    curve,
    lengthM,
    pitBoxes,
    /** Meters s (0..lengthM) -> world point on the centerline. */
    pointAt: (s) => curve.getPointAt((((s % lengthM) + lengthM) % lengthM) / lengthM),
    tangentAt: (s) => curve.getTangentAt((((s % lengthM) + lengthM) % lengthM) / lengthM),
  };
}
