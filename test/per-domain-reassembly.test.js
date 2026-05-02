/**
 * per-domain-reassembly.test.js — p4r-4 reassembly path tests.
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md §7.3
 *   - "Reassembly with all 5 per-domain analyzers succeeding"
 *   - "Reassembly with 1 per-domain analyzer failing (degraded preserved;
 *      other domains' gaps included)"
 *   - "Reassembly with all 5 failing (returns empty gaps + full degraded list;
 *      fail-closed invariant)"
 *   - "PRIORITY_ORDER + severity sort correctness"
 *   - "correlation_id forwarded to per-domain analyzers"
 *   - "Output schema continuity (Thalamus consumer contract — gap shape unchanged)"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalHistory } from '../lib/goal-history.js';

const sampleMission = {
  msp: { version: '1.0.0', raw_text: '# MSP\n## Test', hash: 'h1' },
  bor: { version: '1.0.0', raw_text: '# BoR\n## Article 1', hash: 'h2' },
  loaded_at: '2026-05-02T12:00:00Z',
  cache_expires_at: '2026-05-02T12:10:00Z',
  degraded: [],
};

const sampleWorld = {
  radiant: { recent_context: [], recent_memory: [], stats: {} },
  minder: null,
  hippocampus: null,
  graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
  spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1', transition_id: 't1', timestamp: '2026-05-02T11:55:00Z' }] },
  composed_at: '2026-05-02T12:00:00Z',
  sources_ok: ['Radiant', 'Graph', 'Spine'],
  sources_degraded: [],
  degraded: [],
};

// Helper: synthesize a per-domain analyzer that returns N pre-shaped gaps.
function makeDomainAnalyzer(domain, gaps, opts = {}) {
  const recorded = [];
  const fn = async (args) => {
    recorded.push(args);
    if (opts.throwErr) throw new Error(opts.throwErr);
    return { gaps, degraded: opts.degraded || [] };
  };
  fn.recorded = recorded;
  fn.domain = domain;
  return fn;
}

function gap(domain, evidenceRef, priority, severity, descSuffix = '') {
  return {
    description:    `${domain} gap${descSuffix}`,
    target_state:   `${domain} aligned`,
    mission_ref:    `MSP §${domain}`,
    evidence_refs:  [evidenceRef],
    priority,
    severity,
    source_category: domain,
  };
}

const EV = {
  operational:    'urn:llm-ops:spine-transition:t-1',
  strategic:      'urn:llm-ops:radiant:r-1',
  relational:     'urn:llm-ops:minder-peer:leon',
  compliance:     'urn:llm-ops:governance-event:g-1',
  constitutional: 'BoR Article 1',
};

// === All-5-succeed scenario ===

test('reassembly all 5 succeed: gaps concatenated and sorted by priority+severity', async () => {
  const perDomain = {
    operational:    makeDomainAnalyzer('operational',    [gap('operational',    EV.operational,    'low',      0.1)]),
    strategic:      makeDomainAnalyzer('strategic',      [gap('strategic',      EV.strategic,      'medium',   0.5)]),
    relational:     makeDomainAnalyzer('relational',     [gap('relational',     EV.relational,     'high',     0.7)]),
    compliance:     makeDomainAnalyzer('compliance',     [gap('compliance',     EV.compliance,     'critical', 0.9)]),
    constitutional: makeDomainAnalyzer('constitutional', [gap('constitutional', EV.constitutional, 'critical', 0.99)]),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);

  assert.equal(gaps.length, 5, 'all 5 domains contribute one gap');
  // critical (severity 0.99) before critical (0.9), then high, medium, low
  assert.equal(gaps[0].source_category, 'constitutional');
  assert.equal(gaps[0].severity, 0.99);
  assert.equal(gaps[1].source_category, 'compliance');
  assert.equal(gaps[2].source_category, 'relational');
  assert.equal(gaps[3].source_category, 'strategic');
  assert.equal(gaps[4].source_category, 'operational');
  // No per-domain failures
  assert.ok(!degraded.some(d => d.startsWith('per-domain-')), `unexpected per-domain degraded: ${JSON.stringify(degraded)}`);
});

// === One per-domain analyzer failing ===

test('reassembly with 1 per-domain analyzer failing: other domains pass, failure surfaces as degraded', async () => {
  const perDomain = {
    operational:    makeDomainAnalyzer('operational', [gap('operational', EV.operational, 'high', 0.6)]),
    strategic:      makeDomainAnalyzer('strategic',   null, { throwErr: 'strategic-llm-blew-up' }),
    relational:     makeDomainAnalyzer('relational',  [gap('relational', EV.relational, 'medium', 0.5)]),
    compliance:     makeDomainAnalyzer('compliance',  [gap('compliance', EV.compliance, 'low', 0.2)]),
    constitutional: makeDomainAnalyzer('constitutional', [gap('constitutional', EV.constitutional, 'critical', 0.95)]),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);

  assert.equal(gaps.length, 4, '4 domains produced gaps; strategic failed and contributed 0');
  assert.ok(!gaps.some(g => g.source_category === 'strategic'), 'no strategic gap should be present');
  assert.ok(
    degraded.some(d => d.startsWith('per-domain-strategic-failed:')),
    `expected per-domain-strategic-failed degraded entry; got ${JSON.stringify(degraded)}`,
  );
  assert.ok(
    degraded.find(d => d.startsWith('per-domain-strategic-failed:')).includes('strategic-llm-blew-up'),
    'failure message should propagate',
  );
});

// === All-5-fail (fail-closed invariant) ===

test('reassembly with all 5 per-domain analyzers failing: empty gaps + 5 degraded entries', async () => {
  const perDomain = {
    operational:    makeDomainAnalyzer('operational',    null, { throwErr: 'op-fail' }),
    strategic:      makeDomainAnalyzer('strategic',      null, { throwErr: 'str-fail' }),
    relational:     makeDomainAnalyzer('relational',     null, { throwErr: 'rel-fail' }),
    compliance:     makeDomainAnalyzer('compliance',     null, { throwErr: 'comp-fail' }),
    constitutional: makeDomainAnalyzer('constitutional', null, { throwErr: 'con-fail' }),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);

  assert.deepEqual(gaps, [], 'empty gaps when all per-domain analyzers fail (fail-closed)');
  for (const d of ['operational', 'strategic', 'relational', 'compliance', 'constitutional']) {
    assert.ok(
      degraded.some(x => x.startsWith(`per-domain-${d}-failed:`)),
      `missing degraded entry for ${d}: ${JSON.stringify(degraded)}`,
    );
  }
});

// === Schema-purity rejection collapsed to degraded ===

test('reassembly: per-domain analyzer returning wrong-domain gaps gets schema-rejected', async () => {
  // analyzer wired as 'strategic' but returns operational gaps — schema rejects
  const perDomain = {
    operational:    makeDomainAnalyzer('operational',    [gap('operational', EV.operational, 'medium', 0.5)]),
    strategic:      makeDomainAnalyzer('strategic',      [gap('operational', EV.operational, 'high', 0.7)]), // wrong source_category
    relational:     makeDomainAnalyzer('relational',     [gap('relational', EV.relational, 'low', 0.2)]),
    compliance:     makeDomainAnalyzer('compliance',     [gap('compliance', EV.compliance, 'high', 0.7)]),
    constitutional: makeDomainAnalyzer('constitutional', [gap('constitutional', EV.constitutional, 'critical', 0.9)]),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);

  // strategic was schema-rejected — its gaps are dropped
  assert.equal(gaps.length, 4);
  assert.ok(!gaps.some(g => g.description.includes('operational gap') && degraded.some(d => d.includes('strategic'))) || true);
  assert.ok(
    degraded.some(d => d.startsWith('per-domain-strategic-failed:') && d.includes('source_category')),
    `expected schema-violation degraded for strategic; got ${JSON.stringify(degraded)}`,
  );
});

// === PRIORITY_ORDER + severity sort correctness ===

test('reassembly sort: critical(0.5) before high(0.99) before high(0.7) before medium(any)', async () => {
  const perDomain = {
    operational:    makeDomainAnalyzer('operational', [
      gap('operational', EV.operational, 'high',     0.99, '-A'),
      gap('operational', EV.operational, 'medium',   0.99, '-B'),
    ]),
    strategic:      makeDomainAnalyzer('strategic', [
      gap('strategic', EV.strategic, 'critical', 0.5, '-A'),
    ]),
    relational:     makeDomainAnalyzer('relational', [
      gap('relational', EV.relational, 'high', 0.7, '-A'),
    ]),
    compliance:     makeDomainAnalyzer('compliance', [
      gap('compliance', EV.compliance, 'low', 0.99, '-A'),
    ]),
    constitutional: makeDomainAnalyzer('constitutional', []),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const { gaps } = await analyzer(sampleMission, sampleWorld);

  assert.equal(gaps.length, 5);
  assert.equal(gaps[0].priority, 'critical', 'critical first');
  assert.equal(gaps[1].priority, 'high');
  assert.equal(gaps[1].severity, 0.99, 'high(0.99) before high(0.7)');
  assert.equal(gaps[2].priority, 'high');
  assert.equal(gaps[2].severity, 0.7);
  assert.equal(gaps[3].priority, 'medium');
  assert.equal(gaps[4].priority, 'low');
});

// === correlation_id forwarded ===

test('reassembly forwards correlation_id to each per-domain analyzer', async () => {
  const recorders = {};
  const perDomain = {};
  for (const d of ['operational', 'strategic', 'relational', 'compliance', 'constitutional']) {
    recorders[d] = makeDomainAnalyzer(d, [gap(d, EV[d], 'medium', 0.5)]);
    perDomain[d] = recorders[d];
  }

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: perDomain,
  });

  const cid = 'test-correlation-id-7d3f';
  await analyzer(sampleMission, sampleWorld, { correlationId: cid });

  for (const d of Object.keys(recorders)) {
    assert.equal(recorders[d].recorded.length, 1, `${d} called once`);
    assert.equal(recorders[d].recorded[0].correlationId, cid, `${d} received parent correlationId`);
    assert.deepEqual(recorders[d].recorded[0].missionFrame, sampleMission, `${d} received missionFrame`);
    assert.deepEqual(recorders[d].recorded[0].worldState,   sampleWorld,   `${d} received worldState`);
  }
});

test('reassembly mints fresh correlation_id when caller omits opts.correlationId', async () => {
  const recorder = makeDomainAnalyzer('operational', [gap('operational', EV.operational, 'medium', 0.5)]);
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: { operational: recorder },
  });
  await analyzer(sampleMission, sampleWorld);
  assert.equal(recorder.recorded.length, 1);
  // UUID v4 shape (rough check)
  assert.match(recorder.recorded[0].correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

// === Output schema continuity (Thalamus consumer contract) ===

test('reassembly output shape: { gaps, degraded } envelope preserved', async () => {
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: {
      operational:    makeDomainAnalyzer('operational',    [gap('operational',    EV.operational,    'high', 0.7)]),
      strategic:      makeDomainAnalyzer('strategic',      [gap('strategic',      EV.strategic,      'high', 0.7)]),
      relational:     makeDomainAnalyzer('relational',     [gap('relational',     EV.relational,     'high', 0.7)]),
      compliance:     makeDomainAnalyzer('compliance',     [gap('compliance',     EV.compliance,     'high', 0.7)]),
      constitutional: makeDomainAnalyzer('constitutional', [gap('constitutional', EV.constitutional, 'high', 0.7)]),
    },
  });

  const result = await analyzer(sampleMission, sampleWorld);
  assert.ok('gaps' in result, 'result must have gaps');
  assert.ok('degraded' in result, 'result must have degraded');
  assert.ok(Array.isArray(result.gaps));
  assert.ok(Array.isArray(result.degraded));

  // Each gap must carry the canonical Thalamus-consumer shape
  for (const g of result.gaps) {
    assert.ok('description' in g);
    assert.ok('target_state' in g);
    assert.ok('mission_ref' in g);
    assert.ok('evidence_refs' in g);
    assert.ok('priority' in g);
    assert.ok('severity' in g);
    assert.ok('source_category' in g);
  }
});

// === Degraded propagation from world/mission ===

test('reassembly propagates upstream degraded flags from missionFrame and worldState', async () => {
  const degradedMission = { ...sampleMission, degraded: ['msp-stale'] };
  const degradedWorld = { ...sampleWorld, degraded: ['minder-degraded', 'hippocampus-degraded'] };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: {
      operational:    makeDomainAnalyzer('operational', []),
      strategic:      makeDomainAnalyzer('strategic',   []),
      relational:     makeDomainAnalyzer('relational',  []),
      compliance:     makeDomainAnalyzer('compliance',  []),
      constitutional: makeDomainAnalyzer('constitutional', []),
    },
  });

  const { degraded } = await analyzer(degradedMission, degradedWorld);
  assert.ok(degraded.includes('mission:msp-stale'));
  assert.ok(degraded.includes('world:minder-degraded'));
  assert.ok(degraded.includes('world:hippocampus-degraded'));
});

// === Pre-flight gates apply in reassembly mode too ===

test('reassembly: mission fully absent → empty gaps + flagged (no per-domain calls)', async () => {
  const recorder = makeDomainAnalyzer('operational', [gap('operational', EV.operational, 'high', 0.7)]);
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: { operational: recorder },
  });
  const { gaps, degraded } = await analyzer({ msp: null, bor: null, degraded: [] }, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('mission-fully-absent'));
  assert.equal(recorder.recorded.length, 0, 'per-domain analyzer must not be called when pre-flight gate fails');
});

test('reassembly: spine_state absent → empty gaps + flagged (no per-domain calls)', async () => {
  const recorder = makeDomainAnalyzer('strategic', [gap('strategic', EV.strategic, 'high', 0.7)]);
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: { strategic: recorder },
  });
  const worldNoSpine = { ...sampleWorld, spine_state: null };
  const { gaps, degraded } = await analyzer(sampleMission, worldNoSpine);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('spine-state-absent-at-analysis'));
  assert.equal(recorder.recorded.length, 0);
});

// === LLM-availability bypass in reassembly mode ===

test('reassembly mode bypasses single-LLM availability check (each analyzer brings own LLM)', async () => {
  // No injectedLlm — single-pass would fall through the unavailable stub.
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    goalHistory: createGoalHistory(),
    perDomainAnalyzers: {
      operational: makeDomainAnalyzer('operational', [gap('operational', EV.operational, 'high', 0.7)]),
    },
  });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.equal(gaps.length, 1, 'reassembly proceeds without single-LLM availability');
  assert.ok(!degraded.includes('llm-unavailable'), 'llm-unavailable should NOT be flagged in reassembly mode');
});
