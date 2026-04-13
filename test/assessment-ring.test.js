import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentRing } from '../lib/assessment-ring.js';

// --- Core ring behaviour ---

test('empty ring returns zero ratio', () => {
  const ring = createAssessmentRing();
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 0);
  assert.equal(snap.degraded_iterations, 0);
  assert.equal(snap.ratio, 0);
  assert.deepEqual(snap.flag_breakdown, {});
  assert.equal(snap.oldest_at, null);
  assert.equal(snap.newest_at, null);
});

test('push increments size', () => {
  const ring = createAssessmentRing();
  assert.equal(ring.size(), 0);
  ring.push({ at: new Date().toISOString(), degraded: [] });
  assert.equal(ring.size(), 1);
  ring.push({ at: new Date().toISOString(), degraded: ['llm-unavailable'] });
  assert.equal(ring.size(), 2);
});

test('healthy iterations produce zero ratio', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    ring.push({ at: new Date(now - (10 - i) * 1000).toISOString(), degraded: [] });
  }
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 10);
  assert.equal(snap.degraded_iterations, 0);
  assert.equal(snap.ratio, 0);
});

test('all-degraded iterations produce ratio of 1', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    ring.push({ at: new Date(now - (5 - i) * 1000).toISOString(), degraded: ['llm-unavailable'] });
  }
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 5);
  assert.equal(snap.degraded_iterations, 5);
  assert.equal(snap.ratio, 1);
});

test('mixed iterations produce correct ratio', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  // 3 healthy, 2 degraded = 2/5 = 0.4
  ring.push({ at: new Date(now - 5000).toISOString(), degraded: [] });
  ring.push({ at: new Date(now - 4000).toISOString(), degraded: ['llm-unavailable'] });
  ring.push({ at: new Date(now - 3000).toISOString(), degraded: [] });
  ring.push({ at: new Date(now - 2000).toISOString(), degraded: ['spine-state-unavailable-halt'] });
  ring.push({ at: new Date(now - 1000).toISOString(), degraded: [] });
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 5);
  assert.equal(snap.degraded_iterations, 2);
  assert.equal(snap.ratio, 0.4);
});

// --- Flag breakdown ---

test('flag_breakdown counts per-flag occurrences', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  ring.push({ at: new Date(now - 3000).toISOString(), degraded: ['llm-unavailable', 'world:minder-degraded'] });
  ring.push({ at: new Date(now - 2000).toISOString(), degraded: ['llm-unavailable'] });
  ring.push({ at: new Date(now - 1000).toISOString(), degraded: [] });
  const snap = ring.snapshot(3600000);
  assert.equal(snap.flag_breakdown['llm-unavailable'], 2);
  assert.equal(snap.flag_breakdown['world:minder-degraded'], 1);
});

// --- Time windowing ---

test('snapshot excludes entries outside the window', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  // Entry 2 hours ago — outside 1h window
  ring.push({ at: new Date(now - 7200000).toISOString(), degraded: ['llm-unavailable'] });
  // Entry 30 minutes ago — inside 1h window
  ring.push({ at: new Date(now - 1800000).toISOString(), degraded: [] });
  // Entry 5 minutes ago — inside 1h window
  ring.push({ at: new Date(now - 300000).toISOString(), degraded: ['spine-state-unavailable-halt'] });

  const snap1h = ring.snapshot(3600000);
  assert.equal(snap1h.total_iterations, 2);
  assert.equal(snap1h.degraded_iterations, 1);

  // 24h window includes everything
  const snap24h = ring.snapshot(86400000);
  assert.equal(snap24h.total_iterations, 3);
  assert.equal(snap24h.degraded_iterations, 2);
});

test('oldest_at and newest_at reflect window boundaries', () => {
  const ring = createAssessmentRing();
  const now = Date.now();
  const t1 = new Date(now - 500000).toISOString();
  const t2 = new Date(now - 300000).toISOString();
  const t3 = new Date(now - 100000).toISOString();
  ring.push({ at: t1, degraded: [] });
  ring.push({ at: t2, degraded: [] });
  ring.push({ at: t3, degraded: [] });
  const snap = ring.snapshot(3600000);
  assert.equal(snap.oldest_at, t1);
  assert.equal(snap.newest_at, t3);
});

// --- Capacity / ring overflow ---

test('ring wraps at capacity', () => {
  const ring = createAssessmentRing({ capacity: 3 });
  const now = Date.now();
  ring.push({ at: new Date(now - 4000).toISOString(), degraded: ['a'] });
  ring.push({ at: new Date(now - 3000).toISOString(), degraded: ['b'] });
  ring.push({ at: new Date(now - 2000).toISOString(), degraded: ['c'] });
  assert.equal(ring.size(), 3);
  // Push a 4th — overwrites oldest
  ring.push({ at: new Date(now - 1000).toISOString(), degraded: [] });
  assert.equal(ring.size(), 3);

  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 3);
  // 'a' was evicted, remaining: b(degraded), c(degraded), [](healthy) = 2/3
  assert.equal(snap.degraded_iterations, 2);
});

test('entries() returns chronological order after wrap', () => {
  const ring = createAssessmentRing({ capacity: 3 });
  const now = Date.now();
  const t1 = new Date(now - 4000).toISOString();
  const t2 = new Date(now - 3000).toISOString();
  const t3 = new Date(now - 2000).toISOString();
  const t4 = new Date(now - 1000).toISOString();
  ring.push({ at: t1, degraded: [] });
  ring.push({ at: t2, degraded: [] });
  ring.push({ at: t3, degraded: [] });
  ring.push({ at: t4, degraded: [] }); // wraps, evicts t1
  const all = ring.entries();
  assert.equal(all.length, 3);
  assert.equal(all[0].at, t2);
  assert.equal(all[1].at, t3);
  assert.equal(all[2].at, t4);
});

// --- Edge cases ---

test('push with missing degraded defaults to empty array', () => {
  const ring = createAssessmentRing();
  ring.push({ at: new Date().toISOString(), degraded: undefined });
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 1);
  assert.equal(snap.degraded_iterations, 0);
});

test('push with missing at defaults to now', () => {
  const ring = createAssessmentRing();
  ring.push({ degraded: ['test-flag'] });
  const snap = ring.snapshot(3600000);
  assert.equal(snap.total_iterations, 1);
  assert.equal(snap.degraded_iterations, 1);
  assert.ok(snap.newest_at !== null);
});

test('default capacity is 1440', () => {
  const ring = createAssessmentRing();
  // Push 1441 entries — only last 1440 survive
  const now = Date.now();
  for (let i = 0; i < 1441; i++) {
    ring.push({ at: new Date(now - (1441 - i) * 100).toISOString(), degraded: [] });
  }
  assert.equal(ring.size(), 1440);
});
