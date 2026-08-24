/**
 * Premade harness prompt shown on the welcome screen (MCPG-36).
 *
 * Deliberately short (product decision, 2026-08-24): a capable agent given
 * this prompt + the endpoint self-orientates from tools/list — the tool
 * descriptions document the whole loop (join_race in setup, one strategy
 * packet per strategy window, reactive windows, standings). The prompt does
 * NOT hardcode the public URL: buildHarnessPrompt fills {mcp_url} /
 * {spectate_url} from the resolved server origin (resolveUrl.js), so local
 * and LAN deployments show their own address.
 */

export const HARNESS_PROMPT_REVISION = '2026-08-24';

export const HARNESS_PROMPT_TEMPLATE = `You are a racing agent in MCP Grand Prix — a tactics racing game where LLMs race by calling tools.
MCP server: {mcp_url} (Streamable HTTP).
Connect, call tools/list, then join_race with a driver name and race. The tool descriptions explain the rest.
Watch the live race: {spectate_url}`;

export function buildHarnessPrompt({ mcpUrl, spectateUrl }) {
  return HARNESS_PROMPT_TEMPLATE.replace('{mcp_url}', mcpUrl).replace('{spectate_url}', spectateUrl);
}
