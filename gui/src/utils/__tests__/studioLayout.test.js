import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STUDIO_BOTTOM_HEIGHT_DEFAULT,
  STUDIO_BOTTOM_HEIGHT_MAX_RATIO,
  STUDIO_BOTTOM_HEIGHT_MIN,
  STUDIO_CHAT_WIDTH_DEFAULT,
  STUDIO_CHAT_WIDTH_MAX,
  STUDIO_CHAT_WIDTH_MIN,
  STUDIO_SPLITTER_PX,
  clampStudioBottomHeight,
  clampStudioChatWidth,
  studioGridTemplate,
} from '../studioLayout.js';

test('clamps the chat column into a range that leaves both cells usable', () => {
  assert.equal(clampStudioChatWidth(10), STUDIO_CHAT_WIDTH_MIN);
  assert.equal(clampStudioChatWidth(9000), STUDIO_CHAT_WIDTH_MAX);
  assert.equal(clampStudioChatWidth(520), 520);
});

test('falls back to the defaults rather than collapsing on an unusable size', () => {
  for (const value of ['not a number', NaN, Infinity, undefined, null, {}]) {
    assert.equal(clampStudioChatWidth(value), STUDIO_CHAT_WIDTH_DEFAULT, `chat width for ${String(value)}`);
    assert.equal(clampStudioBottomHeight(value, 1000), STUDIO_BOTTOM_HEIGHT_DEFAULT, `bottom height for ${String(value)}`);
  }
});

test('caps the bottom row against the window rather than a fixed pixel count', () => {
  assert.equal(clampStudioBottomHeight(5000, 1000), 1000 * STUDIO_BOTTOM_HEIGHT_MAX_RATIO);
  assert.equal(clampStudioBottomHeight(5000, 2000), 2000 * STUDIO_BOTTOM_HEIGHT_MAX_RATIO);
  assert.equal(clampStudioBottomHeight(10, 1000), STUDIO_BOTTOM_HEIGHT_MIN);
});

test('enforces only the floor before the window has been measured', () => {
  // A drag that starts before a height is known must still work.
  assert.equal(clampStudioBottomHeight(5000, 0), 5000);
  assert.equal(clampStudioBottomHeight(5000, undefined), 5000);
  assert.equal(clampStudioBottomHeight(10, 0), STUDIO_BOTTOM_HEIGHT_MIN);
});

test('never lets the window cap push the row below its floor', () => {
  // A window shorter than the floor would otherwise invert the clamp range.
  assert.equal(clampStudioBottomHeight(300, 100), STUDIO_BOTTOM_HEIGHT_MIN);
});

test('lays the four surfaces out as editor over chat and terminal', () => {
  const grid = studioGridTemplate({ chatWidth: 500, bottomHeight: 280 });
  assert.equal(grid.gridTemplateColumns, `500px ${STUDIO_SPLITTER_PX}px minmax(0, 1fr)`);
  assert.equal(grid.gridTemplateRows, `minmax(0, 1fr) ${STUDIO_SPLITTER_PX}px 280px`);
  assert.equal(grid.showRowResizer, true);
  assert.equal(grid.showColumnResizer, true);
});

test('gives the bottom row to whichever of chat and terminal is left', () => {
  const withoutTerminal = studioGridTemplate({ isTerminalVisible: false });
  assert.equal(withoutTerminal.gridTemplateColumns, 'minmax(0, 1fr) 0px 0px');
  assert.equal(withoutTerminal.showColumnResizer, false);
  assert.equal(withoutTerminal.showRowResizer, true);

  const withoutChat = studioGridTemplate({ isChatVisible: false });
  assert.equal(withoutChat.gridTemplateColumns, '0px 0px minmax(0, 1fr)');
  assert.equal(withoutChat.showColumnResizer, false);
  assert.equal(withoutChat.showRowResizer, true);
});

test('drops the bottom row when it is empty, and offers no handle for it', () => {
  const grid = studioGridTemplate({ isChatVisible: false, isTerminalVisible: false });
  assert.equal(grid.gridTemplateRows, 'minmax(0, 1fr) 0px 0px');
  assert.equal(grid.showRowResizer, false);
  assert.equal(grid.showColumnResizer, false);
});

test('a maximized editor hides the bottom row without discarding its size', () => {
  const grid = studioGridTemplate({ bottomHeight: 280, isEditorMaximized: true });
  assert.equal(grid.gridTemplateRows, 'minmax(0, 1fr) 0px 0px');
  assert.equal(grid.showRowResizer, false);
  // Restoring re-reads the same stored height.
  assert.equal(studioGridTemplate({ bottomHeight: 280 }).gridTemplateRows.endsWith('280px'), true);
});

test('a maximized bottom row takes the whole centre, keeping its two columns', () => {
  const grid = studioGridTemplate({ chatWidth: 500, isBottomMaximized: true });
  assert.equal(grid.gridTemplateRows, '0px 0px minmax(0, 1fr)');
  assert.equal(grid.gridTemplateColumns, `500px ${STUDIO_SPLITTER_PX}px minmax(0, 1fr)`);
  assert.equal(grid.showRowResizer, false);
  assert.equal(grid.showColumnResizer, true);
});

test('maximizing a bottom row that is not on screen changes nothing', () => {
  const grid = studioGridTemplate({ isEditorMaximized: true, isBottomMaximized: true });
  assert.equal(grid.gridTemplateRows, 'minmax(0, 1fr) 0px 0px');
});
