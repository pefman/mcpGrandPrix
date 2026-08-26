/**
 * Track contract v1 (MCPG-63) — the machine-checked agreement between map
 * files and engine.
 *
 * A map is pure data (`tracks/<id>.json`); this module defines what the
 * engine reads from it. It is dependency-free on purpose and lives under
 * `client/js/` so the browser imports it straight from the static root,
 * while Node (server registry, validator script, tests) imports the very
 * same file — one implementation, nothing to drift out of sync.
 *
 * Rules (full field reference: tracks/README.md):
 *   - Unknown top-level fields, theme keys, prop types and feature flags are
 *     WARNED about and skipped — forward compatibility, never fatal.
 *   - Malformed KNOWN data is fatal where the map is loaded as truth (server
 *     startup) and falls back to a safe legacy look on the client.
 *   - A newer MAJOR contract version is refused; same-major always loads.
 */

/** Major contract version this engine understands. */
export const SUPPORTED_VERSION = 1;

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Prop catalog (v1): builder types known to the engine plus their optional
 * numeric/hex params (builders live in client/js/props.js; this table only
 * decides what the contract accepts). Every prop also accepts x/z
 * (required numbers), rot/y (optional numbers).
 */
export const PROP_TYPES = {
  palm: { nums: ['h'] },
  pine: {},
  building: { nums: ['w', 'd', 'h'], hexes: ['color', 'neon'] },
  grandstand: { nums: ['w', 'd', 'h'] },
  rock: {},
  boat: {},
  lamp: {},
  sign: { nums: ['w', 'h'], hexes: ['color'] },
};

/** Theme keys the engine consumes -> per-key validation shape. */
const THEME_SHAPES = {
  sky: 'hex',
  ground: 'ground',
  road: 'road',
  curb: 'curb',
  pit: 'hex',
  barriers: 'bool',
  ambient: 'ambient',
  sun: 'sun',
  water: 'hex',
  fxAccent: 'hex',
};
const REQUIRED_THEME_KEYS = ['sky', 'ground', 'road', 'pit', 'ambient', 'sun'];

/** Feature flags implemented by this engine so far (reserved names: README). */
const KNOWN_FEATURES = [];

/** Soft perf budget: hand-placed props incl. scatter count. */
export const PROPS_BUDGET = 400;

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isHex(s) {
  return typeof s === 'string' && HEX_RE.test(s);
}

/** Top-level keys of the v1 schema; anything else warns-and-skips. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'version', 'id', 'name', 'lengthM', 'sectorLengthM', 'roadWidthM',
  'waypoints', 'water', 'theme', 'props', 'scatter', 'scenery', 'features',
]);

/**
 * Validate a parsed track definition against the v1 contract.
 *
 * @param {*} def parsed JSON (anything)
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 *   errors: `<path>: expected X, got Y` contract violations — fatal on the
 *   server load path, the client's cue to fall back to its safe legacy look.
 *   warnings: tolerated oddities (unknown keys/types/features, budgets) —
 *   logged and skipped, never fatal. Callers prefix messages with the file
 *   name they came from.
 */
export function validateTrackDef(def) {
  const errors = [];
  const warnings = [];
  const v = {
    err: (path, expected, got) =>
      errors.push(`${path}: expected ${expected}, got ${stringify(got)}`),
    warn: (msg) => warnings.push(msg),
  };

  if (!isPlainObject(def)) {
    v.err('def', 'a JSON object with version/id/name/waypoints/theme', def);
    return { ok: false, errors, warnings };
  }

  // --- forward compatibility: unknown anything is skipped, never fatal ---
  for (const key of Object.keys(def)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) v.warn(`${key}: unknown key ignored (forward compat)`);
  }

  // --- identity + timing ---
  if (def.version === undefined) {
    v.err('version', `integer ${SUPPORTED_VERSION} (track contract version)`, 'missing');
  } else if (!Number.isInteger(def.version) || def.version < 1) {
    v.err('version', 'integer >= 1', def.version);
  } else if (def.version > SUPPORTED_VERSION) {
    v.err('version', `contract v${SUPPORTED_VERSION} or lower`, `v${def.version} (map is newer than this engine)`);
  }

  if (typeof def.id !== 'string' || !/^[a-z0-9-]+$/.test(def.id)) {
    v.err('id', 'string matching /^[a-z0-9-]+$/ (equal to the file name stem)', def.id);
  }
  if (typeof def.name !== 'string' || !def.name) {
    v.err('name', 'non-empty string', def.name);
  }
  if (!isNum(def.lengthM) || def.lengthM <= 0) {
    v.err('lengthM', 'number > 0 (lap length in meters)', def.lengthM);
  }
  if (!isNum(def.sectorLengthM) || def.sectorLengthM <= 0) {
    v.err('sectorLengthM', 'number > 0 that divides lengthM evenly', def.sectorLengthM);
  } else if (isNum(def.lengthM) && def.lengthM % def.sectorLengthM !== 0) {
    v.err('sectorLengthM', 'a divisor of lengthM', `${def.lengthM} % ${def.sectorLengthM} !== 0`);
  }
  // Required since MCPG-27 made the client build road geometry from it:
  // missing roadWidthM means NaN vertices, so the contract enforces it.
  if (!isNum(def.roadWidthM) || def.roadWidthM <= 0) {
    v.err('roadWidthM', 'number > 0 (road ribbon width in meters)', def.roadWidthM);
  }

  validateWaypoints(def, v);

  // --- decoration ---
  if (def.water !== undefined && def.water !== null) {
    if (!Array.isArray(def.water)) {
      v.err('water', 'array of {x, z, r} discs (or omit)', def.water);
    } else {
      def.water.forEach((w, i) => {
        if (!isPlainObject(w) || !isNum(w.x) || !isNum(w.z) || !isNum(w.r) || w.r <= 0) {
          v.err(`water[${i}]`, '{x, z, r} numbers with r > 0', w);
        }
      });
    }
  }

  validateTheme(def, v);
  validateProps(def, v);
  validateScatter(def.scatter, v.warn);
  validateScenery(def.scenery, v.warn);
  validateFeatures(def.features, v.warn);

  return { ok: errors.length === 0, errors, warnings };
}

function stringify(got) {
  if (got === undefined) return 'missing';
  try {
    return JSON.stringify(got) ?? String(got);
  } catch {
    return String(got);
  }
}

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}

/** Closed-loop control points: shape, spacing, self-intersection, size. */
function validateWaypoints(def, { err, warn }) {
  const wps = def.waypoints;
  if (!Array.isArray(wps)) {
    err('waypoints', 'array of [x, z] pairs (>= 6)', wps);
    return;
  }
  if (wps.length < 6) {
    err('waypoints', 'at least 6 points (closed Catmull-Rom loop)', wps.length);
    return;
  }

  let perimeter = 0;
  let maxCoord = 0;
  const segs = [];
  for (let i = 0; i < wps.length; i++) {
    const wp = wps[i];
    if (!Array.isArray(wp) || wp.length !== 2 || !isNum(wp[0]) || !isNum(wp[1])) {
      err(`waypoints[${i}]`, '[x, z] finite numbers', wp);
      continue;
    }
    const [x2, z2] = wps[(i + 1) % wps.length];
    if (!isNum(x2) || !isNum(z2)) continue; // reported next iteration
    const d = Math.hypot(x2 - wp[0], z2 - wp[1]);
    perimeter += d;
    maxCoord = Math.max(maxCoord, Math.abs(wp[0]), Math.abs(wp[1]));
    segs.push([wp[0], wp[1], x2, z2]);
    // degenerate neighbors break curve tangents -> NaN geometry downstream
    if (d < 2) {
      err(`waypoints[${i}]`, 'consecutive points >= 2 m apart (degenerate pairs produce NaN tangents)', `${d.toFixed(1)} m`);
    }
  }

  // self-intersections make the road ribbon overlap itself; reject them
  const n = segs.length;
  outer: for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbors share a waypoint
      if (segmentsProperlyCross(segs[i], segs[j])) {
        err(`waypoints[${i}]..[${j}]`, 'a simple (non-self-intersecting) loop', `segments ${i} and ${j} cross`);
        break outer;
      }
    }
  }

  // The engine rescales the polyline to exactly lengthM; shapes far off the
  // plausibility band squash/stretch the circuit (bounds as in the old
  // registry test).
  if (isNum(def.lengthM) && def.lengthM > 0 && perimeter > 0) {
    const ratio = perimeter / def.lengthM;
    if (ratio < 0.35 || ratio > 2.5) {
      err('waypoints', `polygon perimeter within 0.35x..2.5x of lengthM (${Math.round(def.lengthM)} m)`, `${Math.round(perimeter)} m = ${ratio.toFixed(2)}x`);
    }
  }

  // camera fit + ground margin assume roughly origin-centered coordinates
  if (maxCoord > 400) {
    warn(`waypoints: coordinate extent ${Math.round(maxCoord)} m exceeds +/-400 m camera-fit guidance`);
  }
}

/** Proper crossing test for segments [x1,z1,x2,z2]; touching endpoints excluded. */
function segmentsProperlyCross([ax, az, bx, bz], [cx, cz, dx, dz]) {
  // which side of segment P->Q point R falls on (0 = collinear)
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const A = [ax, az], B = [bx, bz], C = [cx, cz], D = [dx, dz];
  const d1 = side(A, B, C), d2 = side(A, B, D);
  const d3 = side(C, D, A), d4 = side(C, D, B);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

/** Theme block: required palette pieces, per-shape rules; unknown keys skip. */
function validateTheme(def, { err, warn }) {
  const theme = def.theme;
  if (!isPlainObject(theme)) {
    err('theme', 'an object with sky/ground/road/pit/ambient/sun colors', theme);
    return;
  }
  for (const key of Object.keys(theme)) {
    if (!(key in THEME_SHAPES)) warn(`theme.${key}: unknown key ignored (forward compat)`);
  }
  for (const key of REQUIRED_THEME_KEYS) {
    if (theme[key] === undefined) err(`theme.${key}`, 'present (required by the v1 contract)', 'missing');
  }
  for (const [key, shape] of Object.entries(THEME_SHAPES)) {
    const val = theme[key];
    if (val === undefined) continue;
    switch (shape) {
      case 'hex':
        if (!isHex(val)) err(`theme.${key}`, '"#rrggbb" color string', val);
        break;
      case 'bool':
        if (typeof val !== 'boolean') err(`theme.${key}`, 'boolean', val);
        break;
      case 'ground':
      case 'road': {
        if (!isPlainObject(val)) {
          err(`theme.${key}`, '{ base, spot, patch?, tileM? }', val);
          break;
        }
        if (!isHex(val.base)) err(`theme.${key}.base`, '"#rrggbb" color string', val.base);
        if (!isHex(val.spot)) err(`theme.${key}.spot`, '"#rrggbb" color string', val.spot);
        if (shape === 'ground' && val.patch !== undefined && !isHex(val.patch)) {
          err(`theme.${key}.patch`, '"#rrggbb" color string', val.patch);
        }
        if (val.tileM !== undefined && (!isNum(val.tileM) || val.tileM <= 0)) {
          err(`theme.${key}.tileM`, 'positive number (meters per texture tile)', val.tileM);
        }
        break;
      }
      case 'curb': {
        // whole block optional: omitting it simply renders no curbs
        if (!isPlainObject(val)) {
          err('theme.curb', '{ red, white, threshold? } — or omit the block entirely', val);
          break;
        }
        if (!isHex(val.red)) err('theme.curb.red', '"#rrggbb" color string', val.red);
        if (!isHex(val.white)) err('theme.curb.white', '"#rrggbb" color string', val.white);
        if (val.threshold !== undefined && (!isNum(val.threshold) || val.threshold <= 0)) {
          err('theme.curb.threshold', 'positive number (curvature 1/m above which curbs appear)', val.threshold);
        }
        break;
      }
      case 'ambient': {
        if (!isPlainObject(val)) {
          err('theme.ambient', '{ sky, ground, intensity? }', val);
          break;
        }
        if (!isHex(val.sky)) err('theme.ambient.sky', '"#rrggbb" color string', val.sky);
        if (!isHex(val.ground)) err('theme.ambient.ground', '"#rrggbb" color string', val.ground);
        if (val.intensity !== undefined && (!isNum(val.intensity) || val.intensity <= 0)) {
          err('theme.ambient.intensity', 'positive number', val.intensity);
        }
        break;
      }
      case 'sun': {
        if (!isPlainObject(val)) {
          err('theme.sun', '{ color, intensity? }', val);
          break;
        }
        if (!isHex(val.color)) err('theme.sun.color', '"#rrggbb" color string', val.color);
        if (val.intensity !== undefined && (!isNum(val.intensity) || val.intensity <= 0)) {
          err('theme.sun.intensity', 'positive number', val.intensity);
        }
        break;
      }
    }
  }
  // cross-field: discs need something to render with
  const waters = def.water;
  if (Array.isArray(waters) && waters.length > 0 && !isHex(theme.water)) {
    warn('water[]: theme.water color missing — the discs will not render');
  }
}

/** Props: known types validated strictly, unknown types warn-and-skip. */
function validateProps(def, { err, warn }) {
  const props = def.props;
  if (props !== undefined && props !== null && !Array.isArray(props)) {
    err('props', 'array of {type, x, z, ...} (or omit)', props);
    return;
  }
  (props ?? []).forEach((p, i) => {
    if (!isPlainObject(p)) {
      err(`props[${i}]`, 'an object with a "type"', p);
      return;
    }
    const spec = PROP_TYPES[p.type];
    if (!spec) {
      warn(`props[${i}].type: unknown type ${JSON.stringify(p.type)} skipped (known: ${Object.keys(PROP_TYPES).join(', ')})`);
      return;
    }
    if (!isNum(p.x) || !isNum(p.z)) {
      err(`props[${i}]`, 'numeric x/z position', { x: p.x, z: p.z });
    }
    if (p.rot !== undefined && !isNum(p.rot)) err(`props[${i}].rot`, 'number (yaw radians)', p.rot);
    if (p.y !== undefined && !isNum(p.y)) err(`props[${i}].y`, 'number (elevation meters)', p.y);
    for (const k of spec.nums ?? []) {
      if (p[k] !== undefined && (!isNum(p[k]) || p[k] <= 0)) err(`props[${i}].${k}`, 'positive number', p[k]);
    }
    for (const k of spec.hexes ?? []) {
      if (p[k] !== undefined && !isHex(p[k])) err(`props[${i}].${k}`, '"#rrggbb" color string', p[k]);
    }
  });
  // soft perf budget: scatter adds rejection sampling on the main thread —
  // checked even when props itself is omitted
  const scatterCount = Number.isInteger(def.scatter?.count) ? def.scatter.count : 0;
  const total = (props?.length ?? 0) + scatterCount;
  if (total > PROPS_BUDGET) warn(`props: ${total} total (incl. scatter) over the ~${PROPS_BUDGET} perf budget`);
}

/** Scatter block: seeded deterministic placement; oddities warn, not fail. */
function validateScatter(scatter, warn) {
  if (scatter === undefined || scatter === null) return;
  if (!isPlainObject(scatter)) {
    warn(`scatter: expected an object or null, got ${JSON.stringify(scatter)} — ignored`);
    return;
  }
  if (!PROP_TYPES[scatter.type]) {
    warn(`scatter.type: unknown type ${JSON.stringify(scatter.type)} — nothing will scatter (known: ${Object.keys(PROP_TYPES).join(', ')})`);
  }
  if (scatter.count !== undefined && (!Number.isInteger(scatter.count) || scatter.count < 0)) {
    warn(`scatter.count: expected a non-negative integer, got ${JSON.stringify(scatter.count)}`);
  }
  if (scatter.seed !== undefined && !Number.isInteger(scatter.seed)) {
    warn(`scatter.seed: expected an integer, got ${JSON.stringify(scatter.seed)}`);
  }
  if (scatter.minOffsetM !== undefined && (!isNum(scatter.minOffsetM) || scatter.minOffsetM < 0)) {
    warn(`scatter.minOffsetM: expected a non-negative number, got ${JSON.stringify(scatter.minOffsetM)}`);
  }
}

/**
 * Scenery block (voxel dressing, MCPG-64): purely decorative, so every
 * oddity warns-and-skips — the engine renders a safe baseline without it,
 * and one malformed stand must not kill the map. Known list entries are
 * validated individually (a bad entry is skipped, siblings still render).
 */
function validateScenery(scenery, warn) {
  if (scenery === undefined || scenery === null) return;
  if (!isPlainObject(scenery)) {
    warn(`scenery: expected an object or null, got ${JSON.stringify(scenery)} — ignored`);
    return;
  }
  const KNOWN_SCENERY_KEYS = new Set([
    'version', 'island', 'garages', 'stands', 'tireWalls', 'drs',
    'floodlights', 'scatterExclusions',
  ]);
  for (const key of Object.keys(scenery)) {
    if (!KNOWN_SCENERY_KEYS.has(key)) warn(`scenery.${key}: unknown key ignored (forward compat)`);
  }
  if (scenery.version !== undefined && (!Number.isInteger(scenery.version) || scenery.version < 1)) {
    warn('scenery.version: expected an integer >= 1');
  }
  if (scenery.island !== undefined) {
    if (!isPlainObject(scenery.island)) warn('scenery.island: expected an object — ignored');
    else if (scenery.island.marginM !== undefined && (!isNum(scenery.island.marginM) || scenery.island.marginM <= 0)) {
      warn('scenery.island.marginM: expected a positive number');
    }
  }
  if (scenery.garages !== undefined && (!Number.isInteger(scenery.garages) || scenery.garages < 0)) {
    warn('scenery.garages: expected a non-negative integer (engine clamps to its own 2..12 range)');
  }

  /** Every entry must be an object carrying the required numeric fields. */
  const checkList = (listName, required, optionalInts = [], optionalSides = false) => {
    const list = scenery[listName];
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) {
      warn(`scenery.${listName}: expected an array of objects — ignored`);
      return;
    }
    list.forEach((e, i) => {
      if (!isPlainObject(e)) {
        warn(`scenery.${listName}[${i}]: expected an object — skipped`);
        return;
      }
      for (const k of Object.keys(e)) {
        if (!required.includes(k) && !optionalInts.includes(k) && !(optionalSides && k === 'side')) {
          warn(`scenery.${listName}[${i}].${k}: unknown key ignored (forward compat)`);
        }
      }
      for (const k of required) {
        if (!isNum(e[k])) warn(`scenery.${listName}[${i}].${k}: expected a finite number — entry skipped`);
      }
      for (const k of optionalInts) {
        if (e[k] !== undefined && (!Number.isInteger(e[k]) || e[k] < 1)) {
          warn(`scenery.${listName}[${i}].${k}: expected a positive integer`);
        }
      }
      if (optionalSides && e.side !== undefined && e.side !== -1 && e.side !== 1) {
        warn(`scenery.${listName}[${i}].side: expected -1 or 1`);
      }
    });
  };
  checkList('stands', ['atS'], ['arcM'], true);
  checkList('tireWalls', ['atS'], ['count']);
  checkList('drs', ['atS'], [], true);

  const fl = scenery.floodlights;
  if (fl !== undefined && fl !== null) {
    if (!Array.isArray(fl)) warn('scenery.floodlights: expected an array of {x, z} — ignored');
    else fl.forEach((f, i) => {
      if (!isPlainObject(f) || !isNum(f.x) || !isNum(f.z)) {
        warn(`scenery.floodlights[${i}]: expected {x, z} numbers — skipped`);
      }
    });
  }

  const ex = scenery.scatterExclusions;
  if (ex !== undefined && ex !== null) {
    if (!Array.isArray(ex)) warn('scenery.scatterExclusions: expected [x, z, r] triples — ignored');
    else ex.forEach((e, i) => {
      if (!Array.isArray(e) || e.length !== 3 || !e.every(isNum) || e[2] <= 0) {
        warn(`scenery.scatterExclusions[${i}]: expected [x, z, r] numbers with r > 0 — skipped`);
      }
    });
  }
}

/** Capability flags gate optional engine features; unknown ones warn-skip. */
function validateFeatures(features, warn) {
  if (features === undefined || features === null) return;
  if (!Array.isArray(features) || features.some((f) => typeof f !== 'string')) {
    warn('features: expected an array of strings — ignored');
    return;
  }
  for (const f of features) {
    if (!KNOWN_FEATURES.includes(f)) warn(`features: "${f}" is not implemented by this engine — ignored`);
  }
}

/**
 * Strip everything the engine would ignore anyway: unknown top-level fields,
 * unknown theme keys and props of unknown types. Returns a fresh def — the
 * input is never mutated. Call after validateTrackDef() accepted the map so
 * sanitized output is safe to hand to the scene builders. (Warnings were
 * already produced by the validation pass; stripping itself is silent.)
 */
export function sanitizeTrackDef(def) {
  const KEPT_KEYS = [
    'version', 'id', 'name', 'lengthM', 'sectorLengthM', 'roadWidthM',
    'waypoints', 'water', 'theme', 'props', 'scatter', 'scenery', 'features',
  ];
  const clean = {};
  for (const key of KEPT_KEYS) {
    if (def[key] !== undefined) clean[key] = def[key];
  }
  if (isPlainObject(clean.theme)) {
    const theme = {};
    for (const key of Object.keys(THEME_SHAPES)) {
      if (clean.theme[key] !== undefined) theme[key] = clean.theme[key];
    }
    clean.theme = theme;
  }
  if (Array.isArray(clean.props)) {
    clean.props = clean.props.filter((p) => isPlainObject(p) && PROP_TYPES[p.type]);
  }
  return clean;
}
