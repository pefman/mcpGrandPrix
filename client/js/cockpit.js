/**
 * Driver-seat cockpit (MCPG-62).
 *
 * The AI team (an LLM or the scripted junior strategist, over MCP) posts a
 * plan each strategy window; the human in THIS browser — if they claimed a
 * seat — either leaves it in AUTOPILOT (the team's recommended card runs,
 * the resting default) or locks in / overrides a specific tactic. Everything
 * the cockpit shows is server-authoritative state (snapshots + pushed
 * tactic/driver events); the only outbound traffic is the four driver
 * actions (claim / lock_in / override / resume_autopilot), and only the
 * server can resolve a window.
 *
 * Reconnect-safe: seat + autopilot mode + the open window's plan all ride
 * in the snapshot, so a (re)connecting driver's cockpit rehydrates from one
 * frame; the pushed events are just faster than the next snapshot.
 */

const $ = (id) => document.getElementById(id);

const RISK_CLASS = { safe: 'risk-safe', moderate: 'risk-moderate', risky: 'risk-risky' };

export function createCockpit({ send }) {
  const root = $('cockpit');
  const chip = $('cockpit-chip');
  const countdown = $('cockpit-countdown');
  const claimBox = $('cockpit-claim');
  const claimList = $('cockpit-claim-list');
  const panel = $('cockpit-panel');
  const radioFeed = $('cockpit-radio');
  const cardsEl = $('cockpit-cards');
  const actionsEl = $('cockpit-actions');
  const overrideEl = $('cockpit-override');
  const debriefEl = $('cockpit-debrief');
  const alertEl = $('cockpit-alert');

  const state = {
    carId: null, // claimed car (null = spectating)
    carName: null,
    mode: 'unclaimed', // unclaimed | autopilot | manual
    action: null, // this window's pending driver action: {kind, key?, label?}
    plan: null, // {lap, source, radio, proposals: [stamped cards]}
    radioLog: [], // [{lap, radio, source}] newest last
    override: { pace: 'normal', aggression: 0, defend: 0, pitNow: 0 },
    windowLap: null, // the window the open cockpit UI belongs to
    phase: null,
    reactive: null, // open reactive window object (for the alert strip)
    claimed: false, // a seat was claimed this race (persists across windows)
  };

  let cardSignature = '';
  let bound = false;
  let lastMsg = null; // newest snapshot (event-driven renders reuse its state)

  // ------------------------------------------------------------ actions

  function claim(carId) {
    if (state.claimed) return;
    send({ type: 'driver_claim', carId });
  }
  function trust() {
    const rec = (state.plan?.proposals ?? []).find((p) => p.recommend);
    if (rec?.key) send({ type: 'lock_in', carId: state.carId, proposalKey: rec.key });
  }
  function lockKey(key) {
    if (key) send({ type: 'lock_in', carId: state.carId, proposalKey: key });
  }
  function sendOverride() {
    const { pace, aggression, defend, pitNow } = state.override;
    send({ type: 'override', carId: state.carId, packet: { pace, aggression, defend, pitNow: pitNow === 1 } });
  }
  function resume() {
    send({ type: 'resume_autopilot', carId: state.carId });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    claimList.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('[data-action="claim"]');
      if (btn && !btn.disabled) claim(Number(btn.dataset.carId));
    });
    cardsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('button[data-action]');
      if (!btn || btn.disabled) return;
      if (btn.dataset.action === 'trust') trust();
      else if (btn.dataset.action === 'lock') lockKey(btn.dataset.key);
    });
    actionsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('[data-action="resume"]');
      if (btn && !btn.disabled) resume();
    });
    overrideEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('button[data-ov]');
      if (btn) {
        const val = btn.dataset.val;
        if (btn.dataset.ov === 'pace') state.override.pace = val;
        else if (btn.dataset.ov === 'aggression') state.override.aggression = Number(val);
        else if (btn.dataset.ov === 'defend') state.override.defend = Number(val);
        else if (btn.dataset.ov === 'pitNow') state.override.pitNow = Number(val);
        syncOverrideButtons();
        return;
      }
      const sendBtn = ev.target.closest?.('[data-action="override-send"]');
      if (sendBtn && !sendBtn.disabled) sendOverride();
    });
  }

  function syncOverrideButtons() {
    for (const btn of overrideEl.querySelectorAll('button[data-ov]')) {
      const cur =
        btn.dataset.ov === 'pace' ? state.override.pace
        : btn.dataset.ov === 'pitNow' ? String(state.override.pitNow)
        : String(state.override[btn.dataset.ov]);
      btn.classList.toggle('on', cur === btn.dataset.val);
    }
  }

  // ------------------------------------------------------------ inbound

  /** A snapshot (10 Hz, self-contained): rehydrate anything the events missed. */
  function onSnapshot(msg) {
    state.phase = msg.phase;
    const inWindow = msg.phase === 'strategy_window';
    state.reactive = msg.phase === 'reactive_window' ? msg.reactiveWindow : null;

    if (state.carId != null) {
      if (!state.carName) {
        state.carName = msg.cars?.find((c) => c.id === state.carId)?.name ?? state.carName;
      }
      const seat = msg.driverSeats?.[state.carId];
      if (seat && seat.mode !== 'unclaimed') state.mode = seat.mode;
      if (inWindow) {
        const plan = msg.tactics?.[state.carId];
        if (plan && plan.lap === msg.currentLap) {
          if (state.windowLap !== plan.lap) {
            // a NEW window: clear this window's pending action + builder seed
            state.windowLap = plan.lap;
            state.action = null;
            state._ovSeeded = false;
          }
          state.plan = { lap: plan.lap, source: plan.source, radio: plan.radio, proposals: plan.proposals };
          if (plan.radio && state._lastRadioLap !== plan.lap) {
            state._lastRadioLap = plan.lap;
            pushRadio(plan.lap, plan.radio, plan.source);
          }
        } else if (state.windowLap != null && state.windowLap !== msg.currentLap) {
          // the window lapped forward and no plan has posted yet
          state.windowLap = msg.currentLap;
          state.action = null;
          state.plan = null;
          state._ovSeeded = false;
        }
      }
    }

    // dehydrate: a rotation (new race) or the finished phase clears the race
    if (msg.phase === 'finished' || msg.phase === 'setup') {
      if (msg.raceId != null && state._raceId !== msg.raceId) {
        // a NEW race (rotation): the seat is per-race
        hardReset();
        state._raceId = msg.raceId;
      }
    }

    render(msg);
  }

  function onTacticsProposed(e) {
    if (state.carId != null && e.carId === state.carId) {
      state.plan = { lap: e.lap, source: e.source, radio: e.radio ?? null, proposals: e.proposals ?? [] };
      if (e.radio) pushRadio(e.lap, e.radio, e.source);
      renderNow();
    }
  }

  function onAutopilotState(e) {
    if (state.carId != null && e.carId === state.carId) {
      state.mode = e.mode;
      state.claimed = true;
      if (e.change === 'lock' || e.change === 'override') {
        state.action = e.change === 'lock'
          ? { kind: 'lock', label: e.label ?? null }
          : { kind: 'override' };
        if (e.change === 'lock') state.action.trusted = e.trusted === true;
      } else if (e.change === 'resume') {
        state.action = null;
      }
      renderNow();
    }
  }

  function onDriverLocked(e) {
    if (state.carId != null && e.carId === state.carId) {
      state.mode = 'manual';
      state.action = { kind: 'lock', key: e.proposalKey, label: e.label, trusted: e.trusted === true };
      pushRadio(e.lap, e.trusted ? `You trust the team: ${e.label}` : `You locked: ${e.label}`, 'driver');
      renderNow();
    }
  }

  function onDriverOverride(e) {
    if (state.carId != null && e.carId === state.carId) {
      state.mode = 'manual';
      state.action = { kind: 'override' };
      pushRadio(e.lap, `You overrode the plan: ${describePacket(e.packet)}`, 'driver');
      renderNow();
    }
  }

  function onResolved(e) {
    // The window closed: the seat state for the NEXT window is the mode.
    const isTrustedAuto = e.type === 'auto_trusted';
    if (state.carId != null && e.carId === state.carId) {
      state.mode = isTrustedAuto ? 'autopilot' : e.mode === 'autopilot' ? 'autopilot' : 'manual';
      state.action = null;
      state.plan = null; // next window's plan will arrive fresh
      renderNow();
    }
  }

  /** Ack from the hub for our own action (identity-level, not broadcast). */
  function onAck(e) {
    if (e.type === 'driver_claim_ack') {
      state.carId = e.carId;
      state.mode = e.mode ?? 'autopilot';
      state.claimed = true;
      state.windowLap = null;
      renderNow();
    } else if (e.type === 'driver_lock_ack') {
      state.mode = 'manual';
      state.action = { kind: 'lock', trusted: e.trusted === true };
      renderNow();
    } else if (e.type === 'driver_override_ack') {
      state.mode = 'manual';
      state.action = { kind: 'override' };
      renderNow();
    } else if (e.type === 'driver_resume_ack') {
      state.mode = 'autopilot';
      state.action = null;
      renderNow();
    } else if (e.type === 'driver_rejected') {
      pushRadio(state.plan?.lap ?? state.windowLap ?? 0, `Seat rejected ${e.action}: ${e.error}`, 'driver');
      renderNow();
    }
  }

  function pushRadio(lap, radio, source) {
    state.radioLog.push({ lap, radio, source });
    if (state.radioLog.length > 4) state.radioLog.shift();
  }

  function hardReset() {
    state.carId = null;
    state.carName = null;
    state.mode = 'unclaimed';
    state.action = null;
    state.plan = null;
    state.radioLog = [];
    state.override = { pace: 'normal', aggression: 0, defend: 0, pitNow: 0 };
    state.windowLap = null;
    state.claimed = false;
    state.reactive = null;
    state._lastRadioLap = undefined;
    state._ovSeeded = false;
    cardSignature = '';
  }

  // ------------------------------------------------------------ render

  function describePacket(p) {
    if (!p) return '—';
    return `pace=${p.pace ?? 'normal'} tires=${p.tireManagement ?? 'normal'} aggro=${p.aggression ?? 0} def=${p.defend ?? 0}${p.pitNow ? ' PIT' : ''}`;
  }

  function recommendedCard() {
    return (state.plan?.proposals ?? []).find((p) => p.recommend) ?? null;
  }

  function chipText() {
    if (!state.claimed || state.carId == null) return 'UNCLAIMED';
    const rec = recommendedCard();
    if (state.mode === 'autopilot') {
      if (!rec) return 'AUTOPILOT · TEAM PLAN PENDING';
      const conf = rec.confidence != null ? ` · ${rec.confidence}%` : '';
      return `AUTOPILOT · ${rec.label}${conf}`;
    }
    if (state.action?.kind === 'lock') return `MANUAL · locked ${state.action.label ?? state.action.key ?? ''}`;
    if (state.action?.kind === 'override') return 'MANUAL · OVERRIDDEN';
    const rec2 = recommendedCard();
    return rec2 ? `MANUAL · ${rec2.label} will run` : 'MANUAL';
  }

  function signature() {
    const p = state.plan;
    const keys = p ? p.proposals.map((x) => x.key ?? 'x').join(',') : '';
    return [
      state.carId, state.mode, state.action?.kind ?? '', state.claimed,
      state.phase, state.windowLap, p?.source ?? '', p?.radio ?? '', keys,
      state.reactive ? String(state.reactive.trigger) : '',
    ].join('|');
  }

  function renderNow() {
    render(lastMsg);
  }

  function render(msg) {
    if (msg) lastMsg = msg;
    else msg = lastMsg;
    bindOnce();
    const inWindow = state.phase === 'strategy_window';
    root.classList.toggle('hidden', state.phase == null);

    // chip + countdown (cheap, every frame)
    chip.textContent = chipText();
    chip.dataset.mode = state.claimed ? state.mode : 'unclaimed';
    countdown.textContent = inWindow && msg?.windowRemainingS != null
      ? `window ${Math.ceil(msg.windowRemainingS)}s`
      : '';

    // the heavy DOM only when something structural changed
    if (signature() !== cardSignature) {
      cardSignature = signature();
      renderStructure(msg);
    }
  }

  function renderStructure(msg) {
    const inWindow = state.phase === 'strategy_window';
    const isDriver = state.claimed && state.carId != null;

    claimBox.classList.toggle('hidden', isDriver);
    panel.classList.toggle('hidden', !isDriver);
    if (!isDriver) {
      renderClaimList(msg, inWindow);
      cardsEl.innerHTML = '';
      actionsEl.innerHTML = '';
      radioFeed.innerHTML = '';
      debriefEl.innerHTML = '';
      overrideEl.classList.add('hidden');
      alertEl.classList.add('hidden');
      return;
    }

    // ---- radio feed
    radioFeed.innerHTML = '';
    for (const r of state.radioLog) {
      const line = document.createElement('div');
      line.className = 'ck-radio-line' + (r.source === 'driver' ? ' driver' : r.source === 'junior' ? ' junior' : '');
      const who = r.source === 'driver' ? 'YOU' : r.source === 'junior' ? `L${r.lap} JUNIOR` : `L${r.lap} TEAM`;
      line.textContent = `${who} — ${r.radio}`;
      radioFeed.appendChild(line);
    }

    // ---- plan cards
    cardsEl.innerHTML = '';
    const proposals = state.plan?.proposals ?? [];
    const contested = proposals.length > 1;
    if (proposals.length === 0) {
      const card = document.createElement('div');
      card.className = 'tactic-card pending';
      card.innerHTML = `<div class="tc-head"><span class="tc-label">TEAM PLAN PENDING</span></div>
        <div class="tc-narrative">Waiting on the team${state.plan?.source === 'junior' ? '' : '… (the junior strategist fills in if nobody posts)'}</div>`;
      cardsEl.appendChild(card);
    } else {
      for (const p of proposals) {
        cardsEl.appendChild(renderCard(p, inWindow, contested));
      }
    }

    // ---- action row: RESUME AUTOPILOT (manual seats) + NO ACTION REQUIRED
    actionsEl.innerHTML = '';
    if (inWindow && !state.action) {
      if (state.mode === 'manual') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ck-btn ck-btn-resume';
        btn.dataset.action = 'resume';
        btn.textContent = 'RESUME AUTOPILOT';
        actionsEl.appendChild(btn);
      }
      if (!contested && state.mode === 'autopilot') {
        const chipEl = document.createElement('span');
        chipEl.className = 'ck-noaction';
        chipEl.textContent = 'NO ACTION REQUIRED — AUTOPILOT IS ON';
        actionsEl.appendChild(chipEl);
      }
    }
    if (state.action) {
      const note = document.createElement('span');
      note.className = 'ck-locked-note';
      note.textContent =
        state.action.kind === 'lock'
          ? `LOCKED: ${state.action.label ?? state.action.key ?? ''} — this is your submission for the lap`
          : 'OVERRIDDEN — your packet is the submission for the lap';
      actionsEl.appendChild(note);
    }

    // ---- override builder: visible when the driver can still act
    overrideEl.classList.toggle('hidden', !(inWindow && !state.action));
    if (inWindow && !state.action) {
      // seed the builder from the recommended plan when it first appears
      const rec = recommendedCard();
      if (rec && !state._ovSeeded) {
        state.override = {
          pace: rec.packet?.pace ?? 'normal',
          aggression: rec.packet?.aggression ?? 0,
          defend: rec.packet?.defend ?? 0,
          pitNow: rec.packet?.pitNow ? 1 : 0,
        };
        state._ovSeeded = true;
      }
      if (!state._ovSeeded) state._ovSeeded = true;
      syncOverrideButtons();
    }

    // ---- reactive alert (display-only in this slice)
    if (state.reactive && state.reactive.carIds?.includes(state.carId)) {
      alertEl.classList.remove('hidden');
      alertEl.textContent = `⚠ REACTIVE: ${String(state.reactive.trigger).replace(/_/g, ' ').toUpperCase()} — team is handling it (${Math.ceil(state.reactive.remainingS ?? 0)}s)`;
    } else {
      alertEl.classList.add('hidden');
    }
  }

  function renderCard(p, inWindow, contested) {
    const card = document.createElement('div');
    card.className = 'tactic-card' + (p.recommend ? ' recommended' : '');
    if (p.key) card.dataset.key = p.key; // test/automation hook
    if (state.action?.kind === 'lock' && state.action.key === p.key) card.classList.add('locked');
    const proj = p.projection ?? {};
    const delta =
      proj.projectedDeltaS == null ? '±0.0s'
      : `${proj.projectedDeltaS > 0 ? '+' : ''}${proj.projectedDeltaS.toFixed(1)}s`;
    const pos = proj.projectedPos != null ? `→ P${proj.projectedPos}` : '';
    const risk = proj.riskTag ? `<span class="ck-risk ${RISK_CLASS[proj.riskTag] ?? ''}">${proj.riskTag.toUpperCase()}</span>` : '';
    const conf = p.confidence != null
      ? `<div class="tc-conf"><div class="tc-conf-fill" style="width:${p.confidence}%"></div><span>${p.confidence}%</span></div>`
      : '';
    card.innerHTML = `
      <div class="tc-head">
        <span class="tc-label"></span>
        ${p.key ? `<span class="tc-key"></span>` : ''}
        ${p.recommend ? '<span class="tc-reco">RECOMMENDED</span>' : ''}
      </div>
      ${p.narrative ? '<div class="tc-narrative"></div>' : ''}
      <div class="tc-meta"><span class="tc-delta">${delta}</span>${pos ? `<span class="tc-pos">${pos}</span>` : ''}${risk}${conf}</div>`;
    card.querySelector('.tc-label').textContent = p.label;
    if (p.key) card.querySelector('.tc-key').textContent = p.key;
    if (p.narrative) card.querySelector('.tc-narrative').textContent = p.narrative;

    if (inWindow && !state.action && contested) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tc-btn' + (p.recommend ? ' tc-btn-trust' : '');
      btn.dataset.action = p.recommend ? 'trust' : 'lock';
      if (!p.recommend) btn.dataset.key = p.key;
      btn.textContent = p.recommend ? 'TRUST THE TEAM — LOCK RECOMMENDATION' : 'LOCK IN';
      card.appendChild(btn);
    } else if (inWindow && !state.action && !contested && p.recommend) {
      // Uncontested: the plan card alone carries the (optional) deliberate trust.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tc-btn tc-btn-trust';
      btn.dataset.action = 'trust';
      btn.textContent = 'TRUST THE TEAM — LOCK RECOMMENDATION';
      card.appendChild(btn);
    }
    return card;
  }

  function renderClaimList(msg, inWindow) {
    claimList.innerHTML = '';
    const cars = msg?.cars ?? [];
    const seats = msg?.driverSeats ?? {};
    for (const car of cars) {
      const row = document.createElement('div');
      row.className = 'ck-claim-row';
      row.dataset.carId = String(car.id); // test/automation hook
      const seat = seats[car.id];
      const taken = seat?.claimed === true;
      row.innerHTML = `
        <span class="ck-dot" style="background:${car.color ?? '#888'}"></span>
        <span class="ck-claim-name"></span>
        <span class="ck-claim-status">${taken ? 'SEAT TAKEN' : 'available'}</span>`;
      row.querySelector('.ck-claim-name').textContent = car.name;
      if (!taken) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ck-btn ck-btn-claim';
        btn.dataset.action = 'claim';
        btn.dataset.carId = String(car.id);
        btn.textContent = 'CLAIM SEAT';
        if (!inWindow) btn.disabled = true;
        row.appendChild(btn);
      }
      claimList.appendChild(row);
    }
    if (!inWindow) {
      const note = document.createElement('div');
      note.className = 'ck-claim-wait';
      note.textContent = 'Seats open during strategy windows (one per lap).';
      claimList.appendChild(note);
    }
  }

  /** The DEBRIEF strip: last decided windows, projection vs outcome. */
  function renderDebrief(dossiers) {
    debriefEl.innerHTML = '';
    const mine = state.carName ? dossiers?.[state.carName] : null;
    if (!mine) return;
    const entries = (mine.windows ?? []).slice(-3).reverse();
    if (entries.length === 0) return;
    for (const w of entries) {
      const line = document.createElement('div');
      line.className = 'ck-deb-line mode-' + (w.mode ?? 'default');
      const chosen = w.chosen?.label ?? w.chosen?.key ?? 'no plan';
      const proj = w.projected
        ? `proj ${w.projected.projectedPos != null ? `P${w.projected.projectedPos}` : '—'}${w.projected.projectedDeltaS != null ? `, ${w.projected.projectedDeltaS > 0 ? '+' : ''}${w.projected.projectedDeltaS.toFixed(1)}s` : ''}`
        : '';
      const act = w.actualAtNextWindow
        ? `→ actual P${w.actualAtNextWindow.position}${w.actualAtNextWindow.gapToLeaderM != null ? ` (+${Math.round(w.actualAtNextWindow.gapToLeaderM)}m)` : ''}`
        : '';
      line.textContent = `L${w.lap} ${String(w.mode ?? 'default').toUpperCase()} — ${chosen} (${proj}) ${act}`.replace(/\s+/g, ' ').trim();
      debriefEl.appendChild(line);
    }
  }

  // ------------------------------------------------------------ wiring

  return {
    /** main.js calls this per snapshot; `dossiers` is the current race's. */
    onSnapshot: (msg) => {
      onSnapshot(msg);
      renderDebrief(msg.dossiers ?? null);
    },
    onTacticsProposed,
    onAutopilotState,
    onDriverLocked,
    onDriverOverride,
    onResolved,
    onAck,
    /** Called by main.js on race rotation. */
    reset: hardReset,
    /** The claim ack carries the carId; main.js also records the name. */
    setCarName: (name) => { state.carName = name; },
    get: () => ({ ...state, override: { ...state.override } }),
  };
}