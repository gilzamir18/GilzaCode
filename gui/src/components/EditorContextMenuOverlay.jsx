import { useEffect, useRef } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { pastePlainTextIntoMonaco } from '../utils/monacoPaste';

/**
 * Custom context menu overlay for the Monaco editor.
 * Replaces Monaco's built-in Shadow DOM menu which has a hover highlight
 * offset bug due to non-uniform item heights in its internal scroll widget.
 *
 * Renders in normal DOM with full CSS control.
 */
export default function EditorContextMenuOverlay({ menu, onClose, setInlinePrompt, t }) {
  const ref = useRef(null);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  // Position adjustment: keep menu inside viewport
  useEffect(() => {
    if (!ref.current) return;
    // Compared in viewport pixels, written back as a CSS length inside the
    // zoomed app — see viewportPxToApp.
    const scale = readUiScale();
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) ref.current.style.left = `${viewportPxToApp(vw - rect.width, scale) - 4}px`;
    if (rect.bottom > vh) ref.current.style.top = `${viewportPxToApp(vh - rect.height, scale) - 4}px`;
  }, [menu]);

  const { editor, monaco, hasSelection, selectedText, pos, sel } = menu;

  // Helper to get inline prompt coordinates from the editor
  const getPromptCoords = () => {
    const coords = editor.getScrolledVisiblePosition(pos);
    const domNode = editor.getDomNode();
    // Two coordinate spaces meet here: the editor's bounding rect is in viewport
    // pixels, while Monaco reports `coords` in its own CSS pixels — already
    // inside the zoomed app. Only the rect needs converting.
    const scale = readUiScale();
    const rect = domNode?.getBoundingClientRect() ?? { left: 200, top: 100 };
    return {
      x: viewportPxToApp(rect.left, scale) + (coords?.left ?? 60) + 20,
      y: viewportPxToApp(rect.top, scale) + (coords?.top ?? 40) + 24,
    };
  };

  const handleCut = () => {
    editor.focus();
    document.execCommand('cut');
    onClose();
  };

  const handleCopy = () => {
    editor.focus();
    document.execCommand('copy');
    onClose();
  };

  const handlePaste = async () => {
    try {
      const res = await fetch('/api/clipboard/read');
      const data = await res.json();
      const text = data.text ?? '';
      if (text) pastePlainTextIntoMonaco(editor, text);
    } catch (_) {}
    onClose();
  };

  const handleRefine = () => {
    const { x, y } = getPromptCoords();
    setInlinePrompt({
      x, y,
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      startColumn: sel.startColumn,
      endColumn: sel.endColumn,
      cursorCol: pos?.column ?? 1,
      selectedText,
      mode: 'refine',
    });
    onClose();
  };

  const handleCreateIllustration = () => {
    const { x, y } = getPromptCoords();
    setInlinePrompt({
      x, y,
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      startColumn: sel.startColumn,
      endColumn: sel.endColumn,
      cursorCol: pos?.column ?? 1,
      selectedText,
      mode: 'createIllustration',
    });
    onClose();
  };

  const handleGenerate = () => {
    const { x, y } = getPromptCoords();
    const selObj = editor.getSelection();
    const selText = (selObj && !selObj.isEmpty()) ? editor.getModel()?.getValueInRange(selObj) : '';
    setInlinePrompt({
      x, y,
      startLine: pos.lineNumber,
      endLine: pos.lineNumber,
      startColumn: pos.column,
      endColumn: pos.column,
      cursorCol: pos.column,
      selectedText: selText,
      mode: 'generate',
    });
    onClose();
  };

  const handleCommandPalette = () => {
    editor.focus();
    editor.trigger('keyboard', 'editor.action.quickCommand', null);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="editor-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className="editor-ctx-item" onClick={handleCut}>
        <span className="editor-ctx-label">{t('contextMenu.cut', 'Cut')}</span>
        <span className="editor-ctx-key">Ctrl+X</span>
      </button>
      <button className="editor-ctx-item" onClick={handleCopy}>
        <span className="editor-ctx-label">{t('contextMenu.copy', 'Copy')}</span>
        <span className="editor-ctx-key">Ctrl+C</span>
      </button>
      <button className="editor-ctx-item" onClick={handlePaste}>
        <span className="editor-ctx-label">{t('contextMenu.paste', 'Paste')}</span>
        <span className="editor-ctx-key">Ctrl+V</span>
      </button>

      <div className="editor-ctx-separator" />

      {hasSelection && (
        <>
          <button className="editor-ctx-item" onClick={handleRefine}>
            <span className="editor-ctx-label">{t('editorPanel.refineSelection', 'Refine Selection (GilzaBots)')}</span>
          </button>
          <button className="editor-ctx-item" onClick={handleCreateIllustration}>
            <span className="editor-ctx-label">{t('editorPanel.createIllustration', 'Create Illustration (GilzaBots)')}</span>
          </button>
        </>
      )}
      <button className="editor-ctx-item" onClick={handleGenerate}>
        <span className="editor-ctx-label">{t('editorPanel.generateCode', 'Generate Content (GilzaBots)')}</span>
      </button>

      <div className="editor-ctx-separator" />

      <button className="editor-ctx-item" onClick={handleCommandPalette}>
        <span className="editor-ctx-label">{t('contextMenu.commandPalette', 'Command Palette')}</span>
        <span className="editor-ctx-key">F1</span>
      </button>
    </div>
  );
}
