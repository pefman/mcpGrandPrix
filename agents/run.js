/**
 * Standalone agent entry point — one process per car:
 *
 *   node agents/run.js --profile aggressive --name Aggro --url http://127.0.0.1:3080/mcp [--seed 42]
 *
 * Profiles: aggressive | conservative | pitHeavy | random
 */
import { runAgent } from './agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const profile = args.profile ?? 'random';
const name = args.name ?? profile;
const serverUrl = args.url ?? 'http://127.0.0.1:3080/mcp';
const seed = Number(args.seed ?? '42');
const logFile = args['log-file'] ?? null;

const agent = SCRIPTED_AGENTS[profile];
if (!agent) {
  console.error(`unknown profile '${profile}'; choose from ${Object.keys(SCRIPTED_AGENTS).join(', ')}`);
  process.exit(1);
}

const rng = createRng(seed + name.length * 7919); // distinct but reproducible per agent

try {
  const summary = await runAgent({
    name,
    serverUrl,
    decide: agent.decide,
    decideReactive: agent.decideReactive,
    rng,
    pollMs: 150,
    logFile,
    onLog: (line) => console.log(JSON.stringify(line)),
  });
  console.log(JSON.stringify({ type: 'agent_done', ...summary }));
} catch (err) {
  console.error(JSON.stringify({ type: 'agent_error', name, error: err.message }));
  process.exit(1);
}
