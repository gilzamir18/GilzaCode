import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_BAR_DENSITIES,
  ACTIVITY_BAR_DEFAULT_DENSITY,
  ACTIVITY_BAR_MIN_DENSITY,
  activityBarContentHeight,
  getActivityBarDensity,
  pickActivityBarDensity,
} from '../activityBarDensity.js';

// The bar as it ships today: nine mode/view buttons over five utility ones.
const COUNTS = { top: 9, bottom: 5 };

test('keeps the comfortable tier while the buttons fit', () => {
  const needed = activityBarContentHeight(ACTIVITY_BAR_DEFAULT_DENSITY, COUNTS);
  assert.equal(pickActivityBarDensity(needed, COUNTS), ACTIVITY_BAR_DEFAULT_DENSITY);
  assert.equal(pickActivityBarDensity(needed + 200, COUNTS), ACTIVITY_BAR_DEFAULT_DENSITY);
});

test('steps down one tier as soon as the column no longer fits', () => {
  const needed = activityBarContentHeight(ACTIVITY_BAR_DEFAULT_DENSITY, COUNTS);
  const picked = pickActivityBarDensity(needed - 1, COUNTS);
  assert.equal(picked, ACTIVITY_BAR_DENSITIES[1]);
  assert.ok(activityBarContentHeight(picked, COUNTS) <= needed - 1);
});

test('every tier is strictly tighter than the one before it', () => {
  for (let i = 1; i < ACTIVITY_BAR_DENSITIES.length; i += 1) {
    const previous = activityBarContentHeight(ACTIVITY_BAR_DENSITIES[i - 1], COUNTS);
    const current = activityBarContentHeight(ACTIVITY_BAR_DENSITIES[i], COUNTS);
    assert.ok(current < previous, `${ACTIVITY_BAR_DENSITIES[i].name} must be tighter`);
  }
});

test('picks the tier that fits for a given height, never a looser one', () => {
  for (let height = 100; height <= 900; height += 7) {
    const picked = pickActivityBarDensity(height, COUNTS);
    const fits = activityBarContentHeight(picked, COUNTS) <= height;
    assert.ok(fits || picked === ACTIVITY_BAR_MIN_DENSITY, `height ${height}`);
    const looser = ACTIVITY_BAR_DENSITIES.slice(0, ACTIVITY_BAR_DENSITIES.indexOf(picked));
    for (const tier of looser) {
      assert.ok(activityBarContentHeight(tier, COUNTS) > height, `height ${height} skipped ${tier.name}`);
    }
  }
});

test('bottoms out at the densest tier instead of shrinking without limit', () => {
  assert.equal(pickActivityBarDensity(10, COUNTS), ACTIVITY_BAR_MIN_DENSITY);
  assert.equal(pickActivityBarDensity(1, COUNTS), ACTIVITY_BAR_MIN_DENSITY);
});

test('renders at full size until the bar has actually been measured', () => {
  for (const value of [0, -50, NaN, Infinity, undefined, null, 'tall', {}]) {
    assert.equal(pickActivityBarDensity(value, COUNTS), ACTIVITY_BAR_DEFAULT_DENSITY, `height ${String(value)}`);
  }
});

test('an added button raises the height the tier needs', () => {
  const before = activityBarContentHeight(ACTIVITY_BAR_DEFAULT_DENSITY, COUNTS);
  const after = activityBarContentHeight(ACTIVITY_BAR_DEFAULT_DENSITY, { top: 10, bottom: 5 });
  assert.ok(after > before);
  assert.equal(activityBarContentHeight(ACTIVITY_BAR_DEFAULT_DENSITY, {}), 2 * ACTIVITY_BAR_DEFAULT_DENSITY.paddingY);
});

test('an unknown or missing tier name falls back to the comfortable one', () => {
  assert.equal(getActivityBarDensity('dense'), ACTIVITY_BAR_MIN_DENSITY);
  assert.equal(getActivityBarDensity('gigantic'), ACTIVITY_BAR_DEFAULT_DENSITY);
  assert.equal(getActivityBarDensity(undefined), ACTIVITY_BAR_DEFAULT_DENSITY);
});
