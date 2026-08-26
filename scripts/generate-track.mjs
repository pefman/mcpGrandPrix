#!/usr/bin/env node
/**
 * Procedural track generator (MCPG-69) — authoring tool.
 *
 * Produces contract-conformant map files (tracks/<id>.json) in bulk:
 * seed -> JSON -> validator -> visual check -> screenshot approval.
 * The game engine, sim and network layer are untouched; the output is a
 * static JSON file exactly like the hand-authored maps.
 *
 * APPROACH (research: MCPG-69, Leclerc) — ring + low-frequency harmonic
 * radial profile + seeded feature editing:
 *   base loop = control points on a ring, r = R * (1 + sum a_k sin(f_k th + p_k))
 *   (frequencies 2-5, small amplitudes) -> the loop is STAR-SHAPED about the
 *   origin, which makes a self-intersection-free closed curve GUARANTEED by
 *   construction (monotone angles, positive radii). A seeded feature pass
 *   then carves DRS straights (chord flattening), hairpins (inward bays)
 *   and chicanes (alternating radius) at non-overlapping slots.
 *   lengthM = fitted spline length (same THREE.CatmullRomCurve3 the engine
 *   fits) rounded to a multiple of 100, clamped 800-1300 m; waypoints are
 *   pre-scaled so the engine's own rescale is a ~1.0 no-op.
 *   sectorLengthM = lengthM / 5 (the shipped 5-sector convention; always an
 *   even divisor since lengthM is a multiple of 100).
 *
 * DETERMINISM: same seed + style => byte-identical JSON (all randomness
 * through src/rng.js mulberry32, all spline math through the vendored
 * three build the engine ships with). A track is shareable as one integer.
 *
 * USAGE
 *   node scripts/generate-track.mjs --seed 42 --style flow --out tracks/breeze-cove.json
 *   node scripts/generate-track.mjs --seed 42 --style flow --out tracks/ --id breeze-cove --name "Breeze Cove"
 *   node scripts/generate-track.mjs --seed 7 --style city --palette rain-midnight --out tracks/
 *   node scripts/generate-track.mjs --pack 20 --style auto --out tracks/   # stage a pack
 *
 * WORKFLOW (pack -> ship)
 *   1. generate a pack (staged into tracks/, ids gen-<style>-<seed6>)
 *   2. node scripts/validate-tracks.mjs        # every file, in-process contract
 *   3. node scripts/visualCheck.mjs            # real server + agents + headless Chromium
 *                                              #    -> .visual/<id>.png screenshots
 *   4. Peter picks 2-3 from the screenshots; the picks are renamed
 *      (--id/--name) and kept, the rest of the pack is deleted
 *   5. node scripts/validate-tracks.mjs && a 5-lap smoke race per merged map:
 *        MCGP_TRACK=<id> node scripts/runRace.js
 *
 * Output: <out>/<id>.json per map (validator-conformant when it passes),
 * plus a quality table: spline length, longest straight (m), curb-corner
 * count, min turn radius, max coordinate.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from '../client/vendor/three.module.js';
import { createRng } from '../src/rng.js';
import { validateTrackDef } from '../client/js/trackContract.js';

// ---------------------------------------------------------------- styles ---
// Per style: ring params, feature mix, road width, palette variants, scatter.
// Two curated palettes per style: one reuses a shipped, render-proven palette
// (coastal day / alpine day / night neon), one is new (dusk lagoon, dusk
// canyon, rain midnight).
const STYLES = {
  flow: {
    roadWidthM: 13,
    nRange: [16, 20],
    rRange: [115, 135],
    harmAmps: [0.08, 0.2], // per-harmonic amplitude bounds (fraction of R)
    nHarmonics: 2,
    features: { straight: [1, 2], chicane: [1, 2], hairpin: [0, 1] },
    scatter: { type: 'palm', count: [24, 40] },
    water: true,
    palettes: [
      { // day coastal (from coastal-palm, proven)
        sky: '#5ecdf6',
        ground: { base: '#f6de9a', spot: '#e3c276', patch: '#d3ab5e', tileM: 6 },
        road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
        curb: { red: '#e8362e', white: '#fdf6e8', threshold: 0.02 },
        pit: '#98a0b0', barriers: true,
        ambient: { sky: '#d8f4ff', ground: '#e8cf8e', intensity: 0.75 },
        sun: { color: '#fff3d6', intensity: 1 },
        water: '#19b8c9', fxAccent: '#ffd166',
      },
      { // dusk lagoon
        sky: '#3d4b8d',
        ground: { base: '#c8b06a', spot: '#b39d5c', patch: '#9d8a4e', tileM: 6 },
        road: { base: '#474c5c', spot: '#424756', tileM: 3 },
        curb: { red: '#e8542e', white: '#f7ead2', threshold: 0.02 },
        pit: '#8f93a6', barriers: true,
        ambient: { sky: '#7d86c9', ground: '#6f6a4a', intensity: 0.85 },
        sun: { color: '#ffb27d', intensity: 0.9 },
        water: '#2e6f8f', fxAccent: '#ffb35c',
      },
    ],
    paletteNames: ['coastal-day', 'lagoon-dusk'],
    nameAdj: ['Breeze', 'Lagoon', 'Palm', 'Tide', 'Meadow', 'Drift'],
    nameNoun: ['Bay', 'Cove', 'Meadows', 'Shoreline', 'Gardens', 'Ridge'],
  },
  technical: {
    roadWidthM: 12,
    nRange: [20, 28],
    rRange: [120, 140],
    harmAmps: [0.12, 0.3],
    nHarmonics: 3,
    features: { straight: [1, 2], chicane: [1, 2], hairpin: [2, 3] },
    scatter: { type: 'pine', count: [30, 60] },
    water: false,
    palettes: [
      { // day alpine (from mountain-hairpins, proven)
        sky: '#7fb5ea',
        ground: { base: '#58b649', spot: '#4aa43e', patch: '#3c9033', tileM: 6 },
        road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
        curb: { red: '#e8362e', white: '#fdf6e8' },
        pit: '#8b94a8', barriers: true,
        ambient: { sky: '#d9ecff', ground: '#4a8f3c', intensity: 0.75 },
        sun: { color: '#fff6e0', intensity: 1 },
        fxAccent: '#7de8ff',
      },
      { // dusk canyon
        sky: '#7d4a2e',
        ground: { base: '#b3804a', spot: '#a06f3e', patch: '#8f6236', tileM: 6 },
        road: { base: '#454a58', spot: '#404552', tileM: 3 },
        curb: { red: '#e8542e', white: '#f7ead2' },
        pit: '#8f93a6', barriers: true,
        ambient: { sky: '#d98a5c', ground: '#7a5a38', intensity: 0.85 },
        sun: { color: '#ffb27d', intensity: 1 },
        fxAccent: '#ffd166',
      },
    ],
    paletteNames: ['alpine-day', 'canyon-dusk'],
    nameAdj: ['Aiguille', 'Canyon', 'Serpent', 'Granite', 'Switchback', 'Col de'],
    nameNoun: ['Pass', 'Gorge', 'Ridge', 'Saddle', 'Col', 'Ravine'],
  },
  city: {
    roadWidthM: 13,
    nRange: [18, 24],
    rRange: [100, 120],
    harmAmps: [0.1, 0.26],
    nHarmonics: 3,
    features: { straight: [1, 2], chicane: [2, 3], hairpin: [1, 2] },
    scatter: { type: 'lamp', count: [12, 24] },
    water: false,
    buildings: true,
    palettes: [
      { // night neon (from city-night, proven)
        sky: '#0a0d1a',
        ground: { base: '#646a7a', spot: '#767c8e', patch: '#535868', tileM: 5 },
        road: { base: '#9598a8', spot: '#9ea1b1', tileM: 3 },
        curb: { red: '#ff2f4e', white: '#f2f2f8' },
        pit: '#b3b4c4', barriers: true,
        ambient: { sky: '#4a5584', ground: '#1a1e2e', intensity: 2.4 },
        sun: { color: '#8fa3ff', intensity: 2 },
        fxAccent: '#ffb35c',
      },
      { // rain midnight
        sky: '#0d1420',
        ground: { base: '#4d5468', spot: '#5a6178', patch: '#41485c', tileM: 5 },
        road: { base: '#7e8394', spot: '#878c9e', tileM: 3 },
        curb: { red: '#ff2f4e', white: '#e8ecf4' },
        pit: '#9a9db0', barriers: true,
        ambient: { sky: '#3c4a74', ground: '#151a28', intensity: 2.6 },
        sun: { color: '#6fa8ff', intensity: 1.6 },
        water: '#27405e', fxAccent: '#7de8ff',
      },
    ],
    paletteNames: ['neon-night', 'rain-midnight'],
    nameAdj: ['Neon', 'Metro', 'Midnight', 'Riverside', 'Grand', 'Static'],
    nameNoun: ['Circuit', 'Metro', 'Boulevard', 'Spurs', 'Grid', 'Exchange'],
  },
};

const ALL_STYLES = Object.keys(STYLES);
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

function pickCount(rng, [lo, hi]) {
  return rng.int(lo, hi);
}

/** Even angular spans (in index space) that don't overlap; returns [{i0, i1}]. */
function featureSlots(rng, n, features) {
  const total = Object.values(features).reduce(
    (a, f) => a + pickCount(rng, f), 0);
  const slots = [];
  let guard = 0;
  while (slots.length < total && guard++ < 200) {
    const spanLen = rng.int(3, 6); // number of points covered
    const i0 = rng.int(0, n - 1);
    const i1 = i0 + spanLen;
    // no overlap (circular) with existing slots, keep a gap of >= 2 points
    const ok = slots.every((s) => {
      const gap = (i1 % n + n - (s.i1 % n) + n) % n || n;
      return Math.min(gap, n - gap) >= 3;
    });
    if (ok) slots.push({ i0: i0 % n, i1: i1 % n });
  }
  return slots;
}

/**
 * Base ring + feature editing. Returns { pts: [[x,z]...], n }.
 * Star-shaped about the origin: angles monotone, radii > 0 => simple loop.
 */
function buildLoop(rng, style) {
  const n = pickCount(rng, style.nRange);
  const R = rng.int(style.rRange[0], style.rRange[1]);

  // harmonic radial profile (low frequencies only -> smooth, blob-free)
  const harmonics = [];
  for (let k = 0; k < style.nHarmonics; k++) {
    harmonics.push({
      f: rng.int(2, 5),
      a: style.harmAmps[0] + rng.next() * (style.harmAmps[1] - style.harmAmps[0]) / style.nHarmonics,
      p: rng.next() * Math.PI * 2,
    });
  }
  const harmonic = (th) =>
    1 + harmonics.reduce((s, h) => s + h.a * Math.sin(h.f * th + h.p), 0);

  const step = (Math.PI * 2) / n;
  const theta = [];
  const radius = [];
  for (let i = 0; i < n; i++) {
    theta.push(i * step + (rng.next() - 0.5) * step * 0.5); // mild angular jitter
    radius.push(R * harmonic(theta[i]));
  }

  // --- feature pass ---
  // straight-feature interior points: exact chord positions (radius ignored)
  const chordPts = {};

  const types = [];
  for (const [t, range] of Object.entries(style.features)) {
    for (let k = 0; k < pickCount(rng, range); k++) types.push(t);
  }
  const slots = featureSlots(rng, n, style.features);

  slots.forEach((slot, fi) => {
    const type = types[fi];
    const { i0, i1 } = slot;
    const span = []; // index -> local t in [0,1] along feature span
    for (let i = i0; i <= i1; i++) {
      const idx = i % n;
      span.push([idx, (i - i0) / (i1 - i0)]);
    }
    if (type === 'straight') {
      // pin the span's endpoints on the circle, pull interior points onto
      // the chord -> a long near-zero-curvature run (DRS/overtaking zone)
      const p0 = [Math.cos(theta[i0 % n]) * radius[i0 % n], Math.sin(theta[i0 % n]) * radius[i0 % n]];
      const p1 = [Math.cos(theta[i1 % n]) * radius[i1 % n], Math.sin(theta[i1 % n]) * radius[i1 % n]];
      for (const [idx, t] of span) {
        if (t === 0 || t === 1) continue; // endpoints stay on the ring
        chordPts[idx] = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
      }
    } else if (type === 'hairpin') {
      const bayR = R * (0.26 + rng.next() * 0.14);
      for (const [idx, t] of span) {
        const edge = Math.min(t, 1 - t); // 0..0.5
        radius[idx] = edge < 0.34 ? bayR : radius[idx] * 0.92; // smooth shoulder
      }
    } else if (type === 'chicane') {
      const amp = R * (0.1 + rng.next() * 0.06);
      let alt = 1;
      for (const [idx, t] of span) {
        if (t === 0 || t === 1) continue;
        radius[idx] = R + alt * amp;
        alt *= -1;
      }
    }
  });

  const pts = [];
  for (let i = 0; i < n; i++) {
    if (chordPts[i]) pts.push([r1(chordPts[i][0]), r1(chordPts[i][1])]);
    else {
      const r = radius[i];
      pts.push([r1(Math.cos(theta[i]) * r), r1(Math.sin(theta[i]) * r)]);
    }
  }
  return { pts, n };
}

/** Engine-identical spline (closed centripetal Catmull-Rom, same class). */
function makeCurve(pts) {
  const v3 = pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  return new THREE.CatmullRomCurve3(v3, true, 'centripetal', 0.5);
}

/** Same curvature metric as client/js/track.js curvatureSamples(). */
function curvatureProfile(curve, arclen, samples = 240) {
  const out = [];
  const t0 = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  for (let i = 0; i < samples; i++) {
    t0.copy(curve.getTangentAt(i / samples));
    t1.copy(curve.getTangentAt((i + 1) / samples));
    const ang = Math.acos(THREE.MathUtils.clamp(t0.dot(t1), -1, 1));
    out.push(ang / (arclen / samples));
  }
  return out;
}

function longestRun(values, thresh, arclen, minLenM = 0) {
  const ds = arclen / values.length;
  let best = 0, cur = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= thresh) { cur += ds; best = Math.max(best, cur); }
    else cur = 0;
  }
  return best >= minLenM ? best : 0;
}

function countHotRuns(curv, arclen, threshold, minRunM) {
  const ds = arclen / curv.length;
  let count = 0, run = 0;
  for (let i = 0; i < curv.length; i++) {
    if (curv[i] >= threshold) { run += ds; }
    else { if (run >= minRunM) count++; run = 0; }
  }
  if (run >= minRunM) count++;
  return count;
}

/**
 * Generate one track definition for a seed + style.
 * `overrides` = { id?, name? } for maps that get merged (friendly ids).
 */
function generate(seed, styleName, overrides = {}, paletteIndex = null) {
  const style = STYLES[styleName];
  const rng = createRng(seed);

  const { pts, n } = buildLoop(rng, style);

  // center on origin (engine rescales about the centroid; we do the same)
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= n; cz /= n;
  const centered = pts.map(([x, z]) => [x - cx, z - cz]);

  const raw = makeCurve(centered);
  const rawLen = raw.getLength();
  const lengthM = Math.min(1300, Math.max(800, Math.round(rawLen / 100) * 100));
  const scale = lengthM / rawLen;
  const waypoints = centered.map(([x, z]) => [r1(x * scale), r1(z * scale)]);

  // final curve = what the engine will fit (pre-scaled => engine scale ~ 1)
  const curve = makeCurve(waypoints);
  const arclen = curve.getLength();
  const curv = curvatureProfile(curve, arclen);
  const maxCurv = Math.max(...curv);
  const minTurnRadius = maxCurv > 0.005 ? r1(1 / maxCurv) : 999;
  const straightM = r1(longestRun(curv, 0.01, arclen, 25));
  const curbCorners = countHotRuns(curv, arclen, 0.021, 15);

  // min distance origin -> curve (infield clearance, for water placement)
  let minOrigin = Infinity;
  for (let i = 0; i < 200; i++) {
    const p = curve.getPointAt(i / 200);
    minOrigin = Math.min(minOrigin, Math.hypot(p.x, p.z));
  }

  // water: only when the style allows AND the infield clears it
  const water = [];
  if (style.water) {
    const r = r1(Math.min(45, Math.max(16, minOrigin * 0.55)));
    if (minOrigin > r + 9) water.push({ x: 0, z: 0, r });
  }

  // hand props: signs facing in from the road, a couple near s=0 (start area)
  const props = [];
  const propTypes = style.buildings ? ['sign', 'lamp', 'building'] : ['sign', 'rock', 'palm'];
  const nProps = rng.int(4, 8);
  for (let k = 0; k < nProps; k++) {
    const s = k === 0 ? 12 + rng.next() * 30 : (rng.next() * lengthM + lengthM) % lengthM;
    const p = curve.getPointAt((s % lengthM) / arclen);
    const t = curve.getTangentAt((s % lengthM) / arclen);
    const nrm = { x: -t.z, y: 0, z: t.x }; // outward normal
    const side = rng.chance(0.5) ? 1 : -1;
    const off = style.roadWidthM / 2 + 5 + rng.next() * 10;
    const x = p.x + nrm.x * off * side;
    const z = p.z + nrm.z * off * side;
    const type = k < 2 ? 'sign' : rng.pick(propTypes);
    const prop = { type, x: r1(x), z: r1(z) };
    if (type === 'sign') prop.rot = r2(Math.atan2(-nrm.x * side, -nrm.z * side));
    if (type === 'building') { prop.h = rng.int(24, 70); prop.w = rng.int(18, 30); prop.d = rng.int(18, 30); }
    props.push(prop);
  }

  // Draw once unconditionally so the downstream RNG stream (props, scatter
  // seed, generated name) is identical whether or not a palette is forced;
  // only the chosen palette changes. Keeps a --palette run diff-able against
  // its auto-pick twin.
  const autoPalette = rng.pick(style.palettes);
  const palette = paletteIndex != null ? style.palettes[paletteIndex] : autoPalette;

  const name = overrides.name ?? `${rng.pick(style.nameAdj)} ${rng.pick(style.nameNoun)}`;

  const def = {
    version: 1,
    id: overrides.id ?? `gen-${styleName}-${String(seed).padStart(6, '0')}`,
    name,
    lengthM,
    sectorLengthM: lengthM / 5,
    roadWidthM: style.roadWidthM,
    waypoints,
    water,
    theme: palette,
    props,
    scatter: {
      type: style.scatter.type,
      count: pickCount(rng, style.scatter.count),
      seed: (seed * 7 + 13) >>> 0,
    },
  };
  return { def, stats: {
    waypoints: n,
    splineM: r1(rawLen),
    straightM,
    curbCorners,
    minTurnRadius,
    maxCoord: Math.max(...waypoints.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z)))),
  } };
}

// -------------------------------------------------------------------- CLI ---
function fail(msg) {
  console.error(`generate-track: ${msg}`);
  console.error('usage: node scripts/generate-track.mjs [--seed N] [--style flow|technical|city|auto] ' +
    '[--out <file.json|dir>] [--pack K] [--id ID] [--name NAME] [--palette NAME|IDX]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 34).join('\n'));
  process.exit(0);
}
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(getArg('--seed') ?? '1');
const styleArg = getArg('--style') ?? 'auto';
const outPath = path.resolve(getArg('--out') ?? 'out');
const pack = Number(getArg('--pack') ?? '1');
const idOverride = getArg('--id');
const nameOverride = getArg('--name');
const paletteArg = getArg('--palette');

if (!Number.isInteger(seed) || seed < 0) fail(`--seed must be a non-negative integer (got ${getArg('--seed')})`);
if (pack < 1 || !Number.isInteger(pack)) fail(`--pack must be a positive integer (got ${getArg('--pack')})`);
if (styleArg !== 'auto' && !(styleArg in STYLES)) fail(`unknown --style "${styleArg}" (known: ${ALL_STYLES.join(', ')}, auto)`);
if (idOverride !== undefined && !/^[a-z0-9-]+$/.test(idOverride)) fail(`--id must match /^[a-z0-9-]+$/ (got "${idOverride}")`);
if (pack > 1 && (idOverride !== undefined || nameOverride !== undefined)) fail('--id/--name apply to single-map mode only (--pack 1)');

// --palette selects one of a style's curated palettes (by name or index)
// instead of the seeded auto-pick. Single-map only; needs a concrete style.
let paletteIndex = null;
if (paletteArg !== undefined) {
  if (pack !== 1) fail('--palette applies to single-map mode only (--pack 1)');
  if (styleArg === 'auto') fail('--palette needs a concrete --style (not auto)');
  const s = STYLES[styleArg];
  const numeric = /^\d+$/.test(paletteArg) ? Number(paletteArg) : -1;
  const idx = numeric >= 0 ? numeric : s.paletteNames.indexOf(paletteArg);
  if (idx < 0 || idx >= s.palettes.length) {
    fail(`--palette "${paletteArg}" not found for --style ${styleArg} (known: ${s.paletteNames.join(', ')})`);
  }
  paletteIndex = idx;
}

const singleFile = pack === 1 && outPath.endsWith('.json');
const outDir = singleFile ? path.dirname(outPath) : outPath;
fs.mkdirSync(outDir, { recursive: true });

let pass = 0, failCount = 0;
for (let k = 0; k < pack; k++) {
  const s = seed + k;
  const styleName = styleArg === 'auto' ? ALL_STYLES[s % ALL_STYLES.length] : styleArg;
  // single-file mode: the file name stem is the track id unless --id overrides
  const stem = singleFile ? path.basename(outPath).replace(/\.json$/, '') : null;
  const overrides =
    pack === 1
      ? { id: idOverride ?? (singleFile ? stem : undefined), name: nameOverride }
      : {};
  if (overrides.id !== undefined && !/^[a-z0-9-]+$/.test(overrides.id)) {
    failCount++;
    console.log(`FAIL: track id "${overrides.id}" must match /^[a-z0-9-]+$/`);
    continue;
  }
  const { def, stats } = generate(s, styleName, overrides, paletteIndex);
  const { ok, errors, warnings } = validateTrackDef(def);
  const id = def.id;
  if (!ok) {
    failCount++;
    console.log(`FAIL ${id} style=${styleName}: ${errors.join(' | ')}`);
    continue;
  }
  // registry rule: the file name stem must equal the track id
  const file = singleFile ? outPath : path.join(outDir, `${id}.json`);
  if (path.basename(file) !== `${id}.json`) {
    failCount++;
    console.log(`FAIL ${id}: file must be named ${id}.json (got ${path.basename(file)}); pass --id ${stem} or use a directory --out`);
    continue;
  }
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
  pass++;
  console.log(`PASS ${id} (${def.name}) style=${styleName} L=${def.lengthM}m ` +
    `straights>=25m: ${stats.straightM}m curbCorners: ${stats.curbCorners} ` +
    `minTurnR: ${stats.minTurnRadius}m maxCoord: ${Math.round(stats.maxCoord)}`);
  for (const w of warnings) console.log(`     warning: ${w}`);
}
console.log(`\n${pass} passed / ${failCount} failed -> ${outDir}`);
if (pack === 1 && pass !== 1) process.exit(1);