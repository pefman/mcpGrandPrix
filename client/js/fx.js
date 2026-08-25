/**
 * Race FX (Step 4, MCPG-46) — lightweight, stylized, colorful.
 *
 * A tiny effect system built from ONE shared instanced mesh (instanced
 * boxes). Four effects, all "voxel confetti in a direction":
 *
 *  - overtake  small white/yellow burst at the point of the pass
 *  - pit stop  livery-color chunks dropping into the pit box (a voxel pit
 *              crew + the swapped tires landing)
 *  - race start big green burst across the whole grid
 *  - race finish livery-colored confetti column above the finishing car
 *
 * No per-effect geometry, no textures, no allocation in the hot loop
 * (particle objects come from a free list). Worst case is a few hundred
 * instanced boxes — negligible for the renderer.
 *
 * Effects are purely visual: they read snapshot state, they never feed it
 * back (the sim stays 100% authoritative).
 */
import * as THREE from 'three';

const MAX_PARTICLES = 256;

/**
 * Returns an effect system attached to `scene`.
 *   fx.burst(kind, pos, opts)   spawn a one-shot burst at a world position
 *   fx.update(nowMs)            advance particles (call once per frame)
 *   fx.dispose()                free the instanced mesh
 * `pos` must be a long-lived THREE.Vector3 (it is copied).
 *
 * `theme.fxAccent` (optional, Step 5 MCPG-47): swap the default cyan pop
 * for a theme-appropriate neon — the night city uses warm amber so the
 * bursts read as light against the dark towers.
 */
export function createFx(scene, theme = {}) {
  // effect palettes — saturated, toy-box colors that pop on any theme
  const accent = new THREE.Color(theme.fxAccent ?? 0x7de8ff);
  const PALETTES = {
    overtake: [0xffffff, 0xffe066, accent],
    pit: [0xffc53d, 0xffffff, 0x37e08d],
    start: [0x37e08d, 0xffe066, 0xffffff],
    finish: [0xffe066, 0xffffff, 0xff2d55, accent, 0x37e08d],
  };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
  mesh.count = 0;
  mesh.frustumCulled = false; // particles span the whole track
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // seed instanceColor so the color buffer exists before the first burst
  // (setColorAt auto-allocates, but r158+ wants the usage set on creation)
  const _c = new THREE.Color(0xffffff);
  for (let i = 0; i < MAX_PARTICLES; i++) mesh.setColorAt(i, _c);
  if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  // free list of particle structs (no allocation while running)
  const pool = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    pool.push({
      active: false,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      size: 1,
      spin: 0,          // radians/s, around a fixed per-particle axis
      life: 0,          // remaining seconds
      maxLife: 1,
      gravity: 0,
      color: new THREE.Color(),
      axis: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      pos: new THREE.Vector3(),
      mat4: new THREE.Matrix4(),
    });
  }
  const live = new Set();

  const _m = new THREE.Matrix4();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();

  function spawn(p, kind, pos, { count, speed, spread = 0.3, up = 6, gravity = 22, life = 1.4, size = 3, color = null } = {}) {
    const colors = PALETTES[kind] ?? PALETTES.overtake;
    p.active = true;
    p.x = pos.x + (Math.random() - 0.5) * spread;
    p.y = pos.y + 1 + Math.random() * spread * 0.5;
    p.z = pos.z + (Math.random() - 0.5) * spread;
    const ang = Math.random() * Math.PI * 2;
    const r = speed * (0.35 + Math.random() * 0.65);
    p.vx = Math.cos(ang) * r;
    p.vy = up * (0.6 + Math.random() * 0.8);
    p.vz = Math.sin(ang) * r;
    p.gravity = gravity;
    p.maxLife = life * (0.7 + Math.random() * 0.6);
    p.life = p.maxLife;
    p.size = size * (0.6 + Math.random() * 0.8);
    p.spin = (Math.random() - 0.5) * 14;
    p.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    p.color.set(color ?? colors[Math.floor(Math.random() * colors.length)]);
    p.q.identity();
    p.scale.setScalar(1);
    live.add(p);
  }

  /** One-shot burst; `color` overrides the palette (livery-tinted effects). */
  function burst(kind, pos, opts = {}) {
    const count = Math.min(opts.count ?? 10, MAX_PARTICLES - live.size);
    for (let i = 0; i < count; i++) {
      const free = pool.find((p) => !p.active);
      if (!free) break;
      spawn(free, kind, pos, opts);
    }
  }

  let last = -1;
  function update(nowMs) {
    const dt = last < 0 ? 0 : Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    // horizontal air drag (Step 5, MCPG-47): bursts decelerate instead of
    // drifting linearly — softer, more confetti-like
    const drag = Math.exp(-1.8 * dt);

    for (const p of live) {
      p.life -= dt;
      if (p.life <= 0) {
        live.delete(p);
        p.active = false;
        continue;
      }
      p.vy -= p.gravity * dt;
      p.vx *= drag;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.4) { p.y = 0.4; p.vy = 0; p.vx *= 0.85; p.vz *= 0.85; } // settle on the road
      _e.set(0, 0, 0);
      p.q.setFromAxisAngle(p.axis, p.spin * p.maxLife * (1 - p.life / p.maxLife));
      // pop in over the first twelfth of life, shrink out during the last third
      const t = p.life / p.maxLife;
      const pop = (1 - t) < 0.12 ? 0.5 + 0.5 * ((1 - t) / 0.12) : 1;
      const s = p.size * (t < 0.35 ? t / 0.35 : 1) * pop;
      p.pos.set(p.x, p.y, p.z);
      _s.set(s, s, s);
      p.mat4.compose(p.pos, p.q, _s);
    }

    let i = 0;
    for (const p of live) {
      mesh.setMatrixAt(i, p.mat4);
      mesh.setColorAt(i, p.color);
      i += 1;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
    mesh.dispose();
  }

  return { burst, update, dispose, liveCount: () => live.size };
}
