import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectedHandler } from '../handlers/spine-commands.js';
import { createGoalHistory } from '../lib/goal-history.js';

function fakeLoop({ triggerResult = { iteration: 5, skipped: false } } = {}) {
  return {
    trigger: async () => triggerResult,
    getStats: () => ({ stopped: false, loop_iteration: 5, current_interval_ms: 30000 }),
    onPressure: () => {},
  };
}

test('assessment_request triggers the loop and returns assessment_triggered', async () => {
  const loop = fakeLoop();
  const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
  const result = await handler({
    type: 'OTM',
    source_organ: 'Axon',
    target_organ: 'Cortex',
    payload: { event_type: 'assessment_request', reason: 'test' },
    message_id: 'urn:test:1',
  });
  assert.equal(result.event_type, 'assessment_triggered');
  assert.equal(result.triggered, true);
  assert.equal(result.iteration, 5);
});

test('assessment_request with skipped result returns triggered=false', async () => {
  const loop = fakeLoop({ triggerResult: { skipped: true, iteration: null } });
  const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
  const result = await handler({
    type: 'OTM',
    source_organ: 'Axon',
    payload: { event_type: 'assessment_request' },
  });
  assert.equal(result.triggered, false);
  assert.equal(result.skipped, true);
});

test('health_check returns stats when loop is running', async () => {
  const loop = fakeLoop();
  const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
  const result = await handler({
    type: 'OTM',
    payload: { event_type: 'health_check' },
    message_id: 'urn:test:2',
  });
  assert.equal(result.event_type, 'health_response');
  assert.equal(result.status, 'ok');
  assert.equal(result.loop_iteration, 5);
});

test('health_check reports down when loop stopped', async () => {
  const loop = {
    ...fakeLoop(),
    getStats: () => ({ stopped: true, loop_iteration: 0, current_interval_ms: 30000 }),
  };
  const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
  const result = await handler({ type: 'OTM', payload: { event_type: 'health_check' } });
  assert.equal(result.status, 'down');
});

// Thalamus lifecycle acks — full set per x2p-5 O2. All four event_types
// must return null (observability-only) so replies don't rot in Cortex mailbox.
for (const eventType of ['job_record_created', 'job_dispatched', 'job_completed', 'job_failed']) {
  test(`${eventType} from Thalamus returns null (observability)`, async () => {
    const loop = fakeLoop();
    const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
    const result = await handler({
      type: 'OTM',
      source_organ: 'Thalamus',
      target_organ: 'Cortex',
      payload: { event_type: eventType, goal_id: 'urn:llm-ops:goal:1' },
      message_id: `urn:test:lifecycle-${eventType}`,
    });
    assert.equal(result, null);
  });
}

test('unknown OTM event_type returns null and is silently ignored', async () => {
  const loop = fakeLoop();
  const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
  const result = await handler({
    type: 'OTM',
    payload: { event_type: 'weird_unknown' },
    message_id: 'urn:test:4',
  });
  assert.equal(result, null);
});

// OTM-only discipline (x2p-5 O2): non-OTM directed messages must be rejected.
// Cortex is not a governance participant and must never accept APM/PEM/ATM/HOM.
for (const badType of ['APM', 'PEM', 'ATM', 'HOM']) {
  test(`non-OTM envelope type '${badType}' is rejected with distinct error`, async () => {
    const loop = fakeLoop();
    const handler = createDirectedHandler({ assessmentLoop: loop, goalHistory: createGoalHistory() });
    const result = await handler({
      type: badType,
      source_organ: 'Thalamus',
      target_organ: 'Cortex',
      payload: { event_type: 'something' },
      message_id: `urn:test:bad-${badType}`,
    });
    assert.equal(result.error, 'non-otm-directed-rejected');
    assert.equal(result.envelope_type, badType);
  });
}
