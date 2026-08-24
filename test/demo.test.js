import { describe, expect, it } from 'vitest';
import { narrateEvent, strategyLine } from '../scripts/demoNarration.js';

describe('demo narration (Slice 5)', () => {
  it('strategyLine renders all fields, defaulting like the server does', () => {
    expect(strategyLine({})).toBe('pace=normal tires=normal aggression=0 defend=0 pit=no');
    expect(strategyLine({ pace: 'push', tireManagement: 'manage', aggression: 1, defend: 1, pitNow: true })).toBe(
      'pace=push tires=manage aggression=1 defend=1 pit=YES',
    );
  });

  it('narrates planned strategy submissions', () => {
    const line = narrateEvent({
      type: 'strategy_submitted',
      name: 'Aggro',
      lap: 2,
      strategy: { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 1, pitNow: false },
    });
    expect(line).toContain('Aggro');
    expect(line).toContain('pace=push');
    expect(line).toContain('pit=no');
  });

  it('narrates defaulted strategies', () => {
    const line = narrateEvent({ type: 'strategy_defaulted', name: 'Randy', lap: 3, strategy: {} });
    expect(line).toContain('Randy');
    expect(line).toContain('no submission');
  });

  it('narrates close_battle reactive windows with both car names and the gap', () => {
    const line = narrateEvent({
      type: 'reactive_window_opened',
      windowId: 7,
      trigger: 'close_battle',
      carIds: [2, 1],
      remainingS: 10,
      detail: { gapM: 22.4, attackerName: 'Aggro', defenderName: 'Turtle' },
    });
    expect(line).toContain('REACTIVE');
    expect(line).toContain('close battle');
    expect(line).toContain('Aggro');
    expect(line).toContain('Turtle');
    expect(line).toContain('22.4m');
  });

  it('narrates tire-wear reactive windows', () => {
    const line = narrateEvent({
      type: 'reactive_window_opened',
      windowId: 8,
      trigger: 'pit_opportunity',
      carIds: [3],
      remainingS: 10,
      detail: { name: 'PitPete', tireWearPct: 58 },
    });
    expect(line).toContain('pit opportunity');
    expect(line).toContain('PitPete');
    expect(line).toContain('58%');
  });

  it('narrates reactive actions', () => {
    expect(narrateEvent({ type: 'reactive_action_submitted', windowId: 7, trigger: 'close_battle', carId: 2, name: 'Aggro', action: { type: 'attack' } })).toContain('attack');
    expect(narrateEvent({ type: 'reactive_action_defaulted', windowId: 7, trigger: 'close_battle', carId: 1, name: 'Turtle', action: { type: 'hold' } })).toContain('no reaction');
  });

  it('narrates overtakes (flagging reactive decisions) and pit stops', () => {
    expect(narrateEvent({ type: 'overtake', carId: 2, name: 'Aggro', overTakenCarId: 1, overTakenName: 'Turtle', probability: 0.7, via: 'reactive', windowId: 7 }))
      .toContain('OVERTAKE: Aggro passes Turtle');
    expect(narrateEvent({ type: 'pit_stop_enter', carId: 3, name: 'PitPete', lap: 2 })).toContain('PIT STOP: PitPete');
    expect(narrateEvent({ type: 'pit_stop_complete', carId: 3, name: 'PitPete' })).toContain('fresh tires');
  });

  it('narrates finishes, retirements and race start', () => {
    expect(narrateEvent({ type: 'finish', carId: 1, name: 'Aggro', timeS: 912 })).toContain('Aggro FINISHES');
    expect(narrateEvent({ type: 'retired', carId: 4, name: 'Randy', reason: 'out_of_fuel' })).toContain('Randy retires');
    expect(narrateEvent({ type: 'race_start', agents: [{ id: 1, name: 'Aggro' }, { id: 2, name: 'Turtle' }] })).toContain('RACE START — Aggro, Turtle');
  });

  it('stays quiet about non-decision events', () => {
    expect(narrateEvent({ type: 'session_started' })).toBeNull();
    expect(narrateEvent({ type: 'spectator_connected' })).toBeNull();
    expect(narrateEvent({ type: 'agent_joined', carId: 1, name: 'Aggro', position: 1 })).toBeNull();
  });
});
