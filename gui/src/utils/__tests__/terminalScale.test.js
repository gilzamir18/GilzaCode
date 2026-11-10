import test from 'node:test';
import assert from 'node:assert/strict';

import { terminalRenderFontSize } from '../terminalScale.js';

test('terminal font size compensates for the inverse xterm zoom boundary', () => {
  assert.equal(terminalRenderFontSize(13, 1), 13);
  assert.equal(terminalRenderFontSize(13, 1.4), 18.2);
  assert.equal(terminalRenderFontSize(13, 0.8), 10.4);
});

test('terminal font-size compensation ignores an invalid interface scale', () => {
  assert.equal(terminalRenderFontSize(13, 0), 13);
  assert.equal(terminalRenderFontSize(13, Number.NaN), 13);
});
