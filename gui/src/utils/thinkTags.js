/**
 * Helpers for reasoning a model wrote inside the visible content channel.
 *
 * Reasoning normally arrives wrapped in `<think>` … `</think>`. Some chat
 * templates seed the opening tag at the end of the prompt, so the model only
 * ever generates the closing one and the reasoning reaches us as ordinary text
 * terminated by an orphan `</think>`. The backend classifies this before the
 * message is stored (see `gilzabots/think_stream.py`); these helpers keep the UI
 * correct for history saved before that fix and for any residue.
 */

// Everything up to the first `</think>`, but only when no `<think>` opened before
// it — a closing tag that follows an opening one belongs to a balanced block.
const ORPHAN_REASONING_PREFIX = /^((?:(?!<think>)[\s\S])*?)<\/think>/i;

/** Return the reasoning prefix closed by an orphan `</think>`, or `''`. */
export const orphanReasoningPrefix = (content = '') => {
  const match = String(content ?? '').match(ORPHAN_REASONING_PREFIX);
  return match ? match[1].trim() : '';
};

/** Drop a reasoning prefix closed by an orphan `</think>`. */
export const stripOrphanReasoningPrefix = (content = '') => (
  String(content ?? '').replace(ORPHAN_REASONING_PREFIX, '')
);

/** Drop every kind of inline reasoning: orphan prefix and `<think>` blocks. */
export const stripInlineReasoning = (content = '') => (
  stripOrphanReasoningPrefix(content)
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
);

/**
 * Wrap reasoning in a markdown ```thought block.
 *
 * Reasoning is arbitrary prose and routinely contains fenced code of its own. A
 * fixed ``` wrapper would be closed by the first fence inside it, spilling the
 * rest of the reasoning into the message and swallowing the answer that follows
 * into a broken block — so the wrapper is always longer than the longest run of
 * backticks it has to contain.
 */
export const thoughtBlock = (inner = '') => {
  const text = String(inner ?? '').trim();
  const longestRun = (text.match(/`+/g) || [])
    .reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `\n${fence}thought\n${text}\n${fence}\n`;
};
