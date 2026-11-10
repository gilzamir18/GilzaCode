// ─────────────────────────────────────────────────────────────────────────────
// fromLatex.js
//
// LaTeX source → ProseMirror document.
//
// The block structure comes from `parseLatexBlocks`, which is already the
// battle-tested scanner behind the block-preview Rich Text mode. This file
// does not re-parse LaTeX; it turns those offset-tagged blocks into a real
// document model and records everything needed to write the file back
// unchanged:
//
//   - `raw`  — the exact source slice each node came from.
//   - `tail` — the source between a node's end and its next sibling's start,
//              so separators belong to the node that owns them.
//   - `bodyHead` — the gap between a container's opening tag and its first
//              child, so indentation inside `frame`/`itemize` survives.
//
// Together these cover every byte of the file: concatenating each node's
// source and tail reproduces the input exactly. `toLatex.js` relies on that.
//
// A `pristine` map (blockId → node as first built) is returned alongside the
// document. Comparing a node against its pristine twin is how the serializer
// knows whether `raw` is still valid, which is what keeps untouched LaTeX from
// being reformatted when the user edits something else.
// ─────────────────────────────────────────────────────────────────────────────

import { schema } from './schema.js';
import { parseInline } from './inline.js';
import { parseLatexBlocks } from '../utils/latexBlockParser.js';

// Splits the whitespace surrounding a node's inline text off into structural
// attributes. The text field of a prose block routinely starts with the
// newline that separated it from the previous construct; keeping that inside
// the inline content would surface as a stray leading space in the editor and
// collapse the line break on the way back out.
function splitAffixes(text) {
  const value = text || '';
  const head = /^\s*/.exec(value)[0];
  if (head.length === value.length) return { head: value, body: '', foot: '' };
  const foot = /\s*$/.exec(value)[0];
  return { head, body: value.slice(head.length, value.length - foot.length), foot };
}

// Parser block types that carry no editable structure. They are preserved
// verbatim and rendered by a preview node view.
const RAW_KINDS = new Set([
  'preamble', 'comment', 'table', 'figure', 'graphic',
  'code', 'environment', 'titlepage', 'maketitle',
]);

/**
 * Build a ProseMirror document from LaTeX source.
 *
 * @param {string} source - the full `.tex` content
 * @returns {{doc: import('prosemirror-model').Node,
 *            pristine: Map<string, import('prosemirror-model').Node>,
 *            head: string,
 *            source: string}}
 *   `head` is any source before the first block (empty for well-formed
 *   documents, where the preamble block starts at offset 0).
 */
export function fromLatex(source) {
  const src = source || '';
  const blocks = parseLatexBlocks(src);
  const ctx = { src, pristine: new Map(), nextId: 1 };

  if (!blocks.length) {
    const empty = schema.nodes.paragraph.create({ blockId: 'b0', raw: null, tail: '' });
    return { doc: schema.nodes.doc.create(null, [empty]), pristine: ctx.pristine, head: src, source: src };
  }

  const head = src.slice(0, blocks[0].start);
  const nodes = buildSiblings(blocks, ctx, src.length);
  return {
    doc: schema.nodes.doc.create(null, nodes),
    pristine: ctx.pristine,
    head,
    source: src,
  };
}

// Builds a run of sibling blocks, giving each one the source text that
// separates it from the next sibling (or from `rangeEnd` for the last one).
function buildSiblings(blocks, ctx, rangeEnd) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextStart = i + 1 < blocks.length ? blocks[i + 1].start : rangeEnd;
    const tail = ctx.src.slice(block.end, Math.max(block.end, nextStart));
    const node = buildBlock(block, tail, ctx);
    if (node) out.push(node);
  }
  return out;
}

// Builds the children of a container-like block whose body spans
// [bodyStart, bodyEnd), returning the leading gap plus the child nodes.
function buildBody(block, children, ctx) {
  const { bodyStart, bodyEnd } = block;
  const list = children || [];
  const bodyHead = ctx.src.slice(bodyStart, list.length ? list[0].start : bodyEnd);
  const nodes = buildSiblings(list, ctx, bodyEnd);
  // Schema requires `block+` for these wrappers; an environment with an empty
  // body still needs one child. The gap already holds the original text, so
  // the placeholder contributes nothing on the way back out.
  if (!nodes.length) {
    nodes.push(schema.nodes.paragraph.create({ blockId: newId(ctx), raw: null, tail: '' }));
  }
  return { bodyHead, nodes };
}

// The verbatim text on either side of a wrapper's body: its opening tag with
// arguments, and its closing tag (empty for a marker-style `\column`).
function boundary(block, ctx) {
  return {
    headerRaw: ctx.src.slice(block.start, block.bodyStart),
    footerRaw: ctx.src.slice(block.bodyEnd, block.end),
  };
}

function newId(ctx) {
  return `b${ctx.nextId++}`;
}

// Records the node as the pristine version of its block, so the serializer can
// later tell whether the user changed it.
function remember(ctx, node) {
  if (node?.attrs?.blockId) ctx.pristine.set(node.attrs.blockId, node);
  return node;
}

function buildBlock(block, tail, ctx) {
  const blockId = newId(ctx);
  const raw = ctx.src.slice(block.start, block.end);
  const base = { blockId, raw, tail };

  switch (block.type) {
    case 'paragraph': {
      const { head, body, foot } = splitAffixes(block.text);
      return remember(ctx, schema.nodes.paragraph.create(
        { ...base, head, foot },
        parseInline(body, schema),
      ));
    }

    case 'heading': {
      const { head, body, foot } = splitAffixes(block.text);
      return remember(ctx, schema.nodes.heading.create(
        { ...base, head, foot, level: block.level || 2, prefix: block.headingPrefix || '\\section' },
        parseInline(body, schema),
      ));
    }

    case 'frametitle': {
      const { head, body, foot } = splitAffixes(block.text);
      return remember(ctx, schema.nodes.frametitle.create({ ...base, head, foot }, parseInline(body, schema)));
    }

    case 'list': {
      const { bodyHead, nodes } = buildBody(block, block.items, ctx);
      return remember(ctx, schema.nodes.list.create(
        { ...base, bodyHead, envName: block.envName || block.listType || 'itemize' },
        nodes,
      ));
    }

    case 'listitem': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      return remember(ctx, schema.nodes.list_item.create(
        {
          ...base,
          bodyHead,
          term: block.term || '',
          hasTerm: !!block.hasTerm,
          headerRaw: ctx.src.slice(block.start, block.bodyStart),
        },
        nodes,
      ));
    }

    case 'abstract': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      return remember(ctx, schema.nodes.abstract_block.create({ ...base, bodyHead }, nodes));
    }

    case 'align': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      return remember(ctx, schema.nodes.align_block.create(
        { ...base, bodyHead, align: block.align || 'center' },
        nodes,
      ));
    }

    case 'container': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      const titleAffixes = splitAffixes(block.title);
      const title = schema.nodes.container_title.create(
        { blockId: `${blockId}:title`, head: titleAffixes.head, foot: titleAffixes.foot },
        parseInline(titleAffixes.body, schema),
      );
      remember(ctx, title);
      return remember(ctx, schema.nodes.container.create(
        {
          ...base,
          bodyHead,
          envName: block.envName || 'frame',
          frameOptions: block.frameOptions || '',
          subtitle: block.subtitle || '',
          headerRaw: ctx.src.slice(block.start, block.bodyStart),
        },
        [title, ...nodes],
      ));
    }

    // The parser hands back a quote's body as flat text with no offsets, so
    // the body is re-parsed from its own slice and the resulting offsets are
    // shifted into document coordinates. This buys real structure inside a
    // quote (nested lists, math) instead of one opaque text field.
    case 'quote': {
      const openTag = `\\begin{${block.envName}}`;
      const closeTag = `\\end{${block.envName}}`;
      const bodyStart = block.start + openTag.length;
      const bodyEnd = block.end - closeTag.length;
      const children = shiftBlocks(parseLatexBlocks(ctx.src.slice(bodyStart, bodyEnd)), bodyStart);
      const { bodyHead, nodes } = buildBody({ bodyStart, bodyEnd }, children, ctx);
      return remember(ctx, schema.nodes.quote_block.create(
        { ...base, bodyHead, envName: block.envName || 'quote' },
        nodes,
      ));
    }

    // Any environment without dedicated handling. Only its boundary is
    // modelled; the body is ordinary block content, which is what keeps an
    // unknown wrapper from costing the structure nested inside it.
    case 'envblock': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      return remember(ctx, schema.nodes.env_block.create(
        { ...base, bodyHead, ...boundary(block, ctx), envName: block.envName || '' },
        nodes,
      ));
    }

    case 'columns': {
      const columns = (block.children || []).map((column, index) => {
        const next = index + 1 < block.children.length ? block.children[index + 1].start : block.bodyEnd;
        return buildBlock(column, ctx.src.slice(column.end, Math.max(column.end, next)), ctx);
      });
      // `columns_block` accepts nothing but columns, so a body the splitter
      // found none in cannot be represented — the parser already falls back to
      // a generic container in that case, and this guards the invariant.
      if (!columns.length) {
        return remember(ctx, schema.nodes.latex_raw.create({ ...base, kind: 'environment', data: block }));
      }
      const bodyHead = ctx.src.slice(block.bodyStart, block.children[0].start);
      return remember(ctx, schema.nodes.columns_block.create(
        { ...base, bodyHead, ...boundary(block, ctx) },
        columns,
      ));
    }

    case 'column': {
      const { bodyHead, nodes } = buildBody(block, block.children, ctx);
      return remember(ctx, schema.nodes.column_block.create(
        {
          ...base,
          bodyHead,
          ...boundary(block, ctx),
          width: block.width ?? null,
          form: block.form || 'command',
        },
        nodes,
      ));
    }

    case 'math':
      return remember(ctx, schema.nodes.math_block.create({
        ...base,
        math: block.math || '',
        delim: mathDelim(raw, block),
        envName: block.envName || '',
      }));

    default:
      if (!RAW_KINDS.has(block.type)) {
        // An unmapped block type is still preserved — falling back to a raw
        // atom is always safe, whereas guessing at structure is not.
        return remember(ctx, schema.nodes.latex_raw.create({ ...base, kind: block.type, data: block }));
      }
      return remember(ctx, schema.nodes.latex_raw.create({ ...base, kind: block.type, data: block }));
  }
}

// `\[...\]`, `$$...$$` and `\begin{equation}...` all produce a math block;
// which one is recorded so the delimiters come back the way they went in.
function mathDelim(raw, block) {
  if (raw.startsWith('\\[')) return 'bracket';
  if (raw.startsWith('$$')) return 'dollars';
  if (block.envName) return 'env';
  return 'bracket';
}

// Rebases the offsets of a block tree parsed from a slice back onto the full
// source. Mutates in place — the blocks were just created by the parser and
// have no other owner.
function shiftBlocks(blocks, delta) {
  for (const block of blocks) {
    block.start += delta;
    block.end += delta;
    if (typeof block.bodyStart === 'number') block.bodyStart += delta;
    if (typeof block.bodyEnd === 'number') block.bodyEnd += delta;
    if (block.children) shiftBlocks(block.children, delta);
    if (block.items) shiftBlocks(block.items, delta);
  }
  return blocks;
}
