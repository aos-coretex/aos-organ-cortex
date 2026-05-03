/**
 * quality-bar-enforcement.test.js — p4r-7 HARD QUALITY-BAR enforcement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceQualityBar, buildForwardAction, QUALITY_BAR } from '../lib/quality-bar-enforcement.js';

function metrics({ critP, critR, hiP, hiR }) {
  // Construct a minimal metrics shape that enforceQualityBar consumes.
  return {
    tiers: {
      critical: { tp: 95, fp: critP === null ? 0 : Math.round(95 * (1 - critP) / critP), fn: critR === null ? 0 : Math.round(95 * (1 - critR) / critR), precision: critP, recall: critR, f1: critP && critR ? (2 * critP * critR) / (critP + critR) : null },
      high:     { tp: 90, fp: hiP === null ? 0 : Math.round(90 * (1 - hiP) / hiP),   fn: hiR === null ? 0 : Math.round(90 * (1 - hiR) / hiR),   precision: hiP,   recall: hiR,   f1: hiP && hiR ? (2 * hiP * hiR) / (hiP + hiR) : null },
      medium:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      low:      { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
    },
    totals:   { tp: 185, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
  };
}

// --- PASS verdict ---

test('enforceQualityBar: PASS when critical ≥95/95 AND high ≥90/90', () => {
  const m = metrics({ critP: 0.96, critR: 0.97, hiP: 0.92, hiR: 0.91 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.failures.length, 0);
});

test('enforceQualityBar: PASS at exact threshold boundary', () => {
  const m = metrics({ critP: 0.95, critR: 0.95, hiP: 0.90, hiR: 0.90 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'PASS');
});

// --- FAIL verdicts ---

test('enforceQualityBar: FAIL when critical-precision <0.95', () => {
  const m = metrics({ critP: 0.94, critR: 0.96, hiP: 0.95, hiR: 0.95 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.some(f => f.includes('critical-precision')));
});

test('enforceQualityBar: FAIL when critical-recall <0.95', () => {
  const m = metrics({ critP: 0.96, critR: 0.94, hiP: 0.95, hiR: 0.95 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.some(f => f.includes('critical-recall')));
});

test('enforceQualityBar: FAIL when high-precision <0.90', () => {
  const m = metrics({ critP: 0.96, critR: 0.96, hiP: 0.89, hiR: 0.95 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.some(f => f.includes('high-precision')));
});

test('enforceQualityBar: FAIL when high-recall <0.90', () => {
  const m = metrics({ critP: 0.96, critR: 0.96, hiP: 0.95, hiR: 0.89 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.some(f => f.includes('high-recall')));
});

test('enforceQualityBar: FAIL surfaces multiple failure axes', () => {
  const m = metrics({ critP: 0.50, critR: 0.50, hiP: 0.50, hiR: 0.50 });
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.length >= 4, `expected ≥4 failure axes; got ${r.failures.length}`);
});

// --- INCONCLUSIVE verdict (no measurable metrics anywhere) ---

test('enforceQualityBar: INCONCLUSIVE when no measurable metrics in critical+high tiers', () => {
  const m = {
    tiers: {
      critical: { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      high:     { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      medium:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      low:      { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
    },
    totals:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
  };
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.equal(r.summary.determinate_metrics, 0);
  assert.ok(r.failures.some(f => f.includes('zero-measurable-metrics')), `expected zero-measurable note: ${r.failures}`);
});

test('enforceQualityBar: PASS when one tier measurable + ≥ threshold + other tier truly empty (no GT, no RO)', () => {
  const m = {
    tiers: {
      critical: { tp: 95, fp: 4, fn: 1, precision: 0.96, recall: 0.99, f1: 0.97 },
      high:     { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      medium:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      low:      { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
    },
    totals:   { tp: 95, fp: 4, fn: 1, precision: 0.96, recall: 0.99, f1: 0.97 },
  };
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'PASS');
});

test('enforceQualityBar: FAIL on one-sided emptiness — modular emitted 0 but ground-truth has gaps', () => {
  // ground-truth has 10 critical gaps; modular emitted 0 → tp=0, fp=0, fn=10
  // precision = 0/0 = null but fn>0 → one-sided emptiness → FAIL
  const m = {
    tiers: {
      critical: { tp: 0, fp: 0, fn: 10, precision: null, recall: 0, f1: null },
      high:     { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      medium:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      low:      { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
    },
    totals:   { tp: 0, fp: 0, fn: 10, precision: null, recall: 0, f1: null },
  };
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.some(f => f.includes('one-sided emptiness')) || r.failures.some(f => f.includes('critical-recall')), `expected concrete-failure marker: ${r.failures}`);
});

test('enforceQualityBar: FAIL on one-sided emptiness — modular emitted gaps but ground-truth has none', () => {
  // ground-truth has 0; modular emitted 10 → tp=0, fp=10, fn=0
  // recall = 0/0 = null but fp>0 → one-sided emptiness → FAIL
  const m = {
    tiers: {
      critical: { tp: 0, fp: 10, fn: 0, precision: 0, recall: null, f1: null },
      high:     { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      medium:   { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
      low:      { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
    },
    totals:   { tp: 0, fp: 10, fn: 0, precision: 0, recall: null, f1: null },
  };
  const r = enforceQualityBar(m);
  assert.equal(r.verdict, 'FAIL');
});

// --- buildForwardAction ---

test('buildForwardAction: PASS authorizes R8', () => {
  const r = enforceQualityBar(metrics({ critP: 0.96, critR: 0.97, hiP: 0.92, hiR: 0.91 }));
  const action = buildForwardAction(r);
  assert.equal(action.authorize_r8, true);
  assert.deepEqual(action.block_back_targets, []);
  assert.equal(action.escalation_required, false);
});

test('buildForwardAction: INCONCLUSIVE escalates without block-back', () => {
  const r = {
    verdict: 'INCONCLUSIVE',
    failures: ['zero-measurable-metrics-in-critical-and-high-tiers: ...'],
    summary: { determinate_metrics: 0 },
  };
  const action = buildForwardAction(r);
  assert.equal(action.authorize_r8, false);
  assert.deepEqual(action.block_back_targets, []);
  assert.equal(action.escalation_required, true);
  assert.ok(action.reason.includes('INCONCLUSIVE'));
  assert.ok(action.reason.includes('NOT a precision-design defect'));
});

test('buildForwardAction: FAIL on critical → block-back targets include R6 + R4', () => {
  const r = enforceQualityBar(metrics({ critP: 0.50, critR: 0.50, hiP: 0.95, hiR: 0.95 }));
  const action = buildForwardAction(r);
  assert.equal(action.authorize_r8, false);
  assert.ok(action.block_back_targets.includes('R6'));
  assert.ok(action.block_back_targets.includes('R4'));
});

test('buildForwardAction: FAIL on high → block-back targets include R3 + R2', () => {
  const r = enforceQualityBar(metrics({ critP: 0.95, critR: 0.95, hiP: 0.50, hiR: 0.50 }));
  const action = buildForwardAction(r);
  assert.equal(action.authorize_r8, false);
  assert.ok(action.block_back_targets.includes('R3'));
  assert.ok(action.block_back_targets.includes('R2'));
});

// --- thresholds constants ---

test('QUALITY_BAR thresholds match parent MP §Acceptance', () => {
  assert.equal(QUALITY_BAR.critical.precision, 0.95);
  assert.equal(QUALITY_BAR.critical.recall, 0.95);
  assert.equal(QUALITY_BAR.high.precision, 0.90);
  assert.equal(QUALITY_BAR.high.recall, 0.90);
});
