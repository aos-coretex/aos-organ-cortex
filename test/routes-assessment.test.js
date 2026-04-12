import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createAssessmentRouter } from '../server/routes/assessment.js';

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ port: server.address().port, server }));
  });
}

async function httpRequest(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fakeLoop({ skipped = false } = {}) {
  return {
    getStats: () => ({ loop_iteration: 10, last_assessment_duration_ms: 234, current_interval_ms: 30000, stopped: false }),
    trigger: async () => ({ skipped, iteration: 11 }),
  };
}

test('GET /assessment/current returns current gaps', async () => {
  const router = createAssessmentRouter({
    assessmentLoop: fakeLoop(),
    currentGaps: { list: () => [{ gap_id: 'g1', priority: 'high' }] },
    currentAssessmentMeta: { get: () => ({ lastAt: '2026-04-11T12:00:00Z', degraded: [] }) },
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, 'GET', '/assessment/current');
    assert.equal(res.status, 200);
    assert.equal(res.body.loop_iteration, 10);
    assert.equal(res.body.gaps.length, 1);
    assert.equal(res.body.current_interval_ms, 30000);
  } finally {
    server.close();
  }
});

test('POST /assessment/trigger returns 201 when not skipped', async () => {
  const router = createAssessmentRouter({
    assessmentLoop: fakeLoop(),
    currentGaps: { list: () => [] },
    currentAssessmentMeta: { get: () => ({ lastAt: null, degraded: [] }) },
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, 'POST', '/assessment/trigger', { reason: 'test' });
    assert.equal(res.status, 201);
    assert.equal(res.body.triggered, true);
    assert.equal(res.body.skipped, false);
    assert.equal(res.body.iteration, 11);
    assert.equal(res.body.reason, 'test');
  } finally {
    server.close();
  }
});

test('POST /assessment/trigger with skipped result', async () => {
  const router = createAssessmentRouter({
    assessmentLoop: fakeLoop({ skipped: true }),
    currentGaps: { list: () => [] },
    currentAssessmentMeta: { get: () => ({ lastAt: null, degraded: [] }) },
  });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, 'POST', '/assessment/trigger', { reason: 'overlap' });
    assert.equal(res.status, 201);
    assert.equal(res.body.triggered, false);
    assert.equal(res.body.skipped, true);
  } finally {
    server.close();
  }
});
