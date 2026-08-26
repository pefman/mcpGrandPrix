/**
 * Flat-ribbon u-clamp guard (MCPG-69).
 *
 * The engine rescales a track's waypoints so the fitted curve's measured
 * length matches `lengthM`, but the rescaled length lands within ~1e-12 m of
 * it on EITHER side depending on the geometry (a per-track FP coin flip,
 * deterministic per vendored three build). When it lands BELOW, a full-lap
 * ribbon (road, curb, rumble, sector ticks) gets u1 = lengthM/arclen > 1.
 * three.js `getUtoTmapping(u > 1)` reads one element past its arc-length
 * table and returns NaN; `getPoint(NaN)` then throws
 * "Cannot read properties of undefined (reading 'distanceToSquared')" and
 * the spectator page goes blank on load.
 *
 * Hand-authored maps happened to sit on the safe side; procedurally
 * generated tracks (MCPG-69) hit the edge ~half the time. The clamp in
 * flatRibbon (client/js/track.js) keeps every sample u in [0,1]; this test
 * pins it two ways:
 *
 *   1. synthetic: a ribbon with u1 just above 1 must not throw (pre-fix it
 *      threw the exact pageerror from the MCPG-69 research);
 *   2. every shipped tracks/*.json through the engine's OWN curve + measured
 *      arclen (the production boundary values). Tracks on the short side
 *      exercise the clamp on real data — reported via console so a future
 *      merged generated pack re-locks the guard automatically.
 *
 * Pure three.js geometry (no DOM), runs under Node via the vendored three
 * build (see vitest.config.js alias), same pattern as scenery.test.js.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrackCurve, flatRibbon } from '../client/js/track.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracks = fs
  .readdirSync(path.join(root, 'tracks'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'tracks', f), 'utf8')));

describe('flatRibbon u-clamp (MCPG-69)', () => {
  it('tolerates u1 > 1 (measured length a hair below lengthM)', () => {
    const def = tracks.find((d) => d.id === 'coastal-palm') ?? tracks[0];
    const curve = createTrackCurve(def, def.lengthM);
    const arclen = curve.getLength();
    // last sample of a full-lap arc when arclen lands below lengthM:
    const u1 = 1 + 1e-9;
    const geo = flatRibbon(curve, arclen, 0, u1, { widthM: def.roadWidthM, segs: 16 });
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe((16 + 1) * 2); // every sample produced both vertices
  });

  it('builds full-lap road ribbons for every shipped track without throwing', () => {
    const shortSide = [];
    for (const def of tracks) {
      const curve = createTrackCurve(def, def.lengthM);
      const arclen = curve.getLength();
      const u1 = def.lengthM / arclen; // exactly what ribbonOnArc computes
      if (arclen < def.lengthM) shortSide.push(`${def.id} (${(arclen - def.lengthM).toExponential(2)} m)`);
      const geo = flatRibbon(curve, arclen, 0, u1, { widthM: def.roadWidthM, segs: 64 });
      expect(geo.getAttribute('position').count).toBe((64 + 1) * 2);
    }
    console.log(`trackRibbonClamp: ${tracks.length} tracks checked, on the short (arclen < lengthM) side: ${shortSide.length ? shortSide.join(', ') : 'none (synthetic case above still pins the clamp)'}`);
  });
});