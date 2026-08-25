/**
 * Throwaway visual check for the MCPG-49 season UI (SEASON column on the
 * results overlay + crown chip on the live leaderboard). Not part of the
 * test suite — run: node scripts/visualSeasonCheck.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticServer } from '../src/server/staticServe.js';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

const server = createStaticServer(clientDir);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(baseUrl, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const c = document.querySelector('#scene');
  return c && c.width > 0;
}, { timeout: 20000 });

// Hide the welcome overlay so the HUD + leaderboard are visible.
await page.evaluate(() => {
  const w = document.getElementById('overlay-welcome');
  if (w) w.classList.add('hidden');
});

const result = await page.evaluate(async () => {
  const { createUi } = await import('./js/ui.js');
  const ui = createUi();
  const snapshot = {
    cars: [
      { id: 'c1', name: 'Verstappen', status: 'RACING' },
      { id: 'c2', name: 'Leclerc', status: 'RACING' },
      { id: 'c3', name: 'Hamilton', status: 'RACING' },
    ],
    standings: [
      { carId: 'c1', position: 1 },
      { carId: 'c2', position: 2 },
      { carId: 'c3', position: 3 },
    ],
    season: [
      { position: 1, name: 'Leclerc', points: 31, wins: 2, races: 2, dnf: 0, streak: 1 },
      { position: 2, name: 'Verstappen', points: 15, wins: 1, races: 2, dnf: 0, streak: 0 },
      { position: 3, name: 'Hamilton', points: 10, wins: 0, races: 2, dnf: 1, streak: 0 },
    ],
  };
  // ui.js keeps per-car colors; mimic main.js' usage closely enough for a render check
  ui.setCarColors(Object.fromEntries(snapshot.cars.map((c) => [c.id, `hsl(${(c.id.charCodeAt(1) * 47) % 360} 70% 60%)`])));
  ui.setLeaderboard(snapshot);
  const crownRow = document.querySelector('#leaderboard .lb-row .lb-crown');
  const crowned = [...document.querySelectorAll('#leaderboard .lb-row')].map((r) => ({
    name: r.querySelector('.lb-nm').textContent,
    crown: r.querySelector('.lb-crown').textContent,
  }));

  ui.showFinishedOverlay(
    [
      { carId: 'c1', position: 1, name: 'Verstappen', finishTimeS: 120.0 },
      { carId: 'c2', position: 2, name: 'Leclerc', finishTimeS: 123.4 },
      { carId: 'c3', position: 3, name: 'Hamilton', finishTimeS: 140.1 },
    ],
    { c1: 'Verstappen', c2: 'Leclerc', c3: 'Hamilton' },
    snapshot.season,
  );
  const rows = [...document.querySelectorAll('#final-standings .final-row')].map((r) =>
    [...r.children].map((c) => c.textContent.trim()),
  );
  return { crowned, rows };
});

console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: '/tmp/season-check-overlay.png' });
// screenshot the live leaderboard view (hide the finished overlay again)
await page.evaluate(() => document.getElementById('overlay-finished')?.classList.add('hidden'));
await page.screenshot({ path: '/tmp/season-check-leaderboard.png' });

await browser.close();
server.close();
