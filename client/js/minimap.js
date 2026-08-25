/**
 * 2D circuit minimap (MCPG-31) — a small HUD canvas pinned bottom-left,
 * above the features badge.
 *
 * A pure 2D canvas, NOT a second Three.js view: the outline, sector notches,
 * start/finish mark and pit lane come from buildTrack().map (the same
 * Catmull-Rom curve as the 3D road). Car dots are projected from the scene's
 * world XZ positions (scene.carWorldPos), so the map can never disagree with
 * what the 3D view shows. Pixel-art direction: square dots, chunky
 * constant-width outline, no Path2D (plain lineTo keeps this testable in
 * plain Node).
 */

const PAD = 10; // px between panel edge and the outline
const ROAD_PX = 5; // outline stroke width (css px, constant)
const DOT_PX = 7; // car dot size (css px)
const RETIRED_COLOR = '#5a616e';

/**
 * Fit the track's world bbox (map.min/max) into a w×h canvas, aspect
 * preserved and centered. Returns { scale (px per meter), ox, oz } where
 * canvas px = (ox + x*scale, oz + z*scale).
 */
export function computeMapLayout(map, w, h) {
  const tw = Math.max(1, map.max.x - map.min.x);
  const th = Math.max(1, map.max.z - map.min.z);
  const scale = Math.min((w - 2 * PAD) / tw, (h - 2 * PAD) / th);
  const ox = (w - tw * scale) / 2 - map.min.x * scale;
  const oz = (h - th * scale) / 2 - map.min.z * scale;
  return { scale, ox, oz };
}

/** World (x,z) -> canvas px using a computeMapLayout() result. */
export function projectPoint(layout, x, z) {
  return { x: layout.ox + x * layout.scale, y: layout.oz + z * layout.scale };
}

/**
 * Projected outline + marks for the given canvas size. Called once at
 * init/resize; draw() only repaints with fresh car positions.
 */
function buildMapGeometry(map, layout) {
  const outline = map.points.map((p) => projectPoint(layout, p.x, p.z));
  const N = map.points.length;
  // unit tangent (px space = world direction, normalized) at sample i
  const tangentAt = (i) => {
    const a = map.points[(i - 1 + N) % N];
    const b = map.points[(i + 1) % N];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  };
  // a short centered segment across the outline at arclength s (px units)
  const markAt = (s, lenPx) => {
    const i = Math.round((s / map.lengthM) * N) % N;
    const p = projectPoint(layout, map.points[i].x, map.points[i].z);
    const t = tangentAt(i);
    return {
      x0: p.x - (t.x * lenPx) / 2,
      y0: p.y - (t.z * lenPx) / 2,
      x1: p.x + (t.x * lenPx) / 2,
      y1: p.y + (t.z * lenPx) / 2,
    };
  };
  return {
    outline,
    sectorMarks: map.sectorS.map((s) => markAt(s, 10)),
    startMark: markAt(0, 12),
    pit: map.pitPoints.map((p) => projectPoint(layout, p.x, p.z)),
  };
}

/**
 * Create the minimap on a <canvas>. `map` is buildTrack().map.
 * draw(cars) repaints everything: outline + marks (cheap, ~256 lineTos) and
 * one square dot per car { x, z, color, status }.
 */
export function createMinimap(canvas, map) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let layout = null;
  let geo = null;

  function resize(w = 220, h = 170) {
    dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    cssW = w;
    cssH = h;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    layout = computeMapLayout(map, cssW, cssH);
    geo = buildMapGeometry(map, layout);
  }

  function strokeMark(m, color, widthPx) {
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.beginPath();
    ctx.moveTo(m.x0, m.y0);
    ctx.lineTo(m.x1, m.y1);
    ctx.stroke();
  }

  function draw(cars) {
    if (!geo) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // road outline: chunky dark ribbon + faint light edge
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    geo.outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = '#2b3140';
    ctx.lineWidth = ROAD_PX;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // pit lane (dashed amber)
    if (geo.pit.length > 1) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,197,61,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      geo.pit.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // sector notches + start/finish
    for (const m of geo.sectorMarks) strokeMark(m, 'rgba(255,255,255,0.5)', 2);
    strokeMark(geo.startMark, '#ffffff', 3);

    // car dots: squares (pixel-art), retired cars dimmed.
    // PITTING cars are already parked in their pit box by scene.setCar, so
    // their world position IS the box — no special-casing needed.
    for (const car of cars) {
      const p = projectPoint(layout, car.x, car.z);
      ctx.fillStyle = car.status === 'RETIRED' ? RETIRED_COLOR : car.color || '#888';
      ctx.fillRect(p.x - DOT_PX / 2, p.y - DOT_PX / 2, DOT_PX, DOT_PX);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - DOT_PX / 2 + 0.5, p.y - DOT_PX / 2 + 0.5, DOT_PX - 1, DOT_PX - 1);
    }
  }

  function dispose() {
    layout = null;
    geo = null;
  }

  resize();
  return { draw, resize, dispose };
}
