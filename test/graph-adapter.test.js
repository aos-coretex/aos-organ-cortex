import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphAdapter, GraphTimeoutError } from '../lib/graph-adapter.js';

// Stub global fetch for unit tests — track calls
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
      text: async () => JSON.stringify(next.body),
    };
  };
  return calls;
}

// Abort-only mock: never resolves; rejects only when the AbortController fires.
// Adapted from test/http-helpers.test.js::mockFetch({abort:true}) — no dangling timer.
function mockFetchAbort() {
  globalThis.fetch = async (_url, opts) => {
    await new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
}

test('queryConcepts POSTs to /query with X-Organ-Name header and {sql,params} body', async () => {
  const calls = mockFetch([{ status: 200, body: { rows: [], count: 0 } }]);
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020' });
  await adapter.queryConcepts('SELECT 1', ['foo']);
  assert.equal(calls[0].url, 'http://127.0.0.1:4020/query');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['X-Organ-Name'], 'Cortex');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  // Fix 1d (repair #09 x2p-2 O2): verify the exact body shape that Graph's
  // POST /query route expects — { sql, params }. Graph forwards sql directly
  // to the SQLite adapter's .query() (see AOS-organ-graph/server/routes/query.js
  // and server/adapter/sqlite.js line 176). SQLite 3.38+ supports the `->>`
  // JSONB-style operator on TEXT columns with json_valid checks, so the
  // mission-loader's `data->>'type' = 'msp_version'` query is Path A (no
  // dialect rewrite needed).
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.equal(sentBody.sql, 'SELECT 1');
  assert.deepEqual(sentBody.params, ['foo']);
});

test('queryConcepts throws on HTTP error', async () => {
  mockFetch([{ status: 500, body: { error: 'internal' } }]);
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020' });
  await assert.rejects(() => adapter.queryConcepts('bad', []), /graph_query_failed/);
});

test('queryConcepts honors graphTimeoutMs and throws GraphTimeoutError on abort', async () => {
  mockFetchAbort();
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020', timeoutMs: 25 });
  await assert.rejects(
    () => adapter.queryConcepts('SELECT 1', []),
    (err) => {
      assert.ok(err instanceof GraphTimeoutError, 'expected GraphTimeoutError');
      assert.equal(err.name, 'GraphTimeoutError');
      assert.equal(err.error, 'timeout');
      assert.equal(err.timeoutMs, 25);
      assert.equal(err.url, 'http://127.0.0.1:4020/query');
      return true;
    },
  );
});

test('getConcept returns null on 404', async () => {
  mockFetch([{ status: 404, body: { error: 'not found' } }]);
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020' });
  const result = await adapter.getConcept('urn:test:1');
  assert.equal(result, null);
});

test('getConcept URN-encodes the path segment', async () => {
  const calls = mockFetch([{ status: 200, body: { urn: 'urn:x', data: {} } }]);
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020' });
  await adapter.getConcept('urn:graphheight:msp_version:1.0.0');
  assert.ok(calls[0].url.endsWith('urn%3Agraphheight%3Amsp_version%3A1.0.0'));
});

test('getConcept honors graphTimeoutMs and throws GraphTimeoutError on abort', async () => {
  mockFetchAbort();
  const adapter = createGraphAdapter({ graphUrl: 'http://127.0.0.1:4020', timeoutMs: 25 });
  await assert.rejects(
    () => adapter.getConcept('urn:test:1'),
    (err) => {
      assert.ok(err instanceof GraphTimeoutError, 'expected GraphTimeoutError');
      assert.equal(err.name, 'GraphTimeoutError');
      assert.equal(err.error, 'timeout');
      assert.equal(err.timeoutMs, 25);
      assert.ok(err.url.endsWith('/concepts/urn%3Atest%3A1'));
      return true;
    },
  );
});
