// Ctrl+V (and Ctrl+Shift+V) in a terminal panel pastes the clipboard's text,
// as Windows Terminal does. Left to itself, xterm.js turns Ctrl+V into the
// control character ^V and cancels the key, so the browser never fires the
// paste event that carries the text, and nothing reaches the prompt. A key this
// returns true for is handed back to the browser, whose paste event xterm then
// delivers to the program (bracketed when the program asked for it).
export function isTerminalPasteKey(ev) {
  if (ev.type !== 'keydown') return false;
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return false;
  return ev.code === 'KeyV' || ev.key === 'v' || ev.key === 'V';
}
