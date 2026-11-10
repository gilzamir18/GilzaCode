import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

/**
 * Small editor for an annotation's note text.
 *
 * Used both for a fresh sticky note and for the note attached to an existing
 * mark, so the two paths share one input rather than growing two dialogs that
 * drift apart. `state` is { x, y, value, title, saving, error } or null.
 *
 * Ctrl/Cmd+Enter saves and Escape cancels: a note is usually a few words typed
 * mid-read, and reaching for a button breaks that.
 */
export default function PdfNotePopup({ state, onSave, onCancel }) {
  const { t } = useTranslation();
  const textareaRef = useRef(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!state) return;
    setValue(state.value || '');
    // Let the popup mount before taking focus, otherwise the caret lands nowhere.
    const id = setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, [state]);

  if (!state) return null;

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSave(value);
    }
  };

  return (
    <div
      className="pdf-note-popup"
      style={{ top: `${state.y}px`, left: `${state.x}px` }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="pdf-note-popup-header">
        <span>{state.title || t('pdfNote.title', 'Note')}</span>
        <button type="button" onClick={onCancel} aria-label={t('pdfNote.cancel', 'Cancel')}>
          <X size={13} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="pdf-note-popup-input"
        value={value}
        rows={4}
        placeholder={t('pdfNote.placeholder', 'Write your note…')}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={state.saving}
      />
      {state.error && <div className="pdf-note-popup-error">{state.error}</div>}
      <div className="pdf-note-popup-actions">
        <span className="pdf-note-popup-hint">{t('pdfNote.saveHint', 'Ctrl+Enter to save')}</span>
        <button type="button" className="pdf-note-popup-cancel" onClick={onCancel} disabled={state.saving}>
          {t('pdfNote.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="pdf-note-popup-save"
          onClick={() => onSave(value)}
          disabled={state.saving}
        >
          {state.saving ? t('pdfNote.saving', 'Saving…') : t('pdfNote.save', 'Save')}
        </button>
      </div>
    </div>
  );
}
