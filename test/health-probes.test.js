import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';

function fakeLoopStats(overrides = {}) {
  return {
    getStats: () => ({
      stopped: false,
      current_interval_ms: 60000,
      loop_iteration: 42,
      last_assessment_at: '2026-04-11T12:00:00Z',
      last_assessment_duration_ms: 250,
      total_goals_generated: 7,
      ...overrides,
    }),
  };
}

// --- healthCheck ---

test('healthCheck returns a FLAT object (bug #9 — no extra/checks wrapper)', async () => {
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: false, hippocampus: true },
    assessmentLoop: fakeLoopStats(),
    currentAssessmentMeta: { get: () => ({ lastAt: '2026-04-11T12:00:00Z', degraded: [] }) },
  });
  const out = await health();
  assert.equal(typeof out, 'object');
  assert.equal(out.extra, undefined, 'bug #9: must not wrap in { extra }');
  assert.equal(out.checks, undefined, 'bug #9: must not wrap in { checks }');
  // Probes all present
  assert.equal(out.graph_reachable, true);
  assert.equal(out.arbiter_reachable, true);
  assert.equal(out.radiant_reachable, true);
  assert.equal(out.minder_reachable, false);
  assert.equal(out.hippocampus_reachable, true);
});

test('healthCheck surfaces last_assessment_degraded and last_assessment_at (x2p-4 O4)', async () => {
  const meta = { lastAt: '2026-04-11T12:00:00Z', degraded: ['llm-unavailable', 'world:minder-degraded'] };
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoopStats(),
    currentAssessmentMeta: { get: () => meta },
  });
  const out = await health();
  // x2p-4 O4: blinded-silent must be distinguishable from aligned-silent
  assert.ok(Array.isArray(out.last_assessment_degraded));
  assert.equal(out.last_assessment_degraded.length, 2);
  assert.ok(out.last_assessment_degraded.includes('llm-unavailable'));
  assert.ok(out.last_assessment_degraded.includes('world:minder-degraded'));
  assert.equal(out.last_assessment_at, '2026-04-11T12:00:00Z');
});

test('healthCheck reports empty degraded array when aligned-silent', async () => {
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoopStats(),
    currentAssessmentMeta: { get: () => ({ lastAt: '2026-04-11T12:00:00Z', degraded: [] }) },
  });
  const out = await health();
  assert.deepEqual(out.last_assessment_degraded, []);
  assert.equal(out.last_assessment_at, '2026-04-11T12:00:00Z');
});

test('healthCheck assessment_active flips with stopped flag', async () => {
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoopStats({ stopped: true }),
    currentAssessmentMeta: { get: () => ({ lastAt: null, degraded: [] }) },
  });
  const out = await health();
  assert.equal(out.assessment_active, false);
});

test('healthCheck delegates llm_available to injected llm client', async () => {
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoopStats(),
    currentAssessmentMeta: { get: () => ({ lastAt: null, degraded: [] }) },
    llm: { isAvailable: () => false },
  });
  const out = await health();
  assert.equal(out.llm_available, false);
});

// --- introspectCheck ---

test('introspectCheck returns a FLAT object (bug #9)', async () => {
  const introspect = buildIntrospectCheck({
    cadence: { floorMs: 30000, ceilingMs: 900000, startMs: 300000 },
    assessmentLoop: fakeLoopStats(),
    goalHistory: { size: () => 3 },
    missionLoader: { peekCache: () => ({ msp: {}, bor: {} }) },
  });
  const out = await introspect();
  assert.equal(out.extra, undefined, 'bug #9: must not wrap in { extra }');
  assert.equal(out.checks, undefined, 'bug #9: must not wrap in { checks }');
  assert.equal(out.total_goals_generated, 7);
  assert.equal(out.goal_history_size, 3);
  assert.equal(out.mission_cache_loaded, true);
  assert.deepEqual(out.cadence, { floorMs: 30000, ceilingMs: 900000, startMs: 300000 });
});

test('introspectCheck mission_cache_loaded false when cache empty', async () => {
  const introspect = buildIntrospectCheck({
    cadence: {},
    assessmentLoop: fakeLoopStats(),
    goalHistory: { size: () => 0 },
    missionLoader: { peekCache: () => null },
  });
  const out = await introspect();
  assert.equal(out.mission_cache_loaded, false);
});
