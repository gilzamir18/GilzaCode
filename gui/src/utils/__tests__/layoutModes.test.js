import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR_LAYOUTS,
  LAYOUT_MODES,
  enterLayout,
  layoutAfterOpeningFile,
  layoutAllowsChatToggle,
  layoutShowsEditor,
} from '../layoutModes.js';

test('the layouts that show the editor are the ones that dock a sidebar', () => {
  assert.deepEqual(EDITOR_LAYOUTS, ['ide', 'studio', 'document']);
  for (const mode of EDITOR_LAYOUTS) assert.equal(layoutShowsEditor(mode), true);
});

test('the layouts GilzaBots had and GilzaCode does not are not editor layouts', () => {
  for (const mode of ['chat', 'chat-bottom', 'review']) {
    assert.equal(layoutShowsEditor(mode), false);
  }
});

test('an unknown or missing mode is treated as not showing the editor', () => {
  assert.equal(layoutShowsEditor(undefined), false);
  assert.equal(layoutShowsEditor('chat-compare'), false);
});

test('opening a file keeps a layout that already shows the editor', () => {
  // The document layout exists to show one file and its preview, so opening a
  // file from its explorer must not switch layouts.
  assert.equal(layoutAfterOpeningFile('document'), 'document');
  assert.equal(layoutAfterOpeningFile('studio'), 'studio');
  assert.equal(layoutAfterOpeningFile('ide'), 'ide');
});

test('opening a file leaves a layout that hides the editor', () => {
  for (const mode of ['chat', 'chat-bottom', 'review', undefined]) {
    assert.equal(layoutAfterOpeningFile(mode), 'ide');
  }
});

test('the Claude Code panel can be toggled in the layouts that dock it as a panel', () => {
  for (const mode of ['ide', 'studio']) {
    assert.equal(layoutAllowsChatToggle(mode), true);
  }
});

test('the Claude Code panel cannot be toggled where it is not rendered', () => {
  assert.equal(layoutAllowsChatToggle('document'), false);
});

// A recorder for the setters a layout entry calls.
function setters(hasOpenDocument) {
  const calls = {};
  const record = (name) => (value) => { calls[name] = value; };
  return {
    calls,
    deps: {
      hasOpenDocument,
      setLayoutMode: record('layout'),
      setActiveSidebarTab: record('sidebar'),
      setIsChatVisible: record('chat'),
      setIsTerminalCollapsed: record('terminalCollapsed'),
      setActiveBottomTab: record('bottomTab'),
    },
  };
}

test('every layout the window renders can be entered', () => {
  assert.deepEqual([...LAYOUT_MODES].sort(), ['document', 'ide', 'studio']);
  for (const mode of EDITOR_LAYOUTS) assert.ok(LAYOUT_MODES.includes(mode));
});

test('the studio opens with its four surfaces and the explorer retracted', () => {
  const { calls, deps } = setters(true);
  enterLayout('studio', deps);
  assert.deepEqual(calls, {
    layout: 'studio', sidebar: null, chat: true, terminalCollapsed: false, bottomTab: 'terminal',
  });
});

test('the document layout opens on the explorer only when no document is open', () => {
  const open = setters(true);
  enterLayout('document', open.deps);
  assert.deepEqual(open.calls, { layout: 'document', sidebar: null });

  const empty = setters(false);
  enterLayout('document', empty.deps);
  assert.deepEqual(empty.calls, { layout: 'document', sidebar: 'explorer' });
});

test('the IDE layout changes only the layout', () => {
  for (const mode of ['ide']) {
    const plain = setters(true);
    enterLayout(mode, plain.deps);
    assert.deepEqual(plain.calls, { layout: mode });
  }
});
