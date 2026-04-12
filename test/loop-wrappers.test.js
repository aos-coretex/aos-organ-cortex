import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCmClientWrapper,
  createGapAnalyzerWrapper,
  createStateHolders,
} from '../lib/loop-wrappers.js';

// --- createStateHolders ---

test('createStateHolders returns three independent holders with initial state', () => {
  const { currentGaps, currentAssessmentMeta, currentWorldState } = createStateHolders();
  assert.deepEqual(currentGaps.list(), []);
  assert.deepEqual(currentAssessmentMeta.get(), { lastAt: null, degraded: [] });
  assert.equal(currentWorldState.get(), null);
});

test('state holders are mutable via set()', () => {
  const { currentGaps, currentAssessmentMeta, currentWorldState } = createStateHolders();
  currentGaps.set([{ gap_id: 'g1' }]);
  currentAssessmentMeta.set({ lastAt: 't', degraded: ['x'] });
  currentWorldState.set({ spine_state: null });
  assert.equal(currentGaps.list().length, 1);
  assert.equal(currentAssessmentMeta.get().lastAt, 't');
  assert.deepEqual(currentAssessmentMeta.get().degraded, ['x']);
  assert.equal(currentWorldState.get().spine_state, null);
});

// --- createCmClientWrapper ---

test('wrappedCmClient passes snapshot through on happy path', async () => {
  const holders = createStateHolders();
  const cmClient = async () => ({
    snapshot: { spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1' }] }, radiant: {} },
    sources_ok: ['Spine', 'Radiant'],
    sources_degraded: [],
    degraded: [],
  });
  const wrapped = createCmClientWrapper({
    cmClient,
    currentWorldState: holders.currentWorldState,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  const result = await wrapped({ msp: null });
  assert.notEqual(result.snapshot, null);
  assert.equal(result.halt, undefined);
  assert.notEqual(holders.currentWorldState.get(), null);
});

test('wrappedCmClient flags halt when cm-client returns snapshot with spine_state=null', async () => {
  const holders = createStateHolders();
  const cmClient = async () => ({
    snapshot: { spine_state: null, radiant: { recent_context: [] } },
    sources_ok: ['Radiant'],
    sources_degraded: ['Spine: HTTP 500'],
    degraded: ['spine-state-degraded'],
  });
  const wrapped = createCmClientWrapper({
    cmClient,
    currentWorldState: holders.currentWorldState,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  const result = await wrapped({ msp: null });
  assert.equal(result.halt, true, 'halt flag should be set when spine_state is null');
  assert.equal(result.snapshot._cortex_halt, 'spine-state-unavailable');
  assert.ok(result.degraded.includes('spine-state-unavailable-halt'));
  assert.deepEqual(holders.currentAssessmentMeta.get().degraded, ['spine-state-unavailable-halt']);
});

test('wrappedCmClient updates currentWorldState on every call', async () => {
  const holders = createStateHolders();
  let callNo = 0;
  const cmClient = async () => ({
    snapshot: { spine_state: { recent_transitions: [] }, tick: ++callNo },
    sources_ok: ['Spine'],
    sources_degraded: [],
    degraded: [],
  });
  const wrapped = createCmClientWrapper({
    cmClient,
    currentWorldState: holders.currentWorldState,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  await wrapped({});
  assert.equal(holders.currentWorldState.get().tick, 1);
  await wrapped({});
  assert.equal(holders.currentWorldState.get().tick, 2);
});

// --- createGapAnalyzerWrapper ---

test('wrappedGapAnalyzer short-circuits to empty gaps when worldState.halt === true', async () => {
  const holders = createStateHolders();
  let analyzerCalled = false;
  const gapAnalyzer = async () => {
    analyzerCalled = true;
    return { gaps: [{ gap_id: 'should-not-appear', priority: 'critical' }], degraded: [] };
  };
  const wrapped = createGapAnalyzerWrapper({
    gapAnalyzer,
    currentGaps: holders.currentGaps,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  const result = await wrapped(
    { msp: { raw_text: 'x' } },
    { halt: true, degraded: ['spine-state-unavailable-halt'] },
  );
  assert.equal(analyzerCalled, false, 'real gap analyzer must NOT be called when halt=true');
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.degraded, ['spine-state-unavailable-halt']);
  assert.deepEqual(holders.currentGaps.list(), []);
});

test('wrappedGapAnalyzer unwraps snapshot and calls real analyzer on happy path', async () => {
  const holders = createStateHolders();
  const seen = [];
  const gapAnalyzer = async (mission, world) => {
    seen.push({ mission, world });
    return {
      gaps: [{ gap_id: 'g1', priority: 'high' }],
      degraded: [],
    };
  };
  const wrapped = createGapAnalyzerWrapper({
    gapAnalyzer,
    currentGaps: holders.currentGaps,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  const wrappedInput = {
    snapshot: { spine_state: { recent_transitions: [] }, radiant: {} },
    sources_ok: ['Spine', 'Radiant'],
    sources_degraded: [],
    degraded: [],
  };
  const result = await wrapped({ msp: null }, wrappedInput);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].world, wrappedInput.snapshot, 'wrapper should unwrap snapshot before forwarding');
  assert.equal(result.gaps.length, 1);
  assert.equal(holders.currentGaps.list().length, 1);
  assert.match(holders.currentAssessmentMeta.get().lastAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('wrappedGapAnalyzer propagates degraded array to currentAssessmentMeta on happy path', async () => {
  const holders = createStateHolders();
  const gapAnalyzer = async () => ({
    gaps: [],
    degraded: ['world:minder-degraded', 'llm-parse-error: x'],
  });
  const wrapped = createGapAnalyzerWrapper({
    gapAnalyzer,
    currentGaps: holders.currentGaps,
    currentAssessmentMeta: holders.currentAssessmentMeta,
  });
  await wrapped({ msp: null }, { snapshot: { spine_state: {} }, degraded: [] });
  assert.deepEqual(
    holders.currentAssessmentMeta.get().degraded,
    ['world:minder-degraded', 'llm-parse-error: x'],
  );
});
