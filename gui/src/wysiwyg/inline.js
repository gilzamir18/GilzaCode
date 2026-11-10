// ─────────────────────────────────────────────────────────────────────────────
// inline.js
//
// Inline LaTeX ↔ ProseMirror inline content.
//
// This is the layer that turns `\textbf{a $x^2$ b}` into real marks and atoms
// and back. It matters most for *edited* paragraphs: an untouched paragraph is
// written back from its `raw` slice and never passes through here, but as soon
// as the user types a character the whole paragraph is rebuilt from the model.
// Anything this file does not round-trip exactly becomes source drift the user
// did not ask for, so the rules are deliberately narrow:
//
//   - A fixed, bijective table of escapes and ligatures is decoded into real
//     characters (`\%` → `%`, `---` → `—`, `` `` `` → `“`).
//   - A fixed set of formatting commands becomes marks.
//   - Math becomes an atom holding its own source.
//   - **Everything else is captured verbatim** into an `inline_raw` atom,
//     including its balanced arguments, so `\cite{foo}` survives as one unit.
//
// Whitespace is the one deliberate normalization: runs of spaces/newlines
// collapse to a single space, because the model has no concept of source line
// wrapping. Hard wrapping therefore survives until you edit a paragraph, and
// is lost on that paragraph when you do.
// ─────────────────────────────────────────────────────────────────────────────

import { COMMAND_MARKS, MARK_WRAPPERS } from './schema.js';
import { matchDeclarationRun } from '../utils/latexFontDeclarations.js';
import { isTransparentGroup } from '../utils/latexBraceGroups.js';
import { NOTE_COMMANDS, findCommandWithArgument } from '../utils/latexInlineCommands.js';

// ── Character-level bijection ───────────────────────────────────────────────
// Decoded on parse, re-encoded on serialize. Every entry must be reversible;
// a one-way mapping here shows up as source churn on the next save.
const ESCAPED_CHARS = ['%', '&', '_', '#', '$', '{', '}'];

const LIGATURES = [
  ['---', '—'], // em dash
  ['--', '–'],  // en dash
  ['``', '“'],  // left double quote
  ["''", '”'],  // right double quote
];

const NBSP = ' ';

// Commands that take exactly one brace argument and map onto a mark.
const MARK_COMMAND_NAMES = new Set(Object.keys(COMMAND_MARKS));

// ── Brace/bracket scanning ──────────────────────────────────────────────────

function findMatchingBrace(s, openPos) {
  let depth = 0;
  for (let i = openPos; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findMatchingBracket(s, openPos) {
  let depth = 0;
  for (let i = openPos; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Consumes the balanced `[opt]` and `{arg}` groups that follow a command at
// `cursor`, so an unmodelled command is captured together with its arguments
// instead of leaking braces into the text.
function consumeCommandArgs(src, cursor) {
  let i = cursor;
  for (;;) {
    if (src[i] === '{') {
      const close = findMatchingBrace(src, i);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (src[i] === '[') {
      const close = findMatchingBracket(src, i);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    break;
  }
  return i;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a run of inline LaTeX into ProseMirror inline nodes.
 *
 * @param {string} src - inline LaTeX (the body of a paragraph, heading, ...)
 * @param {import('prosemirror-model').Schema} schema
 * @param {object} [options]
 * @param {boolean} [options.collapseWhitespace=true] - collapse whitespace runs
 *   to a single space. Disabled when parsing something whose layout matters.
 * @returns {Array<import('prosemirror-model').Node>}
 */
export function parseInline(src, schema, options = {}) {
  const { collapseWhitespace = true, declDepth = 0 } = options;
  const nodes = [];
  const text = src || '';
  let buf = '';
  let i = 0;

  const flush = () => {
    if (!buf) return;
    nodes.push(schema.text(buf));
    buf = '';
  };

  const pushAtom = (node) => { flush(); nodes.push(node); };

  while (i < text.length) {
    const c = text[i];

    // ── Comment: `%` to end of line, newline included ────────────────────
    // Kept verbatim; a comment is the one place where the trailing newline is
    // semantically load-bearing (it is what the `%` suppresses).
    if (c === '%' ) {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl + 1;
      pushAtom(schema.nodes.inline_raw.create({ raw: text.slice(i, end) }));
      i = end;
      continue;
    }

    if (c === '\\') {
      const next = text[i + 1];

      // ── Explicit line break: `\\`, optionally `\\[2ex]` ─────────────────
      if (next === '\\') {
        let end = i + 2;
        if (text[end] === '[') {
          const close = findMatchingBracket(text, end);
          if (close !== -1) end = close + 1;
        }
        pushAtom(schema.nodes.hard_break.create({ raw: text.slice(i, end) }));
        i = end;
        continue;
      }

      // ── Inline math: `\(...\)` ──────────────────────────────────────────
      if (next === '(') {
        const close = text.indexOf('\\)', i + 2);
        if (close !== -1) {
          pushAtom(schema.nodes.math_inline.create({
            math: text.slice(i + 2, close),
            delim: 'paren',
          }));
          i = close + 2;
          continue;
        }
      }

      // ── Escaped character: `\%`, `\&`, `\_`, `\#`, `\$`, `\{`, `\}` ─────
      if (next && ESCAPED_CHARS.includes(next)) {
        buf += next;
        i += 2;
        continue;
      }

      // ── Font declaration: `\small ...`, `\bfseries ...` ────────────────
      // A declaration takes no argument and applies to the end of its scope,
      // so it becomes a mark over everything that follows rather than a
      // wrapper around an argument. Without this it would be captured as an
      // unmodelled command and shown as literal `\small` in the text.
      const bareDecl = matchDeclarationRun(text, i);
      if (bareDecl) {
        const rest = parseInline(text.slice(bareDecl.end), schema, {
          ...options,
          declDepth: declDepth + 1,
        });
        flush();
        const mark = schema.marks.scope.create({
          prefix: bareDecl.prefix,
          braced: false,
          depth: declDepth,
        });
        for (const child of rest) nodes.push(child.mark(mark.addToSet(child.marks)));
        i = text.length;
        continue;
      }

      // ── Command ─────────────────────────────────────────────────────────
      const nameMatch = /^[a-zA-Z]+\*?/.exec(text.slice(i + 1));
      if (nameMatch) {
        const name = nameMatch[0];
        const afterName = i + 1 + name.length;

        // A note command keeps its whole source and renders as a marker. It
        // is matched with brace counting, not a regex: a footnote routinely
        // contains `\textit{...}`, and stopping at the first `}` would cut
        // the argument in half.
        if (NOTE_COMMANDS.has(name)) {
          const note = findCommandWithArgument(text, i);
          if (note && note.start === i) {
            pushAtom(schema.nodes.footnote.create({
              raw: text.slice(i, note.end),
              content: text.slice(note.argStart, note.argEnd),
            }));
            i = note.end;
            continue;
          }
        }

        // A formatting command with a single brace argument becomes a mark
        // applied to its recursively parsed content.
        if (MARK_COMMAND_NAMES.has(name) && text[afterName] === '{') {
          const close = findMatchingBrace(text, afterName);
          if (close !== -1) {
            const spec = COMMAND_MARKS[name];
            const mark = schema.marks[spec.mark].create(spec.attrs);
            const inner = parseInline(text.slice(afterName + 1, close), schema, {
              ...options,
              declDepth: declDepth + 1,
            });
            flush();
            for (const child of inner) nodes.push(child.mark(mark.addToSet(child.marks)));
            i = close + 1;
            continue;
          }
        }

        // Anything else is captured with its arguments and written back as-is.
        const end = consumeCommandArgs(text, afterName);
        pushAtom(schema.nodes.inline_raw.create({ raw: text.slice(i, end) }));
        i = end;
        continue;
      }

      // A backslash followed by punctuation (`\,`, `\;`, `\ `) — spacing
      // commands and friends. Keep the two characters verbatim.
      pushAtom(schema.nodes.inline_raw.create({ raw: text.slice(i, i + 2) }));
      i += 2;
      continue;
    }

    // ── Inline math: `$...$` ─────────────────────────────────────────────
    if (c === '$') {
      const close = findDollarEnd(text, i + 1);
      if (close !== -1) {
        pushAtom(schema.nodes.math_inline.create({
          math: text.slice(i + 1, close),
          delim: 'dollar',
        }));
        i = close + 1;
        continue;
      }
    }

    // ── Brace group ──────────────────────────────────────────────────────
    // A group whose first token is a font declaration is exactly the
    // `{\Huge\bfseries ...}` idiom: the braces are there to scope the
    // declaration, so the group becomes a mark over its content.
    //
    // A group that opens with anything else is left alone. What such a group
    // means depends on what is inside it, and preserving it whole is the
    // honest option — guessing is how markup ends up silently altered.
    if (c === '{') {
      const close = findMatchingBrace(text, i);
      if (close !== -1) {
        const groupDecl = matchDeclarationRun(text, i + 1);
        if (groupDecl && groupDecl.end <= close) {
          const inner = parseInline(text.slice(groupDecl.end, close), schema, {
            ...options,
            declDepth: declDepth + 1,
          });
          flush();
          const mark = schema.marks.scope.create({
            prefix: groupDecl.prefix,
            braced: true,
            depth: declDepth,
            key: i,
          });
          for (const child of inner) nodes.push(child.mark(mark.addToSet(child.marks)));
          i = close + 1;
          continue;
        }
        // Braces that only group — `1{,}5`, `sha{f}{f}le`. The content is
        // shown without them, but they are kept in `braced` so the source
        // still compiles the same: `{f}{f}` is how an "ff" ligature is
        // broken, and dropping the braces would change the output.
        const groupContent = text.slice(i + 1, close);
        if (isTransparentGroup(groupContent)) {
          const inner = parseInline(groupContent, schema, {
            ...options,
            declDepth: declDepth + 1,
          });
          flush();
          if (inner.length) {
            const mark = schema.marks.scope.create({
              prefix: '',
              braced: true,
              depth: declDepth,
              key: i,
            });
            for (const child of inner) nodes.push(child.mark(mark.addToSet(child.marks)));
          } else {
            // An empty group has no content to carry the mark, so it stays an
            // atom rather than vanishing.
            nodes.push(schema.nodes.inline_raw.create({ raw: text.slice(i, close + 1) }));
          }
          i = close + 1;
          continue;
        }

        pushAtom(schema.nodes.inline_raw.create({ raw: text.slice(i, close + 1) }));
        i = close + 1;
        continue;
      }
    }

    // ── Non-breaking space ───────────────────────────────────────────────
    if (c === '~') {
      buf += NBSP;
      i += 1;
      continue;
    }

    // ── Ligatures ────────────────────────────────────────────────────────
    const ligature = LIGATURES.find(([source]) => text.startsWith(source, i));
    if (ligature) {
      buf += ligature[1];
      i += ligature[0].length;
      continue;
    }

    // ── Whitespace ───────────────────────────────────────────────────────
    if (collapseWhitespace && /\s/.test(c)) {
      const run = /^\s+/.exec(text.slice(i))[0];
      buf += ' ';
      i += run.length;
      continue;
    }

    buf += c;
    i += 1;
  }

  flush();
  return nodes;
}

// Finds the closing `$` of an inline math span, skipping escaped dollars.
function findDollarEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$') return i;
    i += 1;
  }
  return -1;
}

// ── Serializing ─────────────────────────────────────────────────────────────

/**
 * Serialize ProseMirror inline content back to LaTeX.
 *
 * Marks are emitted following schema declaration order (`node.marks` is
 * already sorted by ProseMirror), which gives a single canonical nesting for
 * any given set of marks: `\textbf{\textit{x}}`, never the other way round.
 *
 * @param {import('prosemirror-model').Fragment|import('prosemirror-model').Node} content
 * @returns {string} LaTeX source
 */
export function serializeInline(content) {
  const fragment = content?.content ?? content;
  let out = '';
  const active = [];

  const closeTo = (depth) => {
    while (active.length > depth) out += active.pop().close;
  };

  fragment.forEach((node) => {
    const marks = orderMarks(node.marks);

    // Close the marks that are no longer active, keeping the common prefix
    // open so adjacent nodes sharing a mark stay inside one command.
    let common = 0;
    while (common < active.length && common < marks.length && marks[common].eq(active[common].mark)) {
      common += 1;
    }
    closeTo(common);

    for (let k = common; k < marks.length; k++) {
      const mark = marks[k];
      const wrapper = MARK_WRAPPERS[mark.type.name];
      if (!wrapper) continue;
      const { open, close } = wrapper(mark, { outermost: k === 0 });
      out += open;
      active.push({ mark, close });
    }

    out += serializeInlineNode(node);
  });

  closeTo(0);
  return out;
}

// ProseMirror keeps marks in schema order, but orders marks of the *same*
// type by when they were added — which, for declaration scopes, is innermost
// first. Restoring source order within each same-type run is what makes
// `\small {\bfseries x}` come back out that way round instead of inverted.
// Runs of different types are left exactly where the schema put them.
function orderMarks(marks) {
  if (marks.length < 2) return marks;
  const ordered = [];
  let i = 0;
  while (i < marks.length) {
    let j = i;
    while (j < marks.length && marks[j].type === marks[i].type) j += 1;
    const run = marks.slice(i, j);
    if (run.length > 1) run.sort((a, b) => (a.attrs.depth ?? 0) - (b.attrs.depth ?? 0));
    ordered.push(...run);
    i = j;
  }
  return ordered;
}

function serializeInlineNode(node) {
  switch (node.type.name) {
    case 'text':
      return encodeText(node.text || '');
    case 'math_inline':
      return node.attrs.delim === 'paren'
        ? `\\(${node.attrs.math}\\)`
        : `$${node.attrs.math}$`;
    case 'footnote':
    case 'inline_raw':
      return node.attrs.raw || '';
    case 'hard_break':
      return node.attrs.raw || '\\\\';
    default:
      return '';
  }
}

/**
 * Re-encode a plain text run as LaTeX, inverting the decoding done by
 * `parseInline`. A literal backslash cannot have come from the parser (it
 * always produces an atom), so one typed by the user is escaped explicitly.
 */
export function encodeText(text) {
  let out = '';
  for (const ch of text) {
    if (ch === '\\') { out += '\\textbackslash{}'; continue; }
    if (ESCAPED_CHARS.includes(ch)) { out += `\\${ch}`; continue; }
    if (ch === NBSP) { out += '~'; continue; }
    const ligature = LIGATURES.find(([, decoded]) => decoded === ch);
    if (ligature) { out += ligature[0]; continue; }
    out += ch;
  }
  return out;
}

/**
 * Collapse whitespace the same way `parseInline` does. Exposed so callers can
 * check whether a given source slice is already in normalized form (and hence
 * round-trips exactly through the inline layer).
 */
export function normalizeInlineWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ');
}
