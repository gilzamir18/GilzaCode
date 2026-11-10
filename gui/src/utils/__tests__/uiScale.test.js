import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_PRESETS,
  UI_SCALE_STEP,
  clampUiScale,
  presetForScale,
  roundUiScale,
  readUiScale,
  viewportPointToApp,
  viewportPxToApp,
} from '../uiScale.js';

test('clamps a scale into the supported range', () => {
  assert.equal(clampUiScale(5), UI_SCALE_MAX);
  assert.equal(clampUiScale(0.1), UI_SCALE_MIN);
  assert.equal(clampUiScale(1.25), 1.25);
});

test('falls back to the default rather than shrinking on an unusable value', () => {
  // A corrupted or missing setting must not leave the interface unreadable.
  for (const value of ['not a number', NaN, Infinity, -Infinity, undefined, null, '']) {
    assert.equal(clampUiScale(value), UI_SCALE_DEFAULT, `for ${String(value)}`);
  }
});

test('an explicit zero is a number, and clamps rather than defaulting', () => {
  assert.equal(clampUiScale(0), UI_SCALE_MIN);
});

test('rounds to the fine-tuning step without float drift', () => {
  // 24 * 0.05 is 1.2000000000000002 in IEEE 754; the stored value must be 1.2.
  assert.equal(roundUiScale(1.2000000000000002), 1.2);
  assert.equal(roundUiScale(1.37), 1.35);
  assert.equal(roundUiScale(1.38), 1.4);
});

test('every preset survives a round-trip through rounding', () => {
  for (const preset of UI_SCALE_PRESETS) {
    assert.equal(roundUiScale(preset.scale), preset.scale, preset.id);
    assert.equal(presetForScale(preset.scale)?.id, preset.id);
  }
});

test('presets sit inside the supported range and Medium is unscaled', () => {
  assert.equal(presetForScale(UI_SCALE_DEFAULT)?.id, 'medium');
  for (const preset of UI_SCALE_PRESETS) {
    assert.ok(preset.scale >= UI_SCALE_MIN && preset.scale <= UI_SCALE_MAX, preset.id);
  }
});

test('a value between steps matches no preset', () => {
  assert.equal(presetForScale(1.1), null);
  assert.equal(presetForScale(UI_SCALE_DEFAULT + UI_SCALE_STEP), null);
});

test('presets are ordered and distinct', () => {
  const scales = UI_SCALE_PRESETS.map((p) => p.scale);
  assert.deepEqual(scales, [...scales].sort((a, b) => a - b));
  assert.equal(new Set(scales).size, scales.length);
});

// ── Crossing the zoom boundary ────────────────────────────────────────────
// Regression cover for the context menu that opened near the bottom of the
// window when it was invoked at the top of the file tree: event coordinates are
// viewport pixels, but `left`/`top` inside the zoomed app are multiplied by the
// scale before they are painted.

test('a pointer position becomes a CSS length inside the zoomed app', () => {
  // A click that Chrome reports at (560, 420) sits at CSS (400, 300) when the
  // interface is scaled to 140% — measured against a real rendered page.
  assert.deepEqual(viewportPointToApp(560, 420, 1.4), { x: 400, y: 300 });
  assert.equal(viewportPxToApp(140, 1.4), 100);
});

test('conversion is the identity at the default scale', () => {
  assert.deepEqual(viewportPointToApp(560, 420, 1), { x: 560, y: 420 });
  assert.equal(viewportPxToApp(37, 1), 37);
});

test('converting round-trips against the scale that produced it', () => {
  for (const preset of UI_SCALE_PRESETS) {
    const { x, y } = viewportPointToApp(800 * preset.scale, 600 * preset.scale, preset.scale);
    assert.ok(Math.abs(x - 800) < 1e-9, preset.id);
    assert.ok(Math.abs(y - 600) < 1e-9, preset.id);
  }
});

test('readUiScale falls back to the default without a document', () => {
  // Node has no DOM; the helper must not throw when imported outside a browser.
  assert.equal(readUiScale(), UI_SCALE_DEFAULT);
});
