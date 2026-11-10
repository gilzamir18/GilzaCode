// ─────────────────────────────────────────────────────────────────────────────
// latexBraceGroups.js
//
// Free-standing brace groups in inline LaTeX — `1{,}5`, `sha{f}{f}le`.
//
// A group that contains no control sequences does nothing to its content
// except group it. `1{,}5` is the standard way to write a decimal comma (the
// braces make it an ordinary symbol rather than punctuation, which would take
// extra spacing in math mode), and it should read as `1,5`, not as `1{,}5`.
//
// What the braces do NOT do is nothing at all, which is why they are rendered
// away but never *written* away: `{f}{f}` is how you break an "ff" ligature,
// so dropping the braces on save would change the compiled output. Both
// editors therefore show the content and keep the source.
//
// Shared by both editors so a group cannot render one way in Rich Text mode
// and another in WYSIWYG.
// ─────────────────────────────────────────────────────────────────────────────

// A group is transparent when its content holds neither a control sequence nor
// a comment — nothing, in other words, that could have an effect of its own.
// Groups containing commands are left alone: what they mean depends on the
// command, and guessing is how markup ends up silently altered.
const OPAQUE_CONTENT = /[\\%]/;

/**
 * Whether the content of a brace group only groups.
 * @param {string} content - the text between the braces, exclusive
 * @returns {boolean}
 */
export function isTransparentGroup(content) {
  return !OPAQUE_CONTENT.test(content || '');
}

// The content class excludes braces, so this only ever matches an innermost
// group; nesting is handled by repeating the pass.
//
// The lookbehind is what keeps a command's argument out of reach: `\ref{x}` is
// not a free-standing group, and unwrapping it would leave the command name
// stranded in front of its own argument. Relying on this rule running after
// the command substitutions would work too, but only for as long as nobody
// reorders them.
const TRANSPARENT_GROUP = /(?<!\\[a-zA-Z]{1,32})\{([^{}\\%]*)\}/g;

/**
 * Removes the braces of every free-standing transparent group in `text`,
 * leaving opaque ones and command arguments untouched. For display only — the
 * source keeps its braces, since they can carry meaning the rendering does not
 * show (breaking a ligature, or an atom's spacing class in math).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTransparentGroups(text) {
  let value = text || '';
  // Nested groups need one pass per level. The loop terminates because every
  // pass that changes anything removes a pair of braces.
  for (;;) {
    const next = value.replace(TRANSPARENT_GROUP, '$1');
    if (next === value) return value;
    value = next;
  }
}
