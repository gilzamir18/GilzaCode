import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { parseLatexBlocks } from '../utils/latexBlockParser';
import { serializeDocument } from '../utils/latexBlockSerializer';
import { validateRenderableMath } from '../utils/mathValidation';
import { declarationStyle, findFirstDeclaration } from '../utils/latexFontDeclarations';
import { stripTransparentGroups } from '../utils/latexBraceGroups';
import {
  NOTE_COMMANDS, findCommandWithArgument, latexToPlainText, reduceCommandsToArguments,
} from '../utils/latexInlineCommands';

// ── Module-level cache: keyed by (projectPath, graphic-source-hash) ────────
// This avoids re-compiling identical TikZ snippets on every keystroke. The
// backend also caches by the same content-hash so we hit an O(1) dict lookup
// after the first render. Both caches are bounded in size to avoid memory
// growth on long editing sessions.
const graphicSvgCache = new Map();
const mathHtmlCache = new Map();
const GRAPHIC_CACHE_MAX = 64;
const MATH_CACHE_MAX = 256;
// Cache version — bumped when the output format changes.
// v6 uses KaTeX MathML output consistently with the other math surfaces.
const MATH_CACHE_VERSION = 'v6';
const MATH_RENDER_TIMEOUT_MS = 1200;
const MATH_UI_IDLE_DELAY_MS = 300;
// Keep a moderate delay between tasks to yield to the event loop without
// creating a tight pause/requeue cycle.
const MATH_NEXT_RENDER_DELAY_MS = 40;
const mathRenderQueue = [];
const mathRenderTasks = new Map();
let activeMathTask = null;
let mathPumpTimer = null;
let lastMathUiActivityAt = 0;

// Module-level reference to the precomputed line offsets array, set by the
// RichTextEditor component on each source change. This avoids prop-drilling
// it through every block renderer just for sourceLineFromOffset.
let currentLineOffsets = null;

// Lightweight 32-bit FNV-1a hash of a string, fast and good-enough for an
// in-memory cache key. We avoid shipping crypto-js for this small concern.
function hashSource(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// RichTextEditor
//
// Overleaf-style Rich Text editor for LaTeX. Parses the source into blocks;
// editable prose blocks (headings, paragraphs, lists, quotes) are rendered as
// contentEditable elements whose changes are serialized back to LaTeX and
// spliced into the source via `onChange`. Non-editable blocks (math, figures,
// tables, code, unrecognized environments) are rendered as read-only previews
// with a "jump to source" action on click.
//
// Strategy:
//   - Source LaTeX remains the single source of truth.
//   - Only editable blocks are modified; complex blocks are preserved as-is.
//   - Inline math is rendered while blocks are idle and shown as raw LaTeX
//     while the block is focused for editing.
// ─────────────────────────────────────────────────────────────────────────────

export default function RichTextEditor({
  source,
  activeProjectPath,
  sourceTex,
  zoomLevel = 1.0,
  initialSourceLine,
  initialScrollTop,
  onChange,
  onJumpToSource,
  onActiveSourceLineChange,
  onScrollTopChange,
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseLatexBlocks(source), [source]);
  const containerRef = useRef(null);
  const contentRef = useRef(null);
  const activeLineRef = useRef(1);
  // Scroll target captured at mount. This component is keyed per file by the
  // editor panel, so mount == the user opening this file's Rich Text view and
  // these values always belong to that file.
  const initialScrollTopRef = useRef(initialScrollTop);
  const initialSourceLineRef = useRef(initialSourceLine);
  // True while we are still driving the scroll position toward the restore
  // target. Scroll events caused by our own restore must not be persisted,
  // otherwise the provisional (pre-settle) position overwrites the real one.
  const isRestoringRef = useRef(false);

  // Precompute line-start offsets once per source change so sourceLineFromOffset
  // is O(log n) instead of O(n) — avoids O(n²) cost when called for every block.
  const lineOffsets = useMemo(() => {
    const offsets = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
  }, [source]);

  // Keep the module-level reference in sync so sourceLineFromOffset can use
  // binary search instead of O(n) string slicing on every call.
  useEffect(() => {
    currentLineOffsets = lineOffsets;
    return () => { currentLineOffsets = null; };
  }, [lineOffsets]);

  // ── Handle edit in a contentEditable block ───────────────────────────────
  // Blocks may be nested (a paragraph or list inside a beamer `frame`), so
  // the target block is looked up recursively through `children`.
  const handleBlockEdit = useCallback((blockId, newText) => {
    if (!onChange) return;
    const updatedBlocks = updateBlockById(blocks, blockId, (b) => ({ ...b, text: newText, edited: true }));
    const newSource = serializeDocument(source, updatedBlocks);
    onChange(newSource);
  }, [blocks, source, onChange]);

  // ── Handle a description-list item's `[term]` edit ───────────────────────
  // The rest of an item's content (including nested lists) is real block
  // structure edited via handleBlockEdit; only the `\item[term]` bracket is
  // a plain string owned by the item itself.
  const handleListItemEdit = useCallback((itemId, newTerm) => {
    if (!onChange) return;
    const updatedBlocks = updateBlockById(blocks, itemId, (item) => ({ ...item, term: newTerm, hasTerm: true, edited: true }));
    const newSource = serializeDocument(source, updatedBlocks);
    onChange(newSource);
  }, [blocks, source, onChange]);

  // ── Handle a container's title edit (frame/block/exampleblock/alertblock) ─
  // Title text lives in `\begin{frame}{Title}`-style env args, not in a
  // child block, so it is updated directly on the container itself.
  const handleContainerTitleEdit = useCallback((blockId, newTitle) => {
    if (!onChange) return;
    const updatedBlocks = updateBlockById(blocks, blockId, (b) => ({ ...b, title: newTitle, titleEdited: true }));
    const newSource = serializeDocument(source, updatedBlocks);
    onChange(newSource);
  }, [blocks, source, onChange]);

  // ── Jump to source line for non-editable blocks ──────────────────────────
  const handleJumpToSource = useCallback((block) => {
    if (!onJumpToSource) return;
    // Convert char offset to line number
    const line = sourceLineFromOffset(source, block.start);
    onJumpToSource(line, block.start);
  }, [source, onJumpToSource]);

  const setActiveSourceLine = useCallback((line) => {
    if (!line || activeLineRef.current === line) return;
    activeLineRef.current = line;
    if (onActiveSourceLineChange) onActiveSourceLineChange(line);
  }, [onActiveSourceLineChange]);

  const scrollRafRef = useRef(null);
  const handleScroll = useCallback(() => {
    // Persist the raw scroll offset on every event (not inside the rAF) so a
    // tab switch immediately after a scroll still records the final position.
    // Restoring to a pixel offset is exact; deriving it from a source line is
    // not, because block heights change as lazy blocks and math settle.
    const container = containerRef.current;
    if (container && !isRestoringRef.current && onScrollTopChange) {
      onScrollTopChange(container.scrollTop);
    }

    if (scrollRafRef.current) return; // already scheduled
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const c = containerRef.current;
      if (!c) return;
      const items = Array.from(c.querySelectorAll('[data-source-line]'));
      const current = items.find((item) => item.offsetTop + item.offsetHeight >= c.scrollTop + 24) || items[0];
      const line = Number(current?.getAttribute('data-source-line'));
      if (line) setActiveSourceLine(line);
    });
  }, [setActiveSourceLine, onScrollTopChange]);

  // ── Restore the scroll position for this file ────────────────────────────
  // Off-screen blocks render as 24px placeholders and math/graphics resolve
  // asynchronously, so right after mount the document is far shorter than its
  // final height. Scrolling to the target once would land in the wrong place
  // and then drift as the content grows. Instead we re-apply the target every
  // time the content resizes, and stop as soon as the user actually scrolls
  // (or once the layout has settled).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const savedTop = Number(initialScrollTopRef.current) || 0;
    const line = Number(initialSourceLineRef.current) || 0;
    if (savedTop <= 0 && line <= 1) return;

    isRestoringRef.current = true;
    let settleTimer = null;
    let observer = null;

    const applyTarget = () => {
      const c = containerRef.current;
      if (!c || !isRestoringRef.current) return;
      const maxTop = Math.max(0, c.scrollHeight - c.clientHeight);
      let top;

      if (savedTop > 0) {
        // Returning to a tab: restore the exact offset the user left it at.
        top = Math.min(savedTop, maxTop);
      } else {
        // Entering Rich Text mode from Monaco: aim at the cursor's block.
        const items = Array.from(c.querySelectorAll('[data-source-line]'));
        if (!items.length) return;
        let target = items[0];
        for (const item of items) {
          const itemLine = Number(item.getAttribute('data-source-line'));
          if (!itemLine || itemLine > line) break;
          target = item;
        }
        top = Math.min(Math.max(0, target.offsetTop - 24), maxTop);
        setActiveSourceLine(Number(target.getAttribute('data-source-line')) || line);
      }

      if (Math.abs(c.scrollTop - top) > 1) c.scrollTop = top;
    };

    const stopRestoring = () => {
      if (!isRestoringRef.current) return;
      isRestoringRef.current = false;
      if (observer) observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      container.removeEventListener('wheel', stopRestoring);
      container.removeEventListener('touchstart', stopRestoring);
      container.removeEventListener('keydown', stopRestoring);
      container.removeEventListener('pointerdown', stopRestoring);
    };

    applyTarget();

    if (typeof ResizeObserver !== 'undefined' && contentRef.current) {
      observer = new ResizeObserver(() => applyTarget());
      observer.observe(contentRef.current);
    }
    // Hard stop so we never fight the user on a document that keeps resizing.
    // Any real scroll input below cancels the restore before this fires.
    settleTimer = setTimeout(stopRestoring, 3000);
    container.addEventListener('wheel', stopRestoring, { passive: true });
    container.addEventListener('touchstart', stopRestoring, { passive: true });
    container.addEventListener('keydown', stopRestoring);
    // Covers dragging the scrollbar, which fires neither wheel nor touch.
    container.addEventListener('pointerdown', stopRestoring);

    return stopRestoring;
    // Mount-only: the panel keys this component per file, so remounting is
    // what carries a new restore target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="rich-text-editor-container"
      onScroll={handleScroll}
      style={{
        overflowY: 'auto',
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        boxSizing: 'border-box',
      }}
    >
      {/*
        The zoom transform lives on this inner wrapper, not on the scrolling
        element above. Applying `transform` directly to an `overflow: auto`
        element makes Chromium/webview promote it to its own compositing
        layer, which has a known bug where the native scrollbar stops
        repainting mid-scroll (it vanishes before the content reaches the
        end). Keeping the scroll container transform-free avoids that.
      */}
      <div
        ref={contentRef}
        style={{
          padding: '20px',
          boxSizing: 'border-box',
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'top left',
          width: `${100 / zoomLevel}%`,
          minHeight: `${100 / zoomLevel}%`,
        }}
      >
        <BlockList
          blocks={blocks}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={handleBlockEdit}
          onListItemEdit={handleListItemEdit}
          onContainerTitleEdit={handleContainerTitleEdit}
          onJumpToSource={handleJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
        {blocks.length === 0 && (
          <div style={{ color: 'var(--vscode-descriptionForeground, #888)', fontSize: '13px', padding: '20px' }}>
            {t('editorPanel.emptyRichText', 'No editable content. Open a .tex file with a document body.')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LazyBlock — Only mounts heavy BlockRenderer content when the block is
// visible or near-visible. This is the key optimization that prevents the
// editor from freezing when a document has many equations: instead of
// mounting all MathBlock/AsyncInlineMath components at once (which would
// spawn dozens of worker tasks simultaneously), only the blocks in the
// viewport trigger rendering. Off-screen blocks render a lightweight
// placeholder with a min-height to preserve scroll position.
// ─────────────────────────────────────────────────────────────────────────────

const LAZY_ROOT_MARGIN = '800px 0px 800px 0px';

// ─────────────────────────────────────────────────────────────────────────────
// BlockList — renders a sibling list of blocks, each lazily mounted. Used
// both for the top-level document body and, recursively, for the children
// of a container block (frame/block/exampleblock/alertblock), so nested
// content reuses the exact same lazy-mount and edit wiring as top-level
// content.
// ─────────────────────────────────────────────────────────────────────────────

function BlockList({
  blocks,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  return blocks.map((block) => (
    <LazyBlock
      key={block.id}
      block={block}
      sourceLine={sourceLineFromOffset(source, block.start)}
      source={source}
      activeProjectPath={activeProjectPath}
      sourceTex={sourceTex}
      onBlockEdit={onBlockEdit}
      onListItemEdit={onListItemEdit}
      onContainerTitleEdit={onContainerTitleEdit}
      onJumpToSource={onJumpToSource}
      setActiveSourceLine={setActiveSourceLine}
    />
  ));
}

const LazyBlock = React.memo(function LazyBlock({
  block,
  sourceLine,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // If IntersectionObserver is unavailable, render everything (fallback).
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            // Once visible, keep it mounted — unmounting would lose state
            // (cursor position, edited text) and cause re-renders on scroll.
          }
        }
      },
      {
        root: null,
        rootMargin: LAZY_ROOT_MARGIN,
        threshold: 0,
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-source-line={sourceLine}
      onMouseDown={() => setActiveSourceLine(sourceLine)}
      onFocusCapture={() => setActiveSourceLine(sourceLine)}
      style={{ minHeight: visible ? 'auto' : '24px' }}
    >
      {visible ? (
        <BlockRenderer
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      ) : (
        <div style={{ minHeight: '24px' }} />
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// BlockRenderer — renders a single block based on its type
// ─────────────────────────────────────────────────────────────────────────────

function BlockRenderer({ block, source, activeProjectPath, sourceTex, onBlockEdit, onListItemEdit, onContainerTitleEdit, onJumpToSource, setActiveSourceLine }) {
  switch (block.type) {
    case 'preamble':
      return <PreambleBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'heading':
      return <HeadingBlock block={block} onEdit={onBlockEdit} />;
    case 'paragraph':
      return <ParagraphBlock block={block} onEdit={onBlockEdit} />;
    case 'list':
      return (
        <ListBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'quote':
      return <QuoteBlock block={block} onEdit={onBlockEdit} />;
    case 'frametitle':
      return <FrameTitleBlock block={block} onEdit={onBlockEdit} />;
    case 'titlepage':
      return <TitlePageBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'maketitle':
      return <MakeTitleBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'abstract':
      return (
        <AbstractBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'container':
      return (
        <FrameContainerBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'align':
      return (
        <AlignBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'math':
      return <MathBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'figure':
      return <FigureBlock block={block} activeProjectPath={activeProjectPath} sourceTex={sourceTex} onJumpToSource={onJumpToSource} />;
    case 'graphic':
      return <GraphicBlock block={block} activeProjectPath={activeProjectPath} onJumpToSource={onJumpToSource} />;
    case 'table':
      return <TableBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'code':
      return <CodeBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'envblock':
      return (
        <EnvBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'columns':
      return (
        <ColumnsBlock
          block={block}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      );
    case 'environment':
      return <EnvironmentBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'comment':
      return <CommentBlock block={block} />;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Editable blocks
// ─────────────────────────────────────────────────────────────────────────────

function HeadingBlock({ block, onEdit }) {
  const sizes = { 1: '22px', 2: '20px', 3: '18px', 4: '16px', 5: '14px', 6: '13px' };
  const style = {
    fontSize: sizes[block.level] || '18px',
    fontWeight: 'bold',
    color: 'var(--vscode-text-light, #ffffff)',
    margin: '16px 0 8px 0',
    outline: 'none',
    padding: '2px 4px',
    borderRadius: '3px',
    borderBottom: '1px solid transparent',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ borderBottom: '1px solid var(--vscode-accent, #007acc)' }}
    />
  );
}

function sourceLineFromOffset(source, offset) {
  // Uses the precomputed lineOffsets array if available, otherwise falls
  // back to the O(n) method. The lineOffsets array is built once per source
  // change and passed via a module-level variable to avoid prop drilling.
  const offsets = currentLineOffsets;
  if (offsets && offsets.length > 0) {
    // Binary search: find the largest index whose offset <= target
    let lo = 0, hi = offsets.length - 1, result = 0;
    const target = Math.max(0, offset || 0);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= target) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result + 1; // 1-indexed line number
  }
  return source.slice(0, Math.max(0, offset || 0)).split('\n').length;
}

// Immutably updates the block (or list item) with the given id, searching
// recursively through `children` (container/list-item body content) and
// `items` (a list block's items, which themselves carry `children`).
function updateBlockById(blocks, blockId, updater) {
  return blocks.map((b) => {
    if (b.id === blockId) return updater(b);
    let next = b;
    if (next.items) next = { ...next, items: updateBlockById(next.items, blockId, updater) };
    if (next.children) next = { ...next, children: updateBlockById(next.children, blockId, updater) };
    return next;
  });
}

function ParagraphBlock({ block, onEdit }) {
  const style = {
    margin: '6px 0',
    fontSize: '13px',
    lineHeight: '1.6',
    color: 'var(--chat-text, var(--vscode-text-fg))',
    outline: 'none',
    padding: '2px 4px',
    borderRadius: '3px',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.04))' }}
    />
  );
}

// An item's body is parsed recursively (parseListItems -> parseBody), so it
// may hold more than flat text: a nested \begin{itemize}, a display math
// block, etc. The common case — a single paragraph of prose — still renders
// as one inline-editable field, exactly like before. Anything richer falls
// through to the same BlockList used everywhere else, so a nested list
// renders as a real nested <ul>/<ol> instead of raw `\begin{itemize}` text.
function ListBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  const isOrdered = block.listType === 'enumerate';
  const isDescription = block.listType === 'description';
  const ListTag = isOrdered ? 'ol' : 'ul';
  return (
    <ListTag style={{ margin: '8px 0', paddingLeft: '24px', fontSize: '13px', lineHeight: '1.6', color: 'var(--chat-text, var(--vscode-text-fg))' }}>
      {block.items.map((item) => {
        const isSimpleText = item.children.length === 1 && item.children[0].type === 'paragraph';
        const body = isSimpleText ? (
          <EditableLatexText
            as="span"
            text={item.children[0].text}
            onCommit={(v) => onBlockEdit(item.children[0].id, v)}
            style={{ outline: 'none', display: 'inline-block', width: '100%', whiteSpace: 'pre-wrap' }}
          />
        ) : (
          <BlockList
            blocks={item.children}
            source={source}
            activeProjectPath={activeProjectPath}
            sourceTex={sourceTex}
            onBlockEdit={onBlockEdit}
            onListItemEdit={onListItemEdit}
            onContainerTitleEdit={onContainerTitleEdit}
            onJumpToSource={onJumpToSource}
            setActiveSourceLine={setActiveSourceLine}
          />
        );
        return (
          <li key={item.id} style={{ margin: '4px 0', listStyleType: isDescription ? 'none' : undefined }}>
            {isDescription ? (
              <span style={{ display: 'flex', gap: '6px', alignItems: isSimpleText ? 'baseline' : 'flex-start' }}>
                <EditableLatexText
                  as="span"
                  text={item.term}
                  onCommit={(v) => onListItemEdit(item.id, v)}
                  style={{ fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', outline: 'none', whiteSpace: 'pre-wrap', flexShrink: 0 }}
                />
                <span style={{ flex: 1 }}>{body}</span>
              </span>
            ) : body}
          </li>
        );
      })}
    </ListTag>
  );
}

function QuoteBlock({ block, onEdit }) {
  const style = {
    margin: '8px 0',
    paddingLeft: '12px',
    borderLeft: '3px solid var(--vscode-accent, #007acc)',
    color: 'var(--chat-muted, #8a8a8a)',
    fontSize: '13px',
    outline: 'none',
    padding: '4px 8px',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      as="blockquote"
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.04))' }}
    />
  );
}

function FrameTitleBlock({ block, onEdit }) {
  const style = {
    fontSize: '18px',
    fontWeight: 'bold',
    color: 'var(--vscode-text-light, #ffffff)',
    margin: '0 0 10px 0',
    outline: 'none',
    padding: '2px 4px',
    borderRadius: '3px',
    whiteSpace: 'pre-wrap',
  };
  return (
    <EditableLatexText
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ borderBottom: '1px solid var(--vscode-accent, #007acc)' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TitlePageBlock — Beamer `\titlepage`.
//
// Rendered as a preview card built from the \title/\subtitle/\author/
// \institute/\date extracted from the preamble (parsed once by
// latexBlockParser and carried on `block.titleMeta`), instead of leaking the
// bare `\titlepage` command as literal text. Read-only: the underlying
// metadata lives in the preamble, not in this block, so editing happens by
// jumping to source.
// ─────────────────────────────────────────────────────────────────────────────

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function TitlePageBlock({ block, onJumpToSource }) {
  const { t } = useTranslation();
  const meta = block.titleMeta || {};
  const authors = (meta.author || '')
    .split(/\\and\b/)
    .map((a) => a.trim())
    .filter(Boolean);
  const hasAny = Boolean(meta.title || meta.subtitle || authors.length || meta.institute || meta.date);

  return (
    <div
      onClick={() => onJumpToSource(block)}
      title="Click to jump to source"
      style={{
        margin: '10px 0',
        padding: '32px 20px',
        textAlign: 'center',
        background: 'linear-gradient(180deg, rgba(0,122,204,0.10), rgba(0,122,204,0.02))',
        border: '1px solid var(--vscode-accent, #007acc)',
        borderRadius: '6px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-text-light, #ffffff)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-accent, #007acc)'; }}
    >
      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '16px' }}>
        {t('richTextEditor.block.titlepage', { defaultValue: 'Title Page' })}
      </div>
      {hasAny ? (
        <>
          {meta.title && (
            <div style={{ fontSize: '22px', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', marginBottom: meta.subtitle ? '6px' : '14px', lineHeight: 1.3 }}>
              {renderStyledLatexText(meta.title)}
            </div>
          )}
          {meta.subtitle && (
            <div style={{ fontSize: '15px', color: 'var(--chat-muted, #8a8a8a)', marginBottom: '14px' }}>
              {renderStyledLatexText(meta.subtitle)}
            </div>
          )}
          {authors.length > 0 && (
            <div style={{ fontSize: '13px', color: 'var(--chat-text, var(--vscode-text-fg))', marginBottom: (meta.institute || meta.date) ? '4px' : 0 }}>
              {authors.map((author, index) => (
                <div key={index}>{renderStyledLatexText(author)}</div>
              ))}
            </div>
          )}
          {meta.institute && (
            <div style={{ fontSize: '12px', color: 'var(--chat-muted, #8a8a8a)', marginBottom: meta.date ? '4px' : 0 }}>
              {renderStyledLatexText(meta.institute)}
            </div>
          )}
          {meta.date && (
            <div style={{ fontSize: '12px', color: 'var(--chat-muted, #8a8a8a)', marginTop: '10px' }}>
              {meta.date.trim() === '\\today'
                ? t('richTextEditor.block.titlepageToday', { defaultValue: "Today's date" })
                : renderStyledLatexText(meta.date)}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground, #888)', fontStyle: 'italic' }}>
          {t('richTextEditor.block.titlepageEmpty', { defaultValue: 'No \\title, \\author or \\date defined in the preamble' })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MakeTitleBlock — standard (article/report/book) `\maketitle`.
//
// Rendered as the actual typeset title — centered Title/Authors/Date built
// from the \title/\author/\date extracted from the preamble (same titleMeta
// shape as TitlePageBlock) — instead of leaking the literal `\maketitle`
// command as plain text. Unlike the Beamer title page, this isn't a boxed
// slide preview: it sits inline at the top of the document the way real
// LaTeX output would render it. Read-only: the underlying metadata lives in
// the preamble, so editing happens by jumping to source.
// ─────────────────────────────────────────────────────────────────────────────

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function MakeTitleBlock({ block, onJumpToSource }) {
  const { t } = useTranslation();
  const meta = block.titleMeta || {};
  const authors = (meta.author || '')
    .split(/\\and\b/)
    .map((a) => a.trim())
    .filter(Boolean);
  const hasAny = Boolean(meta.title || authors.length || meta.date);

  return (
    <div
      onClick={() => onJumpToSource(block)}
      title="Click to jump to source"
      style={{
        margin: '16px 0 24px 0',
        padding: '16px 8px',
        textAlign: 'center',
        cursor: 'pointer',
        borderRadius: '4px',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-list-hoverBg, rgba(255,255,255,0.03))'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {hasAny ? (
        <>
          {meta.title && (
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', marginBottom: authors.length ? '10px' : '6px', lineHeight: 1.3 }}>
              {renderStyledLatexText(meta.title)}
            </div>
          )}
          {authors.length > 0 && (
            <div style={{ fontSize: '15px', color: 'var(--chat-text, var(--vscode-text-fg))', marginBottom: meta.date ? '6px' : 0 }}>
              {authors.map((author, index) => (
                <span key={index}>
                  {index > 0 && <span style={{ margin: '0 8px', color: 'var(--chat-muted, #8a8a8a)' }}>&middot;</span>}
                  {renderStyledLatexText(author)}
                </span>
              ))}
            </div>
          )}
          {meta.date && (
            <div style={{ fontSize: '13px', color: 'var(--chat-muted, #8a8a8a)' }}>
              {meta.date.trim() === '\\today'
                ? t('richTextEditor.block.titlepageToday', { defaultValue: "Today's date" })
                : renderStyledLatexText(meta.date)}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground, #888)', fontStyle: 'italic' }}>
          {t('richTextEditor.block.maketitleEmpty', { defaultValue: 'No \\title defined in the preamble' })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FrameContainerBlock — Beamer `frame`, `block`, `exampleblock`, `alertblock`.
//
// These environments hold a nested sub-document rather than flat prose, so
// unlike the other block types they render their `children` through the
// same BlockList/LazyBlock/BlockRenderer pipeline used at the top level —
// full WYSIWYG editing (prose, lists, math, nested blocks/columns-to-come)
// instead of a read-only raw-source dump.
//
// The title is editable wherever it lives: either the `\begin{frame}{Title}`
// env-arg (edited via onContainerTitleEdit, which rewrites the container's
// header) or a `\frametitle{...}` command found among the children (edited
// like any other block, via onBlockEdit).
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER_LABEL_KEYS = {
  frame: { key: 'richTextEditor.block.container.frame', defaultValue: 'Slide' },
  block: { key: 'richTextEditor.block.container.block', defaultValue: 'Block' },
  exampleblock: { key: 'richTextEditor.block.container.exampleblock', defaultValue: 'Example' },
  alertblock: { key: 'richTextEditor.block.container.alertblock', defaultValue: 'Alert' },
};

const CONTAINER_ACCENT_COLORS = {
  frame: 'var(--vscode-accent, #007acc)',
  block: 'var(--vscode-widget-border, #2a2a2a)',
  exampleblock: 'var(--diff-text-added, #4caf50)',
  alertblock: 'var(--vscode-errorForeground, #f44747)',
};

function FrameContainerBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  const { t } = useTranslation();
  const isFrame = block.containerKind === 'frame';
  const hasEnvArgTitle = Boolean(block.title);
  const frametitleChild = !hasEnvArgTitle
    ? block.children.find((c) => c.type === 'frametitle')
    : null;
  const bodyChildren = frametitleChild
    ? block.children.filter((c) => c.id !== frametitleChild.id)
    : block.children;
  const labelInfo = CONTAINER_LABEL_KEYS[block.containerKind] || { key: '', defaultValue: block.containerKind };

  return (
    <div
      style={{
        margin: isFrame ? '16px 0' : '10px 0',
        padding: isFrame ? '18px 22px' : '10px 14px',
        background: isFrame ? 'var(--editor-bg, #1e1e1e)' : 'var(--vscode-list-hoverBg, rgba(255,255,255,0.03))',
        border: `1px solid ${CONTAINER_ACCENT_COLORS[block.containerKind] || 'var(--vscode-widget-border, #2a2a2a)'}`,
        borderRadius: isFrame ? '6px' : '4px',
        boxShadow: isFrame ? '0 2px 6px rgba(0,0,0,0.25)' : 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {t(labelInfo.key, { defaultValue: labelInfo.defaultValue })}
        </span>
        <button
          type="button"
          onClick={() => onJumpToSource(block)}
          title="Click to jump to source"
          style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {t('richTextEditor.block.jumpToSource', { defaultValue: 'source' })}
        </button>
      </div>

      {hasEnvArgTitle ? (
        <EditableLatexText
          text={block.title}
          onCommit={(v) => onContainerTitleEdit(block.id, v)}
          style={{ fontSize: isFrame ? '18px' : '14px', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', outline: 'none', margin: '0 0 10px 0', whiteSpace: 'pre-wrap' }}
          editingStyle={{ borderBottom: '1px solid var(--vscode-accent, #007acc)' }}
        />
      ) : frametitleChild ? (
        <FrameTitleBlock block={frametitleChild} onEdit={onBlockEdit} />
      ) : (
        <EditableLatexText
          text=""
          onCommit={(v) => onContainerTitleEdit(block.id, v)}
          style={{
            fontSize: isFrame ? '18px' : '14px',
            fontWeight: 'bold',
            color: 'var(--vscode-descriptionForeground, #888)',
            outline: 'none',
            margin: '0 0 10px 0',
            minHeight: '1.4em',
            whiteSpace: 'pre-wrap',
          }}
          editingStyle={{ borderBottom: '1px solid var(--vscode-accent, #007acc)' }}
        />
      )}

      <BlockList
        blocks={bodyChildren}
        source={source}
        activeProjectPath={activeProjectPath}
        sourceTex={sourceTex}
        onBlockEdit={onBlockEdit}
        onListItemEdit={onListItemEdit}
        onContainerTitleEdit={onContainerTitleEdit}
        onJumpToSource={onJumpToSource}
        setActiveSourceLine={setActiveSourceLine}
      />
      {bodyChildren.length === 0 && (
        <div style={{ color: 'var(--vscode-descriptionForeground, #666)', fontSize: '12px', fontStyle: 'italic' }}>
          {t('richTextEditor.block.emptyContainer', { defaultValue: 'Empty' })}
        </div>
      )}
    </div>
  );
}

const ALIGN_TEXT_ALIGN = { center: 'center', flushleft: 'left', flushright: 'right' };

// AlignBlock — `\begin{center}`/`flushleft`/`flushright` when it does not
// wrap a table. A pure passthrough wrapper: no border, title bar, or lock
// icon, just the CSS alignment LaTeX itself would apply, so a centered
// paragraph reads as centered editable text instead of a raw-source box.
function AlignBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  return (
    <div style={{ textAlign: ALIGN_TEXT_ALIGN[block.align] || 'left' }}>
      <BlockList
        blocks={block.children}
        source={source}
        activeProjectPath={activeProjectPath}
        sourceTex={sourceTex}
        onBlockEdit={onBlockEdit}
        onListItemEdit={onListItemEdit}
        onContainerTitleEdit={onContainerTitleEdit}
        onJumpToSource={onJumpToSource}
        setActiveSourceLine={setActiveSourceLine}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvBlock — any environment without dedicated handling.
//
// Its body is real block structure, so this is a thin labelled wrapper rather
// than a read-only source dump: the `itemize`, figure or TikZ picture inside a
// `minipage` or a `theorem` renders exactly as it would outside one. The
// environment's own styling is not reproduced — only its boundary is shown —
// because what a package's environment looks like is not knowable without
// running LaTeX. The header (`\begin{env}` plus its arguments) is preserved
// verbatim and reachable through "source".
// ─────────────────────────────────────────────────────────────────────────────

function EnvBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        margin: '10px 0',
        padding: '8px 12px',
        borderLeft: '2px solid var(--vscode-widget-border, #2a2a2a)',
        borderRadius: '2px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {block.envName}
        </span>
        <button
          type="button"
          onClick={() => onJumpToSource(block)}
          title="Click to jump to source"
          style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {t('richTextEditor.block.jumpToSource', { defaultValue: 'source' })}
        </button>
      </div>
      <BlockList
        blocks={block.children}
        source={source}
        activeProjectPath={activeProjectPath}
        sourceTex={sourceTex}
        onBlockEdit={onBlockEdit}
        onListItemEdit={onListItemEdit}
        onContainerTitleEdit={onContainerTitleEdit}
        onJumpToSource={onJumpToSource}
        setActiveSourceLine={setActiveSourceLine}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ColumnsBlock / ColumnBlock — beamer `columns` and its `\column{width}`
// markers (or nested `column` environments).
//
// Laid out side by side with the declared width fractions, so a two-column
// slide reads the way it will compile. A column whose width is an absolute
// length (`{5cm}`) has no fraction to honour and shares the remaining space
// evenly. The layout collapses to a single stack on a narrow editor pane,
// where side-by-side columns would be unreadable.
// ─────────────────────────────────────────────────────────────────────────────

function ColumnsBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: '16px',
        margin: '10px 0',
      }}
    >
      {(block.children || []).map((column) => (
        <ColumnBlock
          key={column.id}
          block={column}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      ))}
    </div>
  );
}

function ColumnBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  // `flex-basis: 0` with the fraction as the grow factor divides the row in
  // the declared proportions; `minWidth: 12rem` is what makes the row wrap
  // into a stack instead of crushing the columns in a narrow pane.
  const grow = block.width || 1;
  return (
    <div style={{ flex: `${grow} 1 0`, minWidth: '12rem' }}>
      <BlockList
        blocks={block.children}
        source={source}
        activeProjectPath={activeProjectPath}
        sourceTex={sourceTex}
        onBlockEdit={onBlockEdit}
        onListItemEdit={onListItemEdit}
        onContainerTitleEdit={onContainerTitleEdit}
        onJumpToSource={onJumpToSource}
        setActiveSourceLine={setActiveSourceLine}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AbstractBlock — `\begin{abstract}...\end{abstract}`.
//
// Renders a styled "Abstract" heading above the abstract body instead of the
// generic read-only environment fallback (raw `\begin{abstract}` dump). The
// body is parsed recursively (like `align`/`container`), so its prose stays
// fully editable through the same paragraph editing pipeline used elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

function AbstractBlock({
  block,
  source,
  activeProjectPath,
  sourceTex,
  onBlockEdit,
  onListItemEdit,
  onContainerTitleEdit,
  onJumpToSource,
  setActiveSourceLine,
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        margin: '16px 0',
        padding: '12px 20px',
        background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.02))',
        borderLeft: '3px solid var(--vscode-accent, #007acc)',
        borderRadius: '4px',
      }}
    >
      <div style={{ fontSize: '12px', fontWeight: 'bold', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vscode-text-light, #ffffff)', marginBottom: '8px' }}>
        {t('richTextEditor.block.abstract', { defaultValue: 'Abstract' })}
      </div>
      <div style={{ fontStyle: 'italic' }}>
        <BlockList
          blocks={block.children}
          source={source}
          activeProjectPath={activeProjectPath}
          sourceTex={sourceTex}
          onBlockEdit={onBlockEdit}
          onListItemEdit={onListItemEdit}
          onContainerTitleEdit={onContainerTitleEdit}
          onJumpToSource={onJumpToSource}
          setActiveSourceLine={setActiveSourceLine}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-editable blocks (rendered preview + jump to source)
// ─────────────────────────────────────────────────────────────────────────────

// ── GraphicBlock ────────────────────────────────────────────────────────────
//
// Renders a tikzpicture / PGFPlots block as a live SVG preview by asking the
// backend to compile the snippet through tectonic + PyMuPDF. The block is
// read-only: clicking anywhere outside the source-label jumps the user to
// the matching source line in Monaco.
//
// Status transitions:
//   idle -> loading -> ok  (svg set)
//   idle -> loading -> err (log set)
// Debounced re-render so the user can type freely without spawning a compile
// per keystroke.
function EditableLatexText({ as: Tag = 'div', text, onCommit, style, editingStyle = {} }) {
  const [isEditing, setIsEditing] = useState(false);
  const editRef = useRef(null);
  const activationPointRef = useRef(null);
  const safeText = text || '';

  useEffect(() => {
    if (!isEditing || !editRef.current) return;
    const el = editRef.current;
    el.textContent = safeText;
    el.focus();
    const point = activationPointRef.current;
    activationPointRef.current = null;
    if (point && setCaretFromPoint(el, point.x, point.y)) return;
    moveCaretToEnd(el);
  }, [isEditing]);

  const commit = useCallback((value) => {
    setIsEditing(false);
    if (value !== safeText) onCommit(value);
  }, [onCommit, safeText]);

  const beginEditingFromPointer = useCallback((event) => {
    activationPointRef.current = { x: event.clientX, y: event.clientY };
    setIsEditing(true);
  }, []);

  const beginEditingFromKeyboard = useCallback(() => {
    activationPointRef.current = null;
    setIsEditing(true);
  }, []);

  if (isEditing) {
    return (
      <Tag
        ref={editRef}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const editedText = readEditableText(e.currentTarget);
          e.currentTarget.replaceChildren();
          commit(editedText);
        }}
        onKeyDown={(e) => {
          const isMod = e.ctrlKey || e.metaKey;
          if (e.key === 'Tab') {
            e.preventDefault();
            e.currentTarget.blur();
            return;
          }
          if (isMod && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            insertLatexWrapper(e.currentTarget, 'textbf');
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.textContent = safeText;
            setIsEditing(false);
          }
        }}
        style={{ ...style, ...editingStyle }}
      />
    );
  }

  return (
    <Tag
      tabIndex={0}
      onMouseDown={beginEditingFromPointer}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          beginEditingFromKeyboard();
        }
      }}
      style={{ ...style, cursor: 'text' }}
    >
      {renderStyledLatexText(safeText)}
    </Tag>
  );
}

function readEditableText(el) {
  return (el.innerText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '\n\n')
    .replace(/\n+$/, '');
}
function setCaretFromPoint(el, x, y) {
  const doc = el.ownerDocument || document;
  let range = null;

  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  } else if (doc.caretRangeFromPoint) {
    range = doc.caretRangeFromPoint(x, y);
  }

  if (!range || !el.contains(range.startContainer)) return false;
  range.collapse(true);

  const selection = doc.defaultView?.getSelection?.();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function moveCaretToEnd(el) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertLatexWrapper(el, command) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;

  const start = getTextOffset(el, range.startContainer, range.startOffset);
  const end = getTextOffset(el, range.endContainer, range.endOffset);
  if (start === -1 || end === -1) return;

  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const currentText = el.textContent || '';
  const selectedText = currentText.slice(selectionStart, selectionEnd);
  const prefix = `\\${command}{`;
  const suffix = '}';
  const nextText = `${currentText.slice(0, selectionStart)}${prefix}${selectedText}${suffix}${currentText.slice(selectionEnd)}`;

  el.textContent = nextText;

  const caretOffset = selectedText
    ? selectionStart + prefix.length + selectedText.length + suffix.length
    : selectionStart + prefix.length;
  setCaretOffset(el, caretOffset);
}

function getTextOffset(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textOffset = 0;

  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === node) return textOffset + offset;
    textOffset += current.textContent.length;
  }

  if (node === root) {
    let childOffset = 0;
    for (let i = 0; i < Math.min(offset, root.childNodes.length); i++) {
      childOffset += root.childNodes[i].textContent.length;
    }
    return childOffset;
  }

  return -1;
}

function setCaretOffset(root, offset) {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let target = root;
  let targetOffset = root.childNodes.length;

  while (walker.nextNode()) {
    const current = walker.currentNode;
    const length = current.textContent.length;
    if (remaining <= length) {
      target = current;
      targetOffset = remaining;
      break;
    }
    remaining -= length;
  }

  const range = document.createRange();
  range.setStart(target, targetOffset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderInlineLatex(text) {
  return tokenizeInlineMath(text).map((token, index) => {
    if (token.type === 'text') {
      return <React.Fragment key={index}>{token.value}</React.Fragment>;
    }
    return <AsyncInlineMath key={index} math={token.value} raw={token.raw} />;
  });
}

function AsyncInlineMath({ math, raw }) {
  const { t } = useTranslation();
  const cacheKey = `${MATH_CACHE_VERSION}::inline::${hashSource(math || '')}`;
  const cancelRef = useRef(null);
  const idleApplyCancelRef = useRef(null);
  const [state, setState] = useState(() => {
    const validation = validateRenderableMath(math || '', { displayMode: false });
    if (!validation.ok) return { status: 'invalid', html: '', errorKey: validation.reasonKey, errorParams: validation.reasonParams };
    const cached = mathHtmlCache.get(cacheKey);
    return cached
      ? { status: 'ok', html: cached, errorKey: '', errorParams: {} }
      : { status: 'loading', html: '', errorKey: '', errorParams: {} };
  });

  useEffect(() => {
    if (idleApplyCancelRef.current) {
      idleApplyCancelRef.current();
      idleApplyCancelRef.current = null;
    }

    const cached = mathHtmlCache.get(cacheKey);
    const validation = validateRenderableMath(math || '', { displayMode: false });
    if (!validation.ok) {
      setState({ status: 'invalid', html: '', errorKey: validation.reasonKey, errorParams: validation.reasonParams });
      return undefined;
    }

    if (cached) {
      setState({ status: 'ok', html: cached, errorKey: '', errorParams: {} });
      return undefined;
    }

    let cancelled = false;
    setState({ status: 'loading', html: '', errorKey: '', errorParams: {} });
    const task = enqueueMathRender(math || '', false);
    cancelRef.current = () => {
      cancelled = true;
      task.cancel();
    };

    task.promise
      .then((html) => {
        if (cancelled) return;
        idleApplyCancelRef.current = scheduleMathUiIdleCallback(() => {
          if (cancelled) return;
          cancelRef.current = null;
          idleApplyCancelRef.current = null;
          if (html) {
            rememberMathHtml(cacheKey, html);
            setState({ status: 'ok', html, errorKey: '', errorParams: {} });
          } else {
            setState({ status: 'err', html: '', errorKey: 'richTextEditor.math.previewUnavailable', errorParams: {} });
          }
        });
      })
      .catch((error) => {
        if (cancelled) return;
        idleApplyCancelRef.current = scheduleMathUiIdleCallback(() => {
          if (cancelled) return;
          cancelRef.current = null;
          idleApplyCancelRef.current = null;
          setState(mathErrorStateFromError(error));
        });
      });

    return () => {
      cancelled = true;
      if (idleApplyCancelRef.current) {
        idleApplyCancelRef.current();
        idleApplyCancelRef.current = null;
      }
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
    };
  }, [cacheKey, math]);

  if (state.status === 'ok' && state.html) {
    return (
      <span
        className="rich-text-inline-math"
        data-latex={raw}
        dangerouslySetInnerHTML={{ __html: state.html }}
      />
    );
  }

  return (
    <span
      className="rich-text-inline-math-pending"
      title={state.status === 'invalid' || state.status === 'err' ? translateMathError(t, state) : raw}
      style={{
        color: state.status === 'invalid' || state.status === 'err'
          ? 'var(--vscode-errorForeground)'
          : 'var(--vscode-descriptionForeground, #888)',
        fontStyle: 'italic',
      }}
    >
      {state.status === 'invalid'
        ? t('richTextEditor.math.inlineIllFormed', { raw, defaultValue: defaultMathMessage('richTextEditor.math.inlineIllFormed') })
        : state.status === 'err'
          ? raw
          : t('richTextEditor.math.rendering', { defaultValue: defaultMathMessage('richTextEditor.math.rendering') })}
    </span>
  );
}

function rememberMathHtml(key, html) {
  mathHtmlCache.set(key, html);
  if (mathHtmlCache.size > MATH_CACHE_MAX) {
    const firstKey = mathHtmlCache.keys().next().value;
    mathHtmlCache.delete(firstKey);
  }
}

function translateMathError(t, state) {
  const key = state.errorKey || 'richTextEditor.math.previewUnavailable';
  return t(key, {
    ...(state.errorParams || {}),
    defaultValue: defaultMathMessage(key),
  });
}

function defaultMathMessage(key) {
  return {
    'richTextEditor.math.rendering': 'Rendering...',
    'richTextEditor.math.inlineIllFormed': '{{raw}} (ill-formed)',
    'richTextEditor.math.displayIllFormed': 'ill-formed\n\n{{math}}',
    'richTextEditor.math.previewUnavailable': 'Preview unavailable',
    'richTextEditor.math.workerUnavailable': 'Math worker is unavailable',
    'richTextEditor.math.renderTimedOut': 'Math render timed out',
    'richTextEditor.math.renderFailed': 'Failed to render equation',
    'richTextEditor.math.workerFailed': 'Math worker failed: {{message}}',
    'richTextEditor.math.renderCancelled': 'Math render cancelled',
    'richTextEditor.math.empty': 'Ill-formed equation: empty math block',
    'richTextEditor.math.lineBreakBeforeDelimiter': 'Ill-formed equation: line break before left/right delimiter',
    'richTextEditor.math.asteriskSubscript': 'Ill-formed equation: use _{...} for indexes instead of *{...}',
    'richTextEditor.math.operatorLimits': 'Ill-formed equation: use _{...} for operator limits',
    'richTextEditor.math.malformedEnvironment': 'Ill-formed equation: malformed environment command',
    'richTextEditor.math.unmatchedDelimiter': 'Ill-formed equation: unmatched {{delimiter}}',
    'richTextEditor.math.unsupportedEnvironment': 'Ill-formed equation: unsupported math environment {{name}}',
    'richTextEditor.math.unmatchedEndEnvironment': 'Ill-formed equation: unmatched end environment {{name}}',
    'richTextEditor.math.unmatchedBeginEnvironment': 'Ill-formed equation: unmatched begin environment {{name}}',
    'richTextEditor.math.unmatchedRightDelimiter': 'Ill-formed equation: unmatched right delimiter',
    'richTextEditor.math.unmatchedLeftDelimiter': 'Ill-formed equation: unmatched left delimiter',
  }[key] || 'Preview unavailable';
}

function makeMathError(key, params = {}) {
  const error = new Error(key);
  error.i18nKey = key;
  error.i18nParams = params;
  return error;
}

function mathErrorStateFromError(error) {
  const key = error?.i18nKey || 'richTextEditor.math.previewUnavailable';
  return {
    status: key.startsWith('richTextEditor.math.invalid')
      || key === 'richTextEditor.math.empty'
      || key === 'richTextEditor.math.lineBreakBeforeDelimiter'
      || key === 'richTextEditor.math.asteriskSubscript'
      || key === 'richTextEditor.math.operatorLimits'
      || key === 'richTextEditor.math.malformedEnvironment'
      || key === 'richTextEditor.math.unmatchedDelimiter'
      || key === 'richTextEditor.math.unsupportedEnvironment'
      || key === 'richTextEditor.math.unmatchedEndEnvironment'
      || key === 'richTextEditor.math.unmatchedBeginEnvironment'
      || key === 'richTextEditor.math.unmatchedRightDelimiter'
      || key === 'richTextEditor.math.unmatchedLeftDelimiter'
      ? 'invalid'
      : 'err',
    html: '',
    errorKey: key,
    errorParams: error?.i18nParams || {},
  };
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function markMathUiActivity() {
  lastMathUiActivityAt = nowMs();
  pauseActiveMathRender();
}

function msUntilMathUiIdle() {
  const idleFor = nowMs() - lastMathUiActivityAt;
  return Math.max(0, MATH_UI_IDLE_DELAY_MS - idleFor);
}

function scheduleMathRenderPump(delay = MATH_NEXT_RENDER_DELAY_MS) {
  if (typeof window === 'undefined' || mathPumpTimer) return;
  mathPumpTimer = window.setTimeout(() => {
    mathPumpTimer = null;
    pumpMathRenderQueue();
  }, delay);
}

function pauseActiveMathRender() {
  if (!activeMathTask || activeMathTask.paused) return;
  activeMathTask.paused = true;
  if (activeMathTask.currentCancel) activeMathTask.currentCancel();
}

function scheduleMathUiIdleCallback(callback, delay = MATH_NEXT_RENDER_DELAY_MS) {
  if (typeof window === 'undefined') {
    callback();
    return () => {};
  }

  let cancelled = false;
  let timerId = null;
  let idleId = null;

  const clearScheduled = () => {
    if (timerId !== null) window.clearTimeout(timerId);
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    }
    timerId = null;
    idleId = null;
  };

  const runWhenReady = () => {
    timerId = null;
    if (cancelled) return;

    const wait = msUntilMathUiIdle();
    if (wait > 0) {
      timerId = window.setTimeout(runWhenReady, wait);
      return;
    }

    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => {
        idleId = null;
        if (cancelled) return;
        const wait = msUntilMathUiIdle();
        if (wait > 0) {
          timerId = window.setTimeout(runWhenReady, wait);
          return;
        }
        callback();
      }, { timeout: 800 });
      return;
    }

    timerId = window.setTimeout(() => {
      timerId = null;
      if (cancelled) return;
      const wait = msUntilMathUiIdle();
      if (wait > 0) {
        timerId = window.setTimeout(runWhenReady, wait);
        return;
      }
      callback();
    }, 0);
  };

  timerId = window.setTimeout(runWhenReady, delay);
  return () => {
    cancelled = true;
    clearScheduled();
  };
}

function pumpMathRenderQueue() {
  if (typeof window === 'undefined') return;
  if (activeMathTask) return;

  const wait = msUntilMathUiIdle();
  if (wait > 0) {
    scheduleMathRenderPump(wait);
    return;
  }

  while (mathRenderQueue.length) {
    const key = mathRenderQueue.shift();
    const task = mathRenderTasks.get(key);
    if (!task || task.subscribers.size === 0 || task.status !== 'queued') {
      if (task && task.subscribers.size === 0) mathRenderTasks.delete(key);
      continue;
    }

    activeMathTask = task;
    task.status = 'running';
    task.paused = false;
    const workerTask = renderMathInWorker(task.math, task.displayMode, task.timeoutMs);
    task.currentCancel = workerTask.cancel;

    workerTask.promise
      .then((value) => {
        if (task.paused && task.subscribers.size > 0) {
          // Task was paused while in-flight. Re-enqueue so it gets another
          // chance to run when the UI is idle. Don't drop the result — the
          // next run will re-render and produce a fresh result.
          task.paused = false;
          task.status = 'queued';
          mathRenderQueue.unshift(task.key);
          return;
        }
        finishMathTask(task, null, value);
      })
      .catch((error) => {
        if (task.paused && task.subscribers.size > 0) {
          task.paused = false;
          task.status = 'queued';
          mathRenderQueue.unshift(task.key);
          return;
        }
        finishMathTask(task, error, null);
      })
      .finally(() => {
        if (activeMathTask === task) activeMathTask = null;
        task.currentCancel = null;
        // With a persistent worker, the next task can start almost
        // immediately — no need to wait for module re-initialization.
        scheduleMathRenderPump(MATH_NEXT_RENDER_DELAY_MS);
      });
    return;
  }
}

function enqueueMathRender(math, displayMode, timeoutMs = MATH_RENDER_TIMEOUT_MS) {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return {
      promise: Promise.reject(makeMathError('richTextEditor.math.workerUnavailable')),
      cancel: () => {},
    };
  }

  const validation = validateRenderableMath(math, { displayMode });
  if (!validation.ok) {
    return {
      promise: Promise.reject(makeMathError(validation.reasonKey, validation.reasonParams)),
      cancel: () => {},
    };
  }

  const key = `${MATH_CACHE_VERSION}::${displayMode ? 'display' : 'inline'}::${hashSource(validation.math)}`;
  const cached = mathHtmlCache.get(key);
  if (cached) {
    return {
      promise: Promise.resolve(cached),
      cancel: () => {},
    };
  }

  let resolveTask;
  let rejectTask;
  const promise = new Promise((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });

  let task = mathRenderTasks.get(key);
  if (!task) {
    task = {
      key,
      math: validation.math,
      displayMode,
      timeoutMs,
      status: 'queued',
      paused: false,
      currentCancel: null,
      subscribers: new Set(),
    };
    mathRenderTasks.set(key, task);
    mathRenderQueue.push(key);
  } else if (task.status === 'idle') {
    task.status = 'queued';
    mathRenderQueue.push(key);
  }

  const subscriber = {
    resolve: resolveTask,
    reject: rejectTask,
  };
  task.subscribers.add(subscriber);
  scheduleMathRenderPump(MATH_UI_IDLE_DELAY_MS);

  return {
    promise,
    cancel: () => {
      task.subscribers.delete(subscriber);
      if (task.subscribers.size === 0) {
        mathRenderTasks.delete(task.key);
        if (activeMathTask === task && task.currentCancel) task.currentCancel();
      }
    },
  };
}

function finishMathTask(task, error, value) {
  if (error) {
    for (const subscriber of task.subscribers) {
      subscriber.reject(error);
    }
  } else {
    rememberMathHtml(task.key, value);
    for (const subscriber of task.subscribers) {
      subscriber.resolve(value);
    }
  }
  task.subscribers.clear();
  task.status = 'done';
  mathRenderTasks.delete(task.key);
}

// ── Persistent Worker pool ──────────────────────────────────────────────
//
// Creating a new Worker (which re-imports and re-initializes KaTeX) for
// every equation was the primary cause of UI freezes: the browser must parse
// the module, load KaTeX (~hundreds of KB), and spin up an isolate each time.
//
// We now reuse a small pool of persistent Workers. Each request carries a
// unique `id`, so multiple renders can be in-flight on the same worker.
const MATH_WORKER_POOL_SIZE = 2;
const mathWorkerPool = [];
let mathWorkerPoolIdx = 0;
const pendingMathRequests = new Map(); // id -> { resolve, reject, timeoutId }

function getMathWorker() {
  if (typeof Worker === 'undefined') return null;

  while (mathWorkerPool.length < MATH_WORKER_POOL_SIZE) {
    const worker = new Worker(new URL('../workers/katexRenderWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const data = event.data || {};
      const req = pendingMathRequests.get(data.id);
      if (!req) return;
      pendingMathRequests.delete(data.id);
      if (req.timeoutId) window.clearTimeout(req.timeoutId);
      if (data.errorKey) req.reject(makeMathError(data.errorKey, data.errorParams || {}));
      else if (data.error) req.reject(makeMathError('richTextEditor.math.renderFailed', { message: data.error }));
      else req.resolve(data.html || '');
    };
    worker.onerror = (event) => {
      // Fail all pending requests for this worker on fatal errors
      for (const [id, req] of pendingMathRequests) {
        if (req._worker === worker) {
          pendingMathRequests.delete(id);
          if (req.timeoutId) window.clearTimeout(req.timeoutId);
          req.reject(makeMathError('richTextEditor.math.workerFailed', { message: event.message || '' }));
        }
      }
    };
    mathWorkerPool.push(worker);
  }

  const worker = mathWorkerPool[mathWorkerPoolIdx % MATH_WORKER_POOL_SIZE];
  mathWorkerPoolIdx++;
  return worker;
}

function renderMathInWorker(math, displayMode, timeoutMs) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let settled = false;
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const worker = getMathWorker();
  if (!worker) {
    rejectPromise(makeMathError('richTextEditor.math.workerUnavailable'));
    return { promise, cancel: () => {} };
  }

  const timeoutId = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    pendingMathRequests.delete(id);
    rejectPromise(makeMathError('richTextEditor.math.renderTimedOut'));
  }, timeoutMs);

  pendingMathRequests.set(id, {
    resolve: (v) => { if (!settled) { settled = true; resolvePromise(v); } },
    reject: (e) => { if (!settled) { settled = true; rejectPromise(e); } },
    timeoutId,
    _worker: worker,
  });

  worker.postMessage({ id, math, displayMode });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      pendingMathRequests.delete(id);
      if (timeoutId) window.clearTimeout(timeoutId);
      rejectPromise(makeMathError('richTextEditor.math.renderCancelled'));
    },
  };
}

function tokenizeInlineMath(text) {
  const tokens = [];
  let cursor = 0;
  let i = 0;

  const pushText = (end) => {
    if (end > cursor) tokens.push({ type: 'text', value: text.slice(cursor, end) });
  };

  while (i < text.length) {
    if (text.startsWith('\\(', i)) {
      const end = findInlineCommandMathEnd(text, i + 2);
      if (end !== -1) {
        pushText(i);
        tokens.push({
          type: 'math',
          value: text.slice(i + 2, end),
          raw: text.slice(i, end + 2),
        });
        i = end + 2;
        cursor = i;
        continue;
      }
    }

    if (text[i] === '$' && !isEscaped(text, i) && text[i + 1] !== '$' && text[i - 1] !== '$') {
      const end = findInlineDollarMathEnd(text, i + 1);
      if (end !== -1) {
        pushText(i);
        tokens.push({
          type: 'math',
          value: text.slice(i + 1, end),
          raw: text.slice(i, end + 1),
        });
        i = end + 1;
        cursor = i;
        continue;
      }
    }

    i++;
  }

  pushText(text.length);
  return tokens;
}

function findInlineCommandMathEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text.startsWith('\\)', i) && !isEscaped(text, i)) return i;
    i++;
  }
  return -1;
}

function findInlineDollarMathEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\n') return -1;
    if (text[i] === '$' && !isEscaped(text, i) && text[i + 1] !== '$') return i;
    i++;
  }
  return -1;
}

function isEscaped(text, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashCount++;
  return slashCount % 2 === 1;
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function GraphicBlock({ block, activeProjectPath, onJumpToSource }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'idle', svg: '', log: '' });
  const debounceRef = useRef(null);
  const tokenRef = useRef(0);

  const cacheKey = useMemo(() => {
    const raw = block.raw || block.source || '';
    return `${activeProjectPath || ''}::${hashSource(raw)}`;
  }, [block.raw, block.source, activeProjectPath]);

  useEffect(() => {
    // Reset in-flight token and clear pending debounce on source change.
    tokenRef.current += 1;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const raw = block.raw || block.source || '';
    if (!raw.trim()) {
      setState({ status: 'idle', svg: '', log: '' });
      return;
    }

    // Front-end cache hit: avoid a round-trip entirely.
    const cached = graphicSvgCache.get(cacheKey);
    if (cached) {
      setState({ status: 'ok', svg: cached, log: '' });
      return;
    }

    setState({ status: 'loading', svg: '', log: '' });

    debounceRef.current = setTimeout(async () => {
      const myToken = tokenRef.current;
      try {
        const res = await fetch('/api/latex/render-graphic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            graphic: raw,
            projectPath: activeProjectPath || '',
            cacheKey,
            graphicEngine: block.graphicEngine || '',
          }),
        });
        const data = await res.json();
        // Drop the result if the user has kept typing and triggered a newer
        // render — we only apply the latest in-flight response.
        if (myToken !== tokenRef.current) return;
        if (data && data.success && data.svg) {
          graphicSvgCache.set(cacheKey, data.svg);
          // Cap cache to avoid unbounded growth
          if (graphicSvgCache.size > GRAPHIC_CACHE_MAX) {
            const firstKey = graphicSvgCache.keys().next().value;
            graphicSvgCache.delete(firstKey);
          }
          setState({ status: 'ok', svg: data.svg, log: '' });
        } else {
          setState({ status: 'err', svg: '', log: (data && data.log) || 'render failed' });
        }
      } catch (err) {
        if (myToken !== tokenRef.current) return;
        setState({ status: 'err', svg: '', log: String(err) });
      }
    }, 250);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [cacheKey, block.raw, block.source, block.graphicEngine, activeProjectPath]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {block.graphicEngine === 'tikz' ? 'TikZ / PGFPlots' : 'graphic'}
        </div>
        <div
          onClick={(e) => { e.stopPropagation(); onJumpToSource(block); }}
          style={{ fontSize: '11px', color: 'var(--vscode-accent, #007acc)', cursor: 'pointer' }}
          title="Jump to source line"
        >
          jump to source →
        </div>
      </div>
      <div
        style={{
          padding: '8px',
          background: 'var(--editor-bg, #1e1e1e)',
          borderRadius: '3px',
          minHeight: '60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
        }}
      >
        {state.status === 'loading' && (
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            {t('richTextEditor.block.renderingPreview', { defaultValue: 'Rendering preview...' })}
          </span>
        )}
        {state.status === 'err' && (
          <pre
            style={{
              margin: 0,
              fontSize: '11px',
              color: 'var(--vscode-errorForeground)',
              maxHeight: '120px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              width: '100%',
            }}
            title={state.log}
          >
            {t('richTextEditor.block.previewUnavailable', {
              log: state.log.split('\n').slice(-3).join('\n').trim(),
              defaultValue: 'Preview unavailable - {{log}}',
            })}
          </pre>
        )}
        {state.status === 'ok' && (
          <div
            // The backend returns trusted SVG produced by tectonic from the
            // user's own source. Using dangerouslySetInnerHTML avoids creating
            // an <img> round-trip and keeps the SVG resolution crisp at any
            // zoom level. The block is read-only, so no user input is rendered
            // as HTML here.
            dangerouslySetInnerHTML={{ __html: state.svg }}
            style={{ maxWidth: '100%' }}
          />
        )}
      </div>
    </NonEditableWrapper>
  );
}

function NonEditableWrapper({ block, onJumpToSource, children }) {
  const { t } = useTranslation();
  return (
    <div
      onClick={() => onJumpToSource(block)}
      title="Click to jump to source"
      style={{
        position: 'relative',
        margin: '8px 0',
        padding: '8px 12px',
        background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.03))',
        border: '1px solid var(--vscode-widget-border, #2a2a2a)',
        borderRadius: '4px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-accent, #007acc)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-widget-border, #2a2a2a)'; }}
    >
      <div style={{ position: 'absolute', top: '4px', right: '6px', display: 'flex', gap: '4px', alignItems: 'center' }}>
        <Lock size={10} style={{ color: 'var(--vscode-descriptionForeground, #888)' }} />
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {t('richTextEditor.block.readOnly', { defaultValue: 'read-only' })}
        </span>
      </div>
      {children}
    </div>
  );
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function MathBlock({ block, onJumpToSource }) {
  const { t } = useTranslation();
  const math = block.math || '';
  const displayMode = block.display !== false;
  const cacheKey = `${MATH_CACHE_VERSION}::${displayMode ? 'display' : 'inline'}::${hashSource(math)}`;
  const cancelRef = useRef(null);
  const idleApplyCancelRef = useRef(null);
  const [state, setState] = useState(() => {
    const validation = validateRenderableMath(math, { displayMode });
    if (!validation.ok) return { status: 'invalid', html: '', errorKey: validation.reasonKey, errorParams: validation.reasonParams };
    const cached = mathHtmlCache.get(cacheKey);
    if (cached) return { status: 'ok', html: cached, errorKey: '', errorParams: {} };
    if (typeof window === 'undefined') {
      return { status: 'loading', html: '', errorKey: '', errorParams: {} };
    }
    return { status: 'loading', html: '', errorKey: '', errorParams: {} };
  });

  useEffect(() => {
    if (idleApplyCancelRef.current) {
      idleApplyCancelRef.current();
      idleApplyCancelRef.current = null;
    }

    const cached = mathHtmlCache.get(cacheKey);
    const validation = validateRenderableMath(math, { displayMode });
    if (!validation.ok) {
      setState({ status: 'invalid', html: '', errorKey: validation.reasonKey, errorParams: validation.reasonParams });
      return undefined;
    }

    if (cached) {
      setState({ status: 'ok', html: cached, errorKey: '', errorParams: {} });
      return undefined;
    }

    let cancelled = false;
    setState({ status: 'loading', html: '', errorKey: '', errorParams: {} });
    const task = enqueueMathRender(math, displayMode);
    cancelRef.current = () => {
      cancelled = true;
      task.cancel();
    };

    task.promise
      .then((html) => {
        if (cancelled) return;
        idleApplyCancelRef.current = scheduleMathUiIdleCallback(() => {
          if (cancelled) return;
          cancelRef.current = null;
          idleApplyCancelRef.current = null;
          if (html) {
            rememberMathHtml(cacheKey, html);
            setState({ status: 'ok', html, errorKey: '', errorParams: {} });
          } else {
            setState({ status: 'err', html: '', errorKey: 'richTextEditor.math.previewUnavailable', errorParams: {} });
          }
        });
      })
      .catch((error) => {
        if (cancelled) return;
        idleApplyCancelRef.current = scheduleMathUiIdleCallback(() => {
          if (cancelled) return;
          cancelRef.current = null;
          idleApplyCancelRef.current = null;
          setState(mathErrorStateFromError(error));
        });
      });

    return () => {
      cancelled = true;
      if (idleApplyCancelRef.current) {
        idleApplyCancelRef.current();
        idleApplyCancelRef.current = null;
      }
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
    };
  }, [cacheKey, math, displayMode]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {state.status === 'ok' && state.html ? (
        <div
          className="rich-text-display-math"
          style={{
            padding: '4px 0',
            overflowX: 'auto',
          }}
          dangerouslySetInnerHTML={{ __html: state.html }}
        />
      ) : (
        <div
          style={{
            padding: '14px 10px',
            minHeight: '48px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: state.status === 'invalid' || state.status === 'err'
              ? 'var(--vscode-errorForeground)'
              : 'var(--vscode-descriptionForeground, #888)',
            fontSize: '12px',
            fontStyle: state.status === 'err' || state.status === 'invalid' ? 'normal' : 'italic',
            textAlign: state.status === 'invalid' ? 'left' : 'center',
            whiteSpace: state.status === 'invalid' ? 'pre-wrap' : 'normal',
            wordBreak: 'break-word',
          }}
          title={state.errorKey ? translateMathError(t, state) : math}
        >
          {state.status === 'invalid'
            ? t('richTextEditor.math.displayIllFormed', { math, defaultValue: defaultMathMessage('richTextEditor.math.displayIllFormed') })
            : state.status === 'err'
              ? t('richTextEditor.math.renderFailed', { defaultValue: defaultMathMessage('richTextEditor.math.renderFailed') })
              : t('richTextEditor.math.rendering', { defaultValue: defaultMathMessage('richTextEditor.math.rendering') })}
        </div>
      )}
    </NonEditableWrapper>
  );
}

// ── FigureBlock ────────────────────────────────────────────────────────────
//
// Renders a \\begin{figure} block that just embeds an image via
// \\includegraphics{...}. The source path is resolved by the backend
// (/api/latex/render-include), which:
//   - passes raster images (PNG/JPG/GIF/WEBP) through as-is
//   - rasterizes the first page of a PDF to a PNG payload
// This means users see a real preview of their figures without compiling
// the whole document, including the \includegraphics{../illustrations/x.pdf}
// case that previously 403'd on the /api/file/raw endpoint.
// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function FigureBlock({ block, activeProjectPath, onJumpToSource, sourceTex }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'idle', src: '', mime: '', svg: '', log: '' });
  const tokenRef = useRef(0);
  const raw = block.src || block.graphicSource || '';
  const isGraphicInput = !block.src && !!block.graphicSource;

  useEffect(() => {
    if (!raw.trim()) {
      setState({ status: 'idle', src: '', mime: '', svg: '', log: '' });
      return;
    }

    if (isGraphicInput) {
      tokenRef.current += 1;
      const myToken = tokenRef.current;

      setState({ status: 'loading', src: '', mime: '', svg: '', log: '' });
      fetch('/api/latex/render-graphic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graphic: block.graphicSource || '',
          projectPath: activeProjectPath || '',
          sourceTex: sourceTex || '',
          cacheKey: '',
          graphicEngine: block.graphicEngine || 'tikz',
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (myToken !== tokenRef.current) return;
          if (data && data.success && data.svg) {
            setState({ status: 'ok', src: '', mime: '', svg: data.svg, log: '' });
          } else {
            setState({ status: 'err', src: '', mime: '', svg: '', log: (data && data.log) || 'preview failed' });
          }
        })
        .catch((err) => {
          if (myToken !== tokenRef.current) return;
          setState({ status: 'err', src: '', mime: '', svg: '', log: String(err) });
        });
      return;
    }

    // URL-encode the path components for the query string.
    const params = new URLSearchParams({
      projectPath: activeProjectPath || '',
      filePath: raw,
    });
    if (sourceTex) params.set('sourceTex', sourceTex);
    const url = `/api/latex/render-include?${params.toString()}`;

    tokenRef.current += 1;
    const myToken = tokenRef.current;

    setState({ status: 'loading', src: '', mime: '', svg: '', log: '' });
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (myToken !== tokenRef.current) return;
        if (data && data.success && data.data_base64 && data.mime) {
          setState({
            status: 'ok',
            src: `data:${data.mime};base64,${data.data_base64}`,
            mime: data.mime,
            svg: '',
            log: '',
          });
        } else {
          setState({
            status: 'err',
            src: '',
            mime: '',
            svg: '',
            log: (data && (data.error || data.log)) || 'preview failed',
          });
        }
      })
      .catch((err) => {
        if (myToken !== tokenRef.current) return;
        setState({ status: 'err', src: '', mime: '', svg: '', log: String(err) });
      });
  }, [raw, activeProjectPath, sourceTex, isGraphicInput, block.graphicSource, block.graphicEngine]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <figure style={{ margin: 0, textAlign: 'center' }}>
        {state.status === 'loading' && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', padding: '12px' }}>
            {t('richTextEditor.block.loadingImagePreview', { defaultValue: 'Loading image preview...' })}
          </div>
        )}
        {state.status === 'ok' && state.svg && (
          <div
            dangerouslySetInnerHTML={{ __html: state.svg }}
            style={{ maxWidth: '100%' }}
          />
        )}
        {state.status === 'ok' && state.src && (
          <img
            src={state.src}
            alt={block.alt || ''}
            style={{ maxWidth: '100%', borderRadius: '4px' }}
          />
        )}
        {state.status === 'err' && (
          <div
            style={{
              padding: '8px',
              fontSize: '11px',
              color: 'var(--vscode-errorForeground)',
              textAlign: 'left',
            }}
            title={state.log}
          >
            {t('richTextEditor.block.imagePreviewUnavailable', {
              log: state.log,
              defaultValue: 'Image preview unavailable - {{log}}',
            })}
          </div>
        )}
        {block.caption && (
          <figcaption style={{ fontSize: '11px', color: 'var(--chat-muted, #8a8a8a)', marginTop: '6px' }}>
            {block.caption}
          </figcaption>
        )}
        {block.label && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            [label:{block.label}]
          </div>
        )}
      </figure>
    </NonEditableWrapper>
  );
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function TableBlock({ block, onJumpToSource }) {
  const table = useMemo(() => parseTablePreview(block), [block]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {block.caption && (
        <div style={{ fontSize: '11px', color: 'var(--chat-muted, #8a8a8a)', marginBottom: '8px', textAlign: 'center' }}>
          Table: {renderCellContent(block.caption)}
        </div>
      )}
      {table && table.rows.length ? (
        <div style={{ overflowX: 'auto', padding: '2px 0' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'auto',
              fontSize: '12px',
              lineHeight: '1.45',
              color: 'var(--chat-text, var(--vscode-text-fg))',
              background: 'var(--editor-bg, #1e1e1e)',
            }}
          >
            {table.header && (
              <thead>
                <LatexTableRow row={table.header} alignments={table.alignments} isHeader />
              </thead>
            )}
            <tbody>
              {table.bodyRows.map((row, rowIndex) => (
                <LatexTableRow
                  key={rowIndex}
                  row={row}
                  alignments={table.alignments}
                  isHeader={false}
                />
              ))}
            </tbody>
          </table>
          {block.label && (
            <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginTop: '6px', textAlign: 'right' }}>
              [label:{block.label}]
            </div>
          )}
        </div>
      ) : (
        <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap' }}>
          {block.raw || block.source}
        </pre>
      )}
    </NonEditableWrapper>
  );
}

function LatexTableRow({ row, alignments, isHeader }) {
  const Cell = isHeader ? 'th' : 'td';
  const borderColor = 'var(--vscode-widget-border, #2a2a2a)';
  const topRule = row.rulesBefore.includes('toprule') || row.rulesBefore.includes('hline');
  const midRule = row.rulesBefore.includes('midrule');
  const bottomRule = row.rulesBefore.includes('bottomrule');

  return (
    <tr>
      {row.cells.map((cell, cellIndex) => (
        <Cell
          key={cellIndex}
          colSpan={cell.colSpan || 1}
          style={{
            padding: '6px 8px',
            textAlign: alignments[cellIndex] || 'left',
            fontWeight: isHeader ? 600 : 400,
            borderTop: topRule || midRule ? `1px solid ${borderColor}` : undefined,
            borderBottom: bottomRule || isHeader ? `1px solid ${borderColor}` : undefined,
            verticalAlign: 'top',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
          }}
        >
          {renderCellContent(cell.text)}
        </Cell>
      ))}
    </tr>
  );
}

function parseTablePreview(block) {
  const tabular = block.tabular || extractTabularFromSource(block.source || block.raw || '');
  if (!tabular || !tabular.body) return null;

  const rows = splitLatexTableRows(tabular.body)
    .map(parseLatexTableRow)
    .filter(row => row.cells.length > 0);

  if (!rows.length) return null;

  const alignments = parseColumnAlignments(tabular.columnSpec || '');
  const hasHeaderRule = rows.length > 1 && rows[1].rulesBefore.some(rule => rule === 'hline' || rule === 'midrule');
  const hasTopRule = rows[0].rulesBefore.includes('toprule');
  const header = hasHeaderRule || hasTopRule ? rows[0] : null;
  const bodyRows = header ? rows.slice(1) : rows;

  return { alignments, header, bodyRows, rows };
}

function extractTabularFromSource(source) {
  const match = source.match(/\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/);
  if (!match) return null;
  const envName = match[1];
  const start = match.index;
  const endRe = new RegExp(`\\\\end\\{${envName.replace('*', '\\*')}\\}`);
  const endMatch = source.slice(start).match(endRe);
  if (!endMatch) return null;
  const raw = source.slice(start, start + endMatch.index + endMatch[0].length);
  const begin = raw.match(/^\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/);
  let cursor = begin ? begin[0].length : 0;
  const args = [];
  const maxArgs = (envName.startsWith('tabularx') || envName.startsWith('tabulary') || envName === 'tabular*')
    ? 2
    : 1;
  while (raw[cursor] === '{') {
    const close = findMatchingBraceInText(raw, cursor);
    if (close === -1) break;
    args.push(raw.slice(cursor + 1, close));
    cursor = close + 1;
    if (args.length >= maxArgs) break;
  }
  const bodyEnd = raw.search(endRe);
  return {
    columnSpec: args[args.length - 1] || '',
    body: raw.slice(cursor, bodyEnd === -1 ? raw.length : bodyEnd),
  };
}

function splitLatexTableRows(body) {
  const rows = [];
  let depth = 0;
  let cursor = 0;
  let rowStart = 0;

  while (cursor < body.length) {
    const char = body[cursor];
    if (char === '{' && !isEscaped(body, cursor)) depth++;
    else if (char === '}' && !isEscaped(body, cursor) && depth > 0) depth--;
    else if (char === '\\' && body[cursor + 1] === '\\' && depth === 0) {
      rows.push(body.slice(rowStart, cursor));
      cursor += 2;
      if (body[cursor] === '[') {
        const optEnd = body.indexOf(']', cursor + 1);
        if (optEnd !== -1) cursor = optEnd + 1;
      }
      rowStart = cursor;
      continue;
    }
    cursor++;
  }

  rows.push(body.slice(rowStart));
  return rows;
}

function parseLatexTableRow(rowSource) {
  const rulesBefore = [];
  let cleaned = rowSource.trim();

  cleaned = cleaned.replace(/\\(toprule|midrule|bottomrule|hline)\b/g, (_, rule) => {
    rulesBefore.push(rule);
    return ' ';
  });
  cleaned = cleaned.replace(/\\cline\{[^}]*\}/g, () => {
    rulesBefore.push('hline');
    return ' ';
  });

  const cells = splitLatexCells(cleaned)
    .map(parseLatexCell)
    .filter(cell => cell.text.trim() || cell.colSpan > 1);

  return { rulesBefore, cells };
}

function splitLatexCells(rowSource) {
  const cells = [];
  let depth = 0;
  let cursor = 0;
  let cellStart = 0;

  while (cursor < rowSource.length) {
    const char = rowSource[cursor];
    if (char === '{' && !isEscaped(rowSource, cursor)) depth++;
    else if (char === '}' && !isEscaped(rowSource, cursor) && depth > 0) depth--;
    else if (char === '&' && !isEscaped(rowSource, cursor) && depth === 0) {
      cells.push(rowSource.slice(cellStart, cursor));
      cellStart = cursor + 1;
    }
    cursor++;
  }

  cells.push(rowSource.slice(cellStart));
  return cells;
}

function parseLatexCell(cellSource) {
  const trimmed = cellSource.trim();
  const multi = trimmed.match(/^\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
  if (multi) {
    return { text: normalizeLatexCellText(multi[2]), colSpan: Number(multi[1]) || 1 };
  }
  return { text: normalizeLatexCellText(trimmed), colSpan: 1 };
}

function normalizeLatexCellText(text) {
  return text
    .replace(/\\(centering|raggedright|raggedleft|arraybackslash)\b/g, '')
    .replace(/~+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseColumnAlignments(spec) {
  const alignments = [];
  let cursor = 0;

  while (cursor < spec.length) {
    const char = spec[cursor];
    if (char === 'l') alignments.push('left');
    else if (char === 'c') alignments.push('center');
    else if (char === 'r') alignments.push('right');
    else if (char === 'X') alignments.push('left');
    else if ('pmb'.includes(char) && spec[cursor + 1] === '{') {
      alignments.push('left');
      const close = findMatchingBraceInText(spec, cursor + 1);
      cursor = close === -1 ? cursor : close;
    } else if (char === '@' && spec[cursor + 1] === '{') {
      const close = findMatchingBraceInText(spec, cursor + 1);
      cursor = close === -1 ? cursor : close;
    }
    cursor++;
  }

  return alignments;
}

function renderCellContent(text) {
  return renderStyledLatexText(text || '');
}

function renderStyledLatexText(text) {
  return tokenizeInlineMath(text).map((token, index) => {
    if (token.type === 'text') {
      return <React.Fragment key={index}>{renderStyledTextOnly(token.value)}</React.Fragment>;
    }
    return <AsyncInlineMath key={index} math={token.value} raw={token.raw} />;
  });
}

function renderStyledTextOnly(text) {
  const commandMatch = findFirstStyleCommand(text);
  const declarationMatch = findFirstDeclaration(text);
  const noteMatch = findCommandWithArgument(text, 0, (name) => NOTE_COMMANDS.has(name));

  // Whichever construct comes first in the text is rendered first, so the
  // outer one wraps the inner one.
  const earliest = Math.min(
    commandMatch ? commandMatch.start : Infinity,
    declarationMatch ? declarationMatch.start : Infinity,
    noteMatch ? noteMatch.start : Infinity,
  );

  // A note compiles to a marker here and text at the foot of the page.
  // Splicing its argument into the sentence, the way an ordinary command's
  // argument is spliced, would read as if the author had written the note
  // into the paragraph.
  if (noteMatch && noteMatch.start === earliest) {
    return (
      <>
        {renderStyledTextOnly(text.slice(0, noteMatch.start))}
        <sup
          title={latexToPlainText(text.slice(noteMatch.argStart, noteMatch.argEnd))}
          style={{ color: 'var(--vscode-accent, #007acc)', cursor: 'help', fontSize: '0.8em', padding: '0 0.1em' }}
        >
          {'\u2020'}
        </sup>
        {renderStyledTextOnly(text.slice(noteMatch.end))}
      </>
    );
  }

  // A font declaration (`{\Huge\bfseries ...}`, or a bare `\small ...`
  // running to the end of the scope) takes no argument, so it is not found by
  // findFirstStyleCommand and used to leak into the preview as literal
  // markup.
  if (declarationMatch && declarationMatch.start === earliest) {
    return (
      <>
        {renderStyledTextOnly(text.slice(0, declarationMatch.start))}
        <span style={declarationStyle(declarationMatch.prefix)}>
          {renderStyledTextOnly(text.slice(declarationMatch.contentStart, declarationMatch.contentEnd))}
        </span>
        {renderStyledTextOnly(text.slice(declarationMatch.end))}
      </>
    );
  }

  if (!commandMatch) return stripSimpleLatexCommands(text);

  const before = text.slice(0, commandMatch.start);
  const inner = text.slice(commandMatch.contentStart, commandMatch.contentEnd);
  const after = text.slice(commandMatch.end);
  const style = {
    textbf: { fontWeight: 600 },
    textit: { fontStyle: 'italic' },
    emph: { fontStyle: 'italic' },
    texttt: { fontFamily: 'monospace' },
    textsc: { fontVariant: 'small-caps' },
    underline: { textDecoration: 'underline' },
  }[commandMatch.command] || {};

  return (
    <>
      {renderStyledTextOnly(before)}
      <span style={style}>{renderStyledTextOnly(inner)}</span>
      {renderStyledTextOnly(after)}
    </>
  );
}

function findFirstStyleCommand(text) {
  const re = /\\(textbf|textit|emph|texttt|textsc|underline)\{/g;
  const match = re.exec(text);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  const closeBrace = findMatchingBraceInText(text, openBrace);
  if (closeBrace === -1) return null;
  return {
    command: match[1],
    start: match.index,
    contentStart: openBrace + 1,
    contentEnd: closeBrace,
    end: closeBrace + 1,
  };
}

// Commands with no visible rendered output (spacing, page/line breaks,
// alignment declarations). Without this, the generic `\cmd{arg}` \u2192 `arg`
// fallback below would turn e.g. `\vspace{0.5cm}` into visible "0.5cm" text.
// Stripped only from the *preview* \u2014 the underlying block text (and thus
// the serialized source) is untouched, so the command is preserved on save.
const INVISIBLE_LATEX_COMMAND_NAMES = [
  'vspace\\*?', 'hspace\\*?', 'vskip', 'hskip',
  'smallskip', 'medskip', 'bigskip',
  'noindent', 'indent', 'par',
  'newpage', 'clearpage', 'cleardoublepage',
  'pagebreak', 'nopagebreak', 'linebreak', 'nolinebreak', 'newline',
  'allowbreak', 'nobreak', 'enlargethispage', 'FloatBarrier',
  'centering', 'raggedright', 'raggedleft',
];
const INVISIBLE_LATEX_COMMAND_RE = new RegExp(
  `\\\\(?:${INVISIBLE_LATEX_COMMAND_NAMES.join('|')})(?:\\[[^\\]]*\\])?(?:\\{[^}]*\\})?`,
  'g'
);

function stripSimpleLatexCommands(text) {
  const stripped = text
    .replace(INVISIBLE_LATEX_COMMAND_RE, '')
    .replace(/``([\s\S]*?)''/g, '"$1"')
    .replace(/\\%/g, '%')
    .replace(/\\&/g, '&')
    .replace(/\\_/g, '_')
    .replace(/\\#/g, '#')
    .replace(/~/g, '\u00a0');

  // `\cmd{arg}` → `arg`, counting braces. The regex this replaces could not:
  // it ended the argument at the first `}`, so anything containing nested
  // markup came out mangled rather than merely unrendered.
  const reduced = reduceCommandsToArguments(stripped);

  // Free-standing braces that only group — `1{,}5` reads as `1,5`. Display
  // only: the block text, and so the saved source, keeps its braces.
  //
  // Before the escaped-brace rule below, not after: `\{a\}` is a literal
  // pair of braces, and unescaping it first would turn it into a group this
  // would then strip, losing the braces the author asked for.
  return stripTransparentGroups(reduced).replace(/\\([{}])/g, '$1');
}

function findMatchingBraceInText(text, openPos) {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === '{' && !isEscaped(text, i)) depth++;
    else if (text[i] === '}' && !isEscaped(text, i)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function CodeBlock({ block, onJumpToSource }) {
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {block.lang && (
        <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
          {block.lang}
        </div>
      )}
      <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '12px', lineHeight: '1.5', fontFamily: 'monospace', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <code>{block.raw}</code>
      </pre>
    </NonEditableWrapper>
  );
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function EnvironmentBlock({ block, onJumpToSource }) {
  const { t } = useTranslation();
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
        {t('richTextEditor.block.environment', {
          name: block.envName,
          defaultValue: 'environment: {{name}}',
        })}
      </div>
      <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap' }}>
        {block.raw || block.source}
      </pre>
    </NonEditableWrapper>
  );
}

// The opening preamble block (everything before `\begin{document}`) hides
// `\documentclass`/`\usepackage` lines behind a compact summary instead of
// dumping them as raw tags — those are boilerplate the user asked not to see
// in Rich Text mode. Any other preamble content (e.g. `\newcommand`,
// `\title`) is still shown in `block.visibleSource` for context. Nothing is
// actually removed from the source: clicking still jumps to the full text in
// Monaco, and serialization keeps using `block.source` unchanged.
// The closing block (`\end{document}` onward) has no such boilerplate to
// hide, so it keeps the original raw-dump rendering.
// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function PreambleBlock({ block, onJumpToSource }) {
  const { t } = useTranslation();

  if (block.postamble) {
    return (
      <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
        <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
          {t('richTextEditor.block.preamble', { defaultValue: 'preamble' })}
        </div>
        <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', maxHeight: '120px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
          {block.raw || block.source}
        </pre>
      </NonEditableWrapper>
    );
  }

  const visibleSource = (block.visibleSource || '').trim();
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: visibleSource ? '4px' : 0 }}>
        {block.documentClass
          ? t('richTextEditor.block.preambleSummary', {
              documentClass: block.documentClass,
              count: block.packageCount || 0,
              defaultValue: 'preamble — document class: {{documentClass}}, {{count}} package(s) hidden',
            })
          : t('richTextEditor.block.preamble', { defaultValue: 'preamble' })}
      </div>
      {visibleSource && (
        <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', maxHeight: '120px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
          {visibleSource}
        </pre>
      )}
    </NonEditableWrapper>
  );
}

// Exported for reuse by the WYSIWYG mode's node views, which render the same
// previews for the blocks it preserves verbatim.
export function CommentBlock({ block }) {
  return (
    <div style={{ margin: '4px 0', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', fontStyle: 'italic' }}>
      {block.text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline LaTeX renderer
//
// The previous implementation rendered \textbf{}, \textit{}, $...$ as styled
// HTML spans inside contentEditable blocks. This caused a critical bug:
// `e.currentTarget.textContent` on blur returned the *rendered* text (without
// LaTeX commands), corrupting the source even when the user didn't edit
// anything.
//
// Fix: editable blocks render inline math only while idle. On focus, the same
// block switches back to raw LaTeX so blur serialization preserves commands.
//
// Non-editable blocks (math display, figures, tables) still render via
// KaTeX/react-markdown since they are read-only and never serialized back.
// ─────────────────────────────────────────────────────────────────────────────
