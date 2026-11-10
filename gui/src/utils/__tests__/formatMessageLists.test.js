// Guards ordered-list numbering in the Markdown renderer shared by the chat and
// the `.md` preview.
//
// Markdown ends a list at any unindented block between items, so
// `1. a` / paragraph / `2. b` is two lists, and the second one's first number
// lives only in its `start` attribute. The `ol` override used to drop it, which
// rendered every item of such a document as "1.".
//
// `formatMessage.jsx` is JSX, which `node --test` cannot import on its own, so
// the module is loaded through Vite's SSR transform — the same compiler the app
// is built with — rather than tested against a copy of the component.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const GUI_SRC = fileURLToPath(new URL('../../..', import.meta.url));

let server;
let FormattedMessage;

before(async () => {
  server = await createServer({
    configFile: false,
    root: GUI_SRC,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  });
  ({ FormattedMessage } = await server.ssrLoadModule('/src/utils/formatMessage.jsx'));
});

after(async () => {
  await server?.close();
});

const listOpenings = (markdown) => {
  const html = renderToStaticMarkup(React.createElement(FormattedMessage, { content: markdown }));
  return (html.match(/<ol[^>]*>/g) || []).map((tag) => tag.match(/ start="(\d+)"/)?.[1] ?? '1');
};

test('a contiguous ordered list renders as one list numbered from 1', () => {
  assert.deepEqual(listOpenings('1. one\n2. two\n3. three'), ['1']);
});

test('numbering continues across a paragraph between items', () => {
  assert.deepEqual(listOpenings('1. one\n\nWhy.\n\n2. two\n\nHow.\n\n3. three'), ['1', '2', '3']);
});

test('numbering continues across a code fence between items', () => {
  assert.deepEqual(listOpenings('1. one\n```\ncode\n```\n2. two'), ['1', '2']);
});

test('a list that does not start at 1 keeps its first number', () => {
  assert.deepEqual(listOpenings('5. five\n6. six'), ['5']);
});
