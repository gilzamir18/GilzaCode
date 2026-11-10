import test from 'node:test';
import assert from 'node:assert/strict';
import { establishLocalSession } from '../localSession.js';

test('session setup uses cookies and verifies them before mounting the app', async () => {
  const calls = [];
  await establishLocalSession(async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['X-GilzaCode-Bootstrap'], '1');
  assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
});

test('disabled cookies produce an explicit startup failure', async () => {
  let count = 0;
  await assert.rejects(establishLocalSession(async () => ({ ok: ++count === 1 })), /verified/);
});
