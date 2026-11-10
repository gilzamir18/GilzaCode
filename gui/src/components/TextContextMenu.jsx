import React from 'react';
import { Copy, Clipboard, CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SnippetActions from './SnippetActions';

/**
 * Right-click menu for plain text surfaces (the chat history, the output panel).
 *
 * The excerpt actions are optional: a surface that passes `onTranslate` gets the
 * same *Ask about* / *Translate* / *Pronounce* items the document viewers offer
 * (§2.13), from the same component, so the three menus cannot drift. A surface
 * that passes none — the output panel — keeps the plain clipboard menu it had.
 *
 * `menu` carries the excerpt captured at right-click time (`useTextContextMenu`),
 * because pressing an item collapses the selection.
 */
export default function TextContextMenu({
  menu,
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  onAskAbout,
  onLookUp,
  onTranslate,
  onPronounce,
  canAsk = true,
  canPronounce = false,
  pronounceUnavailableHint = '',
}) {
  const { t } = useTranslation();

  if (!menu) return null;

  const hasSnippetActions = Boolean(onTranslate);
  const hasSelection = Boolean(menu.selectedText);

  return (
    <div
      id="text-context-menu"
      className="vscode-context-menu"
      style={{ top: `${menu.y}px`, left: `${menu.x}px` }}
    >
      <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onCopy(); }}>
        <Copy size={13} />
        <span>{t('textContextMenu.copy')}</span>
      </div>
      <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onPaste(); }}>
        <Clipboard size={13} />
        <span>{t('textContextMenu.paste')}</span>
      </div>
      {onSelectAll && (
        <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onSelectAll(); }}>
          <CheckSquare size={13} />
          <span>{t('textContextMenu.selectAll')}</span>
        </div>
      )}

      {hasSnippetActions && (
        <>
          <div className="vscode-context-menu-separator" role="separator" />
          <SnippetActions
            hasSelection={hasSelection}
            canAsk={canAsk && Boolean(onAskAbout)}
            canPronounce={canPronounce}
            pronounceUnavailableHint={pronounceUnavailableHint}
            onAskAbout={() => onAskAbout?.(menu)}
            onLookUp={onLookUp ? (() => onLookUp(menu)) : undefined}
            onTranslate={() => onTranslate(menu)}
            onPronounce={onPronounce ? (() => onPronounce(menu)) : undefined}
          />
        </>
      )}
    </div>
  );
}
