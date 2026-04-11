import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedFetch } from '../lib/http-helpers.js';

function mockFetch(response) {
  globalThis.fetch = async (url, opts) => {
    if (response.throw) throw new Error(response.throw);
    if (response.abort) {
      // Wait until the AbortController signal fires — reject only, no dangling timer.
      await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

test('timedFetch returns {ok,status,data,error:null} on 200', async () => {
  mockFetch({ status: 200, body: { hello: 'world' } });
  const r = await timedFetch('http://x/');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { hello: 'world' });
  assert.equal(r.error, null);
});

test('timedFetch returns {ok:false,error:"HTTP 500"} on 500', async () => {
  mockFetch({ status: 500, body: { error: 'internal' } });
  const r = await timedFetch('http://x/');
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.error, 'HTTP 500');
});

test('timedFetch returns {ok:false,error:"timeout"} on abort', async () => {
  mockFetch({ abort: true });
  const r = await timedFetch('http://x/', { timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('timedFetch returns {ok:false,error} on network error', async () => {
  mockFetch({ throw: 'ECONNREFUSED' });
  const r = await timedFetch('http://x/');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('ECONNREFUSED'));
});

test('timedFetch sends X-Organ-Name: Cortex', async () => {
  let seenHeaders;
  globalThis.fetch = async (url, opts) => {
    seenHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await timedFetch('http://x/');
  assert.equal(seenHeaders['X-Organ-Name'], 'Cortex');
});

test('timedFetch merges custom headers without overriding X-Organ-Name', async () => {
  let seenHeaders;
  globalThis.fetch = async (url, opts) => {
    seenHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await timedFetch('http://x/', { headers: { 'X-Custom': 'value' } });
  assert.equal(seenHeaders['X-Organ-Name'], 'Cortex');
  assert.equal(seenHeaders['X-Custom'], 'value');
});
