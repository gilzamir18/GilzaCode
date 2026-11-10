import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPresentationAction,
  clampPresentationIndex,
  fitScale,
  presentationClickAction,
  presentationKeyAction,
} from '../presentationNavigation.js';

test('maps the keys a presenter and a clicker send', () => {
  // Clickers send PageDown/PageUp; keyboards use arrows, space and Enter.
  for (const key of ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']) {
    assert.equal(presentationKeyAction(key), 'next', key);
  }
  for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']) {
    assert.equal(presentationKeyAction(key), 'previous', key);
  }
  assert.equal(presentationKeyAction('Home'), 'first');
  assert.equal(presentationKeyAction('End'), 'last');
  assert.equal(presentationKeyAction('Escape'), 'exit');
});

test('leaves every other key alone, including inherited object keys', () => {
  for (const key of ['a', 'Tab', 'F5', 'Shift', 'toString', 'constructor', '', undefined]) {
    assert.equal(presentationKeyAction(key), null, String(key));
  }
});

test('a click on the left third goes back and anywhere else advances', () => {
  assert.equal(presentationClickAction(0, 1200), 'previous');
  assert.equal(presentationClickAction(395, 1200), 'previous');
  assert.equal(presentationClickAction(396, 1200), 'next');
  assert.equal(presentationClickAction(1199, 1200), 'next');
});

test('a click with no measurable viewport advances rather than dividing by zero', () => {
  assert.equal(presentationClickAction(10, 0), 'next');
});

test('steps stop at both ends instead of wrapping', () => {
  assert.equal(applyPresentationAction(0, 'previous', 5), 0);
  assert.equal(applyPresentationAction(4, 'next', 5), 4);
  assert.equal(applyPresentationAction(2, 'next', 5), 3);
  assert.equal(applyPresentationAction(2, 'previous', 5), 1);
  assert.equal(applyPresentationAction(2, 'first', 5), 0);
  assert.equal(applyPresentationAction(2, 'last', 5), 4);
  assert.equal(applyPresentationAction(2, 'exit', 5), 2);
  assert.equal(applyPresentationAction(2, null, 5), 2);
});

test('a document that shrank while presenting steps from its new last page', () => {
  // A recompile can drop pages under a presenter standing on page 10 of 10.
  assert.equal(applyPresentationAction(9, 'previous', 6), 4);
  assert.equal(applyPresentationAction(9, 'next', 6), 5);
});

test('the requested page survives until the page count is known', () => {
  assert.equal(clampPresentationIndex(11, 0), 11);
  assert.equal(applyPresentationAction(11, 'next', 0), 11);
  assert.equal(clampPresentationIndex(11, 20), 11);
  assert.equal(clampPresentationIndex(11, 8), 7);
});

test('an unusable index clamps to the first page', () => {
  for (const value of [-3, NaN, undefined, null, 'x']) {
    assert.equal(clampPresentationIndex(value, 5), 0, String(value));
  }
  assert.equal(clampPresentationIndex(2.7, 5), 2);
});

test('fits content to the tighter of the two dimensions', () => {
  // A 4:3 Beamer page on a 16:9 screen is limited by height.
  assert.equal(fitScale(364, 273, 1920, 1080), 1080 / 273);
  // A portrait A4 page on the same screen is limited by height too.
  assert.equal(fitScale(595, 842, 1920, 1080), 1080 / 842);
  // A very wide page is limited by width.
  assert.equal(fitScale(2000, 500, 1920, 1080), 1920 / 2000);
});

test('fitting reports nothing to draw for unusable sizes', () => {
  assert.equal(fitScale(0, 100, 800, 600), 0);
  assert.equal(fitScale(100, 100, 0, 600), 0);
  assert.equal(fitScale(NaN, 100, 800, 600), 0);
  assert.equal(fitScale(100, undefined, 800, 600), 0);
});
