// Round-trip fidelity tests for the LaTeX WYSIWYG model layer.
//
// The headline invariant is byte-exactness: parsing a document into the
// ProseMirror model and serializing it straight back must reproduce the input
// exactly. A WYSIWYG editor that normalizes the file on open is unusable for
// version-controlled LaTeX, so this is tested before anything else.
//
// Run with:  npm run test:wysiwyg     (node --test, no extra dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Fragment } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';

import { schema } from '../schema.js';
import { parseInline, serializeInline } from '../inline.js';
import { fromLatex } from '../fromLatex.js';
import { toLatex } from '../toLatex.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Reports the byte offset of the first difference, so a failure points at the
// construct that broke rather than dumping two 19KB strings.
function assertExact(actual, expected, label) {
  if (actual === expected) return;
  let i = 0;
  while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
  assert.fail(
    `${label}: diverges at byte ${i}\n` +
    `  expected: ${JSON.stringify(expected.slice(i, i + 100))}\n` +
    `  actual:   ${JSON.stringify(actual.slice(i, i + 100))}`,
  );
}

function roundTrip(src) {
  const binding = fromLatex(src);
  return toLatex(binding.doc, binding);
}

// ── Inline layer ────────────────────────────────────────────────────────────

test('inline: formatting, math, escapes and ligatures round-trip exactly', () => {
  const cases = [
    'plain text',
    'a \\textbf{bold} b',
    '\\textbf{\\textit{nested marks}}',
    '\\emph{stress} and \\texttt{code} and \\underline{rule} and \\textsc{caps}',
    'see \\ref{fig:x} and \\cite{a,b}',
    'inline $x^2 + y_1$ math',
    'paren \\(z\\) math',
    '100\\% of \\$5 \\& more \\_under\\_ \\#hash',
    'a --- b -- c ``quoted\'\' d',
    'non~breaking',
    'line\\\\ break',
    'sized\\\\[2ex] break',
    'a \\footnote{with \\textbf{bold} inside} b',
    '{\\bfseries scoped group} after',
    '\\includegraphics[width=\\linewidth]{img.png}',
  ];
  for (const source of cases) {
    const out = serializeInline(Fragment.from(parseInline(source, schema)));
    assertExact(out, source, `inline ${JSON.stringify(source)}`);
  }
});

test('inline: unmodelled commands become one atom, arguments included', () => {
  const nodes = parseInline('x \\cite{a,b} y', schema);
  const atoms = nodes.filter((n) => n.type.name === 'inline_raw');
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].attrs.raw, '\\cite{a,b}');
});

test('inline: formatting commands become marks, not literal text', () => {
  const nodes = parseInline('a \\textbf{b} c', schema);
  const bold = nodes.find((n) => n.marks.some((m) => m.type.name === 'strong'));
  assert.ok(bold, 'expected a node carrying the strong mark');
  assert.equal(bold.text, 'b');
  // The command itself must not survive as text — that is the difference from
  // the block-preview editor, which keeps `\textbf{}` in the buffer.
  assert.ok(!nodes.some((n) => n.isText && n.text.includes('textbf')));
});

// ── Document layer ──────────────────────────────────────────────────────────

const ARTICLE = `\\documentclass{article}
\\usepackage{amsmath}
\\title{Demo}
\\begin{document}
\\maketitle

\\section{Intro}
Hello \\textbf{world}, see \\ref{eq:1} and $x^2$.

\\subsection[Short]{Long title}
Second paragraph with 100\\% coverage.

\\begin{itemize}
  \\item First item
  \\item Second with \\emph{stress}
\\end{itemize}

\\[
  E = mc^2
\\]

\\begin{quote}
A quoted paragraph.
\\end{quote}

\\begin{table}[h]
\\centering
\\begin{tabular}{ll}
a & b \\\\
\\end{tabular}
\\caption{T}
\\end{table}
\\end{document}
`;

const BEAMER = `\\documentclass{beamer}
\\begin{document}
\\begin{frame}[fragile]{Title Here}
\\frametitle{Inner}
Some text.
\\begin{itemize}
\\item one
\\end{itemize}
\\end{frame}
\\end{document}
`;

const UNKNOWN = `\\documentclass{article}
\\newcommand{\\mycmd}[1]{\\textbf{#1}}
\\begin{document}
Text with \\mycmd{macro} and \\begin{unknownenv}stuff\\end{unknownenv} inline.

% a comment line

\\begin{description}
\\item[Term] definition
\\end{description}

\\begin{center}
Centred prose.
\\end{center}
\\end{document}
`;

// A two-column beamer slide: the shape that used to collapse into a single
// opaque blob, taking its list and its TikZ picture down with it.
const COLUMNS = `\\documentclass{beamer}
\\begin{document}
\\begin{frame}{Teste de Turing}
\\begin{columns}[T]
    \\column{0.55\\textwidth}
    \\begin{itemize}
      \\item Proposto por \\alert{Alan Turing} em 1950;
      \\item Crit\u00e9rio \\alert{comportamental}.
    \\end{itemize}

    \\column{0.45\\textwidth}
    \\centering
    \\begin{tikzpicture}[node distance=1.2cm]
      \\node[draw, fill=blue!10] (human) {Humano};
    \\end{tikzpicture}
\\end{columns}
\\end{frame}
\\end{document}
`;

const WRAPPERS = `\\documentclass{article}
\\begin{document}
\\begin{minipage}[t]{0.5\\textwidth}
Inside a minipage.

\\begin{itemize}
\\item nested item
\\end{itemize}
\\end{minipage}

\\begin{theorem}[Pythagoras]
For a right triangle, $a^2 + b^2 = c^2$.
\\end{theorem}

\\begin{verbatim}
  a & b \\\\ raw text
\\end{verbatim}
\\end{document}
`;

const CORPUS = { ARTICLE, BEAMER, UNKNOWN, COLUMNS, WRAPPERS };

test('document: round-trips are byte-exact', () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    assertExact(roundTrip(src), src, `corpus ${name}`);
  }
});

test('document: an empty and a whitespace-only file survive', () => {
  assertExact(roundTrip(''), '', 'empty');
  assertExact(roundTrip('\n\n'), '\n\n', 'blank');
});

test('document: a real-world paper template round-trips byte-exactly', async () => {
  // The SIBGRAPI template shipped with the app: 19KB of third-party LaTeX
  // nobody wrote for this editor. Read straight from the template archive so
  // the fixture cannot drift from what users actually open.
  const zipPath = path.resolve(here, '../../../../templates/template-sibgrapi-2024.zip');
  if (!fs.existsSync(zipPath)) {
    test.skip('template archive not present');
    return;
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const entry = Object.keys(zip.files).find(
    (name) => name.endsWith('.tex') && !name.includes('__MACOSX'),
  );
  assert.ok(entry, 'expected a .tex entry in the template archive');
  const src = await zip.files[entry].async('string');
  assert.ok(src.length > 10000, 'expected a substantial document');
  assertExact(roundTrip(src), src, 'sibgrapi template');
});

test('document: unknown environments and macros are preserved verbatim', () => {
  const binding = fromLatex(UNKNOWN);
  const raws = [];
  binding.doc.descendants((node) => {
    if (node.type.name === 'latex_raw') raws.push(node.attrs.kind);
    if (node.type.name === 'inline_raw') raws.push(`inline:${node.attrs.raw}`);
  });
  assert.ok(raws.includes('inline:\\mycmd{macro}'), 'user macro kept as an atom');
  assert.ok(raws.includes('comment'), 'comment kept as an opaque block');
  assertExact(roundTrip(UNKNOWN), UNKNOWN, 'unknown constructs');
});

test('document: structure is modelled, not flattened', () => {
  const { doc } = fromLatex(BEAMER);
  const types = [];
  doc.descendants((node) => { types.push(node.type.name); });
  for (const expected of ['container', 'container_title', 'frametitle', 'list', 'list_item', 'paragraph']) {
    assert.ok(types.includes(expected), `expected a ${expected} node in the beamer document`);
  }
});

// ── Edit locality ───────────────────────────────────────────────────────────
//
// The property that makes the mode safe to use on a shared repository: editing
// one paragraph rewrites that paragraph and nothing else.

// `Transform` (unlike `Transaction`) has no text helper of its own.
function typeText(tr, pos, text) {
  return tr.insert(pos, schema.text(text));
}

// Finds the document position just inside the first node satisfying `match`.
function findNode(doc, match) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (match(node)) { found = { node, pos }; return false; }
    return true;
  });
  return found;
}

test('edit locality: typing in one paragraph leaves every other byte untouched', () => {
  const src = ARTICLE;
  const binding = fromLatex(src);
  const target = findNode(binding.doc, (n) => n.type.name === 'paragraph' && (n.textContent || '').startsWith('Second paragraph'));
  assert.ok(target, 'expected to find the target paragraph');

  const tr = new Transform(binding.doc);
  typeText(tr, target.pos + 1, 'EDITED ');
  const out = toLatex(tr.doc, binding);

  const raw = target.node.attrs.raw;
  const start = src.indexOf(raw);
  assert.ok(start !== -1, 'paragraph raw must be locatable in the source');

  const prefix = src.slice(0, start);
  const suffix = src.slice(start + raw.length);
  assert.ok(out.startsWith(prefix), 'bytes before the edited paragraph must be identical');
  assert.ok(out.endsWith(suffix), 'bytes after the edited paragraph must be identical');

  // The rewritten span is the original slice with the typed text in it — the
  // leading newline that separated it from the heading is structure, not
  // content, so it survives the rebuild.
  const rewritten = out.slice(prefix.length, out.length - suffix.length);
  assert.equal(rewritten, raw.replace('Second paragraph', 'EDITED Second paragraph'));
});

test('edit locality: an edit inside a frame does not rewrite the frame header', () => {
  const src = BEAMER;
  const binding = fromLatex(src);
  const target = findNode(binding.doc, (n) => n.type.name === 'paragraph' && (n.textContent || '').includes('Some text'));
  assert.ok(target);

  const tr = new Transform(binding.doc);
  typeText(tr, target.pos + 1, 'X');
  const out = toLatex(tr.doc, binding);

  // The frame's optional argument and title are the fragile part: a naive
  // model-driven serializer drops `[fragile]` or reorders the arguments.
  assert.ok(out.includes('\\begin{frame}[fragile]{Title Here}'), 'frame header preserved');
  assert.ok(out.includes('\\item one'), 'untouched list preserved');
  assertExact(out, src.replace('Some text.', 'XSome text.'), 'only the edited paragraph changed');
});

test('edit locality: editing a frame title rebuilds only the header', () => {
  const binding = fromLatex(BEAMER);
  const target = findNode(binding.doc, (n) => n.type.name === 'container_title');
  assert.ok(target);

  const tr = new Transform(binding.doc);
  typeText(tr, target.pos + 1, 'New ');
  const out = toLatex(tr.doc, binding);

  assert.ok(out.includes('\\begin{frame}[fragile]{New Title Here}'), 'title rewritten, options kept');
  assert.ok(out.includes('Some text.'), 'body untouched');
});

test('edit locality: a heading keeps its optional short title', () => {
  const binding = fromLatex(ARTICLE);
  const target = findNode(binding.doc, (n) => n.type.name === 'heading' && n.textContent === 'Long title');
  assert.ok(target);

  const tr = new Transform(binding.doc);
  typeText(tr, target.pos + 1, 'Very ');
  const out = toLatex(tr.doc, binding);

  assert.ok(out.includes('\\subsection[Short]{Very Long title}'), `expected short title kept, got: ${out.match(/\\subsection.*/)?.[0]}`);
});

test('edit locality: deleting a block removes its separator with it', () => {
  const binding = fromLatex(ARTICLE);
  const target = findNode(binding.doc, (n) => n.type.name === 'math_block');
  assert.ok(target);

  const tr = new Transform(binding.doc);
  tr.delete(target.pos, target.pos + target.node.nodeSize);
  const out = toLatex(tr.doc, binding);

  assert.ok(!out.includes('E = mc^2'), 'math block removed');
  // The blank line that followed the block went with it rather than being
  // left behind as a growing run of empty lines.
  assert.ok(!/\n{4,}/.test(out), `unexpected blank-line run:\n${JSON.stringify(out)}`);
  assert.ok(out.includes('\\begin{quote}'), 'following block intact');
});

test('edit locality: splitting a paragraph writes both halves once', () => {
  const binding = fromLatex(ARTICLE);
  const target = findNode(binding.doc, (n) => n.type.name === 'paragraph' && (n.textContent || '').startsWith('Second paragraph'));
  assert.ok(target);

  const tr = new Transform(binding.doc);
  // Split after "Second paragraph" — both halves inherit the same blockId, so
  // this is the case where only the first may claim the original bytes.
  tr.split(target.pos + 1 + 'Second paragraph'.length);
  const out = toLatex(tr.doc, binding);

  assert.equal(out.match(/Second paragraph/g).length, 1, 'text must not be duplicated');
  assert.ok(out.includes('with 100\\% coverage.'), 'second half present and re-escaped');
  assertExact(roundTrip(out), out, 'the split result re-parses stably');
});

test('edit locality: an inserted paragraph does not disturb its neighbours', () => {
  const binding = fromLatex(ARTICLE);
  const target = findNode(binding.doc, (n) => n.type.name === 'paragraph' && (n.textContent || '').startsWith('Second paragraph'));
  const tr = new Transform(binding.doc);
  const fresh = schema.nodes.paragraph.create(
    { blockId: null, raw: null, tail: '\n\n' },
    parseInline('A brand new paragraph with \\textbf{bold}.', schema),
  );
  tr.insert(target.pos, fresh);
  const out = toLatex(tr.doc, binding);

  assert.ok(out.includes('A brand new paragraph with \\textbf{bold}.'), 'new paragraph serialized');
  assert.ok(out.includes('Second paragraph with 100\\% coverage.'), 'neighbour untouched');
  assertExact(roundTrip(out), out, 'the insertion result re-parses stably');
});

// ── Wrappers ────────────────────────────────────────────────────────────────

test('wrappers: a columns slide becomes real structure, not one opaque blob', () => {
  const { doc } = fromLatex(COLUMNS);
  const types = [];
  doc.descendants((node) => { types.push(node.type.name); });

  assert.ok(types.includes('columns_block'), 'the columns environment is modelled');
  assert.equal(types.filter((t) => t === 'column_block').length, 2, 'both columns are present');
  // The point of the whole change: the constructs nested inside the wrapper
  // are reached, instead of being swallowed with it.
  assert.ok(types.includes('list'), 'the itemize inside a column is real structure');
  assert.ok(types.includes('list_item'), 'and so are its items');
  assert.ok(
    types.filter((t) => t === 'latex_raw').length === 3,
    `only the preamble, the postamble and the tikzpicture stay verbatim, got: ${types.join(', ')}`,
  );
});

test('wrappers: column widths are carried onto the model', () => {
  const { doc } = fromLatex(COLUMNS);
  const widths = [];
  doc.descendants((node) => {
    if (node.type.name === 'column_block') widths.push(node.attrs.width);
  });
  assert.deepEqual(widths, [0.55, 0.45]);
});

test('wrappers: an unknown environment keeps its arguments in the header', () => {
  const { doc } = fromLatex(WRAPPERS);
  let minipage = null;
  doc.descendants((node) => {
    if (node.type.name === 'env_block' && node.attrs.envName === 'minipage') minipage = node;
  });
  assert.ok(minipage, 'expected the minipage to be modelled');
  assert.equal(minipage.attrs.headerRaw, '\\begin{minipage}[t]{0.5\\textwidth}');
  assert.equal(minipage.attrs.footerRaw, '\\end{minipage}');
  assert.ok(minipage.textContent.includes('Inside a minipage'), 'body is editable content');
});

test('wrappers: an environment whose body is not prose stays verbatim', () => {
  const { doc } = fromLatex(WRAPPERS);
  let verbatimKept = false;
  doc.descendants((node) => {
    if (node.type.name === 'latex_raw' && (node.attrs.raw || '').includes('a & b')) verbatimKept = true;
  });
  assert.ok(verbatimKept, 'the verbatim body must not be parsed into paragraphs');
});

test('edit locality: typing inside a column rewrites only that column\'s text', () => {
  const src = COLUMNS;
  const binding = fromLatex(src);
  const target = findNode(binding.doc, (n) => n.type.name === 'paragraph' && n.textContent.includes('Proposto'));
  assert.ok(target, 'expected to find the paragraph inside the first column');

  const tr = new Transform(binding.doc);
  typeText(tr, target.pos + 1, 'X');
  const out = toLatex(tr.doc, binding);

  // Everything structural around the edit survives byte-for-byte: the column
  // markers, the frame header, and the TikZ picture in the other column.
  assert.ok(out.includes('\\column{0.55\\textwidth}'), 'first column marker preserved');
  assert.ok(out.includes('\\column{0.45\\textwidth}'), 'second column marker preserved');
  assert.ok(out.includes('\\begin{frame}{Teste de Turing}'), 'frame header preserved');
  assert.ok(out.includes('\\node[draw, fill=blue!10] (human) {Humano};'), 'the other column untouched');
  assertExact(out, src.replace('Proposto', 'XProposto'), 'only the edited text changed');
});

test('stability: a second parse/serialize cycle is a fixed point', () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    const once = roundTrip(src);
    assertExact(roundTrip(once), once, `corpus ${name} is a fixed point`);
  }
});
