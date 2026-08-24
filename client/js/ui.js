/**
 * DOM overlay UI: phase chip, lap/clock, strategy-window banner,
 * leaderboard, connection state, start/finish overlays, car name labels.
 * Plain DOM — the 3D canvas stays untouched (Leclerc, MCPG-12 Q5).
 */

const $ = (id) => document.getElementById(id);

const PHASE_LABEL = {
  setup: 'SETUP',
  strategy_window: 'STRATEGY WINDOW',
  simulation: 'RACE LIVE',
  reactive_window: 'REACTIVE WINDOW',
  finished: 'FINISHED',
};

function fmtClock(s) {
  if (s == null) return '00:00.0';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function createUi() {
  const phaseChip = $('phase-chip');
  const lapLine = $('lap-line');
  const clockLine = $('clock-line');
  const connDot = $('conn-dot');
  const connText = $('conn-text');
  const viewersEl = $('viewers');
  const banner = $('strategy-banner');
  const bannerLap = $('strategy-lap');
  const bannerCountdown = $('strategy-countdown');
  const bannerCars = $('strategy-cars');
  const lbRows = $('lb-rows');
  const overlayStart = $('overlay-start');
  const startStatus = $('start-status');
  const startJoined = $('start-joined');
  const overlayFinished = $('overlay-finished');
  const finalStandings = $('final-standings');
  const labels = $('labels');

  const labelEls = new Map(); // carId -> el
  const lbEls = new Map(); // carId -> row

  function ensureLabel(carId, name, color) {
    let el = labelEls.get(carId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'car-label';
      el.style.borderColor = color;
      labels.appendChild(el);
      labelEls.set(carId, el);
    }
    el.textContent = name;
    return el;
  }

  function ensureRow(carId, name, color) {
    let row = lbEls.get(carId);
    if (!row) {
      row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `
        <span class="lb-pos"></span>
        <span class="lb-name"><span class="lb-swatch" style="background:${color}"></span><span class="lb-nm"></span><span class="lb-status"></span></span>
        <span class="lb-laps"></span>
        <span class="lb-gap"></span>
        <div class="tire-bar"><div class="tire-fill"></div></div>`;
      lbRows.appendChild(row);
      lbEls.set(carId, row);
    }
    return row;
  }

  return {
    setPhase(phase) {
      phaseChip.textContent = PHASE_LABEL[phase] ?? phase.toUpperCase();
      phaseChip.className = `phase-${phase}`;
    },

    setLap(currentLap, totalLaps) {
      lapLine.textContent = totalLaps ? `LAP ${currentLap || '—'} / ${totalLaps}` : 'LAP —';
    },

    setClock(raceTimeS) {
      clockLine.textContent = fmtClock(raceTimeS);
    },

    setSpectators(n) {
      viewersEl.textContent = n != null ? `• ${n} spectator${n === 1 ? '' : 's'}` : '';
    },

    setConnection(state, detail) {
      if (state === 'connected') {
        connDot.className = 'dot-on';
        connText.textContent = 'LIVE';
      } else if (state === 'disconnected') {
        connDot.className = 'dot-retry';
        connText.textContent = 'RECONNECTING…';
      } else if (state === 'ended') {
        connDot.className = 'dot-off';
        connText.textContent = 'SERVER ENDED';
      } else {
        connDot.className = 'dot-retry';
        connText.textContent = 'CONNECTING…';
      }
    },

    /**
     * Strategy / reactive window banner. Strategy windows list every car;
     * reactive windows list only the affected cars (from reactiveWindow.carIds).
     */
    setStrategyBanner(snapshot) {
      const strategyOpen = snapshot.phase === 'strategy_window';
      const reactiveOpen = snapshot.phase === 'reactive_window' && snapshot.reactiveWindow;
      const open = strategyOpen || reactiveOpen;
      banner.classList.toggle('hidden', !open);
      if (!open) return;

      if (reactiveOpen) {
        const rw = snapshot.reactiveWindow;
        bannerLap.textContent = `— ${String(rw.trigger).replace(/_/g, ' ').toUpperCase()}`;
        bannerCountdown.textContent = `${Math.ceil(rw.remainingS ?? 0)}s`;
        bannerCars.textContent = '';
        const submitted = new Set(rw.submittedCarIds ?? []);
        for (const car of snapshot.cars) {
          if (!rw.carIds.includes(car.id)) continue;
          const chip = document.createElement('span');
          const done = submitted.has(car.id);
          chip.className = 'sw-car' + (done ? ' done' : '');
          chip.textContent = done ? `${car.name} ✓` : car.name;
          bannerCars.appendChild(chip);
        }
        return;
      }

      bannerLap.textContent = snapshot.totalLaps ? `— LAP ${snapshot.currentLap}` : '';
      bannerCountdown.textContent = `${Math.ceil(snapshot.windowRemainingS ?? 0)}s`;
      bannerCars.textContent = '';
      for (const car of snapshot.cars) {
        const chip = document.createElement('span');
        chip.className = 'sw-car' + (car.submittedStrategy ? ' done' : '');
        chip.textContent = car.submittedStrategy ? `${car.name} ✓` : car.name;
        bannerCars.appendChild(chip);
      }
    },

    setLeaderboard(snapshot) {
      // rebuild row order from standings; keep per-car row elements
      const byId = new Map(snapshot.cars.map((c) => [c.id, c]));
      const seen = new Set();
      for (const entry of snapshot.standings) {
        const car = byId.get(entry.carId);
        if (!car) continue;
        seen.add(car.id);
        const row = ensureRow(car.id, car.name, this._colors ? this._colors[car.id] : '#888');
        row.classList.toggle('finished', car.status === 'FINISHED');
        row.querySelector('.lb-pos').textContent = entry.position;
        row.querySelector('.lb-nm').textContent = car.name;
        row.querySelector('.lb-status').textContent =
          car.status === 'PITTING' ? 'PIT' : car.status === 'RETIRED' ? 'DNF' : car.status === 'FINISHED' ? 'FIN' : '';
        row.querySelector('.lb-laps').textContent = `${car.completedLaps}/${snapshot.totalLaps}`;
        const gap = entry.gapToLeaderM;
        row.querySelector('.lb-gap').textContent =
          entry.position === 1 ? 'leader' : gap == null ? '—' : `+${gap.toFixed(1)}m`;
        const fill = row.querySelector('.tire-fill');
        const wear = car.tireWearPct ?? 0;
        fill.style.width = `${100 - wear}%`;
        fill.style.background = wear > 85 ? 'var(--red)' : wear > 65 ? 'var(--amber)' : 'var(--green)';
      }
      for (const [id, row] of lbEls) {
        if (!seen.has(id)) {
          row.remove();
          lbEls.delete(id);
        }
      }
    },

    setCarColors(colors) {
      this._colors = colors;
      for (const [id, row] of lbEls) {
        const sw = row.querySelector('.lb-swatch');
        if (sw && colors[id]) sw.style.background = colors[id];
      }
    },

    /** update a car's label text + screen position; hide when behind camera */
    placeLabel(carId, name, screenPos, extra) {
      const color = (this._colors && this._colors[carId]) || '#888';
      const el = ensureLabel(carId, name, color);
      el.textContent = extra ? `${name} ${extra}` : name;
      if (!screenPos) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${screenPos.x}px`;
      el.style.top = `${screenPos.y}px`;
    },

    showStartOverlay(status, joinedLine) {
      overlayStart.classList.remove('hidden');
      startStatus.textContent = status;
      startJoined.textContent = joinedLine ?? '';
    },

    hideStartOverlay() {
      overlayStart.classList.add('hidden');
    },

    showFinishedOverlay(standings, carNameById) {
      overlayFinished.classList.remove('hidden');
      finalStandings.textContent = '';
      for (const entry of standings) {
        const row = document.createElement('div');
        row.className = 'final-row';
        const name = carNameById[entry.carId] ?? entry.name ?? entry.carId;
        const gap =
          entry.position === 1
            ? 'winner'
            : entry.finishTimeS != null && standings[0].finishTimeS != null
              ? `+${(entry.finishTimeS - standings[0].finishTimeS).toFixed(1)}s`
              : '';
        row.innerHTML = `<span class="lb-pos">${entry.position}.</span><span class="lb-nm">${name}</span><span class="f-gap">${gap}</span>`;
        finalStandings.appendChild(row);
      }
    },
  };
}
