/**
 * /features page renderer (MCPG-35).
 *
 * Loads `client/features.json` (one hand-edited file in the repo — the
 * changelog record) and renders entries newest-first. The file is fetched
 * relative to the page's own location (`/features/` -> `/features.json`),
 * which resolves on both deploy shapes: the game server (staticFiles.js)
 * and the standalone :8080 client service (staticServe.js).
 *
 * No framework, no build step; a missing or invalid file renders a
 * friendly "no changelog yet" state instead of a broken page.
 */

// Opening the page marks the changelog as seen so the spectator's "NEW"
// badge (featuresBadge.js) goes quiet. Same relative path the badge uses.
const FEATURES_URL = new URL('../features.json', window.location.href).href;
const SEEN_KEY = 'mgp-features-seen';

function markSeen(maxId) {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const seen = raw === null ? 0 : Number.parseInt(raw, 10) || 0;
    if (maxId > seen) localStorage.setItem(SEEN_KEY, String(maxId));
  } catch {
    // storage unavailable — badge will keep showing; harmless
  }
}

function renderEntries(entries) {
  const list = document.getElementById('feat-list');
  list.textContent = '';
  for (const e of entries) {
    const entry = document.createElement('div');
    entry.className = 'feat-entry';

    const head = document.createElement('div');
    head.className = 'feat-entry-head';
    const date = document.createElement('span');
    date.className = 'feat-date';
    date.textContent = e.date ?? '';
    const title = document.createElement('span');
    title.className = 'feat-entry-title';
    title.textContent = e.title ?? 'Untitled';
    head.append(date, title);
    entry.appendChild(head);

    if (Array.isArray(e.notes) && e.notes.length) {
      const ul = document.createElement('ul');
      for (const note of e.notes) {
        const li = document.createElement('li');
        li.textContent = note;
        ul.appendChild(li);
      }
      entry.appendChild(ul);
    }
    list.appendChild(entry);
  }
}

function renderEmpty(reason) {
  const list = document.getElementById('feat-list');
  list.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'feat-empty';
  empty.textContent = reason || 'No changelog yet — check back after the next slice ships.';
  list.appendChild(empty);
}

function maxIdOf(entries) {
  let max = 0;
  for (const e of entries) {
    const id = Number(e?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

async function initFeaturesPage() {
  // Optional deploy-SHA footer: deploy.sh stamps client/build-info.json on
  // the VPS before building; when absent the line is simply omitted.
  try {
    const res = await fetch(FEATURES_URL, { cache: 'no-cache' });
    if (!res.ok) {
      renderEmpty();
      return;
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      renderEmpty();
      return;
    }
    const entries = [...data].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    renderEntries(entries);
    markSeen(maxIdOf(entries));
  } catch {
    renderEmpty();
  }

  try {
    const res = await fetch(new URL('../build-info.json', window.location.href).href, { cache: 'no-cache' });
    if (res.ok) {
      const info = await res.json();
      if (info && info.sha) {
        const footer = document.getElementById('feat-footer');
        footer.textContent = `build ${String(info.sha).slice(0, 7)}`;
      }
    }
  } catch {
    // no build-info.json — leave the footer empty
  }
}

initFeaturesPage();
