/**
 * Three.js scene: camera fit to the track, lights, car meshes.
 * Cars are identified by server car id; transforms come from the
 * interpolated (lap, s) stream — the scene itself is dumb.
 */
import * as THREE from 'three';
import { buildTrack } from './track.js';

export const CAR_COLORS = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759',
  '#0a84ff', '#af52de', '#ff2d55', '#e5e5ea',
];

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

export function createSpectatorScene(canvas, trackInfo) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);
  scene.fog = new THREE.Fog(0x0b0e13, 900, 1800);

  const camera = new THREE.PerspectiveCamera(46, 1, 1, 4000);

  // lights (simple: hemisphere + one directional)
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1f28, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(200, 400, 300);
  scene.add(sun);

  const track = buildTrack(scene, trackInfo);

  // fit the camera to the track bounding sphere, tilted from the south
  const samples = [];
  for (let i = 0; i < 200; i += 1) samples.push(track.curve.getPointAt(i / 200));
  const center = new THREE.Vector3();
  for (const p of samples) center.add(p);
  center.divideScalar(samples.length);
  let radius = 0;
  for (const p of samples) radius = Math.max(radius, p.distanceTo(center));
  radius += 25; // margin
  const dir = new THREE.Vector3(0.18, 0.92, 0.6).normalize();
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(23)) * 1.02;
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.lookAt(center);

  const cars = new Map(); // carId -> { group, labelEl, color, lastS, state }

  function addCar(carId, name, slotIndex) {
    const color = CAR_COLORS[slotIndex % CAR_COLORS.length];
    const group = makeCarMesh(color);
    scene.add(group);
    cars.set(carId, { group, color, lastS: null, state: 'RUNNING', name });
    return color;
  }

  function setCar(carId, s, state) {
    const car = cars.get(carId);
    if (!car) return;
    car.lastS = s;
    car.state = state;
    const group = car.group;
    let pos;
    let heading;
    if (state === 'PITTING') {
      // parked in its pit box (pit boxes are assigned in join/grid order)
      const slot = cars.size >= 1 ? [...cars.keys()].indexOf(carId) : 0;
      const box = track.pitBoxes[Math.max(0, Math.min(slot, track.pitBoxes.length - 1))];
      pos = box.position;
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
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
    /** Project a car's world position to screen px for its DOM label. */
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
      renderer.dispose();
    },
  };
}
