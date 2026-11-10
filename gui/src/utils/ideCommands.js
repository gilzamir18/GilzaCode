// Carrying out the commands Claude Code sends to the window through the MCP
// bridge (copied from GilzaBots).
//
// The backend puts a command on /api/ide/events (gilzacode/ide_control.py) and
// waits for this window's answer, posted to /api/ide/result. A command is
// performed with the same handlers a click uses, and the answer carries the
// resulting tabs so the model's view of the window stays true.
//
// Every refusal is an answer, not a silence: the agent's tool fails with the
// reason written here, so each one names what the agent can do instead. These
// strings are read by the model, not shown as UI, and are therefore English.

import { LAYOUT_MODES } from './layoutModes.js';

export const IDE_COMMAND_ACTIONS = ['open_file', 'close_file', 'reveal_in_pdf', 'set_layout', 'get_problems',
  'get_editor_state', 'get_pdf_view'];

// Commands that act on one file of the project and so carry its path.
const FILE_ACTIONS = new Set(['open_file', 'close_file', 'reveal_in_pdf']);

const toSlashes = (value) => String(value ?? '').replace(/\\/g, '/');

/** Whether two project roots name the same directory, as the IDE compares them. */
export function sameProjectPath(left, right, { caseInsensitive = false } = {}) {
  const norm = (value) => {
    const text = toSlashes(value).trim().replace(/\/+$/, '');
    return caseInsensitive ? text.toLowerCase() : text;
  };
  return Boolean(norm(left)) && norm(left) === norm(right);
}

/** The tabs after opening `path`: appended when new, kept in place when already open. */
export function tabsAfterOpen(openFiles, path, { focus, currentFile, samePath }) {
  const tabs = openFiles.some((file) => samePath(file, path))
    ? openFiles.map((file) => (samePath(file, path) ? path : file))
    : [...openFiles, path];
  return { openFiles: tabs, currentFile: focus ? path : (currentFile || '') };
}

/** The tabs after closing `path`; a closed focused tab hands the focus to the last one, as the tab bar does. */
export function tabsAfterClose(openFiles, path, { currentFile, samePath }) {
  const remaining = openFiles.filter((file) => !samePath(file, path));
  const focused = currentFile && samePath(currentFile, path)
    ? (remaining[remaining.length - 1] || '')
    : (currentFile || '');
  return { openFiles: remaining, currentFile: focused };
}

const listTabs = (tabs) => (tabs.length ? `Open tabs: ${tabs.join(', ')}.` : 'No tabs are open.');

/**
 * The command runner, with every piece of window state reached through `deps`
 * so it reads current values (the stream handler that calls it may be an old
 * closure) and can be exercised without the app.
 *
 *   getProjectPath()       project on screen ('' when none)
 *   caseInsensitive()      whether paths compare case-insensitively
 *   samePath(a, b)
 *   openFiles(), selectedFile()
 *   opensOutside(path)     the IDE has no tab for it: the OS application opens it
 *   hasNoLines(path)       a viewer tab (PDF) with no text lines to scroll to
 *   isUnsaved(path)        the buffer differs from the disk
 *   focusTab(path, line)   what clicking the file does (line may be null)
 *   addBackgroundTab(path) a tab that does not take the focus (may be async)
 *   closeTab(path)
 *   revealInPdf(path, line) the forward search of the focused tab; resolves to
 *                          `{ ok: true, page }` or `{ ok: false, error }`
 *   setLayout(mode)        what the layout's Activity Bar button does
 *   problems()             the entries of the Problems panel
 *   editorState()          cursor, selection and editing mode of the focused tab
 *   pdfView()              what the PDF pane shows, or null when it is not open
 *
 * Resolves to `{ ok: false, error }` or `{ ok: true, ... }`: a command on a
 * file adds the resulting `open_files` and `current_file`, `reveal_in_pdf` the
 * `page` it showed, `set_layout` the `layout` and `get_problems` the `problems`.
 */
export function createIdeCommandRunner(deps) {
  return async function runIdeCommand(command) {
    const action = command?.action;
    const refuse = (error) => ({ ok: false, error });
    if (!IDE_COMMAND_ACTIONS.includes(action)) {
      return refuse(`The IDE does not know the command '${action}'.`);
    }
    const shown = deps.getProjectPath();
    if (!shown) return refuse('No project is open in the IDE window.');
    if (!sameProjectPath(command.project_path, shown, { caseInsensitive: deps.caseInsensitive() })) {
      return refuse(
        `The IDE window is showing another project (${shown}), so it was left as it is.`
        + (FILE_ACTIONS.has(action) ? ' Tell the user which file you meant instead.' : ''),
      );
    }
    const args = command.args || {};
    const path = toSlashes(args.path).trim();
    if (FILE_ACTIONS.has(action) && !path) {
      return refuse(`'${action}' needs the project-relative path of a file.`);
    }

    const tabs = deps.openFiles() || [];
    const currentFile = deps.selectedFile() || '';
    const { samePath } = deps;
    try {
      if (action === 'set_layout') {
        const layout = String(args.layout || '');
        if (!LAYOUT_MODES.includes(layout)) {
          return refuse(`The IDE has no '${layout}' layout. Layouts: ${LAYOUT_MODES.join(', ')}.`);
        }
        await deps.setLayout(layout);
        return { ok: true, layout };
      }

      if (action === 'get_problems') {
        const problems = (deps.problems() || []).map((problem) => ({
          tool: String(problem.tool || ''),
          severity: String(problem.severity || 'error'),
          source: String(problem.source || ''),
          file: toSlashes(problem.filePath || ''),
          time: String(problem.timestamp || ''),
          message: String(problem.message || ''),
        }));
        return { ok: true, problems };
      }

      if (action === 'get_editor_state') {
        const unsaved = tabs.filter((file) => deps.isUnsaved(file));
        return {
          ok: true,
          project_path: shown,
          open_files: tabs,
          current_file: currentFile,
          unsaved_files: unsaved,
          ...(deps.editorState() || {}),
        };
      }

      if (action === 'get_pdf_view') {
        const view = deps.pdfView();
        if (!view) {
          return refuse('No PDF is shown in the window: open a PDF, or the preview of a .tex file '
            + "(open_file, or reveal_in_pdf for a source line).");
        }
        return { ok: true, ...view };
      }

      if (action === 'open_file') {
        if (deps.opensOutside(path)) {
          return refuse(
            `${path} is not a file the IDE opens in a tab: it would be handed to another `
            + 'application. Mention its path in your reply instead.',
          );
        }
        const line = Number.isInteger(args.line) && args.line > 0 ? args.line : null;
        if (line && deps.hasNoLines(path)) {
          return refuse(`${path} opens in a viewer with no lines to scroll to; open it without 'line'.`);
        }
        const focus = args.focus !== false;
        const after = tabsAfterOpen(tabs, path, { focus, currentFile, samePath });
        if (focus) await deps.focusTab(path, line);
        else await deps.addBackgroundTab(path);
        return { ok: true, open_files: after.openFiles, current_file: after.currentFile };
      }

      if (action === 'reveal_in_pdf') {
        const line = Number.isInteger(args.line) && args.line > 0 ? args.line : null;
        if (!line) return refuse("'reveal_in_pdf' needs the 1-based source line to find in the PDF.");
        if (!/\.tex$/i.test(path)) {
          return refuse(`${path} is not LaTeX source, so it has no place in the PDF.`);
        }
        const after = tabsAfterOpen(tabs, path, { focus: true, currentFile, samePath });
        await deps.focusTab(path, line);
        const shown = await deps.revealInPdf(path, line);
        if (!shown?.ok) return refuse(shown?.error || `The PDF pane could not show line ${line} of ${path}.`);
        return { ok: true, page: shown.page, open_files: after.openFiles, current_file: after.currentFile };
      }

      const tab = tabs.find((file) => samePath(file, path));
      if (!tab) return refuse(`${path} is not open in the editor. ${listTabs(tabs)}`);
      if (deps.isUnsaved(tab)) {
        return refuse(
          `${tab} has unsaved edits in the editor, so its tab was left open. `
          + 'Ask the user whether to save or discard them; never close it for them.',
        );
      }
      const after = tabsAfterClose(tabs, tab, { currentFile, samePath });
      deps.closeTab(tab);
      return { ok: true, open_files: after.openFiles, current_file: after.currentFile };
    } catch (err) {
      return refuse(`The IDE failed to carry out '${action}': ${err?.message || err}`);
    }
  };
}
