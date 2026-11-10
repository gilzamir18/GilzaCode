// ─────────────────────────────────────────────────────────────────────────────
// commands.js
//
// Editing commands for the LaTeX WYSIWYG mode.
//
// These are what turn a rendered document into an editable one: Enter splits a
// list item, Tab nests it, Ctrl+B applies a real mark. `prosemirror-commands`
// covers the generic cases; the list commands are implemented here because
// `prosemirror-schema-list` is not among the project's dependencies and the
// schema's list nodes carry source-tracking attributes that the generic
// implementations would copy onto freshly created nodes.
//
// The rule every command follows: a node created or restructured by an editing
// command must NOT inherit `raw`/`headerRaw` from the node it came from, since
// those describe a span of the original file that the new node no longer
// corresponds to. `freshAttrs` enforces that.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, NodeRange, Slice } from 'prosemirror-model';
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import { ReplaceAroundStep, canJoin, canSplit, findWrapping, liftTarget } from 'prosemirror-transform';
import {
  chainCommands, createParagraphNear, joinBackward, joinForward,
  liftEmptyBlock, newlineInCode, selectNodeBackward, selectNodeForward,
  splitBlock, toggleMark,
} from 'prosemirror-commands';
import { schema } from './schema.js';

// Heading level → sectioning command. `\chapter` is level 1 because that is
// how `latexBlockParser` ranks it; article-class documents simply start at
// level 2.
const LEVEL_COMMANDS = {
  1: '\\chapter',
  2: '\\section',
  3: '\\subsection',
  4: '\\subsubsection',
  5: '\\paragraph',
  6: '\\subparagraph',
};

// Attributes for a node that has no counterpart in the source file yet.
// Anything carrying a source span must be cleared, or the serializer would
// write out bytes describing a node that no longer exists.
function freshAttrs(extra = {}) {
  return { blockId: null, raw: null, headerRaw: null, ...extra };
}

// ── Marks ───────────────────────────────────────────────────────────────────

export const toggleBold = toggleMark(schema.marks.strong);
export const toggleItalic = toggleMark(schema.marks.em, { cmd: 'textit' });
export const toggleEmph = toggleMark(schema.marks.em, { cmd: 'emph' });
export const toggleMono = toggleMark(schema.marks.code);
export const toggleUnderline = toggleMark(schema.marks.underline);
export const toggleSmallCaps = toggleMark(schema.marks.smallcaps);

// ── Block type ──────────────────────────────────────────────────────────────

/**
 * Turn the blocks touched by the selection into headings of `level`, or back
 * into paragraphs when they already are. Changing the level rewrites the
 * sectioning command, which is what makes the change visible in the source.
 */
export function setHeading(level) {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const targets = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) {
        targets.push({ node, pos });
        return false;
      }
      return true;
    });
    if (!targets.length) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    for (const { node, pos } of targets) {
      const mapped = tr.mapping.map(pos);
      const attrs = {
        ...node.attrs,
        blockId: node.attrs.blockId,
        level,
        prefix: LEVEL_COMMANDS[level] || '\\section',
      };
      tr.setNodeMarkup(mapped, schema.nodes.heading, attrs, node.marks);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Turn the blocks touched by the selection back into plain paragraphs. */
export function setParagraph(state, dispatch) {
  const { from, to } = state.selection;
  const targets = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.heading) { targets.push({ node, pos }); return false; }
    return true;
  });
  if (!targets.length) return false;
  if (!dispatch) return true;

  const tr = state.tr;
  for (const { node, pos } of targets) {
    tr.setNodeMarkup(tr.mapping.map(pos), schema.nodes.paragraph, node.attrs, node.marks);
  }
  dispatch(tr.scrollIntoView());
  return true;
}

// ── Lists ───────────────────────────────────────────────────────────────────

/**
 * Wrap the selection in an `itemize`/`enumerate`/`description` environment, or
 * lift it back out when it is already in one of that kind.
 */
export function toggleList(envName) {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const listDepth = findAncestorDepth($from, schema.nodes.list);
    if (listDepth !== null && $from.node(listDepth).attrs.envName === envName) {
      return liftListItem(state, dispatch);
    }
    // Switching between list flavours is an attribute change, not a rewrap.
    if (listDepth !== null) {
      if (!dispatch) return true;
      const pos = $from.before(listDepth);
      const node = $from.node(listDepth);
      dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, envName }));
      return true;
    }

    const range = $from.blockRange(state.selection.$to);
    if (!range) return false;
    const wrapping = findWrapping(range, schema.nodes.list, freshAttrs({ envName, tail: '\n\n', bodyHead: '\n' }));
    if (!wrapping) return false;
    if (!dispatch) return true;

    const tr = state.tr.wrap(range, wrapping);
    // The wrapped blocks kept the whitespace they had as free-standing
    // paragraphs — a leading newline and a trailing blank line. Inside an
    // `\item` that whitespace is the item's, not theirs, so it is cleared
    // here rather than emitted as stray blank lines in the environment.
    clearAffixes(tr, tr.mapping.map(range.start), tr.mapping.map(range.end));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// The three item-manipulation commands below follow the algorithms in
// `prosemirror-schema-list` (MIT, ProseMirror authors), which is not among
// this project's dependencies. They are reproduced here rather than
// approximated because the naive versions — wrap/lift on a block range — do
// not handle items with sibling content or nested lists, and fail outright on
// the ordinary "Enter at the end of an item" case.
//
// The one deviation from upstream: nodes created by a split or a sink are
// given fresh attributes, so they never inherit a `raw` span describing a part
// of the file they no longer correspond to.

const ITEM = schema.nodes.list_item;

/** Enter inside a list item: end the item and start a sibling. */
export function splitListItem(state, dispatch) {
  const { $from, $to, node } = state.selection;
  if ((node && node.isBlock) || $from.depth < 2 || !$from.sameParent($to)) return false;

  const grandParent = $from.node(-1);
  if (grandParent.type !== ITEM) return false;

  // Enter in an empty item at the end of a list ends the list instead of
  // adding another empty item.
  if ($from.parent.content.size === 0 && $from.node(-1).childCount === $from.indexAfter(-1)) {
    if ($from.depth === 3 || $from.node(-3).type !== ITEM ||
        $from.index(-2) !== $from.node(-2).childCount - 1) {
      return false;
    }
    if (!dispatch) return true;

    let wrap = Fragment.empty;
    const depthBefore = $from.index(-1) ? 1 : $from.index(-2) ? 2 : 3;
    for (let d = $from.depth - depthBefore; d >= $from.depth - 3; d--) {
      wrap = Fragment.from($from.node(d).copy(wrap));
    }
    const depthAfter = $from.indexAfter(-1) < $from.node(-2).childCount ? 1
      : $from.indexAfter(-2) < $from.node(-3).childCount ? 2 : 3;
    wrap = wrap.append(Fragment.from(ITEM.createAndFill(freshItemAttrs())));

    const start = $from.before($from.depth - (depthBefore - 1));
    const tr = state.tr.replace(start, $from.after(-depthAfter), new Slice(wrap, 4 - depthBefore, 0));
    let sel = -1;
    tr.doc.nodesBetween(start, tr.doc.content.size, (candidate, pos) => {
      if (sel > -1) return false;
      if (candidate.isTextblock && candidate.content.size === 0) sel = pos + 1;
      return true;
    });
    if (sel > -1) tr.setSelection(Selection.near(tr.doc.resolve(sel)));
    dispatch(tr.scrollIntoView());
    return true;
  }

  const nextType = $to.pos === $from.end() ? grandParent.contentMatchAt(0).defaultType : null;
  const tr = state.tr.delete($from.pos, $to.pos);
  const types = nextType
    ? [{ type: ITEM, attrs: freshItemAttrs() }, { type: nextType, attrs: freshTextblockAttrs(nextType) }]
    : [{ type: ITEM, attrs: freshItemAttrs() }];
  if (!canSplit(tr.doc, $from.pos, 2, types)) return false;
  if (!dispatch) return true;
  dispatch(tr.split($from.pos, 2, types).scrollIntoView());
  return true;
}

/** Tab inside a list item: nest it into a sublist of the preceding item. */
export function sinkListItem(state, dispatch) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (n) => n.childCount > 0 && n.firstChild.type === ITEM);
  if (!range) return false;

  const startIndex = range.startIndex;
  // The first item of a list has no sibling to nest under.
  if (startIndex === 0) return false;
  const parent = range.parent;
  if (parent.child(startIndex - 1).type !== ITEM) return false;
  if (!dispatch) return true;

  const nodeBefore = parent.child(startIndex - 1);
  const nestedBefore = nodeBefore.lastChild && nodeBefore.lastChild.type === parent.type;
  const inner = Fragment.from(nestedBefore ? ITEM.create(freshItemAttrs()) : null);
  const sublist = parent.type.create(
    freshAttrs({ envName: parent.attrs.envName, tail: '\n', bodyHead: '\n' }),
    inner,
  );
  const slice = new Slice(
    Fragment.from(ITEM.create(freshItemAttrs(), Fragment.from(sublist))),
    nestedBefore ? 3 : 1,
    0,
  );
  const before = range.start;
  const after = range.end;
  dispatch(state.tr.step(new ReplaceAroundStep(
    before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true,
  )).scrollIntoView());
  return true;
}

/** Shift+Tab inside a list item: move it out one level. */
export function liftListItem(state, dispatch) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (n) => n.childCount > 0 && n.firstChild.type === ITEM);
  if (!range) return false;
  if (!dispatch) return true;
  return $from.node(range.depth - 1).type === ITEM
    ? liftToOuterList(state, dispatch, range)
    : liftOutOfList(state, dispatch, range);
}

function liftToOuterList(state, dispatch, initialRange) {
  const tr = state.tr;
  let range = initialRange;
  const end = range.end;
  const endOfList = range.$to.end(range.depth);
  if (end < endOfList) {
    // Items after the lifted one have to become children of it.
    tr.step(new ReplaceAroundStep(
      end - 1, endOfList, end, endOfList,
      new Slice(Fragment.from(ITEM.create(freshItemAttrs(), range.parent.copy())), 1, 0), 1, true,
    ));
    range = new NodeRange(tr.doc.resolve(range.$from.pos), tr.doc.resolve(endOfList), range.depth);
  }
  const target = liftTarget(range);
  if (target == null) return false;
  tr.lift(range, target);
  const after = tr.mapping.map(range.end, -1) - 1;
  if (canJoin(tr.doc, after)) tr.join(after);
  dispatch(tr.scrollIntoView());
  return true;
}

function liftOutOfList(state, dispatch, range) {
  const tr = state.tr;
  const list = range.parent;
  // Collapse the items in range into a single one before unwrapping.
  for (let pos = range.end, i = range.endIndex - 1, e = range.startIndex; i > e; i--) {
    pos -= list.child(i).nodeSize;
    tr.delete(pos - 1, pos + 1);
  }
  const $start = tr.doc.resolve(range.start);
  const item = $start.nodeAfter;
  if (!item || tr.mapping.map(range.end) !== range.start + item.nodeSize) return false;

  const atStart = range.startIndex === 0;
  const atEnd = range.endIndex === list.childCount;
  const parent = $start.node(-1);
  const indexBefore = $start.index(-1);
  const replacement = item.content.append(atEnd ? Fragment.empty : Fragment.from(list));
  if (!parent.canReplace(indexBefore + (atStart ? 0 : 1), indexBefore + 1, replacement)) return false;

  const start = $start.pos;
  const end = start + item.nodeSize;
  tr.step(new ReplaceAroundStep(
    start - (atStart ? 1 : 0), end + (atEnd ? 1 : 0), start + 1, end - 1,
    new Slice(
      (atStart ? Fragment.empty : Fragment.from(list.copy(Fragment.empty)))
        .append(atEnd ? Fragment.empty : Fragment.from(list.copy(Fragment.empty))),
      atStart ? 0 : 1, atEnd ? 0 : 1,
    ),
    atStart ? 0 : 1, true,
  ));
  dispatch(tr.scrollIntoView());
  return true;
}

// A brand-new `\item`: `bodyHead` carries the space that separates the command
// from its text, which is where that space lives for a parsed item too.
function freshItemAttrs() {
  return freshAttrs({ tail: '\n', bodyHead: ' ', term: '', hasTerm: false });
}

// Strips the source whitespace attributes from every textblock in a range,
// used when blocks are moved into a container that owns their separation.
function clearAffixes(tr, from, to) {
  const edits = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock && 'head' in node.attrs) {
      edits.push({ pos, attrs: { ...node.attrs, head: '', foot: '', tail: '' } });
    }
    return true;
  });
  // Applied afterwards: `setNodeMarkup` preserves node size, so the positions
  // collected above stay valid, but mutating mid-iteration would not.
  for (const edit of edits) tr.setNodeMarkup(edit.pos, null, edit.attrs);
  return tr;
}

function freshTextblockAttrs(type) {
  const attrs = freshAttrs({ tail: '' });
  if (type.spec.attrs && 'head' in type.spec.attrs) { attrs.head = ''; attrs.foot = ''; }
  if (type.spec.attrs && 'bodyHead' in type.spec.attrs) attrs.bodyHead = ' ';
  return attrs;
}

// ── Insertion ───────────────────────────────────────────────────────────────

/** Insert a display-math block after the current block. */
export function insertMathBlock(state, dispatch) {
  const node = schema.nodes.math_block.create(freshAttrs({ math: '', delim: 'bracket', tail: '\n\n' }));
  return insertBlockAfterSelection(node)(state, dispatch);
}

/** Insert an empty paragraph after the current block. */
export function insertParagraph(state, dispatch) {
  const node = schema.nodes.paragraph.create(freshAttrs({ tail: '\n\n' }));
  return insertBlockAfterSelection(node)(state, dispatch);
}

function insertBlockAfterSelection(node) {
  return (state, dispatch) => {
    const { $to } = state.selection;
    const depth = topLevelDepth($to);
    const pos = $to.after(depth);
    if (!dispatch) return true;
    const tr = state.tr.insert(pos, node);
    const selectable = node.isTextblock
      ? TextSelection.create(tr.doc, pos + 1)
      : NodeSelection.create(tr.doc, pos);
    dispatch(tr.setSelection(selectable).scrollIntoView());
    return true;
  };
}

/**
 * Replace the selection with an inline math atom, seeded with the selected
 * text — the common way a formula gets written is by typing it as prose first.
 */
export function insertInlineMath(state, dispatch) {
  const { from, to, empty } = state.selection;
  const seed = empty ? '' : state.doc.textBetween(from, to, '', '');
  if (!dispatch) return true;
  const node = schema.nodes.math_inline.create({ math: seed, delim: 'dollar' });
  dispatch(state.tr.replaceSelection(new Slice(Fragment.from(node), 0, 0)).scrollIntoView());
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Depth of the nearest ancestor of `type`, or null.
function findAncestorDepth($pos, type) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === type) return d;
  }
  return null;
}

// The depth of the outermost block containing `$pos`, so inserting "after the
// current block" from inside a frame inserts after the frame's child, not
// after the frame.
function topLevelDepth($pos) {
  return Math.max(1, $pos.depth);
}

// ── Keymap ──────────────────────────────────────────────────────────────────

/**
 * Editing keymap. Ordering matters: the list-aware commands are tried before
 * the generic block commands so Enter inside an item creates a sibling item
 * rather than a bare paragraph.
 */
export function buildKeymap() {
  const enter = chainCommands(splitListItem, createParagraphNear, liftEmptyBlock, splitBlock);
  const backspace = chainCommands(newlineInCode, joinBackward, selectNodeBackward);
  const del = chainCommands(joinForward, selectNodeForward);

  return {
    'Mod-b': toggleBold,
    'Mod-i': toggleItalic,
    'Mod-u': toggleUnderline,
    'Mod-`': toggleMono,
    'Mod-Shift-m': insertInlineMath,
    'Mod-Shift-Enter': insertMathBlock,
    'Mod-Alt-0': setParagraph,
    'Mod-Alt-1': setHeading(2),
    'Mod-Alt-2': setHeading(3),
    'Mod-Alt-3': setHeading(4),
    'Mod-Shift-8': toggleList('itemize'),
    'Mod-Shift-9': toggleList('enumerate'),
    Enter: enter,
    Tab: sinkListItem,
    'Shift-Tab': liftListItem,
    Backspace: backspace,
    'Mod-Backspace': backspace,
    Delete: del,
    'Mod-Delete': del,
  };
}
