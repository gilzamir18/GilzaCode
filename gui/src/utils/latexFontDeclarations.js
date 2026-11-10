// ─────────────────────────────────────────────────────────────────────────────
// latexFontDeclarations.js
//
// LaTeX font *declarations* — `\Huge`, `\bfseries`, `\footnotesize`, `\itshape`
// — and how to render their effect.
//
// These differ from the commands both editors already handle. `\textbf{x}`
// takes an argument and its scope is that argument. A declaration takes none
// and applies from where it appears to the end of the enclosing group, which
// is why the two shapes below are the ones that occur in real documents:
//
//     {\Huge\bfseries Bem-vindos}      a group scoping the declaration
//     \footnotesize Próxima aula...    bare, running to the end of the scope
//
// Without this, both spellings leak into the rendered text as literal markup —
// the reader sees `{\Huge\bfseries Bem-vindos}` instead of large bold text.
//
// This module is the single vocabulary both editors share, so a declaration
// never renders one way in Rich Text mode and another in WYSIWYG.
// ─────────────────────────────────────────────────────────────────────────────

// Size declarations, as multiples of the surrounding text size. These follow
// the ratios of the standard 10pt classes closely enough to convey the
// intent; they are not a claim to reproduce LaTeX's exact metrics.
//
// Note that the sizes are emitted as `em`, so a size nested inside another
// compounds, whereas in LaTeX every size is absolute relative to
// `\normalsize`. Nesting two size declarations is rare enough that the
// simpler relative form is worth its inaccuracy.
const SIZE_SCALE = {
  tiny: 0.5,
  scriptsize: 0.7,
  footnotesize: 0.8,
  small: 0.9,
  normalsize: 1,
  large: 1.2,
  Large: 1.44,
  LARGE: 1.73,
  huge: 2.07,
  Huge: 2.49,
};

// Series, shape and family declarations, including the short forms that
// predate LaTeX 2e but are still common in slide decks.
const FONT_STYLES = {
  bfseries: { fontWeight: 700 },
  bf: { fontWeight: 700 },
  mdseries: { fontWeight: 400 },
  itshape: { fontStyle: 'italic' },
  it: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  slshape: { fontStyle: 'oblique' },
  upshape: { fontStyle: 'normal' },
  scshape: { fontVariant: 'small-caps' },
  sc: { fontVariant: 'small-caps' },
  ttfamily: { fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  tt: { fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  sffamily: { fontFamily: 'sans-serif' },
  sf: { fontFamily: 'sans-serif' },
  rmfamily: { fontFamily: 'serif' },
  rm: { fontFamily: 'serif' },
  normalfont: { fontWeight: 400, fontStyle: 'normal', fontVariant: 'normal' },
};

export const DECLARATION_NAMES = new Set([
  ...Object.keys(SIZE_SCALE),
  ...Object.keys(FONT_STYLES),
]);

/**
 * Matches a run of consecutive declarations starting at `index`, together with
 * the whitespace that terminates the last one.
 *
 * The whitespace belongs to the run because TeX consumes it as the control
 * word's terminator — `\bfseries Bem` renders as "Bem", not " Bem". Capturing
 * it here means the prefix can be written back verbatim, which is what keeps
 * the round-trip exact.
 *
 * @param {string} text
 * @param {number} index - position of the leading backslash
 * @returns {?{prefix: string, end: number, names: string[]}}
 */
export function matchDeclarationRun(text, index) {
  const names = [];
  let i = index;
  for (;;) {
    if (text[i] !== '\\') break;
    const match = /^[a-zA-Z]+/.exec(text.slice(i + 1));
    if (!match || !DECLARATION_NAMES.has(match[0])) break;
    names.push(match[0]);
    i += 1 + match[0].length;
    // Whitespace after a control word terminates it. Stop consuming at the
    // first non-space so a run followed by more declarations still chains.
    const spaces = /^[ \t]*/.exec(text.slice(i))[0];
    if (spaces && !/^\\[a-zA-Z]/.test(text.slice(i + spaces.length))) {
      i += spaces.length;
      break;
    }
    i += spaces.length;
  }
  if (!names.length) return null;
  return { prefix: text.slice(index, i), end: i, names };
}

/**
 * The combined CSS effect of a declaration prefix such as `\Huge\bfseries `.
 * Declarations are applied in order, so a later one overrides an earlier one
 * exactly as it would in LaTeX.
 *
 * @param {string} prefix
 * @returns {object} a React style object
 */
export function declarationStyle(prefix) {
  const style = {};
  for (const match of (prefix || '').matchAll(/\\([a-zA-Z]+)/g)) {
    const name = match[1];
    if (name in SIZE_SCALE) {
      style.fontSize = `${SIZE_SCALE[name]}em`;
      continue;
    }
    if (name === 'normalfont') {
      // A reset has to clear the family too, which the table cannot express
      // as a value without knowing what to fall back to.
      Object.assign(style, FONT_STYLES[name], { fontFamily: 'inherit' });
      continue;
    }
    if (name in FONT_STYLES) Object.assign(style, FONT_STYLES[name]);
  }
  return style;
}

/**
 * Finds the first declaration in `text`, in either of its two shapes.
 *
 * @param {string} text
 * @returns {?{form: 'group'|'bare', start: number, prefix: string,
 *             contentStart: number, contentEnd: number, end: number}}
 *   For `group`, the span covers `{...}` and the content is what the braces
 *   enclose. For `bare`, the declaration runs to the end of `text`, which is
 *   the scope the caller is rendering.
 */
export function findFirstDeclaration(text) {
  const value = text || '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === '\\') {
      const run = matchDeclarationRun(value, i);
      if (run) {
        return {
          form: 'bare',
          start: i,
          prefix: run.prefix,
          contentStart: run.end,
          contentEnd: value.length,
          end: value.length,
        };
      }
      // Skip the whole command so a declaration name appearing inside another
      // command's argument is not mistaken for a declaration of its own.
      const command = /^\\([a-zA-Z]+|.)/.exec(value.slice(i));
      i += (command ? command[0].length : 1) - 1;
      continue;
    }

    if (char === '{') {
      const close = findMatchingBrace(value, i);
      if (close === -1) continue;
      const run = matchDeclarationRun(value, i + 1);
      if (run && run.end <= close) {
        return {
          form: 'group',
          start: i,
          prefix: run.prefix,
          contentStart: run.end,
          contentEnd: close,
          end: close + 1,
        };
      }
    }
  }
  return null;
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
