/**
 * Leaderboard LAST/SPL columns (MCPG-31): the display logic in ui.js is
 * exercised against a minimal fake DOM — LAST formatting, the "most recently
 * COMPLETED sector" rule (in sector k -> index k-2), and the green "best
 * split" class (server values only; the client derives nothing).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      if (on === undefined) {
        if (set.has(c)) set.delete(c);
        else set.add(c);
      } else if (on) set.add(c);
      else set.delete(c);
      return set.has(c);
    },
  };
}

function makeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    childElementCount: 0,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: makeClassList(),
    _spans: new Map(),
    appendChild(child) {
      el.children.push(child);
      el.childElementCount = el.children.length;
      return child;
    },
    remove() {},
    addEventListener() {},
    querySelector(sel) {
      if (!el._spans.has(sel)) el._spans.set(sel, makeEl('span'));
      return el._spans.get(sel);
    },
  };
  return el;
}

const doc = {
  _byId: new Map(),
  getElementById(id) {
    if (!this._byId.has(id)) this._byId.set(id, makeEl());
    return this._byId.get(id);
  },
  createElement: (tag) => makeEl(tag),
};

let createUi;
beforeAll(async () => {
  vi.stubGlobal('document', doc);
  ({ createUi } = await import('../client/js/ui.js'));
});

function rows() {
  return doc.getElementById('lb-rows').children;
}
function col(row, sel) {
  return row.querySelector(sel);
}
function splBest(row) {
  return row.querySelector('.lb-spl').classList.contains('best');
}

function snapshot() {
  return {
    totalLaps: 10,
    cars: [
      // A: in sector 2, S1 split 24.31 IS the personal best -> green
      {
        id: 1, name: 'A', status: 'RUNNING', completedLaps: 3, tireWearPct: 20,
        lastLapTimeS: 95.42, currentSector: 2,
        currentSectorTimesS: [24.31, null, null, null, null],
        bestSectorTimesS: [24.31, null, null, null, null],
      },
      // B: in sector 1 (no split yet), no laps -> LAST '—', SPL 'S1'
      {
        id: 2, name: 'B', status: 'RUNNING', completedLaps: 0, tireWearPct: 40,
        lastLapTimeS: null, currentSector: 1,
        currentSectorTimesS: [null, null, null, null, null],
        bestSectorTimesS: [null, null, null, null, null],
      },
      // C: retired, frozen splits — S2 29.9 is still the best -> green
      {
        id: 3, name: 'C', status: 'RETIRED', completedLaps: 5, tireWearPct: 90,
        lastLapTimeS: 132.5, currentSector: 3,
        currentSectorTimesS: [30.1, 29.9, null, null, null],
        bestSectorTimesS: [28.0, 29.9, null, null, null],
      },
      // D: in sector 2, split 24.31 but best is 24.10 -> NOT green
      {
        id: 4, name: 'D', status: 'RUNNING', completedLaps: 2, tireWearPct: 55,
        lastLapTimeS: 96.1, currentSector: 2,
        currentSectorTimesS: [24.31, null, null, null, null],
        bestSectorTimesS: [24.1, null, null, null, null],
      },
    ],
    standings: [
      { carId: 1, position: 1, gapToLeaderM: null },
      { carId: 2, position: 2, gapToLeaderM: 12.4 },
      { carId: 3, position: 3, gapToLeaderM: 41.0 },
      { carId: 4, position: 4, gapToLeaderM: null },
    ],
  };
}

describe('leaderboard LAST/SPL columns (MCPG-31)', () => {
  it('renders LAST from lastLapTimeS (m:ss.t / ss.t), — when unknown', () => {
    const ui = createUi();
    ui.setLeaderboard(snapshot());
    const r = rows();
    expect(r).toHaveLength(4);
    expect(col(r[0], '.lb-last').textContent).toBe('1:35.4'); // 95.42 s
    expect(col(r[1], '.lb-last').textContent).toBe('—'); // no lap yet
    expect(col(r[2], '.lb-last').textContent).toBe('2:12.5'); // retired, frozen
  });

  it('shows the most recently COMPLETED sector: in sector k -> S{k-1}', () => {
    const ui = createUi();
    ui.setLeaderboard(snapshot());
    const r = rows();
    expect(col(r[0], '.lb-spl').textContent).toBe('S1 24.3');
    expect(col(r[1], '.lb-spl').textContent).toBe('S1');
    expect(col(r[2], '.lb-spl').textContent).toBe('S2 29.9');
  });

  it('marks the split green only when it equals the personal best', () => {
    const ui = createUi();
    ui.setLeaderboard(snapshot());
    const r = rows();
    expect(splBest(r[0])).toBe(true); // 24.31 == best 24.31
    expect(splBest(r[1])).toBe(false); // sector 1, no split yet
    expect(splBest(r[2])).toBe(true); // frozen best on a retired car
    expect(splBest(r[3])).toBe(false); // 24.31 vs best 24.10
  });

  it('keeps the existing LAP/GAP columns intact', () => {
    const ui = createUi();
    ui.setLeaderboard(snapshot());
    const r = rows();
    expect(col(r[0], '.lb-laps').textContent).toBe('3/10');
    expect(col(r[0], '.lb-gap').textContent).toBe('leader');
    expect(col(r[1], '.lb-gap').textContent).toBe('+12.4m');
  });
});
