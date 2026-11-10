import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampViewAnchor,
  isAnchorLaidOut,
  scrollTopForAnchor,
  viewAnchorAt,
} from '../pdfViewState.js';

// Three pages of 1000px with 40px between them, after 32px of top padding.
const PAGES = [
  { page: 1, top: 32, height: 1000, ready: true },
  { page: 2, top: 1072, height: 1000, ready: true },
  { page: 3, top: 2112, height: 1000, ready: true },
];

test('anchors to the page at the top of the view', () => {
  assert.deepEqual(viewAnchorAt(1572, PAGES), { page: 2, offset: 0.5 });
  assert.deepEqual(viewAnchorAt(2112, PAGES), { page: 3, offset: 0 });
});

test('the gap after a page belongs to that page', () => {
  const anchor = viewAnchorAt(1050, PAGES);
  assert.equal(anchor.page, 1);
  assert.equal(scrollTopForAnchor(anchor, PAGES), 1050);
});

test('the padding above the first page is kept', () => {
  const anchor = viewAnchorAt(0, PAGES);
  assert.equal(anchor.page, 1);
  assert.equal(scrollTopForAnchor(anchor, PAGES), 0);
});

test('an anchor round-trips to the same offset', () => {
  for (const top of [0, 10, 32, 500, 1071, 1072, 2000, 3000]) {
    assert.equal(scrollTopForAnchor(viewAnchorAt(top, PAGES), PAGES), top, `top=${top}`);
  }
});

test('an anchor lands on its page when the pages above it changed height', () => {
  // A recompile that grew page 1 must still restore the middle of page 2.
  const anchor = viewAnchorAt(1572, PAGES);
  const grown = [
    { page: 1, top: 32, height: 1400, ready: true },
    { page: 2, top: 1472, height: 1000, ready: true },
  ];
  assert.equal(scrollTopForAnchor(anchor, grown), 1972);
});

test('pages that are not laid out are neither anchored to nor restored onto', () => {
  const placeholders = PAGES.map((p) => ({ ...p, height: 0, ready: false }));
  assert.equal(viewAnchorAt(500, placeholders), null);
  assert.equal(scrollTopForAnchor({ page: 2, offset: 0 }, placeholders), null);
  assert.equal(scrollTopForAnchor(null, PAGES), null);
});

test('an anchor waits for its page and every page above it', () => {
  const anchor = { page: 3, offset: 0.2 };
  assert.equal(isAnchorLaidOut(anchor, PAGES), true);
  // A placeholder above the target would move it as soon as it grows.
  const pending = [PAGES[0], { ...PAGES[1], ready: false }, PAGES[2]];
  assert.equal(isAnchorLaidOut(anchor, pending), false);
  // A placeholder below the target cannot move it.
  assert.equal(isAnchorLaidOut({ page: 1, offset: 0 }, pending), true);
  // A page that is not in the document yet is not laid out.
  assert.equal(isAnchorLaidOut({ page: 4, offset: 0 }, PAGES), false);
  assert.equal(isAnchorLaidOut(null, PAGES), false);
});

test('a document that lost pages opens at the top of its new last page', () => {
  assert.deepEqual(clampViewAnchor({ page: 9, offset: 0.7 }, 4), { page: 4, offset: 0 });
  assert.deepEqual(clampViewAnchor({ page: 3, offset: 0.7 }, 4), { page: 3, offset: 0.7 });
  // The page count is unknown until the document loads; the anchor is kept.
  assert.deepEqual(clampViewAnchor({ page: 9, offset: 0.7 }, 0), { page: 9, offset: 0.7 });
});

test('unusable anchors are dropped rather than guessed at', () => {
  for (const anchor of [null, undefined, {}, { page: 0, offset: 0 }, { page: 'x', offset: 0 }]) {
    assert.equal(clampViewAnchor(anchor, 5), null, JSON.stringify(anchor));
  }
  assert.deepEqual(clampViewAnchor({ page: 2, offset: NaN }, 5), { page: 2, offset: 0 });
});
