/**
 * Voting panel DOM (MCPG-57): the real client/js/ui.js against the real
 * index.html in headless Chromium.
 *
 * The live bug: the server sent a provisional `winner` in every open-window
 * snapshot, so the panel showed DECIDED + 0 votes for the whole window,
 * rendered NO Vote buttons, and the winner-branch refresh appended a new
 * result span on every snapshot (~10/s). These tests drive the exact
 * functions the WebSocket path uses (showVotePanel / setVoteHandler) with
 * the corrected server view (winner: null while open) and assert the DOM
 * stays stable across a full vote window.
 *
 * No game server needed: the static server serves the page, and the panel
 * is driven in-page from plain vote objects in the server's wire shape.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../src/server/staticServe.js';
import { closeServer } from './helpers.js';
import { chromium } from 'playwright';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

const OPTIONS = [
  { id: 'city-night', name: 'City Night', lengthM: 1000, theme: 'urban' },
  { id: 'mountain-hairpins', name: 'Mountain Hairpins', lengthM: 1000, theme: 'alpine' },
];

/** Wire shape of the vote block while the window is OPEN (MCPG-57: no winner). */
function openVote(remainingS, votes) {
  return {
    raceId: 'r1',
    raceSeq: 1,
    options: OPTIONS.map((o) => ({ ...o, votes: votes[o.id] ?? 0 })),
    winner: null,
    defaultId: 'coastal-palm',
    totalVotes: Object.values(votes).reduce((a, b) => a + b, 0),
    windowSeconds: 30,
    remainingS,
  };
}

/** Wire shape after the window closed (vote_result: the decided track). */
function decidedVote(winnerId, votes) {
  return {
    raceId: 'r1',
    raceSeq: 1,
    options: OPTIONS.map((o) => ({ ...o, votes: votes[o.id] ?? 0 })),
    winner: winnerId,
    defaultId: 'coastal-palm',
    totalVotes: Object.values(votes).reduce((a, b) => a + b, 0),
    windowSeconds: 30,
    remainingS: 0,
  };
}

let server;
let baseUrl;
let browser;
let page;
const errors = [];

beforeAll(async () => {
  server = createStaticServer(clientDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    // Software WebGL keeps this deterministic on headless/CI machines.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // expected: the static server has no /spectate WebSocket endpoint
    if (m.text().includes('/spectate')) return;
    errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${baseUrl}/`);
  // A fresh UI on the page's real elements; Vote clicks recorded for
  // asserts. Injected as a <script type=module> — a dynamic import inside
  // page.evaluate would be rewritten by vitest (same workaround as
  // fx-skin.test.js).
  await page.addScriptTag({
    type: 'module',
    content: `
      const { createUi } = await import('/js/ui.js');
      window.__ui = createUi();
      window.__clicks = [];
      window.__ui.setVoteHandler((trackId) => window.__clicks.push(trackId));
      window.__voteUiReady = true;
    `,
  });
  await page.waitForFunction(() => !!window.__voteUiReady, { timeout: 10000 });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await closeServer(server);
});

/**
 * Reset the panel, then run `steps` through showVotePanel exactly like the
 * snapshot loop would. Returns one DOM summary per step (so growth across
 * the whole window can be asserted step by step).
 */
async function drive(steps) {
  return page.evaluate((steps) => {
    window.__ui.reset();
    const summarize = () => {
      const rows = [...document.querySelectorAll('#vote-options .vote-option')];
      return {
        hidden: document.getElementById('overlay-vote').classList.contains('hidden'),
        countdown: document.getElementById('vote-countdown').textContent,
        rowCount: rows.length,
        rows: rows.map((r) => ({
          trackId: r.dataset.trackId,
          childCount: r.childElementCount,
          buttons: r.querySelectorAll('button').length,
          results: r.querySelectorAll('.vote-option-result').length,
          resultText: r.querySelector('.vote-option-result') ? r.querySelector('.vote-option-result').textContent : null,
          btnText: r.querySelector('button') ? r.querySelector('button').textContent : null,
          mine: r.classList.contains('mine'),
        })),
      };
    };
    const states = [];
    for (const step of steps) {
      window.__ui.showVotePanel(step.vote, { myVote: step.myVote ?? null });
      states.push(summarize());
    }
    return states;
  }, steps);
}

const last = (states) => states[states.length - 1];

describe('voting panel DOM (MCPG-57)', () => {
  it('open window: one row per track, one Vote button each, nothing duplicated across the whole window', async () => {
    // Two open-window snapshots (the server's corrected view: winner null),
    // then 100 more at ~10 Hz with the live count ticking — a full window.
    const steps = [{ vote: openVote(29.9, {}) }, { vote: openVote(15.4, { 'city-night': 1 }) }];
    for (let i = 0; i < 100; i += 1) {
      steps.push({ vote: openVote(15.4 - i * 0.14, { 'city-night': 1 }) });
    }
    const states = await drive(steps);

    // Every single snapshot leaves exactly the same structure behind:
    // one row per track, one right-hand element (the button), no result
    // spans — no growth at any point in the window.
    for (const st of states) {
      expect(st.hidden, 'panel visible while open').toBe(false);
      expect(st.rowCount, 'one row per track').toBe(2);
      expect(st.rows.map((r) => r.trackId)).toEqual(['city-night', 'mountain-hairpins']);
      for (const r of st.rows) {
        expect(r.childCount, 'exactly name + meta + one right element').toBe(3);
        expect(r.buttons).toBe(1);
        expect(r.btnText).toBe('Vote');
        expect(r.results, 'no result elements while open').toBe(0);
      }
    }
    // The countdown ticks from the live remainingS (not a fixed "DECIDED").
    expect(states[0].countdown).toBe('Closes in 30s');
    expect(states[1].countdown).toBe('Closes in 16s');
    expect(last(states).countdown).toBe('Closes in 2s');
  });

  it('Vote buttons are clickable while open and the pick is highlighted', async () => {
    await drive([{ vote: openVote(25, {}) }]);
    await page.click('#vote-options .vote-option[data-track-id="city-night"] button');
    expect(await page.evaluate(() => window.__clicks)).toEqual(['city-night']);

    const states = await drive([{ vote: openVote(24, { 'city-night': 1 }), myVote: 'city-night' }]);
    const st = last(states);
    expect(st.rows.find((r) => r.trackId === 'city-night').mine).toBe(true);
    expect(st.rows.find((r) => r.trackId === 'city-night').btnText).toBe('Voted ✓');
    expect(st.rows.find((r) => r.trackId === 'mountain-hairpins').mine).toBe(false);
    expect(st.rows.find((r) => r.trackId === 'mountain-hairpins').btnText).toBe('Vote');
  });

  it('vote_result after an open window: DECIDED, exactly one result per row with real tallies, idempotent', async () => {
    // Open window (buttons rendered), then the window closes with
    // mountain-hairpins winning 2-0.
    const steps = [
      { vote: openVote(12, { 'city-night': 1 }) },
      { vote: decidedVote('mountain-hairpins', { 'mountain-hairpins': 2 }) },
      // repeated decided snapshots must not change the DOM shape at all
      { vote: decidedVote('mountain-hairpins', { 'mountain-hairpins': 2 }) },
      { vote: decidedVote('mountain-hairpins', { 'mountain-hairpins': 2 }) },
    ];
    const states = await drive(steps);

    // While open: buttons, no DECIDED.
    const open = states[0];
    expect(open.countdown).not.toBe('DECIDED');
    for (const r of open.rows) expect(r.buttons).toBe(1);

    // Decided: exactly one result element per row (the button is replaced
    // in place), real tallies, and every repeat keeps the same shape.
    for (const st of states.slice(1)) {
      expect(st.countdown, 'DECIDED only after the result').toBe('DECIDED');
      expect(st.rowCount).toBe(2);
      for (const r of st.rows) {
        expect(r.childCount, 'no duplication on repeated decided snapshots').toBe(3);
        expect(r.buttons, 'Vote buttons are gone once decided').toBe(0);
        expect(r.results, 'exactly one result element per row').toBe(1);
      }
      const winner = st.rows.find((r) => r.trackId === 'mountain-hairpins');
      const loser = st.rows.find((r) => r.trackId === 'city-night');
      expect(winner.resultText).toBe('winner — 2 votes');
      expect(loser.resultText).toBe('0 votes');
    }
  });

  it('rows built directly in the decided state (late (re)connect) never duplicate', async () => {
    // A client that (re)connects after close renders the result list from
    // the first snapshot on — repeated snapshots must not add elements.
    const states = await drive([
      { vote: decidedVote('city-night', { 'city-night': 1 }) },
      { vote: decidedVote('city-night', { 'city-night': 1 }) },
    ]);
    for (const st of states) {
      expect(st.countdown).toBe('DECIDED');
      for (const r of st.rows) {
        expect(r.childCount).toBe(3);
        expect(r.buttons).toBe(0);
        expect(r.results).toBe(1);
      }
      expect(st.rows.find((r) => r.trackId === 'city-night').resultText).toBe('winner — 1 vote');
      expect(st.rows.find((r) => r.trackId === 'mountain-hairpins').resultText).toBe('0 votes');
    }
  });

  it('the page runs without unexpected errors', () => {
    expect(errors).toEqual([]);
  });
});
