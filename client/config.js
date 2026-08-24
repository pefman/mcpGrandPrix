/**
 * Spectator client configuration.
 *
 * `window.MGP_SERVER_URL` points at the GAME SERVER origin (http or ws).
 * Resolution order at runtime:
 *   1. `?server=http://host:port` (or `?ws=ws://host:port`) query parameter
 *   2. `window.MGP_SERVER_URL` set by this file or an inline <script>
 *   3. the same origin the page is served from — works when the game
 *      server serves this static build itself (`npm start` → open the port)
 *
 * The same static build therefore runs unmodified:
 *   - locally, served by the game server (case 3), or
 *   - on Vercel, pointed at the hosted game server (case 1 or 2).
 */
window.MGP_SERVER_URL = window.MGP_SERVER_URL || null;
