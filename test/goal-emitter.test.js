import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalEmitter } from '../lib/goal-emitter.js';
import { createGoalHistory } from '../lib/goal-history.js';

const sampleGap = {
  gap_id: 'urn:llm-ops:cortex-gap:1744380000000-0-abc123',
  priority: 'high',
  description: 'Backups have not run in 8 days',
  target_state: 'Daily backup cycle resumed',
  mission_ref: 'MSP §Operational Continuity',
  evidence_refs: ['urn:llm-ops:radiant:block:42'],
  severity: 0.85,
  source_category: 'operational',
  analyzed_at: '2026-04-11T12:00:00Z',
};

const sampleMission = {
  msp: { version: '1.0.0-seed', hash: 'msp-hash', raw_text: '...' },
  bor: { version: '1.0.0', hash: 'bor-hash', raw_text: '...' },
};

function fakeSpine({ sendResult, throwErr = false } = {}) {
  const calls = [];
  return {
    calls,
    send: async (envelope) => {
      calls.push(envelope);
      if (throwErr) throw new Error('spine-down');
      return sendResult || { message_id: 'urn:llm-ops:otm:spine-minted-123', timestamp: '2026-04-11T12:00:00Z', status: 'accepted', routing: 'directed', target_organ: 'Thalamus' };
    },
  };
}

test('emitGoal builds envelope with correct OTM shape', async () => {
  const spine = fakeSpine();
  const history = createGoalHistory();
  const emitter = createGoalEmitter({ spine, goalHistory: history, getIteration: () => 42 });
  const result = await emitter(sampleGap, sampleMission);
  assert.equal(result.dispatched, true);
  assert.equal(spine.calls.length, 1);
  const env = spine.calls[0];
  assert.equal(env.type, 'OTM');
  assert.equal(env.source_organ, 'Cortex');
  assert.equal(env.target_organ, 'Thalamus');
  assert.equal(env.reply_to, 'Cortex');
  assert.equal(env.message_id, undefined, 'Cortex should NOT pre-mint message_id — Spine assigns it');
  assert.equal(env.timestamp, undefined, 'Cortex should NOT pre-set timestamp — Spine assigns it');
});

test('envelope payload matches autonomous_goal schema', async () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 7 });
  await emitter(sampleGap, sampleMission);
  const p = spine.calls[0].payload;
  assert.equal(p.event_type, 'autonomous_goal');
  assert.match(p.goal_id, /^urn:llm-ops:goal:/);
  assert.equal(p.gap_ref, sampleGap.gap_id);
  assert.equal(p.description, sampleGap.description);
  assert.equal(p.target_state, sampleGap.target_state);
  assert.equal(p.priority, 'high');
  assert.equal(p.mission_ref, sampleGap.mission_ref);
  assert.deepEqual(p.evidence_refs, sampleGap.evidence_refs);
  assert.equal(p.severity, 0.85);
  assert.equal(p.source_category, 'operational');
  assert.equal(p.deadline_context, null);
  assert.equal(p.suggested_approach, null);
});

test('assessment_context carries MSP + BoR version/hash and iteration', async () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 42 });
  await emitter(sampleGap, sampleMission);
  const ctx = spine.calls[0].payload.assessment_context;
  assert.equal(ctx.msp_version, '1.0.0-seed');
  assert.equal(ctx.msp_hash, 'msp-hash');
  assert.equal(ctx.bor_version, '1.0.0');
  assert.equal(ctx.bor_hash, 'bor-hash');
  assert.equal(ctx.assessed_at, '2026-04-11T12:00:00Z');
  assert.equal(ctx.cortex_iteration, 42);
});

test('assessment_context handles null mission frame gracefully', async () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 1 });
  await emitter(sampleGap, { msp: null, bor: null });
  const ctx = spine.calls[0].payload.assessment_context;
  assert.equal(ctx.msp_version, null);
  assert.equal(ctx.msp_hash, null);
  assert.equal(ctx.bor_version, null);
  assert.equal(ctx.bor_hash, null);
});

test('successful dispatch records goal in history', async () => {
  const spine = fakeSpine();
  const history = createGoalHistory();
  const emitter = createGoalEmitter({ spine, goalHistory: history, getIteration: () => 1 });
  await emitter(sampleGap, sampleMission);
  const list = history.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].description, sampleGap.description);
  assert.equal(list[0].priority, 'high');
  assert.equal(list[0].gap_ref, sampleGap.gap_id);
});

test('failed dispatch does NOT record in history', async () => {
  const spine = fakeSpine({ throwErr: true });
  const history = createGoalHistory();
  const emitter = createGoalEmitter({ spine, goalHistory: history, getIteration: () => 1 });
  const result = await emitter(sampleGap, sampleMission);
  assert.equal(result.dispatched, false);
  assert.equal(result.error, 'spine-down');
  assert.equal(history.size(), 0);
});

test('emitGoal with null gap returns no-gap-provided error', async () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 1 });
  const result = await emitter(null, sampleMission);
  assert.equal(result.dispatched, false);
  assert.equal(result.error, 'no-gap-provided');
  assert.equal(spine.calls.length, 0);
});

test('envelope has NO governance message fields (OTM-only discipline)', async () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 1 });
  await emitter(sampleGap, sampleMission);
  const env = spine.calls[0];
  // Cortex is strictly OTM — architectural-conclusions §1
  assert.notEqual(env.type, 'APM');
  assert.notEqual(env.type, 'PEM');
  assert.notEqual(env.type, 'ATM');
  assert.notEqual(env.type, 'HOM');
  // No authorization-token fields
  assert.equal(env.payload.token, undefined);
  assert.equal(env.payload.token_urn, undefined);
  assert.equal(env.payload.action_proposal, undefined);
  assert.equal(env.payload.ruling, undefined);
});

test('buildEnvelope is exported for direct shape assertions', () => {
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 1 });
  assert.equal(typeof emitter.buildEnvelope, 'function');
  const env = emitter.buildEnvelope(sampleGap, sampleMission);
  assert.equal(env.type, 'OTM');
  assert.equal(env.target_organ, 'Thalamus');
});

test('gap with suggested_approach and deadline_context propagates them', async () => {
  const richGap = {
    ...sampleGap,
    suggested_approach: 'Invoke skl-LLM-Ops-safevault backup cycle',
    deadline_context: 'Within 24 hours per operational continuity target',
  };
  const spine = fakeSpine();
  const emitter = createGoalEmitter({ spine, goalHistory: createGoalHistory(), getIteration: () => 1 });
  await emitter(richGap, sampleMission);
  const p = spine.calls[0].payload;
  assert.equal(p.suggested_approach, 'Invoke skl-LLM-Ops-safevault backup cycle');
  assert.equal(p.deadline_context, 'Within 24 hours per operational continuity target');
});
