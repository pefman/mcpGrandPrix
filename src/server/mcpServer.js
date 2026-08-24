/**
 * The MCP tool surface. One McpServer instance per client session, all bound
 * to the shared RaceSession (and therefore to the single authoritative
 * Simulation).
 *
 * Idempotency rules:
 *  - join_race: same name always returns the same car.
 *  - get_* tools: pure reads, safe to repeat.
 *  - submit_phase_strategy: first valid packet per window wins; repeats are
 *    rejected as duplicates and never change state.
 *  - submit_reactive_action: first valid action per (carId, windowId) wins;
 *    duplicates / wrong-car / closed-window are rejected with no state change.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const jsonResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

const strategySchema = z
  .object({
    pace: z.enum(['push', 'normal', 'manage']).optional(),
    tireManagement: z.enum(['push', 'normal', 'manage']).optional(),
    aggression: z.union([z.literal(0), z.literal(1)]).optional(),
    defend: z.union([z.literal(0), z.literal(1)]).optional(),
    pitNow: z.boolean().optional(),
  })
  .passthrough();

export function createMcpServer(session) {
  const server = new McpServer({ name: 'mcp-grand-prix', version: '0.1.0' });

  server.registerTool(
    'join_race',
    {
      title: 'Join race',
      description:
        'Join the race with a display name. Idempotent: calling again with the same name returns the same car. ' +
        'Returns your carId (required by other tools). The race stays in phase "setup" until minAgents cars have ' +
        'joined, then the first strategy window opens automatically.',
      inputSchema: { name: z.string().min(1).max(40) },
    },
    async ({ name }) => {
      try {
        const car = session.addAgent(name, 'mcp-client');
        const state = session.state();
        const position = state.standings.find((s) => s.carId === car.id)?.position ?? null;
        return jsonResult({
          carId: car.id,
          name: car.name,
          gridPosition: position,
          phase: state.phase,
          totalLaps: state.totalLaps,
          minAgents: state.minAgents,
          carsJoined: state.cars.length,
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
        'Full snapshot of the race: phase, lap, window time left, track, all cars (position, gap, pace strategy, ' +
        'tire wear, fuel, pit status) and current standings. Pure read — safe to call anytime.',
      inputSchema: {},
    },
    async () => jsonResult(session.state()),
  );

  server.registerTool(
    'get_car_state',
    {
      title: 'Get car state',
      description: 'Snapshot of one car plus its current position. Pure read.',
      inputSchema: { carId: z.number().int().positive() },
    },
    async ({ carId }) => {
      const car = session.carView(carId);
      return jsonResult(car ?? { error: 'unknown_car' });
    },
  );

  server.registerTool(
    'get_standings',
    {
      title: 'Get standings',
      description: 'Current race standings: position, name, status, completed laps, gap to leader. Pure read.',
      inputSchema: {},
    },
    async () => jsonResult(session.standings()),
  );

  server.registerTool(
    'submit_phase_strategy',
    {
      title: 'Submit phase strategy',
      description:
        'Submit your strategy packet for the current strategy window (once per lap). Fields: ' +
        'pace (push|normal|manage — speed vs. fuel/tire trade), tireManagement (push|normal|manage — wear rate), ' +
        'aggression (0|1 — initiate overtakes), defend (0|1 — defend position), pitNow (bool — pit this lap). ' +
        'Omitted fields default to (normal, normal, 0, 0, false). ' +
        'Idempotent: the first valid submission per window is kept; later submissions are rejected as duplicates.',
      inputSchema: {
        carId: z.number().int().positive(),
        strategy: strategySchema.optional(),
      },
    },
    async ({ carId, strategy }) => jsonResult(session.submitPhaseStrategy(carId, strategy ?? {})),
  );

  server.registerTool(
    'submit_reactive_action',
    {
      title: 'Submit reactive action',
      description:
        'React to a short reactive window (8–15 s) opened for your car by a trigger event. ' +
        'Check get_race_state().reactiveWindow: it lists trigger, carIds, remainingS, and allowedByCar. ' +
        'Triggers (MVP): close_battle (attack|defend|hold by role), critical_tire_wear (pit_now|hold), ' +
        'pit_opportunity (pit_now|hold). No response by timeout = hold (no action). ' +
        'Idempotent: first valid action per window wins; duplicates rejected as duplicate_action; ' +
        'calls outside a window or for a car not listed return an error and change nothing.',
      inputSchema: {
        carId: z.number().int().positive(),
        type: z.enum(['attack', 'defend', 'hold', 'pit_now']),
        detail: z.string().max(500).optional(),
      },
    },
    async ({ carId, type, detail }) => jsonResult(session.submitReactiveAction(carId, { type, detail })),
  );

  return server;
}
