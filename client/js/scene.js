/**
 * Spectator scene (MCPG-27 rewrite).
 *
 * One fixed orthographic camera — soft 3/4 view from the south, fitted
 * once to the track's bounding box. No pan, no zoom, no follow-cam.
 * The renderer draws into a quarter-resolution buffer that CSS upscales
 * with `image-rendering: pixelated`: chunky pixels, no antialiasing.
 * Background and lights come from the track theme.
 *
 * Step 2 (MCPG-44): one soft directional shadow (chunky, on-brand) and a
 * thick island slab under the ground plane — the floating-tabletop read.
 * Shadows are a single toggle (SHADOWS_ENABLED); if they moiré at the
 * 1/4-res buffer, flipping it off is the Step-5 lever.
 *
 * Step 5 (MCPG-47): the camera fits the WHOLE island (track.fitBox), so
 * the floating slab reads as a diorama on a table instead of bleeding
 * off-frame; fog is gone (the hard slab edge IS the diorama border);
 * per-frame temporaries keep the render loop allocation-free.
 */
import * as THREE from 'three';
import { buildTrack } from './track.js';
import { createFx } from './fx.js';

export const CAR_COLORS = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759',
  '#0a84ff', '#af52de', '#ff2d55', '#e5e5ea',
];

const PIXEL_SCALE = 4; // buffer = 1/PIXEL_SCALE of the CSS size
const ELEVATION = THREE.MathUtils.degToRad(35);
const FIT_MARGIN = 1.05;
const SHADOWS_ENABLED = true; // kill-switch; keep on (verified in Step 5, MCPG-47)
const SHADOW_MAP_SIZE = 2048;
const PIT_TWEEN_MS = 900; // pit lane drive-in/out, client-side only (MCPG-45)

// shared per-frame temporaries (Step 5, MCPG-47): label projection reuses
// one Vector3 instead of allocating per car per frame
const _labelVec = new THREE.Vector3();
const _labelOut = { x: 0, y: 0 }; // reused by labelScreenPos (read immediately)

/**
 * Voxel F1 car (Step 3, MCPG-45): a box stack with a strong F1 silhouette,
 * nose pointing local +Z (setCar orients via lookAt):
 *
 *   body + front splitter + rear wing  → livery parts (userData.livery)
 *   glass cockpit                      → light glass
 *   4 wide wheels + 2 wing pylons      → dark
 *
 * Livery parts are painted ONCE here / in addCar; setCar only repaints when
 * a car retires (never per frame — the old per-frame traverse is gone).
 */
const GLASS_COLOR = 0x9fc7dd; // light cockpit glass
const DARK_COLOR = 0x14171d;  // wheels
const PYLON_COLOR = 0x1a1e26; // wing pylons

export function makeCarMesh(color) {
  const g = new THREE.Group();
  const add = (w, h, d, c, x, y, z, livery) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: c }),
    );
    m.position.set(x, y, z);
    if (livery) m.userData.livery = true;
    g.add(m);
    return m;
  };
  // body (livery): long, low slab
  add(2.0, 0.85, 4.6, color, 0, 0.85, -0.1, true);
  // glass cockpit, just behind mid
  add(1.1, 0.55, 1.5, GLASS_COLOR, 0, 1.5, 0.15);
  // front splitter (livery) — the nose, local +Z
  add(1.3, 0.35, 1.1, color, 0, 0.6, 2.55, true);
  // rear wing (livery) + pylons — the tail, local -Z
  add(2.5, 0.3, 0.75, color, 0, 1.8, -2.55, true);
  add(0.28, 0.9, 0.3, PYLON_COLOR, -0.62, 1.2, -2.5);
  add(0.28, 0.9, 0.3, PYLON_COLOR, 0.62, 1.2, -2.5);
  // 4 wide wheels: F1 stance, wider than the body
  for (const x of [-1.12, 1.12]) for (const z of [-1.75, 1.75]) add(0.95, 1.05, 1.35, DARK_COLOR, x, 0.525, z);
  g.scale.setScalar(1.9); // track is 1000 m — 2 m cars would be sub-pixel
  g.userData.color = color;
  return g;
}

/**
 * Fit an orthographic camera (already positioned + lookAt-ed) so the 8
 * bbox corners all land inside the frustum with a little breathing room.
 */
function fitCamera(camera, bbox, aspect) {
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  let maxX = 1;
  let maxY = 1;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(
      i & 1 ? bbox.max.x : bbox.min.x,
      i & 2 ? bbox.max.y : bbox.min.y,
      i & 4 ? bbox.max.z : bbox.min.z,
    ).applyMatrix4(inv);
    maxX = Math.max(maxX, Math.abs(c.x));
    maxY = Math.max(maxY, Math.abs(c.y));
  }
  const halfH = Math.max(maxY, maxX / aspect) * FIT_MARGIN;
  const halfW = halfH * aspect;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}

export function createSpectatorScene(canvas, trackInfo, def) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);

  const theme = def.theme;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.sky);

  // themed lights. The shadow frustum is set once the track size is known
  // (it must cover the circuit but not the whole ground plane — a 2048 map
  // over ~1200 m would be ~60 cm/texel and the shadows would disappear)
  scene.add(new THREE.HemisphereLight(
    new THREE.Color(theme.ambient.sky),
    new THREE.Color(theme.ambient.ground),
    theme.ambient.intensity ?? 1.0,
  ));
  const sun = new THREE.DirectionalLight(new THREE.Color(theme.sun.color), theme.sun.intensity ?? 1.0);
  scene.add(sun);

  const track = buildTrack(scene, trackInfo, def, { shadows: SHADOWS_ENABLED });
  scene.add(track.group);

  // circuit center + size (shadow setup and camera share these)
  const center = track.bbox.getCenter(new THREE.Vector3());
  const size = track.bbox.getSize(new THREE.Vector3());

  // soft chunky shadows: only props cast, only the ground floor receives —
  // the shadow map stays sparse and legible at the 1/4-res buffer
  if (SHADOWS_ENABLED) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const spread = Math.max(size.x, size.z) + 60;
    sun.position.set(center.x + spread * 0.45, 380, center.z + spread * 0.55);
    sun.target.position.copy(center);
    scene.add(sun.target);
    const shadow = sun.shadow;
    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    shadow.camera.near = 1;
    shadow.camera.far = 1500;
    shadow.camera.left = -spread;
    shadow.camera.right = spread;
    shadow.camera.top = spread;
    shadow.camera.bottom = -spread;
    shadow.bias = -0.0015; // keep the chunky slabs from shadowing themselves
    shadow.normalBias = 0.04; // offset along the normal: kills acne on the
                              // chunky axis-aligned boxes (Step 5, MCPG-47)
  }

  // fixed camera: from the south (+z), elevated, aimed at the track center
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000);
  const distance = (size.x + size.z) * 0.75 + 400;
  // No fog (Step 5, MCPG-47): the ground is a finite island slab, and its
  // hard edge against the sky is the intended diorama border — foging it
  // would just blur the tabletop's far rim.
  camera.position.set(
    center.x,
    center.y + distance * Math.sin(ELEVATION),
    center.z + distance * Math.cos(ELEVATION),
  );
  camera.lookAt(center);
  // near=10 (the track is ~500+ m away) keeps depth precision fine enough
  // that the centimetre-scale road overlays can't z-fight
  camera.near = 10;
  camera.far = distance + size.length() * 1.5 + 1000;

  const cars = new Map(); // carId -> { group, color, liveryParts, state, name, ... }
  const _lerp = new THREE.Vector3(); // scratch for the pit-transition tween
  const _dir = new THREE.Vector3();
  const DIM = new THREE.Color(0x3a3f48); // retired cars fade to this

  // ---- race FX (Step 4, MCPG-46): one shared effect system (client/js/fx.js)
  const fx = createFx(scene, theme);
  const fxPos = new THREE.Vector3(); // long-lived: fx.burst copies it
  let prevOrder = null;    // last seen standings order (overtake detection)
  let prevPhase = null;    // last seen phase (start / finish detection)
  let lastEventSnapshot = null; // dedupe: setCar is called per car with the SAME snapshot object each frame
  const lastOvertakeAt = new Map(); // pairKey -> ms (one burst per pass)

  /**
   * Detect race moments from snapshot-to-snapshot state and fire FX.
   * Purely visual — the sim's own event log stays the record of truth.
   * Called from setCar with the driving snapshot; positions come from the
   * render buffer (the car is placed right before this).
   */
  function detectEvents(snapshot) {
    // one detection pass per snapshot: every setCar in the frame hands over
    // the same object (Step 5, MCPG-47 — 4-8 identical passes was pure waste)
    if (snapshot === lastEventSnapshot) return;
    lastEventSnapshot = snapshot;
    const now = performance.now();

    // race start: first strategy window of the race (cars still on the grid)
    if (prevPhase === 'setup' && snapshot.phase === 'strategy_window') {
      for (const c of snapshot.cars) {
        const car = cars.get(c.id);
        if (!car) continue;
        fx.burst('start', car.group.position, { count: 5, speed: 24, up: 9, life: 1.5 });
      }
    }

    // race finish: confetti above every car — tinted by livery, P1 gets a
    // bigger gold column
    if (prevPhase !== 'finished' && snapshot.phase === 'finished') {
      const posById = new Map((snapshot.standings ?? []).map((e) => [e.carId, e.position]));
      for (const [carId, car] of cars) {
        const p1 = posById.get(carId) === 1;
        fx.burst('finish', car.group.position, {
          count: p1 ? 22 : 10,
          speed: 26,
          up: p1 ? 14 : 8,
          life: 2.2,
          color: p1 ? 0xffe066 : new THREE.Color(car.color),
        });
      }
    }

    // overtakes: standings order changed -> burst at the mid point of the
    // cars whose relative order flipped. The order only flips on a real
    // position change in the sim, so this cannot fire off the pit lane.
    const order = (snapshot.standings ?? []).map((e) => e.carId);
    if (prevOrder && order.length > 0 && order.length === prevOrder.length) {
      const prevIdx = new Map(prevOrder.map((id, i) => [id, i]));
      const idx = new Map(order.map((id, i) => [id, i]));
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const a = order[i];
          const b = order[j];
          if ((prevIdx.get(a) ?? 0) - (prevIdx.get(b) ?? 0) >= idx.get(a) - idx.get(b)) continue;
          // a and b swapped: a is now ahead of b, it wasn't before
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          const lastAt = lastOvertakeAt.get(key) ?? -Infinity;
          if (now - lastAt < 3000) continue; // debounce: the flip wobbles a few frames
          lastOvertakeAt.set(key, now);
          const ca = cars.get(a)?.group;
          const cb = cars.get(b)?.group;
          if (!ca || !cb) continue;
          fxPos.copy(ca.position).add(cb.position).multiplyScalar(0.5);
          fxPos.y = 1;
          fx.burst('overtake', fxPos, { count: 8, speed: 20, up: 6, life: 1.1 });
        }
      }
    }
    prevOrder = order.length ? order : prevOrder;
    prevPhase = snapshot.phase;
  }

  function addCar(carId, name, slotIndex, serverColor) {
    // Prefer the server-assigned livery color (join order, MCPG-33); fall
    // back to the legacy client palette for pre-change servers.
    const color =
      typeof serverColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(serverColor)
        ? serverColor
        : CAR_COLORS[slotIndex % CAR_COLORS.length];
    const group = makeCarMesh(color);
    const liveryParts = [];
    group.traverse((o) => {
      if (!o.isMesh) return;
      if (SHADOWS_ENABLED) o.castShadow = true;
      if (o.userData.livery) liveryParts.push(o);
    });
    scene.add(group);
    cars.set(carId, {
      group, color, liveryParts,
      liveryColor: new THREE.Color(color),
      state: 'RUNNING', name,
      placed: false,  // first sighting: snap, don't tween (late spectators)
      pitting: false,
      dimmed: false,
      tween: null,
    });
    return color;
  }

  /** Pit box for this car (pit boxes are assigned in join/grid order). */
  function pitBoxOf(carId) {
    const slot = Math.max(0, [...cars.keys()].indexOf(carId));
    return track.pitBoxes[Math.min(slot, track.pitBoxes.length - 1)];
  }

  function paintLivery(car) {
    const c = car.dimmed ? DIM : car.liveryColor;
    for (const part of car.liveryParts) part.material.color.copy(c);
  }

  const smooth01 = (t) => {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  };

  function setCar(carId, s, state, snapshot = null) {
    const car = cars.get(carId);
    if (!car) return;
    car.state = state;
    const group = car.group;

    // pit-stop FX: the snapshot's pitTimeLeftS only counts down while the
    // car actually pits, so the first PITTING frame fires once per stop.
    // (Fires at the car's on-track position: this frame is where the tween
    // starts, i.e. where the car entered the pit lane.)
    const pitting = state === 'PITTING';
    const now = performance.now();
    if (pitting && snapshot && snapshot.cars) {
      const snapCar = snapshot.cars.find((c) => c.id === carId);
      const t = snapCar?.pitTimeLeftS;
      if (car.pitFxArmed !== true && t != null && t > 0) {
        car.pitFxArmed = true;
        fx.burst('pit', group.position, { count: 12, speed: 12, up: 5, life: 1.2, color: 0xffc53d });
      }
    } else if (state !== 'PITTING') {
      car.pitFxArmed = false;
    }
    // pit transition (MCPG-45): the sim holds the car stationary at its
    // entry point while PITTING; the drive to/from the pit lane is pure
    // client-side dressing — a short eased tween instead of a teleport
    if (car.placed && pitting !== car.pitting) {
      car.tween = {
        from: group.position.clone(),
        to: pitting ? pitBoxOf(carId).pos : track.pointAt(s),
        t0: now,
        dur: PIT_TWEEN_MS,
      };
    }
    car.placed = true;
    car.pitting = pitting;

    let pos;
    let heading = null;
    const tw = car.tween;
    if (tw) {
      const t = smooth01((now - tw.t0) / tw.dur);
      pos = _lerp.copy(tw.from).lerp(tw.to, t);
      _dir.copy(tw.to).sub(tw.from);
      if (_dir.lengthSq() > 1e-4) heading = _dir.normalize();
      if (t >= 1) car.tween = null;
    } else if (pitting) {
      const box = pitBoxOf(carId);
      pos = box.pos;
      heading = box.tangent;
    } else {
      pos = track.pointAt(s);
      heading = track.tangentAt(s);
    }
    group.position.set(pos.x, 0, pos.z);
    // lookAt with scalars uses three's cached target: no per-frame alloc
    // (Step 5, MCPG-47)
    if (heading) {
      group.lookAt(pos.x + heading.x, 0, pos.z + heading.z); // +Z faces the nose
    }

    // RETIRED dim: repaint only when the state changes (was: every frame,
    // every car)
    const dim = state === 'RETIRED';
    if (dim !== car.dimmed) {
      car.dimmed = dim;
      paintLivery(car);
    }

    if (snapshot) detectEvents(snapshot);
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = Math.max(1, Math.round(w / PIXEL_SCALE));
    const bh = Math.max(1, Math.round(h / PIXEL_SCALE));
    renderer.setSize(bw, bh, false); // buffer size; CSS stretches the canvas
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // fit the WHOLE island, not just the circuit (Step 5, MCPG-47): the
    // floating slab stays in frame on every side, no sky band slicing it
    fitCamera(camera, track.fitBox, w / h);
  }
  resize();
  window.addEventListener('resize', resize);

  function tick(nowMs) {
    fx.update(nowMs);
  }

  return {
    renderer,
    scene,
    camera,
    track,
    carIds: () => [...cars.keys()],
    addCar,
    setCar,
    /** World (x,z) of a car's current visual spot (pit box while PITTING) — the minimap (MCPG-31). */
    carWorldPos(carId) {
      const car = cars.get(carId);
      if (!car) return null;
      return { x: car.group.position.x, z: car.group.position.z };
    },
    /** Project a car's world position to screen px (CSS space) for its DOM label. */
    labelScreenPos(carId) {
      const car = cars.get(carId);
      if (!car) return null;
      // shared temp (Step 5, MCPG-47): the caller reads x/y immediately
      _labelVec.copy(car.group.position);
      _labelVec.y += 6;
      _labelVec.project(camera);
      if (_labelVec.z > 1) return null; // behind the camera
      _labelOut.x = (_labelVec.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      _labelOut.y = (-_labelVec.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
      return _labelOut;
    },
    tick,
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', resize);
      track.dispose();
      fx.dispose();
      renderer.dispose();
    },
  };
}
