# Track definition format

A track is one JSON file in `tracks/`. The server validates the identity
fields (`id`, `name`, `lengthM`, `sectorLengthM`, `waypoints`) and serves
the whole file to the spectator client at `GET /tracks/<id>.json`; the sim
only reads identity + length. Everything visual is client-side.

All visual fields are **optional** and forward-compatible: unknown fields
are ignored by the client, and a def that omits any of them still renders
(the client derives sensible defaults from the geometry).

## Core fields

| field | type | notes |
| --- | --- | --- |
| `id` | string | `[a-z0-9-]+`, unique, selects `MCGP_TRACK` |
| `name` | string | shown in the HUD |
| `lengthM` | number | sim length in meters; the client rescales the centerline to match |
| `sectorLengthM` | number | must divide `lengthM` |
| `roadWidthM` | number | road width in meters (default 14) |
| `waypoints` | `[x, z][]` | >= 6 points; closed Catmull-Rom centerline |
| `water` | `{ x, z, r }[]` | lagoon circles inset into the island top |
| `props` | `object[]` | hand-placed props (`palm`, `pine`, `rock`, `boat`, `building`, `sign`, `lamp`), each `{ type, x, z, rot?, ... }` |
| `scatter` | `{ type, count, seed, minOffsetM?, exclusions? }` | seeded scatter of one prop type around the circuit |
| `theme` | object | palette + lighting (sky, ground, road, curb, pit, water, barriers, ambient, sun, fxAccent) |

## `scenery` block (MCPG-64)

Drives the voxel art direction from `client/design/reference/f1-track.html`.
Every field is optional; omitted pieces fall back to automatic placement
derived from the circuit geometry (island footprint from the bbox, stands on
the main straight + sharpest apex + mid-lap, tire walls on curvature peaks,
DRS boards at fixed fractions, floodlights at island corners).

```json
"scenery": {
  "version": 1,
  "island":  { "marginM": 85 },
  "garages": 8,
  "stands":      [{ "atS": 40, "arcM": 90, "side": 1 }],
  "tireWalls":   [{ "atS": 210, "count": 6 }],
  "drs":         [{ "atS": 120, "side": -1 }],
  "floodlights": [{ "x": 190, "z": 150 }],
  "scatterExclusions": [[70, 120, 48]]
}
```

| field | type | meaning |
| --- | --- | --- |
| `version` | number | def authoring version of this block (currently 1). A client that doesn't recognize a newer version still renders with defaults instead of breaking |
| `island.marginM` | number | grass island margin beyond the circuit bbox, per side |
| `garages` | number | pit garage count (2–12); the pit boxes cars tween to follow the garage slots |
| `stands[]` | `{ atS, arcM?, side? }` | curved grandstand centered at `atS` meters along the lap, `arcM` long; `side` ±1 picks the track side, omit to auto-place outside the circuit |
| `tireWalls[]` | `{ atS, count? }` | stacked tire wall outside the corner at `atS`; omit the list for auto apex detection |
| `drs[]` | `{ atS, side? }` | DRS board at `atS` |
| `floodlights[]` | `{ x, z }` | floodlight tower at world coords |
| `scatterExclusions[]` | `[x, z, r]` | circles the prop scatter must avoid (pit complex, stands, …); the legacy `scatter.exclusions` field is honored too |

Schema notes (reconciled with the MCPG-63 track contract — `scenery` is a
known, validated top-level field; the canonical authoring reference is
`tracks/README.md`):

- the client tolerates unknown fields anywhere in the def and unknown
  `scenery` versions (defaults win);
- malformed entries inside known lists (wrong types, non-object items) are
  skipped individually — one bad stand must not kill the map;
- `atS` values wrap, so `atS: 980` on a 1000 m lap is 20 m before the line;
- the baseline look (voxel island, two-tone asphalt, start gantry, pit
  garages + crew, red/white barriers, rumble strips, dashes, grid boxes)
  renders even when the whole `scenery` block is absent.
