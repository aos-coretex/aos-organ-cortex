import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArbiterClient } from '../lib/arbiter-client.js';

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return calls;
}

test('getBoRRaw returns BoR data on 200', async () => {
  mockFetch([{
    status: 200,
    body: {
      version: '1.0.0',
      hash: 'abc',
      raw_text: '# BoR',
      effective_since: '2026-01-01T00:00:00Z',
      loaded_at: '2026-04-11T00:00:00Z',
    },
  }]);
  const client = createArbiterClient({ arbiterUrl: 'http://127.0.0.1:4021' });
  const bor = await client.getBoRRaw();
  assert.equal(bor.version, '1.0.0');
  assert.equal(bor.raw_text, '# BoR');
});

test('getBoRRaw returns null on 503 BOR_NOT_LOADED', async () => {
  mockFetch([{ status: 503, body: { error: 'BOR_NOT_LOADED' } }]);
  const client = createArbiterClient({ arbiterUrl: 'http://127.0.0.1:4021' });
  const bor = await client.getBoRRaw();
  assert.equal(bor, null);
});

test('getBoRRaw returns null on 404 (endpoint missing — repair not landed)', async () => {
  mockFetch([{ status: 404, body: { error: 'not found' } }]);
  const client = createArbiterClient({ arbiterUrl: 'http://127.0.0.1:4021' });
  const bor = await client.getBoRRaw();
  assert.equal(bor, null);
});

test('getBoRRaw returns null on network error', async () => {
  mockFetch([{ throw: 'ECONNREFUSED' }]);
  const client = createArbiterClient({ arbiterUrl: 'http://127.0.0.1:4021' });
  const bor = await client.getBoRRaw();
  assert.equal(bor, null);
});

test('getBoRRaw sends X-Organ-Name: Cortex header', async () => {
  const calls = mockFetch([{ status: 200, body: { version: '1.0.0', hash: 'x', raw_text: '', effective_since: '', loaded_at: '' } }]);
  const client = createArbiterClient({ arbiterUrl: 'http://127.0.0.1:4021' });
  await client.getBoRRaw();
  assert.equal(calls[0].opts.headers['X-Organ-Name'], 'Cortex');
});
