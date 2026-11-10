import { useEffect, useRef } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { useTranslation } from 'react-i18next';

/**
 * Right-click context menu for the editor tab bar.
 *
 * `menu` is { x, y, filePath } for the tab that was right-clicked, or null
 * when no menu is open. Reuses the editor context menu styling so both menus
 * look the same.
 */
export default function TabContextMenu({ menu, onClose, onCloseTab, onCloseOthers, onCloseAll, tabCount }) {
  const { t } = useTranslation();
  const ref = useRef(null);

  // Close on click outside, on another right-click, or on Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('contextmenu', handleClick, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('contextmenu', handleClick, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [menu, onClose]);

  // Keep the menu inside the viewport.
  useEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    // Compared in viewport pixels, written back as a CSS length inside the
    // zoomed app — see viewportPxToApp.
    const scale = readUiScale();
    if (rect.right > window.innerWidth) ref.current.style.left = `${viewportPxToApp(window.innerWidth - rect.width, scale) - 4}px`;
    if (rect.bottom > window.innerHeight) ref.current.style.top = `${viewportPxToApp(window.innerHeight - rect.height, scale) - 4}px`;
  }, [menu]);

  if (!menu) return null;

  const run = (action) => {
    onClose();
    action(menu.filePath);
  };

  const hasOthers = tabCount > 1;

  return (
    <div ref={ref} className="editor-ctx-menu" style={{ left: menu.x, top: menu.y }}>
      <button className="editor-ctx-item" onClick={() => run(onCloseTab)}>
        <span className="editor-ctx-label">{t('tabContextMenu.close', 'Close')}</span>
      </button>
      <button className="editor-ctx-item" onClick={() => run(onCloseOthers)} disabled={!hasOthers}>
        <span className="editor-ctx-label">{t('tabContextMenu.closeOthers', 'Close Others')}</span>
      </button>
      <button className="editor-ctx-item" onClick={() => run(onCloseAll)}>
        <span className="editor-ctx-label">{t('tabContextMenu.closeAll', 'Close All')}</span>
      </button>
    </div>
  );
}
