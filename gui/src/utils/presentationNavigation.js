// Navigation conventions of the full-screen presentation surface (the PDF
// viewer's presentation mode): a presenter's habits, and the clicker in their
// hand, which sends PageDown/PageUp.
//
// Pure functions only, so the conventions are unit-tested without a DOM; the
// React lifecycle around them is `hooks/usePresentation.js`.

const KEY_ACTIONS = {
  ArrowRight: 'next',
  ArrowDown: 'next',
  PageDown: 'next',
  ' ': 'next',
  Enter: 'next',
  ArrowLeft: 'previous',
  ArrowUp: 'previous',
  PageUp: 'previous',
  Backspace: 'previous',
  Home: 'first',
  End: 'last',
  Escape: 'exit',
};

/** The presentation action a key press stands for, or null for any other key. */
export const presentationKeyAction = (key) => (
  Object.prototype.hasOwnProperty.call(KEY_ACTIONS, key) ? KEY_ACTIONS[key] : null
);

/**
 * Clicking the right two-thirds advances and the left third goes back — the
 * convention every presentation remote already follows. Both arguments are
 * viewport pixels (`event.clientX`, `window.innerWidth`), so the interface
 * scale cancels out and needs no conversion here.
 */
export const presentationClickAction = (clientX, viewportWidth) => (
  viewportWidth > 0 && clientX / viewportWidth < 0.33 ? 'previous' : 'next'
);

/**
 * `index` kept inside a presentation of `count` items. While the count is not
 * known yet (a document still loading reports 0) the requested index is kept
 * as it is, so a presentation started on page 12 does not fall back to page 1
 * before the page count arrives.
 */
export const clampPresentationIndex = (index, count) => {
  const requested = Math.max(0, Math.trunc(Number(index) || 0));
  if (!(count > 0)) return requested;
  return Math.min(requested, count - 1);
};

/** The index an action leads to. Unknown actions, and 'exit', leave it alone. */
export const applyPresentationAction = (index, action, count) => {
  const current = clampPresentationIndex(index, count);
  if (!(count > 0)) return current;
  switch (action) {
    case 'next': return Math.min(count - 1, current + 1);
    case 'previous': return Math.max(0, current - 1);
    case 'first': return 0;
    case 'last': return count - 1;
    default: return current;
  }
};

/**
 * The largest scale at which content of the given size fits the available box
 * without cropping. Returns 0 when either size is unusable, which callers treat
 * as "nothing to draw yet" rather than drawing at a made-up size.
 */
export const fitScale = (contentWidth, contentHeight, availableWidth, availableHeight) => {
  if (!(contentWidth > 0 && contentHeight > 0 && availableWidth > 0 && availableHeight > 0)) return 0;
  return Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
};
