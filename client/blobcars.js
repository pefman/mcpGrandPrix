/**
 * Driven by test/voxel-cars-browser.test.js (MCPG-45).
 *
 * Imports the REAL spectator modules (the page's importmap resolves
 * 'three') and drives addCar/setCar on a hidden canvas exactly like
 * main.js would — so the voxel car model, livery colors, the
 * pit-transition tween and the RETIRED dim are exercised through the
 * production code path, not a copy of it. Results land on
 * window.__carsResult.
 */
import * as THREE from 'three';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = performance.now();
  const def = await (await fetch('/tracks/coastal-palm.json')).json();
  const trackInfo = {
    id: def.id,
    name: def.name,
    lengthM: def.lengthM,
    sectorLengthM: def.sectorLengthM,
  };
  const { createSpectatorScene } = await import('/js/scene.js');

  const canvas = document.createElement('canvas'); // hidden: model checks only
  canvas.width = 160;
  canvas.height = 90;
  const api = createSpectatorScene(canvas, trackInfo, def);

  // join order == __testColors order (server-assigned liveries)
  const colors = window.__testColors;
  const ids = ['a1', 'a2', 'a3', 'a4'];
  ids.forEach((id, i) => api.addCar(id, `Blob ${id}`, i, colors[i]));

  const pitId = 'a3'; // slot 2 -> pitBoxes[2]
  const dimId = 'a4'; // retired at the end
  const st = {};
  ids.forEach((id, i) => { st[id] = { s: 40 + i * 15 }; });
  let last = t0;

  function frame() {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const t = (now - t0) / 1000;
    for (const id of ids) {
      let status = 'RUNNING';
      if (id === pitId && t >= 1.2) status = 'PITTING';   // hold: s freezes
      if (id === dimId && t >= 2.2) status = 'RETIRED';   // fade to dim
      if (status === 'RUNNING') st[id].s = (st[id].s + 30 * dt) % def.lengthM;
      api.setCar(id, st[id].s, status, null);
    }
    api.render();
    if (t < 2.8) { requestAnimationFrame(frame); return; }
    record();
  }

  function carGroups() {
    // the car groups are the only scene children with 10 boxes at scale 1.9
    return api.scene.children.filter(
      (g) => g.isGroup && g.children.length === 10 && Math.abs(g.scale.x - 1.9) < 0.01,
    );
  }

  function describe(group) {
    const meshes = [];
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    return {
      parts: meshes.length,
      livery: meshes.filter((m) => m.userData.livery).map((m) => `#${m.material.color.getHexString()}`),
      wheels: meshes.filter((m) => Math.abs(m.position.x) > 1).length,
      pos: { x: group.position.x, z: group.position.z },
    };
  }

  function record() {
    const groups = carGroups();
    const pitting = describe(groups[2]);
    const pitBox = api.track.pitBoxes[Math.min(2, api.track.pitBoxes.length - 1)];
    const onTrack = describe(groups[0]);
    const expected = api.track.pointAt(st.a1.s);
    const retired = describe(groups[3]);
    // the dim must touch ONLY the livery parts
    const nonLiveryDimmed = groups[3]
      .children.filter((m) => !m.userData.livery)
      .some((m) => `#${m.material.color.getHexString()}` === '#3a3f48');
    window.__carsResult = {
      carCount: groups.length,
      expected: colors.map((c) => `#${new THREE.Color(c).getHexString()}`),
      cars: groups.map(describe),
      pitDistanceM: Math.hypot(pitting.pos.x - pitBox.pos.x, pitting.pos.z - pitBox.pos.z),
      pitBox: { x: pitBox.pos.x, z: pitBox.pos.z },
      onTrackDistanceM: Math.hypot(onTrack.pos.x - expected.x, onTrack.pos.z - expected.z),
      retiredLivery: retired.livery,
      nonLiveryDimmed,
    };
  }

  requestAnimationFrame(frame);
  // belt & braces: never hang the page forever
  await sleep(10000);
  if (!window.__carsResult) record();
})();
