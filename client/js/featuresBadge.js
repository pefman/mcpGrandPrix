/**
 * "NEW" badge for the spectator HUD (MCPG-35).
 *
 * Shows when the changelog (client/features.json, see /features) has entries
 * newer than what this browser has seen: max content `id` > the number
 * stored in localStorage['mgp-features-seen']. No stored value = badge
 * shows, so first-time visitors discover the page. Clicking opens /features
 * in a NEW tab — never steal the live-race tab.
 *
 * Self-contained module: own DOM node, one init on load, zero touch to the
 * race loop or ui.js snapshot flow. /features writes the seen-id when it is
 * opened, which hides the badge next time.
 */

const SEEN_KEY = 'mgp-features-seen';

function maxIdOf(entries) {
  let max = 0;
  for (const e of entries) {
    const id = Number(e?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

export function initFeaturesBadge() {
  let seen;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    seen = raw === null ? 0 : Number.parseInt(raw, 10);
    if (!Number.isFinite(seen)) seen = 0;
  } catch {
    return; // storage unavailable (private mode edge cases) — no badge
  }

  fetch(new URL('../features.json', window.location.href).href, { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((entries) => {
      if (!Array.isArray(entries) || !entries.length) return;
      const maxId = maxIdOf(entries);
      if (maxId <= seen) return;

      const badge = document.createElement('a');
      badge.id = 'features-badge';
      badge.href = '/features/';
      badge.target = '_blank';
      badge.rel = 'noopener';
      const fresh = maxId - seen;
      badge.textContent = fresh > 1 ? `NEW \u00d7${fresh}` : "WHAT'S NEW";
      document.body.appendChild(badge);
    })
    .catch(() => {}); // badge is decorative — never break the spectator
}
