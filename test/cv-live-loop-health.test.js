/**
 * cv-live-loop-health — /health and /introspect return flat objects with
 * the expected shape per cortex-organ-intervention-instruction.md §4 and
 * cortex-organ-definition.md §3.
 *
 * Verifies bug #9 (no nested {checks}/{extra}), x2p-4 O4 (aligned-vs-blinded
 * surface via last_assessment_degraded), and x2p-7 §6.2 (real llm_available
 * via gapAnalyzer.llm).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';
import { createGoalHistory } from '../lib/goal-history.js';

function fakeLoop(overrides = {}) {
  return {
    getStats: () => ({
      stopped: false,
      current_interval_ms: 60000,
      loop_iteration: 100,
      last_assessment_at: '2026-04-11T12:00:00Z',
      last_assessment_duration_ms: 250,
      total_goals_generated: 12,
      ...overrides,
    }),
  };
}

test('healthCheck returns the expected flat shape per /health spec', async () => {
  const meta = { lastAt: '2026-04-11T12:00:00Z', degraded: [] };
  const llm = { isAvailable: () => true };
  const health = buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoop(),
    currentAssessmentMeta: { get: () => meta },
    llm,
  });
  const out = await health();
  // Bug #9 — no nested wrappers
  assert.equal(out.checks, undefined);
  assert.equal(out.extra, undefined);
  // Spec fields per cortex-organ-definition.md §3 + x2p-7 augmentations
  assert.equal(typeof out.graph_reachable, 'boolean');
  assert.equal(typeof out.arbiter_reachable, 'boolean');
  assert.equal(typeof out.radiant_reachable, 'boolean');
  assert.equal(typeof out.minder_reachable, 'boolean');
  assert.equal(typeof out.hippocampus_reachable, 'boolean');
  assert.equal(typeof out.assessment_active, 'boolean');
  assert.equal(out.llm_available, true);
  assert.equal(typeof out.current_interval_ms, 'number');
  assert.equal(typeof out.loop_iteration, 'number');
  assert.ok(Array.isArray(out.last_assessment_degraded));
  assert.equal(out.last_assessment_at, '2026-04-11T12:00:00Z');
});

test('healthCheck distinguishes blinded-silent from aligned-silent (x2p-4 O4)', async () => {
  // Aligned-silent: empty gaps, no degraded flags → aligned organism
  const alignedHealth = await buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoop(),
    currentAssessmentMeta: { get: () => ({ lastAt: '2026-04-11T12:00:00Z', degraded: [] }) },
  })();
  assert.deepEqual(alignedHealth.last_assessment_degraded, [], 'aligned-silent → empty degraded');

  // Blinded-silent: empty gaps, llm-unavailable degraded flag → can't see
  const blindedHealth = await buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoop(),
    currentAssessmentMeta: { get: () => ({ lastAt: '2026-04-11T12:00:00Z', degraded: ['llm-unavailable'] }) },
  })();
  assert.ok(blindedHealth.last_assessment_degraded.includes('llm-unavailable'), 'blinded-silent → degraded flag visible');
});

test('healthCheck llm_available reflects real isAvailable() (x2p-7 §6.2)', async () => {
  const llmDown = { isAvailable: () => false };
  const out = await buildHealthCheck({
    probes: { graph: true, arbiter: true, radiant: true, minder: true, hippocampus: true },
    assessmentLoop: fakeLoop(),
    currentAssessmentMeta: { get: () => ({ lastAt: null, degraded: [] }) },
    llm: llmDown,
  })();
  assert.equal(out.llm_available, false, 'llm_available must reflect llm.isAvailable()');
});

test('introspectCheck returns the expected flat shape per /introspect spec', async () => {
  const introspect = buildIntrospectCheck({
    cadence: { floorMs: 30000, ceilingMs: 900000, startMs: 300000 },
    assessmentLoop: fakeLoop(),
    goalHistory: createGoalHistory(),
    missionLoader: { peekCache: () => null },
  });
  const out = await introspect();
  assert.equal(out.checks, undefined);
  assert.equal(out.extra, undefined);
  // Spec fields per cortex-organ-definition.md §3 introspect endpoint
  assert.deepEqual(out.cadence, { floorMs: 30000, ceilingMs: 900000, startMs: 300000 });
  assert.equal(out.last_assessment_at, '2026-04-11T12:00:00Z');
  assert.equal(out.last_assessment_duration_ms, 250);
  assert.equal(out.total_goals_generated, 12);
  assert.equal(typeof out.goal_history_size, 'number');
  assert.equal(out.mission_cache_loaded, false);
});
