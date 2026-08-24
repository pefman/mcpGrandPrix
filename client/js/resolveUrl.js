/**
 * Resolve the game-server origin for the spectator client.
 * See config.js for the resolution order (query param > MGP_SERVER_URL > same origin).
 */
export function resolveServerOrigin() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('server') || params.get('ws') || window.MGP_SERVER_URL || null;
  if (q) {
    try {
      // new URL().origin drops any path the user typed, plus trailing slashes
      return new URL(String(q).trim()).origin;
    } catch {
      // malformed ?server= — fall through to same origin
    }
  }
  return window.location.origin; // game server serves this page: same origin
}

/**
 * Resolve the game-server WebSocket URL for the spectator feed.
 */
export function resolveSpectatorWsUrl() {
  const origin = resolveServerOrigin();
  if (origin.startsWith('ws://') || origin.startsWith('wss://')) {
    return origin + '/spectate';
  }
  const u = new URL(origin);
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${u.host}/spectate`;
}
