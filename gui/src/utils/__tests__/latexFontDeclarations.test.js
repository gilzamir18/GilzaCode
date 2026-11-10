// Tests for LaTeX font declarations — the commands that take no argument and
// apply to the end of their scope (`\Huge`, `\small`, `\bfseries`, ...).
//
// Both editors used to show these as literal markup, so a slide title read
// `{\Huge\bfseries Bem-vindos}` instead of large bold text. These tests pin
// the whole standard set, in both spellings, and the round-trip that keeps
// rendering them from rewriting the source.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fragment } from 'prosemirror-model';

import {
  DECLARATION_NAMES, declarationStyle, findFirstDeclaration, matchDeclarationRun,
} from '../latexFontDeclarations.js';
import { schema } from '../../wysiwyg/schema.js';
import { parseInline, serializeInline } from '../../wysiwyg/inline.js';

// The complete set the standard classes define, spelled out rather than
// derived from the implementation — a test that reads its expectations from
// the code it is testing cannot catch a deletion.
const SIZES = [
  'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize',
  'large', 'Large', 'LARGE', 'huge', 'Huge',
];
const SERIES_SHAPE_FAMILY = [
  'bfseries', 'mdseries',
  'itshape', 'slshape', 'scshape', 'upshape',
  'ttfamily', 'sffamily', 'rmfamily',
  'normalfont',
];
// Short forms that predate LaTeX 2e but remain common in slide decks.
const SHORT_FORMS = ['bf', 'it', 'sc', 'tt', 'sf', 'rm', 'em'];

const ALL = [...SIZES, ...SERIES_SHAPE_FAMILY, ...SHORT_FORMS];

// The visible text of a parsed inline run, with unmodelled commands shown as
// their source — which is how leaked markup would surface.
function visibleText(source) {
  const fragment = Fragment.from(parseInline(source, schema));
  return fragment.textBetween(0, fragment.size, '', (node) => node.attrs.raw || '');
}

function roundTrip(source) {
  return serializeInline(Fragment.from(parseInline(source, schema)));
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

test('the whole standard declaration set is recognized', () => {
  for (const name of ALL) {
    assert.ok(DECLARATION_NAMES.has(name), `\\${name} must be recognized as a declaration`);
  }
});

test('every declaration produces a visible effect', () => {
  for (const name of ALL) {
    const style = declarationStyle(`\\${name} `);
    assert.ok(
      Object.keys(style).length > 0,
      `\\${name} resolved to no style, so it would render as a silent no-op`,
    );
  }
});

test('sizes are ordered smallest to largest', () => {
  const sizes = SIZES.map((name) => parseFloat(declarationStyle(`\\${name} `).fontSize));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] > sizes[i - 1], `\\${SIZES[i]} must be larger than \\${SIZES[i - 1]}`);
  }
  assert.equal(declarationStyle('\\normalsize ').fontSize, '1em', 'normalsize is the reference size');
});

test('a later declaration overrides an earlier one, as in LaTeX', () => {
  assert.equal(declarationStyle('\\small\\Huge ').fontSize, '2.49em');
  assert.equal(declarationStyle('\\bfseries\\mdseries ').fontWeight, 400);
});

test('the terminating whitespace belongs to the declaration run', () => {
  // TeX consumes it as the control word's terminator, so `\bfseries Bem`
  // renders "Bem" and not " Bem".
  const run = matchDeclarationRun('\\bfseries Bem', 0);
  assert.equal(run.prefix, '\\bfseries ');
  assert.deepEqual(run.names, ['bfseries']);

  const chained = matchDeclarationRun('\\Huge\\bfseries Bem', 0);
  assert.equal(chained.prefix, '\\Huge\\bfseries ');
  assert.deepEqual(chained.names, ['Huge', 'bfseries']);
});

test('a declaration name is not matched inside a longer command', () => {
  // `\emph` must not be read as `\em`, nor `\itemize` as `\it`.
  assert.equal(matchDeclarationRun('\\emph{x}', 0), null);
  assert.equal(matchDeclarationRun('\\itemize', 0), null);
  assert.equal(matchDeclarationRun('\\smallskip', 0), null);
  assert.equal(findFirstDeclaration('see \\emph{x} here'), null);
});

test('a declaration inside another command\'s argument is not hoisted out', () => {
  // `\textbf{\small x}` is found at the inner position, not at the `\textbf`.
  const found = findFirstDeclaration('\\textbf{\\small x}');
  assert.ok(found);
  assert.equal(found.form, 'group');
  assert.equal(found.prefix, '\\small ');
});

test('both spellings are found', () => {
  const group = findFirstDeclaration('{\\Huge\\bfseries Bem-vindos}');
  assert.equal(group.form, 'group');
  assert.equal(group.prefix, '\\Huge\\bfseries ');

  const bare = findFirstDeclaration('\\footnotesize Referência: Ng, A.');
  assert.equal(bare.form, 'bare');
  assert.equal(bare.prefix, '\\footnotesize ');
  // A bare declaration runs to the end of the scope it was given.
  assert.equal(bare.contentEnd, '\\footnotesize Referência: Ng, A.'.length);
});

// ── The reported cases ──────────────────────────────────────────────────────

test('the reported slides render as text, not as markup', () => {
  const cases = [
    ['{\\Huge\\bfseries Bem-vindos à disciplina de Inteligência Artificial!}',
     'Bem-vindos à disciplina de Inteligência Artificial!'],
    ['{\\Large A IA se aprende fazendo --- programando.}',
     'A IA se aprende fazendo — programando.'],
    ['{\\large Dúvidas?}', 'Dúvidas?'],
    ['\\footnotesize\\emph{Próxima aula: Conceitos de inteligência.}',
     'Próxima aula: Conceitos de inteligência.'],
    ['\\footnotesize Referência: Ng, A. \\emph{Agentic AI} --- DeepLearning.AI, 2024.',
     'Referência: Ng, A. Agentic AI — DeepLearning.AI, 2024.'],
    ['\\small texto pequeno', 'texto pequeno'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(visibleText(source), expected, `visible text of ${source}`);
    assert.equal(roundTrip(source), source, `round-trip of ${source}`);
  }
});

// ── Round-trip over the whole set ───────────────────────────────────────────

test('every declaration round-trips exactly, in both spellings', () => {
  for (const name of ALL) {
    for (const source of [`{\\${name} scoped text}`, `\\${name} trailing text`]) {
      assert.equal(roundTrip(source), source, `round-trip of ${source}`);
      assert.ok(
        !visibleText(source).includes(`\\${name}`),
        `\\${name} leaked into the visible text of ${source}`,
      );
    }
  }
});

test('declarations combine with argument-taking commands without reordering', () => {
  const cases = [
    '{\\bfseries bold with \\textit{italic} inside}',
    '{\\ttfamily code} and {\\scshape caps}',
    '\\small {\\bfseries nested} tail',
    '{\\Large outer {\\small inner} outer}',
  ];
  for (const source of cases) {
    assert.equal(roundTrip(source), source, `round-trip of ${source}`);
  }
});

test('a declaration inside a command argument keeps its scope, gaining braces', () => {
  // ProseMirror orders marks by schema rank, so a declaration written inside
  // `\textbf{...}` comes back out ahead of it. Written bare in that position
  // it would run to the end of the paragraph instead of ending with the
  // argument, so it is braced — the same scope, not the same bytes.
  //
  // This only ever applies to a paragraph the user edited; an untouched one
  // is written back from its original source and never passes through here.
  assert.equal(roundTrip('\\textbf{\\small x}'), '{\\small \\textbf{x}}');
  assert.equal(roundTrip('a \\textbf{\\small x} b'), 'a {\\small \\textbf{x}} b');

  // The property that matters: text after the construct is outside the
  // declaration's scope, exactly as it was in the source.
  const out = roundTrip('a \\textbf{\\small x} b');
  const afterScope = out.slice(out.lastIndexOf('}') + 1);
  assert.equal(afterScope, ' b', 'trailing text must not be swallowed by the declaration');
});

test('a brace group that is not a declaration scope keeps its braces in source', () => {
  // Braces that only group are rendered away — see latexBraceGroups.test.js —
  // but they are never written away, since they can carry meaning the
  // rendering does not show.
  assert.equal(roundTrip('{plain group}'), '{plain group}');
  assert.equal(visibleText('{plain group}'), 'plain group');

  // A group holding a command is preserved whole, rendering included: what it
  // means depends on the command, and guessing is how markup ends up
  // silently altered.
  assert.equal(roundTrip('{\\color{red} x}'), '{\\color{red} x}');
  assert.equal(visibleText('{\\color{red} x}'), '{\\color{red} x}');
});
