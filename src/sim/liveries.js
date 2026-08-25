/**
 * Agent liveries: each car gets a distinct, stable color for the race.
 *
 * Assignment is sequential by join order (first joiner = P1 = PALETTE[0]),
 * decided at addAgent time — no sim RNG, so determinism ("same seed = same
 * race") is preserved, and it is idempotent (same name → same car → same
 * color). PALETTE must hold at least CONFIG.race.maxAgents entries so every
 * grid is fully distinct; if maxAgents is ever raised past the palette
 * length the overflow falls back to a neutral gray.
 *
 * Colors are per-race identity: each new session restarts at PALETTE[0].
 */
import { CONFIG } from '../config.js';

export const LIVERY_FALLBACK = '#8a8f98';

// The legacy 8 client colors (continuity with the deployed look) + 4 extras.
export const PALETTE = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759',
  '#0a84ff', '#af52de', '#ff2d55', '#e5e5ea',
  '#32ade6', '#ff6ab8', '#cd8a3e', '#2fbf9f',
];

/** Color for the car at 0-based slot `slotIndex` (join order). */
export function colorForSlot(slotIndex) {
  if (slotIndex < 0) return LIVERY_FALLBACK;
  if (slotIndex >= PALETTE.length) {
    // Should never happen while PALETTE.length >= CONFIG.race.maxAgents
    // (guarded by a unit test); degrade gracefully if it ever does.
    console.warn(
      `livery palette exhausted at slot ${slotIndex} (maxAgents=${CONFIG.race.maxAgents}); using fallback color`,
    );
    return LIVERY_FALLBACK;
  }
  return PALETTE[slotIndex];
}
