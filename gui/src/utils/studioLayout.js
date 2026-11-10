// Geometry of the "studio" layout.
//
// The studio puts the four surfaces a document is actually written with on one
// screen: the editor and its preview across the top, the chat and the terminal
// side by side underneath, and the workspace explorer docked to the left of all
// of them (retracted on entry, since the layout exists to give the document the
// width, not the file tree).
//
// It reuses the IDE layout's own components at their existing positions in the
// React tree — only the CSS placement changes — so switching into and out of it
// never remounts the editor or tears down a running terminal. That is why this
// module produces a grid template instead of a component tree: the layout is a
// `grid-template-columns` / `grid-template-rows` pair applied to
// `.vscode-studio-layout`, with the panels routed into named areas by class
// (see index.css).

export const STUDIO_CHAT_WIDTH_DEFAULT = 460;
export const STUDIO_CHAT_WIDTH_MIN = 260;
export const STUDIO_CHAT_WIDTH_MAX = 1400;

// Tall enough that the chat's header, picker and composer still leave the
// history something to show — that row is the layout's conversation surface,
// not a status strip.
export const STUDIO_BOTTOM_HEIGHT_DEFAULT = 360;
export const STUDIO_BOTTOM_HEIGHT_MIN = 140;
// The bottom row is capped as a fraction of the window rather than at a pixel
// count: a fixed ceiling is too low to be useful on a tall screen and taller
// than the window itself on a short one.
export const STUDIO_BOTTOM_HEIGHT_MAX_RATIO = 0.75;

// Thickness of the drag handles, matching .vscode-resizer-* in index.css. The
// grid has to reserve the track, so the number lives on both sides.
export const STUDIO_SPLITTER_PX = 4;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Number(null) and Number('') are 0, which would clamp a missing size down to
// the minimum instead of restoring the default — the same trap clampUiScale
// documents.
const toFinite = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Width of the chat column, clamped to a range that keeps both cells usable. */
export const clampStudioChatWidth = (value) =>
  clamp(toFinite(value, STUDIO_CHAT_WIDTH_DEFAULT), STUDIO_CHAT_WIDTH_MIN, STUDIO_CHAT_WIDTH_MAX);

/**
 * Height of the bottom row. `availableHeight` is the app-space height of the
 * window; without a usable one only the floor is enforced, so a drag started
 * before the window has been measured still behaves.
 */
export const clampStudioBottomHeight = (value, availableHeight) => {
  const height = toFinite(availableHeight, 0);
  const max = height > 0
    ? Math.max(STUDIO_BOTTOM_HEIGHT_MIN, height * STUDIO_BOTTOM_HEIGHT_MAX_RATIO)
    : Number.POSITIVE_INFINITY;
  return clamp(toFinite(value, STUDIO_BOTTOM_HEIGHT_DEFAULT), STUDIO_BOTTOM_HEIGHT_MIN, max);
};

/**
 * Grid template for the studio's centre area, plus which drag handles that
 * template leaves room for. A hidden cell collapses to a zero track instead of
 * dropping out of the template, so the surviving cell grows into the space and
 * the panels keep their grid areas either way.
 */
export function studioGridTemplate({
  chatWidth = STUDIO_CHAT_WIDTH_DEFAULT,
  bottomHeight = STUDIO_BOTTOM_HEIGHT_DEFAULT,
  isChatVisible = true,
  isTerminalVisible = true,
  isEditorMaximized = false,
  isBottomMaximized = false,
} = {}) {
  const isBottomVisible = (isChatVisible || isTerminalVisible) && !isEditorMaximized;
  // Maximising the bottom row only means anything while it is on screen.
  const isTopVisible = !(isBottomVisible && isBottomMaximized);
  const showChat = isBottomVisible && isChatVisible;
  const showTerminal = isBottomVisible && isTerminalVisible;

  const showRowResizer = isBottomVisible && isTopVisible;
  const showColumnResizer = showChat && showTerminal;

  let gridTemplateRows;
  if (!isBottomVisible) gridTemplateRows = 'minmax(0, 1fr) 0px 0px';
  else if (!isTopVisible) gridTemplateRows = '0px 0px minmax(0, 1fr)';
  else gridTemplateRows = `minmax(0, 1fr) ${STUDIO_SPLITTER_PX}px ${clampStudioBottomHeight(bottomHeight)}px`;

  let gridTemplateColumns;
  if (showChat && showTerminal) {
    gridTemplateColumns = `${clampStudioChatWidth(chatWidth)}px ${STUDIO_SPLITTER_PX}px minmax(0, 1fr)`;
  } else if (showTerminal) {
    gridTemplateColumns = '0px 0px minmax(0, 1fr)';
  } else {
    // Chat alone, and the row-hidden case: the first track is the only one with
    // a cell in it, so it takes the width.
    gridTemplateColumns = 'minmax(0, 1fr) 0px 0px';
  }

  return { gridTemplateColumns, gridTemplateRows, showRowResizer, showColumnResizer };
}
