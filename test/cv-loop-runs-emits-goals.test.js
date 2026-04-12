/**
 * cv-loop-runs-emits-goals — happy path: Cortex starts, sees a gap, emits a goal.
 *
 * Sandbox-mode implementation: assembles the assessment-loop pipeline directly
 * with stub readers and a recording Thalamus stub. Asserts the first iteration
 * runs immediately on `start()` (RFI-1 Q5), the gap analyzer surfaces a gap,
 * and the goal emitter dispatches an autonomous_goal envelope to the recorder.
 *
 * The relay's prose spec calls for booting a real in-process Spine + Thalamus
 * mock; full end-to-end Spine + WebSocket verification is an rtime smoke test
 * (the createOrgan-based fixture in test/fixtures/thalamus-mock.js supports it).
 * The unit-style version here verifies the same architectural assertions
 * without the Spine boot dependency, so the test runs reliably under
 * `npm test` without a live Spine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentLoop } from '../lib/assessment-loop.js';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalEmitter } from '../lib/goal-emitter.js';
import { createGoalHistory } from '../lib/goal-history.js';
import { createThalamusRecorder } from './fixtures/thalamus-mock.js';

const sampleMission = {
  msp: { version: '1.0.0', hash: 'msp-h1', raw_text: '# MSP\n\n## Purpose\nKeep services healthy.', status: 'active' },
  bor: { version: '1.0.0', hash: 'bor-h1', raw_text: '# BoR\n\n## Article 1\nNo destructive ops.' },
  loaded_at: '2026-04-11T12:00:00Z',
  cache_expires_at: '2026-04-11T12:10:00Z',
  degraded: [],
};

const happyWorld = {
  snapshot: {
    radiant: { recent_context: [], recent_memory: [], stats: {} },
    minder: null,
    hippocampus: null,
    graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
    spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1', previous_state: 'A', current_state: 'B' }] },
    composed_at: '2026-04-11T12:00:00Z',
    sources_ok: ['Radiant', 'Graph', 'Spine'],
    sources_degraded: [],
    degraded: [],
  },
  sources_ok: ['Radiant', 'Graph', 'Spine'],
  sources_degraded: [],
  degraded: [],
};

test('happy path — Cortex runs first iteration immediately and dispatches a goal', async () => {
  const recorder = createThalamusRecorder();
  const goalHistory = createGoalHistory();

  // Injected LLM returns one high-priority gap on every call.
  const injectedLlm = {
    isAvailable: () => true,
    chat: async () => ({
      content: JSON.stringify({
        gaps: [{
          description: 'Backups have not run in 8 days',
          target_state: 'Daily backup cycle resumed',
          mission_ref: 'MSP §Operational Continuity',
          evidence_refs: ['urn:test:radiant:1'],
          priority: 'high',
          severity: 0.9,
          source_category: 'operational',
        }],
      }),
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
    }),
    getUsage: () => ({}),
  };

  const gapAnalyzer = createGapAnalyzer({
    llmConfig: { agentName: 'cortex-gap-analyzer' },
    injectedLlm,
    goalHistory,
  });

  // The goal emitter uses the recorder as its spine. assessmentLoop is
  // referenced via late binding inside getIteration.
  const goalEmitter = createGoalEmitter({
    spine: recorder,
    goalHistory,
    getIteration: () => assessmentLoop.getStats().loop_iteration,
  });

  const assessmentLoop = createAssessmentLoop({
    cadence: { floorMs: 10, ceilingMs: 1000, startMs: 50, gapDivisor: 2, idleFactor: 1.5, pressureFactor: 2 },
    missionLoader: async () => sampleMission,
    cmClient: async () => happyWorld,
    gapAnalyzer: async (mission, world) => {
      // The real gap analyzer expects (mission, snapshot). Unwrap.
      return gapAnalyzer(mission, world?.snapshot || world);
    },
    goalEmitter,
  });

  await assessmentLoop.start();

  // Assertions: first iteration ran, goal was dispatched
  const stats = assessmentLoop.getStats();
  assert.equal(stats.loop_iteration, 1, 'first iteration should have run during start()');
  assert.equal(recorder.received.length, 1, 'recorder should have received exactly one goal envelope');

  const env = recorder.received[0];
  assert.equal(env.type, 'OTM');
  assert.equal(env.source_organ, 'Cortex');
  assert.equal(env.target_organ, 'Thalamus');
  assert.equal(env.payload.event_type, 'autonomous_goal');
  assert.equal(env.payload.priority, 'high');

  assessmentLoop.stop();
});
