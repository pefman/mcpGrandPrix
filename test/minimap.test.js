/**
 * 2D circuit minimap (MCPG-31): layout/projection math + the draw pipeline,
 * driven against a fake canvas 2D context (no browser needed). The browser
 * smoke (test/fx-skin.test.js) separately proves the page loads the module
 * without errors; the live in-race rendering uses scene.world positions that
 * the sim's own tests cover.
 */
import { describe, expect, it } from 'vitest';
import { computeMapLayout, projectPoint, createMinimap } from '../client/js/minimap.js';

// A 400 m circuit with a 100x100 m bbox (4 sectors of 100 m).
const MAP = {
  points: [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
  ],
  pitPoints: [
    { x: 20, z: -10 },
    { x: 80, z: -10 },
  ],
  min: { x: 0, z: 0 },
  max: { x: 100, z: 100 },
  sectorS: [100, 200, 300],
  lengthM: 400,
};

function makeFakeCanvas() {
  const rects = [];
  let strokes = 0;
  const ctx = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
    stroke() {
      strokes += 1;
    },
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, style: ctx.fillStyle });
    },
    strokeRect() {},
  };
  return {
    canvas: { style: {}, width: 0, height: 0, getContext: () => ctx },
    rects,
    strokes: () => strokes,
  };
}

describe('minimap layout + projection (MCPG-31)', () => {
  it('fits the world bbox into the canvas, centered, aspect preserved', () => {
    const layout = computeMapLayout(MAP, 220, 170);
    // bounded by height: (170 - 20) / 100 = 1.5 px/m
    expect(layout.scale).toBeCloseTo(1.5, 9);
    const p0 = projectPoint(layout, 0, 0);
    const p1 = projectPoint(layout, 100, 100);
    expect(p0.x).toBeCloseTo(35, 9); // (220 - 150) / 2
    expect(p0.y).toBeCloseTo(10, 9); // (170 - 150) / 2
    expect(p1.x).toBeCloseTo(185, 9);
    expect(p1.y).toBeCloseTo(160, 9);
  });

  it('centers bboxes with negative world offsets', () => {
    const shifted = { ...MAP, min: { x: -50, z: 0 }, max: { x: 50, z: 100 } };
    const layout = computeMapLayout(shifted, 220, 170);
    // same scale; min corner lands at the same centered spot as above
    expect(projectPoint(layout, -50, 0).x).toBeCloseTo(35, 9);
    expect(projectPoint(layout, 50, 100).x).toBeCloseTo(185, 9);
  });

  it('letterboxes non-square tracks (width bound)', () => {
    const wide = { ...MAP, max: { x: 300, z: 100 }, min: { x: 0, z: 0 } };
    const layout = computeMapLayout(wide, 220, 170);
    expect(layout.scale).toBeCloseTo(200 / 300, 9); // bounded by width
    // vertical centering: (170 - 100*scale) / 2
    const top = projectPoint(layout, 0, 0).y;
    expect(top).toBeCloseTo((170 - 100 * (200 / 300)) / 2, 9);
  });
});

describe('minimap draw (MCPG-31)', () => {
  it('paints the outline, pit lane and marks on every draw', () => {
    const fake = makeFakeCanvas();
    const mm = createMinimap(fake.canvas, MAP);
    mm.draw([]);
    // outline (2 strokes) + pit (1) + 3 sector notches + start mark
    expect(fake.strokes()).toBeGreaterThanOrEqual(7);
    expect(fake.rects).toEqual([]);
  });

  it('places a car dot at the projected world position, livery-colored', () => {
    const fake = makeFakeCanvas();
    const mm = createMinimap(fake.canvas, MAP);
    const layout = computeMapLayout(MAP, 220, 170);
    const p = projectPoint(layout, 40, 60);
    mm.draw([{ x: 40, z: 60, color: '#e10600', status: 'RUNNING' }]);
    expect(fake.rects).toHaveLength(1);
    const dot = fake.rects[0];
    expect(dot.style).toBe('#e10600');
    expect(dot.x).toBeCloseTo(p.x - 3.5, 9); // 7 px square, centered
    expect(dot.y).toBeCloseTo(p.y - 3.5, 9);
    expect(dot.w).toBe(7);
  });

  it('dims retired cars and keeps other cars at full color', () => {
    const fake = makeFakeCanvas();
    const mm = createMinimap(fake.canvas, MAP);
    mm.draw([
      { x: 10, z: 10, color: '#e10600', status: 'RETIRED' },
      { x: 90, z: 90, color: '#0600e1', status: 'PITTING' },
    ]);
    expect(fake.rects).toHaveLength(2);
    expect(fake.rects[0].style).toBe('#5a616e'); // retired -> grey
    expect(fake.rects[1].style).toBe('#0600e1'); // pitting -> livery (parked in box)
  });

  it('dispose() stops drawing without throwing', () => {
    const fake = makeFakeCanvas();
    const mm = createMinimap(fake.canvas, MAP);
    mm.dispose();
    expect(() => mm.draw([{ x: 0, z: 0, color: '#fff', status: 'RUNNING' }])).not.toThrow();
    expect(fake.rects).toEqual([]);
  });
});
