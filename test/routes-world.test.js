import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createWorldRouter } from '../server/routes/world.js';

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ port: server.address().port, server }));
  });
}

async function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sampleSnapshot() {
  return {
    radiant: { recent_context: [{ id: 1 }, { id: 2 }], recent_memory: [{ id: 3 }], stats: {} },
    minder: { active_peers: [], recent_observations: [{ peer_id: 'p1' }, { peer_id: 'p2' }] },
    hippocampus: { recent_conversations: [{ urn: 'urn:h:1' }] },
    graph_structural: { recent_entities: [{ urn: 'urn:e:1' }, { urn: 'urn:e:2' }, { urn: 'urn:e:3' }], recent_concept_counts_by_type: {} },
    spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1' }] },
    sources_ok: ['Radiant', 'Minder', 'Hippocampus', 'Graph', 'Spine'],
    sources_degraded: [],
    composed_at: '2026-04-11T12:00:00Z',
    degraded: [],
  };
}

test('GET /world/state returns summary of cached snapshot', async () => {
  const snap = sampleSnapshot();
  const router = createWorldRouter({
    cmClient: async () => ({ snapshot: snap }),
    currentWorldState: { get: () => snap },
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/world/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.radiant_blocks, 3);  // 2 context + 1 memory
    assert.equal(res.body.summary.minder_observations, 2);
    assert.equal(res.body.summary.hippocampus_conversations, 1);
    assert.equal(res.body.summary.graph_entities, 3);
    assert.equal(res.body.summary.recent_transitions, 1);
    assert.equal(res.body.composed_at, '2026-04-11T12:00:00Z');
  } finally {
    server.close();
  }
});

test('GET /world/state returns 204 when no snapshot cached yet', async () => {
  const router = createWorldRouter({
    cmClient: async () => ({ snapshot: null }),
    currentWorldState: { get: () => null },
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/world/state');
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  } finally {
    server.close();
  }
});

test('GET /world/state?fresh=true bypasses cache and calls cmClient', async () => {
  const snap = sampleSnapshot();
  let cmCalls = 0;
  const router = createWorldRouter({
    cmClient: async () => {
      cmCalls += 1;
      return { snapshot: snap };
    },
    currentWorldState: { get: () => null },  // cache empty
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/world/state?fresh=true');
    assert.equal(res.status, 200);
    assert.equal(cmCalls, 1, 'cmClient should have been invoked');
    assert.equal(res.body.summary.recent_transitions, 1);
  } finally {
    server.close();
  }
});
