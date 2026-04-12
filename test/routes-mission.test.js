import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createMissionRouter } from '../server/routes/mission.js';

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

test('GET /mission/state returns MSP + BoR metadata without raw_text', async () => {
  const missionLoader = {
    loadMission: async () => ({
      msp: {
        urn: 'urn:graphheight:msp_version:1.0.0-seed',
        version: '1.0.0-seed',
        hash: 'abc',
        status: 'active',
        activated_at: '2026-04-10T00:00:00Z',
        raw_text: '# MSP\n\n## Purpose\nVery secret mission text',
      },
      bor: {
        version: '1.0.0',
        hash: 'def',
        effective_since: '2026-04-01T00:00:00Z',
        raw_text: '# BoR\n\n## Article 1\nVery sensitive constitutional text',
      },
      loaded_at: '2026-04-11T12:00:00Z',
      cache_expires_at: '2026-04-11T12:10:00Z',
      degraded: [],
    }),
  };
  const router = createMissionRouter({ missionLoader });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/mission/state');
    assert.equal(res.status, 200);
    // MSP metadata present, raw_text NOT leaked
    assert.equal(res.body.msp.version, '1.0.0-seed');
    assert.equal(res.body.msp.raw_text, undefined, 'raw_text must NOT be returned on /mission/state');
    assert.equal(res.body.msp.raw_text_present, true);
    // BoR metadata present, raw_text NOT leaked
    assert.equal(res.body.bor.version, '1.0.0');
    assert.equal(res.body.bor.raw_text, undefined, 'BoR raw_text must NOT be returned');
    assert.equal(res.body.bor.raw_text_present, true);
  } finally {
    server.close();
  }
});

test('GET /mission/state returns null msp/bor and degraded flags when unavailable', async () => {
  const missionLoader = {
    loadMission: async () => ({
      msp: null,
      bor: null,
      loaded_at: '2026-04-11T12:00:00Z',
      cache_expires_at: '2026-04-11T12:10:00Z',
      degraded: ['msp-missing-from-graph', 'bor-unavailable'],
    }),
  };
  const router = createMissionRouter({ missionLoader });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/mission/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.msp, null);
    assert.equal(res.body.bor, null);
    assert.deepEqual(res.body.degraded, ['msp-missing-from-graph', 'bor-unavailable']);
  } finally {
    server.close();
  }
});

test('GET /mission/state raw_text_present=false when msp has empty raw_text (legacy)', async () => {
  const missionLoader = {
    loadMission: async () => ({
      msp: { urn: 'urn:x', version: '1.0.0', hash: '', status: 'active', activated_at: 't', raw_text: '' },
      bor: null,
      loaded_at: 't',
      cache_expires_at: 't',
      degraded: ['msp-raw-text-absent'],
    }),
  };
  const router = createMissionRouter({ missionLoader });
  const { port, server } = await startApp(router);
  try {
    const res = await httpGet(port, '/mission/state');
    assert.equal(res.body.msp.raw_text_present, false);
    assert.ok(res.body.degraded.includes('msp-raw-text-absent'));
  } finally {
    server.close();
  }
});
