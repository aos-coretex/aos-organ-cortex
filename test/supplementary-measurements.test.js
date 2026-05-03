/**
 * supplementary-measurements.test.js — p4r-7 cross-pollination + markdown-fence
 * + constitutional-emission baseline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measureCrossPollination,
  measureMarkdownFenceUsage,
  measureConstitutionalEmissionBaseline,
  SUPPLEMENTARY_THRESHOLDS,
} from '../lib/supplementary-measurements.js';

const g = (priority, source_category, description) => ({
  gap_id: `urn:llm-ops:cortex-gap:test-${Math.random().toString(36).slice(2,8)}`,
  priority, source_category, description,
});

// --- measureCrossPollination ---

test('measureCrossPollination: clean per-domain → all 0 rate', () => {
  const replays = [{
    per_domain_outputs: [
      { domain: 'operational', gaps: [g('critical', 'operational', 'a')], degraded: [] },
      { domain: 'strategic', gaps: [g('high', 'strategic', 'b')], degraded: [] },
    ],
  }];
  const r = measureCrossPollination(replays);
  assert.equal(r.by_domain.operational.cross_pollination_rate, 0);
  assert.equal(r.by_domain.strategic.cross_pollination_rate, 0);
  assert.equal(r.any_above_threshold, false);
});

test('measureCrossPollination: 50% mismatched → flagged above 0.20 threshold', () => {
  const replays = [{
    per_domain_outputs: [
      { domain: 'operational', gaps: [
        g('critical', 'operational', 'good'),
        g('critical', 'strategic', 'bad — wrong category'),  // cross-pollinated
      ], degraded: [] },
    ],
  }];
  const r = measureCrossPollination(replays);
  assert.equal(r.by_domain.operational.total_gaps_emitted, 2);
  assert.equal(r.by_domain.operational.cross_pollinated_gaps, 1);
  assert.equal(r.by_domain.operational.cross_pollination_rate, 0.5);
  assert.ok(r.by_domain.operational.flagged);
  assert.ok(r.any_above_threshold);
});

test('measureCrossPollination: empty per_domain_outputs → no error', () => {
  const r = measureCrossPollination([]);
  assert.equal(r.any_above_threshold, false);
  for (const d of ['operational', 'strategic', 'relational', 'compliance', 'constitutional']) {
    assert.equal(r.by_domain[d].total_gaps_emitted, 0);
    assert.equal(r.by_domain[d].cross_pollination_rate, 0);
  }
});

// --- measureMarkdownFenceUsage ---

test('measureMarkdownFenceUsage: counts fenced/unfenced + parse failures', () => {
  const replays = [
    { legacy: { raw_response: '```json\n[]\n```' }, modular: { raw_responses: [] } },
    { legacy: { raw_response: '[]' },               modular: { raw_responses: [] } },
    { legacy: { raw_response: 'not json{' },        modular: { raw_responses: [] } },
  ];
  const r = measureMarkdownFenceUsage(replays);
  assert.equal(r.total_samples, 3);
  assert.equal(r.fenced_count, 1);
  assert.equal(r.unfenced_count, 2);
  assert.equal(r.parse_failure_count, 1);
});

test('measureMarkdownFenceUsage: parse_failure_rate >0.05 → flagged', () => {
  const replays = [
    { legacy: { raw_response: 'broken{json' }, modular: { raw_responses: [] } },
    { legacy: { raw_response: '[]' },          modular: { raw_responses: [] } },
  ];
  const r = measureMarkdownFenceUsage(replays);
  assert.equal(r.parse_failure_rate, 0.5);
  assert.ok(r.flagged);
});

test('measureMarkdownFenceUsage: includes modular raw_responses', () => {
  const replays = [
    { legacy: { raw_response: '[]' }, modular: { raw_responses: ['```json\n[]\n```', '[]', '[]'] } },
  ];
  const r = measureMarkdownFenceUsage(replays);
  assert.equal(r.total_samples, 4);
  assert.equal(r.fenced_count, 1);
});

// --- measureConstitutionalEmissionBaseline ---

test('measureConstitutionalEmissionBaseline: counts cycles emitting constitutional gap', () => {
  const replays = [];
  // 30 cycles total; 5 emit constitutional gap
  for (let i = 0; i < 30; i++) {
    const gaps = i < 5
      ? [g('high', 'constitutional', `c${i}`), g('medium', 'operational', `o${i}`)]
      : [g('medium', 'operational', `o${i}`)];
    replays.push({ fixture_id: `f${i}`, legacy: { gaps } });
  }
  const r = measureConstitutionalEmissionBaseline(replays);
  assert.equal(r.total_cycles, 30);
  assert.equal(r.cycles_with_constitutional_gap, 5);
  assert.equal(r.constitutional_emission_rate, 5 / 30);
  assert.equal(r.total_constitutional_gaps_emitted, 5);
  assert.ok(r.sustained_window_eligible);
  assert.ok(!r.flagged); // emission is non-zero
});

test('measureConstitutionalEmissionBaseline: 0 emissions across ≥30 cycles → flagged', () => {
  const replays = Array.from({ length: 30 }, (_, i) => ({
    fixture_id: `f${i}`,
    legacy: { gaps: [g('medium', 'operational', `o${i}`)] },
  }));
  const r = measureConstitutionalEmissionBaseline(replays);
  assert.equal(r.cycles_with_constitutional_gap, 0);
  assert.equal(r.constitutional_emission_rate, 0);
  assert.ok(r.flagged);
});

test('measureConstitutionalEmissionBaseline: under 30 cycles → not yet eligible to flag', () => {
  const replays = Array.from({ length: 10 }, (_, i) => ({
    fixture_id: `f${i}`,
    legacy: { gaps: [g('medium', 'operational', `o${i}`)] },
  }));
  const r = measureConstitutionalEmissionBaseline(replays);
  assert.equal(r.cycles_with_constitutional_gap, 0);
  assert.ok(!r.sustained_window_eligible);
  assert.ok(!r.flagged);
});

// --- thresholds constants ---

test('SUPPLEMENTARY_THRESHOLDS exposes the right constants', () => {
  assert.equal(SUPPLEMENTARY_THRESHOLDS.CROSS_POLLINATION_THRESHOLD, 0.20);
  assert.equal(SUPPLEMENTARY_THRESHOLDS.MARKDOWN_PARSE_FAILURE_THRESHOLD, 0.05);
  assert.equal(SUPPLEMENTARY_THRESHOLDS.CONSTITUTIONAL_BASELINE_MIN_CYCLES, 30);
});
