/**
 * Goal emitter — builds the autonomous-goal OTM envelope from a Gap and a
 * MissionFrame, dispatches it to Thalamus via the Spine client, and records
 * the dispatched goal in the goal-history ring buffer.
 *
 * Cortex is strictly OTM (architectural-conclusions §1). This module never
 * emits APM / PEM / ATM / HOM. The CV test "cortex-otm-only" in x2p-7 and
 * the local test/goal-emitter.test.js::envelope has NO governance message
 * fields both assert this boundary.
 *
 * Spine assigns `message_id` and `timestamp` at POST /messages time (verified
 * 2026-04-11 against AOS-organ-spine-src/server/routes/messages.js:47-50).
 * Cortex submits an envelope without these fields; the validation middleware
 * only requires type/source_organ/target_organ/payload.
 *
 * Thalamus-unreachable handling: `spine.send()` POSTs to Spine /messages,
 * which persists the OTM in Thalamus's mailbox with TTL (OTM defaults to
 * 3600s per MP-2 relay 6). If Spine itself is unreachable, the dispatch
 * fails — we return { dispatched: false, error } and let the assessment
 * loop flag the cycle as degraded. We do NOT retry inside the emitter —
 * the next assessment iteration will produce a fresh goal from the
 * (presumably same) gap.
 */

import { generateUrn } from '@coretex/organ-boot/urn';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} config
 * @param {object} config.spine              - Spine client from organ-boot (provides send())
 * @param {object} config.goalHistory        - goal-history store (add() called on successful dispatch)
 * @param {() => number} [config.getIteration] - returns current loop iteration (from assessment-loop getStats)
 * @returns {(gap, missionFrame) => Promise<{ goal_id, dispatched, error? }>}
 */
export function createGoalEmitter(config) {
  const { spine, goalHistory, getIteration } = config;

  function buildEnvelope(gap, missionFrame) {
    const goalId = generateUrn('goal');
    const payload = {
      event_type: 'autonomous_goal',
      goal_id: goalId,
      gap_ref: gap.gap_id,
      description: gap.description,
      target_state: gap.target_state,
      priority: gap.priority,
      mission_ref: gap.mission_ref,
      evidence_refs: gap.evidence_refs || [],
      severity: gap.severity,
      source_category: gap.source_category,
      assessment_context: {
        msp_version: missionFrame?.msp?.version || null,
        msp_hash:    missionFrame?.msp?.hash    || null,
        bor_version: missionFrame?.bor?.version || null,
        bor_hash:    missionFrame?.bor?.hash    || null,
        assessed_at: gap.analyzed_at || new Date().toISOString(),
        cortex_iteration: getIteration ? getIteration() : 0,
      },
      deadline_context: gap.deadline_context || null,
      suggested_approach: gap.suggested_approach || null,
    };
    return {
      type: 'OTM',
      source_organ: 'Cortex',
      target_organ: 'Thalamus',
      reply_to: 'Cortex',
      payload,
    };
    // message_id and timestamp are assigned by Spine at POST /messages time
  }

  async function emitGoal(gap, missionFrame) {
    if (!gap) {
      return { goal_id: null, dispatched: false, error: 'no-gap-provided' };
    }

    const envelope = buildEnvelope(gap, missionFrame);
    const goalId = envelope.payload.goal_id;

    try {
      const result = await spine.send(envelope);
      // p4r-2 §1d: enrich log event with source_category + description so
      // downstream observers (Lobe, Vigil, p4r-7 replay) get the full goal
      // context without joining against the OTM payload.
      log('cortex_goal_dispatched', {
        goal_id: goalId,
        gap_ref: gap.gap_id,
        priority: gap.priority,
        source_category: gap.source_category || null,
        description: gap.description || null,
        spine_message_id: result?.message_id || null,
        routing: result?.routing || null,
      });

      // Record in history on successful dispatch
      if (goalHistory?.add) {
        goalHistory.add({
          goal_id: goalId,
          description: gap.description,
          priority: gap.priority,
          gap_ref: gap.gap_id,
          mission_ref: gap.mission_ref,
        });
      }

      return { goal_id: goalId, dispatched: true };
    } catch (err) {
      log('cortex_goal_dispatch_failed', {
        goal_id: goalId,
        gap_ref: gap.gap_id,
        error: err.message,
      });
      return { goal_id: goalId, dispatched: false, error: err.message };
    }
  }

  // Exported for unit tests that want to assert envelope shape without dispatching
  emitGoal.buildEnvelope = buildEnvelope;

  return emitGoal;
}
