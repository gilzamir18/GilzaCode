// Mode-aware word/character counting for the editor status bar.
//
// A raw `content.length` is useless for a LaTeX or Markdown author: it counts
// markup (commands, math, fences, table pipes) that never reaches the rendered
// document. Each supported mode therefore first extracts the prose the reader
// will actually see, and only then counts words and characters over it.
//
// Supported modes: 'latex', 'markdown', 'text' (plus 'auto' at the UI level,
// which resolves to one of the three from the file extension).

export const COUNT_MODE_AUTO = 'auto';
export const COUNT_MODE_LATEX = 'latex';
export const COUNT_MODE_MARKDOWN = 'markdown';
export const COUNT_MODE_TEXT = 'text';

// Order used when the user cycles the mode from the status bar.
export const COUNT_MODE_CYCLE = [
  COUNT_MODE_AUTO,
  COUNT_MODE_LATEX,
  COUNT_MODE_MARKDOWN,
  COUNT_MODE_TEXT,
];

const LATEX_EXTENSIONS = new Set(['tex', 'ltx', 'latex', 'cls', 'sty', 'bib', 'bbl']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx', 'rmd']);

/** Resolves the counting mode implied by a file name. */
export const detectCountMode = (filename) => {
  if (!filename) return COUNT_MODE_TEXT;
  const normalized = String(filename).replace(/\\/g, '/');
  const base = normalized.split('/').pop();
  if (!base.includes('.')) return COUNT_MODE_TEXT;
  const ext = base.split('.').pop().toLowerCase();
  if (LATEX_EXTENSIONS.has(ext)) return COUNT_MODE_LATEX;
  if (MARKDOWN_EXTENSIONS.has(ext)) return COUNT_MODE_MARKDOWN;
  return COUNT_MODE_TEXT;
};

/** Applies a user override ('auto' means "detect from the file name"). */
export const resolveCountMode = (filename, override) => {
  if (override && override !== COUNT_MODE_AUTO) {
    return COUNT_MODE_CYCLE.includes(override) ? override : COUNT_MODE_TEXT;
  }
  return detectCountMode(filename);
};

/** Next mode in the status-bar cycle. */
export const nextCountMode = (mode) => {
  const index = COUNT_MODE_CYCLE.indexOf(mode || COUNT_MODE_AUTO);
  return COUNT_MODE_CYCLE[(index + 1) % COUNT_MODE_CYCLE.length];
};

// ── LaTeX ──────────────────────────────────────────────────────────────────

// Escaped specials are literal characters in the output, not markup, so they
// are parked as placeholders before the markup passes run and restored after.
const LATEX_ESCAPES = ['%', '$', '&', '#', '_', '{', '}'];
const PLACEHOLDER_BASE = 0xe000; // Unicode private use area — never in source.

// Environments whose body is not prose (math, code, drawings).
const LATEX_NON_PROSE_ENVIRONMENTS = [
  'equation', 'displaymath', 'math', 'align', 'alignat', 'flalign', 'gather',
  'multline', 'eqnarray', 'split', 'array', 'cases', 'matrix', 'pmatrix',
  'bmatrix', 'vmatrix', 'Bmatrix', 'Vmatrix', 'verbatim', 'Verbatim',
  'lstlisting', 'minted', 'alltt', 'tikzpicture', 'pgfpicture', 'pspicture',
  'picture', 'filecontents', 'comment', 'thebibliography',
];

// Commands whose arguments carry no prose at all.
const LATEX_NON_PROSE_COMMANDS = [
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref',
  'cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'nocite', 'bibitem',
  'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography',
  'usepackage', 'documentclass', 'RequirePackage', 'input', 'include',
  'includeonly', 'includegraphics', 'graphicspath', 'newcommand',
  'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment',
  'DeclareMathOperator', 'newtheorem', 'setlength', 'addtolength', 'setcounter',
  'addtocounter', 'usetikzlibrary', 'lstset', 'definecolor', 'geometry',
  'hypersetup', 'pagestyle', 'thispagestyle', 'url', 'index', 'vspace',
  'hspace', 'rule', 'bibliographyfont',
];

// Commands whose first argument is not prose but whose second one is
// (\href{url}{label}, \textcolor{red}{label}).
const LATEX_DROP_FIRST_ARG_COMMANDS = ['href', 'textcolor', 'colorbox', 'fcolorbox'];

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest first, so \citeauthor is not matched as \cite + "author".
const byLengthDesc = (names) => [...names].sort((a, b) => b.length - a.length);

const commandAlternation = (names) => byLengthDesc(names).map(escapeForRegex).join('|');

const LATEX_NON_PROSE_COMMAND_RE = new RegExp(
  `\\\\(?:${commandAlternation(LATEX_NON_PROSE_COMMANDS)})\\*?(?![a-zA-Z])\\s*(?:\\[[^\\]]*\\]\\s*)*(?:\\{[^{}]*\\}\\s*)*`,
  'g',
);

const LATEX_DROP_FIRST_ARG_RE = new RegExp(
  `\\\\(?:${commandAlternation(LATEX_DROP_FIRST_ARG_COMMANDS)})\\*?(?![a-zA-Z])\\s*(?:\\[[^\\]]*\\]\\s*)*\\{[^{}]*\\}`,
  'g',
);

// One pass with a backreference rather than one regex per environment: an
// unbalanced `\begin` makes the lazy body scan the rest of the file, so 30-odd
// separate passes multiply that cost by 30 for no gain.
const LATEX_NON_PROSE_ENVIRONMENT_RE = new RegExp(
  `\\\\begin\\s*\\{(${commandAlternation(LATEX_NON_PROSE_ENVIRONMENTS)})\\*?\\}`
  + `[\\s\\S]*?\\\\end\\s*\\{\\1\\*?\\}`,
  'g',
);

const extractLatexText = (source) => {
  let text = source;

  // 1. Park escaped specials so no later pass reads them as markup.
  text = text.replace(/\\([%$&#_{}])/g, (_match, char) =>
    String.fromCharCode(PLACEHOLDER_BASE + LATEX_ESCAPES.indexOf(char)));

  // 2. Comments.
  text = text.replace(/%[^\n]*/g, '');

  // 3. Only the document body is prose; the preamble is configuration.
  const bodyStart = text.indexOf('\\begin{document}');
  if (bodyStart !== -1) {
    text = text.slice(bodyStart + '\\begin{document}'.length);
    const bodyEnd = text.indexOf('\\end{document}');
    if (bodyEnd !== -1) text = text.slice(0, bodyEnd);
  }

  // 4. Math (display first — $$ before $, \[ before \().
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  text = text.replace(/\\\[[\s\S]*?\\\]/g, ' ');
  text = text.replace(/\\\([\s\S]*?\\\)/g, ' ');
  text = text.replace(/\$[^$]*\$/g, ' ');

  // 5. Non-prose environments, body included.
  text = text.replace(LATEX_NON_PROSE_ENVIRONMENT_RE, ' ');

  // 6. \begin/\end of the remaining (prose-bearing) environments.
  text = text.replace(/\\(?:begin|end)\s*\{[^{}]*\}(?:\s*\[[^\]]*\])*/g, ' ');

  // 7. Commands with no prose in them, then the drop-first-argument ones.
  text = text.replace(LATEX_NON_PROSE_COMMAND_RE, ' ');
  text = text.replace(LATEX_DROP_FIRST_ARG_RE, ' ');

  // 8. Any other command: the name (and its optional args) is markup, but the
  //    braced argument is the prose it formats — \textbf{word} is one word.
  text = text.replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])*/g, ' ');

  // 9. Leftover control symbols (\\, \,, \&-style spacing) and grouping.
  text = text.replace(/\\[^a-zA-Z]/g, ' ');
  text = text.replace(/[{}]/g, ' ');
  text = text.replace(/[&~]/g, ' ');

  // 10. Restore the escaped specials.
  return text.replace(/[\uE000-\uE006]/g, (char) =>
    LATEX_ESCAPES[char.charCodeAt(0) - PLACEHOLDER_BASE] ?? '');
};

// ── Markdown ───────────────────────────────────────────────────────────────

// Inline code spans, removed by scanning rather than by a backreference
// regex: `` /(`+)[\s\S]*?\1/ `` is quadratic on a long run of backticks (a
// pasted separator line is enough to freeze the editor for seconds), while the
// scan is linear because each opening run is consumed exactly once.
const stripInlineCode = (source) => {
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '`') {
      out += source[index];
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < source.length && source[index] === '`') index += 1;
    const runLength = index - runStart;

    // A span closes on a backtick run of exactly the same length.
    let cursor = index;
    let closed = false;
    while (cursor < source.length) {
      if (source[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      const closeStart = cursor;
      while (cursor < source.length && source[cursor] === '`') cursor += 1;
      if (cursor - closeStart === runLength) {
        closed = true;
        break;
      }
    }
    out += ' ';
    if (closed) index = cursor; // drop the span, delimiters included
  }
  return out;
};

const extractMarkdownText = (source) => {
  let text = source.replace(/\r\n?/g, '\n');

  // Fenced code blocks, closed or left open at end of file. The `(?!`)`
  // lookaheads stop the opening run from backtracking one backtick at a time
  // across the whole file when the fence turns out not to match.
  text = text.replace(/^[ \t]*(`{3,}(?!`)|~{3,}(?!~))[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, ' ');
  text = text.replace(/^[ \t]*(?:`{3,}(?!`)|~{3,}(?!~))[^\n]*\n[\s\S]*$/m, ' ');

  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Math (remark-math syntax) and inline code.
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  text = text.replace(/\$[^$\n]*\$/g, ' ');
  text = stripInlineCode(text);

  // Bracket and angle-bracket constructs are matched with bounded character
  // classes (`{0,N}` instead of `*`). An unbounded `[^\]]*` rescans the rest
  // of the file from every `[` that never closes, which is quadratic — a line
  // of unmatched brackets froze the counter for seconds. The bounds are far
  // above any real link label, alt text or tag, and the only cost of exceeding
  // one is that the construct is counted as prose instead of being stripped.

  // Footnote references and definitions.
  text = text.replace(/^[ \t]*\[\^[^\]\n]{1,200}\]:[^\n]*$/gm, ' ');
  text = text.replace(/\[\^[^\]\n]{0,200}\]/g, ' ');

  // Images contribute no prose; links keep their label.
  text = text.replace(/!\[[^\]\n]{0,500}\]\((?:[^()\n]|\([^()\n]{0,500}\)){0,2000}\)/g, ' ');
  text = text.replace(/!\[[^\]\n]{0,500}\]\[[^\]\n]{0,500}\]/g, ' ');
  text = text.replace(/\[([^\]\n]{0,500})\]\((?:[^()\n]|\([^()\n]{0,500}\)){0,2000}\)/g, '$1');
  text = text.replace(/\[([^\]\n]{0,500})\]\[[^\]\n]{0,500}\]/g, '$1');
  text = text.replace(/^[ \t]*\[[^\]\n]{1,500}\]:[^\n]*$/gm, ' ');

  // Raw HTML and autolinks.
  text = text.replace(/<\/?[a-zA-Z][^>\n]{0,2000}>/g, ' ');
  text = text.replace(/<[^\s>]{1,200}@[^\s>]{1,200}>/g, ' ');
  text = text.replace(/<[a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/[^\s>]{0,2000}>/g, ' ');

  // Thematic breaks and table separator rows.
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ');
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?[ \t]*$/gm, ' ');

  // Block markers: headings, blockquotes, list bullets, task checkboxes.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*#{1,6}[ \t]*$/gm, ' ');
  text = text.replace(/^[ \t]*>+[ \t]?/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
  text = text.replace(/^[ \t]*(?:=+|-+)[ \t]*$/gm, ' '); // setext underlines

  text = text.replace(/\|/g, ' ');

  // Emphasis markers. Underscores only count at word boundaries, so
  // snake_case identifiers keep their characters.
  text = text.replace(/\*\*|~~|\*/g, '');
  text = text.replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');

  return text;
};

// ── Counting ───────────────────────────────────────────────────────────────

// Each CJK ideograph/kana is a word on its own — they are not space separated.
const CJK_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/gu;
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Counts words in already-extracted prose. */
export const countWords = (text) => {
  if (!text) return 0;
  let words = 0;
  for (const token of text.split(/\s+/)) {
    if (!token || !HAS_ALPHANUMERIC.test(token)) continue; // skip bare punctuation
    const cjk = token.match(CJK_CHARS);
    if (!cjk) {
      words += 1;
      continue;
    }
    words += cjk.length;
    words += token
      .replace(CJK_CHARS, ' ')
      .split(/\s+/)
      .filter((part) => part && HAS_ALPHANUMERIC.test(part)).length;
  }
  return words;
};

/**
 * Extracts the prose a reader would see, for the given counting mode.
 * Whitespace is normalized so markup removal never inflates the character
 * count with the blanks it left behind.
 */
export const extractCountableText = (source, mode = COUNT_MODE_TEXT) => {
  const raw = typeof source === 'string' ? source : '';
  if (!raw) return '';
  let text;
  if (mode === COUNT_MODE_LATEX) text = extractLatexText(raw);
  else if (mode === COUNT_MODE_MARKDOWN) text = extractMarkdownText(raw);
  else text = raw;
  return text.replace(/\s+/g, ' ').trim();
};

/**
 * Word/character statistics for a document (or a selection inside it).
 *
 * `characters` counts the prose; `rawCharacters` counts the file as stored,
 * markup included. For plain text the two only differ by collapsed whitespace.
 */
export const countTextStats = (source, mode = COUNT_MODE_TEXT) => {
  const raw = typeof source === 'string' ? source : '';
  const text = extractCountableText(raw, mode);
  return {
    mode,
    words: countWords(text),
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/g, '').length,
    rawCharacters: raw.length,
    lines: raw.length === 0 ? 0 : raw.split(/\r\n|\r|\n/).length,
  };
};
