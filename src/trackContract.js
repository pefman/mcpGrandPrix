/**
 * Track contract (MCPG-63) — server-side import path.
 *
 * The one real implementation lives at `client/js/trackContract.js`: it must
 * sit inside the static root so the browser can import it directly when it
 * validates a fetched map. Node code imports it through this re-export so
 * server call sites keep a `src/` path and nothing ever forks into two
 * validators.
 */
export {
  SUPPORTED_VERSION,
  PROP_TYPES,
  PROPS_BUDGET,
  validateTrackDef,
  sanitizeTrackDef,
} from '../client/js/trackContract.js';
