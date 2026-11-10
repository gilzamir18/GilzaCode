// ─────────────────────────────────────────────────────────────────────────────
// schema.js
//
// ProseMirror schema for the LaTeX WYSIWYG mode ("Target A": a semantic
// WYSIWYG over a bounded LaTeX subset, with a verbatim escape hatch for
// everything outside that subset).
//
// Design invariants that the rest of the module depends on:
//
//  1. **The `.tex` file stays the source of truth.** Every node that came from
//     the source carries the exact slice it was built from in `raw`, plus the
//     inter-block text that followed it in `tail`. A node that the user never
//     touched is written back byte-for-byte from `raw` — the model is only
//     consulted for nodes that actually changed. See `toLatex.js`.
//
//  2. **Nothing is ever dropped.** Any construct the parser does not model
//     becomes a `latex_raw` block atom or an `inline_raw` inline atom holding
//     its source. Unknown packages, macros and environments therefore survive
//     an edit session untouched instead of being normalized away.
//
//  3. **Marks, not markup.** Bold/italic/monospace are real ProseMirror marks,
//     so `Ctrl+B` toggles formatting instead of typing `\textbf{}` into the
//     text — the difference between this mode and the block-preview editor in
//     `RichTextEditor.jsx`.
//
// `blockId` is a stable identity used to pair a node with its pristine
// counterpart when deciding whether `raw` is still valid. It survives content
// edits (ProseMirror keeps attrs when only children change) and is copied on
// a split, which `toLatex.js` handles by letting only the first occurrence
// claim the original source range.
// ─────────────────────────────────────────────────────────────────────────────

import { Schema } from 'prosemirror-model';
import { declarationStyle } from '../utils/latexFontDeclarations.js';
import { latexToPlainText } from '../utils/latexInlineCommands.js';

// Attributes shared by every node that maps onto a span of the source file.
// `raw`  — the exact source slice this node was parsed from (null when the
//          node was created in the editor and has no source yet).
// `tail` — the source text between this node's end and the next sibling's
//          start (usually blank lines). Kept on the node so that deleting a
//          block also removes its separator, and inserting one brings its own.
const sourceAttrs = () => ({
  blockId: { default: null },
  raw: { default: null },
  tail: { default: '\n\n' },
});

// Nodes with inline content additionally split off the whitespace that
// surrounds that content in the source. A paragraph following a `\section`
// line starts with the newline that separated them; leaving it inside the
// text would both show up as a leading space in the editor and, on the way
// back out, glue the paragraph onto the heading line. `head`/`foot` keep that
// whitespace as structure so it survives an edit untouched.
const affixAttrs = () => ({
  head: { default: '' },
  foot: { default: '' },
});

// Containers additionally remember the gap between their opening tag and
// their first child, so `\begin{frame}\n  \item...` keeps its indentation.
const bodyAttrs = () => ({
  ...sourceAttrs(),
  bodyHead: { default: '\n' },
});

// Wrappers whose opening and closing text is kept verbatim rather than rebuilt
// from a known shape. `\begin{minipage}[t]{0.5\textwidth}` and a marker-style
// `\column{0.55\textwidth}` (which has no closing text at all) are the same
// case: the boundary is whatever source lies outside the body range.
const boundaryAttrs = () => ({
  ...bodyAttrs(),
  headerRaw: { default: null },
  footerRaw: { default: null },
});

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },

    // ── Prose ───────────────────────────────────────────────────────────────
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { ...sourceAttrs(), ...affixAttrs() },
      toDOM: () => ['p', { class: 'ltx-paragraph' }, 0],
      parseDOM: [{ tag: 'p' }],
    },

    heading: {
      group: 'block',
      content: 'inline*',
      defining: true,
      attrs: {
        ...sourceAttrs(),
        ...affixAttrs(),
        level: { default: 2 },
        // The original sectioning command, including a star and an optional
        // short title (`\section[short]`). Preserved verbatim so editing the
        // visible title never silently drops `\chapter*` or `[short]`.
        prefix: { default: '\\section' },
      },
      toDOM: (node) => [`h${Math.min(6, Math.max(1, node.attrs.level))}`, { class: 'ltx-heading' }, 0],
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    },

    // Beamer `\frametitle{...}`.
    frametitle: {
      group: 'block',
      content: 'inline*',
      defining: true,
      attrs: { ...sourceAttrs(), ...affixAttrs() },
      toDOM: () => ['h4', { class: 'ltx-frametitle' }, 0],
    },

    // ── Lists ───────────────────────────────────────────────────────────────
    list: {
      group: 'block',
      content: 'list_item+',
      attrs: { ...bodyAttrs(), envName: { default: 'itemize' } },
      toDOM: (node) => [
        node.attrs.envName === 'enumerate' ? 'ol' : 'ul',
        { class: `ltx-list ltx-${node.attrs.envName}` },
        0,
      ],
    },

    list_item: {
      content: 'block+',
      defining: true,
      attrs: {
        ...bodyAttrs(),
        // An item created in the editor separates `\item` from its text with a
        // space and its sibling with a single newline — the shape `\item text`
        // that parsed items have. The generic block defaults (a blank line,
        // a leading newline) would produce `\item\n\ntext`.
        tail: { default: '\n' },
        bodyHead: { default: ' ' },
        // `\item[term]` of a description list. Held as a plain attribute
        // because description lists are rare; the body is real block content.
        term: { default: '' },
        hasTerm: { default: false },
        // `\item` plus its optional `[term]`, verbatim.
        headerRaw: { default: null },
      },
      toDOM: () => ['li', { class: 'ltx-item' }, 0],
    },

    // ── Block wrappers whose body is real, editable structure ───────────────
    quote_block: {
      group: 'block',
      content: 'block+',
      attrs: { ...bodyAttrs(), envName: { default: 'quote' } },
      toDOM: (node) => ['blockquote', { class: `ltx-quote ltx-${node.attrs.envName}` }, 0],
    },

    abstract_block: {
      group: 'block',
      content: 'block+',
      attrs: bodyAttrs(),
      toDOM: () => ['section', { class: 'ltx-abstract' }, 0],
    },

    align_block: {
      group: 'block',
      content: 'block+',
      attrs: { ...bodyAttrs(), align: { default: 'center' } },
      toDOM: (node) => ['div', { class: `ltx-align ltx-${node.attrs.align}` }, 0],
    },

    // Beamer `frame` / `block` / `exampleblock` / `alertblock`. The title is a
    // real child node (`container_title`) rather than an attribute, so it is
    // edited inline like any other text.
    container: {
      group: 'block',
      content: 'container_title block*',
      attrs: {
        ...bodyAttrs(),
        envName: { default: 'frame' },
        frameOptions: { default: '' },
        subtitle: { default: '' },
        // `\begin{frame}[opts]{Title}{Subtitle}`, verbatim.
        headerRaw: { default: null },
      },
      toDOM: (node) => ['section', { class: `ltx-container ltx-${node.attrs.envName}` }, 0],
    },

    container_title: {
      content: 'inline*',
      defining: true,
      attrs: { blockId: { default: null }, ...affixAttrs() },
      toDOM: () => ['header', { class: 'ltx-container-title' }, 0],
    },

    // Any environment without dedicated handling. Its body is real block
    // content; only its boundary is modelled, since what a package's
    // environment renders as is not knowable without running LaTeX. The
    // boundary text is kept verbatim in `headerRaw`/`footerRaw`, so arguments
    // such as `\begin{minipage}[t]{0.5\textwidth}` survive untouched.
    env_block: {
      group: 'block',
      content: 'block+',
      attrs: { ...boundaryAttrs(), envName: { default: '' } },
      toDOM: (node) => ['section', { class: `ltx-env ltx-env-${node.attrs.envName}` }, 0],
    },

    // Beamer `columns`, holding one child per column.
    columns_block: {
      group: 'block',
      content: 'column_block+',
      attrs: boundaryAttrs(),
      toDOM: () => ['div', { class: 'ltx-columns' }, 0],
    },

    // One column, in either of beamer's two spellings: a `\column{width}`
    // marker running until the next one, or a `column` environment. `form`
    // records which, so a rebuilt column keeps the spelling the document uses.
    column_block: {
      content: 'block+',
      attrs: {
        ...boundaryAttrs(),
        width: { default: null },
        form: { default: 'command' },
      },
      // The declared fraction becomes the flex grow factor, with a zero basis,
      // so the row divides in the proportions the slide will compile to.
      toDOM: (node) => [
        'div',
        { class: 'ltx-column', style: `flex: ${node.attrs.width || 1} 1 0` },
        0,
      ],
    },

    // ── Opaque blocks ───────────────────────────────────────────────────────
    // Display math is an atom in the document flow; its LaTeX lives in `math`
    // and is edited through a dedicated node view rather than as inline text,
    // so the surrounding prose can never be corrupted by a half-typed formula.
    math_block: {
      group: 'block',
      atom: true,
      draggable: true,
      attrs: {
        ...sourceAttrs(),
        math: { default: '' },
        // 'bracket' → \[...\], 'dollars' → $$...$$, 'env' → \begin{equation}
        delim: { default: 'bracket' },
        envName: { default: '' },
      },
      toDOM: (node) => ['div', { class: 'ltx-math-block' }, node.attrs.math],
    },

    // Everything the model does not understand: figures, tables, tikz, code,
    // the preamble, comments, `\maketitle`, unrecognized environments. The
    // node is never re-serialized from the model — `raw` is written back
    // unchanged — which is what makes it safe to open arbitrary documents.
    latex_raw: {
      group: 'block',
      atom: true,
      draggable: true,
      attrs: {
        ...sourceAttrs(),
        kind: { default: 'environment' },
        // The originating block from `parseLatexBlocks`, used by the node view
        // to render a preview (figure image, table grid, tikz SVG, ...).
        data: { default: null },
      },
      toDOM: (node) => ['div', { class: `ltx-raw ltx-raw-${node.attrs.kind}` }, node.attrs.raw || ''],
    },

    // ── Inline ──────────────────────────────────────────────────────────────
    text: { group: 'inline' },

    math_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        math: { default: '' },
        // 'dollar' → $...$, 'paren' → \(...\)
        delim: { default: 'dollar' },
      },
      toDOM: (node) => ['span', { class: 'ltx-math-inline' }, node.attrs.math],
    },

    // `\footnote{...}` and its relatives. A note is not part of the sentence —
    // it compiles to a marker here and text at the foot of the page — so it
    // renders as a marker rather than being spliced inline, which would read
    // as if the author had written the note into the paragraph. The note text
    // is available on hover; editing it means going to the source.
    footnote: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        // The whole command, verbatim. It is what gets written back, so an
        // optional argument (`\footnote[3]{...}`) survives untouched.
        raw: { default: '' },
        content: { default: '' },
      },
      toDOM: (node) => [
        'sup',
        { class: 'ltx-footnote', title: latexToPlainText(node.attrs.content) },
        '\u2020',
      ],
    },

    // Any inline construct outside the modelled subset: `\ref{}`, `\cite{}`,
    // `\includegraphics`, user macros. Carries its full source
    // (command plus balanced arguments) and is written back untouched.
    inline_raw: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { raw: { default: '' } },
      toDOM: (node) => ['span', { class: 'ltx-inline-raw' }, node.attrs.raw],
    },

    // `\\` — an explicit line break inside a paragraph.
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      attrs: { raw: { default: '\\\\' } },
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
  },

  // Mark order is significant: `toLatex.js` emits nested commands following
  // the order declared here, so `strong` before `em` makes the canonical form
  // `\textbf{\textit{x}}`.
  marks: {
    // A scope in the inline source, in any of the three shapes that occur:
    //
    //     {\Huge\bfseries x}   braces carrying font declarations
    //     \small x             a bare declaration, to the end of its scope
    //     1{,}5                braces that only group
    //
    // Font declarations take no argument, so they are modelled as a mark over
    // whatever they affect rather than as a command wrapping an argument; a
    // grouping-only brace pair is the same shape with no declarations.
    //
    // `prefix` holds the declaration run verbatim, including the whitespace
    // that terminates it (empty for a grouping-only pair), so the scope is
    // written back exactly as written. `braced` records whether the source
    // used a group. `depth` records how deeply the scope was nested, which is
    // what lets the serializer restore the original nesting order when two
    // scopes overlap — ProseMirror keeps same-type marks in insertion order,
    // not source order. `key` distinguishes one braced group from the next so
    // that adjacent ones are never merged: `sha{f}{f}le` breaks a ligature
    // and must not become `sha{ff}le`.
    //
    // `excludes: ''` is required: a mark type excludes itself by default,
    // which would make a nested scope replace its enclosing one.
    scope: {
      attrs: {
        prefix: { default: '' },
        braced: { default: true },
        depth: { default: 0 },
        key: { default: null },
      },
      excludes: '',
      toDOM: (mark) => ['span', { style: styleToCss(declarationStyle(mark.attrs.prefix)) }, 0],
    },
    strong: {
      toDOM: () => ['strong', 0],
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    },
    em: {
      // `\textit` and `\emph` render the same but are not interchangeable in
      // source; the original command is preserved.
      attrs: { cmd: { default: 'textit' } },
      toDOM: () => ['em', 0],
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    },
    underline: {
      toDOM: () => ['u', 0],
      parseDOM: [{ tag: 'u' }],
    },
    smallcaps: {
      toDOM: () => ['span', { class: 'ltx-sc' }, 0],
    },
    code: {
      toDOM: () => ['code', 0],
      parseDOM: [{ tag: 'code' }],
    },
  },
});

// React-style style objects into the CSS text a DOM spec needs.
function styleToCss(style) {
  return Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';');
}

// Mark name → the LaTeX text that opens and closes it. Kept next to the schema
// so adding a mark forces deciding how it is written back.
//
// Most marks wrap their content in a command argument; a declaration scope
// does not, which is why this maps to an explicit open/close pair rather than
// to a command name.
export const MARK_WRAPPERS = {
  // A declaration without braces runs to the end of its scope, so it may only
  // be written that way when the scope it is being emitted into is the one it
  // came from: at the top of its scope (`depth === 0`) and with nothing
  // wrapped around it here (`outermost`).
  //
  // Otherwise it must be braced. `\textbf{\small x}` is the case that forces
  // this: ProseMirror orders marks by schema rank, so the declaration comes
  // back out ahead of the `\textbf`, and writing it bare there would extend
  // it over the rest of the paragraph instead of just that argument. Bracing
  // gives `{\small \textbf{x}}` — the same scope the source had, at the cost
  // of not being byte-identical for this shape.
  scope: (mark, context = {}) => {
    const braced = mark.attrs.braced || mark.attrs.depth > 0 || context.outermost === false;
    return braced
      ? { open: `{${mark.attrs.prefix}`, close: '}' }
      : { open: mark.attrs.prefix, close: '' };
  },
  strong: () => ({ open: '\\textbf{', close: '}' }),
  em: (mark) => ({ open: `\\${mark.attrs.cmd || 'textit'}{`, close: '}' }),
  underline: () => ({ open: '\\underline{', close: '}' }),
  smallcaps: () => ({ open: '\\textsc{', close: '}' }),
  code: () => ({ open: '\\texttt{', close: '}' }),
};

// LaTeX command → { mark, attrs }. The inverse of MARK_COMMANDS, used by the
// inline parser.
export const COMMAND_MARKS = {
  textbf: { mark: 'strong', attrs: {} },
  textit: { mark: 'em', attrs: { cmd: 'textit' } },
  emph: { mark: 'em', attrs: { cmd: 'emph' } },
  underline: { mark: 'underline', attrs: {} },
  textsc: { mark: 'smallcaps', attrs: {} },
  texttt: { mark: 'code', attrs: {} },
};
