import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';

/**
 * The frame every document context menu shares: placement, the viewport clamp,
 * and the three ways a menu is dismissed (click outside, another right-click,
 * Escape).
 *
 * The PDF viewer's menu owned all of this privately. Giving the Markdown
 * preview a menu of its own would have meant a second copy, and a second copy
 * drifts the first time one of them gains a behavior — the same argument that
 * put the presentation key table in one module (§2.14.1).
 *
 * `preserveSelection` suppresses the default `mousedown` inside the menu.
 * Pressing an item — a button especially, since it takes focus — collapses the
 * document selection the actions are about to act on. The selected text is
 * captured at right-click time anyway, but keeping the selection alive also
 * keeps it visible while the user reads the menu.
 */
export default function ContextMenuSurface({
  x,
  y,
  onClose,
  preserveSelection = true,
  className = 'vscode-context-menu',
  ariaLabel,
  children,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
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
  }, [onClose]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    // Compared in viewport pixels, written back as a CSS length inside the
    // zoomed app — see viewportPxToApp.
    const scale = readUiScale();
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${Math.max(4, viewportPxToApp(window.innerWidth - rect.width, scale) - 5)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${Math.max(4, viewportPxToApp(window.innerHeight - rect.height, scale) - 5)}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className={className}
      role="menu"
      aria-label={ariaLabel}
      style={{ top: `${y}px`, left: `${x}px` }}
      onMouseDown={preserveSelection ? ((event) => event.preventDefault()) : undefined}
    >
      {children}
    </div>
  );
}
