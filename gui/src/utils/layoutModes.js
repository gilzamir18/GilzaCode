// Which layout modes keep the editor and its preview on screen.
//
// Three GilzaCode layouts do: `ide`, `studio` and `document`. The fourth,
// `chat`, gives the centre to Claude Code (GilzaBots' chat layout, with Claude
// Code as the conversation). Two rules read off this list, which is why it
// lives here rather than at each call site:
//
//   - those layouts dock the explorer/source-control sidebar, so opening the
//     explorer from one of them must not switch the user to another layout
//     (`ActivityBar`'s `hasDockedSidebar`);
//   - opening a file only has to leave the layouts that hide the editor
//     (`App.jsx`'s `revealEditorLayout`), so picking a file in the explorer
//     never drops the user out of the studio or the document layout — which,
//     in the document layout, would mean leaving it for the very file it
//     exists to show.

export const EDITOR_LAYOUTS = ['ide', 'studio', 'document'];

const EDITOR_LAYOUT_SET = new Set(EDITOR_LAYOUTS);

/** Does `mode` render the editor panel? */
export const layoutShowsEditor = (mode) => EDITOR_LAYOUT_SET.has(mode);

/**
 * The layout to be in after a file is opened: the current one when it already
 * shows the editor, and the IDE layout otherwise.
 */
export const layoutAfterOpeningFile = (mode) => (layoutShowsEditor(mode) ? mode : 'ide');

// The Claude Code panel button and its Ctrl+T shortcut have nothing to switch
// in the document layout (only the file and its preview) or in the chat layout
// (where Claude Code is the layout and cannot be hidden).
const CHAT_TOGGLE_DISABLED_LAYOUTS = new Set(['chat', 'document']);

/** Can the Claude Code panel (where GilzaBots had its chat) be shown/hidden in `mode`? */
export const layoutAllowsChatToggle = (mode) => !CHAT_TOGGLE_DISABLED_LAYOUTS.has(mode);


// Layouts that dock the explorer/source-control sidebar on their left: the
// editor layouts and the chat layout, whose sidebar is the project explorer.
const SIDEBAR_LAYOUT_SET = new Set([...EDITOR_LAYOUTS, 'chat']);

/** Does `mode` dock the explorer/source-control sidebar? */
export const layoutDocksSidebar = (mode) => SIDEBAR_LAYOUT_SET.has(mode);

// Every layout the window has.
export const LAYOUT_MODES = ['ide', 'chat', 'studio', 'document'];

/**
 * What entering `mode` sets besides the mode itself; a field left out is left
 * as it is.
 *
 *   - The studio is a four-surface layout, so it opens with all four on screen
 *     — except the workspace explorer, which starts retracted because the
 *     layout exists to give the document the width. It names its bottom cell
 *     the terminal, so that cell opens on the terminal rather than on whichever
 *     tab was last read there.
 *   - The document layout is two panes and nothing else, the open document and
 *     its preview, so the explorer starts retracted for the same reason. With
 *     no document open there is nothing to give the width to, and the editor's
 *     empty state points at the file tree, so it opens on the explorer instead.
 */
export function layoutEntry(mode, { hasOpenDocument = false } = {}) {
  if (mode === 'studio') {
    return { sidebarTab: null, chatVisible: true, terminalCollapsed: false, bottomTab: 'terminal' };
  }
  if (mode === 'document') return { sidebarTab: hasOpenDocument ? null : 'explorer' };
  return {};
}

/** Switch to `mode` the way its Activity Bar button does (see `layoutEntry`). */
export function enterLayout(mode, {
  hasOpenDocument = false,
  setLayoutMode,
  setActiveSidebarTab,
  setIsChatVisible,
  setIsTerminalCollapsed,
  setActiveBottomTab,
}) {
  const entry = layoutEntry(mode, { hasOpenDocument });
  setLayoutMode(mode);
  if ('sidebarTab' in entry) setActiveSidebarTab(entry.sidebarTab);
  if ('chatVisible' in entry) setIsChatVisible(entry.chatVisible);
  if ('terminalCollapsed' in entry) setIsTerminalCollapsed(entry.terminalCollapsed);
  if ('bottomTab' in entry) setActiveBottomTab(entry.bottomTab);
}
