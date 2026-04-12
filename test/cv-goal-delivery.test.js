/**
 * cv-goal-delivery — THE CONTRACT LOCK.
 *
 * This test is the source of truth for the Cortex → Thalamus envelope contract.
 * MP-13's real Thalamus must consume exactly the envelope shape this test
 * captures from the recorder. To find the contract from any future session,
 * grep for "goal envelope contract" — this assertion block is the canonical
 * reference.
 *
 * Procedure (sandbox-mode adaptation):
 *   1. Construct a known Gap with known fields
 *   2. Construct a MissionFrame with known MSP/BoR metadata
 *   3. Call createGoalEmitter with a Thalamus recorder as `spine`
 *   4. Invoke emitGoal directly
 *   5. Assert the recorded envelope matches the canonical schema verbatim
 *
 * Full end-to-end Spine WebSocket routing is verified by the rtime smoke test
 * (deferred per the relay's RFI-1 Q4 Path B). The unit-style version here
 * locks the same shape contract — anything MP-13 must honor is asserted here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalEmitter } from '../lib/goal-emitter.js';
import { createGoalHistory } from '../lib/goal-history.js';
import { createThalamusRecorder } from './fixtures/thalamus-mock.js';

const KNOWN_GAP = {
  gap_id: 'urn:llm-ops:cortex-gap:1744380000000-0-known1',
  priority: 'high',
  description: 'known test gap — backups have not run in 8 days',
  target_state: 'Daily backup cycle resumed',
  mission_ref: 'MSP §Operational Continuity',
  evidence_refs: ['urn:llm-ops:radiant:block:42', 'urn:llm-ops:spine:transition:99'],
  severity: 0.85,
  source_category: 'operational',
  analyzed_at: '2026-04-11T12:00:00Z',
};

const KNOWN_MISSION = {
  msp: { version: '1.0.0-seed', hash: 'msp-known-hash', raw_text: '# MSP' },
  bor: { version: '1.0.0', hash: 'bor-known-hash', raw_text: '# BoR' },
  loaded_at: '2026-04-11T12:00:00Z',
  cache_expires_at: '2026-04-11T12:10:00Z',
  degraded: [],
};

test('goal envelope contract — Cortex → Thalamus canonical shape (BINDING for MP-13)', async () => {
  const recorder = createThalamusRecorder();
  const goalHistory = createGoalHistory();
  const emitter = createGoalEmitter({
    spine: recorder,
    goalHistory,
    getIteration: () => 7, // simulate iteration 7
  });

  const result = await emitter(KNOWN_GAP, KNOWN_MISSION);
  assert.equal(result.dispatched, true);
  assert.equal(recorder.received.length, 1);

  const env = recorder.received[0];

  // === ENVELOPE-LEVEL ASSERTIONS (Spine-mediated fields) ===
  assert.equal(env.type, 'OTM', 'type === OTM');
  assert.equal(env.source_organ, 'Cortex', 'source_organ === Cortex');
  assert.equal(env.target_organ, 'Thalamus', 'target_organ === Thalamus');
  assert.equal(env.reply_to, 'Cortex', 'reply_to === Cortex (for Thalamus → Cortex lifecycle ack OTMs)');
  assert.equal(env.message_id, undefined, 'Cortex MUST NOT pre-mint message_id — Spine assigns it server-side');
  assert.equal(env.timestamp, undefined, 'Cortex MUST NOT pre-set timestamp — Spine assigns it server-side');

  // === PAYLOAD-LEVEL ASSERTIONS (autonomous_goal schema) ===
  const p = env.payload;
  assert.equal(p.event_type, 'autonomous_goal');
  assert.match(p.goal_id, /^urn:llm-ops:goal:/, 'goal_id is a goal URN');
  assert.equal(p.gap_ref, KNOWN_GAP.gap_id);
  assert.equal(p.description, KNOWN_GAP.description);
  assert.equal(p.target_state, KNOWN_GAP.target_state);
  assert.equal(p.priority, 'high');
  assert.equal(p.mission_ref, KNOWN_GAP.mission_ref);
  assert.deepEqual(p.evidence_refs, KNOWN_GAP.evidence_refs);
  assert.equal(p.severity, 0.85);
  assert.equal(p.source_category, 'operational');

  // === ASSESSMENT_CONTEXT NESTED OBJECT ===
  const ctx = p.assessment_context;
  assert.equal(ctx.msp_version, '1.0.0-seed');
  assert.equal(ctx.msp_hash, 'msp-known-hash');
  assert.equal(ctx.bor_version, '1.0.0');
  assert.equal(ctx.bor_hash, 'bor-known-hash');
  assert.equal(ctx.assessed_at, '2026-04-11T12:00:00Z');
  assert.equal(ctx.cortex_iteration, 7);

  // === OPTIONAL FIELDS ===
  assert.equal(p.deadline_context, null, 'deadline_context is null when gap does not surface a deadline');
  assert.equal(p.suggested_approach, null, 'suggested_approach is null by default — HOW is Thalamus job');

  // === OTM-ONLY DISCIPLINE — no governance fields ===
  // Cortex is strictly OTM (architectural-conclusions §1). The envelope must
  // not contain any field that belongs to APM/PEM/ATM/HOM. This block is the
  // mechanical guard against Cortex slipping into governance message types.
  assert.equal(env.payload.token, undefined, 'no authorization token in OTM payload');
  assert.equal(env.payload.token_urn, undefined, 'no token URN in OTM payload');
  assert.equal(env.payload.action_proposal, undefined, 'no action proposal in OTM payload');
  assert.equal(env.payload.ruling, undefined, 'no ruling in OTM payload');
  assert.notEqual(env.type, 'APM');
  assert.notEqual(env.type, 'PEM');
  assert.notEqual(env.type, 'ATM');
  assert.notEqual(env.type, 'HOM');

  // === GOAL HISTORY SIDE-EFFECT ===
  // Successful dispatch must add the goal to the in-memory ring buffer so the
  // next assessment cycle's gap analyzer sees recent_goals as context.
  assert.equal(goalHistory.size(), 1);
  const recorded = goalHistory.list()[0];
  assert.equal(recorded.gap_ref, KNOWN_GAP.gap_id);
  assert.equal(recorded.priority, 'high');
});

test('goal envelope contract — null mission frame still produces a valid envelope', async () => {
  // Edge case: if missionLoader returned a degraded frame, the goal envelope
  // must still be valid (assessment_context fields just become null). MP-13
  // must accept this — it is a real production state when MSP/BoR are
  // unreadable but a gap was still surfaced from world state alone.
  const recorder = createThalamusRecorder();
  const emitter = createGoalEmitter({
    spine: recorder,
    goalHistory: createGoalHistory(),
    getIteration: () => 1,
  });

  await emitter(KNOWN_GAP, { msp: null, bor: null });
  const env = recorder.received[0];
  const ctx = env.payload.assessment_context;
  assert.equal(ctx.msp_version, null);
  assert.equal(ctx.msp_hash, null);
  assert.equal(ctx.bor_version, null);
  assert.equal(ctx.bor_hash, null);
  assert.equal(ctx.cortex_iteration, 1);
  // Required fields still present
  assert.equal(env.payload.event_type, 'autonomous_goal');
  assert.match(env.payload.goal_id, /^urn:llm-ops:goal:/);
});
