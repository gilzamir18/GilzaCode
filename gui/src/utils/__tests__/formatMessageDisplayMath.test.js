// Guards display math whose `$$` shares a line with the formula.
//
// remark-math treats text after an opening `$$` as fence meta and closes the
// block only on a line holding `$$` alone. A model reply that wrote
// `$$w_1=...\n=...$$` therefore lost the formula's first line and swallowed
// the rest of the message into one math node; KaTeX could not render it, and
// because the swallowed prose contained "í" KaTeX's error markup came out as
// the literal text "undefined" — the reply looked truncated.
//
// `formatMessage.jsx` is JSX, so it is loaded through Vite's SSR transform as
// in formatMessageLists.test.js.
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

const render = (markdown) => renderToStaticMarkup(React.createElement(FormattedMessage, { content: markdown }));

const texSources = (html) => [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)]
  .map((match) => match[1]);

const proseOf = (html) => html.replace(/<math[\s\S]*?<\/math>/g, '').replace(/<[^>]+>/g, '');

for (const [name, block] of [
  ['both fences attached', '$$w_1=\\frac{a}{b}\n=\\frac{c}{d}$$'],
  ['opening fence attached', '$$w_1=\\frac{a}{b}\n=\\frac{c}{d}\n$$'],
  ['closing fence attached', '$$\nw_1=\\frac{a}{b}\n=\\frac{c}{d}$$'],
  ['fences on their own lines', '$$\nw_1=\\frac{a}{b}\n=\\frac{c}{d}\n$$'],
]) {
  test(`display math with ${name} keeps the whole formula and the text after it`, () => {
    const html = render(`Você reencontra o monstro:\n\n${block}\n\nConferindo o equilíbrio.\n\n| x | y |\n|---|---|\n| 1 | 1 |`);

    assert.deepEqual(texSources(html), ['w_1=\\frac{a}{b}\n=\\frac{c}{d}']);
    assert.doesNotMatch(html, /katex-error/);
    assert.doesNotMatch(proseOf(html), /undefined|\$\$/);
    assert.match(proseOf(html), /Conferindo o equilíbrio\./);
    assert.match(html, /<table/);
  });
}

test('inline $$ math inside a sentence stays inline', () => {
  const html = render('Inline $$x^2$$ here and $$y$$ there.');

  assert.deepEqual(texSources(html), ['x^2', 'y']);
  assert.match(proseOf(html), /^Inline  here and  there\.$/m);
});

test('$$ inside fenced code is left as code', () => {
  const html = render('```text\n$$a\nb$$\n```');

  assert.deepEqual(texSources(html), []);
  assert.match(html, /\$\$a\nb\$\$/);
});
