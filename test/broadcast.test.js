import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastHandler } from '../handlers/broadcast.js';

function fakeLoop() {
  const pressureCalls = [];
  return { pressureCalls, onPressure: (org) => pressureCalls.push(org) };
}

function fakeMissionLoader() {
  const invalidations = [];
  return {
    invalidations,
    invalidate: (reason) => invalidations.push(reason),
    loadMission: async () => ({ msp: null, bor: null, loaded_at: '', cache_expires_at: '', degraded: [] }),
    peekCache: () => null,
  };
}

test('mailbox_pressure on Thalamus triggers loop backpressure', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({
    payload: { event_type: 'mailbox_pressure', data: { organ_name: 'Thalamus', depth: 150, threshold: 100 } },
  });
  assert.deepEqual(loop.pressureCalls, ['Thalamus']);
});

test('mailbox_pressure on other organ is ignored', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({
    payload: { event_type: 'mailbox_pressure', data: { organ_name: 'Radiant', depth: 150, threshold: 100 } },
  });
  assert.deepEqual(loop.pressureCalls, []);
});

test('msp_updated invalidates mission cache', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({ payload: { event_type: 'msp_updated', data: { version: '1.1.0' } } });
  assert.deepEqual(ml.invalidations, ['msp_updated']);
});

test('bor_updated invalidates mission cache', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({ payload: { event_type: 'bor_updated', data: { version: '1.0.1' } } });
  assert.deepEqual(ml.invalidations, ['bor_updated']);
});

test('governance_version_activated also invalidates mission cache', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({ payload: { event_type: 'governance_version_activated', data: { version: '1.2.0' } } });
  assert.deepEqual(ml.invalidations, ['governance_version_activated']);
});

test('state_transition is observability-only (no side effects)', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({ payload: { event_type: 'state_transition', data: { entity_urn: 'urn:e:1' } } });
  assert.deepEqual(loop.pressureCalls, []);
  assert.deepEqual(ml.invalidations, []);
});

test('unknown event_type silently ignored', async () => {
  const loop = fakeLoop();
  const ml = fakeMissionLoader();
  const handler = createBroadcastHandler({ assessmentLoop: loop, missionLoader: ml });
  await handler({ payload: { event_type: 'weird_unknown' } });
  assert.deepEqual(loop.pressureCalls, []);
  assert.deepEqual(ml.invalidations, []);
});
