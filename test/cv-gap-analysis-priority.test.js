/**
 * cv-gap-analysis-priority — gap analyzer returns a prioritized list with
 * critical first, severity tiebreaker, and URN-minted gap_ids.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalHistory } from '../lib/goal-history.js';

const sampleMission = {
  msp: { version: '1.0.0', raw_text: '# MSP', hash: 'h1' },
  bor: { version: '1.0.0', raw_text: '# BoR', hash: 'h2' },
  loaded_at: '2026-04-11T12:00:00Z',
  cache_expires_at: '2026-04-11T12:10:00Z',
  degraded: [],
};

const sampleWorld = {
  spine_state: { recent_transitions: [] },
  radiant: null, minder: null, hippocampus: null, graph_structural: null,
  composed_at: '2026-04-11T12:00:00Z', sources_ok: ['Spine'], sources_degraded: [], degraded: [],
};

test('gap analyzer returns gaps sorted by priority then severity', async () => {
  const llm = {
    isAvailable: () => true,
    chat: async () => ({
      content: JSON.stringify({
        gaps: [
          { description: 'low-1',      target_state: 'a', mission_ref: 'MSP', priority: 'low',      severity: 0.9, source_category: 'operational' },
          { description: 'critical-1', target_state: 'b', mission_ref: 'MSP', priority: 'critical', severity: 0.5, source_category: 'strategic' },
          { description: 'high-low-sev',   target_state: 'c', mission_ref: 'MSP', priority: 'high', severity: 0.6, source_category: 'compliance' },
          { description: 'high-high-sev',  target_state: 'd', mission_ref: 'MSP', priority: 'high', severity: 0.95, source_category: 'relational' },
        ],
      }),
      model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50,
    }),
    getUsage: () => ({}),
  };

  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'test' },
    injectedLlm: llm,
    goalHistory: createGoalHistory(),
  });

  const { gaps } = await analyzer(sampleMission, sampleWorld);

  // Expected order: critical → high@0.95 → high@0.6 → low
  assert.equal(gaps.length, 4);
  assert.equal(gaps[0].description, 'critical-1', 'critical first');
  assert.equal(gaps[1].description, 'high-high-sev', 'high with sev 0.95 before high with sev 0.6');
  assert.equal(gaps[2].description, 'high-low-sev');
  assert.equal(gaps[3].description, 'low-1');

  // Every gap has a URN gap_id and analyzed_at timestamp
  for (const g of gaps) {
    assert.match(g.gap_id, /^urn:llm-ops:cortex-gap:/, `gap_id should be cortex-gap URN, got: ${g.gap_id}`);
    assert.match(g.analyzed_at, /^\d{4}-\d{2}-\d{2}T/, `analyzed_at should be ISO8601`);
  }
});
