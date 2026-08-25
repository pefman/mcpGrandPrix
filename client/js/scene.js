/**
 * Spectator scene (MCPG-27 rewrite).
 *
 * One fixed orthographic camera — soft 3/4 view from the south, fitted
 * once to the track's bounding box. No pan, no zoom, no follow-cam.
 * The renderer draws into a quarter-resolution buffer that CSS upscales
 * with `image-rendering: pixelated`: chunky pixels, no antialiasing.
 * Background, fog and lights come from the track theme.
 *
 * Step 2 (MCPG-44): one soft directional shadow (chunky, on-brand) and a
 * thick island slab under the ground plane — the floating-tabletop read.
 * Shadows are a single toggle (SHADOWS_ENABLED); if they moiré at the
 * 1/4-res buffer, flipping it off is the Step-5 lever.
 */
import * as THREE from 'three';
import { buildTrack } from './track.js';

export const CAR_COLORS = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759',
  '#0a84ff', '#af52de', '#ff2d55', '#e5e5ea',
];

const PIXEL_SCALE = 4; // buffer = 1/PIXEL_SCALE of the CSS size
const ELEVATION = THREE.MathUtils.degToRad(35);
const FIT_MARGIN = 1.05;
const SHADOWS_ENABLED = true; // kill-switch; tune/decide in Step 5 (MCPG-47)
const SHADOW_MAP_SIZE = 2048;

/** One car mesh: a stylized box car, nose pointing local +Z. */
function makeCarMesh(color) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 5.4),
    new THREE.MeshLambertMaterial({ color }),
  );
  body.position.y = 0.8;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.7, 2.2),
    new THREE.MeshLambertMaterial({ color: 0x11141a }),
  );
  cabin.position.set(0, 1.7, -0.5);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.4, 0.8),
    new THREE.MeshLambertMaterial({ color: 0x11141a }),
  );
  nose.position.set(0, 0.9, 2.9);
  group.add(body, cabin, nose);
  group.scale.setScalar(1.9); // track is 1000 m — 2 m cars would be sub-pixel
  group.userData.color = color;
  return group;
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
  scene.background = new THREE.Color(theme.sky); // fog set below, once the camera distance is known

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
  }

  // fixed camera: from the south (+z), elevated, aimed at the track center
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000);
  const distance = (size.x + size.z) * 0.75 + 400;
  // Fog tuned to the camera distance: the circuit itself stays clear, the
  // far edge of the ground plane melts into the sky colour
  scene.fog = new THREE.Fog(new THREE.Color(theme.sky), distance * 1.15, distance * 2.5);
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

  const cars = new Map(); // carId -> { group, color, state, name }

  function addCar(carId, name, slotIndex, serverColor) {
    // Prefer the server-assigned livery color (join order, MCPG-33); fall
    // back to the legacy client palette for pre-change servers.
    const color =
      typeof serverColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(serverColor)
        ? serverColor
        : CAR_COLORS[slotIndex % CAR_COLORS.length];
    const group = makeCarMesh(color);
    if (SHADOWS_ENABLED) group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(group);
    cars.set(carId, { group, color, state: 'RUNNING', name });
    return color;
  }

  function setCar(carId, s, state) {
    const car = cars.get(carId);
    if (!car) return;
    car.state = state;
    const group = car.group;
    let pos;
    let heading;
    if (state === 'PITTING') {
      // parked in its pit box (pit boxes are assigned in join/grid order)
      const slot = Math.max(0, [...cars.keys()].indexOf(carId));
      const box = track.pitBoxes[Math.min(slot, track.pitBoxes.length - 1)];
      pos = box.pos;
      heading = box.tangent;
    } else {
      pos = track.pointAt(s);
      heading = track.tangentAt(s);
    }
    group.position.set(pos.x, 0, pos.z);
    const target = new THREE.Vector3(pos.x + heading.x, 0, pos.z + heading.z);
    group.lookAt(target); // non-camera objects: +Z faces the target (the nose)
    const dim = state === 'RETIRED';
    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.material.color.set(dim ? 0x3a3f48 : (obj === group.children[0] ? car.color : 0x11141a));
      }
    });
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = Math.max(1, Math.round(w / PIXEL_SCALE));
    const bh = Math.max(1, Math.round(h / PIXEL_SCALE));
    renderer.setSize(bw, bh, false); // buffer size; CSS stretches the canvas
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    fitCamera(camera, track.bbox, w / h);
  }
  resize();
  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    track,
    carIds: () => [...cars.keys()],
    addCar,
    setCar,
    /** Project a car's world position to screen px (CSS space) for its DOM label. */
    labelScreenPos(carId) {
      const car = cars.get(carId);
      if (!car) return null;
      const v = car.group.position.clone().add(new THREE.Vector3(0, 6, 0));
      v.project(camera);
      if (v.z > 1) return null; // behind the camera
      return {
        x: (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth,
        y: (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight,
      };
    },
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', resize);
      track.dispose();
      renderer.dispose();
    },
  };
}
