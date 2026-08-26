/**
 * MCP tool layer. The `host` is either a bare RaceSession (single-race,
 * used by tests) or a RaceOrchestrator (persistent server, MCPG-34). The
 * orchestrator routes joins through `joinAgent` so agents joining outside
 * `setup` land in the pending queue instead of a dead-end error; a bare
 * session keeps the old join_failed behavior.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TACTIC_LIMITS } from '../sim/tactics.js';
import { ARCHETYPE_KEYS } from '../sim/archetypes.js';

// Strategy packet: the four tactical levers + a pit request. Every field has
// a default so a minimal `{}` packet is always valid; unknown fields are
// rejected to keep the contract tight.
//
// MCPG-62 schema fix: aggression/defend are BINARY 0|1 (the sim's
// parseStrategy only ever accepted 0|1 — the old 0..1 float advertisement
// made every fractional submission an invalid_strategy). Defaults align
// with the sim's defaultStrategy() (0 = off).
const strategySchema = z
  .object({
    pace: z.enum(['push', 'normal', 'manage']).default('normal'),
    tireManagement: z.enum(['manage', 'normal', 'push']).default('normal'),
    aggression: z.union([z.literal(0), z.literal(1)]).default(0),
    defend: z.union([z.literal(0), z.literal(1)]).default(0),
    pitNow: z.boolean().default(false),
  })
  .strict();

// Tactic envelope (MCPG-62): the optional wrapper a team plan can carry.
// `radio` is the team's message to the driver; `proposals` are the tactic
// cards (fixed archetype keys, one recommended). The server stamps each
// card with projections (projectedPos/delta/risk) before broadcasting.
// Mirrors validateTacticEnvelope() in src/sim/tactics.js (the sim-level
// authority; keep the two in sync).
const proposalSchema = z
  .object({
    key: z.enum(ARCHETYPE_KEYS),
    label: z.string().min(1).max(TACTIC_LIMITS.labelMax),
    narrative: z.string().max(TACTIC_LIMITS.narrativeMax).optional(),
    packet: strategySchema,
    recommend: z.boolean(),
    confidence: z.number().int().min(TACTIC_LIMITS.confidenceMin).max(TACTIC_LIMITS.confidenceMax),
  })
  .strict();

const tacticEnvelopeSchema = z
  .object({
    radio: z.string().max(TACTIC_LIMITS.radioMax).optional(),
    proposals: z.array(proposalSchema).min(1).max(TACTIC_LIMITS.maxProposals),
  })
  .strict()
  .refine(
    (e) => e.proposals.filter((p) => p.recommend).length === 1,
    { message: 'envelope must recommend exactly one proposal' },
  )
  .refine(
    (e) => new Set(e.proposals.map((p) => p.key)).size === e.proposals.length,
    { message: 'proposal keys must be unique within an envelope' },
  );

// A submission is EITHER a plain packet (the pre-MCPG-62 contract, still
// fully supported) OR an envelope. A plain packet cannot match the
// envelope (it has no `proposals` array) and vice versa (the strict packet
// rejects the envelope's extra fields).
const strategyOrEnvelopeSchema = z.union([strategySchema, tacticEnvelopeSchema]);

// Exported for tests (and future tooling): the exact contract the MCP layer
// enforces before a submission reaches the simulation.
export { strategySchema, tacticEnvelopeSchema, strategyOrEnvelopeSchema };

// Reactive actions (Slice 3): exactly one per window per car.
const reactiveTypes = ['attack', 'defend', 'hold', 'pit_now'];

export function createMcpServer(host, { sessionId } = {}) {
  const isOrchestrator = typeof host.joinAgent === 'function';
  // The active session: the orchestrator exposes the current one; a bare
  // session is its own session.
  const current = () => host.session ?? host;

  const server = new McpServer({ name: 'mcp-grand-prix', version: '0.1.0' });

  server.registerTool(
    'join_race',
    {
      title: 'Join the race',
      description:
        'Join the current race as a car, or queue for the next one. Your driver ' +
        'identity is bound to THIS MCP connection (session id), not to your name: ' +
        'this session controls exactly ONE car — the one whose carId the response ' +
        'returns — and re-calling join_race from this same session always returns ' +
        'that same car. If a DIFFERENT session already took your requested display ' +
        'name you still get your own new car, with an auto-suffixed display name ' +
        '("name#2", "#3", ...). In the setup phase you are added to the grid ' +
        'immediately. Outside setup (or when the grid is full) you are placed in ' +
        'the FIFO pending queue and promised a seat in the NEXT race session — ' +
        're-call join_race from this same session during that setup to claim it. ' +
        'The server keeps running across races.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Driver/agent display name (cosmetic only — identity comes from your MCP session)'),
      },
    },
    async ({ name }) => {
      try {
        let res;
        if (isOrchestrator) {
          res = host.joinAgent(name, sessionId);
        } else {
          const car = current().addAgent(name, sessionId);
          res = { status: 'joined', car, claimedFromQueue: false };
        }
        if (res.status === 'queued') {
          const state = host.state();
          return jsonResult({
            queued: true,
            requestedName: name,
            name: res.name,
            position: res.position,
            phase: state.phase,
            totalLaps: state.totalLaps,
            hint:
              "You are in the FIFO pending queue for the next race. Re-call join_race from this SAME session " +
              "during that session's setup phase to claim your seat; use get_race_state to track the phase.",
          });
        }
        if (res.status === 'queue_full') {
          const state = host.state();
          return jsonResult({
            queued: false,
            error: 'queue_full',
            maxSize: res.maxSize,
            phase: state.phase,
            hint: 'The pending queue is full; retry join_race later.',
          });
        }
        const state = current().state();
        const position = state.cars.findIndex((c) => c.id === res.car.id) + 1;
        return jsonResult({
          youAre: `You control exactly this car: carId ${res.car.id} ("${res.car.name}"). All your tool calls act on this carId.`,
          carId: res.car.id,
          name: res.car.name,
          requestedName: name,
          color: res.car.color,
          gridPosition: position,
          claimedFromQueue: res.claimedFromQueue,
          phase: state.phase,
          totalLaps: state.totalLaps,
          minAgents: state.minAgents,
          carsJoined: state.cars.length,
          track: { id: state.track.id, name: state.track.name },
        });
      } catch (err) {
        return jsonResult({ error: 'join_failed', details: err.message });
      }
    },
  );

  server.registerTool(
    'get_race_state',
    {
      title: 'Get race state',
      description:
        'Full current race state: phase, lap, per-car status/position/tires, standings, ' +
        'open window details, driver seats + posted tactic plans (driverSeats, tactics), ' +
        'this race\'s team dossiers, and the pending queue (names + positions) for the next race. ' +
        'Poll this to drive your strategy loop; strategy decisions are only accepted while ' +
        'the phase is strategy_window (same for reactive actions in reactive_window).',
      inputSchema: {},
    },
    async () => jsonResult(host.state()),
  );

  server.registerTool(
    'get_car_state',
    {
      title: 'Get one car\'s state',
      description:
        'A single car\'s status, position, tires, fuel and pit state. ' +
        'The carId comes from join_race.',
      inputSchema: { carId: z.number().int().positive() },
    },
    async ({ carId }) => {
      const car = current().carView(carId);
      return jsonResult(car ?? { error: 'unknown_car' });
    },
  );

  server.registerTool(
    'get_standings',
    {
      title: 'Get standings',
      description:
        'Current race standings: position per car with lap and gap to leader.',
      inputSchema: {},
    },
    async () => jsonResult(current().standings()),
  );

  server.registerTool(
    'get_season_standings',
    {
      title: 'Get season standings',
      description:
        'All-time championship standings across every completed race on this server: ' +
        'per driver, season points (F1 top-8 scoring, 15/12/10/8/6/4/2/1 per race), ' +
        'wins, races, DNFs and consecutive win streak. Ranked by points, then wins, ' +
        'then fewer DNFs, then name. Updated once per finished race. Read it to know ' +
        'your championship position and shape your strategy (defend a lead, push when ' +
        'far behind).',
      inputSchema: {},
    },
    async () => jsonResult(host.seasonView ? host.seasonView() : []),
  );

  server.registerTool(
    'submit_phase_strategy',
    {
      title: 'Submit lap strategy',
      description:
        "Submit this lap's strategy for your car while a strategy_window is open. " +
        'Two shapes (one per lap, first valid submission wins; re-submitting returns duplicate_strategy):\n' +
        '1. PLAIN PACKET — { pace: push|normal|manage, tireManagement: manage|normal|push, aggression: 0|1, defend: 0|1, pitNow: boolean } (every field optional; this is the original contract, unchanged).\n' +
        '2. TACTIC ENVELOPE (optional, for teams with a human driver on the seat) — { radio?: string (<=200 chars), proposals: [1-3 cards] } where each card is ' +
        `{ key: ${ARCHETYPE_KEYS.join('|')}, label: string (<=24), narrative?: string (<=160), packet: <plain packet shape>, recommend: boolean, confidence: integer 50-99 }. ` +
        'Exactly one card must be recommend: true and keys must be unique. The server stamps every card with projections ' +
        '(projectedPos / projectedDeltaS / riskTag) from its authoritative state — your own numbers (e.g. confidence) are display-only and never drive the sim. ' +
        'With a driver seated in AUTOPILOT the recommended card runs automatically; the driver may lock another card or override with a raw packet. ' +
        'If no plan arrives early in the window a scripted junior strategist fills in for you. ' +
        'If you miss the window the server applies your last strategy or the default.',
      inputSchema: {
        carId: z.number().int().positive(),
        strategy: strategyOrEnvelopeSchema.optional(),
      },
    },
    async ({ carId, strategy }) => {
      try {
        const res = current().submitPhaseStrategy(carId, strategy ?? {});
        if (res.accepted) return jsonResult({ accepted: true, carId, lap: res.lap, ...(res.projections ? { projections: res.projections } : {}) });
        return jsonResult({ accepted: false, error: res.error, details: res.details });
      } catch (err) {
        return jsonResult({ accepted: false, error: 'rejected', details: err.message });
      }
    },
  );

  server.registerTool(
    'submit_reactive_action',
    {
      title: 'Submit reactive action',
      description:
        'React to an in-race event window (close battle, safety car, critical tire ' +
        'wear, pit opportunity): attack, defend, hold or pit_now. Only accepted ' +
        'while the reactive_window that lists your car is open; exactly one action per ' +
        'window per car (re-submitting returns duplicate_action). If you miss the ' +
        'window the server defaults to hold.',
      inputSchema: {
        carId: z.number().int().positive(),
        type: z.enum(reactiveTypes),
        detail: z.string().optional(),
      },
    },
    async ({ carId, type, detail }) => {
      try {
        const res = current().submitReactiveAction(carId, { type, detail });
        if (res.accepted) return jsonResult({ accepted: true, carId, windowId: res.windowId, action: { type, detail } });
        return jsonResult({ accepted: false, error: res.error, details: res.details });
      } catch (err) {
        return jsonResult({ accepted: false, error: 'rejected', details: err.message });
      }
    },
  );

  return server;
}

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
