// Editing-command tests: what the user does in the surface, checked against
// the LaTeX it produces.
//
// The round-trip suite proves the model can hold a document without damaging
// it. This suite proves the commands change it the way a LaTeX author would
// expect — a real mark becomes `\textbf{}`, Enter in a list makes an `\item`,
// Tab nests a sublist — and that everything they did not touch still comes out
// byte-identical.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, TextSelection } from 'prosemirror-state';

import { schema } from '../schema.js';
import { fromLatex } from '../fromLatex.js';
import { toLatex } from '../toLatex.js';
import {
  insertInlineMath, insertMathBlock, liftListItem, setHeading,
  setParagraph, sinkListItem, splitListItem, toggleBold, toggleList, toggleMono,
} from '../commands.js';

const DOC = `\\documentclass{article}
\\begin{document}
\\section{Heading}
Alpha beta gamma.

\\begin{itemize}
\\item first
\\item second
\\end{itemize}

Closing paragraph.
\\end{document}
`;

// Builds an editor state over `src` and returns it together with the binding
// needed to serialize back.
function open(src) {
  const binding = fromLatex(src);
  const state = EditorState.create({ doc: binding.doc, schema });
  return { state, binding };
}

function findNode(doc, match) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (match(node, pos)) { found = { node, pos }; return false; }
    return true;
  });
  return found;
}

// Places the cursor at `offset` characters into the first node matching, or
// selects a range when `length` is given.
function select(state, match, offset = 0, length = 0) {
  const target = findNode(state.doc, match);
  assert.ok(target, 'selection target not found');
  const from = target.pos + 1 + offset;
  const selection = TextSelection.create(state.doc, from, from + length);
  return state.apply(state.tr.setSelection(selection));
}

// Runs a command and returns the resulting LaTeX.
function run(state, binding, command) {
  let next = state;
  const ok = command(state, (tr) => { next = state.apply(tr); });
  assert.ok(ok, 'command did not apply');
  return { latex: toLatex(next.doc, binding), state: next };
}

const isPara = (text) => (node) => node.type.name === 'paragraph' && node.textContent.startsWith(text);
const isItem = (text) => (node) => node.type.name === 'list_item' && node.textContent.trim().startsWith(text);

// ── Marks ───────────────────────────────────────────────────────────────────

test('bold: applying the mark writes \\textbf and leaves the rest alone', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isPara('Alpha'), 0, 5); // "Alpha"
  const { latex } = run(selected, binding, toggleBold);

  assert.ok(latex.includes('\\textbf{Alpha} beta gamma.'), `got: ${latex.match(/.*beta gamma.*/)?.[0]}`);
  assert.ok(latex.includes('\\item first'), 'untouched list preserved');
  assert.ok(latex.includes('\\section{Heading}'), 'untouched heading preserved');
});

test('monospace: applying the mark writes \\texttt', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isPara('Alpha'), 6, 4); // "beta"
  const { latex } = run(selected, binding, toggleMono);
  assert.ok(latex.includes('Alpha \\texttt{beta} gamma.'), `got: ${latex.match(/.*gamma.*/)?.[0]}`);
});

test('bold: removing the mark removes the command', () => {
  const src = DOC.replace('Alpha beta gamma.', '\\textbf{Alpha} beta gamma.');
  const { state, binding } = open(src);
  const selected = select(state, isPara('Alpha'), 0, 5);
  const { latex } = run(selected, binding, toggleBold);
  assert.ok(latex.includes('Alpha beta gamma.'), `got: ${latex.match(/.*beta gamma.*/)?.[0]}`);
  assert.ok(!latex.includes('\\textbf'), 'command removed');
});

// ── Block type ──────────────────────────────────────────────────────────────

test('heading: changing the level rewrites the sectioning command', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, (n) => n.type.name === 'heading');
  const { latex } = run(selected, binding, setHeading(3));
  assert.ok(latex.includes('\\subsection{Heading}'), `got: ${latex.match(/\\\\sub?section.*/)?.[0]}`);
  assert.ok(!latex.includes('\\section{Heading}'), 'old command gone');
});

test('heading: a paragraph can be promoted, and a heading demoted back', () => {
  const { state, binding } = open(DOC);
  const promoted = run(select(state, isPara('Closing')), binding, setHeading(2));
  assert.ok(promoted.latex.includes('\\section{Closing paragraph.}'), `got: ${promoted.latex}`);

  const demoted = run(select(promoted.state, (n) => n.type.name === 'heading' && n.textContent === 'Closing paragraph.'), binding, setParagraph);
  assert.ok(demoted.latex.includes('Closing paragraph.'), 'text kept');
  assert.ok(!demoted.latex.includes('\\section{Closing'), 'command removed');
});

// ── Lists ───────────────────────────────────────────────────────────────────

test('list: Enter at the end of an item starts a new \\item', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isItem('first'), 'first'.length + 1);
  const { latex, state: next } = run(selected, binding, splitListItem);

  const items = latex.match(/\\item/g) || [];
  assert.equal(items.length, 3, `expected three items, got: ${latex}`);
  assert.ok(latex.includes('\\item first'), 'original item intact');
  assert.ok(latex.includes('\\item second'), 'sibling intact');
  // The new item must round-trip as real structure, not as stray text.
  const reparsed = fromLatex(latex);
  assert.equal(toLatex(reparsed.doc, reparsed), latex, 'result re-parses stably');
  assert.equal(next.doc.nodeSize > state.doc.nodeSize, true);
});

test('list: Tab nests an item into a sublist of the same flavour', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isItem('second'), 1);
  const { latex } = run(selected, binding, sinkListItem);

  assert.match(latex, /\\begin\{itemize\}[\s\S]*\\begin\{itemize\}[\s\S]*\\item second[\s\S]*\\end\{itemize\}[\s\S]*\\end\{itemize\}/);
  assert.ok(latex.includes('\\item first'), 'sibling untouched');
  const reparsed = fromLatex(latex);
  assert.equal(toLatex(reparsed.doc, reparsed), latex, 'result re-parses stably');
});

test('list: Shift+Tab lifts an item out of the list', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isItem('second'), 1);
  const { latex } = run(selected, binding, liftListItem);
  assert.ok(latex.includes('\\item first'), 'remaining item kept');
  assert.equal((latex.match(/\\item/g) || []).length, 1, `expected one item left, got: ${latex}`);
  assert.ok(latex.includes('second'), 'lifted text kept');
});

test('list: a paragraph can be turned into an enumerate and back', () => {
  const { state, binding } = open(DOC);
  const wrapped = run(select(state, isPara('Closing')), binding, toggleList('enumerate'));
  assert.match(wrapped.latex, /\\begin\{enumerate\}[\s\S]*\\item[\s\S]*Closing paragraph\.[\s\S]*\\end\{enumerate\}/);
  const reparsed = fromLatex(wrapped.latex);
  assert.equal(toLatex(reparsed.doc, reparsed), wrapped.latex, 'result re-parses stably');
});

test('list: switching flavour rewrites only the environment name', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isItem('first'), 1);
  const { latex } = run(selected, binding, toggleList('enumerate'));
  assert.ok(latex.includes('\\begin{enumerate}'), `got: ${latex}`);
  assert.ok(latex.includes('\\end{enumerate}'), 'closing tag rewritten');
  assert.ok(latex.includes('\\item first'), 'items untouched');
  assert.ok(!latex.includes('itemize'), 'old environment gone');
});

// ── Math ────────────────────────────────────────────────────────────────────

test('math: selected text becomes an inline formula', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isPara('Alpha'), 6, 4); // "beta"
  const { latex } = run(selected, binding, insertInlineMath);
  assert.ok(latex.includes('Alpha $beta$ gamma.'), `got: ${latex.match(/.*gamma.*/)?.[0]}`);
});

test('math: a display block is inserted after the current block', () => {
  const { state, binding } = open(DOC);
  const selected = select(state, isPara('Alpha'), 1);
  const { latex } = run(selected, binding, insertMathBlock);
  assert.ok(latex.includes('\\[\\]'), `expected an empty display block, got: ${latex}`);
  assert.ok(latex.includes('Alpha beta gamma.'), 'host paragraph untouched');
});

// ── The invariant, under editing ────────────────────────────────────────────

test('every command leaves untouched blocks byte-identical', () => {
  const untouched = ['\\documentclass{article}', '\\section{Heading}', '\\end{document}'];
  const commands = [
    ['bold', isPara('Alpha'), 0, 5, toggleBold],
    ['inline math', isPara('Alpha'), 6, 4, insertInlineMath],
    ['split item', isItem('first'), 6, 0, splitListItem],
    ['sink item', isItem('second'), 1, 0, sinkListItem],
  ];
  for (const [name, match, offset, length, command] of commands) {
    const { state, binding } = open(DOC);
    const { latex } = run(select(state, match, offset, length), binding, command);
    for (const fragment of untouched) {
      assert.ok(latex.includes(fragment), `${name}: expected "${fragment}" to survive untouched`);
    }
  }
});
