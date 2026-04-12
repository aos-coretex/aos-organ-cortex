/**
 * cv-partial-cm-failure — Minder + Hippocampus down, Cortex continues with
 * a flagged snapshot. Verifies the graceful degradation rule from
 * cortex-organ-intervention-instruction.md §5: partial CM failure does NOT
 * halt the assessment loop; only spine_state-unreachable does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmClient } from '../lib/cm-client.js';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalHistory } from '../lib/goal-history.js';

function routeFetch(routes) {
  globalThis.fetch = async (url) => {
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('cm-client surfaces a partial snapshot when Minder + Hippocampus return 503', async () => {
  routeFetch({
    // Radiant up
    '/context': { status: 200, body: { blocks: [{ id: 1 }] } },
    '/memory':  { status: 200, body: { blocks: [{ id: 2 }] } },
    '/stats':   { status: 200, body: { context_count: 1, memory_count: 1, last_dream_at: null } },
    // Minder DOWN (503)
    '/peers/recent':        { status: 503, body: {} },
    '/observations/recent': { status: 503, body: {} },
    // Hippocampus DOWN (503)
    '/conversations': { status: 503, body: {} },
    // Spine events up
    '/events': { status: 200, body: { events: [
      { urn: 'urn:e:1', created_at: 't', envelope: { payload: { event_type: 'state_transition', data: { entity_urn: 'urn:e:1' } } } },
    ] } },
  });

  const cmClient = createCmClient({
    radiantUrl: 'http://r',
    minderUrl: 'http://m',
    hippocampusUrl: 'http://h',
    graphAdapter: { queryConcepts: async () => ({ rows: [{ urn: 'urn:ent:1', data: { type: 'entity', status: 'active' } }], count: 1 }) },
    spineUrl: 'http://s',
    timeoutMs: 1000,
  });

  const result = await cmClient({});
  const snap = result.snapshot;

  assert.notEqual(snap.radiant, null, 'Radiant should be present');
  assert.notEqual(snap.graph_structural, null, 'Graph should be present');
  assert.notEqual(snap.spine_state, null, 'Spine state should be present (loop must NOT halt)');
  assert.equal(snap.minder, null, 'Minder should be null (degraded)');
  assert.equal(snap.hippocampus, null, 'Hippocampus should be null (degraded)');

  assert.ok(snap.sources_degraded.some(s => s.startsWith('Minder:')), 'sources_degraded should flag Minder');
  assert.ok(snap.sources_degraded.some(s => s.startsWith('Hippocampus:')), 'sources_degraded should flag Hippocampus');
  assert.ok(snap.degraded.includes('minder-degraded'));
  assert.ok(snap.degraded.includes('hippocampus-degraded'));
});

test('gap analyzer accepts the partial snapshot and produces gaps with degraded propagation', async () => {
  // Verifies the full assessment cycle continues when Minder + Hippocampus are down.
  // Per cortex-organ-intervention-instruction.md §5, partial CM failure is non-halting.
  const partialSnapshot = {
    radiant: { recent_context: [], recent_memory: [], stats: {} },
    minder: null,  // degraded
    hippocampus: null,  // degraded
    graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
    spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1' }] },
    composed_at: 't',
    sources_ok: ['Radiant', 'Graph', 'Spine'],
    sources_degraded: ['Minder: HTTP 503', 'Hippocampus: HTTP 503'],
    degraded: ['minder-degraded', 'hippocampus-degraded'],
  };

  const llm = {
    isAvailable: () => true,
    chat: async () => ({
      content: JSON.stringify({ gaps: [{ description: 'g', target_state: 'x', mission_ref: 'MSP', priority: 'medium', severity: 0.5, source_category: 'operational' }] }),
      model: 'x', input_tokens: 0, output_tokens: 0,
    }),
    getUsage: () => ({}),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    injectedLlm: llm,
    goalHistory: createGoalHistory(),
  });

  const sampleMission = {
    msp: { version: '1.0.0', raw_text: '# MSP', hash: 'h' },
    bor: { version: '1.0.0', raw_text: '# BoR', hash: 'h2' },
    degraded: [],
  };

  const { gaps, degraded } = await analyzer(sampleMission, partialSnapshot);

  assert.equal(gaps.length, 1, 'gap analyzer must produce a gap even when CM is partial');
  assert.ok(degraded.includes('world:minder-degraded'), 'degraded list must propagate world:minder-degraded');
  assert.ok(degraded.includes('world:hippocampus-degraded'));
});
