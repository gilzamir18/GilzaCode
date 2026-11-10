// ─────────────────────────────────────────────────────────────────────────────
// LatexWysiwygEditor.jsx
//
// The editing surface for the LaTeX WYSIWYG mode.
//
// The `.tex` file remains the source of truth. This component holds a
// ProseMirror document derived from it, and after every change serializes that
// document back and hands the result to `onChange`. The binding produced at
// parse time (the pristine node map) is kept for the lifetime of the editing
// session, which is what lets the serializer write untouched blocks back
// byte-for-byte no matter how long the session runs.
//
// External changes — the agent editing the same file, a checkpoint restore —
// arrive as a new `source` prop that does not match what this editor last
// emitted, and rebuild the document from scratch. Echoes of our own edits are
// filtered out so typing does not tear down the editor on every keystroke.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold, Code, Italic, List, ListOrdered, Pilcrow,
  Redo2, Sigma, Underline, Undo2,
} from 'lucide-react';

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { history, redo, undo, undoDepth, redoDepth } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';

import { schema } from './schema.js';
import { fromLatex } from './fromLatex.js';
import { toLatex } from './toLatex.js';
import { buildNodeViews } from './nodeViews.jsx';
import {
  buildKeymap, insertMathBlock, setHeading, setParagraph,
  toggleBold, toggleItalic, toggleList, toggleMono, toggleUnderline,
} from './commands.js';
import './wysiwyg.css';

export default function LatexWysiwygEditor({
  source,
  activeProjectPath,
  sourceTex,
  zoomLevel = 1.0,
  onChange,
  onJumpToSource,
  onActiveSourceLineChange,
}) {
  const { t } = useTranslation();
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // The pristine binding for the document currently being edited. Deliberately
  // NOT refreshed on every keystroke: it describes the file as it was opened,
  // which is exactly the baseline "has this node changed?" needs.
  const bindingRef = useRef(null);
  // The last LaTeX this editor produced, so the resulting `source` prop update
  // is recognized as our own echo rather than an external edit.
  const lastEmittedRef = useRef(null);
  const sourceRef = useRef(source);
  const onChangeRef = useRef(onChange);
  const onJumpRef = useRef(onJumpToSource);
  const onLineRef = useRef(onActiveSourceLineChange);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onJumpRef.current = onJumpToSource; }, [onJumpToSource]);
  useEffect(() => { onLineRef.current = onActiveSourceLineChange; }, [onActiveSourceLineChange]);

  const [toolbar, setToolbar] = useState(() => emptyToolbarState());

  // Locates a preserved block in the *current* source and reports its line.
  // Offsets recorded at parse time drift as soon as anything above the block
  // is edited, so the block's own text is used as the anchor and the offset is
  // only a fallback.
  const jumpToSource = useCallback((block) => {
    const jump = onJumpRef.current;
    if (!jump || !block) return;
    const current = sourceRef.current || '';
    const raw = block.source || block.raw || '';
    const found = raw ? current.indexOf(raw) : -1;
    const offset = found === -1 ? (block.start || 0) : found;
    jump(lineFromOffset(current, offset), offset);
  }, []);

  const nodeViewOptions = useMemo(
    () => ({ activeProjectPath, sourceTex, onJumpToSource: jumpToSource }),
    [activeProjectPath, sourceTex, jumpToSource],
  );

  // ── Editor lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const binding = fromLatex(sourceRef.current || '');
    bindingRef.current = binding;

    const view = new EditorView(host, {
      state: buildState(binding.doc),
      nodeViews: buildNodeViews(nodeViewOptions),
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        // Every keystroke and cursor move produces a transaction, but the
        // toolbar only reflects a handful of booleans — re-render it when one
        // of them actually changed.
        const nextToolbar = readToolbarState(nextState);
        setToolbar((prev) => (sameToolbarState(prev, nextToolbar) ? prev : nextToolbar));

        if (!transaction.docChanged) {
          reportActiveLine(nextState, sourceRef.current, onLineRef.current);
          return;
        }
        const latex = toLatex(nextState.doc, bindingRef.current);
        lastEmittedRef.current = latex;
        sourceRef.current = latex;
        onChangeRef.current?.(latex);
        reportActiveLine(nextState, latex, onLineRef.current);
      },
    });

    viewRef.current = view;
    setToolbar(readToolbarState(view.state));
    return () => { view.destroy(); viewRef.current = null; };
    // Node view options are captured at construction; changing the project
    // path mid-session is not a thing that happens to an open file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── External source changes ───────────────────────────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (source === lastEmittedRef.current) return; // our own edit coming back
    if (source === sourceRef.current) return;

    sourceRef.current = source;
    const binding = fromLatex(source || '');
    bindingRef.current = binding;
    lastEmittedRef.current = null;
    view.updateState(buildState(binding.doc));
    setToolbar(readToolbarState(view.state));
  }, [source]);

  const command = useCallback((fn) => () => {
    const view = viewRef.current;
    if (!view) return;
    fn(view.state, view.dispatch);
    view.focus();
  }, []);

  return (
    <div className="ltx-wysiwyg" style={{ fontSize: `${Math.round(15 * zoomLevel)}px` }}>
      <div className="ltx-toolbar">
        <ToolbarButton
          onClick={command(undo)} disabled={!toolbar.canUndo}
          label={t('wysiwyg.undo', { defaultValue: 'Undo' })}
        ><Undo2 size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(redo)} disabled={!toolbar.canRedo}
          label={t('wysiwyg.redo', { defaultValue: 'Redo' })}
        ><Redo2 size={13} /></ToolbarButton>

        <span className="ltx-toolbar-separator" />

        <ToolbarButton
          onClick={command(toggleBold)} active={toolbar.strong}
          label={t('wysiwyg.bold', { defaultValue: 'Bold (\\textbf)' })}
        ><Bold size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(toggleItalic)} active={toolbar.em}
          label={t('wysiwyg.italic', { defaultValue: 'Italic (\\textit)' })}
        ><Italic size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(toggleUnderline)} active={toolbar.underline}
          label={t('wysiwyg.underline', { defaultValue: 'Underline (\\underline)' })}
        ><Underline size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(toggleMono)} active={toolbar.code}
          label={t('wysiwyg.monospace', { defaultValue: 'Monospace (\\texttt)' })}
        ><Code size={13} /></ToolbarButton>

        <span className="ltx-toolbar-separator" />

        <ToolbarButton
          onClick={command(setParagraph)} active={toolbar.blockType === 'paragraph'}
          label={t('wysiwyg.paragraph', { defaultValue: 'Paragraph' })}
        ><Pilcrow size={13} /></ToolbarButton>
        {[2, 3, 4].map((level) => (
          <ToolbarButton
            key={level}
            onClick={command(setHeading(level))}
            active={toolbar.blockType === 'heading' && toolbar.level === level}
            label={t('wysiwyg.headingLevel', { defaultValue: 'Heading level {{level}}', level })}
          >{`H${level - 1}`}</ToolbarButton>
        ))}

        <span className="ltx-toolbar-separator" />

        <ToolbarButton
          onClick={command(toggleList('itemize'))} active={toolbar.list === 'itemize'}
          label={t('wysiwyg.itemize', { defaultValue: 'Bullet list (itemize)' })}
        ><List size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(toggleList('enumerate'))} active={toolbar.list === 'enumerate'}
          label={t('wysiwyg.enumerate', { defaultValue: 'Numbered list (enumerate)' })}
        ><ListOrdered size={13} /></ToolbarButton>
        <ToolbarButton
          onClick={command(insertMathBlock)}
          label={t('wysiwyg.displayMath', { defaultValue: 'Display formula' })}
        ><Sigma size={13} /></ToolbarButton>
      </div>

      <div className="ltx-wysiwyg-page" ref={hostRef} />
    </div>
  );
}

function ToolbarButton({ onClick, active, disabled, label, children }) {
  return (
    <button
      type="button"
      className={`ltx-toolbar-button${active ? ' is-active' : ''}`}
      onMouseDown={(event) => event.preventDefault()} // keep the selection
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active ? 'true' : undefined}
    >
      {children}
    </button>
  );
}

function buildState(doc) {
  return EditorState.create({
    doc,
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
      keymap(buildKeymap()),
      keymap(baseKeymap),
      dropCursor({ color: 'var(--vscode-accent, #007acc)' }),
    ],
  });
}

function sameToolbarState(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

function emptyToolbarState() {
  return {
    strong: false, em: false, underline: false, code: false,
    blockType: null, level: null, list: null, canUndo: false, canRedo: false,
  };
}

// Reads the formatting state under the cursor so the toolbar reflects what the
// text actually is, rather than what was last clicked.
function readToolbarState(state) {
  const { $from, from, to, empty } = state.selection;
  const stored = state.storedMarks;

  const hasMark = (type) => {
    if (empty) return !!type.isInSet(stored || $from.marks());
    return state.doc.rangeHasMark(from, to, type);
  };

  let blockType = null;
  let level = null;
  let list = null;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!blockType && (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading)) {
      blockType = node.type.name;
      level = node.attrs.level ?? null;
    }
    if (!list && node.type === schema.nodes.list) list = node.attrs.envName;
  }

  return {
    strong: hasMark(schema.marks.strong),
    em: hasMark(schema.marks.em),
    underline: hasMark(schema.marks.underline),
    code: hasMark(schema.marks.code),
    blockType,
    level,
    list,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

// Reports which source line the cursor is over, so switching back to the
// source editor lands where the user was looking.
function reportActiveLine(state, currentSource, report) {
  if (!report || !currentSource) return;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const raw = $from.node(depth).attrs?.raw;
    if (!raw) continue;
    const offset = currentSource.indexOf(raw);
    if (offset !== -1) {
      report(lineFromOffset(currentSource, offset));
      return;
    }
  }
}

function lineFromOffset(source, offset) {
  let line = 1;
  const limit = Math.min(Math.max(0, offset || 0), source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}
