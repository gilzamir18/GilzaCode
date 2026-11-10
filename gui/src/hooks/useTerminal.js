import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from 'react-i18next';
import { terminalRenderFontSize } from '../utils/terminalScale.js';

// Terminal font size, adjustable per panel on top of the global interface
// scale (see utils/uiScale.js): the global scale sets a comfortable baseline
// for the whole app, this tunes the terminal relative to it.
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 28;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_SIZE_STORAGE_KEY = 'terminalFontSize';

export const clampTerminalFontSize = (value) => {
  const size = Number(value);
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
};

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff',
  foreground: '#171a23',
  cursor: '#5847d6',
  // xterm defaults to a white 30% selection layer, which is invisible over the
  // white light-theme background, so both themes set it explicitly.
  selectionBackground: '#d9d3fc',
  selectionInactiveBackground: '#e6e8ef',
  black: '#000000',
  red: '#a1260d',
  green: '#008000',
  yellow: '#795e00',
  blue: '#0451a5',
  magenta: '#811f7c',
  cyan: '#007acc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#a1260d',
  brightGreen: '#098658',
  brightYellow: '#795e00',
  brightBlue: '#0451a5',
  brightMagenta: '#811f7c',
  brightCyan: '#007acc',
  brightWhite: '#171a23'
};

const DARK_TERMINAL_THEME = {
  background: '#11141b',
  foreground: '#dcdfe8',
  cursor: '#8b7cf6',
  selectionBackground: '#3a3480',
  selectionInactiveBackground: '#262a3b',
};

// Hook that initialises an xterm.js terminal and connects it to the backend SSE stream.
// `redrawPromptOnShow` sends one Enter the first time the terminal is shown, so a
// shell draws a fresh prompt. It must be off for anything that is not a shell: in
// Claude Code that Enter would answer whatever dialog is on screen (the folder
// trust prompt on a first run). `onStreamClosed` is called when the server ends
// the stream for good: an `ended` event (Claude Code exited by itself), or a
// reconnect that is refused (EventSource stops retrying).
// `onConnectionChange('reconnecting' | 'open')` lets the caller show the
// reconnection itself; without it, a lost connection is written into the terminal.
// Changing `connectionKey` reconnects (after a restart).
export function useTerminal({ activeProject, terminalRef, terminalInstanceRef, fitAddonRef, eventSourceRef, activeBottomTab, bottomPanelHeight, isTerminalCollapsed, theme, termId = 'main', isActive = true, fontSize = TERMINAL_FONT_SIZE_DEFAULT, uiScale = 1, onZoomIn, onZoomOut, onZoomReset, redrawPromptOnShow = true, onStreamClosed, onConnectionChange, connectionKey = 0 }) {
  const { t } = useTranslation();
  // The terminal effect must not be torn down just because the language changed,
  // so `t` is read through a ref instead of being an effect dependency.
  const tRef = useRef(t);
  tRef.current = t;
  const onStreamClosedRef = useRef(onStreamClosed);
  onStreamClosedRef.current = onStreamClosed;
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const promptDrawnRef = useRef(false);
  // Written on every render so the ResizeObserver callback (a closure created
  // once at mount) always reads the latest value without a stale-closure race.
  const isCollapsedRef = useRef(isTerminalCollapsed);
  isCollapsedRef.current = isTerminalCollapsed;
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  // Whether the viewport is parked above the live output. Mirrored in a ref so
  // the xterm listeners (created once per terminal) only call setState when the
  // value actually flips, instead of on every written chunk.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const isScrolledUpRef = useRef(false);
  // Read at terminal construction time. Kept in a ref so changing the size
  // re-styles the live terminal instead of tearing it down and losing the
  // visible scrollback, which depending on `fontSize` in the mount effect would.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;
  // The key handler is installed once with the terminal; reading the callbacks
  // through a ref keeps it from going stale when the panel re-renders.
  const zoomHandlersRef = useRef({});
  zoomHandlersRef.current = { onZoomIn, onZoomOut, onZoomReset };

  // Update terminal theme dynamically when theme changes
  useEffect(() => {
    if (terminalInstanceRef.current) {
      const isLight = theme === 'light';
      terminalInstanceRef.current.options.theme = isLight ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
    }
  }, [theme, terminalInstanceRef]);

  // Only the project path matters to the terminal session. `activeProject` gets
  // a fresh object identity on unrelated updates (chat switch, model change,
  // project settings), and depending on the object itself would dispose the
  // xterm instance and wipe the visible scrollback every time.
  const projectPath = activeProject ? activeProject.project_path : null;

  // Re-measure the terminal and tell the backend PTY about the new geometry.
  // The shell wraps its own output, so a resize that is not reported leaves it
  // wrapping at the old width. Callers apply their own visibility guards first.
  const syncTerminalSize = useCallback(() => {
    const term = terminalInstanceRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !terminalRef.current) return;
    try {
      if (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0) return;
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols > 0 && rows > 0 && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
        lastSizeRef.current = { cols, rows };
        fetch('/api/terminal/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ term_id: termId, action: 'resize', cols, rows, projectPath }),
        }).catch(err => console.error('Failed to send terminal resize', err));
      }
    } catch (e) { /* ignore */ }
  }, [termId, projectPath, terminalInstanceRef, fitAddonRef, terminalRef]);

  // Apply a font-size change to the live terminal. Fewer/more columns fit at the
  // new size, so the fit and the PTY resize have to follow it.
  useEffect(() => {
    const term = terminalInstanceRef.current;
    if (!term) return;
    term.options.fontSize = terminalRenderFontSize(fontSize, uiScale);
    syncTerminalSize();
  }, [fontSize, uiScale, syncTerminalSize, terminalInstanceRef]);

  // Initialise / tear-down terminal when the active project changes.
  useEffect(() => {
    if (!projectPath) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    if (!terminalRef.current) return;

    // Reset the prompt-drawn flag whenever the terminal is (re)created.
    promptDrawnRef.current = false;
    isScrolledUpRef.current = false;
    setIsScrolledUp(false);

    const isLight = document.body.classList.contains('light-theme');
    const termTheme = isLight ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: terminalRenderFontSize(fontSizeRef.current, uiScaleRef.current),
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: termTheme,
    });

    // Ctrl +/- resizes the terminal font, matching the editor's own shortcut.
    // xterm would otherwise swallow these, so they are claimed through its
    // documented interception hook. The interface-wide scale is Ctrl+Shift+/-,
    // which is deliberately let through to the window handler.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const isCtrl = ev.ctrlKey || ev.metaKey;
      if (!isCtrl || ev.shiftKey || ev.altKey) return true;
      const { onZoomIn, onZoomOut, onZoomReset } = zoomHandlersRef.current;
      let handler = null;
      if (ev.key === '+' || ev.key === '=' || ev.code === 'Equal' || ev.code === 'NumpadAdd') handler = onZoomIn;
      else if (ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract') handler = onZoomOut;
      else if (ev.key === '0' || ev.code === 'Digit0' || ev.code === 'Numpad0') handler = onZoomReset;
      if (!handler) return true;
      ev.preventDefault();
      handler();
      return false;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    terminalRef.current.innerHTML = '';
    term.open(terminalRef.current);
    try { fitAddon.fit(); } catch (e) { /* ignore */ }

    terminalInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track whether the user has scrolled away from the live output, so the UI
    // can offer a way back to the prompt. `onWriteParsed` covers the case where
    // new output arrives while the viewport is parked in the scrollback.
    const syncScrollState = () => {
      const buffer = term.buffer.active;
      const scrolledUp = buffer.viewportY < buffer.baseY;
      if (scrolledUp === isScrolledUpRef.current) return;
      isScrolledUpRef.current = scrolledUp;
      setIsScrolledUp(scrolledUp);
    };
    term.onScroll(syncScrollState);
    term.onWriteParsed(syncScrollState);

    // Connect to SSE terminal stream. The backend replays the session
    // scrollback on connect, so a remount restores what was on screen.
    const url = `/api/terminal/stream?term_id=${termId}&projectPath=${encodeURIComponent(projectPath)}`;
    const evs = new EventSource(url);
    eventSourceRef.current = evs;

    evs.onmessage = (event) => {
      try {
        const raw = atob(event.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        term.write(bytes);
      } catch (err) {
        console.error('Error decoding terminal stream data', err);
      }
    };

    evs.onopen = () => onConnectionChangeRef.current?.('open');

    // The server says the program ended by itself (Claude Code after `/exit`):
    // stop here instead of retrying a stream that would only answer 410.
    evs.addEventListener('ended', () => {
      evs.close();
      onStreamClosedRef.current?.();
    });

    evs.onerror = () => {
      if (evs.readyState === EventSource.CLOSED) {
        onStreamClosedRef.current?.();
        return;
      }
      if (onConnectionChangeRef.current) {
        onConnectionChangeRef.current('reconnecting');
        return;
      }
      term.write(`\r\n\x1b[31m[GilzaCode] ${tRef.current('bottomPanel.terminalConnectionLost', 'Terminal connection lost. Reconnecting...')}\x1b[0m\r\n`);
    };

    // Forward keystrokes to the backend.
    term.onData((data) => {
      fetch('/api/terminal/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term_id: termId, action: 'input', text: data, projectPath }),
      }).catch(err => console.error('Failed to send terminal input', err));
    });

    let resizeTimeout;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) return;
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        if (fitAddon && !isCollapsedRef.current && isActive && terminalRef.current) {
          syncTerminalSize();
        }
      }, 100); // 100ms debounce
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      if (evs) evs.close();
      term.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [projectPath, termId, syncTerminalSize, connectionKey]);

  // Re-fit the terminal when the terminal tab becomes visible, the panel is expanded, or resized.
  useEffect(() => {
    if (activeBottomTab === 'terminal' && !isTerminalCollapsed && terminalInstanceRef.current && fitAddonRef.current && projectPath && isActive) {
      setTimeout(() => {
        try {
          if (terminalRef.current && (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0)) return;
          syncTerminalSize();

          terminalInstanceRef.current.focus();

          // On the first time the terminal becomes visible, the shell may not have
          // redrawn its prompt after the initial resize (the tab was hidden during
          // creation so xterm.js had no valid dimensions). Sending Enter (\r) forces
          // the shell (especially PowerShell on Windows) to print a fresh, clean prompt.
          if (redrawPromptOnShow && !promptDrawnRef.current) {
            promptDrawnRef.current = true;
            fetch('/api/terminal/input', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ term_id: termId, action: 'input', text: '\r', projectPath }),
            }).catch(err => console.error('Failed to send prompt redraw', err));
          }
        } catch (e) { /* ignore */ }
      }, 50);
    }
  }, [activeBottomTab, bottomPanelHeight, projectPath, isTerminalCollapsed, isActive, syncTerminalSize]);

  const scrollToBottom = useCallback(() => {
    const term = terminalInstanceRef.current;
    if (!term) return;
    term.scrollToBottom();
    term.focus();
    isScrolledUpRef.current = false;
    setIsScrolledUp(false);
  }, [terminalInstanceRef]);

  return { isScrolledUp, scrollToBottom };
}
