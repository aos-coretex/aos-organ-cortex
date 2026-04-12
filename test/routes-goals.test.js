import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createGoalsRouter } from '../server/routes/goals.js';
import { createGoalHistory } from '../lib/goal-history.js';

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ port: server.address().port, server }));
  });
}

async function httpRequest(port, path) {
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

test('GET /goals/active returns empty list when history is empty', async () => {
  const router = createGoalsRouter({ goalHistory: createGoalHistory() });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, '/goals/active');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.goals, []);
    assert.equal(res.body.count, 0);
  } finally {
    server.close();
  }
});

test('GET /goals/active returns populated list, most recent first', async () => {
  const history = createGoalHistory();
  history.add({ goal_id: 'g1', description: 'first', priority: 'high' });
  history.add({ goal_id: 'g2', description: 'second', priority: 'medium' });
  history.add({ goal_id: 'g3', description: 'third', priority: 'low' });
  const router = createGoalsRouter({ goalHistory: history });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, '/goals/active');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 3);
    assert.equal(res.body.goals[0].goal_id, 'g3', 'most recent first');
    assert.equal(res.body.goals[2].goal_id, 'g1', 'oldest last');
  } finally {
    server.close();
  }
});

test('GET /goals/active respects limit query param', async () => {
  const history = createGoalHistory();
  for (let i = 1; i <= 5; i++) history.add({ goal_id: `g${i}`, description: `goal ${i}`, priority: 'high' });
  const router = createGoalsRouter({ goalHistory: history });
  const { port, server } = await startApp(router);
  try {
    const res = await httpRequest(port, '/goals/active?limit=2');
    assert.equal(res.status, 200);
    assert.equal(res.body.goals.length, 2);
    assert.equal(res.body.count, 5, 'count reflects total history, not filtered slice');
  } finally {
    server.close();
  }
});
