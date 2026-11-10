// Guards the copy button on fenced code blocks in the Markdown renderer shared
// by the chat and the `.md` preview.
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

const render = (markdown) => renderToStaticMarkup(React.createElement(FormattedMessage, { content: markdown }));
const count = (html, needle) => html.split(needle).length - 1;
// The label is localised and the test runner's locale is not fixed, so the
// button is found by its class rather than its text.
const COPY_BUTTON = 'class="chat-code-copy ';

test('a fenced block with a language gets a copy button next to its label', () => {
  const html = render('```latex\n\\documentclass{article}\n\\begin{document}\n\\end{document}\n```');
  assert.equal(count(html, 'class="chat-code-block"'), 1);
  assert.match(html, /<span class="chat-code-lang">latex<\/span>/);
  assert.equal(count(html, COPY_BUTTON), 1);
  assert.match(html, /<code>\\documentclass\{article\}/);
});

test('a fenced block without a language still gets a copy button', () => {
  const html = render('```\nplain text listing\n```');
  assert.equal(count(html, COPY_BUTTON), 1);
  assert.match(html, /<span class="chat-code-lang"><\/span>/);
});

test('every fenced block gets its own copy button', () => {
  const html = render('```python\nprint(1)\n```\n\ntext\n\n```bash\nls\n```');
  assert.equal(count(html, COPY_BUTTON), 2);
});

// react-markdown 9+ passes no `inline` flag to the `code` component, so inline
// code must be told apart from fenced blocks by the <pre> wrapper; otherwise
// every `word` in a sentence would become a boxed listing with a copy button.
test('inline code stays inline and gets no copy button', () => {
  const html = render('Use `pdflatex` here.');
  assert.match(html, /<p[^>]*>Use <code class="chat-inline-code"[^>]*>pdflatex<\/code> here\.<\/p>/);
  assert.equal(count(html, 'chat-code-block'), 0);
});

test('folded reasoning blocks get no copy button', () => {
  assert.equal(count(render('<think>private reasoning</think>Answer.'), 'chat-code-copy'), 0);
});

test('a KaTeX-valid fenced latex block is still rendered as math', () => {
  const html = render('```latex\nx^2 + y^2 = z^2\n```');
  assert.match(html, /<math/);
  assert.equal(count(html, 'chat-code-block'), 0);
});
