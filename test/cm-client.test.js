import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmClient } from '../lib/cm-client.js';

// Route-aware mock fetch: looks at URL and returns the matching response.
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

const happyRoutes = {
  // Radiant
  '/context': { status: 200, body: { blocks: [{ id: 1, content: 'ctx1', entity: 'llm-ops', created_at: 't1' }] } },
  '/memory':  { status: 200, body: { blocks: [{ id: 2, content: 'mem1', entity: 'llm-ops', created_at: 't2' }] } },
  '/stats':   { status: 200, body: { context_count: 1, memory_count: 1, last_dream_at: '2026-04-11T03:00:00Z' } },
  // Minder
  '/peers/recent':        { status: 200, body: { peers: [{ peer_id: 'p1', name: 'leon', last_seen: 't1' }] } },
  '/observations/recent': { status: 200, body: { observations: [{ peer_id: 'p1', observation_type: 'FACT', content: 'o1', created_at: 't1' }] } },
  // Hippocampus — nested participants shape (verified against
  // AOS-organ-hippocampus-src/server/routes/conversations.js:377-381)
  '/conversations': { status: 200, body: { conversations: [{
    urn: 'urn:h:1',
    status: 'completed',
    participants: { user_urn: 'urn:test:user:leon', persona_urn: 'urn:test:persona:architect' },
    summary: 'conv1',
    message_count: 5,
    updated_at: 't3',
  }] } },
  // Spine events
  '/events': { status: 200, body: { events: [
    { urn: 'urn:event:1', created_at: 't4', envelope: { payload: { event_type: 'state_transition', data: { entity_urn: 'urn:e:1', previous_state: 'A', current_state: 'B', transition_id: 'tr1', actor: 'sys', reason: 'test' } } } },
    { urn: 'urn:event:2', created_at: 't5', envelope: { payload: { event_type: 'mailbox_pressure', data: {} } } }, // should be filtered out client-side
  ], count: 2 } },
};

function fakeGraph({ rowsEntities = [], rowsCounts = [], throws = false } = {}) {
  return {
    queryConcepts: async (sql) => {
      if (throws) throw new Error('graph down');
      if (sql.includes('GROUP BY')) return { rows: rowsCounts, count: rowsCounts.length };
      return { rows: rowsEntities, count: rowsEntities.length };
    },
  };
}

test('readWorldState returns full snapshot when all 5 sources are OK', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl:     'http://r',
    minderUrl:      'http://m',
    hippocampusUrl: 'http://h',
    graphAdapter:   fakeGraph({
      rowsEntities: [{ urn: 'urn:ent:1', data: { type: 'entity', status: 'active', tier: 'platform' } }],
      rowsCounts:   [{ type: 'entity', count: 5 }],
    }),
    spineUrl: 'http://s',
    timeoutMs: 1000,
  });
  const result = await client({});
  const snap = result.snapshot;
  assert.notEqual(snap.radiant, null);
  assert.notEqual(snap.minder, null);
  assert.notEqual(snap.hippocampus, null);
  assert.notEqual(snap.graph_structural, null);
  assert.notEqual(snap.spine_state, null);
  assert.deepEqual(snap.sources_ok.sort(), ['Graph', 'Hippocampus', 'Minder', 'Radiant', 'Spine']);
  assert.deepEqual(snap.degraded, []);
  // Repair #09 x2p-3 O3: participant_urn must be extracted from nested
  // participants.user_urn (not from a non-existent top-level field).
  assert.equal(
    snap.hippocampus.recent_conversations[0].participant_urn,
    'urn:test:user:leon',
    'participant_urn should come from participants.user_urn (Hippocampus nested shape)',
  );
});

test('Radiant blocks are stripped of embedding and redundant/null fields (C2A cortex-03 Source 1)', async () => {
  const embeddingString = '[' + Array.from({ length: 768 }, (_, i) => (i * 0.001).toFixed(6)).join(',') + ']';
  const rawContextBlock = {
    id: 'block-1',
    lifecycle: 'context',
    content: 'hello',
    metadata: { type: 'test' },
    session_id: null,
    entity: 'llm-ops',
    source_sessions: null,
    embedding: embeddingString,
    created_at: 't1',
    expires_at: 't2',
    promoted_at: null,
    created_by: 'test',
  };
  const rawMemoryBlock = {
    ...rawContextBlock,
    id: 'block-2',
    lifecycle: 'memory',
    session_id: 'session-abc',  // non-null — must be retained
  };

  const routes = {
    ...happyRoutes,
    '/context': { status: 200, body: { blocks: [rawContextBlock] } },
    '/memory':  { status: 200, body: { blocks: [rawMemoryBlock] } },
  };
  routeFetch(routes);

  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  const { snapshot } = await client({});

  const ctx = snapshot.radiant.recent_context[0];
  assert.equal(ctx.embedding, undefined, 'embedding must be stripped — not decision-relevant');
  assert.equal(ctx.lifecycle, undefined, 'lifecycle must be stripped — redundant');
  assert.equal(ctx.session_id, undefined, 'null session_id must be stripped');
  assert.equal(ctx.source_sessions, undefined, 'null source_sessions must be stripped');
  assert.equal(ctx.promoted_at, undefined, 'null promoted_at must be stripped');
  assert.equal(ctx.id, 'block-1', 'id must be retained');
  assert.equal(ctx.content, 'hello', 'content must be retained');
  assert.equal(ctx.entity, 'llm-ops', 'entity must be retained');
  assert.equal(ctx.created_at, 't1', 'created_at must be retained');
  assert.deepEqual(ctx.metadata, { type: 'test' }, 'metadata must be retained');

  const mem = snapshot.radiant.recent_memory[0];
  assert.equal(mem.embedding, undefined, 'memory embedding must be stripped');
  assert.equal(mem.session_id, 'session-abc', 'non-null session_id must be retained');
});

test('hippocampus mapping falls back to persona_urn when user_urn missing', async () => {
  const routes = {
    ...happyRoutes,
    '/conversations': { status: 200, body: { conversations: [{
      urn: 'urn:h:2',
      status: 'completed',
      participants: { persona_urn: 'urn:test:persona:architect' }, // no user_urn
      summary: 'conv2',
      message_count: 3,
      updated_at: 't6',
    }] } },
  };
  routeFetch(routes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(
    snapshot.hippocampus.recent_conversations[0].participant_urn,
    'urn:test:persona:architect',
    'participant_urn should fall back to persona_urn when user_urn is absent',
  );
});

test('hippocampus mapping returns null when participants field is absent (legacy/edge case)', async () => {
  const routes = {
    ...happyRoutes,
    // Conversation with no `participants` key at all — must not throw, must yield null
    '/conversations': { status: 200, body: { conversations: [{
      urn: 'urn:h:3',
      status: 'completed',
      summary: 'conv3',
      message_count: 1,
      updated_at: 't7',
    }] } },
  };
  routeFetch(routes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(
    snapshot.hippocampus.recent_conversations[0].participant_urn,
    null,
    'participant_urn should be null when participants key is absent (no throw, defensive)',
  );
});

test('spine_state client-side filters non-state_transition events', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(snapshot.spine_state.recent_transitions.length, 1, 'should keep only state_transition events');
  assert.equal(snapshot.spine_state.recent_transitions[0].entity_urn, 'urn:e:1');
});

test('radiant-degraded: all 3 Radiant endpoints return 503', async () => {
  const routes = { ...happyRoutes, '/context': { status: 503, body: {} }, '/memory': { status: 503, body: {} }, '/stats': { status: 503, body: {} } };
  routeFetch(routes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(snapshot.radiant, null);
  assert.ok(snapshot.sources_degraded.some(s => s.startsWith('Radiant:')));
  assert.ok(snapshot.degraded.includes('radiant-degraded'));
  // Other sources still OK
  assert.notEqual(snapshot.minder, null);
  assert.notEqual(snapshot.hippocampus, null);
});

test('graph-degraded: queryConcepts throws', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph({ throws: true }),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(snapshot.graph_structural, null);
  assert.ok(snapshot.sources_degraded.some(s => s.startsWith('Graph:')));
  assert.ok(snapshot.degraded.includes('graph-structural-degraded'));
});

test('spine-degraded: /events returns 500 (loop should pause — enforced by engine, not cm-client)', async () => {
  const routes = { ...happyRoutes, '/events': { status: 500, body: {} } };
  routeFetch(routes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(snapshot.spine_state, null);
  assert.ok(snapshot.degraded.includes('spine-state-degraded'));
  // cm-client still returns — it's the loop engine's job to halt on spine_state === null
});

test('fully degraded: all 5 sources down, snapshot still returns', async () => {
  routeFetch({}); // 404 for every path
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph({ throws: true }),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.equal(snapshot.radiant, null);
  assert.equal(snapshot.minder, null);
  assert.equal(snapshot.hippocampus, null);
  assert.equal(snapshot.graph_structural, null);
  assert.equal(snapshot.spine_state, null);
  assert.deepEqual(snapshot.sources_ok, []);
  assert.equal(snapshot.sources_degraded.length, 5);
  assert.equal(snapshot.degraded.length, 5);
});

test('composed_at and window_since are ISO8601', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(),
    spineUrl: 'http://s',
  });
  const { snapshot } = await client({});
  assert.match(snapshot.composed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(snapshot.window_since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('p4r-3: result includes correlation_id (string) for stitching with prompt-size-breakdown', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  const result = await client({});
  assert.equal(typeof result.correlation_id, 'string');
  assert.ok(result.correlation_id.length > 0);
});

test('p4r-3: cmClient exposes readSlice(name) for per-section assessment cycles', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  assert.equal(typeof client.readSlice, 'function');
  const radiant = await client.readSlice('radiant');
  assert.equal(radiant.ok, true);
  assert.equal(radiant.source, 'Radiant');
  assert.ok(radiant.data.recent_context);
  // _cache metadata stripped from readSlice() return
  assert.equal(radiant._cache, undefined);
});

test('p4r-3: cmClient.readSlice throws on unknown slice name', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  await assert.rejects(client.readSlice('not-a-slice'), /Unknown slice/);
});

test('p4r-3: cmClient.checkSpineAvailable probes /health and returns boolean', async () => {
  const routes = { ...happyRoutes, '/health': { status: 200, body: { status: 'ok' } } };
  routeFetch(routes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  assert.equal(typeof client.checkSpineAvailable, 'function');
  const ok = await client.checkSpineAvailable();
  assert.equal(ok, true);
});

test('p4r-3: cmClient.checkSpineAvailable returns false when /health unreachable', async () => {
  routeFetch({});
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  const ok = await client.checkSpineAvailable();
  assert.equal(ok, false);
});

test('p4r-3: cmClient.sliceClients exposes per-slice clients for introspection', async () => {
  routeFetch(happyRoutes);
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: fakeGraph(), spineUrl: 'http://s',
  });
  assert.ok(client.sliceClients);
  for (const name of ['radiant', 'minder', 'hippocampus', 'graph_structural', 'spine_state']) {
    assert.ok(client.sliceClients[name], `sliceClients.${name} present`);
    assert.equal(typeof client.sliceClients[name].read, 'function');
    assert.equal(typeof client.sliceClients[name].invalidate, 'function');
    assert.equal(typeof client.sliceClients[name].peekCache, 'function');
  }
  // spine_state additionally exposes checkAvailable
  assert.equal(typeof client.sliceClients.spine_state.checkAvailable, 'function');
});

test('p4r-3: per-slice cache reduces fetch count on second readWorldState', async () => {
  let radiantStatsFetches = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/stats')) radiantStatsFetches += 1;
    if (url.includes('/context')) return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/memory'))  return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/stats'))   return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/peers/recent'))        return { ok: true, status: 200, json: async () => ({ peers: [] }) };
    if (url.includes('/observations/recent')) return { ok: true, status: 200, json: async () => ({ observations: [] }) };
    if (url.includes('/conversations')) return { ok: true, status: 200, json: async () => ({ conversations: [] }) };
    if (url.includes('/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: { queryConcepts: async () => ({ rows: [] }) },
    spineUrl: 'http://s',
  });
  await client({});
  await client({});
  // Radiant cache hit on second call → /stats not refetched
  assert.equal(radiantStatsFetches, 1, 'radiant cache hit prevents second /stats fetch');
});

test('concurrent execution — all 5 sources start within milliseconds', async () => {
  const startTimes = [];
  globalThis.fetch = async (url) => {
    startTimes.push(Date.now());
    await new Promise(r => setTimeout(r, 20));
    if (url.includes('/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    if (url.includes('/stats')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ blocks: [], peers: [], observations: [], conversations: [] }) };
  };
  const client = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: {
      queryConcepts: async () => {
        startTimes.push(Date.now());
        await new Promise(r => setTimeout(r, 20));
        return { rows: [], count: 0 };
      },
    },
    spineUrl: 'http://s',
  });
  await client({});
  // At least 7 starts (Radiant has 3, Minder has 2, Hippocampus has 1, Graph has 2, Spine has 1 — total 9)
  // All should be within a small window because Promise.allSettled dispatches concurrently
  const span = Math.max(...startTimes) - Math.min(...startTimes);
  assert.ok(span < 20, `expected concurrent dispatch, got span ${span}ms`);
});
