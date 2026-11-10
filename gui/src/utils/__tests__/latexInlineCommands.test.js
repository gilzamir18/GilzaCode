// Tests for inline commands that take a textual argument.
//
// Two failures motivated this module. A regex of the shape `\{([^}]*)\}`
// cannot find the end of an argument containing braces of its own, so
// `\footnote{o termo \textit{modelo} ...}` rendered with a stray `\textit{`
// in the middle and an orphaned `}` at the end — corrupted output, not merely
// unrendered markup. And a note is not body text: splicing a footnote's
// argument into the sentence reads as if the author had written it there.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fragment } from 'prosemirror-model';

import {
  NOTE_COMMANDS, findCommandWithArgument, latexToPlainText, reduceCommandsToArguments,
} from '../latexInlineCommands.js';
import { schema } from '../../wysiwyg/schema.js';
import { parseInline, serializeInline } from '../../wysiwyg/inline.js';

// The case as reported, wrapped in a sentence and spanning lines like the
// original.
const REPORTED = 'Um \\footnote{Ao longo deste texto, o termo \\textit{modelo} refere-se sempre a\n'
  + '\\textit{modelo grande de linguagem} (do inglês \\textit{Large Language Model}, LLM),\n'
  + 'salvo indicação em contrário.} exemplo.';

function parse(source) {
  return parseInline(source, schema);
}

function roundTrip(source) {
  return serializeInline(Fragment.from(parse(source)));
}

// Visible text with a note shown as its marker, which is how it renders.
function visibleText(source) {
  const fragment = Fragment.from(parse(source));
  return fragment.textBetween(0, fragment.size, '', (node) => (
    node.type.name === 'footnote' ? '[†]' : (node.attrs.raw || '')
  ));
}

// ── Brace-aware scanning ────────────────────────────────────────────────────

test('an argument containing braces is matched to its real end', () => {
  const source = '\\footnote{a \\textit{b} c}';
  const found = findCommandWithArgument(source);
  assert.equal(found.name, 'footnote');
  assert.equal(source.slice(found.argStart, found.argEnd), 'a \\textit{b} c');
  assert.equal(found.end, source.length);
});

test('an optional argument is recognized and kept out of the argument', () => {
  const found = findCommandWithArgument('\\footnote[3]{note}');
  assert.equal(found.name, 'footnote');
  assert.equal(found.options, '[3]');
  assert.equal(found.argStart, '\\footnote[3]{'.length);
});

test('an escaped character is not read as a command', () => {
  assert.equal(findCommandWithArgument('100\\% of \\{a\\}'), null);
});

test('a command with no brace argument is skipped', () => {
  const found = findCommandWithArgument('\\bfseries then \\textbf{x}');
  assert.equal(found.name, 'textbf');
});

test('a filter skips past a rejected command and its whole argument', () => {
  // Without skipping the argument too, the `\textit` nested inside would come
  // back as if it stood at the top level.
  const found = findCommandWithArgument(
    '\\footnote{a \\textit{b}} \\emph{c}',
    0,
    (name) => !NOTE_COMMANDS.has(name),
  );
  assert.equal(found.name, 'emph');
});

// ── Reduction ───────────────────────────────────────────────────────────────

test('nested markup reduces completely', () => {
  // The regex this replaced stopped at the first `}`, leaving `\textbf{`
  // stranded and a `}` behind.
  assert.equal(
    reduceCommandsToArguments('\\caption{um \\textbf{teste} aqui}'),
    'um teste aqui',
  );
  assert.equal(reduceCommandsToArguments('\\a{\\b{\\c{deep}}}'), 'deep');
  assert.equal(reduceCommandsToArguments('ver \\ref{fig:x} aqui'), 'ver fig:x aqui');
});

test('note commands are left in place for the caller to render', () => {
  assert.equal(reduceCommandsToArguments(REPORTED), REPORTED);
  for (const name of NOTE_COMMANDS) {
    const source = `x \\${name}{note} y`;
    assert.equal(reduceCommandsToArguments(source), source, `\\${name} must survive reduction`);
  }
});

test('plain text drops markup but keeps the words', () => {
  assert.equal(
    latexToPlainText('o termo \\textit{modelo} refere-se a\n\\textit{LLM}, 100\\% certo'),
    'o termo modelo refere-se a LLM, 100% certo',
  );
});

// ── The reported case, end to end ───────────────────────────────────────────

test('the reported footnote renders as a marker, not as markup', () => {
  assert.equal(visibleText(REPORTED), 'Um [†] exemplo.');
  assert.equal(roundTrip(REPORTED), REPORTED, 'and the source is untouched');
});

test('the footnote carries its text for display, markup removed', () => {
  const note = parse(REPORTED).find((node) => node.type.name === 'footnote');
  assert.ok(note, 'expected a footnote node');
  const tooltip = latexToPlainText(note.attrs.content);
  assert.ok(tooltip.startsWith('Ao longo deste texto, o termo modelo refere-se'), tooltip);
  assert.ok(!tooltip.includes('\\textit'), 'markup must not reach the reader');
  assert.ok(tooltip.endsWith('salvo indicação em contrário.'), tooltip);
});

test('a note marker is not a number', () => {
  // LaTeX assigns footnote numbers at compile time from a document-wide
  // counter. Inventing one here would be a guess the reader could mistake for
  // the real numbering.
  const note = parse(REPORTED).find((node) => node.type.name === 'footnote');
  const marker = schema.nodes.footnote.spec.toDOM(note)[2];
  assert.equal(marker, '†');
});

test('every note command round-trips exactly', () => {
  for (const name of NOTE_COMMANDS) {
    for (const source of [
      `x \\${name}{simple} y`,
      `x \\${name}{with \\textit{markup} inside} y`,
      `x \\${name}{with $a^2$ math} y`,
    ]) {
      assert.equal(roundTrip(source), source, `round-trip of ${source}`);
    }
  }
  // An optional argument must survive, which it does because the whole
  // command is kept verbatim rather than rebuilt from its parts.
  assert.equal(roundTrip('x \\footnote[3]{note} y'), 'x \\footnote[3]{note} y');
});

test('a footnote does not disturb the text around it', () => {
  const source = 'antes \\footnote{nota} depois \\textbf{negrito} fim';
  assert.equal(visibleText(source), 'antes [†] depois negrito fim');
  assert.equal(roundTrip(source), source);
});
