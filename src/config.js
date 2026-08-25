/**
 * Central game configuration. Every tunable lives here so the rules are
 * readable in one place. Units are metric unless noted.
 *
 * Env overrides (read once at process start):
 *   MIN_AGENTS — cars required before the race leaves `setup` (default 4).
 *                Public demo / solo external play: set MIN_AGENTS=1.
 *   RESULTS_HOLD_SECONDS — persistent server holds results before opening
 *                the next race session (default 60). (MCPG-34)
 *   PENDING_GRACE_SECONDS — how long a queued agent has to claim its seat in
 *                the next session before its queue entry expires (default 30).
 *                (MCPG-34)
 *   VOTE_WINDOW_SECONDS — post-race spectator track-voting window (default
 *                30). The winner becomes the next race's track; persisted in
 *                the log volume so a restart cannot lose it. (MCPG-28)
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CONFIG = {
  race: {
    totalLaps: 10, // product default; a race session may be created with fewer (dev/tests use 5)
    minAgents: envInt('MIN_AGENTS', 4),
    maxAgents: 8,
  },

  timing: {
    strategyWindowSeconds: 30, // real-time length of each strategy window (product target ~30 s)
    reactiveWindowSeconds: 10, // real-time length of a reactive window (spec: 8-15)
    tickSeconds: 0.25, // race-time step between simulation ticks
    // Wall delay per tick. 250 = 1x real time (0.25 s sim per 0.25 s wall),
    // so a lap (40 ticks) takes ~10 s of spectator wall time. Pacing only:
    // it never enters sim math, same seed = same race at any pace.
    tickWallDelayMs: 250,
    // Persistent server (MCPG-34): after the final lap the results are held
    // for this long, then a fresh race session opens (setup) so queued agents
    // and late joiners have a race to get into.
    resultsHoldSeconds: envInt('RESULTS_HOLD_SECONDS', 60),
    // A name in the pending queue is only promised a seat in the NEXT session.
    // If the name is still queued when that session's grace clock expires, the
    // entry is dropped (the queue is FIFO order, not a reservation).
    pendingGraceSeconds: envInt('PENDING_GRACE_SECONDS', 30),
    // Post-race spectator track voting (MCPG-28): after the last car finishes,
    // the spectator window shows a VOTE overlay for this long and the winner
    // becomes the next race's track (persisted; 0 disables the window and
    // falls back to deterministic rotation).
    voteWindowSeconds: envInt('VOTE_WINDOW_SECONDS', 30),
  },

  reactive: {
    // Close battle fires when the gap is this tight AND the car behind is faster.
    // Kept at/under overtaking.opportunityDistanceM so every battle is also an
    // overtake opportunity; the reactive window replaces the immediate roll.
    closeBattleGapM: 30,
    criticalTireWearPct: 80, // open a window when wear crosses this (once per stint)
    pitOpportunityWearPct: 55, // strategy-driven mid-stint pit offer (once per lap)
    maxWindowsPerLap: 4, // hard cap so a messy battle does not stall the race
  },

  physics: {
    baseSpeedMs: 100, // clean-air speed at "normal" pace with fresh tires
    paceMultipliers: { push: 1.03, normal: 1.0, manage: 0.965 },
    tireGripDrop: 0.06, // speed multiplier = 1 - tireGripDrop * (wear/100)
    trafficDragDistanceM: 20, // slow down if you are this close behind the car ahead
    trafficDragFactor: 0.95,
  },

  tires: {
    wearPerLapBase: 18, // % wear per lap at normal pace on normal management
    paceWearFactors: { push: 1.5, normal: 1.0, manage: 0.65 },
    strategyWearFactors: { manage: 0.8, normal: 1.0, push: 1.2 },
  },

  fuel: {
    startKg: 95,
    perLapNormalKg: 4.0, // 95 kg covers ~20 laps at normal pace (23.75)
    paceFactors: { push: 1.12, normal: 1.0, manage: 0.92 },
  },

  overtaking: {
    opportunityDistanceM: 30, // attempt when this close behind a faster-gap car
    baseProbability: 0.05, // per opportunity tick
    speedDeltaCoefficient: 1.0, // + this * (dv / leaderSpeed)
    attackBonus: 0.08,
    defendPenalty: 0.12,
    minProbability: 0.01,
    maxProbability: 0.9,
    cooldownTicks: 4, // ticks between attempts for the same car pair
  },

  pit: {
    stopSeconds: 18,
  },

  grid: {
    formationGapM: 15, // gap between cars on the grid
  },
};

export const PACES = Object.keys(CONFIG.physics.paceMultipliers);
export const TIRE_STRATEGIES = Object.keys(CONFIG.tires.strategyWearFactors);
