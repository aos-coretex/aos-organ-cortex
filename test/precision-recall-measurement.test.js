/**
 * precision-recall-measurement.test.js — p4r-7 measurement module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDescription,
  diceSimilarity,
  strictTripleMatch,
  twoOfThreeMatch,
  bucketize,
  computeTierMetrics,
  compareFixture,
  aggregateAcrossFixtures,
  checkDistributionCriterion,
} from '../lib/precision-recall-measurement.js';

const g = (priority, source_category, description, severity = 0.5) => ({
  gap_id: `urn:llm-ops:cortex-gap:test-${Math.random().toString(36).slice(2, 8)}`,
  priority, source_category, description,
  target_state: `${priority} target`, mission_ref: 'MSP §test',
  evidence_refs: ['urn:llm-ops:test:e-1'], severity,
});

// --- normalizeDescription ---

test('normalizeDescription: lowercase + collapse whitespace + strip punctuation', () => {
  assert.equal(normalizeDescription('Hello,   World!'), 'hello world');
  assert.equal(normalizeDescription('  Multi\n\tline'), 'multi line');
  assert.equal(normalizeDescription(''), '');
  assert.equal(normalizeDescription(null), '');
  assert.equal(normalizeDescription('UPPER123!@#'), 'upper123');
});

// --- diceSimilarity ---

test('diceSimilarity: identical strings score 1.0', () => {
  assert.equal(diceSimilarity('hello world', 'hello world'), 1);
});

test('diceSimilarity: empty strings both → 1; one empty → 0', () => {
  assert.equal(diceSimilarity('', ''), 1);
  assert.equal(diceSimilarity('hello', ''), 0);
});

test('diceSimilarity: totally disjoint strings score 0', () => {
  // "abc" and "xyz" share no bigrams
  assert.equal(diceSimilarity('abc', 'xyz'), 0);
});

test('diceSimilarity: similar phrasing scores >= 0.7', () => {
  const a = 'system needs more critical patching urgently';
  const b = 'system needs critical patching urgently now';
  const sim = diceSimilarity(a, b);
  assert.ok(sim >= 0.7, `expected ≥0.7 for paraphrase, got ${sim}`);
});

// --- strictTripleMatch / twoOfThreeMatch ---

test('strictTripleMatch: same priority+category+normalized_description → match', () => {
  const a = g('critical', 'operational', 'System  outage  detected');
  const b = g('critical', 'operational', 'system outage detected');
  assert.ok(strictTripleMatch(a, b), 'normalized descriptions match');
});

test('strictTripleMatch: differing priority → no match', () => {
  const a = g('critical', 'operational', 'System outage');
  const b = g('high',     'operational', 'System outage');
  assert.ok(!strictTripleMatch(a, b));
});

test('strictTripleMatch: differing category → no match', () => {
  const a = g('critical', 'operational', 'System outage');
  const b = g('critical', 'compliance',  'System outage');
  assert.ok(!strictTripleMatch(a, b));
});

test('twoOfThreeMatch: priority+category required, description ≥0.7', () => {
  const a = g('high', 'strategic', 'Mission alignment with new organ deployment plan');
  const b = g('high', 'strategic', 'Mission alignment with new organ deployment proposal');
  assert.ok(twoOfThreeMatch(a, b), 'paraphrase should match under two-of-three');
});

test('twoOfThreeMatch: priority match + category match + description <0.7 → no match', () => {
  const a = g('high', 'strategic', 'Apple banana cherry date');
  const b = g('high', 'strategic', 'Quantum gravity wave detector');
  assert.ok(!twoOfThreeMatch(a, b));
});

// --- bucketize ---

test('bucketize: count by priority+category', () => {
  const gaps = [
    g('critical', 'operational', 'a'),
    g('critical', 'operational', 'b'),
    g('high',     'strategic',   'c'),
  ];
  const m = bucketize(gaps);
  assert.equal(m.get('critical::operational'), 2);
  assert.equal(m.get('high::strategic'), 1);
  assert.equal(m.size, 2);
});

// --- computeTierMetrics ---

test('computeTierMetrics: perfect match → precision=recall=f1=1', () => {
  const gt = [g('critical', 'operational', 'X'), g('critical', 'operational', 'Y')];
  const ro = [g('critical', 'operational', 'X'), g('critical', 'operational', 'Y')];
  const { tiers, totals } = computeTierMetrics(gt, ro, strictTripleMatch);
  assert.equal(tiers.critical.precision, 1);
  assert.equal(tiers.critical.recall, 1);
  assert.equal(tiers.critical.f1, 1);
  assert.equal(totals.precision, 1);
  assert.equal(totals.recall, 1);
});

test('computeTierMetrics: half match → precision=recall=0.5', () => {
  const gt = [g('high', 'strategic', 'A'), g('high', 'strategic', 'B')];
  const ro = [g('high', 'strategic', 'A'), g('high', 'strategic', 'C')]; // B missed; C is FP
  const { tiers } = computeTierMetrics(gt, ro, strictTripleMatch);
  assert.equal(tiers.high.tp, 1);
  assert.equal(tiers.high.fp, 1);
  assert.equal(tiers.high.fn, 1);
  assert.equal(tiers.high.precision, 0.5);
  assert.equal(tiers.high.recall, 0.5);
});

test('computeTierMetrics: tier with no GT and no RO → null indeterminate', () => {
  const gt = [];
  const ro = [];
  const { tiers } = computeTierMetrics(gt, ro, strictTripleMatch);
  assert.equal(tiers.medium.precision, null);
  assert.equal(tiers.medium.recall, null);
  assert.equal(tiers.medium.f1, null);
});

test('computeTierMetrics: all-FP (no GT but RO has gaps) → precision=0', () => {
  const gt = [];
  const ro = [g('critical', 'operational', 'X')];
  const { tiers } = computeTierMetrics(gt, ro, strictTripleMatch);
  assert.equal(tiers.critical.tp, 0);
  assert.equal(tiers.critical.fp, 1);
  assert.equal(tiers.critical.precision, 0);
  // recall is null (no ground truth in this tier)
  assert.equal(tiers.critical.recall, null);
});

// --- compareFixture ---

test('compareFixture: returns all 3 variants', () => {
  const legacy = [g('critical', 'operational', 'System outage')];
  const modular = [g('critical', 'operational', 'System outage detected')];
  const c = compareFixture(legacy, modular);
  assert.ok(c.strict_triple);
  assert.ok(c.two_of_three);
  assert.ok(c.set_overlap_buckets);
  // strict triple: descriptions don't match exactly → no match
  assert.equal(c.strict_triple.tiers.critical.tp, 0);
  // two-of-three: priority+category exact, description sim should be ≥0.7
  assert.ok(c.two_of_three.tiers.critical.tp >= 1, 'paraphrase should match under two-of-three');
});

// --- aggregateAcrossFixtures ---

test('aggregateAcrossFixtures: scopes matches to same fixture_id', () => {
  const f1 = {
    fixture_id: 'F1',
    legacy_gaps: [g('critical', 'operational', 'A'), g('high', 'strategic', 'B')],
    modular_gaps: [g('critical', 'operational', 'A'), g('high', 'strategic', 'B')],
  };
  const f2 = {
    fixture_id: 'F2',
    legacy_gaps: [g('critical', 'operational', 'A')], // same description as F1, but in F2
    modular_gaps: [], // F2 modular has no critical → FN for F2
  };
  const agg = aggregateAcrossFixtures([f1, f2]);
  // strict triple: F1 critical match (tp=1); F2 critical FN (fn=1)
  assert.equal(agg.strict_triple.tiers.critical.tp, 1);
  assert.equal(agg.strict_triple.tiers.critical.fn, 1);
  // F1's legacy critical "A" should NOT match F2's modular [] (cross-fixture isolation)
  assert.equal(agg.fixture_count, 2);
});

// --- checkDistributionCriterion ---

test('checkDistributionCriterion: passes when ≥10 critical AND ≥15 high', () => {
  const fixtureResults = [
    { fixture_id: 'A', legacy_gaps: [
      ...Array(10).fill(0).map((_, i) => g('critical', 'operational', `c${i}`)),
      ...Array(15).fill(0).map((_, i) => g('high', 'strategic', `h${i}`)),
    ]},
  ];
  const r = checkDistributionCriterion(fixtureResults);
  assert.ok(r.ok);
  assert.equal(r.breakdown.critical, 10);
  assert.equal(r.breakdown.high, 15);
});

test('checkDistributionCriterion: fails when <10 critical', () => {
  const fixtureResults = [
    { fixture_id: 'A', legacy_gaps: [
      ...Array(5).fill(0).map((_, i) => g('critical', 'operational', `c${i}`)),
      ...Array(20).fill(0).map((_, i) => g('high', 'strategic', `h${i}`)),
    ]},
  ];
  const r = checkDistributionCriterion(fixtureResults);
  assert.ok(!r.ok);
  assert.ok(r.missing.some(m => m.includes('critical:5<10')));
});
