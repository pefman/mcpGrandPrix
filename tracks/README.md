# Track authoring — add a map without touching engine code

A track is a **pure data file**: drop a conforming `tracks/<id>.json` into
this directory and it starts races and renders correctly — zero engine
changes. The engine interprets the map; the map never contains logic.

Before deploying, validate any file without starting the game:

```sh
node scripts/validate-tracks.mjs                 # every tracks/*.json
node scripts/validate-tracks.mjs tracks/my.json  # one file
```

The registry re-checks every file at server startup and refuses to boot on a
contract violation; the spectator client falls back to a plain legacy ring
(with a console warning) if a fetched def is broken. Unknown fields, unknown
prop types and unknown `features` flags are **warned about and skipped** —
they never crash anything. The rules below are enforced by
`client/js/trackContract.js` (one module shared by validator, server and
client) and pinned by `test/trackContract.test.js`.

## Principles

1. **A map is pure data.** Geometry, palette, decoration placement, timing
   identity. No logic, no engine tuning, no code — ever.
2. **The engine interprets; the map describes.** The same field means the
   same thing on every map; rendering *algorithms* (curve fitting, curb
   placement, camera framing, pit-lane layout) live only in the engine.
3. **Forward compatibility by tolerance.** Unknown fields / unknown prop
   types / unknown feature flags are warned about and skipped, never fatal.
4. **Fail fast on bad data we do know.** A malformed known field aborts
   server startup with an actionable message; the client falls back safely
   instead of rendering garbage.
5. **Optional engine features are opt-in** via `"features": [...]`. Old maps
   never set them and keep working unchanged; new maps opt in explicitly.

## Top-level schema (`"version": 1`)

| Field | Type | Req | Rules / notes |
|---|---|---|---|
| `version` | int | **yes** | Must be `1`. Same-major loads; a newer major is refused (server: fail fast, client: legacy fallback + warning). |
| `id` | string | **yes** | `/^[a-z0-9-]+$/`; must equal the filename stem (`tracks/<id>.json`); unique across the registry. |
| `name` | string | **yes** | Non-empty. Shown in HUD title + vote panel. |
| `lengthM` | number | **yes** | Lap length in meters, > 0. Sim-authoritative; the client rescales its curve to match. |
| `sectorLengthM` | number | **yes** | > 0, divides `lengthM` evenly. |
| `roadWidthM` | number | **yes** | Road ribbon width in m. Sensible 8–24 (existing maps: 12–13). |
| `waypoints` | `[x, z][]` | **yes** | ≥ 6 pairs of finite numbers. Control points of a closed centripetal Catmull-Rom loop, uniformly rescaled to exactly `lengthM`. Invariants: no duplicate closing point; consecutive points ≥ 2 m apart (degenerate pairs produce NaN tangents); no self-intersections; polygon perimeter within 0.35×–2.5× of `lengthM`; coordinates within ±~400 m of origin (camera fit + ground margin headroom). |
| `water` | `{x, z, r}[]` | no (default none) | Flat discs, `r` > 0. Rendered only if `theme.water` is also set. Scatter avoids water automatically. |
| `theme` | object | **yes** | See theme reference. Unknown keys → warn + ignore. |
| `props` | `{type, ...}[]` | no (default none) | Hand-placed decorations from the v1 catalog below. Unknown `type` → skip + warn. |
| `scatter` | object \| null | no | `{type, count?, seed?, minOffsetM?}` — deterministic seeded placement inside the circuit bbox, kept clear of road (+`minOffsetM`, default 14 m) and water. `count` default 0; `seed` any int (same seed ⇒ same layout); `type` from the catalog. |
| `scenery` | object \| null | no | Voxel-dressing overrides (MCPG-64): `{version?, island?: {marginM}, garages?, stands[], tireWalls[], drs[], floodlights[], scatterExclusions[]}`. Every field optional — omitted pieces fall back to automatic placement derived from the circuit geometry (see docs/track-format.md for the per-field reference; malformed entries are skipped individually, never fatal). |
| `features` | `string[]` | no (default none) | Capability flags gating optional engine behavior (reserved examples: `"elevation"`, `"weather-zones"`). An older engine warns + ignores flags it doesn't implement. |

Soft budget: hand-placed props incl. scatter count ≲ 400 (warn above; scatter
does rejection sampling on the main thread).

## Theme reference (all colors are `#rrggbb` strings)

| Key | Shape | Notes |
|---|---|---|
| `sky` | hex, req | Scene background. |
| `ground` | `{base, spot, patch?, tileM}` , req | Ground speckle texture; `patch` optional third tone; `tileM` = meters per tile (small ints). |
| `road` | `{base, spot, tileM}`, req | Road ribbon texture. |
| `curb` | `{red, white, threshold?}`, opt | Whole block optional — omit ⇒ no curbs anywhere. `threshold` = curvature 1/m above which curbs appear (default ≈ radius < 48 m). |
| `pit` | hex, req | Pit-lane paint. Every map gets a pit lane drawn (engine-owned geometry), so this is effectively required. |
| `barriers` | bool, opt | Outer wall ring on/off. |
| `ambient` | `{sky, ground, intensity?}`, req | Hemisphere light; intensity defaults 1.0. |
| `sun` | `{color, intensity?}`, req | Directional light; intensity defaults 1.0. |
| `water` | hex, opt | Required for `water[]` discs to render. |
| `fxAccent` | hex, opt | FX accent color (default cyan `#7de8ff`). |

## Prop catalog (v1)

Common fields: `x`, `z` (required numbers), `rot` (yaw radians), `y`
(elevation meters) — both optional.

| Type | Params | Notes |
|---|---|---|
| `palm` | `h?` | Height default randomized 6–9 m. |
| `pine` | — | Randomized scale. |
| `building` | `w?=24`, `d?=24`, `h?=40`, `color?`, `neon?` (hex roof band) | `color` default derived from position; `h` feeds camera fit. |
| `grandstand` | `w?=30`, `d?=12`, `h?=8` | Faces local +z; rotate to face track. |
| `rock` | — | Randomized scale. |
| `boat` | — | For water themes. |
| `lamp` | — | Arm points local +x; scatter aims it at the road automatically. |
| `sign` | `w?=8`, `h?=5`, `color?` | Sponsor sign; panel faces local +z. |

Unknown `type` → skipped with a console warning (never crashes).

## What belongs where

**Map file owns:** waypoints/geometry, `lengthM`/`sectorLengthM`, road width,
palette (`theme.*`), decoration placement (`props`, `scatter`, `water`),
capability flags (`features`).

**Engine owns — identical for every map, not expressible in map files:**

- Curve fitting / rescaling waypoints to exact `lengthM` (`client/js/track.js`)
- Curvature analysis → curb-run placement
- Start/finish checker line, sector ticks
- Pit-lane geometry (fixed arc, offset, box positions)
- Camera framing / diorama island / ground sizing
- All sim rules (`src/sim/*` consumes only id/name/lengthM/sectorLengthM)
- Minimap drawing (fed from the same fitted curve)

No engine logic in map files, ever.

## Engine-interpreted features (derived, not declared)

The scene implements a fixed set of circuit features on **every** map.
They are not schema fields — the engine derives them from the geometry
(`client/js/scenery.js`, `track.js`), so a bare map with only the required
fields still renders the complete look. This section is the source of
truth for what a map author gets for free, what they can tune, and what
they cannot touch. Design work builds against this list.

| Feature | What drives it | Author control via map data |
|---|---|---|
| Floating island (two-tone grass slab + dirt skirt + rock keel) | Circuit bbox + `scenery.island.marginM` (default 85 m) | Footprint size only (`marginM`); shape/colors are engine-fixed |
| Two-tone asphalt strips | `theme.road` (`base`, `spot`, `tileM`) + curve geometry | Colors and tile scale; strip pattern is engine-drawn |
| Curvature curbs | `theme.curb` (`red`, `white`, `threshold`) + curvature analysis | Colors + sensitivity (`threshold` = radius below which curbs appear); placement is automatic |
| Rumble strips + center dashes | Engine-painted along the whole lap | None (fixed palette/placement) |
| Start/finish: checker line, grid boxes, gantry with animated red→green light cycle | Derived from `s = 0` on the fitted curve | None |
| Pit lane + garages + striped roofs + crew figures | Fixed arc offset from the start line; `scenery.garages` count (default 8, clamped 2–12); paint `theme.pit`; pit boxes follow garage slots (one per joined car) | Garage count + apron color; layout/crew are engine-fixed |
| Grandstands with colored seats | `scenery.stands[]` (`atS`, `arcM?`, `side?`); omitted ⇒ auto: main straight + sharpest apex + mid-lap | Placement per stand; seat palette is engine-fixed |
| Apex tire walls | `scenery.tireWalls[]` (`atS`, `count?`); omitted ⇒ auto at curvature peaks | Placement per wall |
| Red/white outer barriers | `theme.barriers: true` ring outside the road, skipping curve insides | On/off only |
| DRS boards | `scenery.drs[]` (`atS`, `side?`); omitted ⇒ auto at fixed lap fractions | Placement per board |
| Floodlight towers | `scenery.floodlights[]` (`x`, `z`); omitted ⇒ island corners | Placement per tower |
| Water lagoons inset into the island top | `water[]` discs + `theme.water` hex | Position/size/color |
| Seeded scatter (palms/pines/…) | `scatter` block; kept clear of road, water, `scenery.scatterExclusions[]` | Type/count/seed/exclusions |

Candidate optional fields (future contract versions — **not** implemented;
do not rely on them): per-map crew-shirt / stand-seat palettes, barrier
density, gantry light-cycle timing, curb threshold per sector.

## Workflow for a new map

1. Copy an existing file as a starting point, rename to `tracks/<your-id>.json`
   and set `"id"` to match the stem.
2. Edit waypoints/theme/props. Keep the invariants above.
3. `node scripts/validate-tracks.mjs tracks/<your-id>.json` until clean.
4. See it live before deploy: start the server with `MCGP_TRACK=<your-id>`
   and open the spectator page (the design sandbox, MCPG-60, will reuse the
   same `validateTrackDef` so errors show inline while editing).
5. Ship it — no engine changes needed unless you invented a *new kind* of
   feature, which is exactly what `features` flags are for negotiating.
