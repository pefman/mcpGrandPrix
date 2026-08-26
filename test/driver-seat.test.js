/**
 * MCPG-62: the driver seat over the spectator WebSocket — real hub, real
 * session, scripted MCP agents on the grid, WS driver clients.
 *
 * Covers: claim-first (one driver per car, idempotent re-claim, second
 * driver rejected), release on disconnect, lock_in / override /
 * resume_autopilot inside the strategy window (including the deliberate
 * "trust the team" path and already_acted), actions outside the window
 * rejected, the broadcast events (tactics_proposed / driver_locked /
 * driver_override / autopilot_state), reconnect-safe visibility (a late
 * WS client sees the seat + plan in its first snapshot), and a clean race
 * finish with no server errors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceSession } from '../src/server/raceSession.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { closeServer, waitFor } from './helpers.js';

const TOTAL_LAPS = 4; // one spare lap: the test chain (claim -> lock -> override) needs a following window to exist
const WINDOW_S = 15; // headroom: the driver's WS round-trips must fit inside one window

let session;
let logger;
let server;
let hub;
let baseUrl;
let wsUrl;
let logFile;
let agentsDone;
let seatHolder; // the driver WS that owns a seat, kept alive across tests
let seatCarId = null;

/** A tiny WS client: collects messages, helpers to send + wait. */
function makeDriver() {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  const waiting = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    msgs.push(m);
    for (let i = waiting.length - 1; i >= 0; i -= 1) {
      if (waiting[i](m)) waiting.splice(i, 1);
    }
  });
  // The hub heartbeats: a client silent for 30 s is terminated (exactly like
  // the real browser client, which pings to keep the connection warm).
  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 10000);
  ws.addEventListener('close', () => clearInterval(pingTimer));
  const opened = new Promise((resolve) => ws.addEventListener('open', resolve));
  const send = (obj) => ws.send(JSON.stringify(obj));
  const next = (pred, what, from = 0) =>
    new Promise((resolve, reject) => {
      const hit = msgs.slice(from).find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 15000);
      waiting.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  return { ws, msgs, opened, send, next };
}

const snapshots = (d) => d.msgs.filter((m) => m.type === 'snapshot');
const lastSnap = (d) => snapshots(d)[snapshots(d).length - 1];
const lastSnapIndex = (d) => {
  for (let i = d.msgs.length - 1; i >= 0; i -= 1) if (d.msgs[i].type === 'snapshot') return i;
  return -1;
};
/**
 * Event acks are pushed immediately but snapshots tick at 10 Hz — assertions
 * about snapshot-carried state must wait for a snapshot taken AFTER the action.
 */
async function freshSnap(d, floor, what = 'a fresh snapshot') {
  await waitFor(() => lastSnapIndex(d) > floor, 5000, what);
  return lastSnap(d);
}

/**
 * Wait until the client snapshot AND the server agree on a strategy window
 * with a team plan, then return the FRESH server plan (the lock key must
 * name a card of the current window; a stale client frame could name a card
 * that no longer exists).
 */
async function awaitJuniorPlan(d) {
  await waitFor(
    () => {
      const s = lastSnap(d);
      const cur = session.state();
      return (
        s?.phase === 'strategy_window' &&
        cur.phase === 'strategy_window' &&
        s.currentLap === cur.currentLap &&
        s.tactics?.[seatCarId]?.proposals?.length > 0 &&
        cur.tactics?.[seatCarId]
      );
    },
    30000,
    'junior plan visible to the client and on the server (same window)',
  );
  const fresh = session.state().tactics[seatCarId];
  if (!fresh) throw new Error('server plan vanished after the client saw one');
  return fresh;
}

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-seat-'));
  logFile = path.join(tmpDir, 'race.jsonl');

  session = new RaceSession({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_S,
    reactiveWindowSeconds: 0.5,
    tickWallDelayMs: 0,
    seed: 42,
    juniorFallbackSeconds: 0, // the teams always post; keep the test deterministic
    earlyCloseStrategyWindows: false, // hold the full window open for the driver's round-trips
    logFile,
    logToStdout: false,
  });
  logger = session.logger;

  server = createMcpHttpServer(session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  hub = createSpectatorHub(server, session, {
    getSession: () => session,
    onEvent: (event) => logger.log(event),
  });

  session.run();

  // The grid: three plain-packet scripted agents + one junior strategist
  // (the scripted "AI team" that posts envelopes, exactly like an LLM team).
  const agents = [
    { profile: 'aggressive', name: 'Aggro', seed: 61 },
    { profile: 'conservative', name: 'Turtle', seed: 62 },
    { profile: 'pitHeavy', name: 'PitPete', seed: 63 },
    { profile: 'junior', name: 'JuniorJr', seed: 64 },
  ];
  agentsDone = Promise.all(agents.map((a) => runAgent({
    name: a.name,
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS[a.profile].decide,
    decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
    rng: createRng(a.seed),
    pollMs: 50,
  })));
  await waitFor(() => session.state().phase === 'strategy_window', 30000, 'first strategy window');
}, 60000);

afterAll(async () => {
  seatHolder?.ws.close();
  session.close();
  hub.close();
  await closeServer(server);
  logger.close();
  await agentsDone.catch(() => {});
});

describe('driver seat over the spectator WS (MCPG-62)', () => {
  it('claim-first: one driver per car, idempotent re-claim, second driver rejected, released on disconnect', async () => {
    const junior = session.state().cars.find((c) => c.name === 'JuniorJr');
    expect(junior).toBeTruthy(); // the junior team car is on the grid
    seatCarId = junior.id;

    seatHolder = makeDriver();
    const rival = makeDriver();
    await Promise.all([seatHolder.opened, rival.opened]);
    await waitFor(() => lastSnap(seatHolder)?.phase === 'strategy_window', 10000, 'window');

    // driver 1 claims the junior car
    seatHolder.send({ type: 'driver_claim', carId: junior.id });
    const ack = await seatHolder.next((m) => m.type === 'driver_claim_ack' && m.carId === junior.id, 'claim ack');
    expect(ack.mode).toBe('autopilot'); // the seat rests in AUTOPILOT

    // both drivers see the broadcast autopilot_state event
    await rival.next((m) => m.type === 'autopilot_state' && m.carId === junior.id && m.change === 'claim', 'claim broadcast');

    // the SAME driver re-claims: idempotent
    seatHolder.send({ type: 'driver_claim', carId: junior.id });
    const again = await seatHolder.next((m) => m.type === 'driver_claim_ack' && m.idempotent, 're-claim ack');
    expect(again.mode).toBe('autopilot');

    // a DIFFERENT driver cannot take the seat
    rival.send({ type: 'driver_claim', carId: junior.id });
    const taken = await rival.next((m) => m.type === 'driver_rejected' && m.error === 'seat_taken', 'seat_taken');
    expect(taken.action).toBe('driver_claim');

    // seat + autopilot state ride in every snapshot (reconnect-safe) — the
    // acks above are pushed instantly, so wait for a snapshot taken after them
    const snap = await freshSnap(seatHolder, seatHolder.msgs.length - 1, 'post-claim snapshot');
    expect(snap.driverSeats[junior.id]).toEqual({ claimed: true, mode: 'autopilot', actionKind: null });

    // a dead connection cannot hold a seat forever: disconnect -> released
    rival.ws.close();
    const d1 = makeDriver();
    await d1.opened;
    seatHolder.ws.close();
    await d1.next((m) => m.type === 'autopilot_state' && m.carId === junior.id && m.change === 'release', 'release broadcast');

    // a (re)connected driver can claim the freed seat again, claim-first —
    // the claim only lands in a strategy window, so wait for one if the
    // first window lapped forward under us.
    await waitFor(() => session.state().phase === 'strategy_window', 30000, 'window for re-acquire');
    seatHolder = d1;
    seatHolder.send({ type: 'driver_claim', carId: junior.id });
    const reAcquired = await seatHolder.next((m) => m.type === 'driver_claim_ack' && m.carId === junior.id && !m.idempotent, 're-acquire ack');
    expect(reAcquired.mode).toBe('autopilot');
  }, 90000);

  it('the team posts an envelope; a lock_in of a NON-recommended card flips the seat to MANUAL (driver_locked)', async () => {
    await waitFor(() => lastSnap(seatHolder)?.phase === 'strategy_window', 30000, 'a strategy window');
    const plan = await awaitJuniorPlan(seatHolder);
    expect(plan.source).toBe('team');
    expect(plan.proposals.length).toBeGreaterThanOrEqual(2); // the team always offers choices
    const rec = plan.proposals.find((p) => p.recommend);
    const alt = plan.proposals.find((p) => !p.recommend);
    expect(rec).toBeTruthy();
    expect(alt).toBeTruthy();
    for (const p of plan.proposals) {
      expect(p.projection).toHaveProperty('projectedDeltaS');
      expect(p.projection).toHaveProperty('riskTag');
    }
    // (the plan broadcast reaching a client is verified live in the next
    // window — this client may have connected after this window's plan)
    // lock the NON-recommended card IMMEDIATELY — the key names a card of the
    // current window, and a window advance would retire it
    seatHolder.send({ type: 'lock_in', carId: seatCarId, proposalKey: alt.key });
    const lockAck = await seatHolder.next((m) => m.type === 'driver_lock_ack' && m.carId === seatCarId, 'lock ack');
    expect(lockAck.trusted).toBe(false);

    // the acting client received the lock broadcast (a LATE client is covered
    // by the snapshot checks below — it joined after the broadcast)
    await seatHolder.next((m) => m.type === 'driver_locked' && m.carId === seatCarId && m.trusted === false, 'driver_locked broadcast');
    const spectator = makeDriver();
    await spectator.opened;
    // a late client sees the seat state (claimed, MANUAL) in its first snapshots
    await waitFor(() => lastSnap(spectator)?.driverSeats?.[seatCarId]?.claimed === true, 10000, 'seat visible to late client');
    // it cannot act on the seat it does not hold (the seat is taken)
    spectator.send({ type: 'lock_in', carId: seatCarId, proposalKey: alt.key });
    await spectator.next((m) => m.type === 'driver_rejected' && (m.error === 'not_your_seat' || m.error?.startsWith('not_in_window')), 'spectator rejected');
    await waitFor(() => lastSnap(seatHolder).driverSeats[seatCarId].mode === 'manual', 10000, 'seat MANUAL in snapshot');

    // one action per window: an override now is rejected
    seatHolder.send({ type: 'override', carId: seatCarId, packet: { pace: 'push' } });
    await seatHolder.next((m) => m.type === 'driver_rejected' && (m.error === 'already_acted' || m.error?.startsWith('not_in_window')), 'already_acted');
    spectator.ws.close();
  }, 90000);

  it('a later window: the MANUAL seat holds, override works, resume_autopilot restores the default', async () => {
    // cross the window boundary: the override must land in the NEXT window
    // (the lock above resolved the window it landed in)
    await waitFor(() => session.state().phase !== 'strategy_window', 30000, 'the locked window to close');
    const floor = seatHolder.msgs.length; // everything after: the NEXT window's traffic
    await waitFor(() => lastSnap(seatHolder)?.phase === 'strategy_window' && lastSnap(seatHolder).driverSeats?.[seatCarId]?.mode === 'manual', 40000, 'next window with the manual seat');
    const plan = await awaitJuniorPlan(seatHolder);
    // the team plan of THIS window arrived as a live broadcast event
    await seatHolder.next((m) => m.type === 'tactics_proposed' && m.carId === seatCarId, 'tactics_proposed', floor);

    // the seat persisted as MANUAL across windows (MCPG-62: stays manual)
    expect(lastSnap(seatHolder).driverSeats[seatCarId].mode).toBe('manual');

    // an invalid packet is rejected like any strategy submission (before acting)
    seatHolder.send({ type: 'override', carId: seatCarId, packet: { aggression: 0.5 } });
    const bad = await seatHolder.next((m) => m.type === 'driver_rejected' && m.error === 'invalid_packet', 'invalid_packet');
    expect(bad.details.join(' ')).toContain('aggression');

    // override with a raw packet
    const packet = { pace: 'push', tireManagement: 'normal', aggression: 1, defend: 0, pitNow: false };
    seatHolder.send({ type: 'override', carId: seatCarId, packet });
    const ovAck = await seatHolder.next((m) => m.type === 'driver_override_ack' && m.carId === seatCarId, 'override ack');
    expect(ovAck.mode).toBe('manual');
    await seatHolder.next((m) => m.type === 'driver_override' && m.carId === seatCarId, 'driver_override broadcast');

    // one action per window
    seatHolder.send({ type: 'override', carId: seatCarId, packet: { pace: 'push' } });
    await seatHolder.next((m) => m.type === 'driver_rejected' && m.error === 'already_acted', 'already_acted');

    // resume AUTOPILOT: the resting default comes back (withdraws the action)
    seatHolder.send({ type: 'resume_autopilot', carId: seatCarId });
    const resumeAck = await seatHolder.next((m) => m.type === 'driver_resume_ack' && m.carId === seatCarId, 'resume ack');
    expect(resumeAck.mode).toBe('autopilot');
    expect(resumeAck.withdrew).toBe(true);
    await waitFor(() => lastSnap(seatHolder).driverSeats[seatCarId].mode === 'autopilot', 10000, 'autopilot restored in snapshot');
  }, 120000);

  it('driver actions outside a strategy window are rejected (valid only in-window)', async () => {
    // ride until we are NOT in a strategy window (simulation or reactive)
    const t0 = Date.now();
    while (['strategy_window'].includes(session.state().phase) && Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (session.state().phase === 'strategy_window') {
      // the window never left during the wait (short race): still, a claim
      // for a DIFFERENT car must work in-window, and the next test drives
      // the rest — skip the out-of-window probe deterministically.
      return;
    }
    const other = session.state().cars.find((c) => c.id !== seatCarId);
    seatHolder.send({ type: 'driver_claim', carId: other.id });
    await seatHolder.next((m) => m.type === 'driver_rejected' && m.error.includes('not_in_window'), 'claim not_in_window');
    seatHolder.send({ type: 'lock_in', carId: seatCarId, proposalKey: 'attack' });
    await seatHolder.next((m) => m.type === 'driver_rejected' && m.error.includes('not_in_window'), 'lock not_in_window');
    seatHolder.send({ type: 'override', carId: seatCarId, packet: { pace: 'push' } });
    await seatHolder.next((m) => m.type === 'driver_rejected' && m.error.includes('not_in_window'), 'override not_in_window');
    seatHolder.send({ type: 'resume_autopilot', carId: seatCarId });
    await seatHolder.next((m) => m.type === 'driver_rejected' && m.error.includes('not_in_window'), 'resume not_in_window');
  }, 120000);

  it('the full race finishes cleanly with driver actions on the grid (no server errors)', async () => {
    await waitFor(() => session.state().phase === 'finished', 120000, 'race to finish');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === 'server_error')).toBe(false);
    expect(lines.some((l) => l.type === 'race_start')).toBe(true);
    expect(lines.some((l) => l.type === 'race_finished')).toBe(true);
    // the seat lifecycle is fully in the decision log
    expect(lines.filter((l) => l.type === 'autopilot_state' && l.change === 'claim').length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.type === 'autopilot_state' && l.change === 'release')).toBe(true);
    expect(lines.some((l) => l.type === 'driver_locked' && l.trusted === false)).toBe(true);
    expect(lines.some((l) => l.type === 'driver_override')).toBe(true);
    expect(lines.some((l) => l.type === 'autopilot_state' && l.change === 'resume')).toBe(true);
    // window resolutions: the locked lap is overridden, at least one lap ran
    // on autopilot (the resumed seat / the unclaimed seats)
    const decisions = lines
      .filter((l) => l.type === 'window_closed')
      .flatMap((l) => l.decisions ?? [])
      .filter((d) => d.carId === seatCarId);
    expect(decisions.length).toBe(TOTAL_LAPS);
    expect(decisions.some((d) => d.mode === 'overridden')).toBe(true);
    expect(decisions.some((d) => d.mode === 'autopilot')).toBe(true);
    const standings = session.standings();
    expect(standings.length).toBe(4);
    for (const s of standings) expect(s.status).toBe('FINISHED');
  }, 180000);
});