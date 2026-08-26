/**
 * Tactic archetype registry (MCPG-62).
 *
 * The fixed vocabulary of tactic "shapes" a team plan can propose. Each
 * archetype documents its packet template — the baseline values for the
 * four tactical levers + pit request. The server rejects proposal keys
 * outside this registry (the LLM cannot invent new tactic classes); the
 * scripted junior strategist and any human-authored override card build on
 * these templates.
 *
 * Packet templates are starting points, not laws: a proposal's `packet`
 * may tune any field (e.g. `undercut` normally pits — a "soft undercut"
 * with pitNow false is still an undercut-shaped tactic and stays legal).
 */
export const ARCHETYPE_KEYS = ['undercut', 'overcut', 'stay_out', 'attack', 'defend', 'manage_tyres'];

/**
 * @typedef {object} Archetype
 * @property {string} key        stable machine key (the proposal's `key`)
 * @property {string} name       display name for cards and the log
 * @property {string} blurb      one-line human description (docs + card hint)
 * @property {{pace?: string, tireManagement?: string, aggression?: 0|1, defend?: 0|1, pitNow?: boolean}}
 * @property {object} packet     packet template (partial; defaults fill in)
 */
export const ARCHETYPES = {
  undercut: {
    key: 'undercut',
    name: 'Undercut',
    blurb: 'Box now for fresh tires and get clear ahead of the car(s) behind you on lap one out of the stop.',
    packet: { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 0, pitNow: true },
  },
  overcut: {
    key: 'overcut',
    name: 'Overcut',
    blurb: 'Stay out on old tires and try to lap faster than whoever boxes — wins when traffic makes their stop slow.',
    packet: { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 1, pitNow: false },
  },
  stay_out: {
    key: 'stay_out',
    name: 'Stay Out',
    blurb: 'No pit stop; keep the current tires working and focus on race position.',
    packet: { pace: 'normal', tireManagement: 'normal', aggression: 0, defend: 0, pitNow: false },
  },
  attack: {
    key: 'attack',
    name: 'Attack',
    blurb: 'Push for the car ahead: full pace, attacks on, defending off. Costs tires.',
    packet: { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 0, pitNow: false },
  },
  defend: {
    key: 'defend',
    name: 'Defend',
    blurb: 'Protect your position: manage speed through battle, defend on, do not chase.',
    packet: { pace: 'manage', tireManagement: 'normal', aggression: 0, defend: 1, pitNow: false },
  },
  manage_tyres: {
    key: 'manage_tyres',
    name: 'Manage Tyres',
    blurb: 'Protect the tires for the end of the stint: managed pace and management, no attacks.',
    packet: { pace: 'manage', tireManagement: 'manage', aggression: 0, defend: 0, pitNow: false },
  },
};

/** True when `key` is in the fixed registry. */
export function isKnownArchetype(key) {
  return Object.prototype.hasOwnProperty.call(ARCHETYPES, key);
}

/** The registry list for docs/UI (stable order). */
export function archetypeList() {
  return ARCHETYPE_KEYS.map((k) => ARCHETYPES[k]);
}