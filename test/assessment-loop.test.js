import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentLoop } from '../lib/assessment-loop.js';

// Standard cadence config (matches server/config.js defaults)
const testCadence = {
  floorMs: 30000,
  ceilingMs: 900000,
  startMs: 300000,
  gapDivisor: 2,
  idleFactor: 1.5,
  pressureFactor: 2,
};

// Small cadence for faster timing tests where we need setTimeout to actually fire
const fastCadence = {
  floorMs: 10,
  ceilingMs: 1000,
  startMs: 50,
  gapDivisor: 2,
  idleFactor: 1.5,
  pressureFactor: 2,
};

// Test-only readers
function makeReaders({ gaps = [], missionDegraded = false } = {}) {
  return {
    missionLoader: async () => ({
      msp: { version: 'test-1.0.0', raw_text: 'test mission' },
      bor: { version: 'test-bor-1.0.0', raw_text: 'test bor' },
      loaded_at: new Date().toISOString(),
      degraded: missionDegraded ? ['mission-stale'] : [],
    }),
    cmClient: async () => ({
      snapshot: { test: true },
      sources_ok: ['Radiant'],
      sources_degraded: [],
      degraded: [],
    }),
    gapAnalyzer: async () => ({ gaps, degraded: [] }),
    goalEmitter: async (gap) => ({ goal_id: `urn:llm-ops:goal:test-${gap.gap_id}`, dispatched: true }),
  };
}

test('createAssessmentLoop returns an API', () => {
  const loop = createAssessmentLoop({ cadence: testCadence, ...makeReaders() });
  assert.equal(typeof loop.start, 'function');
  assert.equal(typeof loop.stop, 'function');
  assert.equal(typeof loop.trigger, 'function');
  assert.equal(typeof loop.getStats, 'function');
  assert.equal(typeof loop.onPressure, 'function');
});

test('getStats initial values match config', () => {
  const loop = createAssessmentLoop({ cadence: testCadence, ...makeReaders() });
  const stats = loop.getStats();
  assert.equal(stats.loop_iteration, 0);
  assert.equal(stats.current_interval_ms, testCadence.startMs);
  assert.equal(stats.floor_ms, testCadence.floorMs);
  assert.equal(stats.ceiling_ms, testCadence.ceilingMs);
  assert.equal(stats.in_flight, false);
  assert.equal(stats.stopped, true);
});

test('start runs first iteration immediately', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders() });
  await loop.start();
  const stats = loop.getStats();
  assert.equal(stats.loop_iteration, 1, 'first iteration should have run during start()');
  loop.stop();
});

test('cadence halves on gaps found', async () => {
  const gaps = [{ gap_id: 'g1', priority: 'high', description: 'test gap' }];
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps }) });
  await loop.start();
  const stats = loop.getStats();
  // Started at 50ms; gap found → next = max(10, 50/2) = 25
  assert.equal(stats.current_interval_ms, 25);
  loop.stop();
});

test('cadence multiplies by 1.5x on idle', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [] }) });
  await loop.start();
  const stats = loop.getStats();
  // Started at 50ms; idle → next = min(1000, floor(50 * 1.5)) = 75
  assert.equal(stats.current_interval_ms, 75);
  loop.stop();
});

test('backpressure doubles next interval', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [] }) });
  loop.onPressure('Thalamus');
  await loop.start();
  const stats = loop.getStats();
  // Started at 50ms; pressure flagged before start → first computeNextInterval applies pressureFactor
  // next = min(1000, 50 * 2) = 100
  assert.equal(stats.current_interval_ms, 100);
  assert.equal(stats.pressure_flag, false, 'pressure flag should be cleared after consumption');
  loop.stop();
});

test('backpressure only triggers for Thalamus', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [] }) });
  loop.onPressure('Radiant'); // not Thalamus — should be ignored
  await loop.start();
  const stats = loop.getStats();
  // Started at 50ms; idle → 75 (not doubled)
  assert.equal(stats.current_interval_ms, 75);
  loop.stop();
});

test('floor bound enforced on halving', async () => {
  const gaps = [{ gap_id: 'g1', priority: 'critical' }];
  const nearFloor = { ...fastCadence, startMs: 11 };  // 11/2 = 5.5 → floor to 5 → max(10, 5) = 10
  const loop = createAssessmentLoop({ cadence: nearFloor, ...makeReaders({ gaps }) });
  await loop.start();
  const stats = loop.getStats();
  assert.equal(stats.current_interval_ms, 10, 'should clamp to floor');
  loop.stop();
});

test('ceiling bound enforced on idle growth', async () => {
  const nearCeiling = { ...fastCadence, startMs: 900 };  // 900 * 1.5 = 1350 → min(1000, 1350) = 1000
  const loop = createAssessmentLoop({ cadence: nearCeiling, ...makeReaders({ gaps: [] }) });
  await loop.start();
  const stats = loop.getStats();
  assert.equal(stats.current_interval_ms, 1000, 'should clamp to ceiling');
  loop.stop();
});

test('manual trigger runs an assessment but does not reschedule', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [] }) });
  await loop.start();
  const intervalAfterStart = loop.getStats().current_interval_ms;
  const triggerResult = await loop.trigger({ reason: 'operator-urgency' });
  assert.equal(triggerResult.iteration, 2, 'manual trigger counts as an iteration');
  const intervalAfterTrigger = loop.getStats().current_interval_ms;
  assert.equal(intervalAfterTrigger, intervalAfterStart, 'manual trigger must not mutate the scheduled interval');
  loop.stop();
});

test('in-flight guard prevents overlapping assessments', async () => {
  let inFlightSeen = false;
  const slowReader = {
    missionLoader: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { msp: null, bor: null, loaded_at: new Date().toISOString(), degraded: [] };
    },
    cmClient: async () => ({ snapshot: {}, sources_ok: [], sources_degraded: [], degraded: [] }),
    gapAnalyzer: async () => ({ gaps: [], degraded: [] }),
    goalEmitter: async () => ({ goal_id: null, dispatched: false }),
  };
  const loop = createAssessmentLoop({ cadence: fastCadence, ...slowReader });
  const first = loop.start();
  const second = loop.trigger({ reason: 'test-overlap' });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  // second must have been skipped because first was in-flight
  assert.equal(secondResult.skipped, true, 'overlapping trigger must be skipped');
  loop.stop();
});

test('error in reader does not mutate cadence', async () => {
  const broken = {
    missionLoader: async () => { throw new Error('reader-broken'); },
    cmClient: async () => ({ snapshot: {}, sources_ok: [], sources_degraded: [], degraded: [] }),
    gapAnalyzer: async () => ({ gaps: [], degraded: [] }),
    goalEmitter: async () => ({ goal_id: null, dispatched: false }),
  };
  const loop = createAssessmentLoop({ cadence: fastCadence, ...broken });
  await loop.start();
  const stats = loop.getStats();
  // Error → interval unchanged from startMs
  assert.equal(stats.current_interval_ms, fastCadence.startMs);
  loop.stop();
});

test('stop clears scheduled timer', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [] }) });
  await loop.start();
  loop.stop();
  const stats = loop.getStats();
  assert.equal(stats.stopped, true);
});

test('degraded flags propagate from readers through the result', async () => {
  const loop = createAssessmentLoop({ cadence: fastCadence, ...makeReaders({ gaps: [], missionDegraded: true }) });
  const result = await loop.trigger({ reason: 'degraded-test' });
  assert.ok(result.degraded.includes('mission-stale'));
});
