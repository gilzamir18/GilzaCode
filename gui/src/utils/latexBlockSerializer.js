// ─────────────────────────────────────────────────────────────────────────────
// latexBlockSerializer.js
//
// Serializes Rich Text blocks back into LaTeX source. Used by the
// RichTextEditor to write edits back into the Monaco source via
// `setFileContent` with offset-based splicing.
//
// Only *editable* blocks are serialized (headings, paragraphs, lists, quotes).
// Non-editable blocks (math, figures, tables, code, environments) are kept
// as-is from their original `source` field — they are never modified by the
// Rich Text editor.
//
// Inline markup inside editable text is preserved as LaTeX commands:
//   **bold**   → \textbf{bold}
//   *italic*   → \textit{italic}
//   `code`     → \texttt{code}
//   $math$     → $math$  (kept as-is)
//   "quoted"   becomes ``quoted''
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a single block back to LaTeX source.
 * @param {object} block - a block from parseLatexBlocks
 * @param {string} [originalSource] - the full original source; required for
 *   'container' blocks so their (possibly untouched) header and children can
 *   be spliced from it.
 * @returns {string} LaTeX source for this block
 */
export function serializeBlock(block, originalSource) {
  if (!block) return '';

  // Non-editable blocks: return original source unchanged
  if (!block.editable) {
    return block.source;
  }

  switch (block.type) {
    case 'heading':
      return serializeHeading(block);
    case 'paragraph':
      return serializeParagraph(block);
    case 'list':
      return serializeList(block, originalSource);
    case 'listitem':
      return serializeListItem(block, originalSource);
    case 'quote':
      return serializeQuote(block);
    case 'frametitle':
      return serializeFrametitle(block);
    case 'container':
      return serializeContainer(block, originalSource);
    case 'align':
      return serializeAlign(block, originalSource);
    case 'abstract':
      return serializeAbstract(block, originalSource);
    case 'envblock':
    case 'columns':
    case 'column':
      return serializeBodyEnvironment(block, originalSource);
    // 'graphic' (tikzpicture/PGFPlots) is non-editable; preserve source as-is.
    default:
      return block.source;
  }
}

// Block types that are always re-spliced rather than emitted from their
// captured `source`, because an edit deep inside one of their descendants does
// not mark the wrapper itself dirty. Any container type must be listed here —
// omitting one means edits inside it are silently dropped on save.
const RESPLICED_BLOCK_TYPES = new Set([
  'container', 'list', 'listitem', 'align', 'abstract',
  'envblock', 'columns', 'column',
]);

/**
 * Given the full original source and a list of blocks (some possibly edited),
 * produce a new source string by splicing the serialized blocks into their
 * offset ranges.
 *
 * @param {string} originalSource - the original full LaTeX source
 * @param {Array} blocks - blocks from parseLatexBlocks (possibly with edits)
 * @returns {string} new LaTeX source with edits applied
 */
export function serializeDocument(originalSource, blocks) {
  if (!blocks || !blocks.length) return originalSource;
  return spliceBlocksIntoRange(originalSource, blocks, 0, originalSource.length);
}

/**
 * Splices a list of sibling blocks into a [rangeStart, rangeEnd) window of
 * `originalSource`. Shared by the top-level document splice and by
 * container blocks (frame/block/exampleblock/alertblock), which recursively
 * splice their own `children` into their body range.
 */
function spliceBlocksIntoRange(originalSource, blocks, rangeStart, rangeEnd) {
  // Sort blocks by start offset
  const sorted = [...blocks].sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = rangeStart;

  for (const block of sorted) {
    // Append any gap before this block (text between blocks that wasn't captured)
    if (block.start > cursor) {
      result += originalSource.slice(cursor, block.start);
    }
    // Rewrite only the block that the user edited. Re-serializing every
    // editable block used to normalize unrelated headings/lists whenever a
    // different block was changed, which could alter commands such as
    // \chapter* or \section[short]{long}. Containers are always re-spliced
    // (not just when `edited`) because an edit deep inside a child block
    // does not mark the container itself dirty.
    result += (block.edited || RESPLICED_BLOCK_TYPES.has(block.type))
      ? serializeBlock(block, originalSource)
      : block.source;
    cursor = block.end;
  }

  // Append any trailing content
  if (cursor < rangeEnd) {
    result += originalSource.slice(cursor, rangeEnd);
  }

  return result;
}

// ── Block serializers ───────────────────────────────────────────────────────

function serializeHeading(block) {
  const prefix = block.headingPrefix || levelToCommand(block.level);
  return `${prefix}{${inlineToLatex(block.text)}}`;
}

function serializeParagraph(block) {
  // The text field contains the edited paragraph text.
  // Inline markup is already in LaTeX form (we keep \textbf{}, \textit{}, etc.
  // as-is during editing — the RichTextEditor shows them as styled spans but
  // preserves the LaTeX commands in the text).
  return inlineToLatex(block.text);
}

// Items are spliced into the list's body range the same way a container
// splices its children — this preserves any text before the first `\item`
// or after the last one (typically just whitespace/indentation) verbatim.
function serializeList(block, originalSource) {
  const items = spliceBlocksIntoRange(originalSource, block.items || [], block.bodyStart, block.bodyEnd);
  return `\\begin{${block.envName}}${items}\\end{${block.envName}}`;
}

// An item's body starts right after `\item` (or `\item[term]`), so the
// spliced body already carries whatever whitespace originally followed —
// reconstructing `\item` + term + body reproduces the original formatting
// exactly when nothing in the item was touched.
function serializeListItem(block, originalSource) {
  const term = block.hasTerm ? `[${inlineToLatex(block.term || '')}]` : '';
  const body = spliceBlocksIntoRange(originalSource, block.children || [], block.bodyStart, block.bodyEnd);
  return `\\item${term}${body}`;
}

function serializeQuote(block) {
  const env = 'quote';
  return `\\begin{${env}}\n${inlineToLatex(block.text)}\n\\end{${env}}`;
}

function serializeFrametitle(block) {
  return `\\frametitle{${inlineToLatex(block.text)}}`;
}

function serializeContainer(block, originalSource) {
  const header = serializeContainerHeader(block, originalSource);
  const children = spliceBlocksIntoRange(originalSource, block.children || [], block.bodyStart, block.bodyEnd);
  return `${header}${children}\\end{${block.envName}}`;
}

function serializeAlign(block, originalSource) {
  const children = spliceBlocksIntoRange(originalSource, block.children || [], block.bodyStart, block.bodyEnd);
  return `\\begin{${block.align}}${children}\\end{${block.align}}`;
}

function serializeAbstract(block, originalSource) {
  const children = spliceBlocksIntoRange(originalSource, block.children || [], block.bodyStart, block.bodyEnd);
  return `\\begin{abstract}${children}\\end{abstract}`;
}

// The header (`\begin{frame}[opts]{title}` or `\begin{block}{title}`) is
// only rebuilt when the title was edited through the container's title
// field. Otherwise the original header text is preserved verbatim so
// untouched frame options/titles never drift on unrelated edits.
function serializeContainerHeader(block, originalSource) {
  if (!block.titleEdited) {
    return originalSource.slice(block.start, block.bodyStart);
  }
  if (block.envName === 'frame') {
    const options = block.frameOptions || '';
    const title = block.title ? `{${inlineToLatex(block.title)}}` : '';
    const subtitle = block.title && block.subtitle ? `{${inlineToLatex(block.subtitle)}}` : '';
    return `\\begin{frame}${options}${title}${subtitle}`;
  }
  return `\\begin{${block.envName}}{${inlineToLatex(block.title || '')}}`;
}

// Generic serializer for any environment-like block whose body is a range of
// child blocks: the generic `envblock`, `columns`, and a `column` in either of
// its two forms. The header (`\\begin{env}` plus arguments, or `\\column{w}`)
// and the footer (`\\end{env}`, or nothing for a marker-style column) are the
// source outside the body range, so both are preserved verbatim without the
// serializer needing to know which form it is looking at.
function serializeBodyEnvironment(block, originalSource) {
  const header = originalSource.slice(block.start, block.bodyStart);
  const body = spliceBlocksIntoRange(originalSource, block.children || [], block.bodyStart, block.bodyEnd);
  const footer = originalSource.slice(block.bodyEnd, block.end);
  return `${header}${body}${footer}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function levelToCommand(level) {
  const map = { 1: '\\section', 2: '\\section', 3: '\\subsection', 4: '\\subsubsection', 5: '\\paragraph', 6: '\\subparagraph' };
  return map[level] || '\\section';
}

/**
 * Convert inline Markdown-style markup (produced by the editable text fields)
 * back to LaTeX commands. This is used when the editable text field stores
 * content in a lightweight markup that the user sees as rendered text.
 *
 * The RichTextEditor keeps LaTeX commands directly in the text and uses this
 * helper for source-safe conversions performed when an edit is committed.
 */
export function inlineToLatex(text) {
  if (!text) return '';
  // Future: convert **bold** → \textbf{}, *italic* → \textit{}, etc.
  // For now, LaTeX commands are preserved as-is in the editable text.
  return text.replace(/(^|[^\\])"([^"\r\n]*\S[^"\r\n]*)"/g, "$1``$2''");
}