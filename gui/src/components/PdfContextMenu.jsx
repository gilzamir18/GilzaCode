import React from 'react';
import { Highlighter, Underline, Strikethrough, StickyNote, Trash2, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ContextMenuSurface from './ContextMenuSurface';
import SnippetActions from './SnippetActions';

/**
 * Right-click context menu for the PDF viewer.
 *
 * `menu` is { x, y, selectedText, page, point, annotation } for the spot that was
 * right-clicked, or null when no menu is open. "Translate" and the markup tools
 * only apply to a selected excerpt, so they stay disabled while the selection is
 * empty. When the click landed on an existing annotation, `menu.annotation` holds
 * it and the menu leads with the actions for that mark.
 *
 * What is left here is what is genuinely PDF-specific: the annotations. The
 * excerpt actions below the separator are shared with every other document
 * surface (SnippetActions), and the frame — placement, viewport clamp,
 * dismissal, keeping the selection alive — is shared too (ContextMenuSurface).
 */

// Highlighter colors offered for a new mark. Kept deliberately short: a long
// palette turns a one-gesture action into a decision.
export const ANNOTATION_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];

export default function PdfContextMenu({
  menu,
  onClose,
  onAskAbout,
  onLookUp,
  onTranslate,
  onPronounce,
  canAsk = true,
  canPronounce = false,
  pronounceUnavailableHint = '',
  canAnnotate = false,
  annotationColor = ANNOTATION_COLORS[0],
  onAnnotate,
  onEditNote,
  onRemoveAnnotation,
}) {
  const { t } = useTranslation();

  if (!menu) return null;

  const hasSelection = Boolean(menu.selectedText);
  const target = menu.annotation;
  // Marks written by other software can use subtypes this viewer cannot recreate.
  // They are shown, never offered for editing.
  const canEditTarget = Boolean(target && target.editable);

  const run = (action, ...args) => {
    onClose();
    action(menu, ...args);
  };

  const markupItem = (kind, Icon, labelKey, fallback) => (
    <div
      className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
      role="menuitem"
      aria-disabled={!hasSelection}
      title={hasSelection ? undefined : t('pdfContextMenu.annotateNeedsSelection', 'Select some text in the PDF first.')}
      onClick={() => { if (hasSelection) run(onAnnotate, kind, annotationColor); }}
    >
      <Icon size={13} style={{ color: annotationColor }} />
      <span>{t(labelKey, fallback)}</span>
    </div>
  );

  return (
    <ContextMenuSurface
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      ariaLabel={t('pdfContextMenu.label', 'PDF actions')}
    >
      {canAnnotate && target && (
        <>
          <div
            className={`vscode-context-menu-item${canEditTarget ? '' : ' vscode-context-menu-item-disabled'}`}
            role="menuitem"
            aria-disabled={!canEditTarget}
            title={canEditTarget ? undefined : t('pdfContextMenu.annotationNotEditable', 'This annotation was made by other software and cannot be edited here.')}
            onClick={() => { if (canEditTarget) run(onEditNote); }}
          >
            <PenLine size={13} style={{ color: 'var(--vscode-fg-link)' }} />
            <span>{t('pdfContextMenu.editNote', 'Edit note')}</span>
          </div>
          <div
            className={`vscode-context-menu-item${canEditTarget ? '' : ' vscode-context-menu-item-disabled'}`}
            role="menuitem"
            aria-disabled={!canEditTarget}
            onClick={() => { if (canEditTarget) run(onRemoveAnnotation); }}
          >
            <Trash2 size={13} style={{ color: 'var(--vscode-fg-danger)' }} />
            <span>{t('pdfContextMenu.removeAnnotation', 'Remove annotation')}</span>
          </div>
          <div className="vscode-context-menu-separator" role="separator" />
        </>
      )}

      {canAnnotate && (
        <>
          {markupItem('highlight', Highlighter, 'pdfContextMenu.highlight', 'Highlight')}
          <div className="pdf-annotation-swatches" role="group" aria-label={t('pdfContextMenu.highlightColor', 'Highlight color')}>
            {ANNOTATION_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`pdf-annotation-swatch${color === annotationColor ? ' pdf-annotation-swatch-active' : ''}`}
                style={{ background: color }}
                aria-label={color}
                disabled={!hasSelection}
                onClick={() => { if (hasSelection) run(onAnnotate, 'highlight', color); }}
              />
            ))}
          </div>
          {markupItem('underline', Underline, 'pdfContextMenu.underline', 'Underline')}
          {markupItem('strikeout', Strikethrough, 'pdfContextMenu.strikeout', 'Strike through')}
          <div
            className="vscode-context-menu-item"
            role="menuitem"
            onClick={() => run(onEditNote)}
          >
            <StickyNote size={13} style={{ color: 'var(--vscode-fg-warning)' }} />
            <span>{t('pdfContextMenu.addNote', 'Add a note here')}</span>
          </div>
          <div className="vscode-context-menu-separator" role="separator" />
        </>
      )}

      <SnippetActions
        hasSelection={hasSelection}
        canAsk={canAsk}
        canPronounce={canPronounce}
        pronounceUnavailableHint={pronounceUnavailableHint}
        onAskAbout={() => run(onAskAbout)}
        onLookUp={onLookUp ? (() => run(onLookUp)) : undefined}
        onTranslate={() => run(onTranslate)}
        onPronounce={onPronounce ? (() => run(onPronounce)) : undefined}
      />
    </ContextMenuSurface>
  );
}
