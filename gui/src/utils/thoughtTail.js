// The chat shows the most recent agent reasoning up to a size in tokens
// (editor settings -> thought_context_tokens). Nothing is dropped from storage;
// this only decides what is on screen.
//
// Each chunk carries `tokens`: the backend's running token count of the turn's
// reasoning, including that chunk. Chunks without it (older activity) fall back
// to an estimate of four characters per token.

export const DEFAULT_THOUGHT_CONTEXT_TOKENS = 32000;

const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

// A tail is a window `[first, count)` over `items`, an array the states built
// from one another share. Appending pushes onto that array instead of copying
// the window: while streaming, a window of tens of thousands of chunks was
// copied once per token, so a long reasoning phase cost seconds of main-thread
// time (30,000 chunks measured ~28 s). A state is never changed after it is
// returned: appending to a state that is no longer the newest one copies its
// window first, so every state keeps describing the same chunks.
const makeTail = (items, first, count, startTokens, lastTokens) => ({
  items, first, count, startTokens, lastTokens, omittedTokens: startTokens,
});

export const createThoughtTail = () => makeTail([], 0, 0, 0, 0);

// Once the dropped prefix outweighs the window, the window is copied to a new
// array, so the shared array stays within twice the window and the copy costs
// amortized O(1) per append.
const COMPACT_MIN_DROPPED = 1024;

// Append a chunk and keep only the most recent chunks within `limit` tokens.
export const appendThoughtChunk = (state, content, tokens, limit) => {
  const text = String(content || '');
  if (!text) return state;
  const end = Number.isFinite(tokens) && tokens > state.lastTokens
    ? tokens
    : state.lastTokens + estimateTokens(text);
  let { items, first, count } = state;
  if (count !== items.length) {
    items = items.slice(first, count);
    count -= first;
    first = 0;
  }
  items.push({ text, end });
  count += 1;
  // A chunk starts where the previous one ended; the first kept chunk starts at
  // the tokens already omitted.
  const startOf = (index) => (index === first ? state.startTokens : items[index - 1].end);
  let next = first;
  while (next < count - 1 && end - startOf(next) > limit) next += 1;
  const omittedTokens = startOf(next);
  if (next >= COMPACT_MIN_DROPPED && next * 2 >= count) {
    items = items.slice(next, count);
    count -= next;
    next = 0;
  }
  return makeTail(items, next, count, omittedTokens, end);
};

export const thoughtTailText = (state) => {
  let text = '';
  for (let index = state.first; index < state.count; index += 1) text += state.items[index].text;
  return text;
};

// Build the visible tail of a finished list of chunks ({ content, tokens }).
//
// Measured in one pass, cut once at the end, rather than by replaying
// `appendThoughtChunk`: that rebuilt the kept window for every chunk, which is
// quadratic in the number of chunks and is what made reopening a long chat take
// tens of seconds. Reasoning arrives roughly one token per chunk, so a chat with
// a hundred thousand chunks keeps a window of tens of thousands of them, and
// copying that window per chunk dominated everything else on the load path.
//
// The result is identical. `end` strictly increases, so the smallest index
// satisfying `end - startOf(index) <= limit` only ever moves forward: dropping
// chunks as they go and cutting once at the end settle on the same index.
export const tailThoughtChunks = (items, limit) => {
  const chunks = [];
  let lastTokens = 0;
  for (const item of items || []) {
    const text = String(item?.content || '');
    if (!text) continue;
    const tokens = Number(item?.tokens);
    const end = Number.isFinite(tokens) && tokens > lastTokens
      ? tokens
      : lastTokens + estimateTokens(text);
    chunks.push({ text, end });
    lastTokens = end;
  }
  if (!chunks.length) return createThoughtTail();
  // A chunk starts where the previous one ended; the first one starts at zero,
  // since nothing has been omitted before the list begins.
  const startOf = (index) => (index === 0 ? 0 : chunks[index - 1].end);
  let first = 0;
  while (first < chunks.length - 1 && lastTokens - startOf(first) > limit) first += 1;
  const omittedTokens = startOf(first);
  return makeTail(chunks, first, chunks.length, omittedTokens, lastTokens);
};

// Estimate-only tail for plain text (the Output panel merges text without counts).
export const tailTextByTokens = (text, limit) => {
  const value = String(text || '');
  const maxChars = Math.max(1, limit) * 4;
  if (value.length <= maxChars) return { text: value, omittedTokens: 0 };
  return { text: value.slice(value.length - maxChars), omittedTokens: estimateTokens(value.slice(0, value.length - maxChars)) };
};

export const clampThoughtContextTokens = (value) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_THOUGHT_CONTEXT_TOKENS;
  return Math.max(1000, Math.min(1000000, n));
};
