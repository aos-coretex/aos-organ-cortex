/**
 * cadence-executor.test.js — p4r-5 cadence-mode executor tests.
 *
 * Spec anchor: parent meta-prompt §Architectural invariants + relay p4r-5 §5
 *   - Mode A priority-driven: gap-analyzer wrapper invoked once per cycle
 *     (delegates to runPerDomainReassembly internally — verified separately
 *     by per-domain-reassembly.test.js).
 *   - Mode B round-robin: ONE analyzer per cycle, rotating through domainOrder
 *     in critical-priority-first order.
 *   - Mode C backpressure-adapted: priority-driven default; switches to
 *     fallback on signal; returns to default after recoveryThreshold clear
 *     cycles. Consume-once semantics on the signal mirror the assessment-loop
 *     pressureFlag pattern.
 *   - Telemetry: cortex_cadence_mode emitted per cycle.
 *   - Backward compatibility: not asserted here (assessment-loop without
 *     cadenceConfig falls through to legacy gap-analyzer call site; covered
 *     by all pre-p4r-5 assessment-loop.test.js cases continuing to pass).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCadenceExecutor,
} from '../lib/cadence-executor.js';
import {
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_DOMAIN_ORDER,
  validateCadenceConfig,
} from '../lib/cadence-config.js';

const sampleMission = {
  msp: { version: '1.0.0', raw_text: '# MSP', hash: 'h1' },
  bor: { version: '1.0.0', raw_text: '# BoR', hash: 'h2' },
  loaded_at: '2026-05-02T12:00:00Z',
  cache_expires_at: '2026-05-02T12:10:00Z',
  degraded: [],
};

const sampleWorld = {
  radiant: null,
  minder: null,
  hippocampus: null,
  graph_structural: null,
  spine_state: { recent_transitions: [] },
  composed_at: '2026-05-02T12:00:00Z',
  sources_ok: ['Spine'],
  sources_degraded: [],
  degraded: [],
};

function makeAnalyzerSet(recordings = {}) {
  const set = {};
  for (const domain of DEFAULT_DOMAIN_ORDER) {
    recordings[domain] = recordings[domain] || [];
    set[domain] = async (args) => {
      recordings[domain].push(args);
      return { gaps: [], degraded: [] };
    };
  }
  return { set, recordings };
}

function makeRecordingGapAnalyzer() {
  const calls = [];
  const fn = async (missionFrame, worldState) => {
    calls.push({ missionFrame, worldState });
    return { gaps: [], degraded: [] };
  };
  fn.calls = calls;
  return fn;
}

function captureStdout(fn) {
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(chunk.toString());
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = original;
  }).then(() => captured.join(''));
}

function findEvents(rawStdout, eventName) {
  return rawStdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((e) => e && e.event === eventName);
}

// ===== validateCadenceConfig =====

test('validateCadenceConfig accepts the default', () => {
  validateCadenceConfig({ ...DEFAULT_CADENCE_CONFIG });
});

test('validateCadenceConfig rejects unknown mode', () => {
  assert.throws(
    () => validateCadenceConfig({ ...DEFAULT_CADENCE_CONFIG, mode: 'random-walk' }),
    /mode must be one of/,
  );
});

test('validateCadenceConfig rejects backpressure-adapted as fallback', () => {
  assert.throws(
    () => validateCadenceConfig({
      ...DEFAULT_CADENCE_CONFIG,
      backpressureFallbackMode: 'backpressure-adapted',
    }),
    /backpressureFallbackMode must be a non-adaptive mode/,
  );
});

test('validateCadenceConfig rejects non-positive recovery threshold', () => {
  assert.throws(
    () => validateCadenceConfig({ ...DEFAULT_CADENCE_CONFIG, backpressureRecoveryThreshold: 0 }),
    /backpressureRecoveryThreshold must be a positive integer/,
  );
});

// ===== createCadenceExecutor — construction guards =====

test('createCadenceExecutor throws when analyzerSet missing a domainOrder entry', () => {
  const { set } = makeAnalyzerSet();
  delete set.compliance;
  const gapAnalyzer = makeRecordingGapAnalyzer();
  assert.throws(
    () => createCadenceExecutor({
      analyzerSet: set,
      gapAnalyzer,
      cadenceConfig: { ...DEFAULT_CADENCE_CONFIG },
    }),
    /analyzerSet has no analyzer for that domain/,
  );
});

test('createCadenceExecutor throws when gapAnalyzer missing', () => {
  const { set } = makeAnalyzerSet();
  assert.throws(
    () => createCadenceExecutor({
      analyzerSet: set,
      cadenceConfig: { ...DEFAULT_CADENCE_CONFIG },
    }),
    /gapAnalyzer is required/,
  );
});

// ===== Mode A — priority-driven =====

test('Mode A priority-driven: gapAnalyzer invoked once per cycle; analyzerSet untouched', async () => {
  const { set, recordings } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'priority-driven' },
  });

  for (let i = 0; i < 3; i += 1) {
    await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  }

  assert.equal(gapAnalyzer.calls.length, 3, 'gapAnalyzer should be called once per cycle');
  for (const domain of DEFAULT_DOMAIN_ORDER) {
    assert.equal(recordings[domain].length, 0, `Mode A must not call analyzerSet[${domain}] directly`);
  }
  assert.equal(exec.getCurrentMode(), 'priority-driven');
});

// ===== Mode B — round-robin =====

test('Mode B round-robin: one analyzer per cycle in critical-priority-first order', async () => {
  const { set, recordings } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'round-robin' },
  });

  // Run exactly 5 cycles — one per domain.
  for (let i = 0; i < 5; i += 1) {
    await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  }

  assert.equal(gapAnalyzer.calls.length, 0, 'Mode B must not call the gap-analyzer wrapper');

  // Each domain hit exactly once, in domainOrder.
  for (const domain of DEFAULT_DOMAIN_ORDER) {
    assert.equal(recordings[domain].length, 1, `${domain} should have been called once`);
  }
  assert.equal(exec.getRoundRobinIndex(), 5);

  // Wrap-around — 6th cycle hits operational again.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(recordings.operational.length, 2);
  assert.equal(exec.getRoundRobinIndex(), 6);
});

test('Mode B round-robin: per-domain analyzer receives correlationId and missionFrame/worldState', async () => {
  const { set, recordings } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'round-robin' },
  });

  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });

  const callArgs = recordings.operational[0];
  assert.equal(callArgs.missionFrame, sampleMission);
  assert.equal(callArgs.worldState, sampleWorld);
  assert.ok(callArgs.correlationId, 'correlationId should be minted per cycle');
  assert.match(callArgs.correlationId, /^[0-9a-f-]{36}$/, 'correlationId should be a UUIDv4-shaped string');
});

// ===== Mode C — backpressure-adapted =====

test('Mode C backpressure-adapted: starts in priority-driven; switches on signal; returns after threshold', async () => {
  const { set, recordings } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const signal = { active: false };
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: {
      ...DEFAULT_CADENCE_CONFIG,
      mode: 'backpressure-adapted',
      backpressureRecoveryThreshold: 2,
    },
    backpressureSignal: signal,
  });

  // Cycle 1 — no pressure → priority-driven, gapAnalyzer called.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(gapAnalyzer.calls.length, 1);
  assert.equal(exec.getCurrentMode(), 'priority-driven');
  assert.equal(recordings.operational.length, 0);

  // Cycle 2 — pressure event arrives → switch to round-robin (fallback).
  signal.active = true;
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin', 'backpressure should switch to fallback');
  assert.equal(recordings.operational.length, 1, 'first round-robin cycle should hit operational');
  assert.equal(signal.active, false, 'signal should be consumed after the cycle');

  // Cycle 3 — clear (streak=1; not yet >= threshold=2) → still round-robin.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin');
  assert.equal(recordings.constitutional.length, 1);

  // Cycle 4 — clear (streak=2; >= threshold) → return to priority-driven.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'priority-driven', 'should return to default after recovery');
  // gapAnalyzer was called in cycle 1 + cycle 4 = 2 total.
  assert.equal(gapAnalyzer.calls.length, 2);
});

test('Mode C: a fresh pressure event during fallback resets the recovery streak', async () => {
  const { set, recordings } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const signal = { active: false };
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: {
      ...DEFAULT_CADENCE_CONFIG,
      mode: 'backpressure-adapted',
      backpressureRecoveryThreshold: 2,
    },
    backpressureSignal: signal,
  });

  // Pressure → fallback.
  signal.active = true;
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin');

  // Clear cycle — streak=1.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin');

  // Fresh pressure event resets streak.
  signal.active = true;
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin');

  // Clear cycle — streak=1 again (not 2, due to reset).
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'round-robin', 'streak reset by fresh pressure');

  // Clear cycle — streak=2 — return to default.
  await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  assert.equal(exec.getCurrentMode(), 'priority-driven');
});

// ===== Telemetry =====

test('telemetry: cortex_cadence_mode emitted per cycle with cycle_mode', async () => {
  const { set } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'priority-driven' },
  });

  const out = await captureStdout(async () => {
    await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
    await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  });

  const events = findEvents(out, 'cortex_cadence_mode');
  assert.equal(events.length, 2, 'should emit one cadence-mode event per cycle');
  for (const e of events) {
    assert.equal(e.cycle_mode, 'priority-driven');
    assert.equal(e.configured_mode, 'priority-driven');
    assert.equal(typeof e.round_robin_index, 'number');
  }
});

test('telemetry: round-robin pick + complete events emitted', async () => {
  const { set } = makeAnalyzerSet();
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'round-robin' },
  });

  const out = await captureStdout(async () => {
    await exec.executeAssessmentCycle({ missionFrame: sampleMission, worldState: sampleWorld });
  });

  const picks = findEvents(out, 'cortex_cadence_round_robin_pick');
  const completes = findEvents(out, 'cortex_cadence_round_robin_complete');
  assert.equal(picks.length, 1);
  assert.equal(completes.length, 1);
  assert.equal(picks[0].domain, 'operational');
  assert.equal(picks[0].correlation_id, completes[0].correlation_id, 'pick + complete share correlation_id');
});

// ===== Per-domain failure isolation =====

test('Mode B: per-domain analyzer that throws returns degraded but does not propagate', async () => {
  const { set, recordings } = makeAnalyzerSet();
  set.operational = async () => { throw new Error('boom'); };
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'round-robin' },
  });

  const result = await exec.executeAssessmentCycle({
    missionFrame: sampleMission, worldState: sampleWorld,
  });

  assert.deepEqual(result.gaps, []);
  assert.equal(result.degraded.length, 1);
  assert.match(result.degraded[0], /^per-domain-rejected:boom$/);
});

// ===== Sort contract parity with reassembly =====

test('Mode B: gaps sorted by PRIORITY_ORDER asc + severity desc (matches reassembly)', async () => {
  const { set } = makeAnalyzerSet();
  set.operational = async () => ({
    gaps: [
      { priority: 'low',      severity: 0.9, _id: 'L' },
      { priority: 'critical', severity: 0.2, _id: 'C-low-sev' },
      { priority: 'critical', severity: 0.8, _id: 'C-high-sev' },
      { priority: 'high',     severity: 0.5, _id: 'H' },
    ],
    degraded: [],
  });
  const gapAnalyzer = makeRecordingGapAnalyzer();
  const exec = createCadenceExecutor({
    analyzerSet: set,
    gapAnalyzer,
    cadenceConfig: { ...DEFAULT_CADENCE_CONFIG, mode: 'round-robin' },
  });

  const result = await exec.executeAssessmentCycle({
    missionFrame: sampleMission, worldState: sampleWorld,
  });

  assert.deepEqual(
    result.gaps.map((g) => g._id),
    ['C-high-sev', 'C-low-sev', 'H', 'L'],
    'critical-high-sev before critical-low-sev before high before low',
  );
});
