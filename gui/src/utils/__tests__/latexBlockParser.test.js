// Tests for the block parser's environment handling.
//
// The parser recurses into an environment's body by default and names the
// exceptions, rather than recursing only into a short whitelist. These tests
// pin both halves of that: that unknown wrappers no longer swallow the
// structure inside them, and that the environments which genuinely are not
// sub-documents still do not get parsed as prose.
//
// Run with:  npm run test:wysiwyg

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLatexBlocks } from '../latexBlockParser.js';

// Collects every block in the tree, depth first.
function flatten(blocks, out = []) {
  for (const block of blocks) {
    out.push(block);
    if (block.children) flatten(block.children, out);
    if (block.items) flatten(block.items, out);
  }
  return out;
}

function types(blocks) {
  return flatten(blocks).map((b) => b.type);
}

function find(blocks, type) {
  return flatten(blocks).find((b) => b.type === type);
}

function doc(body) {
  return `\\begin{document}\n${body}\n\\end{document}\n`;
}

// ── The compounding-loss regression ─────────────────────────────────────────

const TURING_SLIDE = doc(`\\begin{frame}{Teste de Turing}
\\begin{columns}[T]
    \\column{0.55\\textwidth}
    \\begin{itemize}
      \\item Proposto por \\alert{Alan Turing} em 1950;
      \\item Artigo: \`\`\\emph{Computing Machinery and Intelligence}'';
    \\end{itemize}

    \\column{0.45\\textwidth}
    \\centering
    \\begin{tikzpicture}[node distance=1.2cm]
      \\node[draw, fill=blue!10] (human) {Humano};
    \\end{tikzpicture}
\\end{columns}
\\end{frame}`);

test('an unknown wrapper no longer swallows the structure inside it', () => {
  const found = types(parseLatexBlocks(TURING_SLIDE));
  // Before the default was inverted, the whole `columns` body collapsed into a
  // single opaque `environment` block, taking the list and the picture with it
  // even though both are constructs the parser handles on their own.
  assert.ok(found.includes('list'), 'the itemize inside the columns must be reached');
  assert.ok(found.includes('listitem'), 'its items must be reached');
  assert.ok(found.includes('graphic'), 'the tikzpicture must be reached (it gets a compiled preview)');
  assert.ok(!found.includes('environment'), `nothing should remain opaque, got: ${found.join(', ')}`);
});

test('columns split into columns, carrying their width fraction', () => {
  const columns = find(parseLatexBlocks(TURING_SLIDE), 'columns');
  assert.ok(columns, 'expected a columns block');
  assert.equal(columns.children.length, 2);
  assert.deepEqual(columns.children.map((c) => c.width), [0.55, 0.45]);
  assert.deepEqual(columns.children.map((c) => c.form), ['command', 'command']);
});

test('columns written as environments split the same way', () => {
  const source = doc(`\\begin{columns}
\\begin{column}{0.5\\textwidth}
Left side.
\\end{column}
\\begin{column}{0.5\\textwidth}
Right side.
\\end{column}
\\end{columns}`);
  const columns = find(parseLatexBlocks(source), 'columns');
  assert.ok(columns);
  assert.equal(columns.children.length, 2);
  assert.deepEqual(columns.children.map((c) => c.form), ['environment', 'environment']);
  assert.deepEqual(columns.children.map((c) => c.width), [0.5, 0.5]);
  const text = flatten(columns.children).filter((b) => b.type === 'paragraph').map((b) => b.text.trim());
  assert.deepEqual(text, ['Left side.', 'Right side.']);
});

test('a column width in absolute units reports no fraction', () => {
  const source = doc('\\begin{columns}\n\\column{5cm}\nText.\n\\end{columns}');
  const columns = find(parseLatexBlocks(source), 'columns');
  assert.equal(columns.children[0].width, null);
});

test('a columns environment with no columns stays a generic container', () => {
  const source = doc('\\begin{columns}\nJust text.\n\\end{columns}');
  const found = types(parseLatexBlocks(source));
  assert.ok(found.includes('envblock'), `expected a generic container, got: ${found.join(', ')}`);
  assert.ok(!found.includes('columns'));
});

// ── Generic recursion ───────────────────────────────────────────────────────

test('unrecognized environments recurse into their body', () => {
  for (const env of ['minipage', 'theorem', 'proof', 'definition', 'tcolorbox', 'multicols', 'adjustbox']) {
    const arg = ['minipage', 'tcolorbox', 'multicols', 'adjustbox'].includes(env) ? '{0.5\\textwidth}' : '';
    const source = doc(`\\begin{${env}}${arg}\n\\begin{itemize}\n\\item nested\n\\end{itemize}\n\\end{${env}}`);
    const found = types(parseLatexBlocks(source));
    assert.ok(found.includes('envblock'), `${env}: expected a generic container, got ${found.join(', ')}`);
    assert.ok(found.includes('list'), `${env}: expected the nested list to be reached`);
  }
});

test('environment arguments become the header, not body content', () => {
  const source = doc('\\begin{minipage}[t]{0.5\\textwidth}\nBody text.\n\\end{minipage}');
  const block = find(parseLatexBlocks(source), 'envblock');
  assert.ok(block);
  // The body starts after the arguments, so `[t]{0.5\textwidth}` is never
  // parsed as prose.
  const header = source.slice(block.start, block.bodyStart);
  assert.equal(header, '\\begin{minipage}[t]{0.5\\textwidth}');
  const paragraph = find([block], 'paragraph');
  assert.equal(paragraph.text.trim(), 'Body text.');
});

test('a brace group on the next line is body content, not an argument', () => {
  // Argument scanning deliberately does not skip whitespace.
  const source = doc('\\begin{myenv}\n{\\bfseries styled}\n\\end{myenv}');
  const block = find(parseLatexBlocks(source), 'envblock');
  assert.equal(source.slice(block.start, block.bodyStart), '\\begin{myenv}');
});

// ── Opaque environments ─────────────────────────────────────────────────────

test('environments whose body is not prose stay opaque', () => {
  // The property under test is that the body is never parsed as prose, not
  // which opaque block type it lands in: `verbatim` is claimed by the earlier
  // `code` branch, which is a better rendering than the generic fallback.
  for (const env of ['verbatim', 'alltt', 'array', 'tabbing', 'axis', 'filecontents']) {
    const source = doc(`\\begin{${env}}\na & b \\\\\n\\end{${env}}`);
    const blocks = flatten(parseLatexBlocks(source));
    const block = blocks.find((b) => b.envName === env);
    assert.ok(block, `${env}: expected a block for the environment`);
    assert.equal(block.editable, false, `${env}: must not be editable`);
    assert.ok(!block.children, `${env}: body must not be parsed into blocks`);
    assert.ok(
      !blocks.some((b) => b.type === 'paragraph' && b.text.includes('&')),
      `${env}: body leaked into a paragraph`,
    );
  }
});

// ── Existing behaviour must be unchanged ────────────────────────────────────

test('the environments that already had dedicated handling still get it', () => {
  const cases = [
    ['\\begin{itemize}\\item a\\end{itemize}', 'list'],
    ['\\begin{enumerate}\\item a\\end{enumerate}', 'list'],
    ['\\begin{description}\\item[t] a\\end{description}', 'list'],
    ['\\begin{quote}q\\end{quote}', 'quote'],
    ['\\begin{abstract}a\\end{abstract}', 'abstract'],
    ['\\begin{center}c\\end{center}', 'align'],
    ['\\begin{equation}x\\end{equation}', 'math'],
    ['\\begin{figure}\\includegraphics{a.png}\\end{figure}', 'figure'],
    ['\\begin{table}\\begin{tabular}{l}a\\\\\\end{tabular}\\end{table}', 'table'],
    ['\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}', 'graphic'],
    ['\\begin{verbatim}raw\\end{verbatim}', 'code'],
    ['\\begin{lstlisting}raw\\end{lstlisting}', 'code'],
    ['\\begin{frame}{T}body\\end{frame}', 'container'],
    ['\\begin{block}{T}body\\end{block}', 'container'],
  ];
  for (const [body, expected] of cases) {
    const found = types(parseLatexBlocks(doc(body)));
    assert.ok(found.includes(expected), `${body} → expected ${expected}, got ${found.join(', ')}`);
  }
});

// ── Offset integrity ────────────────────────────────────────────────────────
//
// Both editors splice edits back by offset, and the WYSIWYG serializer relies
// on a node's children exactly tiling its body range. A parser that reports
// inconsistent offsets corrupts the file rather than merely rendering oddly,
// so this is checked structurally rather than through either editor.

test('every block\'s children stay inside its body range and never overlap', () => {
  const sources = [TURING_SLIDE, doc('\\begin{minipage}{0.5\\textwidth}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\end{minipage}')];
  for (const source of sources) {
    for (const block of flatten(parseLatexBlocks(source))) {
      assert.ok(block.start <= block.end, `${block.type}: start after end`);
      const children = block.children || block.items;
      if (!children || !children.length) continue;
      if (typeof block.bodyStart === 'number') {
        assert.ok(children[0].start >= block.bodyStart, `${block.type}: first child starts before the body`);
        assert.ok(children[children.length - 1].end <= block.bodyEnd, `${block.type}: last child ends after the body`);
      }
      for (let i = 1; i < children.length; i++) {
        assert.ok(
          children[i].start >= children[i - 1].end,
          `${block.type}: children ${i - 1} and ${i} overlap`,
        );
      }
    }
  }
});
