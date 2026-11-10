// ─────────────────────────────────────────────────────────────────────────────
// toLatex.js
//
// ProseMirror document → LaTeX source.
//
// The contract this file exists to uphold:
//
//   **A node the user did not touch is written back byte-for-byte.**
//
// Every node built by `fromLatex` carries the source slice it came from
// (`raw`) and the text that followed it (`tail`). Before rebuilding a node
// from the model, the serializer compares it against the pristine version
// recorded at parse time; if they are identical, the original bytes are
// emitted and the model is never consulted. Only what actually changed gets
// re-serialized.
//
// That is what makes this safe to point at somebody else's LaTeX: opening a
// document, editing one word and saving touches exactly one paragraph. Without
// it, a model-driven WYSIWYG normalizes the entire file on first save —
// reflowing text, dropping comments, reordering optional arguments — which for
// a version-controlled `.tex` is a far worse bug than any missing feature.
// ─────────────────────────────────────────────────────────────────────────────

import { serializeInline, encodeText } from './inline.js';

// Re-attaches the whitespace that `fromLatex` split off a node's inline
// content, so rebuilding a paragraph keeps the line break that introduced it.
function inlineWithAffixes(node) {
  return `${node.attrs.head ?? ''}${serializeInline(node)}${node.attrs.foot ?? ''}`;
}

/**
 * Serialize a document back to LaTeX.
 *
 * @param {import('prosemirror-model').Node} doc
 * @param {{pristine: Map, head?: string}} binding - the value returned by
 *   `fromLatex` for the document this one was derived from.
 * @returns {string} LaTeX source
 */
export function toLatex(doc, binding) {
  const ctx = {
    pristine: binding?.pristine || new Map(),
    // A block id can appear more than once after a split or a paste. Only the
    // first occurrence may claim the original bytes; the rest are rebuilt.
    consumed: new Set(),
  };
  return (binding?.head || '') + serializeFragment(doc.content, ctx);
}

function serializeFragment(fragment, ctx) {
  let out = '';
  fragment.forEach((node) => {
    out += serializeBlockNode(node, ctx);
    out += node.attrs.tail ?? '';
  });
  return out;
}

function serializeBlockNode(node, ctx) {
  // Opaque blocks are never rebuilt from the model — they have no model to
  // rebuild from. Their source is the whole of their content.
  if (node.type.name === 'latex_raw') return node.attrs.raw ?? '';
  if (isUnchanged(node, ctx)) return node.attrs.raw;
  return rebuild(node, ctx);
}

function isUnchanged(node, ctx) {
  const id = node.attrs.blockId;
  if (!id || node.attrs.raw == null) return false;
  if (ctx.consumed.has(id)) return false;
  const pristine = ctx.pristine.get(id);
  if (!pristine || !node.eq(pristine)) return false;
  ctx.consumed.add(id);
  return true;
}

// True when a container's title child still matches what was parsed, meaning
// the original `\begin{frame}[...]{...}` header can be reused untouched.
function titleUnchanged(titleNode, ctx) {
  const id = titleNode?.attrs?.blockId;
  if (!id) return false;
  const pristine = ctx.pristine.get(id);
  return !!pristine && titleNode.eq(pristine);
}

function rebuild(node, ctx) {
  const attrs = node.attrs;

  switch (node.type.name) {
    case 'paragraph':
      return inlineWithAffixes(node);

    case 'heading':
      return `${attrs.prefix || '\\section'}{${inlineWithAffixes(node)}}`;

    case 'frametitle':
      return `\\frametitle{${inlineWithAffixes(node)}}`;

    case 'list':
      return wrapEnv(attrs.envName, attrs.bodyHead, serializeFragment(node.content, ctx));

    case 'list_item': {
      const header = attrs.headerRaw ?? buildItemHeader(node);
      return `${header}${attrs.bodyHead ?? ''}${serializeFragment(node.content, ctx)}`;
    }

    case 'quote_block':
      return wrapEnv(attrs.envName || 'quote', attrs.bodyHead, serializeFragment(node.content, ctx));

    case 'abstract_block':
      return wrapEnv('abstract', attrs.bodyHead, serializeFragment(node.content, ctx));

    case 'align_block':
      return wrapEnv(attrs.align || 'center', attrs.bodyHead, serializeFragment(node.content, ctx));

    case 'container': {
      const title = node.child(0);
      const header = (attrs.headerRaw != null && titleUnchanged(title, ctx))
        ? attrs.headerRaw
        : buildContainerHeader(node, title);
      // Child 0 is the title, which lives in the header rather than the body.
      const body = serializeFragment(node.content.cut(title.nodeSize), ctx);
      return `${header}${attrs.bodyHead ?? ''}${body}\\end{${attrs.envName}}`;
    }

    case 'env_block':
    case 'columns_block':
    case 'column_block':
      return `${headerFor(node)}${attrs.bodyHead ?? ''}${serializeFragment(node.content, ctx)}${footerFor(node)}`;

    case 'math_block':
      return buildMath(attrs);

    default:
      return attrs.raw ?? '';
  }
}

// The boundary of a verbatim-wrapped node. `headerRaw`/`footerRaw` hold the
// original text whenever the node came from the file; the rebuilt forms below
// only apply to a wrapper created in the editor, which has no source yet.
function headerFor(node) {
  const attrs = node.attrs;
  if (attrs.headerRaw != null) return attrs.headerRaw;
  switch (node.type.name) {
    case 'columns_block':
      return '\\begin{columns}';
    case 'column_block':
      return attrs.form === 'environment'
        ? `\\begin{column}{${formatColumnWidth(attrs.width)}}`
        : `\\column{${formatColumnWidth(attrs.width)}}`;
    default:
      return `\\begin{${attrs.envName}}`;
  }
}

function footerFor(node) {
  const attrs = node.attrs;
  if (attrs.footerRaw != null) return attrs.footerRaw;
  switch (node.type.name) {
    case 'columns_block':
      return '\\end{columns}';
    case 'column_block':
      // A marker-style column has no closing text — it ends where the next
      // one begins.
      return attrs.form === 'environment' ? '\\end{column}' : '';
    default:
      return `\\end{${attrs.envName}}`;
  }
}

function formatColumnWidth(width) {
  return `${width || 0.5}\\textwidth`;
}

function wrapEnv(envName, bodyHead, body) {
  return `\\begin{${envName}}${bodyHead ?? ''}${body}\\end{${envName}}`;
}

function buildItemHeader(node) {
  const { hasTerm, term } = node.attrs;
  return hasTerm ? `\\item[${encodeText(term || '')}]` : '\\item';
}

function buildContainerHeader(node, titleNode) {
  const { envName, frameOptions, subtitle } = node.attrs;
  const title = inlineWithAffixes(titleNode);
  if (envName === 'frame') {
    const titleArg = title ? `{${title}}` : '';
    const subtitleArg = title && subtitle ? `{${subtitle}}` : '';
    return `\\begin{frame}${frameOptions || ''}${titleArg}${subtitleArg}`;
  }
  return `\\begin{${envName}}{${title}}`;
}

function buildMath(attrs) {
  const math = attrs.math || '';
  switch (attrs.delim) {
    case 'dollars':
      return `$$${math}$$`;
    case 'env':
      return `\\begin{${attrs.envName}}${math}\\end{${attrs.envName}}`;
    case 'bracket':
    default:
      return `\\[${math}\\]`;
  }
}
