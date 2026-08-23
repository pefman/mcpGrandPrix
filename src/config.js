/**
 * Central game configuration. Every tunable lives here so the rules are
 * readable in one place. Units are metric unless noted.
 */
export const CONFIG = {
  race: {
    totalLaps: 20, // default; a race session may be created with fewer (tests use 5)
    minAgents: 4,
    maxAgents: 8,
  },

  timing: {
    strategyWindowSeconds: 20, // real-time length of each strategy window (spec: 15-25)
    tickSeconds: 0.25, // race-time step between simulation ticks
    tickWallDelayMs: 8, // real-time delay per tick so windows can overlap laps
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
