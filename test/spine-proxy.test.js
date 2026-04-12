import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpineProxy } from '../lib/spine-proxy.js';

test('createSpineProxy returns an unbound proxy', () => {
  const p = createSpineProxy();
  assert.equal(p.isBound(), false);
  assert.equal(p.raw(), null);
});

test('send() throws spine-proxy-not-bound before bind()', async () => {
  const p = createSpineProxy();
  await assert.rejects(() => p.send({ type: 'OTM' }), /spine-proxy-not-bound/);
});

test('bind() wires the live spine and send() delegates', async () => {
  const calls = [];
  const liveSpine = { send: async (env) => { calls.push(env); return { message_id: 'urn:test:1' }; } };
  const p = createSpineProxy();
  p.bind(liveSpine);
  assert.equal(p.isBound(), true);
  assert.equal(p.raw(), liveSpine);
  const result = await p.send({ type: 'OTM', payload: {} });
  assert.equal(result.message_id, 'urn:test:1');
  assert.equal(calls.length, 1);
});
