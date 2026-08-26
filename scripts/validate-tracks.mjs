#!/usr/bin/env node
/**
 * Track validator (MCPG-63) — check map files against the track contract
 * WITHOUT starting the game. The same module the server registry and the
 * spectator client use (client/js/trackContract.js), so what passes here is
 * exactly what loads in the engine.
 *
 *   node scripts/validate-tracks.mjs                 # every tracks/*.json
 *   node scripts/validate-tracks.mjs tracks/my.json  # specific file(s)
 *
 * Exit code 0 = all files conform; 1 = at least one error. Warnings do not
 * fail the run — they report things the engine will skip (unknown fields,
 * prop types, feature flags) or soft budgets exceeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrackDef } from '../client/js/trackContract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracksDir = path.join(root, 'tracks');

const args = process.argv.slice(2);
const explicit = args.length > 0;
const files = explicit
  ? args.map((f) => path.resolve(f))
  : fs
      .readdirSync(tracksDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(tracksDir, f));

if (files.length === 0) {
  console.error('no track files given and none found in tracks/');
  process.exit(1);
}

let failed = false;
// registry rule a single def cannot check: ids must be unique across the set
const seenIds = new Map();

for (const file of files) {
  const rel = path.relative(root, file);
  const problems = [];
  const warnings = [];

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`not valid JSON (${e.message})`);
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const stem = path.basename(file).replace(/\.json$/, '');
    // id must equal the file name stem so GET /tracks/<id>.json stays honest
    if (raw.id !== undefined && raw.id !== stem) {
      problems.push(`id: expected "${stem}" (the file name stem), got ${JSON.stringify(raw.id)}`);
      raw = null; // skip the rest; the id is the map's primary key
    }
  }

  if (raw) {
    const check = validateTrackDef(raw);
    problems.push(...check.errors);
    warnings.push(...check.warnings);
    if (typeof raw.id === 'string') {
      if (seenIds.has(raw.id)) {
        problems.push(`duplicate track id "${raw.id}" (also in ${path.relative(root, seenIds.get(raw.id))})`);
      } else {
        seenIds.set(raw.id, file);
      }
    }
  }

  if (problems.length > 0) {
    failed = true;
    console.log(`FAIL ${rel}`);
    for (const p of problems) console.log(`     ${p}`);
  } else {
    console.log(`OK   ${rel}${explicit ? ` (${raw.name ?? '?'})` : ''}`);
  }
  for (const w of warnings) console.log(`     warning: ${w}`);
}

process.exit(failed ? 1 : 0);
