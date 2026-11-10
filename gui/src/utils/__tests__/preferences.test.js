import test from 'node:test';
import assert from 'node:assert/strict';

import {
  flushPreferences,
  getPreference,
  hydratePreferences,
  preferenceStorage,
  removePreference,
  resetPreferencesForTests,
  setPreference,
} from '../preferences.js';

// A stand-in for the backend's /api/settings/client-prefs, with its semantics.
const fakeBackend = (initial = {}, { imported = true } = {}) => {
  const state = { prefs: { ...initial }, imported, posts: [] };
  const fetchImpl = async (url, init = {}) => {
    assert.equal(url, '/api/settings/client-prefs');
    if ((init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ prefs: { ...state.prefs }, imported: state.imported }) };
    }
    const body = JSON.parse(init.body);
    state.posts.push({ body, keepalive: Boolean(init.keepalive) });
    if (body.legacy_import) {
      if (!state.imported) {
        for (const [k, v] of Object.entries(body.set)) {
          if (k !== 'lastActiveProject' && !(k in state.prefs)) state.prefs[k] = v;
        }
        state.imported = true;
      }
    } else {
      Object.assign(state.prefs, body.set);
      for (const k of body.remove) delete state.prefs[k];
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  return { state, fetchImpl };
};

const memoryStorage = (entries) => {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i) => keys[i] ?? null, getItem: (k) => entries[k] ?? null };
};

test('hydration loads the stored preferences for synchronous reads', async () => {
  resetPreferencesForTests();
  const { fetchImpl } = fakeBackend({ theme: 'light', editorFontSize: '15' });
  await hydratePreferences({ fetchImpl, legacyStorage: null });
  assert.equal(getPreference('theme', 'dark'), 'light');
  assert.equal(getPreference('editorFontSize'), '15');
  assert.equal(getPreference('missing', 'fallback'), 'fallback');
  assert.equal(preferenceStorage.getItem('missing'), null);
});

test('the first hydration imports the old localStorage once, never overwriting', async () => {
  resetPreferencesForTests();
  const { state, fetchImpl } = fakeBackend({ theme: 'dark' }, { imported: false });
  const legacy = memoryStorage({ theme: 'light', chatZoom: '1.3', lastActiveProject: 'paper' });
  await hydratePreferences({ fetchImpl, legacyStorage: legacy });
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].body.legacy_import, true);
  assert.equal(getPreference('theme'), 'dark');
  assert.equal(getPreference('chatZoom'), '1.3');

  // Already imported: a later window posts nothing.
  await hydratePreferences({ fetchImpl, legacyStorage: memoryStorage({ chatZoom: '2' }) });
  assert.equal(state.posts.length, 1);
  assert.equal(getPreference('chatZoom'), '1.3');
});

test('writes are visible at once and reach the backend as one batch', async () => {
  resetPreferencesForTests();
  const { state, fetchImpl } = fakeBackend({ theme: 'dark', stale: 'x' });
  await hydratePreferences({ fetchImpl, legacyStorage: null });

  setPreference('editorFontSize', 14);
  setPreference('editorFontSize', 16);
  setPreference('chatHideThink', true);
  removePreference('stale');
  // localStorage semantics: values are stored as strings.
  assert.equal(getPreference('editorFontSize'), '16');
  assert.equal(getPreference('chatHideThink'), 'true');
  assert.equal(getPreference('stale'), null);

  await flushPreferences();
  assert.equal(state.posts.length, 1);
  assert.deepEqual(state.posts[0].body, { set: { editorFontSize: '16', chatHideThink: 'true' }, remove: ['stale'] });
  assert.deepEqual(state.prefs, { theme: 'dark', editorFontSize: '16', chatHideThink: 'true' });

  await flushPreferences();
  assert.equal(state.posts.length, 1, 'nothing pending, nothing sent');
});

test('a batch that fails is kept for the next one', async () => {
  resetPreferencesForTests();
  const { state, fetchImpl } = fakeBackend();
  let fail = true;
  const flaky = async (url, init) => (fail && init?.method === 'POST'
    ? { ok: false, status: 500, json: async () => ({}) }
    : fetchImpl(url, init));
  await hydratePreferences({ fetchImpl: flaky, legacyStorage: null });

  const originalError = console.error;
  console.error = () => {};
  try {
    setPreference('theme', 'light');
    await flushPreferences();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(state.prefs, {});

  fail = false;
  setPreference('chatZoom', '1.1');
  await flushPreferences({ keepalive: true });
  assert.deepEqual(state.prefs, { theme: 'light', chatZoom: '1.1' });
  assert.equal(state.posts.at(-1).keepalive, true);
});

test('hydration fails loudly when the backend refuses', async () => {
  resetPreferencesForTests();
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(hydratePreferences({ fetchImpl, legacyStorage: null }), /HTTP 403/);
});
