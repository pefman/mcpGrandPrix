/**
 * Resolve the game-server WebSocket URL for the spectator feed.
 * See config.js for the resolution order (query param > MGP_SERVER_URL > same origin).
 */
export function resolveSpectatorWsUrl() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('server') || params.get('ws') || window.MGP_SERVER_URL || null;
  let origin;
  if (q) {
    origin = String(q).trim().replace(/\/+$/, '');
  } else {
    origin = window.location.origin; // game server serves this page: same origin
  }
  if (origin.startsWith('ws://') || origin.startsWith('wss://')) {
    return origin + '/spectate';
  }
  const u = new URL(origin);
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${u.host}/spectate`;
}
