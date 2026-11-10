// ─────────────────────────────────────────────────────────────────────────────
// latexInlineCommands.js
//
// Inline commands that take a textual argument, and what should become of them
// when the source is rendered rather than compiled.
//
// Two things live here, both shared so the two editors cannot disagree:
//
//  1. **Brace-aware argument scanning.** A regex of the shape `\{([^}]*)\}`
//     cannot find the end of an argument that contains braces of its own, and
//     stops at the first `}` instead. On
//
//         \footnote{o termo \textit{modelo} refere-se a ...}
//
//     that leaves a stray `\textit{` in the middle of the rendered text and an
//     orphaned `}` at the end — corrupted output, not merely unrendered
//     markup. Every helper here matches braces by counting them.
//
//  2. **Notes are not body text.** `\footnote{...}` compiles to a marker in
//     the text and a note at the foot of the page. Reducing it to its argument
//     the way `\alert{x}` reduces to `x` would splice the note into the middle
//     of the sentence, reading as if the author had written it there.
// ─────────────────────────────────────────────────────────────────────────────

import { stripTransparentGroups } from './latexBraceGroups.js';

// Commands whose argument is a note rather than part of the sentence. These
// are rendered as a marker; their content is shown separately.
export const NOTE_COMMANDS = new Set(['footnote', 'footnotetext', 'thanks', 'marginpar']);

/**
 * Finds the first `\command` in `text` that takes a brace argument, matching
 * braces by counting so a nested group cannot end the argument early.
 *
 * @param {string} text
 * @param {number} [from=0] - index to start scanning at
 * @param {?(name: string) => boolean} [accept] - optional filter on the
 *   command name; scanning continues past commands it rejects.
 * @returns {?{name: string, start: number, argStart: number, argEnd: number,
 *             end: number, options: string}}
 *   `argStart`/`argEnd` bound the argument exclusive of its braces; `options`
 *   is the `[...]` group between the name and the argument, if any.
 */
export function findCommandWithArgument(text, from = 0, accept = null) {
  const value = text || '';
  for (let i = from; i < value.length; i++) {
    if (value[i] !== '\\') continue;

    const nameMatch = /^[a-zA-Z]+\*?/.exec(value.slice(i + 1));
    if (!nameMatch) {
      // An escaped character (`\%`, `\{`) — skip both so its second character
      // is never read as the start of something else.
      i += 1;
      continue;
    }

    const name = nameMatch[0];
    let cursor = i + 1 + name.length;

    let options = '';
    if (value[cursor] === '[') {
      const close = findMatchingBracket(value, cursor);
      if (close !== -1) {
        options = value.slice(cursor, close + 1);
        cursor = close + 1;
      }
    }

    if (value[cursor] !== '{') {
      i = cursor - 1;
      continue;
    }
    const close = findMatchingBrace(value, cursor);
    if (close === -1) {
      i = cursor - 1;
      continue;
    }

    if (accept && !accept(name)) {
      // Skip the whole command, argument included, so a command nested inside
      // a rejected one is not returned as if it were at the top level.
      i = close;
      continue;
    }

    return {
      name,
      start: i,
      options,
      argStart: cursor + 1,
      argEnd: close,
      end: close + 1,
    };
  }
  return null;
}

/**
 * Replaces every `\command{argument}` with its argument, recursively, so
 * nested markup is reduced too. Note commands are left in place: their
 * argument is not part of the sentence, and the caller renders them.
 *
 * @param {string} text
 * @returns {string}
 */
export function reduceCommandsToArguments(text) {
  let value = text || '';
  let cursor = 0;
  for (;;) {
    const found = findCommandWithArgument(value, cursor, (name) => !NOTE_COMMANDS.has(name));
    if (!found) return value;
    value = value.slice(0, found.start) + value.slice(found.argStart, found.argEnd) + value.slice(found.end);
    // Resume at the start of the substituted argument so commands nested
    // inside it are reduced as well.
    cursor = found.start;
  }
}

/**
 * The readable text of an inline LaTeX run: commands reduced to their
 * arguments, grouping braces removed, escapes resolved. Used for a footnote's
 * tooltip, where markup would be noise.
 *
 * @param {string} text
 * @returns {string}
 */
export function latexToPlainText(text) {
  return stripTransparentGroups(reduceCommandsToArguments(text || ''))
    .replace(/``([\s\S]*?)''/g, '"$1"')
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\([{}])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findMatchingBrace(text, openPos) {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (char === '{') depth++;
    else if (char === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findMatchingBracket(text, openPos) {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') depth++;
    else if (char === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
