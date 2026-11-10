import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orphanReasoningPrefix,
  stripOrphanReasoningPrefix,
  stripInlineReasoning,
  thoughtBlock,
} from '../thinkTags.js';

const LEAKED = 'Cleanup done. Let me structure it clearly:\n</think>Analisei os slides 4-9.';

test('an orphan </think> closes a reasoning prefix', () => {
  assert.equal(orphanReasoningPrefix(LEAKED), 'Cleanup done. Let me structure it clearly:');
  assert.equal(stripOrphanReasoningPrefix(LEAKED), 'Analisei os slides 4-9.');
});

test('a closing tag belonging to a balanced block is not an orphan', () => {
  assert.equal(orphanReasoningPrefix('<think>note</think>Answer.'), '');
  assert.equal(stripOrphanReasoningPrefix('<think>note</think>Answer.'), '<think>note</think>Answer.');
});

test('content without reasoning is left untouched', () => {
  assert.equal(orphanReasoningPrefix('Plain answer.'), '');
  assert.equal(stripInlineReasoning('Plain answer.'), 'Plain answer.');
});

test('stripInlineReasoning removes the orphan prefix and balanced blocks', () => {
  assert.equal(stripInlineReasoning('reasoning</think>Answer.<think>more</think>'), 'Answer.');
});

test('stripInlineReasoning removes an unclosed block left by a partial stream', () => {
  assert.equal(stripInlineReasoning('Answer.<think>still thinking'), 'Answer.');
});

test('a thought block outlives fenced code inside the reasoning', () => {
  const reasoning = 'Let me check:\n```python\nprint(1)\n```\nDone.';
  const block = thoughtBlock(reasoning);

  assert.ok(block.startsWith('\n````thought\n'), 'fence must be longer than the inner one');
  assert.ok(block.endsWith('\n````\n'));
  // The whole reasoning stays inside, so the answer after it is never swallowed.
  assert.ok(block.includes('```python\nprint(1)\n```'));
});

test('a thought block uses the plain fence when the reasoning has none', () => {
  assert.equal(thoughtBlock('just prose'), '\n```thought\njust prose\n```\n');
});
