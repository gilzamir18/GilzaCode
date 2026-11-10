import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findEnclosingHeading,
  findSelectionHeading,
  readSelectionWithin,
} from '../documentSelection.js';

// Minimal stand-ins for the parts of the DOM these rules actually read. The
// point of the module is that both document surfaces answer the same way, so
// the rules are exercised directly rather than through a rendered tree.
const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

const makeSelection = ({ text, isCollapsed = false, rangeCount = 1, common = {} }) => ({
  isCollapsed,
  rangeCount,
  toString: () => text,
  getRangeAt: () => ({ commonAncestorContainer: common }),
});

const containerHolding = (node) => ({ contains: (candidate) => candidate === node });

test('a selection inside the container is returned trimmed', () => {
  const node = { id: 'inside' };
  const selection = makeSelection({ text: '  an excerpt worth translating \n', common: node });

  assert.equal(readSelectionWithin(containerHolding(node), selection), 'an excerpt worth translating');
});

test('a selection anchored outside the container is not this document\'s excerpt', () => {
  // The rule the PDF viewer has always applied: text selected elsewhere in the
  // app is not part of the document, and quoting it would attribute to the
  // document something the user never pointed at.
  const outside = { id: 'somewhere-else' };
  const selection = makeSelection({ text: 'chat message text', common: outside });

  assert.equal(readSelectionWithin(containerHolding({ id: 'inside' }), selection), '');
});

test('a collapsed caret is not a selection', () => {
  const node = { id: 'inside' };
  const selection = makeSelection({ text: '', isCollapsed: true, common: node });

  assert.equal(readSelectionWithin(containerHolding(node), selection), '');
});

test('an empty range count yields no excerpt', () => {
  const node = { id: 'inside' };
  const selection = makeSelection({ text: 'x', rangeCount: 0, common: node });

  assert.equal(readSelectionWithin(containerHolding(node), selection), '');
});

test('a missing container or selection is empty, never a throw', () => {
  assert.equal(readSelectionWithin(null, makeSelection({ text: 'x' })), '');
  assert.equal(readSelectionWithin({ contains: () => true }, null), '');
});

// ── heading lookup ─────────────────────────────────────────────────────────
// `heading.compareDocumentPosition(node)` reports the node's position relative
// to the heading, so FOLLOWING means the node sits after that heading.
const makeHeadingTree = (headings, nodeIndex) => ({
  querySelectorAll: () => headings.map((textContent, index) => ({
    textContent,
    compareDocumentPosition: () => (
      index <= nodeIndex ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING
    ),
  })),
});

test('the locator is the last heading the excerpt still follows', () => {
  const container = makeHeadingTree(['Introduction', 'Method', 'Results'], 1);

  assert.equal(findEnclosingHeading(container, { id: 'node' }), 'Method');
});

test('an excerpt above the first heading has no section, and that is not an error', () => {
  // A missing locator drops its line from the staged prompt rather than
  // guessing a section the excerpt is not in.
  const container = makeHeadingTree(['Introduction'], -1);

  assert.equal(findEnclosingHeading(container, { id: 'node' }), '');
});

test('a document with no headings has no section', () => {
  assert.equal(findEnclosingHeading({ querySelectorAll: () => [] }, { id: 'node' }), '');
});

test('a container that cannot be queried fails soft', () => {
  assert.equal(findEnclosingHeading({}, { id: 'node' }), '');
  assert.equal(findEnclosingHeading({ querySelectorAll: () => { throw new Error('detached'); } }, {}), '');
  assert.equal(findEnclosingHeading(null, null), '');
});

test('the heading is only read when the selection belongs to the container', () => {
  const node = { id: 'inside' };
  const container = {
    ...makeHeadingTree(['Method'], 0),
    contains: (candidate) => candidate === node,
  };

  assert.equal(findSelectionHeading(container, makeSelection({ text: 'x', common: node })), 'Method');
  assert.equal(findSelectionHeading(container, makeSelection({ text: 'x', common: { id: 'other' } })), '');
});
