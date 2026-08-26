import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROP_TYPES,
  SUPPORTED_VERSION,
  sanitizeTrackDef,
  validateTrackDef,
} from '../client/js/trackContract.js';
import { TRACKS_DIR } from '../src/tracks.js';

/**
 * MCPG-63 — the track contract: a map is a pure-data file that must start a
 * race and render with zero engine changes. These tests pin both sides of
 * that promise: the contract module's rules, and the two enforcement points
 * (server registry fails fast; client loader falls back safely).
 */

/** A minimal conforming v1 map (simple convex octagon, ratio ~0.86). */
function validDef() {
  return {
    version: 1,
    id: 'test-track',
    name: 'Test Track',
    lengthM: 1000,
    sectorLengthM: 200,
    roadWidthM: 12,
    waypoints: [
      [0, 100], [100, 100], [140, 0], [100, -100],
      [0, -100], [-100, -60], [-140, 0], [-100, 60],
    ],
    theme: {
      sky: '#5ecdf6',
      ground: { base: '#f6de9a', spot: '#e3c276' },
      road: { base: '#4a4f5e', spot: '#454a57' },
      pit: '#98a0b0',
      ambient: { sky: '#d8f4ff', ground: '#e8cf8e' },
      sun: { color: '#fff3d6' },
    },
  };
}

describe('track contract v1 (MCPG-63)', () => {
  it('accepts a minimal conforming map with no errors or warnings', () => {
    const r = validateTrackDef(validDef());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('every shipped tracks/*.json conforms and matches its file name', () => {
    const files = fs.readdirSync(TRACKS_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(TRACKS_DIR, f), 'utf8'));
      const r = validateTrackDef(raw);
      if (!r.ok || r.warnings.length > 0) console.log(`${f}:`, r.errors, r.warnings);
      expect(r.ok, `${f}: ${r.errors.join('; ')}`).toBe(true);
      expect(r.warnings, `${f}: ${r.warnings.join('; ')}`).toEqual([]);
      expect(raw.version).toBe(SUPPORTED_VERSION);
      expect(raw.id, `${f}: id must equal the file stem`).toBe(f.replace(/\.json$/, ''));
    }
  });

  // --- version gate -------------------------------------------------------
  it('refuses missing and unsupported major versions with clear messages', () => {
    const missing = validDef();
    delete missing.version;
    expect(validateTrackDef(missing).errors.join(' ')).toMatch(/version.*missing/);

    const newer = { ...validDef(), version: SUPPORTED_VERSION + 1 };
    expect(validateTrackDef(newer).ok).toBe(false);
    expect(validateTrackDef(newer).errors.join(' ')).toMatch(/newer than this engine/);
  });

  // --- identity + geometry --------------------------------------------------
  it('rejects malformed identity fields', () => {
    for (const [patch, field] of [
      [{ id: 'Bad_Id' }, 'id'],
      [{ name: '' }, 'name'],
      [{ lengthM: -5 }, 'lengthM'],
      [{ sectorLengthM: 0 }, 'sectorLengthM'],
      [{ roadWidthM: undefined }, 'roadWidthM'],
    ]) {
      const def = { ...validDef(), ...patch };
      const r = validateTrackDef(def);
      expect(r.ok, JSON.stringify(patch)).toBe(false);
      expect(r.errors.join(' '), JSON.stringify(patch)).toContain(field);
    }

    const uneven = validDef();
    uneven.sectorLengthM = 300;
    expect(validateTrackDef(uneven).errors.join(' ')).toMatch(/sectorLengthM/);
  });

  it('rejects degenerate waypoint sets: too few, non-numeric, cramped, crossing, mis-scaled', () => {
    const few = validDef();
    few.waypoints = few.waypoints.slice(0, 4);
    expect(validateTrackDef(few).errors.join(' ')).toMatch(/at least 6/);

    const nan = validDef();
    nan.waypoints[2] = ['x', 0];
    expect(validateTrackDef(nan).errors.join(' ')).toMatch(/waypoints\[2\]/);

    const cramped = validDef();
    cramped.waypoints = [...cramped.waypoints, [(cramped.waypoints.at(-1)[0] + 1), cramped.waypoints.at(-1)[1]]];
    const rCramped = validateTrackDef(cramped);
    expect(rCramped.ok).toBe(false);
    expect(rCramped.errors.join(' ')).toMatch(/2 m apart/);

    // bowtie loop: segments cross at the center
    const bowtie = validDef();
    bowtie.waypoints = [
      [-100, -50], [100, 50], [100, -50], [-100, 50],
      [-90, -80], [90, 80], [90, -80], [-90, 80],
    ];
    const rBowtie = validateTrackDef(bowtie);
    expect(rBowtie.ok).toBe(false);
    expect(rBowtie.errors.join(' ')).toMatch(/cross|self-intersect/i);

    const squashed = validDef();
    squashed.waypoints = squashed.waypoints.map(([x, z]) => [x * 20, z * 20]);
    const rSquashed = validateTrackDef(squashed);
    expect(rSquashed.ok).toBe(false);
    expect(rSquashed.errors.join(' ')).toMatch(/perimeter/);
  });

  // --- theme -----------------------------------------------------------------
  it('requires the palette the renderer dereferences directly', () => {
    const def = validDef();
    delete def.theme.pit;
    expect(validateTrackDef(def).errors.join(' ')).toMatch(/theme\.pit/);

    const badColor = validDef();
    badColor.theme.sky = 'red';
    expect(validateTrackDef(badColor).errors.join(' ')).toMatch(/theme\.sky/);

    const badGround = validDef();
    delete badGround.theme.ground.base;
    expect(validateTrackDef(badGround).errors.join(' ')).toMatch(/theme\.ground\.base/);

    const badCurb = validDef();
    badCurb.theme.curb = {};
    expect(validateTrackDef(badCurb).errors.join(' ')).toMatch(/curb\.red/);
  });

  // --- tolerance (forward compatibility) ---------------------------------------
  it('warns about unknown fields/types/features instead of failing', () => {
    const def = validDef();
    def.somethingNew = { fancy: true };
    def.theme.neonSky = '#ffffff';
    def.features = ['weather-zones'];
    def.props = [
      { type: 'dronePad', x: 10, z: 10 },
      { type: 'palm', x: 20, z: -20 },
    ];
    def.scatter = { type: 'kiosk', count: 5 };

    const r = validateTrackDef(def);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('somethingNew'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('theme.neonSky'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('weather-zones'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('dronePad'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('scatter.type'))).toBe(true);
  });

  it('sanitizes unknown fields/types away but keeps everything known', () => {
    const def = validDef();
    def.somethingNew = 1;
    def.theme.neonSky = '#ffffff';
    def.props = [
      { type: 'dronePad', x: 10, z: 10 },
      { type: 'palm', x: 20, z: -20 },
    ];

    const snapshot = structuredClone(def);
    const clean = sanitizeTrackDef(def);

    expect(def, 'input must not be mutated').toEqual(snapshot);
    expect(clean.somethingNew).toBeUndefined();
    expect(clean.theme.neonSky).toBeUndefined();
    expect(clean.theme.pit).toBe('#98a0b0');
    expect(clean.props).toEqual([{ type: 'palm', x: 20, z: -20 }]);
    expect(clean.waypoints).toEqual(def.waypoints);
    expect(clean.id).toBe('test-track');
  });

  // --- props / scatter ---------------------------------------------------------
  it('validates known prop types strictly while catalog stays honest', () => {
    const def = validDef();
    def.props = [{ type: 'grandstand', x: 10, z: 10, w: 'wide' }];
    expect(validateTrackDef(def).errors.join(' ')).toMatch(/grandstand.*w|props\[0\]\.w/);

    const noPos = validDef();
    noPos.props = [{ type: 'rock' }];
    expect(validateTrackDef(noPos).errors.join(' ')).toMatch(/props\[0\]/);

    // every catalog param is accepted on a well-formed prop
    const full = validDef();
    full.props = [
      { type: 'building', x: 1, z: 2, rot: 0.5, y: 0, w: 24, d: 24, h: 40, color: '#aabbcc', neon: '#ff2d55' },
    ];
    expect(validateTrackDef(full).errors).toEqual([]);
    for (const t of Object.keys(PROP_TYPES)) {
      const one = validDef();
      one.props = [{ type: t, x: 1, z: 2 }];
      expect(validateTrackDef(one).errors, t).toEqual([]);
    }
  });

  it('warns when water discs have no color and when the perf budget bursts', () => {
    const dry = validDef();
    dry.water = [{ x: 0, z: 30, r: 20 }];
    const rDry = validateTrackDef(dry);
    expect(rDry.ok).toBe(true);
    expect(rDry.warnings.join(' ')).toMatch(/theme\.water/);

    const wet = validDef();
    wet.water = [{ x: 0, z: 30, r: 20 }];
    wet.theme.water = '#19b8c9';
    expect(validateTrackDef(wet).warnings).toEqual([]);

    const many = validDef();
    many.scatter = { type: 'pine', count: 500 };
    const rMany = validateTrackDef(many);
    expect(rMany.ok).toBe(true);
    expect(rMany.warnings.join(' ')).toMatch(/perf budget/);
  });

  // --- client enforcement point -----------------------------------------------
  it('client loader falls back to the legacy ring on a contract violation', async () => {
    const { LEGACY_DEF, loadTrackDef } = await import('../client/js/tracks.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    afterEach(() => warnSpy.mockRestore());

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => {
        const broken = validDef();
        delete broken.theme.pit; // renders garbage silently before the contract
        return broken;
      },
    }));
    try {
      const def = await loadTrackDef({ id: 'broken-map', name: 'Broken', lengthM: 1000 });
      expect(def).toBe(LEGACY_DEF);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('invalid track contract'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
    }
  });

  it('client loader hands through a sanitized conforming map', async () => {
    const { loadTrackDef } = await import('../client/js/tracks.js');
    const good = { ...validDef(), somethingNew: 1 };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => good }));
    try {
      const def = await loadTrackDef({ id: 'test-track', name: 'Server Name', lengthM: 1200 });
      expect(def.id).toBe('test-track');
      expect(def.name).toBe('Server Name'); // server numbers stay authoritative
      expect(def.lengthM).toBe(1200);
      expect(def.somethingNew).toBeUndefined(); // stripped before the scene sees it
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
