// How the Output and Agent Thinking panels fold a stream of events into
// readable entries.
//
// Reasoning and streamed text arrive one chunk per token, so consecutive
// entries of the same type and agent are merged into one. What is *kept* when a
// merged entry grows past its size differs by type, and that difference is the
// whole point of this module: ordinary logs keep their beginning, because a
// command's first lines say what it did; reasoning keeps its end, because the
// panel is where the user watches the model think and the end is where it
// currently is. Keeping the beginning of reasoning froze the Agent Thinking
// panel mid-turn — past the cap every new chunk was appended and cut away
// again, so the panel sat on the opening lines while the chat preview moved
// with the stream.

import { tailTextByTokens } from './thoughtTail.js';

export const MAX_MERGED_LOG_CHARS = 16000;

export const clampLogMessage = (value) => {
  const text = String(value ?? '');
  if (text.length <= MAX_MERGED_LOG_CHARS) return text;
  return `${text.slice(0, MAX_MERGED_LOG_CHARS)}\n[log truncated]`;
};

export const joinMergedLogMessage = (leftMessage, rightMessage, type) => {
  const left = String(leftMessage ?? '');
  const right = String(rightMessage ?? '');
  if (!left || !right) return left + right;
  // Reasoning is a token stream: the pieces are already written to be
  // concatenated. A reflection is whole sentences, one per event.
  if (type === 'reflection') {
    return `${left.replace(/\s+$/g, '')}\n${right.replace(/^\s+/g, '')}`;
  }
  return left + right;
};

// `thoughtTokens` is the configured reasoning size (editor settings).
export const fitLogMessage = (message, type, thoughtTokens) => (
  type === 'thought'
    ? tailTextByTokens(message, thoughtTokens).text
    : clampLogMessage(message)
);
