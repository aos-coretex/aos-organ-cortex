/**
 * Slice-clients unit tests — per-slice cache hit/miss, fail-soft contract,
 * spine cursor + dedup + window-evict + checkAvailable. Authored in p4r-3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRadiantSliceClient,
  createMinderSliceClient,
  createHippocampusSliceClient,
  createGraphStructuralSliceClient,
  createSpineStateSliceClient,
} from '../lib/slice-clients.js';
import { createWorldStateCache } from '../lib/world-state-cache.js';

// Route-aware fetch mock — same shape as cm-client.test.js.
function routeFetch(routes) {
  globalThis.fetch = async (url) => {
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (response.throw) throw new Error(response.throw);
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'no route' }) };
  };
}

const happyRadiant = {
  '/context': { status: 200, body: { blocks: [{ id: 1, content: 'ctx', entity: 'llm-ops', created_at: 't1' }] } },
  '/memory':  { status: 200, body: { blocks: [{ id: 2, content: 'mem', entity: 'llm-ops', created_at: 't2' }] } },
  '/stats':   { status: 200, body: { context_count: 1, memory_count: 1, last_dream_at: 't' } },
};

// --- Radiant slice client ---

test('radiant slice: first read fetches; second read hits cache', async () => {
  routeFetch(happyRadiant);
  const cache = createWorldStateCache();
  const client = createRadiantSliceClient({ radiantUrl: 'http://r', timeoutMs: 1000 }, cache, { ttlMs: 60000 });
  const r1 = await client.read();
  assert.equal(r1.ok, true);
  assert.equal(r1._cache.hit, false);
  assert.ok(r1._cache.fetched_ms >= 0);
  assert.ok(r1.data.recent_context, 'context populated');
  const r2 = await client.read();
  assert.equal(r2.ok, true);
  assert.equal(r2._cache.hit, true);
  assert.ok(r2._cache.age_ms >= 0);
  assert.equal(r2._cache.fetched_ms, 0);
});

test('radiant slice: invalidate forces refetch', async () => {
  routeFetch(happyRadiant);
  const cache = createWorldStateCache();
  const client = createRadiantSliceClient({ radiantUrl: 'http://r', timeoutMs: 1000 }, cache, { ttlMs: 60000 });
  await client.read();
  client.invalidate();
  const r2 = await client.read();
  assert.equal(r2._cache.hit, false, 'invalidate forces miss');
});

test('radiant slice: all 3 endpoints fail → degraded, not cached', async () => {
  routeFetch({ '/context': { status: 503, body: {} }, '/memory': { status: 503, body: {} }, '/stats': { status: 503, body: {} } });
  const cache = createWorldStateCache();
  const client = createRadiantSliceClient({ radiantUrl: 'http://r', timeoutMs: 1000 }, cache);
  const r = await client.read();
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r._cache.hit, false);
  // Failed reads must NOT cache (so subsequent retries actually retry).
  const peek = cache.peek();
  assert.ok(!peek.radiant, 'failed read must not populate cache');
});

// --- Minder slice client ---

test('minder slice: cache hit/miss', async () => {
  routeFetch({
    '/peers/recent':        { status: 200, body: { peers: [{ peer_id: 'p1' }] } },
    '/observations/recent': { status: 200, body: { observations: [{ peer_id: 'p1', content: 'o1' }] } },
  });
  const cache = createWorldStateCache();
  const client = createMinderSliceClient({ minderUrl: 'http://m' }, cache, { ttlMs: 60000 });
  const r1 = await client.read();
  assert.equal(r1.ok, true);
  assert.equal(r1._cache.hit, false);
  const r2 = await client.read();
  assert.equal(r2._cache.hit, true);
});

// --- Hippocampus slice client ---

test('hippocampus slice: nested participants shape preserved', async () => {
  routeFetch({
    '/conversations': { status: 200, body: { conversations: [{
      urn: 'urn:h:1',
      summary: 's1',
      participants: { user_urn: 'urn:user:a' },
      message_count: 2,
      updated_at: 't',
    }] } },
  });
  const cache = createWorldStateCache();
  const client = createHippocampusSliceClient({ hippocampusUrl: 'http://h' }, cache);
  const r = await client.read();
  assert.equal(r.ok, true);
  assert.equal(r.data.recent_conversations[0].participant_urn, 'urn:user:a');
});

// --- Graph slice client ---

test('graph slice: queryConcepts result composes into expected shape', async () => {
  const graphAdapter = {
    queryConcepts: async (sql) => {
      if (sql.includes('GROUP BY')) {
        return { rows: [{ type: 'entity', count: 5 }, { type: 'binding', count: 3 }] };
      }
      return { rows: [{ urn: 'urn:e:1', data: { type: 'entity', status: 'active', tier: 'platform' } }] };
    },
  };
  const cache = createWorldStateCache();
  const client = createGraphStructuralSliceClient({ graphAdapter }, cache, { ttlMs: 60000 });
  const r = await client.read();
  assert.equal(r.ok, true);
  assert.equal(r.data.recent_entities[0].urn, 'urn:e:1');
  assert.equal(r.data.recent_concept_counts_by_type.entity, 5);
  assert.equal(r.data.recent_concept_counts_by_type.binding, 3);
  // Cache hit on second call
  const r2 = await client.read();
  assert.equal(r2._cache.hit, true);
});

test('graph slice: queryConcepts throws → degraded, not cached', async () => {
  const graphAdapter = { queryConcepts: async () => { throw new Error('graph down'); } };
  const cache = createWorldStateCache();
  const client = createGraphStructuralSliceClient({ graphAdapter }, cache);
  const r = await client.read();
  assert.equal(r.ok, false);
  assert.match(r.error, /graph down/);
  assert.ok(!cache.peek().graph_structural, 'failed read must not populate cache');
});

// --- Spine_state slice client ---

function makeSpineEvent(transitionId, createdAt) {
  return {
    urn: `urn:event:${transitionId}`,
    created_at: createdAt,
    envelope: {
      payload: {
        event_type: 'state_transition',
        data: {
          entity_urn: `urn:e:${transitionId}`,
          previous_state: 'A',
          current_state: 'B',
          transition_id: transitionId,
          actor: 'sys',
          reason: 'test',
        },
      },
    },
  };
}

test('spine_state slice: first read fetches full window; cursor advances', async () => {
  // Timestamps relative to now so they survive window-evict (10-min window).
  const t1Iso = new Date(Date.now() - 60000).toISOString();
  const t2Iso = new Date(Date.now() - 30000).toISOString();
  routeFetch({ '/events': { status: 200, body: { events: [makeSpineEvent('t1', t1Iso), makeSpineEvent('t2', t2Iso)] } } });
  const client = createSpineStateSliceClient({ spineUrl: 'http://s', eventsWindowMs: 600000 });
  const r = await client.read();
  assert.equal(r.ok, true);
  assert.equal(r.data.recent_transitions.length, 2);
  assert.equal(r._cache.new_transitions, 2);
  assert.equal(r._cache.evicted, 0);
  const peek = client.peekCache();
  assert.equal(peek.cached_count, 2);
  assert.equal(peek.lastSeenCreatedAt, t2Iso);
});

test('spine_state slice: dedup against cached set on transition_id', async () => {
  const t1Iso = new Date(Date.now() - 60000).toISOString();
  const t2Iso = new Date(Date.now() - 30000).toISOString();
  const t3Iso = new Date(Date.now() - 5000).toISOString();
  let callNo = 0;
  globalThis.fetch = async (url) => {
    callNo += 1;
    const body = callNo === 1
      ? { events: [makeSpineEvent('t1', t1Iso), makeSpineEvent('t2', t2Iso)] }
      : { events: [makeSpineEvent('t2', t2Iso), makeSpineEvent('t3', t3Iso)] };
    return { ok: true, status: 200, json: async () => body };
  };
  const client = createSpineStateSliceClient({ spineUrl: 'http://s', eventsWindowMs: 600000 });
  const r1 = await client.read();
  assert.equal(r1.data.recent_transitions.length, 2);
  const r2 = await client.read();
  assert.equal(r2._cache.new_transitions, 1);
  assert.equal(r2.data.recent_transitions.length, 3);
  const ids = r2.data.recent_transitions.map(t => t.transition_id);
  assert.deepEqual(ids, ['t1', 't2', 't3']);
});

test('spine_state slice: window-evict drops transitions older than eventsWindowMs', async () => {
  const now = Date.now();
  const oldIso = new Date(now - 700000).toISOString(); // 700s old (>600s window)
  const recentIso = new Date(now - 60000).toISOString(); // 60s old
  let callNo = 0;
  globalThis.fetch = async () => {
    callNo += 1;
    const body = callNo === 1
      ? { events: [makeSpineEvent('old', oldIso), makeSpineEvent('recent', recentIso)] }
      : { events: [] }; // no new events second call
    return { ok: true, status: 200, json: async () => body };
  };
  const client = createSpineStateSliceClient({ spineUrl: 'http://s', eventsWindowMs: 600000 });
  const r1 = await client.read();
  // First read: both transitions are added, then window-evict removes the old one.
  assert.equal(r1._cache.new_transitions, 2, 'both arrived as new');
  assert.equal(r1._cache.evicted, 1, 'old one evicted by window');
  assert.equal(r1.data.recent_transitions.length, 1);
  assert.equal(r1.data.recent_transitions[0].transition_id, 'recent');
});

test('spine_state slice: cursor backoff applies on second read', async () => {
  const tIso = new Date(Date.now() - 30000).toISOString();
  const captured = [];
  globalThis.fetch = async (url) => {
    captured.push(url);
    return { ok: true, status: 200, json: async () => ({ events: [makeSpineEvent('a', tIso)] }) };
  };
  const client = createSpineStateSliceClient({
    spineUrl: 'http://s',
    eventsWindowMs: 600000,
    boundaryBackoffMs: 250,
  });
  await client.read();
  await client.read();
  const sinceMatch2 = captured[1].match(/since=([^&]+)/);
  const since2Iso = decodeURIComponent(sinceMatch2[1]);
  const since2Ms = new Date(since2Iso).getTime();
  const lastSeenMs = new Date(tIso).getTime();
  assert.ok(since2Ms <= lastSeenMs, 'backoff applied (since <= lastSeen)');
  assert.ok(since2Ms >= lastSeenMs - 251, 'backoff is 250ms window');
});

test('spine_state slice: HTTP 500 → ok:false; cached transitions preserved', async () => {
  const tIso = new Date(Date.now() - 30000).toISOString();
  let callNo = 0;
  globalThis.fetch = async () => {
    callNo += 1;
    if (callNo === 1) return { ok: true, status: 200, json: async () => ({ events: [makeSpineEvent('t1', tIso)] }) };
    return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
  };
  const client = createSpineStateSliceClient({ spineUrl: 'http://s' });
  await client.read();
  const r2 = await client.read();
  assert.equal(r2.ok, false);
  assert.equal(client.peekCache().cached_count, 1);
});

test('spine_state slice: invalidate resets cursor + cache', async () => {
  const tIso = new Date(Date.now() - 30000).toISOString();
  routeFetch({ '/events': { status: 200, body: { events: [makeSpineEvent('t1', tIso)] } } });
  const client = createSpineStateSliceClient({ spineUrl: 'http://s' });
  await client.read();
  client.invalidate();
  const peek = client.peekCache();
  assert.equal(peek.lastSeenCreatedAt, null);
  assert.equal(peek.cached_count, 0);
  assert.equal(peek.availability_probed, false);
});

// --- checkAvailable() ---

test('checkAvailable: probe /health returns true when ok', async () => {
  routeFetch({ '/health': { status: 200, body: { status: 'ok' } } });
  const client = createSpineStateSliceClient({ spineUrl: 'http://s' });
  const ok = await client.checkAvailable();
  assert.equal(ok, true);
});

test('checkAvailable: returns false when /health unreachable', async () => {
  routeFetch({});  // 404 for everything
  const client = createSpineStateSliceClient({ spineUrl: 'http://s' });
  const ok = await client.checkAvailable();
  assert.equal(ok, false);
});

test('checkAvailable: result cached for probeTtlMs (no second probe within window)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  };
  const client = createSpineStateSliceClient({ spineUrl: 'http://s', probeTtlMs: 60000 });
  await client.checkAvailable();
  await client.checkAvailable();
  await client.checkAvailable();
  assert.equal(calls, 1, 'probe must be cached for probeTtlMs');
});

test('checkAvailable: cache expires after probeTtlMs', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const client = createSpineStateSliceClient({ spineUrl: 'http://s', probeTtlMs: 5 });
  await client.checkAvailable();
  await new Promise(r => setTimeout(r, 20));
  await client.checkAvailable();
  assert.equal(calls, 2, 'probe re-runs after TTL expires');
});
