import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MERGED_LOG_CHARS,
  clampLogMessage,
  fitLogMessage,
  joinMergedLogMessage,
} from '../logMerge.js';

const THOUGHT_TOKENS = 32000;

test('reasoning keeps its end, so the panel follows a running turn', () => {
  // The defect: past the cap the merged entry kept its first characters, so
  // every new chunk was appended and immediately cut away and the Agent
  // Thinking panel stopped moving while the chat preview kept up.
  let merged = '';
  for (let i = 0; i < 5000; i += 1) {
    merged = fitLogMessage(joinMergedLogMessage(merged, `chunk${i} `, 'thought'), 'thought', THOUGHT_TOKENS);
  }

  assert.ok(merged.endsWith('chunk4999 '), 'the latest reasoning must be on screen');
  assert.ok(!merged.includes('[log truncated]'));
});

test('an ordinary log still keeps its beginning', () => {
  const long = 'x'.repeat(MAX_MERGED_LOG_CHARS + 500);
  const fitted = fitLogMessage(long, 'stdout', THOUGHT_TOKENS);

  assert.ok(fitted.startsWith('x'.repeat(100)));
  assert.ok(fitted.endsWith('[log truncated]'));
});

test('reasoning chunks are concatenated as the token stream wrote them', () => {
  assert.equal(joinMergedLogMessage('Let me ', 'write.', 'thought'), 'Let me write.');
});

test('reflections stay one per line', () => {
  assert.equal(joinMergedLogMessage('First. ', ' Second.', 'reflection'), 'First.\nSecond.');
});

test('an empty side never introduces a separator', () => {
  assert.equal(joinMergedLogMessage('', 'only', 'reflection'), 'only');
  assert.equal(joinMergedLogMessage('only', '', 'thought'), 'only');
});

test('a short log is returned untouched', () => {
  assert.equal(clampLogMessage('ok'), 'ok');
});
