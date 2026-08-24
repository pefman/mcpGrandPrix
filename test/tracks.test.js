import { describe, expect, it } from 'vitest';
import { Track } from '../src/track.js';
import {
  DEFAULT_TRACK_ID,
  createTrackFromEnv,
  getTrackDef,
  loadTrackDefs,
} from '../src/tracks.js';

/**
 * MCPG-27: the `tracks/` registry — JSON definitions are the source of
 * truth for both the server's Track identity and the spectator client's
 * visual scene. All definitions must be structurally valid; the client
 * rescales each centerline to exactly `lengthM`, so loops should be of
 * plausible size (no degenerate waypoints).
 */

function polygonPerimeter(waypoints) {
  let len = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const [x1, z1] = waypoints[i];
    const [x2, z2] = waypoints[(i + 1) % waypoints.length];
    len += Math.hypot(x2 - x1, z2 - z1);
  }
  return len;
}

describe('tracks/ registry (MCPG-27)', () => {
  it('has at least three structurally valid tracks', () => {
    const defs = loadTrackDefs();
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const ids = new Set();
    for (const def of defs) {
      expect(def.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);

      expect(def.lengthM).toBeGreaterThan(0);
      expect(def.lengthM % def.sectorLengthM).toBe(0);
      expect(def.waypoints.length).toBeGreaterThanOrEqual(6);
      for (const wp of def.waypoints) {
        expect(wp).toHaveLength(2);
        expect(wp.every((n) => Number.isFinite(n))).toBe(true);
      }
      // plausible loop size: the client rescales to lengthM, so a wildly
      // off perimeter would mean a squashed or stretched circuit
      const raw = polygonPerimeter(def.waypoints);
      expect(raw).toBeGreaterThan(def.lengthM * 0.35);
      expect(raw).toBeLessThan(def.lengthM * 2.5);

      expect(def.theme.sky).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.theme.ground.base).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.theme.road.base).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.theme.curb.red).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof def.roadWidthM === 'number' && def.roadWidthM > 0).toBe(true);
    }
    for (const id of ['coastal-palm', 'mountain-hairpins', 'city-night']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('getTrackDef finds known ids and returns undefined for unknown ones', () => {
    expect(getTrackDef('coastal-palm').id).toBe('coastal-palm');
    expect(getTrackDef('city-night').id).toBe('city-night');
    expect(getTrackDef('nope')).toBeUndefined();
  });

  it('createTrackFromEnv defaults to the default track id', () => {
    const track = createTrackFromEnv({});
    expect(track.id).toBe(DEFAULT_TRACK_ID);
    expect(track.info()).toMatchObject({
      id: 'coastal-palm',
      lengthM: 1000,
      sectorLengthM: 200,
      sectorCount: 5,
    });
  });

  it('createTrackFromEnv honors MCGP_TRACK and fails fast on unknown ids', () => {
    expect(createTrackFromEnv({ MCGP_TRACK: 'city-night' }).id).toBe('city-night');
    expect(createTrackFromEnv({ MCGP_TRACK: '  mountain-hairpins  ' }).id).toBe('mountain-hairpins');
    expect(() => createTrackFromEnv({ MCGP_TRACK: 'narnia' })).toThrow(/not a known track/);
  });

  it('Track carries the registry id through info()', () => {
    // default stays 'ring' (legacy fallback for the client)
    expect(new Track().id).toBe('ring');
    expect(new Track().info().id).toBe('ring');

    const def = getTrackDef('mountain-hairpins');
    const track = new Track({
      id: def.id,
      name: def.name,
      lengthM: def.lengthM,
      sectorLengthM: def.sectorLengthM,
    });
    expect(track.info()).toEqual({
      id: 'mountain-hairpins',
      name: def.name,
      lengthM: 1000,
      sectorLengthM: 200,
      sectorCount: 5,
    });
    // sim semantics unchanged by the id
    expect(track.lapPosition(1200)).toBe(200);
    expect(track.sectorForPosition(450)).toBe(3);
  });
});
