import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalHistory } from '../lib/goal-history.js';

test('add + list roundtrips goals', () => {
  const h = createGoalHistory({ limit: 3 });
  h.add({ goal_id: 'g1', description: 'x', priority: 'high' });
  h.add({ goal_id: 'g2', description: 'y', priority: 'low' });
  const list = h.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].goal_id, 'g1');
  assert.equal(list[1].goal_id, 'g2');
});

test('ring buffer evicts oldest past limit', () => {
  const h = createGoalHistory({ limit: 2 });
  h.add({ goal_id: 'g1', description: 'x', priority: 'high' });
  h.add({ goal_id: 'g2', description: 'y', priority: 'low' });
  h.add({ goal_id: 'g3', description: 'z', priority: 'medium' });
  const list = h.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].goal_id, 'g2');
  assert.equal(list[1].goal_id, 'g3');
});

test('list returns copy (caller cannot mutate internal state)', () => {
  const h = createGoalHistory();
  h.add({ goal_id: 'g1', description: 'x', priority: 'high' });
  const list = h.list();
  list.push({ goal_id: 'hacker' });
  assert.equal(h.size(), 1);
});

test('clear empties the buffer', () => {
  const h = createGoalHistory();
  h.add({ goal_id: 'g1', description: 'x', priority: 'high' });
  h.clear();
  assert.equal(h.size(), 0);
});

test('dispatched_at populated on add', () => {
  const h = createGoalHistory();
  h.add({ goal_id: 'g1', description: 'x', priority: 'high' });
  assert.match(h.list()[0].dispatched_at, /^\d{4}-\d{2}-\d{2}T/);
});
