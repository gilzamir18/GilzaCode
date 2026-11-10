import { useEffect, useLayoutEffect, useState } from 'react';
import { readUiScale, viewportPointToApp, viewportPxToApp } from '../utils/uiScale';
import { getPreference, setPreference } from '../utils/preferences';

/**
 * The movable, viewport-clamped behaviour of the excerpt popups (translation,
 * look-up), and their remembered text size.
 *
 * Both were TranslationPopup's own code. The look-up card needs exactly the same
 * behaviour — it opens over the passage being read, so it has to move out of the
 * way and must never be dragged where its header cannot be grabbed back — and a
 * second copy would be a second place for the clamp or the effect order to be
 * got wrong (§2.13).
 */

// Gap kept between the popup and the window edges, both when it opens and while
// it is dragged, so the header (and therefore the drag handle) never goes
// off-screen where it could not be grabbed back.
export const VIEWPORT_MARGIN = 8;

// Text scale of the popup, kept between 80% and 240% so the excerpt stays
// readable without the popup growing past its own scroll area. The choice is
// persisted: someone who needs larger text needs it every time.
export const MIN_TEXT_SCALE = 0.8;
export const MAX_TEXT_SCALE = 2.4;
export const TEXT_SCALE_STEP = 0.15;

const clampTextScale = (value) => (
  Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(value * 100) / 100))
);

/**
 * A text scale persisted under `storageKey`. `legacyKey`, when given, is still
 * read while `storageKey` is absent, so renaming a key does not quietly reset a
 * preference someone chose because they need larger text.
 */
export function useRememberedTextScale(storageKey, legacyKey = '') {
  const [textScale, setTextScale] = useState(() => {
    const saved = getPreference(
      storageKey,
      legacyKey ? getPreference(legacyKey, '1') : '1',
    );
    const stored = Number(saved);
    return Number.isFinite(stored) && stored > 0 ? clampTextScale(stored) : 1;
  });

  const changeTextScale = (delta) => {
    setTextScale((prev) => {
      const next = clampTextScale(prev + delta);
      setPreference(storageKey, String(next));
      return next;
    });
  };

  return [textScale, changeTextScale];
}

/**
 * Position and drag state of a floating popup.
 *
 * `anchor` is { x, y } of the click that opened it, or null while closed.
 * `anchorKey` re-anchors the popup when it changes (a new excerpt), while a
 * retry that keeps the same anchor leaves a popup the user dragged where they
 * put it. `measureKey` re-runs the viewport clamp whenever the popup's height
 * may have changed (a new phase, a new text scale).
 */
export function useFloatingPosition(popupRef, { anchor, anchorKey, measureKey }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [grab, setGrab] = useState(null);
  const open = Boolean(anchor);

  // A new excerpt re-anchors the popup at the click that asked for it.
  //
  // This must be a layout effect, and must be declared before the viewport
  // clamp below: as a passive effect it would run *after* the clamp had already
  // painted the popup at its previous (or initial) coordinates for one frame.
  useLayoutEffect(() => {
    if (!anchor) return;
    setPosition({ x: anchor.x, y: anchor.y });
  }, [anchor?.x, anchor?.y, anchorKey]);

  const startDrag = (e) => {
    // Only the header background drags; the buttons in it still click.
    if (e.button !== 0 || e.target.closest('button')) return;
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setGrab({ dx: e.clientX - rect.left, dy: e.clientY - rect.top });
    setIsDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging || !grab) return undefined;
    const handleMove = (e) => {
      setPosition(viewportPointToApp(e.clientX - grab.dx, e.clientY - grab.dy));
    };
    const endDrag = () => {
      setGrab(null);
      setIsDragging(false);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [isDragging, grab]);

  // Keep the popup inside the viewport — on open, whenever its height may have
  // changed, and on every drag step. Clamping is idempotent, so re-running it on
  // its own result settles in one pass.
  useLayoutEffect(() => {
    if (!open || !popupRef.current) return;
    // `position` is a CSS length inside the zoomed app, while the rect and the
    // window are measured in viewport pixels; the bounds have to be brought
    // into the same space before they can be compared.
    const scale = readUiScale();
    const rect = popupRef.current.getBoundingClientRect();
    const maxX = Math.max(VIEWPORT_MARGIN, viewportPxToApp(window.innerWidth - rect.width, scale) - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, viewportPxToApp(window.innerHeight - rect.height, scale) - VIEWPORT_MARGIN);
    setPosition((prev) => {
      const x = Math.min(Math.max(VIEWPORT_MARGIN, prev.x), maxX);
      const y = Math.min(Math.max(VIEWPORT_MARGIN, prev.y), maxY);
      return x === prev.x && y === prev.y ? prev : { x, y };
    });
  }, [open, anchor, measureKey, position]);

  return { position, isDragging, startDrag };
}
