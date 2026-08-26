// MCPG-52: the client must render smooth constant-velocity motion even
// though the sim ticks every 250 ms while snapshots arrive every 100 ms.
//
// Synthetic stream mirrors production timing (model per repro_stutter.mjs):
// one car at constant 100 m/s; each sim tick (250 ms) moves it 25 m (position
// only changes on the tick); the server broadcasts every 100 ms; the client
// renders at 60 fps with a 150 ms interpolation delay.
//
// Bounds are asserted in steady state only (t >= 500 ms, past stream start).
import { describe, it, expect } from 'vitest';
import { CarPositionBuffer } from '../client/js/spectatorClient.js';

const TRACK = 1000;
const SPEED = 100; // m/s
const TICK_MS = 250;
const SNAP_MS = 100;
const RENDER_DELAY_MS = 150;
const FRAME_MS = 1000 / 60;
const STALE_HOLD_MS = 500;

/**
 * Drive the REAL CarPositionBuffer with the synthetic stream and record one
 * rendered (unwrapped) position per 60 fps frame. `feedUntilMs` cuts the
 * snapshot feed short to simulate a stale feed. Pure computation — no
 * real-time waits.
 */
function drive({ durationMs, feedUntilMs = null }) {
  const buffer = new CarPositionBuffer(TRACK);
  let dist = 0; // sim truth (m), advances in 25 m steps on the tick
  let nextTick = 0;
  let nextSnap = 0;
  let lastRenderS = null;
  const frames = [];
  let frameTime = 0;
  for (let t = 0; t <= durationMs; t += 1) {
    while (nextTick <= t) {
      dist += SPEED * (TICK_MS / 1000);
      nextTick += TICK_MS;
    }
    if (feedUntilMs == null || t <= feedUntilMs) {
      if (t >= nextSnap) {
        const positionM = dist % TRACK;
        buffer.push(
          { track: { lengthM: TRACK }, phase: 'simulation', cars: [{ id: 1, positionM, speedMs: SPEED, status: 'RUNNING' }] },
          t,
        );
        nextSnap += SNAP_MS;
      }
    }
    if (t >= frameTime) {
      frameTime += FRAME_MS;
      const smp = buffer.sample(1, t - RENDER_DELAY_MS);
      if (!smp) continue;
      let s = smp.s;
      if (lastRenderS != null) {
        if (s < lastRenderS - TRACK / 2) s += TRACK; // unwrap across the line
        else if (s > lastRenderS + TRACK / 2) s -= TRACK;
      }
      lastRenderS = s;
      frames.push({ t, s });
    }
  }
  return { frames };
}

const steady = (frames) => frames.filter((f) => f.t >= 500);

// MCPG-56 server truth, measured on the real Simulation (repro_mcp56.mjs):
// during a strategy/reactive window the sim is paused — positions are frozen
// exactly — but RUNNING cars keep reporting their last tick's speedMs (~95).
// The feed keeps flowing at 10 Hz throughout the window.
const WINDOW_SPEED = 95; // m/s, stale reported speed during a paused window

/**
 * Drive the REAL CarPositionBuffer through a sequence of race segments and
 * record one rendered (unwrapped) position per 60 fps frame, tagged with the
 * segment index it was rendered in. Segments mirror production timing:
 * positions advance in TICK_MS steps only while a segment is moving (the
 * paused sim loses that time — no catch-up); every SNAP_MS a snapshot
 * carries dist % TRACK plus the segment's phase and its REPORTED speed.
 * Pure computation — no real-time waits.
 */
function driveSegments(segments) {
  const buffer = new CarPositionBuffer(TRACK);
  let dist = 0;
  let nextTick = 0;
  let nextSnap = 0;
  let lastRenderS = null;
  const frames = [];
  let frameTime = 0;
  const bounds = [];
  let t = 0;
  for (let seg = 0; seg < segments.length; seg += 1) {
    const { ms, phase, moving = false, status = 'RUNNING', speed } = segments[seg];
    bounds.push({ start: t, end: t + ms });
    for (let segEnd = t + ms; t < segEnd; t += 1) {
      while (nextTick <= t) {
        if (moving) dist += SPEED * (TICK_MS / 1000);
        nextTick += TICK_MS;
      }
      if (t >= nextSnap) {
        buffer.push(
          {
            track: { lengthM: TRACK },
            phase,
            cars: [{ id: 1, positionM: dist % TRACK, speedMs: speed ?? (moving ? SPEED : WINDOW_SPEED), status }],
          },
          t,
        );
        nextSnap += SNAP_MS;
      }
      if (t >= frameTime) {
        frameTime += FRAME_MS;
        const smp = buffer.sample(1, t - RENDER_DELAY_MS);
        if (!smp) continue;
        let s = smp.s;
        if (lastRenderS != null) {
          if (s < lastRenderS - TRACK / 2) s += TRACK; // unwrap across the line
          else if (s > lastRenderS + TRACK / 2) s -= TRACK;
        }
        lastRenderS = s;
        frames.push({ t, s, seg });
      }
    }
  }
  return { frames, bounds };
}

describe('CarPositionBuffer paused-phase holds (MCPG-56)', () => {
  it('holds the car perfectly still through a strategy window (cruise -> window -> resume)', () => {
    // The MCPG-56 bug: cruise 10 s at ~95 m/s, then a 30 s strategy window
    // where the sim is paused but snapshots still report speedMs ~95.
    // Pre-fix the car extrapolated from the stale speed and re-anchored to
    // the same frozen spot every ~250 ms — a visible back-and-forth creep.
    const { frames, bounds } = driveSegments([
      { ms: 10000, phase: 'simulation', moving: true },
      { ms: 30000, phase: 'strategy_window' },
      { ms: 5000, phase: 'simulation', moving: true },
    ]);
    const [cruise, win, resume] = bounds;
    const windowFrames = frames.filter((f) => f.t >= win.start && f.t < win.end);
    expect(windowFrames.length).toBeGreaterThan(1000);

    // Still for the whole window, from the very first snapshot of it.
    let minS = Infinity;
    let maxS = -Infinity;
    for (const f of windowFrames) {
      minS = Math.min(minS, f.s);
      maxS = Math.max(maxS, f.s);
    }
    expect(maxS - minS).toBeLessThan(0.01);

    // No backward jumps while the window lasts.
    let backward = 0;
    for (let i = 1; i < windowFrames.length; i += 1) {
      if (windowFrames[i].s < windowFrames[i - 1].s - 1e-9) backward += 1;
    }
    expect(backward).toBe(0);

    // Resuming the sim ramps smoothly away from the held spot — no teleport,
    // no reversal in the first seconds after the window closes.
    const resumeFrames = frames.filter((f) => f.t >= resume.start && f.t < resume.start + 2000);
    for (let i = 1; i < resumeFrames.length; i += 1) {
      expect(resumeFrames[i].s - resumeFrames[i - 1].s).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('holds still on the starting grid (window before any movement, speed 0)', () => {
    const { frames } = driveSegments([{ ms: 8000, phase: 'strategy_window', speed: 0 }]);
    expect(frames.length).toBeGreaterThan(400);
    for (const f of frames) {
      expect(f.s).toBeCloseTo(frames[0].s, 6);
    }
  });

  it('holds still while the car sits in the pit box (PITTING, speed 0)', () => {
    const { frames } = driveSegments([
      { ms: 3000, phase: 'simulation', moving: true },
      { ms: 5000, phase: 'simulation', moving: false, speed: 0, status: 'PITTING' },
    ]);
    const pitFrames = frames.filter((f) => f.t >= 3500);
    expect(pitFrames.length).toBeGreaterThan(200);
    for (const f of pitFrames) {
      expect(f.s).toBeCloseTo(pitFrames[0].s, 6);
    }
  });

  it('holds still after the finish (finished phase, zeroed speed)', () => {
    const { frames } = driveSegments([
      { ms: 5000, phase: 'simulation', moving: true },
      { ms: 8000, phase: 'finished', moving: false, speed: 0 },
    ]);
    const finFrames = frames.filter((f) => f.t >= 5500);
    expect(finFrames.length).toBeGreaterThan(400);
    for (const f of finFrames) {
      expect(f.s).toBeCloseTo(finFrames[0].s, 6);
    }
  });
});

describe('CarPositionBuffer speed-based motion (MCPG-52)', () => {
  it('renders within ±2 m of the ideal constant-velocity line in steady state', () => {
    const { frames } = drive({ durationMs: 10000 });
    const steadyFrames = steady(frames);
    expect(steadyFrames.length).toBeGreaterThan(100);
    const first = steadyFrames[0];
    let maxDev = 0;
    for (const f of steadyFrames) {
      const ideal = first.s + SPEED * ((f.t - first.t) / 1000);
      maxDev = Math.max(maxDev, Math.abs(f.s - ideal));
    }
    expect(maxDev).toBeLessThanOrEqual(2);
  });

  it('never renders a 0 m/s frame in steady state (~1 m/frame floor)', () => {
    const { frames } = drive({ durationMs: 10000 });
    const steadyFrames = steady(frames);
    let minStep = Infinity;
    for (let i = 1; i < steadyFrames.length; i += 1) {
      minStep = Math.min(minStep, steadyFrames[i].s - steadyFrames[i - 1].s);
    }
    expect(minStep).toBeGreaterThanOrEqual(1.0);
  });

  it('holds position after a 500 ms feed gap (no endless extrapolation)', () => {
    const feedEnd = 5000;
    const { frames } = drive({ durationMs: 8000, feedUntilMs: feedEnd });
    // stale once renderAt = t - RENDER_DELAY_MS is > 500 ms past the feed end
    const hold = frames.filter((f) => f.t >= feedEnd + STALE_HOLD_MS + RENDER_DELAY_MS + 100);
    expect(hold.length).toBeGreaterThan(50);
    const firstS = hold[0].s;
    for (const f of hold) {
      expect(Math.abs(f.s - firstS)).toBeLessThan(1e-9);
    }
  });
});
