/**
 * cv-backpressure-cadence — mailbox_pressure on Thalamus doubles next interval.
 *
 * RFI-1 Q5 mechanical verification. The broadcast handler is called directly
 * with a mailbox_pressure envelope; the loop's onPressure flag is verified
 * via getStats(). Negative case: mailbox_pressure on a non-Thalamus organ
 * MUST NOT cause cadence change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentLoop } from '../lib/assessment-loop.js';
import { createBroadcastHandler } from '../handlers/broadcast.js';

function noopReaders() {
  return {
    missionLoader: async () => ({ msp: null, bor: null, loaded_at: '', cache_expires_at: '', degraded: [] }),
    cmClient: async () => ({
      snapshot: { spine_state: { recent_transitions: [] } },
      sources_ok: ['Spine'], sources_degraded: [], degraded: [],
    }),
    gapAnalyzer: async () => ({ gaps: [], degraded: [] }),
    goalEmitter: async () => ({ goal_id: null, dispatched: false }),
  };
}

test('mailbox_pressure on Thalamus doubles next interval', async () => {
  const loop = createAssessmentLoop({
    cadence: { floorMs: 10, ceilingMs: 1000, startMs: 50, gapDivisor: 2, idleFactor: 1.5, pressureFactor: 2 },
    ...noopReaders(),
  });
  const missionLoader = { invalidate: () => {} };

  const broadcast = createBroadcastHandler({ assessmentLoop: loop, missionLoader });

  // Inject pressure broadcast BEFORE start so the first interval computation applies it.
  await broadcast({
    payload: { event_type: 'mailbox_pressure', data: { organ_name: 'Thalamus', depth: 150, threshold: 100 } },
  });

  await loop.start();

  // start() runs first iteration (idle since no gaps), then computes next interval.
  // Pressure flag was set before start, so the first computeNextInterval applies it:
  // next = min(1000, 50 * 2) = 100. Without pressure: idle path = min(1000, floor(50 * 1.5)) = 75.
  const stats = loop.getStats();
  assert.equal(stats.current_interval_ms, 100, 'pressure should have doubled the start interval');
  assert.equal(stats.pressure_flag, false, 'pressure flag should be cleared after consumption');
  loop.stop();
});

test('mailbox_pressure on non-Thalamus organ does NOT change cadence', async () => {
  const loop = createAssessmentLoop({
    cadence: { floorMs: 10, ceilingMs: 1000, startMs: 50, gapDivisor: 2, idleFactor: 1.5, pressureFactor: 2 },
    ...noopReaders(),
  });
  const broadcast = createBroadcastHandler({
    assessmentLoop: loop,
    missionLoader: { invalidate: () => {} },
  });

  await broadcast({
    payload: { event_type: 'mailbox_pressure', data: { organ_name: 'Radiant', depth: 999, threshold: 100 } },
  });

  await loop.start();
  const stats = loop.getStats();
  // No pressure → idle growth path: 50 * 1.5 = 75
  assert.equal(stats.current_interval_ms, 75, 'non-Thalamus pressure must not change cadence');
  loop.stop();
});
