import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHttpServer } from '../src/server/http.js';
import { createSpectatorHub } from '../src/server/spectator.js';
import { RaceOrchestrator } from '../src/server/raceOrchestrator.js';
import { runAgent } from '../agents/agentBase.js';
import { SCRIPTED_AGENTS } from '../src/sim/strategies.js';
import { createRng } from '../src/rng.js';
import { loadTrackDefs, persistNextTrack, readNextTrack } from '../src/tracks.js';
import { driveWindows, closeServer, waitFor, WINDOW_BACKSTOP_S } from './helpers.js';

/**
 * MCPG-28 e2e: post-race track voting. After each race a time-boxed voting
 * window opens; human spectators vote over the existing WebSocket (one vote
 * per session, re-voting replaces). The winner decides the NEXT session's
 * track and is persisted to the log volume so a restart cannot lose it.
 *
 * Scenario (1-lap races, 0 ms tick delay, windows close on submit):
 *   1. Four scripted agents race session 1 on the env track (coastal-palm).
 *   2. The post-race vote opens; two raw-WS spectators vote (one re-votes),
 *      invalid tracks are rejected, live snapshots carry phase 'voting' with
 *      running counts, and vote acks come back per WS session.
 *   3. The tally picks mountain-hairpins (2 votes) — persisted with source
 *      'vote' — and session 2 opens on it.
 *   4. Race 2 finishes with NO voters: the deterministic fallback rotation
 *      (registry order) kicks in and is persisted with source 'fallback'.
 *   5. The persisted file round-trips (persist/read, corrupt file -> null)
 *      and a fresh orchestrator instance reads it for its next session
 *      (restart simulation).
 *
 * NOTE on ordering: the voting phase is NOT 'finished', so the `driveWindows`
 * poller (which stops at 'finished') would stop INSIDE the vote window. The
 * scenario therefore drives each race's windows up front and waits on the
 * orchestrator's phase for the voting transitions; race 2 is also driven to
 * completion inside beforeAll so every assertion has its data.
 *
 * Wall-clock budget: two 1-lap races + two ~2 s vote windows + 0.3 s holds
 * ≈ well under 15 s.
 */
const TOTAL_LAPS = 1;
const VOTE_S = 2;
const HOLD_S = 0.3;

const RACE1_AGENTS = [
  { profile: 'aggressive', name: 'Aggro', seed: 301 },
  { profile: 'conservative', name: 'Turtle', seed: 302 },
  { profile: 'pitHeavy', name: 'PitPete', seed: 303 },
  { profile: 'random', name: 'Randy', seed: 304 },
];
const RACE2_AGENTS = [
  { profile: 'aggressive', name: 'R2B', seed: 305 },
  { profile: 'conservative', name: 'R2C', seed: 306 },
  { profile: 'pitHeavy', name: 'R2D', seed: 307 },
  { profile: 'random', name: 'R2E', seed: 308 },
];

let tmpDir;
let logFile;
let nextTrackFile;
let orchestrator;
let server;
let hub;
let baseUrl;
let wsUrl;
let session1;
let session2;
const specA = { ws: null, messages: [] };
const specB = { ws: null, messages: [] };
const specC = { ws: null, messages: [] }; // (re)connects INTO the open window (MCPG-57)
let acksA = [];
let acksB = [];
let rejectsB = [];
let votingMsgs = [];
let votingSnapshots = [];
let reconnectVoting = null; // specC's `voting` greeting (MCPG-57)
const voteResults = []; // one per raceSeq (deduped)
let persistAfterRace1 = null;

function connectSpectator(box) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    box.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      box.messages.push(msg);
      if (msg.type === 'vote_ack' && box === specA) acksA.push(msg);
      if (msg.type === 'vote_ack' && box === specB) acksB.push(msg);
      if (msg.type === 'vote_rejected' && box === specB) rejectsB.push(msg);
      if (msg.type === 'voting') votingMsgs.push(msg);
      if (msg.type === 'snapshot' && msg.phase === 'voting') votingSnapshots.push(msg);
      if (msg.type === 'vote_result' && !voteResults.some((r) => r.raceSeq === msg.raceSeq)) {
        voteResults.push(msg);
      }
    });
    ws.addEventListener('open', () => resolve(box));
  });
}

function startAgent(a) {
  return runAgent({
    name: a.name,
    serverUrl: baseUrl,
    decide: SCRIPTED_AGENTS[a.profile].decide,
    decideReactive: SCRIPTED_AGENTS[a.profile].decideReactive,
    rng: createRng(a.seed),
    pollMs: 50,
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpgp-vote-'));
  logFile = path.join(tmpDir, 'voting.jsonl');
  nextTrackFile = path.join(tmpDir, 'next_track.json');

  orchestrator = new RaceOrchestrator({
    totalLaps: TOTAL_LAPS,
    strategyWindowSeconds: WINDOW_BACKSTOP_S,
    reactiveWindowSeconds: WINDOW_BACKSTOP_S,
    tickWallDelayMs: 0,
    seed: 7,
    resultsHoldSeconds: HOLD_S,
    pendingGraceSeconds: 2,
    voteWindowSeconds: VOTE_S,
    nextTrackFile,
    logFile,
    logToStdout: false,
  });

  orchestrator.run(); // opens session 1 synchronously; the host loop awaits agents
  session1 = orchestrator.session;

  server = createMcpHttpServer(orchestrator);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  wsUrl = `ws://127.0.0.1:${port}/spectate`;

  hub = createSpectatorHub(server, orchestrator.session, {
    getSession: () => orchestrator.session,
    onEvent: (e) => orchestrator.logger.log(e),
  });

  orchestrator.onSession = () => hub.reset();
  orchestrator.onRaceComplete = () => hub.finalize();
  orchestrator.onVoteStart = (info) => orchestrator.logger.log({ type: 'test_vote_start', options: info.options.map((o) => o.id) });
  orchestrator.onVoteEnd = (res) => {
    hub.finalizeVote(res);
    orchestrator.logger.log({ type: 'test_vote_end', winner: res.trackId, source: res.source });
  };

  await connectSpectator(specA);
  await connectSpectator(specB);

  // ---- race 1, then vote ----
  const race1Promises = RACE1_AGENTS.map((a) => startAgent(a));
  const drive1 = driveWindows(session1);
  await waitFor(() => orchestrator.state().phase === 'voting', 15000, 'voting window 1 to open');

  expect(session1.castVote).toBeTypeOf('function'); // hub routes through the session
  specA.ws.send(JSON.stringify({ type: 'vote', trackId: 'mountain-hairpins' }));
  specB.ws.send(JSON.stringify({ type: 'vote', trackId: 'city-night' }));
  await waitFor(() => acksA.length >= 1 && acksB.length >= 1, 3000, 'vote acks');
  // Invalid + replace behavior: unknown track rejected, re-vote replaces.
  specB.ws.send(JSON.stringify({ type: 'vote', trackId: 'no-such-track' }));
  specB.ws.send(JSON.stringify({ type: 'vote', trackId: 'mountain-hairpins' }));
  await waitFor(() => rejectsB.length >= 1, 3000, 'vote rejection');
  await waitFor(
    () => acksB.length >= 2 && acksB[acksB.length - 1].trackId === 'mountain-hairpins',
    3000,
    're-vote ack',
  );

  // (Re)connect INTO the open window (MCPG-57): specC must be greeted with
  // the same live vote view the snapshots carry (counts + remainingS, no
  // winner), not the raw window info.
  await connectSpectator(specC);
  await waitFor(() => votingMsgs.length >= 3, 3000, 'reconnect voting message');
  reconnectVoting = votingMsgs[votingMsgs.length - 1];

  await drive1; // resolves at 'finished' (before the voting phase)
  await Promise.all(race1Promises);

  // The window closes after VOTE_S and session 2 opens on the winner.
  await waitFor(() => orchestrator.state().phase === 'setup', 15000, 'session 2 to open');
  session2 = orchestrator.session;
  persistAfterRace1 = readNextTrack(nextTrackFile);

  // ---- race 2 (no voters), driven to completion ----
  const race2Promises = RACE2_AGENTS.map((a) => startAgent(a));
  const drive2 = driveWindows(session2);
  await waitFor(() => session2.sim.cars.length >= 4, 15000, 'race 2 grid to fill');
  await waitFor(
    () => ['strategy_window', 'simulation', 'reactive_window'].includes(session2.sim.phase),
    15000,
    'race 2 to start',
  );
  await drive2; // resolves at 'finished' (before race 2's voting phase)
  await Promise.all(race2Promises);

  // Session 2's vote (no voters) falls back and persists before session 3.
  await waitFor(
    () => {
      const t = readNextTrack(nextTrackFile);
      return t && t.source === 'fallback';
    },
    15000,
    'fallback vote to persist after race 2',
  );
  // Let the rotation continue so teardown has a settled orchestrator.
  await waitFor(() => orchestrator.raceSeq >= 3, 5000, 'rotation to continue into session 3');
}, 60000);

afterAll(async () => {
  orchestrator.shutdown('test-teardown');
  await new Promise((r) => setTimeout(r, 100));
  hub.close();
  specA.ws.close();
  specB.ws.close();
  specC.ws.close();
  await closeServer(server);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function logLines() {
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('post-race track voting (MCPG-28)', () => {
  it('offers every registry track except the one just raced', () => {
    const ids = loadTrackDefs().map((d) => d.id);
    const raced1 = session1.sim.track.id;
    expect(votingMsgs[0].options.map((o) => o.id)).toEqual(ids.filter((id) => id !== raced1));
    // The live tally view carried the same options.
    expect(votingSnapshots[0].vote.options.map((o) => o.id)).toEqual(ids.filter((id) => id !== raced1));
  });

  it('decides the next session by the vote tally (mountain-hairpins, 2 votes)', () => {
    // Two distinct spectators voted mountain-hairpins (B after re-voting
    // from city-night); the re-vote ack carries the updated total.
    expect(acksA[0]).toMatchObject({ trackId: 'mountain-hairpins', totalVotes: 1 });
    expect(acksB[0]).toMatchObject({ trackId: 'city-night', totalVotes: 2 });
    const revote = acksB[acksB.length - 1];
    expect(revote).toMatchObject({ trackId: 'mountain-hairpins', totalVotes: 2 });
    expect(rejectsB[0]).toMatchObject({ error: expect.stringContaining('unknown track') });

    expect(session2.sim.track.id).toBe('mountain-hairpins');

    const line = logLines().find((l) => l.type === 'track_vote_result' && l.raceSeq === 1);
    expect(line).toMatchObject({
      winner: 'mountain-hairpins',
      source: 'vote',
      totalVotes: 2,
      votes: { 'mountain-hairpins': 2 },
    });
  });

  it('persisted the decision atomically (tmp+rename) and session 2 raced it', () => {
    expect(persistAfterRace1).toMatchObject({ trackId: 'mountain-hairpins', source: 'vote' });
    expect(fs.existsSync(nextTrackFile)).toBe(true);
    expect(fs.existsSync(nextTrackFile + '.tmp')).toBe(false); // rename, not copy
    expect(session2.sim.track.name).toBe('Mountain Hairpins');
  });

  it('keeps the window undecided while open (MCPG-57)', () => {
    // The regression guard: the server used to broadcast the fallback
    // track as a provisional `winner` in the `voting` message and EVERY
    // open-window snapshot, so the client rendered DECIDED + 0 votes for
    // the whole window and never showed the Vote buttons. The winner only
    // exists at close and travels in the vote_result message.
    expect(votingMsgs.length).toBeGreaterThanOrEqual(2);
    expect(votingSnapshots.length).toBeGreaterThan(1); // ≥2 open-window snapshots
    const voteBlocks = [
      ...votingMsgs.map((m) => m), // `voting` spreads the vote block top-level
      ...votingSnapshots.map((s) => s.vote),
    ];
    for (const vote of voteBlocks) {
      expect(vote, 'vote block present').toBeTruthy();
      expect(vote.winner, 'winner is null while the window is open').toBe(null);
      expect(typeof vote.remainingS, 'remainingS present').toBe('number');
      expect(vote.remainingS).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(vote.options) && vote.options.length).toBeGreaterThan(0);
      for (const o of vote.options) expect(typeof o.votes, 'per-option votes present').toBe('number');
    }
  });

  it('greets a (re)connecting spectator with the live vote view (MCPG-57)', () => {
    // specC connected mid-window, after both votes had landed: its
    // `voting` greeting must carry the running tally and the countdown —
    // the same view as the open-window snapshots (not the raw info).
    expect(reconnectVoting, 'reconnect voting message').toBeTruthy();
    expect(reconnectVoting.winner).toBe(null);
    expect(typeof reconnectVoting.remainingS).toBe('number');
    expect(reconnectVoting.remainingS).toBeGreaterThanOrEqual(0);
    expect(reconnectVoting.totalVotes).toBe(2);
    expect(reconnectVoting.options.find((o) => o.id === 'mountain-hairpins').votes).toBe(2);
    expect(reconnectVoting.options.find((o) => o.id === 'city-night').votes).toBe(0);
  });

  it('broadcast the vote to spectators: window msg, live snapshots, result', () => {
    // While the window was open, snapshots carried phase 'voting' + a live
    // vote block whose counts tick up as votes arrive.
    expect(votingSnapshots.length).toBeGreaterThan(0);
    const tallied = votingSnapshots.some((s) => s.vote?.options?.find((o) => o.id === 'mountain-hairpins')?.votes === 2);
    expect(tallied, 'a live snapshot showed the running tally').toBe(true);

    const result = voteResults.find((r) => r.raceSeq === 1);
    expect(result).toMatchObject({ trackId: 'mountain-hairpins', source: 'vote' });
    expect(result.options.find((o) => o.id === 'mountain-hairpins').votes).toBe(2);
  });

  it('falls back to the registry rotation when nobody votes (race 2)', () => {
    const line = logLines().find((l) => l.type === 'track_vote_result' && l.raceSeq === 2);
    expect(line.source).toBe('fallback');
    const ids = loadTrackDefs().map((d) => d.id);
    const raced2 = session2.sim.track.id;
    expect(line.winner).toBe(ids[(ids.indexOf(raced2) + 1) % ids.length]);

    const result = voteResults.find((r) => r.raceSeq === 2);
    expect(result).toMatchObject({ trackId: line.winner, source: 'fallback' });
    const persisted = readNextTrack(nextTrackFile);
    expect(persisted).toMatchObject({ trackId: line.winner, source: 'fallback' });
  });

  it('survives a restart: a fresh orchestrator reads the persisted decision', () => {
    // The file round-trips: write/read with a fresh payload...
    persistNextTrack({ trackId: 'city-night', source: 'vote', votes: { 'city-night': 1 }, raceId: 'test', file: nextTrackFile });
    expect(readNextTrack(nextTrackFile)).toMatchObject({ trackId: 'city-night', source: 'vote' });
    // ...and a corrupt file degrades to null, not a crash.
    fs.writeFileSync(nextTrackFile, '{not json');
    expect(readNextTrack(nextTrackFile)).toBe(null);

    // A brand-new orchestrator instance (same file) picks the persisted id
    // for its second session — exactly what a container restart reproduces.
    persistNextTrack({ trackId: 'city-night', source: 'vote', votes: {}, raceId: 'test', file: nextTrackFile });
    const restarted = new RaceOrchestrator({
      totalLaps: TOTAL_LAPS,
      tickWallDelayMs: 0,
      voteWindowSeconds: 0, // voting disabled: pure persistence check
      nextTrackFile,
      logToStdout: false,
    });
    expect(restarted._trackIdForNextSession()).toBe('city-night');
  });
});
