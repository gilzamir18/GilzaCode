import test from 'node:test';
import assert from 'node:assert/strict';

import { collectTreePaths, isSelectAllKey, outermostPaths } from '../explorerSelection.js';

const tree = [
  { name: 'figs', path: 'figs', isDirectory: true, children: [
    { name: 'a.png', path: 'figs\\a.png', isDirectory: false },
    { name: 'sub', path: 'figs\\sub', isDirectory: true, children: [
      { name: 'b.svg', path: 'figs\\sub\\b.svg', isDirectory: false },
    ] },
  ] },
  { name: 'empty', path: 'empty', isDirectory: true, children: [] },
  { name: 'main.tex', path: 'main.tex', isDirectory: false },
];

test('select all collects every file and directory, nested ones included', () => {
  assert.deepEqual(collectTreePaths(tree), ['figs', 'figs\\a.png', 'figs\\sub', 'figs\\sub\\b.svg', 'empty', 'main.tex']);
  assert.deepEqual(collectTreePaths([]), []);
});

test('bulk actions keep only the outermost selected paths', () => {
  assert.deepEqual(outermostPaths(collectTreePaths(tree)), ['figs', 'empty', 'main.tex']);
  assert.deepEqual(outermostPaths(['figs/sub/b.svg', 'figs\\sub', 'main.tex']), ['figs\\sub', 'main.tex']);
  // A sibling sharing a prefix is not inside the directory.
  assert.deepEqual(outermostPaths(['figs', 'figs-old/x.png']), ['figs', 'figs-old/x.png']);
  assert.deepEqual(outermostPaths(['a', 'a']), ['a']);
});

test('Ctrl+A selects in the tree but not inside its text fields', () => {
  const div = { tagName: 'DIV' };
  assert.equal(isSelectAllKey({ ctrlKey: true, key: 'a', target: div }), true);
  assert.equal(isSelectAllKey({ metaKey: true, key: 'A', target: div }), true);
  assert.equal(isSelectAllKey({ ctrlKey: true, key: 'q', code: 'KeyA', target: div }), true);
  assert.equal(isSelectAllKey({ key: 'a', target: div }), false);
  assert.equal(isSelectAllKey({ ctrlKey: true, shiftKey: true, key: 'a', target: div }), false);
  assert.equal(isSelectAllKey({ ctrlKey: true, key: 'a', target: { tagName: 'INPUT' } }), false);
  assert.equal(isSelectAllKey({ ctrlKey: true, key: 'a', target: { tagName: 'DIV', isContentEditable: true } }), false);
});
