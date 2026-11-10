import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasAgentChanges,
  markerPathKey,
  removeAgentChangedFiles,
  renameAgentChangedFiles,
  unsavedFilePaths,
  withAgentChangedFiles,
  withoutAgentChangedFile,
} from '../fileMarkers.js';

const isBinary = (path) => path.endsWith('.pdf');

test('a buffer equal to the disk is not unsaved, even when it differs from git HEAD', () => {
  // The old marker compared with HEAD: a saved file stayed "dirty" until commit.
  const unsaved = unsavedFilePaths({
    openFiles: ['main.tex'],
    fileContents: { 'main.tex': 'saved edit' },
    activeFile: 'main.tex',
    activeContent: 'saved edit',
    diskContents: { 'main.tex': 'saved edit' },
  });
  assert.deepEqual(unsaved, []);
});

test('an edited buffer is unsaved, active or not', () => {
  const unsaved = unsavedFilePaths({
    openFiles: ['a.tex', 'b.tex', 'c.tex'],
    fileContents: { 'a.tex': 'stale cache', 'b.tex': 'typed', 'c.tex': 'same' },
    activeFile: 'a.tex',
    activeContent: 'typed in a',
    diskContents: { 'a.tex': 'disk a', 'b.tex': 'disk b', 'c.tex': 'same' },
  });
  assert.deepEqual(unsaved, ['a.tex', 'b.tex']);
});

test('the active buffer wins over its cached copy', () => {
  const unsaved = unsavedFilePaths({
    openFiles: ['a.tex'],
    fileContents: { 'a.tex': 'old typing' },
    activeFile: 'a.tex',
    activeContent: 'disk',
    diskContents: { 'a.tex': 'disk' },
  });
  assert.deepEqual(unsaved, []);
});

test('a file invalidated after an agent write is not unsaved', () => {
  // The cache entry is dropped so the next open reloads from disk; the old
  // marker read that `undefined` as a change and starred the file.
  const unsaved = unsavedFilePaths({
    openFiles: ['agent.tex'],
    fileContents: {},
    activeFile: null,
    diskContents: { 'agent.tex': 'before the agent' },
  });
  assert.deepEqual(unsaved, []);
});

test('files with no disk baseline, and binary files, are never unsaved', () => {
  const unsaved = unsavedFilePaths({
    openFiles: ['new.tex', 'out.pdf'],
    fileContents: { 'new.tex': 'x', 'out.pdf': 'y' },
    activeFile: null,
    diskContents: { 'out.pdf': 'z' },
    isBinary,
  });
  assert.deepEqual(unsaved, []);
});

test('marker keys are POSIX and relative', () => {
  assert.equal(markerPathKey('chapters\\intro.tex'), 'chapters/intro.tex');
  assert.equal(markerPathKey('./main.tex'), 'main.tex');
  assert.equal(markerPathKey('figures/'), 'figures');
});

test('agent marks are added, kept identical when nothing is new, and cleared one by one', () => {
  const empty = new Set();
  const marked = withAgentChangedFiles(empty, ['main.tex', 'chapters/intro.tex']);
  assert.deepEqual([...marked].sort(), ['chapters/intro.tex', 'main.tex']);
  assert.equal(withAgentChangedFiles(marked, ['main.tex']), marked);

  const opened = withoutAgentChangedFile(marked, 'chapters\\intro.tex');
  assert.deepEqual([...opened], ['main.tex']);
  assert.equal(withoutAgentChangedFile(opened, 'other.tex'), opened);
});

test('a file is marked only by its own path, never by a same-named file elsewhere', () => {
  const marked = new Set(['chapters/intro.tex']);
  assert.equal(hasAgentChanges(marked, 'chapters/intro.tex', false), true);
  assert.equal(hasAgentChanges(marked, 'appendix/intro.tex', false), false);
  assert.equal(hasAgentChanges(marked, 'intro.tex', false), false);
});

test('a folder is marked when something inside it is', () => {
  const marked = new Set(['chapters/part1/intro.tex']);
  assert.equal(hasAgentChanges(marked, 'chapters', true), true);
  assert.equal(hasAgentChanges(marked, 'chapters/part1', true), true);
  assert.equal(hasAgentChanges(marked, 'chap', true), false);
  assert.equal(hasAgentChanges(marked, 'appendix', true), false);
  assert.equal(hasAgentChanges(new Set(), 'chapters', true), false);
});

test('marks follow a renamed file or folder', () => {
  const marked = new Set(['chapters/intro.tex', 'chapters/x/y.tex', 'main.tex']);
  assert.deepEqual(
    [...renameAgentChangedFiles(marked, 'chapters', 'parts')].sort(),
    ['main.tex', 'parts/intro.tex', 'parts/x/y.tex'],
  );
  assert.deepEqual(
    [...renameAgentChangedFiles(marked, 'main.tex', 'thesis.tex')].sort(),
    ['chapters/intro.tex', 'chapters/x/y.tex', 'thesis.tex'],
  );
  assert.equal(renameAgentChangedFiles(marked, 'other', 'else'), marked);
});

test('deleting a file or folder drops its marks', () => {
  const marked = new Set(['chapters/intro.tex', 'chapters/x/y.tex', 'main.tex']);
  assert.deepEqual([...removeAgentChangedFiles(marked, 'chapters')], ['main.tex']);
  assert.deepEqual([...removeAgentChangedFiles(marked, 'main.tex')].sort(), ['chapters/intro.tex', 'chapters/x/y.tex']);
  assert.equal(removeAgentChangedFiles(marked, 'none.tex'), marked);
});
