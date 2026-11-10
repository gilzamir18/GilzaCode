// Tests for free-standing brace groups in inline LaTeX.
//
// `1{,}5` is the standard way to write a decimal comma and should read as
// `1,5`. Both editors used to show it verbatim. The braces are rendered away
// but never written away — `{f}{f}` breaks an "ff" ligature, so dropping them
// on save would change what LaTeX compiles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fragment } from 'prosemirror-model';

import { isTransparentGroup, stripTransparentGroups } from '../latexBraceGroups.js';
import { schema } from '../../wysiwyg/schema.js';
import { parseInline, serializeInline } from '../../wysiwyg/inline.js';

function visibleText(source) {
  const fragment = Fragment.from(parseInline(source, schema));
  return fragment.textBetween(0, fragment.size, '', (node) => node.attrs.raw || '');
}

function roundTrip(source) {
  return serializeInline(Fragment.from(parseInline(source, schema)));
}

// ── The rule ────────────────────────────────────────────────────────────────

test('a group only groups when its content holds no command or comment', () => {
  for (const content of [',', 'abc', '', '-', '1 2', '$x$']) {
    assert.ok(isTransparentGroup(content), `{${content}} should be transparent`);
  }
  for (const content of ['\\bfseries x', '\\ref{a}', '% note', 'a\\,b']) {
    assert.ok(!isTransparentGroup(content), `{${content}} should be opaque`);
  }
});

test('stripping unwraps free-standing groups only', () => {
  assert.equal(stripTransparentGroups('mais de 1{,}5'), 'mais de 1,5');
  assert.equal(stripTransparentGroups('sha{f}{f}le'), 'shaffle');
  assert.equal(stripTransparentGroups('{,} no início'), ', no início');
  // Nested groups reduce one level per pass.
  assert.equal(stripTransparentGroups('{a{b}c}'), 'abc');
  // A group holding a command is left alone: what it means depends on the
  // command, and guessing is how markup ends up silently altered.
  assert.equal(stripTransparentGroups('{\\bfseries x}'), '{\\bfseries x}');
});

test('a command argument is never mistaken for a free-standing group', () => {
  // Unwrapping here would strand the command name in front of its own
  // argument. The lookbehind makes this independent of substitution order.
  assert.equal(stripTransparentGroups('ver \\ref{fig:x} aqui'), 'ver \\ref{fig:x} aqui');
  assert.equal(stripTransparentGroups('\\cite{a,b}'), '\\cite{a,b}');
  assert.equal(stripTransparentGroups('\\textbf{bold}'), '\\textbf{bold}');
});

test('escaped braces are not a group', () => {
  // `\{a\}` is a literal pair of braces; its content reads as `a\` and so
  // fails the transparency test outright.
  assert.equal(stripTransparentGroups('lit \\{a\\} braces'), 'lit \\{a\\} braces');
});

// ── The reported case, end to end ───────────────────────────────────────────

test('the reported decimal comma renders as a comma and saves unchanged', () => {
  const source = 'mais de 1{,}5';
  assert.equal(visibleText(source), 'mais de 1,5');
  assert.equal(roundTrip(source), source);
});

test('transparent groups round-trip exactly', () => {
  const cases = [
    'mais de 1{,}5',
    'R\\$~1{,}50',
    'sha{f}{f}le',
    '{,} no início',
    'empty {} group',
    '{\\Huge H} and 1{,}5',
    'a {b} c {d} e',
  ];
  for (const source of cases) {
    assert.equal(roundTrip(source), source, `round-trip of ${source}`);
  }
});

test('adjacent groups are never merged into one', () => {
  // `sha{f}{f}le` breaks a ligature; `sha{ff}le` does not. The two groups must
  // stay distinct through the model, which is what the scope mark's `key`
  // attribute is for.
  const source = 'sha{f}{f}le';
  assert.equal(visibleText(source), 'shaffle');
  assert.equal(roundTrip(source), source);
  assert.ok(!roundTrip(source).includes('{ff}'), 'the two groups must not merge');
});

test('an empty group survives as itself', () => {
  // There is no content to carry the mark, so it stays an atom rather than
  // vanishing on save.
  assert.equal(roundTrip('empty {} group'), 'empty {} group');
});

test('a group holding a command is still preserved whole', () => {
  const source = '{\\color{red} x}';
  assert.equal(roundTrip(source), source);
  assert.equal(visibleText(source), source);
});
