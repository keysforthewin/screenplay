// Keeping the downloaded model for good.
//
// transformers.js stores the weights in the Cache API. Those entries have no
// expiry — but by default an origin's storage is "best effort": the browser
// may evict ALL of it (Chrome: least-recently-used origins first when the disk
// runs low; Safari: after 7 days without a visit), and then the next Play
// downloads 326MB again. The only switch that exempts an origin is
// navigator.storage.persist().
//
// Chrome never prompts for it: it grants silently when the site is bookmarked,
// installed, highly engaged, or holds the notifications permission — and
// silently refuses otherwise. So pinStorage() asks, and if refused, asks for
// the notifications permission (the one criterion a page can trigger itself)
// and asks again. Firefox shows its own persist prompt on the first ask.
//
// Must run on the main thread: persist() is not exposed to workers.

export async function isStoragePersisted() {
  try {
    return !!(await navigator.storage?.persisted?.());
  } catch {
    return false;
  }
}

// Quiet attempt — no prompts in Chrome. Safe to call on every Play.
export async function requestPersist() {
  try {
    return !!(await navigator.storage?.persist?.());
  } catch {
    return false;
  }
}

// Explicit user action ("Keep model"): may show a permission prompt.
export async function pinStorage() {
  if (await requestPersist()) return true;
  try {
    if (globalThis.Notification && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch { /* unsupported */ }
  return requestPersist();
}
