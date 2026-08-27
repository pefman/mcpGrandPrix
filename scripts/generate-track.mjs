#!/usr/bin/env node
/**
 * Procedural track generator (MCPG-69 / MCPG-72 tuning run) — authoring tool.
 *
 * Produces contract-conformant map files (tracks/<id>.json) in bulk:
 * seed -> JSON -> validator -> visual check -> screenshot approval.
 * The game engine, sim and network layer are untouched; the output is a
 * static JSON file exactly like the hand-authored maps.
 *
 * APPROACH (MCPG-72 tuning run, Leclerc research) — closed STRAIGHT+CORNER
 * SPINE (replaces the MCPG-69 ring+harmonic approach):
 *   K star-shaped anchors at monotonically increasing angles about the
 *   origin (radius jitter +/- 10%) -> simple-loop guarantee (same class
 *   as the old ring, so the contract's self-intersection check stays a
 *   reliable safety net).
 *   ONE wide angular window across the seam is the MAIN STRAIGHT
 *   (~105-145 deg, chord ~200-350 m). All anchors inside that window are
 *   pulled onto the chord; the chord's midpoint is forced to waypoint 0
 *   so the start line is mid-main-straight and the hard-coded pit window
 *   s=15..95 sits inside it. The remaining anchors are CORNERS chosen by
 *   a contrast mix (30% "wide" windows -> tight corner complex, else
 *   "narrow" -> sweeper); each pair of adjacent anchors is joined by a
 *   FILLET (circular arc tangent to both, radius clamped to fit the
 *   adjacent straights). Tiny fillets collapse to a bare anchor point
 *   that the engine's Catmull-Rom rounds.
 *   Dense resample (~5 m on straights, >= 3 m on arcs, all gaps >= 2 m
 *   after the engine rescale - the contract's waypoint-spacing floor);
 *   same length-fit as before (multiple of 100, clamped 800-1300 m).
 *
 * BUDGET GATES (Leclerc's tuning-run acceptance list, MCPG-72):
 *   - longest straight >= 25% (and <= 40%) of lap, located in
 *     s in [L-0.22L, L] U [0, 0.22L] (start/finish mid-straight)
 *   - max curvature over s in [0, 110] <= 0.020 (clean pit window)
 *   - 2-3 more straight runs >= 60 m on the rest of the lap
 *   - per-style corner quality (MCPG-74 re-gate): structural fillet
 *     corners with r >= 6 m >= style floor, and the engine's curb-run
 *     metric (curvature >= 0.021 1/m over a >= 15 m arc, exactly what
 *     the client paints) at or below a style ceiling. The spline fit
 *     washes the run metric out (packs 1-2 measured 0-1 runs on it),
 *     so it can only act as a ceiling
 *   A track that fails any gate is deterministically reseeded
 *   (offset +1, up to 8 retries) so the JSON the script writes is the
 *   first seed that passes every gate.
 *
 * DETERMINISM: same seed + style => byte-identical JSON (all randomness
 * through src/rng.js mulberry32, all spline math through the vendored
 * three build the engine ships with). A track is shareable as one integer.
 *
 * USAGE
 *   node scripts/generate-track.mjs --seed 42 --style flow --out tracks/breeze-cove.json
 *   node scripts/generate-track.mjs --seed 42 --style flow --out tracks/ --id breeze-cove --name "Breeze Cove"
 *   node scripts/generate-track.mjs --seed 7 --style city --palette rain-midnight --out tracks/
 *   node scripts/generate-track.mjs --seed 300 --style desert --out tracks/ --id sirocco-dunes
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
// Per style: spine params, fillet radius pool, road width, palette variants,
// scatter, name parts. Palettes are pure theme data blocks the engine
// renders generically (client/js/scene.js consumes theme.* colors; there is
// no per-palette engine code). The day/neon ones reuse render-proven
// palettes from shipped maps (coastal-palm, mountain-hairpins, city-night);
// the others are curated moods. MCPG-74 (pack 3) adds the desert-day and
// alpine-dusk palettes plus five single-mood presets (desert / alpine /
// city-rain / lagoon / canyon) so each map in a feedback pack has its own
// preset/knob combination.
//
// Spine knobs the feedback loop turns (MCPG-72):
//   K:               total anchor count (1 start + 2 straights + K-3 corners)
//   rRange:          base star radius (m) - sets the overall circuit scale.
//                    MCPG-74: tuned so the fitted lap lands ~1150-1250 m
//                    (pack 2's maps all clamped at the 1300 m ceiling).
//   mainDeg:         angular window of the main straight (deg) - wider =
//                    longer straight (capped by the chord-to-radius ratio)
//   straightMix:     fraction of non-main windows that are "wide straight"
//                    (DRS/back-straight runs) vs "tight corner". Higher =
//                    more long straights on the rest of the lap
//   filletRange:     fillet radius pool (m) per style - tight pool =
//                    hairpin-y, loose pool = sweeper-y. Wide-straight
//                    windows get a fillet at the top of the range; tight
//                    corner windows get the full range.
//   angularJitter:   per-anchor position jitter (m) - small deviations
//                    from a regular polygon
//   radiusJitter:    per-anchor radius jitter (frac of base R)
//   propTypes:       optional hand-prop pool (default: buildings ?
//                    [sign,lamp,building] : [sign,rock,palm])
// Curated palettes (theme data only, see the table above).
const PAL_COASTAL_DAY = {
  // day coastal (from coastal-palm, proven)
  sky: '#5ecdf6',
  ground: { base: '#f6de9a', spot: '#e3c276', patch: '#d3ab5e', tileM: 6 },
  road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
  curb: { red: '#e8362e', white: '#fdf6e8', threshold: 0.02 },
  pit: '#98a0b0', barriers: true,
  ambient: { sky: '#d8f4ff', ground: '#e8cf8e', intensity: 0.75 },
  sun: { color: '#fff3d6', intensity: 1 },
  water: '#19b8c9', fxAccent: '#ffd166',
};
const PAL_LAGOON_DUSK = {
  // dusk lagoon
  sky: '#3d4b8d',
  ground: { base: '#c8b06a', spot: '#b39d5c', patch: '#9d8a4e', tileM: 6 },
  road: { base: '#474c5c', spot: '#424756', tileM: 3 },
  curb: { red: '#e8542e', white: '#f7ead2', threshold: 0.02 },
  pit: '#8f93a6', barriers: true,
  ambient: { sky: '#7d86c9', ground: '#6f6a4a', intensity: 0.85 },
  sun: { color: '#ffb27d', intensity: 0.9 },
  water: '#2e6f8f', fxAccent: '#ffb35c',
};
const PAL_ALPINE_DAY = {
  // day alpine (from mountain-hairpins, proven)
  sky: '#7fb5ea',
  ground: { base: '#58b649', spot: '#4aa43e', patch: '#3c9033', tileM: 6 },
  road: { base: '#4a4f5e', spot: '#454a57', tileM: 3 },
  curb: { red: '#e8362e', white: '#fdf6e8' },
  pit: '#8b94a8', barriers: true,
  ambient: { sky: '#d9ecff', ground: '#4a8f3c', intensity: 0.75 },
  sun: { color: '#fff6e0', intensity: 1 },
  fxAccent: '#7de8ff',
};
const PAL_CANYON_DUSK = {
  // dusk canyon
  sky: '#7d4a2e',
  ground: { base: '#b3804a', spot: '#a06f3e', patch: '#8f6236', tileM: 6 },
  road: { base: '#454a58', spot: '#404552', tileM: 3 },
  curb: { red: '#e8542e', white: '#f7ead2' },
  pit: '#8f93a6', barriers: true,
  ambient: { sky: '#d98a5c', ground: '#7a5a38', intensity: 0.85 },
  sun: { color: '#ffb27d', intensity: 1 },
  fxAccent: '#ffd166',
};
const PAL_NEON_NIGHT = {
  // night neon (from city-night, proven)
  sky: '#0a0d1a',
  ground: { base: '#646a7a', spot: '#767c8e', patch: '#535868', tileM: 5 },
  road: { base: '#9598a8', spot: '#9ea1b1', tileM: 3 },
  curb: { red: '#ff2f4e', white: '#f2f2f8' },
  pit: '#b3b4c4', barriers: true,
  ambient: { sky: '#4a5584', ground: '#1a1e2e', intensity: 2.4 },
  sun: { color: '#8fa3ff', intensity: 2 },
  fxAccent: '#ffb35c',
};
const PAL_RAIN_MIDNIGHT = {
  // rain midnight
  sky: '#0d1420',
  ground: { base: '#4d5468', spot: '#5a6178', patch: '#41485c', tileM: 5 },
  road: { base: '#7e8394', spot: '#878c9e', tileM: 3 },
  curb: { red: '#ff2f4e', white: '#e8ecf4' },
  pit: '#9a9db0', barriers: true,
  ambient: { sky: '#3c4a74', ground: '#151a28', intensity: 2.6 },
  sun: { color: '#6fa8ff', intensity: 1.6 },
  water: '#27405e', fxAccent: '#7de8ff',
};
const PAL_DESERT_DAY = {
  // desert day (MCPG-74 pack 3): hot midday, sandy ground, hazy bright sky
  sky: '#8ecdf0',
  ground: { base: '#d9b06c', spot: '#cfa65f', patch: '#bfa052', tileM: 6 },
  road: { base: '#5a554e', spot: '#544f48', tileM: 3 },
  curb: { red: '#d94f35', white: '#f5ead0' },
  pit: '#a89878', barriers: true,
  ambient: { sky: '#eaf6ff', ground: '#d9b06c', intensity: 0.8 },
  sun: { color: '#fff2d0', intensity: 1.1 },
  fxAccent: '#7de8ff',
};
const PAL_ALPINE_DUSK = {
  // alpine dusk (MCPG-74 pack 3): snow ground, low warm sun, dusk purple sky
  sky: '#5a5f9e',
  ground: { base: '#e8edf4', spot: '#dbe3ec', patch: '#c8d2e0', tileM: 6 },
  road: { base: '#454a58', spot: '#3f4452', tileM: 3 },
  curb: { red: '#e8542e', white: '#f7ead2' },
  pit: '#8f93a6', barriers: true,
  ambient: { sky: '#8d92c9', ground: '#8a93ad', intensity: 0.9 },
  sun: { color: '#ffb27d', intensity: 0.8 },
  fxAccent: '#7de8ff',
};

const STYLES = {
  flow: {
    roadWidthM: 13,
    K: [7, 9],             // total anchors: 4-6 corners (fewer = longer main-straight %)
    rRange: [175, 235],    // large radius so the main-straight chord dominates
    mainDeg: [140, 165],   // main straight: 140-165 deg chord (dominant feature)
    straightMix: 0.30,     // ~30% of the non-main windows are wide-straight "DRS" runs
    filletRange: [8, 20],  // corners are mid-tight sweepers
    angularJitter: 0.10,   // small position jitter to keep the star shape clean
    radiusJitter: 0.04,    // small radius jitter to keep the star shape clean
    scatter: { type: 'palm', count: [24, 40] },
    water: true,
    palettes: [PAL_COASTAL_DAY, PAL_LAGOON_DUSK],
    paletteNames: ['coastal-day', 'lagoon-dusk'],
    nameAdj: ['Breeze', 'Lagoon', 'Palm', 'Tide', 'Meadow', 'Drift'],
    nameNoun: ['Bay', 'Cove', 'Meadows', 'Shoreline', 'Gardens', 'Ridge'],
  },
  technical: {
    roadWidthM: 12,
    K: [10, 13],           // total anchors: 7-10 corners
    rRange: [178, 228],    // larger radius for longer main straight
    mainDeg: [125, 150],   // main straight: 125-150 deg
    straightMix: 0.20,     // fewer wide-straight runs (technical tracks are twistier)
    filletRange: [6, 14],  // tighter pool, hairpin-capable
    angularJitter: 0.10,
    radiusJitter: 0.04,
    scatter: { type: 'pine', count: [30, 60] },
    water: false,
    palettes: [PAL_ALPINE_DAY, PAL_CANYON_DUSK],
    paletteNames: ['alpine-day', 'canyon-dusk'],
    nameAdj: ['Aiguille', 'Canyon', 'Serpent', 'Granite', 'Switchback', 'Col de'],
    nameNoun: ['Pass', 'Gorge', 'Ridge', 'Saddle', 'Col', 'Ravine'],
  },
  city: {
    roadWidthM: 13,
    K: [8, 11],            // total anchors: 5-8 corners
    rRange: [172, 222],    // larger radius for longer main straight
    mainDeg: [125, 150],   // main straight: 125-150 deg
    straightMix: 0.20,     // medium mix of wide-straight runs
    filletRange: [6, 16],  // medium pool, no extreme hairpins
    angularJitter: 0.10,
    radiusJitter: 0.04,
    scatter: { type: 'lamp', count: [12, 24] },
    water: false,
    buildings: true,
    palettes: [PAL_NEON_NIGHT, PAL_RAIN_MIDNIGHT],
    paletteNames: ['neon-night', 'rain-midnight'],
    nameAdj: ['Neon', 'Metro', 'Midnight', 'Riverside', 'Grand', 'Static'],
    nameNoun: ['Circuit', 'Metro', 'Boulevard', 'Spurs', 'Grid', 'Exchange'],
  },
  // ---- pack 3 (MCPG-74): single-mood presets, one per feedback map ----
  desert: {
    // bright desert day: 3-5 long sweeping dune corners, two long dry runs
    roadWidthM: 13,
    K: [6, 8],
    rRange: [195, 240],
    mainDeg: [150, 175],
    straightMix: 0.35,
    filletRange: [12, 28],  // sweeping dune bends only, no hairpins
    angularJitter: 0.08,
    radiusJitter: 0.05,
    scatter: { type: 'rock', count: [12, 26] },
    water: false,
    propTypes: ['sign', 'rock'], // no palms in the dunes
    palettes: [PAL_DESERT_DAY],
    paletteNames: ['desert-day'],
    nameAdj: ['Sirocco', 'Dune', 'Mesa', 'Gypsum', 'Oasis', 'Caliche'],
    nameNoun: ['Dunes', 'Pass', 'Crossing', 'Flats', 'Ridge', 'Gorge'],
  },
  alpine: {
    // snow alpine at dusk: hairpin-heavy switchback spine
    roadWidthM: 12,
    K: [10, 12],
    rRange: [195, 240],
    mainDeg: [135, 155],
    straightMix: 0.25,
    filletRange: [5, 12],   // tight pool: hairpin-capable switchbacks
    angularJitter: 0.10,
    radiusJitter: 0.05,
    scatter: { type: 'pine', count: [40, 70] },
    water: false,
    palettes: [PAL_ALPINE_DUSK],
    paletteNames: ['alpine-dusk'],
    nameAdj: ['Chamois', 'Glacier', 'Aiguille', 'Powder', 'Serpent', 'Cornice'],
    nameNoun: ['Col', 'Pass', 'Ridge', 'Serpentine', 'Gorge', 'Switchback'],
  },
  'city-rain': {
    // wet midnight city grid (pack 1-2 never used the rain-midnight palette)
    roadWidthM: 13,
    K: [9, 11],
    rRange: [182, 229],
    mainDeg: [120, 140],
    straightMix: 0.30,
    filletRange: [7, 15],
    angularJitter: 0.10,
    radiusJitter: 0.04,
    scatter: { type: 'lamp', count: [14, 26] },
    water: false,
    buildings: true,
    palettes: [PAL_RAIN_MIDNIGHT],
    paletteNames: ['rain-midnight'],
    nameAdj: ['Rain', 'Canal', 'Riverside', 'Harbor', 'Midnight', 'Static'],
    nameNoun: ['Boulevard', 'Dockside', 'Exchange', 'Avenue', 'Junction', 'Grid'],
  },
  lagoon: {
    // dusk lagoon circuit, twistier than the flow preset (more corners,
    // more DRS windows) - same palette mood as pack 2's breeze-cove
    roadWidthM: 13,
    K: [9, 11],
    rRange: [195, 238],
    mainDeg: [130, 155],
    straightMix: 0.40,
    filletRange: [8, 18],
    angularJitter: 0.10,
    radiusJitter: 0.04,
    scatter: { type: 'palm', count: [26, 44] },
    water: true,
    palettes: [PAL_LAGOON_DUSK],
    paletteNames: ['lagoon-dusk'],
    nameAdj: ['Tide', 'Coral', 'Salt', 'Lagoon', 'Drift', 'Marina'],
    nameNoun: ['Basin', 'Shoal', 'Gardens', 'Landing', 'Terrace', 'Circuit'],
  },
  canyon: {
    // dusk canyon with long run-outs (fewer, wider anchors than the
    // technical preset) - same palette mood as pack 2's granite-pass
    roadWidthM: 12,
    K: [7, 9],
    rRange: [184, 234],
    mainDeg: [140, 165],
    straightMix: 0.40,
    filletRange: [10, 22],
    angularJitter: 0.10,
    radiusJitter: 0.05,
    scatter: { type: 'pine', count: [20, 40] },
    water: false,
    palettes: [PAL_CANYON_DUSK],
    paletteNames: ['canyon-dusk'],
    nameAdj: ['Mesa', 'Boulder', 'Arroyo', 'Cholla', 'Vermejo', 'Saddle'],
    nameNoun: ['Run', 'Trestle', 'Saddle', 'Crossing', 'Draw', 'Pass'],
  },
};

const ALL_STYLES = Object.keys(STYLES);
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

function pickCount(rng, [lo, hi]) {
  return rng.int(lo, hi);
}

/**
 * Build a closed STRAIGHT+CORNER SPINE for the given style.
 *
 * Output: { pts: [[x,z]...], n } — a dense, contract-conformant polyline
 * (every gap >= 2 m) the engine's Catmull-Rom will round. All randomness
 * flows through `rng` (so a single seed reproduces the same spine).
 *
 * Algorithm (MCPG-72 tuning run, Leclerc research):
 *   K total anchors in index order. Anchor 0 is the START LINE (chord
 *      midpoint of the main straight). Anchors 1 and K-1 are the two
 *      main-straight-endpoint anchors (the chord endpoints). Anchors
 *      2..K-2 are CORNER anchors (K-3 of them, each in either a "wide
 *      straight" window for DRS/back-straight runs or a "tight corner"
 *      window for the corner proper). The mix is set by `straightMix`.
 *   2. The main straight is the chord between anchor 1 and anchor K-1
 *      (symmetric about the origin, spanning `mainDeg` degrees). The
 *      start line (anchor 0) is the midpoint of that chord.
 *   3. For each corner anchor, sample a fillet radius from the style
 *      pool (wider for wide-straight windows, tighter for tight-corner
 *      windows). The fillet rounds off the corner: tangent points along
 *      the two adjacent chords at distance r / tan(half-angle) from the
 *      anchor. The corner arc is a small subset of a circle of radius
 *      r centered on the angle bisector.
 *   4. Between corner anchors the polyline follows the chord (straight
 *      run); the main straight is the chord between anchor 1 and
 *      anchor K-1, with anchor 0 as its midpoint.
 *   5. The whole polyline is resampled at ~5 m on straights, >= 3 m on
 *      arcs (floor 2 m to satisfy the contract), preserving the start
 *      point at index 0.
 */
function buildLoop(rng, style) {
  const K = pickCount(rng, style.K);
  const R0 = rng.int(style.rRange[0], style.rRange[1]);
  const mainDeg = style.mainDeg[0] + rng.next() * (style.mainDeg[1] - style.mainDeg[0]);

  if (K < 5) throw new Error(`K must be >= 5 (got ${K})`);

  // Anchor layout:
  //   0      = START LINE (chord midpoint of the main straight)
  //   1      = main-straight-endpoint-A (chord endpoint at +mainDeg/2)
  //   2..K-2 = corner anchors (K-3 of them)
  //   K-1    = main-straight-endpoint-B (chord endpoint at -mainDeg/2)
  const cornerCount = K - 3;
  if (cornerCount < 1) throw new Error(`K must be >= 4 with our layout (got ${K}, cornerCount=${cornerCount})`);

  // --- 1. anchor angles (counterclockwise from angle 0) ---
  // The main straight is symmetric about angle 0; endpoints at +/- mainDeg/2.
  // The remaining (360 - mainDeg) arc is split into (cornerCount) windows,
  // each one either a "wide straight" (40-80 deg, used for DRS/back-straight
  // style runs) or a "tight corner" (15-30 deg, used for the corner proper).
  // The `straightMix` knob controls the mix; the budget gate requires at
  // least 2-3 wide-straight windows per lap for F1-style contrast.
  const cornerDegTotal = 360 - mainDeg;
  // Budget: at least 2 wide-straight windows; cap so we never starve the
  // corner count. The first and last corner windows (adjacent to the main-
  // straight endpoints) are FORCED to be wide so the car has a long
  // straight run before and after the first/last corner — this is what
  // keeps the pit window (s=15..95) clear of corners.
  const wideCount = Math.max(2, Math.min(cornerCount - 2, Math.round(cornerCount * style.straightMix)));
  const tightCount = cornerCount - wideCount;
  // Budget the angle: each wide window takes ~25 deg (a "back straight" run
  // about a third of the main straight so the track has a clear hierarchy
  // of straights and doesn't read as a stadium), each tight ~22 deg (a
  // corner proper — a 22-deg window with a 10-15 m fillet gives a 90+ deg
  // sweep that produces 15+ m of high curvature, the budget-gate floor).
  // The first and last windows get a bonus so the lead-in / lead-out are
  // always wide enough.
  const roughWideDeg = 25;
  const roughTightDeg = 22;
  const roughTotal = wideCount * roughWideDeg + tightCount * roughTightDeg;
  const scale = cornerDegTotal / roughTotal;
  const wideDeg = roughWideDeg * scale;
  const tightDeg = roughTightDeg * scale;
  // Build a window list where the first and last entries are ALWAYS wide
  // (so the main-straight lead-in/lead-out are wide). The remaining windows
  // are shuffled wide/tight.
  const middle = [];
  for (let i = 0; i < wideCount - 2; i++) middle.push(wideDeg);
  for (let i = 0; i < tightCount; i++) middle.push(tightDeg);
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [middle[i], middle[j]] = [middle[j], middle[i]];
  }
  const windowSizes = [wideDeg, ...middle, wideDeg];
  // The sum may differ from cornerDegTotal due to the (wideCount - 2) vs
  // (wideCount) bookkeeping; re-scale the last window so the total matches.
  const sumSoFar = windowSizes.reduce((a, w) => a + w, 0);
  windowSizes[windowSizes.length - 1] += (cornerDegTotal - sumSoFar);
  const cornerSteps = windowSizes.map((deg) => deg / (360 / K));

  // Anchor positions and per-anchor fillet radii
  const anchorAngle = new Array(K);
  const anchorPos = new Array(K);
  const anchorFillet = new Array(K);
  const anchorKind = new Array(K);

  // main-straight-endpoint-A at +mainDeg/2
  // main-straight-endpoint-A at +mainDeg/2. The endpoint is FILLETED (MCPG-74:
  // a raw star vertex here is a 90-115 deg V that the fitted spline rounds
  // into a ~2.5 m kart hook - "90 degrees turns? thats not very f1").
  // The fillet is a gentle lead-out: the straight chord itself stays intact
  // (the start line at its midpoint is untouched).
  anchorAngle[1] = (mainDeg / 2) * Math.PI / 180;
  anchorKind[1] = 'straight';
  {
    const lo = Math.max(style.filletRange[1] * 0.9, 25);
    anchorFillet[1] = lo + rng.next() * (style.filletRange[1] * 1.4 - lo);
  }
  // main-straight-endpoint-B at -mainDeg/2 (same fillet treatment)
  anchorAngle[K - 1] = -(mainDeg / 2) * Math.PI / 180;
  anchorKind[K - 1] = 'straight';
  {
    const lo = Math.max(style.filletRange[1] * 0.9, 25);
    anchorFillet[K - 1] = lo + rng.next() * (style.filletRange[1] * 1.4 - lo);
  }
  // corner anchors, CCW from +mainDeg/2 toward -mainDeg/2 going through +180
  let cursorAngle = anchorAngle[1];
  for (let i = 0; i < cornerCount; i++) {
    const idx = 2 + i;
    const windowRad = cornerSteps[i] * (Math.PI * 2) / K;
    anchorAngle[idx] = cursorAngle + windowRad / 2;
    const isWide = windowSizes[i] > (wideDeg + tightDeg) / 2;
    const rRange = isWide
      ? [Math.max(style.filletRange[1] * 0.9, 25), style.filletRange[1] * 1.4]
      : style.filletRange;
    anchorFillet[idx] = rRange[0] + rng.next() * (rRange[1] - rRange[0]);
    anchorKind[idx] = 'corner';
    cursorAngle += windowRad;
  }
  // start line at angle 0 (chord midpoint), no fillet
  anchorAngle[0] = 0;
  anchorKind[0] = 'start';
  anchorFillet[0] = 0;

  // Place anchor positions in 2D
  for (let i = 0; i < K; i++) {
    if (anchorKind[i] === 'start' || anchorKind[i] === 'straight') {
      // straight endpoints and start line use a common radius
      const r = R0;
      anchorPos[i] = {
        x: r * Math.cos(anchorAngle[i]),
        z: r * Math.sin(anchorAngle[i]),
      };
    } else {
      // corner anchors: radius jitter
      const r = R0 * (1 + (rng.next() * 2 - 1) * style.radiusJitter);
      anchorPos[i] = {
        x: r * Math.cos(anchorAngle[i]),
        z: r * Math.sin(anchorAngle[i]),
      };
    }
  }
  // The start line (anchor 0) sits on the chord between anchors 1 and K-1,
  // not on the circle. Snap it to the exact midpoint of that chord so
  // waypoint 0 is the chord midpoint and the polyline is symmetric.
  const sStartX = (anchorPos[1].x + anchorPos[K - 1].x) / 2;
  const sStartZ = (anchorPos[1].z + anchorPos[K - 1].z) / 2;
  anchorPos[0] = { x: sStartX, z: sStartZ };
  // Nudge corner anchor positions by a small random offset (the star's
  // angles have already been jittered by the window sizes; this nudges
  // the position further so the layout doesn't look mechanical).
  const step = (Math.PI * 2) / K;
  const jitterAmp = step * style.angularJitter;
  for (let i = 0; i < K; i++) {
    if (anchorKind[i] !== 'corner') continue;
    const jx = (rng.next() * 2 - 1) * jitterAmp * 0.5;
    const jz = (rng.next() * 2 - 1) * jitterAmp * 0.5;
    anchorPos[i].x += jx * 4;
    anchorPos[i].z += jz * 4;
  }

  // --- 2. dense polyline (waypoints) with explicit fillet vertices ---
  // The polyline visits anchors in index order: 0 -> 1 -> 2 -> ... -> K-1 -> 0
  // (closed). For each CORNER anchor we replace the polyline vertex with
  // a fillet arc — two tangent points on the adjacent chords, sampled at
  // >= 3 m arc steps (exact tangent points bracket the samples). For
  // STRAIGHT anchors and the START anchor we emit
  // the anchor as a single point.
  // fillets collects the EFFECTIVE fillet radius per corner anchor (after
  // the halfChord clamp) so the budget gate can count structural corners
  // that survive the spline smoothing (r >= 6 m = a visible corner).
  const pts = [];
  const fillets = [];
  const protIdx = []; // sparse indices that must survive the 2 m floor
  for (let i = 0; i < K; i++) {
    const prev = (i - 1 + K) % K;
    const next = (i + 1) % K;
    const pPrev = anchorPos[prev];
    const pHere = anchorPos[i];
    const pNext = anchorPos[next];
    if (anchorKind[i] === 'corner' || anchorKind[i] === 'straight') {
      // tangent point on the chord pPrev -> pHere
      const u1 = unitVec(pPrev, pHere);
      const u2 = unitVec(pHere, pNext);
      const ang = angleBetween(u1, u2);
      const halfAng = ang / 2;
      // Effective fillet radius: don't let it exceed the half-chord on
      // either side (else the tangent points go past the adjacent anchor
      // and the polyline kinks). Also clamp halfAng away from 0 (nearly
      // straight) and from PI (U-turn) — both produce degenerate arcs.
      const halfPrev = Math.hypot(pHere.x - pPrev.x, pHere.z - pPrev.z) / 2;
      const halfNext = Math.hypot(pNext.x - pHere.x, pNext.z - pHere.z) / 2;
      const halfChord = Math.min(halfPrev, halfNext);
      let r = anchorFillet[i];
      // Theoretical max fillet radius (so tIn/tOut stay within both chords):
      // d = r / tan(halfAng); require d <= halfChord => r <= halfChord * tan(halfAng)
      const maxR = halfChord * Math.tan(halfAng);
      if (r > maxR) r = maxR;
      if (r < 1) r = 1; // floor: a 1-m fillet is still a "rounded corner" w/ minimum impact
      // Big turns need a real radius (MCPG-74): a 100deg turn through a
      // 3 m fillet is a kart hook no matter how well it is sampled. Force
      // turns > 70deg out to at least r=8m (a flowing F1 slow corner) when
      // the halfChord clamp allows it; when it doesn't, the corner stays
      // too pointy and the F1 corner-shape budget gate reseeds the map.
      if (ang > (70 * Math.PI) / 180 && r < 8 && r < maxR) r = 8;
      fillets.push(r);
      // Recompute d with the effective r
      const d = r / Math.tan(halfAng);
      const tIn = {
        x: pHere.x - u1.x * d,
        z: pHere.z - u1.z * d,
      };
      const tOut = {
        x: pHere.x + u2.x * d,
        z: pHere.z + u2.z * d,
      };
      // arc length and sample count. >= 2.5 m sample spacing keeps the
      // >= 2 m waypoint floor from cascading-sliding dense clusters into
      // kinks (pack 2 maps showed ~1.7 m radius wiggles from that,
      // MCPG-74). Arcs shorter than 3 m collapse to the two tangent points
      // (a straight cut the Catmull-Rom rounds) - the old 6 m threshold
      // collapsed big-turn arcs (r*ang < 6 m) whose chord-cut the fit
      // rounded into V-hooks, MCPG-74.
      const arcLen = r * ang;
      const ARC_SAMPLE_M = 2.5;
      const arcSegs = arcLen >= 3 ? Math.max(2, Math.round(arcLen / ARC_SAMPLE_M)) : 0;
      if (arcSegs === 0) {
        pts.push([tIn.x, tIn.z], [tOut.x, tOut.z]);
        protIdx.push(pts.length - 2, pts.length - 1);
      } else {
        // TRUE circular arc (MCPG-74 fix): the old implementation put the
        // samples on the tIn->tOut CHORD with a sine sagitta offset, so the
        // first sample after tIn was already rotated by half the turn angle
        // away from the straight's direction. The fitted Catmull-Rom kinked
        // at the straight/arc junction; at turns >= 90 deg the kink became
        // a ~3 m radius hook (pack 3's 118 deg dune corners - "90 degrees
        // turns? thats not very f1"). Sampling the circle by angle keeps
        // the polyline exactly tangent to the chords at both ends.
        const turnSign = Math.sign(
          (pHere.x - pPrev.x) * (pNext.z - pHere.z) -
          (pHere.z - pPrev.z) * (pNext.x - pHere.x),
        ) || 1;
        // circle center: r from tIn along the travel-left normal
        // ((-u1.z, u1.x) is the left normal in xz; sign flips for right)
        const cx = tIn.x + turnSign * -u1.z * r;
        const cz = tIn.z + turnSign * u1.x * r;
        const phiIn = Math.atan2(tIn.z - cz, tIn.x - cx);
        for (let k = 0; k <= arcSegs; k++) {
          const phi = phiIn + turnSign * ang * (k / arcSegs);
          pts.push([cx + r * Math.cos(phi), cz + r * Math.sin(phi)]);
        }
        // tIn (first) and tOut (last) must survive the >= 2 m waypoint
        // floor: dropping one of them breaks tangent continuity at the
        // straight/arc junction and the fitted spline kinks into a tight
        // hook (MCPG-74: pack 3's 100-120 deg kart corners at r ~ 2.5 m)
        protIdx.push(pts.length - 1 - arcSegs, pts.length - 1);
      }
    } else {
      // start anchor: emit the single chord-midpoint (on the main straight)
      pts.push([pHere.x, pHere.z]);
    }
  }

  // --- 3. Densify: target ~5 m on long straight segments, keep arcs as-is ---
  const densePts = [];
  const sparseToDense = new Array(pts.length);
  const STRAIGHT_DENSIFY_M = 5;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const seg = Math.hypot(dx, dz);
    if (seg <= STRAIGHT_DENSIFY_M * 1.5) {
      densePts.push([p0[0], p0[1]]);
      sparseToDense[i] = densePts.length - 1;
    } else {
      const n = Math.max(1, Math.floor(seg / STRAIGHT_DENSIFY_M));
      for (let k = 0; k < n; k++) {
        if (k === 0) sparseToDense[i] = densePts.length;
        densePts.push([p0[0] + dx * (k / n), p0[1] + dz * (k / n)]);
      }
    }
  }
  const protectedDense = new Set(protIdx.map((i) => sparseToDense[i]));
  // The final sparse vertex is already included (it is the k=0 point of
  // the wrap segment, pushed above) - do NOT append it again: the old
  // extra push duplicated it at the end of the list and the wrap became
  // "... near-start -> B -> start", a ~160 m V-spike that the fitted
  // Catmull-Rom rounded into a ~1.6 m hairpin wiggle (pack 2 maps,
  // MCPG-74).

  // Round to 0.1 m and enforce the contract's >= 2 m floor.
  const r1Pts = densePts.map(([x, z]) => [r1(x), r1(z)]);
  // >= 2 m floor: DROP the nearer point instead of sliding it - sliding
  // pushes the point along the segment and kinks the fitted spline where
  // several slides cascade on a dense cluster (pack 2 maps showed ~1.7 m
  // radius wiggles, MCPG-74). Dropping keeps the polyline a subsequence
  // of the dense samples, so the fit stays smooth. Fillet tangent points
  // are PROTECTED: dropping one breaks tangent continuity at the
  // straight/arc junction (MCPG-74 kart hooks) - drop the other point
  // instead, or slide when the other is the start point. The start point
  // (index 0) never drops; a sub-2 m wrap gap (last -> first) slides the
  // LAST point instead so the start line never moves. Protection rides on
  // a flag array spliced IN SYNC with the points (an index set goes stale
  // after the first drop and silently deprotects later tangent points).
  const flags = new Array(r1Pts.length).fill(0);
  for (const i of protectedDense) flags[i] = 1;
  let guard = 0;
  while (guard++ < 10 * r1Pts.length) {
    let changed = false;
    for (let i = 0; i < r1Pts.length; i++) {
      const j = (i + 1) % r1Pts.length;
      const a = r1Pts[i];
      const b = r1Pts[j];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d >= 2) continue;
      const aProt = flags[i] === 1;
      const bProt = flags[j] === 1;
      if (j === 0) {
        // wrap pair: slide the last point away from the start point
        const ux = d > 1e-6 ? (a[0] - b[0]) / d : -1;
        const uz = d > 1e-6 ? (a[1] - b[1]) / d : 0;
        a[0] = b[0] + ux * 2;
        a[1] = b[1] + uz * 2;
        changed = true;
      } else if (bProt && !aProt && i !== 0) {
        r1Pts.splice(i, 1);
        flags.splice(i, 1); // keep protection in sync
        changed = true;
        break; // re-walk: indices shifted
      } else if (bProt) {
        // b protected and a is the start point (or also protected): slide b
        const ux = d > 1e-6 ? (b[0] - a[0]) / d : 1;
        const uz = d > 1e-6 ? (b[1] - a[1]) / d : 0;
        b[0] = a[0] + ux * 2;
        b[1] = a[1] + uz * 2;
        changed = true;
      } else {
        r1Pts.splice(j, 1);
        flags.splice(j, 1); // keep protection in sync
        changed = true;
        break; // re-walk: indices shifted
      }
    }
    if (!changed) break; // all gaps >= 2 m
  }
  return { pts: r1Pts, n: r1Pts.length, fillets };
}

/** Unit vector from a -> b (zero vector guarded). */
function unitVec(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  return { x: d > 1e-9 ? dx / d : 1, z: d > 1e-9 ? dz / d : 0 };
}

/** Interior angle (rad) between two unit vectors meeting tail-to-tail. */
function angleBetween(u1, u2) {
  const dot = THREE.MathUtils.clamp(u1.x * u2.x + u1.z * u2.z, -1, 1);
  return Math.acos(dot);
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
 * Find the longest run of low curvature (`<= thresh`) and return
 * { s0, s1, lenM } in meters. Used by the start-on-straight budget gate.
 */
function longestRunInfo(values, thresh, arclen) {
  const ds = arclen / values.length;
  let best = 0, bestS0 = 0, bestS1 = 0;
  let cur = 0, curS0 = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= thresh) {
      if (cur === 0) curS0 = i * ds;
      cur += ds;
      if (cur > best) { best = cur; bestS0 = curS0; bestS1 = i * ds + ds; }
    } else cur = 0;
  }
  // wrap case: low-curv spans the seam
  if (values[values.length - 1] <= thresh && values[0] <= thresh && best > 0) {
    const lastIdx = values.length - 1;
    const firstIdx = 0;
    // Find a single combined run from first low-curv index through the seam
    let wrapS0 = 0, wrapS1 = 0;
    let i = firstIdx;
    while (i < values.length && values[i] <= thresh) {
      wrapS1 = i * ds + ds;
      i++;
    }
    // then the trailing run from the last low-curv at the end
    let j = lastIdx;
    while (j >= 0 && values[j] <= thresh) {
      wrapS0 = j * ds;
      j--;
    }
    const wrapLen = wrapS1 + (arclen - wrapS0);
    if (wrapLen > best) {
      best = wrapLen;
      bestS0 = wrapS0;
      bestS1 = wrapS1;
    }
  }
  return { s0: bestS0, s1: bestS1, lenM: best };
}

/** Max curvature over a window [s0, s1] (meters, may wrap). */
function maxCurvInWindow(curv, arclen, s0, s1) {
  const N = curv.length;
  const ds = arclen / N;
  // convert s0, s1 to indices (window may wrap)
  const a = ((s0 % arclen) + arclen) % arclen;
  const b = ((s1 % arclen) + arclen) % arclen;
  const i0 = Math.floor(a / ds);
  const i1 = Math.floor(b / ds);
  let max = 0;
  if (i0 <= i1) {
    for (let i = i0; i <= i1; i++) if (curv[i] > max) max = curv[i];
  } else {
    for (let i = i0; i < N; i++) if (curv[i] > max) max = curv[i];
    for (let i = 0; i <= i1; i++) if (curv[i] > max) max = curv[i];
  }
  return max;
}

/** Per-style corner-quality budget (MCPG-74 two-part re-gate).
 *  Two metrics, because the engine's curb-run metric (client/js/track.js
 *  curbRuns: curvature >= 0.021 1/m sustained over a >= 15 m arc = one
 *  curb run) is mostly washed out by the Catmull-Rom fit: every accepted
 *  map in packs 1-2 measures 0-1 runs on it (hand-authored 0-6), so it
 *  can only act as a CEILING (catch bumpy maps that would paint curbs
 *  all over the track). The FLOOR is the generator's structural metric:
 *  how many fillet events kept an effective radius >= 6 m (a visible
 *  corner after spline smoothing; tiny fillets round away). The older
 *  single gate - 90deg-at-r<=10m spec counts - failed even the
 *  hand-authored coastal-palm, and the raw engine run count cannot
 *  separate "twisty" from "smoothed" on CR-fitted maps, so it cannot
 *  floor anything. */
/** Corner arcs on the fitted curve: contiguous runs of curvature >= 0.010 1/m
 *  (radius <= 100 m). For each arc: total tangent deflection (deg) and min
 *  radius (1/m) on the same 240-sample profile the budget gates use, so
 *  this measures what the ENGINE's fitted spline actually does - the paper
 *  fillet radius can come out much sharper than the CR fit (MCPG-74: the
 *  pack-3 sweep produced 95-120 deg kart-style hooks at r ~ 2.7 m). */
function cornerShapes(curv, arclen) {
  const N = curv.length;
  const ds = arclen / N;
  const hot = curv.map((c) => c >= 0.010);
  const shapes = [];
  let i = 0;
  while (i < N) {
    if (!hot[i]) { i++; continue; }
    let j = i;
    while (j < N && hot[j]) j++;
    let dth = 0, kmax = 0;
    for (let k = i; k < j; k++) { dth += curv[k] * ds; kmax = Math.max(kmax, curv[k]); }
    shapes.push({ s: r1(i * ds), deg: Math.round((dth * 180) / Math.PI), rMin: kmax > 0 ? r1(1 / kmax) : 999 });
    i = j;
  }
  // wrap merge: a corner spanning the seam (last run touches N, first run starts at 0)
  if (shapes.length > 1 && hot[N - 1] && hot[0]) {
    const last = shapes.pop();
    const first = shapes[0];
    first.deg += last.deg;
    first.rMin = Math.min(first.rMin, last.rMin);
    first.s = last.s;
  }
  return shapes;
}

const STYLE_BUDGETS = {
  flow: { minEffCorners: 3, maxCurbRuns: 12, maxTurnDeg: 90, minCornerR: 4.5 },
  technical: { minEffCorners: 5, maxCurbRuns: 16, maxTurnDeg: 90, minCornerR: 4.5 },
  city: { minEffCorners: 4, maxCurbRuns: 16, maxTurnDeg: 90, minCornerR: 4.5 },
  desert: { minEffCorners: 2, maxCurbRuns: 12, maxTurnDeg: 90, minCornerR: 4.5 },
  alpine: { minEffCorners: 5, maxCurbRuns: 20, maxTurnDeg: 120, minCornerR: 4.5 },
  'city-rain': { minEffCorners: 4, maxCurbRuns: 16, maxTurnDeg: 90, minCornerR: 4.5 },
  lagoon: { minEffCorners: 4, maxCurbRuns: 12, maxTurnDeg: 90, minCornerR: 4.5 },
  canyon: { minEffCorners: 3, maxCurbRuns: 12, maxTurnDeg: 90, minCornerR: 4.5 },
};

/**
 * Run the budget gates (MCPG-72 acceptance). Returns { ok, reasons }.
 * Reasons is a list of human-readable strings for the diagnostic log;
 * empty if all gates pass.
 *
 * Gates (per Leclerc's handoff):
 *   1. longest straight >= 25% of lap (and <= 40%, no dragstrip), located
 *      within s in [L-0.22L, L] U [0, 0.22L] (start/finish mid-straight)
 *   2. max curvature over s in [0, 110] <= 0.020
 *      (the pit window is at s=15..95; 0.020 = the engine's default curb
 *      threshold, so anything sharper in the window would be a real corner)
 *   3. 2-3 more straight runs of >= 60 m on the rest of the lap
 *   4. per-style corner quality (see STYLE_BUDGETS): structural fillet
 *      corners with effective r >= 6 m >= minEffCorners, and the engine's
 *      curb-run count (0.021 1/m, >= 15 m runs) <= maxCurbRuns
 *   5. F1 corner shape (MCPG-74 feedback "90 degrees turns? that's not
 *      very f1"): a corner that deflects more than maxTurnDeg (90) is only
 *      accepted at a WIDE radius (r >= 8 m) - F1 has plenty of wide
 *      sweepers past 90 deg (Tamburello ~135 deg, La Source ~180 deg),
 *      but tight kart-style L-hooks (big deflection at r < 5 m) are not
 *      F1. Independently, any corner with >= 15 deg of deflection must
 *      keep r >= minCornerR, so slow-but-wide Monaco-style corners pass
 *      while tight kinks fail.
 */
function checkBudgets(curve, arclen, lengthM, curv, styleName, effCorners) {
  const reasons = [];
  const budget = STYLE_BUDGETS[styleName];
  if (!budget) return { ok: true, reasons };

  // 1. longest straight >= 25% of lap (and <= 40%, no dragstrip), located
  //    in [L-0.22L, L] U [0, 0.22L] (start/finish mid-straight). The half
  //    window is proportional because the main straight grows with the
  //    circuit: a 40%-of-lap straight centered on the seam extends +-20%
  //    before/after it (MCPG-74: pack 3's bigger circuits produced
  //    380-460 m main straights that overshot the old fixed +-180 m
  //    window).
  const low = longestRunInfo(curv, 0.012, arclen);
  const minMain = lengthM * 0.25;
  const maxMain = lengthM * 0.40;
  const wraps = low.s0 > low.s1;
  const HALF_WIN = lengthM * 0.22;
  const inStartWindow = (low.lenM > 0) && (
    // non-wrapping case: the run sits entirely in one half-window
    (low.s0 >= lengthM - HALF_WIN && low.s1 <= lengthM) ||
    (low.s0 >= 0 && low.s1 <= HALF_WIN) ||
    // wrapping case: the run straddles s=0; either side is in a start half
    (wraps && (low.s0 >= lengthM - HALF_WIN || low.s1 <= HALF_WIN))
  );
  if (low.lenM < minMain - 5) {  // 5 m tolerance for the rounding/center jitter
    reasons.push(`longest straight ${low.lenM.toFixed(1)}m < 25% of lap (${minMain.toFixed(1)}m)`);
  } else if (low.lenM > maxMain) {
    reasons.push(`longest straight ${low.lenM.toFixed(1)}m > 40% of lap (${maxMain.toFixed(1)}m, would be a dragstrip)`);
  } else if (!inStartWindow) {
    reasons.push(`longest straight ${low.lenM.toFixed(1)}m NOT in start window [L-${HALF_WIN.toFixed(0)}, L]U[0, ${HALF_WIN.toFixed(0)}] (s0=${low.s0.toFixed(1)}, s1=${low.s1.toFixed(1)})`);
  }

  // 2. max curvature over s in [0, 110] <= 0.020
  //    (the pit window is at s=15..95; 110m of clean start/pit straight.
  //    Threshold 0.020 = the engine's curb threshold — anything sharper
  //    would be a real corner, not a straight.)
  const maxCurvPitWindow = maxCurvInWindow(curv, arclen, 0, 110);
  if (maxCurvPitWindow > 0.020) {
    reasons.push(`max curvature in [0, 110] = ${maxCurvPitWindow.toFixed(4)} > 0.020 (pit lane would be on a corner)`);
  }

  // 3. 2-3 more straight runs >= 60m on the rest of the lap
  // Walk the curvature profile, find runs of curvature <= 0.012 that are
  // >= 60m and are NOT the main straight we already identified.
  const N = curv.length;
  const ds = arclen / N;
  const otherStraights = [];
  let run = 0, runS0 = 0;
  for (let i = 0; i < N; i++) {
    if (curv[i] <= 0.012) {
      if (run === 0) runS0 = i * ds;
      run += ds;
    } else {
      if (run >= 60) {
        // skip the main-straight window
        const mid = (runS0 + i * ds) / 2;
        const mainMid = (low.s0 + low.s1) / 2;
        const dMain = Math.min(Math.abs(mid - mainMid), lengthM - Math.abs(mid - mainMid));
        if (dMain > 80) otherStraights.push({ s0: runS0, s1: i * ds, lenM: run });
      }
      run = 0;
    }
  }
  if (run >= 60) {
    const mid = (runS0 + lengthM) / 2;
    const mainMid = (low.s0 + low.s1) / 2;
    const dMain = Math.min(Math.abs(mid - mainMid), lengthM - Math.abs(mid - mainMid));
    if (dMain > 80) otherStraights.push({ s0: runS0, s1: lengthM, lenM: run });
  }
  if (otherStraights.length < 2) {
    reasons.push(`only ${otherStraights.length} other straight run(s) >= 60m (need 2-3)`);
  }

  // 4. per-style corner quality (MCPG-74 two-part re-gate, see STYLE_BUDGETS)
  const curbCorners = countHotRuns(curv, arclen, 0.021, 15);
  if (curbCorners > budget.maxCurbRuns) {
    reasons.push(`curb runs ${curbCorners} > ${budget.maxCurbRuns} for style ${styleName} (track would be painted curb-to-curb)`);
  }
  if (effCorners < budget.minEffCorners) {
    reasons.push(`effective corners ${effCorners} < ${budget.minEffCorners} for style ${styleName} (too few visible corners)`);
  }

  // 5. F1 corner shape (see gate list above): tight hooks are the non-F1
  //    marker - big deflection is fine at a wide radius, tight radius is
  //    not.
  for (const c of cornerShapes(curv, arclen)) {
    if (c.deg > budget.maxTurnDeg && c.rMin < 8) {
      reasons.push(`corner at s=${c.s}m bends ${c.deg}deg at r=${c.rMin}m (tight hook past ${budget.maxTurnDeg}deg - kart-style, not F1)`);
    } else if (c.deg >= 15 && c.rMin < budget.minCornerR) {
      reasons.push(`corner at s=${c.s}m (${c.deg}deg) has r=${c.rMin}m < ${budget.minCornerR}m (tightest allowed corner radius)`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Build the full def for one seed + style, applying the contract + budget
 * gates and deterministically reseeding on failure.
 *
 * Returns { def, stats, attempts } where attempts is the number of
 * seeds tried (1..MAX_ATTEMPTS). The returned def always passes the
 * gates (or, if no seed in the search space does, the best attempt
 * is returned with `attempts = MAX_ATTEMPTS` and the gates' reasons
 * are left in the stats).
 */
const MAX_ATTEMPTS = 8;

function generate(seed, styleName, overrides = {}, paletteIndex = null) {
  const style = STYLES[styleName];
  let attempt = 0;
  let lastResult = null;
  let lastReasons = [];
  for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const s = seed + attempt;
    const result = tryGenerate(s, styleName, overrides, paletteIndex);
    const { def, stats, contractOk, budgetReasons } = result;
    lastResult = result;
    lastReasons = budgetReasons;
    if (contractOk && budgetReasons.length === 0) {
      return { def, stats: { ...stats, attempts: attempt + 1 } };
    }
  }
  // exhausted: return the last attempt's def anyway so the pack ships;
  // the caller can decide what to do
  return {
    def: lastResult.def,
    stats: { ...lastResult.stats, attempts: attempt, budgetFails: lastReasons },
  };
}

function tryGenerate(seed, styleName, overrides, paletteIndex) {
  const style = STYLES[styleName];
  const rng = createRng(seed);

  const { pts, n, fillets } = buildLoop(rng, style);

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
  // structural corner count (generator-known, spline-smoothing-proof)
  const effCorners = fillets.filter((r) => r >= 6).length;

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
  const propTypes = style.propTypes ?? (style.buildings ? ['sign', 'lamp', 'building'] : ['sign', 'rock', 'palm']);
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

  // Contract gate (in-process). On failure the retry loop in generate()
  // will try the next seed; here we just record the result.
  const contract = validateTrackDef(def);
  const budget = checkBudgets(curve, arclen, lengthM, curv, styleName, effCorners);
  return {
    def,
    stats: {
      waypoints: n,
      splineM: r1(rawLen),
      straightM,
      curbCorners,
      effCorners,
      minTurnRadius,
      maxCoord: Math.max(...waypoints.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z)))),
    },
    contractOk: contract.ok,
    budgetReasons: budget.reasons,
  };
}

// -------------------------------------------------------------------- CLI ---
function fail(msg) {
  console.error(`generate-track: ${msg}`);
  console.error('usage: node scripts/generate-track.mjs [--seed N] [--style flow|technical|city|desert|alpine|city-rain|lagoon|canyon|auto] ' +
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
  if (stats.budgetFails && stats.budgetFails.length > 0) {
    // emit a clear diagnostic so the user can see why a pack slipped
    console.log(`WARN ${id} (${def.name}) style=${styleName} L=${def.lengthM}m ` +
      `attempts=${stats.attempts} budgetFails: ${stats.budgetFails.join('; ')}`);
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
    `straights>=25m: ${stats.straightM}m curbRuns: ${stats.curbCorners} effCorners: ${stats.effCorners} ` +
    `minTurnR: ${stats.minTurnRadius}m maxCoord: ${Math.round(stats.maxCoord)} ` +
    `attempts=${stats.attempts ?? 1}`);
  for (const w of warnings) console.log(`     warning: ${w}`);
}
console.log(`\n${pass} passed / ${failCount} failed -> ${outDir}`);
if (pack === 1 && pass !== 1) process.exit(1);