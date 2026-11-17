import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalPasteKey } from '../terminalKeys.js';

const key = (overrides) => ({ type: 'keydown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  key: 'v', code: 'KeyV', ...overrides });

test('Ctrl+V and Ctrl+Shift+V paste instead of sending ^V', () => {
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true })), true);
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true, shiftKey: true, key: 'V' })), true);
  // The physical key counts, whatever character the layout gives it.
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true, key: 'ж' })), true);
});

test('other keys and Alt+V (Claude Code\'s image paste on Windows) go to the program', () => {
  assert.equal(isTerminalPasteKey(key({})), false);
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true, altKey: true })), false);
  assert.equal(isTerminalPasteKey(key({ altKey: true })), false);
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true, key: 'c', code: 'KeyC' })), false);
  assert.equal(isTerminalPasteKey(key({ ctrlKey: true, type: 'keyup' })), false);
});
