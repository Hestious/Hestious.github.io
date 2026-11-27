/* Owner-only navigation is a display preference, never an authorization check.
 * GitHub authenticates and authorizes every write in the publishing interface.
 * This marker contains no credential and expires after eight hours.
 */
(() => {
  const key = 'research-owner-ui';
  const maxAge = 8 * 60 * 60 * 1000;
  let expiryTimer;

  function ownerSession() {
    try {
      const marker = JSON.parse(sessionStorage.getItem(key) || 'null');
      const age = Date.now() - marker?.verifiedAt;
      return marker?.login === 'Hestious' && Number.isFinite(marker.verifiedAt)
        && age >= 0 && age < maxAge ? marker : null;
    } catch {
      return null;
    }
  }

  function updateOwnerUI() {
    const marker = ownerSession();
    document.querySelectorAll('[data-owner-only]').forEach(node => { node.hidden = !marker; });
    document.querySelectorAll('[data-owner-guest]').forEach(node => { node.hidden = !!marker; });
    clearTimeout(expiryTimer);
    if (marker) expiryTimer = setTimeout(updateOwnerUI, Math.max(1, marker.verifiedAt + maxAge - Date.now()));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateOwnerUI, { once: true });
  else updateOwnerUI();
  window.addEventListener('research-owner-ui-change', updateOwnerUI);
  window.addEventListener('pageshow', updateOwnerUI);
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) updateOwnerUI(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateOwnerUI(); });
})();
