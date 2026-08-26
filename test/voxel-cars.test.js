/**
 * Voxel cars + sign props (Step 3, MCPG-45) — unit level.
 *
 * The car mesh and the sign builder are pure three.js, so they can be
 * imported straight under Node (vitest aliases `three` to the client's
 * vendored build, same file the browser importmap resolves). What is NOT
 * covered here: the live render + pit-transition tween driven by snapshot
 * state — that lives in test/voxel-cars-browser.test.js.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeCarMesh, CAR_COLORS } from '../client/js/scene.js';
import { buildProp } from '../client/js/props.js';
import { loadTrackDefs } from '../src/tracks.js';

const hex = (c) => `#${new THREE.Color(c).getHexString()}`;

describe('makeCarMesh (MCPG-45 voxel car)', () => {
  const LIVERY = '#ff3b30';

  function parts(group) {
    const meshes = [];
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    return meshes;
  }

  it('is built from plain boxes: body, glass cockpit, splitter, wing, 2 pylons, 4 wheels', () => {
    const g = makeCarMesh(LIVERY);
    expect(g.isGroup).toBe(true);
    const meshes = parts(g);
    expect(meshes).toHaveLength(10);
    for (const m of meshes) expect(m.geometry.type).toBe('BoxGeometry');
    expect(g.scale.x).toBeCloseTo(1.9); // oversized so the car reads at diorama distance
  });

  it('tags exactly body/splitter/wing as livery, painted with the car color', () => {
    const g = makeCarMesh(LIVERY);
    const livery = parts(g).filter((m) => m.userData.livery);
    expect(livery).toHaveLength(3);
    for (const m of livery) expect(hex(m.material.color)).toBe(hex(LIVERY));
  });

  it('has a strong F1 silhouette: nose at +Z, wing at -Z, wheels wider than the body', () => {
    const g = makeCarMesh(LIVERY);
    const meshes = parts(g);
    const byZ = [...meshes].sort((a, b) => a.position.z - b.position.z);
    const tail = byZ[0];   // rear wing
    const nose = byZ.at(-1); // front splitter
    expect(tail.position.z).toBeLessThan(-2);
    expect(nose.position.z).toBeGreaterThan(2);
    // the wing is the tallest part (the silhouette peak)
    const top = [...meshes].sort((a, b) => b.position.y - a.position.y)[0];
    expect(top.position.z).toBeLessThan(0);
    // four wheels, clearly outside the 2.0 m body, on the ground
    const wheels = meshes.filter((m) => Math.abs(m.position.x) > 1);
    expect(wheels).toHaveLength(4);
    for (const w of wheels) {
      expect(hex(w.material.color)).toBe(hex(0x14171d));
      expect(w.geometry.parameters.height).toBeCloseTo(1.05);
      expect(w.position.y).toBeCloseTo(w.geometry.parameters.height / 2);
    }
  });

  const luminance = (h) => {
    const n = parseInt(h.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };

  it('sits on the ground and the cockpit glass is the light part', () => {
    const g = makeCarMesh(LIVERY);
    const meshes = parts(g);
    const box = new THREE.Box3().setFromObject(g);
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    const glass = meshes.filter(
      (m) => hex(m.material.color) !== hex(LIVERY) && hex(m.material.color) !== hex(0x14171d) && hex(m.material.color) !== hex(0x1a1e26),
    );
    expect(glass).toHaveLength(1);
    expect(luminance(hex(glass[0].material.color))).toBeGreaterThan(0.4);
  });

  it('respects the fallback palette contract (CAR_COLORS is 8 distinct hexes)', () => {
    expect(CAR_COLORS).toHaveLength(8);
    expect(Array.from(new Set(CAR_COLORS.map(hex)))).toHaveLength(8);
  });
});

describe('sign prop (MCPG-45 environment; MCPG-66: merged single mesh)', () => {
  // MCPG-66 bakes a prop's colored boxes into one merged vertex-colored
  // geometry (one draw call per prop at full-resolution rendering), so the
  // assertions now check the merged mesh's bounds and vertex colors.
  function vertexColors(geo) {
    const set = new Set();
    const a = geo.attributes.color;
    const c = new THREE.Color();
    for (let i = 0; i < a.count; i++) {
      // attribute holds working-space (linear) values; getHexString()
      // converts back to sRGB for the comparison
      c.setRGB(a.getX(i), a.getY(i), a.getZ(i));
      set.add(`#${c.getHexString()}`);
    }
    return set;
  }
  const hex = (v) => `#${new THREE.Color(v).getHexString()}`;

  it('bakes post + panel into one mesh: 5 m post, 8 m panel near the top', () => {
    const g = buildProp({ type: 'sign', x: 10, z: -20, rot: 1.2 }, { next: () => 0.5, int: () => 1, chance: () => false, pick: (a) => a[0] });
    expect(g).toBeTruthy();
    const meshes = [];
    g.traverse((o) => { if (o.isMesh) meshes.push(o); });
    expect(meshes).toHaveLength(1);
    const box = new THREE.Box3().setFromBufferAttribute(meshes[0].geometry.attributes.position);
    expect(box.max.y - box.min.y).toBeCloseTo(5, 1); // 5 m post
    expect(box.max.x - box.min.x).toBeCloseTo(8, 1); // 8 m wide panel
    const cols = vertexColors(meshes[0].geometry);
    expect(cols).toContain(hex(0xffc53d)); // default amber panel
    expect(cols).toContain(hex(0x3a4152)); // post
    expect(g.position.x).toBe(10);
    expect(g.position.z).toBe(-20);
    expect(g.rotation.y).toBeCloseTo(1.2);
  });

  it('honors per-placement size and color overrides', () => {
    const g = buildProp({ type: 'sign', x: 0, z: 0, w: 12, h: 7, color: '#0a84ff' }, { next: () => 0.5, int: () => 1, chance: () => false, pick: (a) => a[0] });
    const meshes = [];
    g.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const box = new THREE.Box3().setFromBufferAttribute(meshes[0].geometry.attributes.position);
    expect(box.max.y - box.min.y).toBeCloseTo(7, 1);
    expect(box.max.x - box.min.x).toBeCloseTo(12, 1);
    expect(vertexColors(meshes[0].geometry)).toContain('#0a84ff');
  });

  it('unknown prop types still build nothing', () => {
    expect(buildProp({ type: 'hovercraft', x: 0, z: 0 }, { next: () => 0.5, int: () => 1, chance: () => false, pick: (a) => a[0] })).toBeNull();
  });
});

describe('track registry signs (MCPG-45)', () => {
  it('every track carries at least two roadside signs with valid placements', () => {
    for (const def of loadTrackDefs()) {
      const signs = def.props.filter((p) => p.type === 'sign');
      expect(signs.length, `${def.id} signs`).toBeGreaterThanOrEqual(2);
      for (const s of signs) {
        expect(Number.isFinite(s.x), `${def.id} sign x`).toBe(true);
        expect(Number.isFinite(s.z), `${def.id} sign z`).toBe(true);
        if (s.color) expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
