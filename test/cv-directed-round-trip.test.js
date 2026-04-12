/**
 * cv-directed-round-trip — directed OTM health_check from a mock external organ
 * receives a health_response with current loop stats. Verifies the directed
 * handler dispatch path end-to-end (without requiring a live Spine WebSocket).
 *
 * Sandbox-mode adaptation: invokes createDirectedHandler directly with a
 * synthetic envelope. The full WebSocket round-trip is verified by the rtime
 * smoke test using the createOrgan-based Thalamus mock fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectedHandler } from '../handlers/spine-commands.js';
import { createGoalHistory } from '../lib/goal-history.js';

function fakeLoop({ stopped = false, iteration = 100 } = {}) {
  return {
    trigger: async () => ({ skipped: false, iteration: iteration + 1 }),
    getStats: () => ({ stopped, loop_iteration: iteration, current_interval_ms: 60000 }),
    onPressure: () => {},
  };
}

test('directed health_check returns health_response with loop stats', async () => {
  const handler = createDirectedHandler({
    assessmentLoop: fakeLoop({ iteration: 100 }),
    goalHistory: createGoalHistory(),
  });

  const inbound = {
    type: 'OTM',
    source_organ: 'Axon',
    target_organ: 'Cortex',
    message_id: 'urn:llm-ops:otm:axon-test-1',
    reply_to: 'Axon',
    payload: { event_type: 'health_check' },
  };

  const reply = await handler(inbound);

  assert.notEqual(reply, null, 'health_check must return a reply payload');
  assert.equal(reply.event_type, 'health_response');
  assert.equal(reply.status, 'ok');
  assert.equal(reply.loop_iteration, 100);
  assert.equal(reply.current_interval_ms, 60000);
});

test('directed assessment_request triggers the loop and returns assessment_triggered', async () => {
  const handler = createDirectedHandler({
    assessmentLoop: fakeLoop({ iteration: 50 }),
    goalHistory: createGoalHistory(),
  });

  const reply = await handler({
    type: 'OTM',
    source_organ: 'Axon',
    target_organ: 'Cortex',
    payload: { event_type: 'assessment_request', reason: 'operator-urgency' },
  });

  assert.equal(reply.event_type, 'assessment_triggered');
  assert.equal(reply.triggered, true);
  assert.equal(reply.skipped, false);
  assert.equal(reply.iteration, 51);
});

test('non-OTM directed message is rejected (OTM-only inbound discipline)', async () => {
  const handler = createDirectedHandler({
    assessmentLoop: fakeLoop(),
    goalHistory: createGoalHistory(),
  });
  // APM should be rejected — Cortex is not a governance participant
  const reply = await handler({
    type: 'APM',
    source_organ: 'Nomos',
    target_organ: 'Cortex',
    payload: { event_type: 'authorization_request' },
  });
  assert.equal(reply.error, 'non-otm-directed-rejected');
  assert.equal(reply.envelope_type, 'APM');
});
