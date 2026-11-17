import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveModel } from '../helperModels.js';

const tasks = {
  translate_model: { default: 'haiku' },
  lookup_model: { default: 'sonnet' },
  tex_change_model: { follows: 'lookup_model' },
};

test('a task runs on its own model, else its default, else the task it follows', () => {
  const none = { translate_model: '', lookup_model: '', tex_change_model: '' };
  assert.equal(effectiveModel('translate_model', none, tasks), 'haiku');
  assert.equal(effectiveModel('tex_change_model', none, tasks), 'sonnet');
  assert.equal(effectiveModel('tex_change_model', { ...none, lookup_model: 'opus' }, tasks), 'opus');
  assert.equal(effectiveModel('tex_change_model', { ...none, tex_change_model: 'fable' }, tasks), 'fable');
  assert.equal(effectiveModel('unknown', none, tasks), '');
});
