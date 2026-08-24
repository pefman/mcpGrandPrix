/**
 * Human-readable narration for the live demo (Slice 5).
 *
 * narrateEvent() maps one decision-log event (the same JSON lines the server
 * writes, or a state-diff event built by the public-mode narrator) to one
 * readable terminal line, or null for events the demo keeps quiet about.
 *
 * Pure functions — no I/O, unit-tested in test/demo.test.js.
 */

const TRIGGER_LABELS = {
  close_battle: 'close battle',
  critical_tire_wear: 'critical tire wear',
  pit_opportunity: 'pit opportunity',
};

/** "pace=push tires=manage aggression=1 defend=1 pit=YES" */
export function strategyLine(s = {}) {
  return (
    `pace=${s.pace ?? 'normal'} ` +
    `tires=${s.tireManagement ?? 'normal'} ` +
    `aggression=${s.aggression ?? 0} ` +
    `defend=${s.defend ?? 0} ` +
    `pit=${s.pitNow ? 'YES' : 'no'}`
  );
}

/** Who is involved in a reactive window, from its trigger detail. */
function reactiveSubjects(trigger, detail, carIds) {
  const d = detail ?? {};
  if (trigger === 'close_battle' && d.attackerName && d.defenderName) {
    return `${d.attackerName} is ${d.gapM}m behind ${d.defenderName}`;
  }
  if (d.name) return `${d.name} (tire wear ${d.tireWearPct}%)`;
  if (Array.isArray(carIds) && carIds.length) return carIds.map((id) => `car ${id}`).join(', ');
  return '';
}

/**
 * @param {object} ev one decision-log event ({ type, ... })
 * @returns {string|null} a narration line, or null to stay quiet
 */
export function narrateEvent(ev) {
  switch (ev.type) {
    case 'race_start': {
      const names = (ev.agents ?? []).map((a) => a.name).join(', ');
      return `🏁 RACE START — ${names}`;
    }

    case 'window_opened':
      return `\n── LAP ${ev.lap}: STRATEGY WINDOW OPEN (${ev.remainingS}s) — each agent picks pace / tires / attack / pit ──`;

    case 'strategy_submitted':
      return `  ${String(ev.name).padEnd(10)} → ${strategyLine(ev.strategy)}`;

    case 'strategy_defaulted':
      return `  ${String(ev.name).padEnd(10)} → no submission, safe default applied`;

    case 'window_closed':
      return `  window closed — the server simulates the lap (${(ev.submitted ?? []).length} submitted, ${(ev.defaulted ?? []).length} defaulted)`;

    case 'reactive_window_opened':
      return `  ⚡ REACTIVE [${TRIGGER_LABELS[ev.trigger] ?? ev.trigger}]: ${reactiveSubjects(ev.trigger, ev.detail, ev.carIds)} — ${ev.remainingS}s to act`;

    case 'reactive_action_submitted':
      return `  ${String(ev.name).padEnd(10)} reacts: ${ev.action?.type}`;

    case 'reactive_action_defaulted':
      return `  ${String(ev.name ?? 'car').padEnd(10)} no reaction (defaults to hold)`;

    case 'reactive_window_closed':
      return '  (reactive window resolved)';

    case 'overtake':
      return `  🏎  OVERTAKE: ${ev.name} passes ${ev.overTakenName}${ev.via === 'reactive' ? ' — decided in a reactive window' : ''}`;

    case 'overtake_failed':
      return `  ${ev.name} does not get past ${ev.defendedByName}`;

    case 'pit_stop_enter':
      return `  🔧 PIT STOP: ${ev.name}`;

    case 'pit_stop_complete':
      return `  ${String(ev.name).padEnd(10)} back on track with fresh tires`;

    case 'lap_complete':
      return `  ${String(ev.name).padEnd(10)} completes lap ${ev.lap} (tires ${ev.tireWearPct}%, fuel ${ev.fuelKg}kg)`;

    case 'finish':
      return `  🏁 ${ev.name} FINISHES (${ev.timeS}s total)`;

    case 'retired':
      return `  💥 ${ev.name} retires: ${ev.reason}`;

    case 'race_finished':
      return '\nRace over — final standings below.';

    default:
      return null;
  }
}
