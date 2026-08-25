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
