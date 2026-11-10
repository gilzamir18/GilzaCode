// Interface preferences (theme, editor font, chat zoom, window positions, ...).
//
// They are owned by the backend (`client_prefs` in ui_settings.json), not by
// localStorage. localStorage is partitioned by origin, and the origin carries
// the local server's port: a launch that lands on 3001 instead of 3000 used to
// come up with another port's older copy of every preference.
//
// Components read synchronously, as they did from localStorage, from a cache
// that `hydratePreferences` fills before the app mounts. Values are strings,
// with localStorage's semantics: whatever is written is stored as String(value).
// Writes update the cache at once and reach the backend in small batches; a
// batch still pending when the window goes away is sent with `keepalive`.

const ENDPOINT = '/api/settings/client-prefs';
const FLUSH_DELAY_MS = 200;

const cache = new Map();
let pending = new Map(); // key -> string (set) | null (remove)
let flushTimer = null;
let fetcher = (...args) => fetch(...args);

const legacyLocalStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch (_) {
    return null;
  }
};

const readLegacyEntries = (storage) => {
  const entries = {};
  if (!storage) return entries;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) continue;
      const value = storage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  } catch (_) {
    // Storage the webview refuses to read has nothing to import.
  }
  return entries;
};

async function postChanges(body, init = {}) {
  const res = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    ...init,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Load the stored preferences into the cache. Must complete before the app
 * mounts. The first window ever to run this also imports its old localStorage
 * once (the backend ignores the import if another window already did it).
 */
export async function hydratePreferences({ fetchImpl, legacyStorage = legacyLocalStorage() } = {}) {
  if (fetchImpl) fetcher = fetchImpl;
  const res = await fetcher(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the interface preferences (HTTP ${res.status}).`);
  let data = await res.json();
  if (!data.imported) {
    const legacy = readLegacyEntries(legacyStorage);
    await postChanges({ set: legacy, legacy_import: true });
    const reread = await fetcher(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
    if (!reread.ok) throw new Error(`Could not load the interface preferences (HTTP ${reread.status}).`);
    data = await reread.json();
  }
  cache.clear();
  for (const [key, value] of Object.entries(data.prefs || {})) {
    if (typeof value === 'string') cache.set(key, value);
  }
}

/** Send the pending batch now. `keepalive` lets it outlive the page. */
export function flushPreferences({ keepalive = false } = {}) {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.size === 0) return Promise.resolve();
  const batch = pending;
  pending = new Map();
  const set = {};
  const remove = [];
  for (const [key, value] of batch) {
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  return postChanges({ set, remove }, keepalive ? { keepalive: true } : {}).catch((err) => {
    // Keep the failed changes for the next batch unless they were superseded.
    for (const [key, value] of batch) {
      if (!pending.has(key)) pending.set(key, value);
    }
    console.error(`Could not save interface preferences: ${err.message}`);
  });
}

const scheduleFlush = () => {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => { flushPreferences(); }, FLUSH_DELAY_MS);
};

export const getPreference = (key, defaultValue = null) =>
  (cache.has(key) ? cache.get(key) : defaultValue);

export const setPreference = (key, value) => {
  const stored = String(value);
  cache.set(key, stored);
  pending.set(key, stored);
  scheduleFlush();
};

export const removePreference = (key) => {
  cache.delete(key);
  pending.set(key, null);
  scheduleFlush();
};

/** A Storage-shaped view of the preferences, for code that takes a `storage`. */
export const preferenceStorage = {
  getItem: (key) => getPreference(key, null),
  setItem: (key, value) => setPreference(key, value),
  removeItem: (key) => removePreference(key),
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { flushPreferences({ keepalive: true }); });
}

/** Test seam: forget all state. */
export function resetPreferencesForTests() {
  clearTimeout(flushTimer);
  flushTimer = null;
  cache.clear();
  pending = new Map();
  fetcher = (...args) => fetch(...args);
}
