import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendThoughtChunk,
  clampThoughtContextTokens,
  createThoughtTail,
  DEFAULT_THOUGHT_CONTEXT_TOKENS,
  tailTextByTokens,
  tailThoughtChunks,
  thoughtTailText,
} from '../thoughtTail.js';

test('the tail keeps every chunk while the reasoning fits the limit', () => {
  const state = tailThoughtChunks([
    { content: 'a', tokens: 10 },
    { content: 'b', tokens: 20 },
  ], 100);
  assert.equal(thoughtTailText(state), 'ab');
  assert.equal(state.omittedTokens, 0);
});

test('the oldest chunks leave the screen once the reasoning exceeds the limit', () => {
  const state = tailThoughtChunks([
    { content: 'first ', tokens: 50 },
    { content: 'second ', tokens: 100 },
    { content: 'third', tokens: 150 },
  ], 110);
  // 'second third' spans tokens 50..150 (100 tokens), which fits 110.
  assert.equal(thoughtTailText(state), 'second third');
  assert.equal(state.omittedTokens, 50);
});

test('what is shown never exceeds the limit, measured from where it starts', () => {
  const state = tailThoughtChunks([
    { content: 'first ', tokens: 50 },
    { content: 'second ', tokens: 100 },
    { content: 'third', tokens: 150 },
  ], 60);
  // 'second third' would span 100 tokens, over 60: only 'third' fits.
  assert.equal(thoughtTailText(state), 'third');
  assert.equal(state.omittedTokens, 100);
});

test('appending one chunk at a time gives the same tail as building it at once', () => {
  const items = [30, 60, 90, 120, 150].map((tokens, i) => ({ content: `c${i} `, tokens }));
  let state = createThoughtTail();
  for (const item of items) state = appendThoughtChunk(state, item.content, item.tokens, 70);
  assert.equal(thoughtTailText(state), thoughtTailText(tailThoughtChunks(items, 70)));
  assert.equal(thoughtTailText(state), 'c3 c4 ');
});

// Reasoning is streamed at roughly one token per chunk, so a long chat holds
// over a hundred thousand of them and the visible tail keeps tens of thousands.
// Rebuilding that window once per chunk made reopening such a chat take tens of
// seconds, and the two tests below are what a return to it would trip on: the
// same tail, built within a budget no linear pass can miss and no quadratic one
// can meet.
const streamedChunks = (count) => Array.from({ length: count }, (_, i) => ({ content: `${i % 10} ` }));

test('the tail of a heavily chunked stream matches chunk-by-chunk appending', () => {
  const items = streamedChunks(3000);
  let state = createThoughtTail();
  for (const item of items) state = appendThoughtChunk(state, item.content, item.tokens, 400);
  const batch = tailThoughtChunks(items, 400);
  assert.equal(thoughtTailText(batch), thoughtTailText(state));
  assert.equal(batch.omittedTokens, state.omittedTokens);
  assert.equal(batch.lastTokens, state.lastTokens);
});

test('building the tail of a long chat stays linear in the number of chunks', () => {
  const items = streamedChunks(120000);
  const started = performance.now();
  const state = tailThoughtChunks(items, DEFAULT_THOUGHT_CONTEXT_TOKENS);
  const elapsed = performance.now() - started;
  // The tail is the most recent `limit` tokens, at two characters per chunk.
  assert.equal(thoughtTailText(state).length, DEFAULT_THOUGHT_CONTEXT_TOKENS * 2);
  // Two orders of magnitude of headroom over a linear pass, and an order of
  // magnitude under the quadratic one this replaced.
  assert.ok(elapsed < 2000, `building the tail took ${Math.round(elapsed)}ms`);
});

test('the newest chunk is always shown, even when it alone exceeds the limit', () => {
  const state = appendThoughtChunk(createThoughtTail(), 'huge', 5000, 1000);
  assert.equal(thoughtTailText(state), 'huge');
});

test('chunks without a backend count are estimated at four characters per token', () => {
  const state = tailThoughtChunks([
    { content: 'x'.repeat(400) },
    { content: 'y'.repeat(400) },
  ], 150);
  assert.equal(thoughtTailText(state), 'y'.repeat(400));
  assert.equal(state.omittedTokens, 100);
});

test('plain text is cut from the start by the token estimate', () => {
  const { text, omittedTokens } = tailTextByTokens('a'.repeat(12) + 'b'.repeat(8), 2);
  assert.equal(text, 'b'.repeat(8));
  assert.equal(omittedTokens, 3);
});

test('the configured size is clamped to the supported range', () => {
  assert.equal(clampThoughtContextTokens('abc'), 32000);
  assert.equal(clampThoughtContextTokens(10), 1000);
  assert.equal(clampThoughtContextTokens(5_000_000), 1000000);
  assert.equal(clampThoughtContextTokens(64000), 64000);
});

// The live stream appends one chunk per token. Copying the kept window on every
// append made a 30,000-token reasoning phase cost ~28 s of main-thread time.
test('streaming a long reasoning phase chunk by chunk stays linear', () => {
  const started = performance.now();
  let state = createThoughtTail();
  for (let i = 0; i < 120000; i += 1) state = appendThoughtChunk(state, `${i % 10} `, i + 1, 32000);
  const elapsed = performance.now() - started;
  assert.equal(thoughtTailText(state).length, 32000 * 2);
  assert.equal(state.omittedTokens, 120000 - 32000);
  assert.ok(elapsed < 2000, `streaming the tail took ${Math.round(elapsed)}ms`);
});

test('a state keeps its chunks after a newer state was built from it', () => {
  const base = appendThoughtChunk(createThoughtTail(), 'a', 1, 100);
  const left = appendThoughtChunk(base, 'b', 2, 100);
  const right = appendThoughtChunk(base, 'c', 2, 100);
  assert.equal(thoughtTailText(base), 'a');
  assert.equal(thoughtTailText(left), 'ab');
  assert.equal(thoughtTailText(right), 'ac');
});

test('compacting the shared window gives the same tail as building it at once', () => {
  const items = Array.from({ length: 9000 }, (_, i) => ({ content: `c${i} `, tokens: (i + 1) * 3 }));
  let state = createThoughtTail();
  for (const item of items) state = appendThoughtChunk(state, item.content, item.tokens, 1500);
  const batch = tailThoughtChunks(items, 1500);
  assert.equal(thoughtTailText(state), thoughtTailText(batch));
  assert.equal(state.omittedTokens, batch.omittedTokens);
  assert.ok(state.items.length <= 2 * (state.count - state.first) + 1024);
});
