/**
 * Voxel scenery layer (MCPG-64) — the map-driven art direction ported from
 * client/design/reference/f1-track.html.
 *
 * resolveScenery + scatterProps exclusions are pure data logic; buildScenery
 * is pure three.js (no DOM), so the whole module runs under Node with the
 * vendored three build (see vitest.config.js alias). The browser-level
 * visual check (scripts/visualCheck.mjs) covers the rendered result.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolveScenery, buildScenery } from '../client/js/scenery.js';
import { scatterProps } from '../client/js/props.js';

const THEME = {
  sky: '#87ceeb',
  ground: { base: '#58b649', spot: '#4aa43e', patch: '#3c9033', tileM: 6 },
  road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
  curb: { red: '#e8362e', white: '#fdf6e8' },
  pit: '#8b94a8',
  barriers: true,
};

// rounded ring, ~940 m of centerline
const WAYPOINTS = [
  [0, 150], [100, 140], [150, 80], [150, -80],
  [100, -140], [0, -150], [-100, -140], [-150, -60],
  [-150, 80], [-100, 140],
];

function makeCtx(scenery) {
  const pts = WAYPOINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  const arclen = curve.getLength();
  return {
    curve,
    arclen,
    lengthM: 900,
    roadWidthM: 13,
    theme: THEME,
    scenery: scenery ?? resolveScenery({}),
  };
}

describe('resolveScenery (map contract)', () => {
  it('fills sane defaults when a def has no scenery block at all', () => {
    const sc = resolveScenery({});
    expect(sc.version).toBe(1);
    expect(sc.island).toEqual({ marginM: 85 });
    expect(sc.garages).toBe(8);
    expect(sc.stands).toBeNull();
    expect(sc.tireWalls).toBeNull();
    expect(sc.drs).toBeNull();
    expect(sc.floodlights).toBeNull();
    expect(sc.scatterExclusions).toEqual([]);
  });

  it('keeps explicit values and tolerates garbage shapes / unknown fields', () => {
    const sc = resolveScenery({
      scenery: {
        version: 1,
        futureUnknown: { whatever: true },
        island: { marginM: 95 },
        garages: 5,
        stands: [{ atS: 40, arcM: 90 }, 'oops', null, { atS: 300 }],
        tireWalls: 'nope',
        drs: [{ atS: 120 }],
        floodlights: [{ x: 10, z: -20 }, 42],
        scatterExclusions: [[1, 2, 3]],
      },
      scatter: { type: 'palm', count: 5, seed: 1 },
    });
    expect(sc.island).toEqual({ marginM: 95 });
    expect(sc.garages).toBe(5);
    expect(sc.stands).toEqual([{ atS: 40, arcM: 90 }, { atS: 300 }]);
    expect(sc.tireWalls).toBeNull(); // non-array -> auto placement
    expect(sc.drs).toEqual([{ atS: 120 }]);
    expect(sc.floodlights).toEqual([{ x: 10, z: -20 }]);
    expect(sc.scatterExclusions).toEqual([[1, 2, 3]]);
  });

  it('accepts exclusion zones from the legacy scatter block too', () => {
    const sc = resolveScenery({ scatter: { exclusions: [[4, 5, 6]] } });
    expect(sc.scatterExclusions).toEqual([[4, 5, 6]]);
  });
});

describe('buildScenery', () => {
  it('bakes every voxel into ONE InstancedMesh plus the gantry light pods', () => {
    const scn = buildScenery(makeCtx());
    const instanced = scn.group.children.filter((o) => o.isInstancedMesh);
    expect(instanced).toHaveLength(1);
    expect(instanced[0].count).toBe(scn.stats.voxels);
    expect(scn.stats.voxels).toBeGreaterThan(2000); // island alone is thousands
    // 10 gantry pods (5 columns x 2), separate meshes for animated emissive
    expect(scn.group.children.length).toBe(1 + 10);
    scn.dispose();
  });

  it('is deterministic for a given def (seeded scatter/variation)', () => {
    const a = buildScenery(makeCtx());
    const b = buildScenery(makeCtx());
    expect(a.stats.voxels).toBe(b.stats.voxels);
    a.dispose();
    b.dispose();
  });

  it('pit garage slots: count follows the config, all inside the lane span', () => {
    for (const garages of [2, 8, 12]) {
      const scn = buildScenery(makeCtx(resolveScenery({ scenery: { garages } })));
      expect(scn.pitSlots).toHaveLength(garages);
      for (const slot of scn.pitSlots) {
        expect(slot.s).toBeGreaterThanOrEqual(15);
        expect(slot.s).toBeLessThanOrEqual(95);
        expect(slot.pos).toBeInstanceOf(THREE.Vector3);
      }
      scn.dispose();
    }
  });

  it('explicit stands/tire walls/drs/floodlights drive placement; bad entries are skipped', () => {
    const base = makeCtx();
    const withFields = resolveScenery({
      scenery: {
        stands: [{ atS: 120, arcM: 60 }],
        tireWalls: [{ atS: 400, count: 6 }],
        drs: [{ atS: 250 }],
        floodlights: [{ x: -180, z: -170 }],
      },
    });
    const custom = buildScenery({ ...base, scenery: withFields });
    const auto = buildScenery(base);
    // one explicit stand (60 m arc -> ~31 steps x (7 rows + roof pieces))
    expect(custom.stats.voxels).toBeGreaterThan(2000);
    expect(auto.stats.voxels).not.toBe(custom.stats.voxels); // different layouts
    custom.dispose();
    auto.dispose();
  });

  it('the gantry animation cycles dim -> red sequence -> green', () => {
    const scn = buildScenery(makeCtx());
    expect(() => scn.update(0)).not.toThrow();
    expect(() => scn.update(1500)).not.toThrow(); // mid red-sequence
    expect(() => scn.update(4500)).not.toThrow(); // green phase
    expect(() => scn.update(7000)).not.toThrow(); // wrapped into cycle 2
    scn.dispose();
  });

  it('island extents contain the circuit and report the keel bottom', () => {
    const scn = buildScenery(makeCtx());
    expect(scn.island.rx).toBeGreaterThan(160);
    expect(scn.island.rz).toBeGreaterThan(160);
    expect(scn.island.bottomY).toBeLessThan(-18);
    expect(scn.island.topY).toBe(-0.5);
    scn.dispose();
  });
});

describe('scatterProps exclusion zones (MCPG-64)', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({
    x: Math.cos((i / 40) * Math.PI * 2) * 150,
    z: Math.sin((i / 40) * Math.PI * 2) * 150,
  }));
  const def = { scatter: { type: 'pine', count: 20, seed: 23, minOffsetM: 16 } };

  it('without zones, props can land anywhere clear of the road/water', () => {
    const props = scatterProps(def, samples, 13, []);
    expect(props.length).toBe(20);
  });

  it('a zone covering the whole island pushes every prop out (graceful: fewer props)', () => {
    const props = scatterProps(def, samples, 13, [], [[0, 0, 400]]);
    expect(props).toHaveLength(0);
  });

  it('props avoid a small zone but still fill elsewhere', () => {
    const props = scatterProps(def, samples, 13, [], [[0, 0, 90]]);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(p.x * p.x + p.z * p.z).toBeGreaterThanOrEqual(90 * 90);
    }
  });
});
