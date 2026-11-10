import React from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ContextMenuSurface from './ContextMenuSurface';
import SnippetActions from './SnippetActions';

/**
 * Right-click menu for the rendered Markdown preview.
 *
 * The preview had no menu at all: the app suppresses the native one globally
 * (App.jsx), so a right-click there did nothing. It now offers the same excerpt
 * actions as the PDF viewer (§2.13) plus Copy, which a rendered, read-only
 * document is expected to have.
 *
 * `menu` is { x, y, selectedText, heading } captured at right-click time, or
 * null when no menu is open — the selection has to be read then, because
 * pressing a menu item collapses it.
 */
export default function MarkdownContextMenu({
  menu,
  onClose,
  onCopy,
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

  const hasSelection = Boolean(menu.selectedText);

  const run = (action) => {
    onClose();
    action(menu);
  };

  return (
    <ContextMenuSurface
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      ariaLabel={t('markdownContextMenu.label', 'Preview actions')}
    >
      <div
        className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
        role="menuitem"
        aria-disabled={!hasSelection}
        title={hasSelection ? undefined : t('snippetActions.needsSelection', 'Select some text first.')}
        onClick={() => { if (hasSelection) run(onCopy); }}
      >
        <Copy size={13} />
        <span>{t('contextMenu.copy', 'Copy')}</span>
      </div>
      <div className="vscode-context-menu-separator" role="separator" />

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
