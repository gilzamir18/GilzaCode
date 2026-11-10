import test from 'node:test';
import assert from 'node:assert/strict';

import { UNAVAILABLE, availabilityFromSettings } from '../featureAvailability.js';

test('a feature that is on and working is both offered and ready', () => {
  const a = availabilityFromSettings({ enabled: true, problem: '' });

  assert.deepEqual(a, { ready: true, offered: true, problem: '' });
});

test('enabled but not working is still offered — this is the regression', () => {
  // The defect: collapsing these two into one boolean made the chat's
  // microphone disappear when the user ticked the box before the model had
  // finished downloading, so the setting looked like it did nothing. The
  // control must exist and carry its reason.
  const a = availabilityFromSettings({
    enabled: true,
    problem: "The 'small' transcription model is not downloaded yet (about 486 MB).",
  });

  assert.equal(a.offered, true);
  assert.equal(a.ready, false);
  assert.match(a.problem, /486 MB/);
});

test('turned off in settings is not offered at all', () => {
  const a = availabilityFromSettings({
    enabled: false,
    problem: 'Dictation is disabled. Enable it in Settings > General > Dictation.',
  });

  assert.equal(a.offered, false);
  assert.equal(a.ready, false);
});

test('a backend that cannot be reached offers nothing', () => {
  // Not evidence that the user asked for anything, so `offered` stays false
  // rather than showing a control nothing can service.
  for (const value of [null, undefined, '', 0, 'nope']) {
    assert.deepEqual(availabilityFromSettings(value), { ...UNAVAILABLE });
  }
});

test('a missing problem field reads as ready, not as broken', () => {
  // The endpoints omit `problem` only when there is none.
  const a = availabilityFromSettings({ enabled: true });

  assert.equal(a.ready, true);
  assert.equal(a.problem, '');
});

test('the problem is always a string, whatever the backend sent', () => {
  // It is rendered into a tooltip; an object there would read as [object Object].
  assert.equal(typeof availabilityFromSettings({ enabled: true, problem: null }).problem, 'string');
  assert.equal(typeof availabilityFromSettings({ enabled: true, problem: 42 }).problem, 'string');
});

test('the shared fallback cannot be mutated by one caller', () => {
  assert.throws(() => { UNAVAILABLE.ready = true; }, TypeError);
});
