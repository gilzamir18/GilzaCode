/**
 * Reading a text selection that belongs to one document surface.
 *
 * The PDF viewer has always scoped its selection to its own container: a
 * selection that started somewhere else in the app is not an excerpt of the
 * document, and translating it would quote text the user never pointed at. The
 * Markdown preview needs exactly the same rule, so both surfaces call here
 * rather than keeping a copy of it each.
 *
 * `selection` is injectable so the rules can be exercised without a DOM.
 */

// `a.compareDocumentPosition(b)` describes b relative to a. Spelled out here
// because `Node` is a browser global and these functions are unit-tested.
const DOCUMENT_POSITION_FOLLOWING = 4;
const DOCUMENT_POSITION_CONTAINED_BY = 16;

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/**
 * The trimmed text currently selected inside `containerEl`, or ''.
 *
 * Returns '' — never a partial reading — when the selection is collapsed,
 * empty, or anchored outside the container.
 */
export function readSelectionWithin(containerEl, selection) {
  const sel = selection === undefined
    ? (typeof window !== 'undefined' ? window.getSelection?.() : null)
    : selection;
  if (!containerEl || !sel) return '';
  if (sel.isCollapsed || !sel.rangeCount) return '';

  const range = sel.getRangeAt(0);
  if (!range || !containerEl.contains?.(range.commonAncestorContainer)) return '';

  return String(sel.toString() || '').trim();
}

/**
 * The text of the heading `node` sits under, or ''.
 *
 * This is the Markdown preview's answer to "page 7" in the PDF viewer: a
 * rendered preview has no page numbers and no reliable mapping back to source
 * lines, but it does have the section the excerpt was read in, which is the
 * part an agent actually needs to locate the passage.
 *
 * Fails soft on purpose. An excerpt above the document's first heading, or a
 * container that cannot be queried, yields '' and the caller simply omits the
 * line — a missing locator is not worth an error.
 */
export function findEnclosingHeading(containerEl, node) {
  if (!containerEl || !node || typeof containerEl.querySelectorAll !== 'function') return '';

  let headings;
  try {
    headings = Array.from(containerEl.querySelectorAll(HEADING_SELECTOR) || []);
  } catch {
    return '';
  }

  // querySelectorAll returns document order, so the heading being looked for is
  // the last one the node still follows; everything past it is further down the
  // document and cannot enclose the node.
  let found = null;
  for (const heading of headings) {
    const relation = heading.compareDocumentPosition?.(node) ?? 0;
    if (!(relation & (DOCUMENT_POSITION_FOLLOWING | DOCUMENT_POSITION_CONTAINED_BY))) break;
    found = heading;
  }

  return found ? String(found.textContent || '').trim() : '';
}

/**
 * The heading enclosing the current selection inside `containerEl`, or ''.
 */
export function findSelectionHeading(containerEl, selection) {
  const sel = selection === undefined
    ? (typeof window !== 'undefined' ? window.getSelection?.() : null)
    : selection;
  if (!containerEl || !sel || !sel.rangeCount) return '';

  const range = sel.getRangeAt(0);
  if (!range || !containerEl.contains?.(range.commonAncestorContainer)) return '';

  return findEnclosingHeading(containerEl, range.commonAncestorContainer);
}
