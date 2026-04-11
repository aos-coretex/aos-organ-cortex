import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalHistory } from '../lib/goal-history.js';
import { SYSTEM_PROMPT, buildPrompt, parseResponse } from '../agents/gap-analyzer-agent.js';

const sampleMission = {
  msp: { version: '1.0.0-seed', raw_text: '# MSP\n\n## Purpose\nTest mission.', hash: 'h1' },
  bor: { version: '1.0.0',      raw_text: '# BoR\n\n## Article 1\nTest identity.', hash: 'h2' },
  loaded_at: '2026-04-11T12:00:00Z',
  cache_expires_at: '2026-04-11T12:10:00Z',
  degraded: [],
};

const sampleWorld = {
  radiant: { recent_context: [], recent_memory: [], stats: {} },
  minder: null,
  hippocampus: null,
  graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
  spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1', previous_state: 'A', current_state: 'B', timestamp: 't' }] },
  composed_at: '2026-04-11T12:00:00Z',
  window_since: '2026-04-11T11:50:00Z',
  sources_ok: ['Radiant', 'Graph', 'Spine'],
  sources_degraded: ['Minder: timeout', 'Hippocampus: 503'],
  degraded: ['minder-degraded', 'hippocampus-degraded'],
};

function mockLlm({ response, available = true, throwErr = false }) {
  return {
    isAvailable: () => available,
    chat: async (messages, options) => {
      // Capture the system prompt for verification
      mockLlm.lastSystem = options?.system;
      mockLlm.lastMessages = messages;
      if (throwErr) throw new Error('llm-blew-up');
      return response;
    },
    getUsage: () => ({}),
  };
}

test('SYSTEM_PROMPT contains no scope-ruling language (binding CV assertion)', () => {
  const forbidden = ['in_scope', 'out_of_scope', 'ambiguous', 'scope ruling', 'scope gate', 'permitted action', 'forbidden action', 'IN_SCOPE', 'OUT_OF_SCOPE', 'AMBIGUOUS'];
  for (const phrase of forbidden) {
    assert.ok(
      !SYSTEM_PROMPT.toLowerCase().includes(phrase.toLowerCase()),
      `SYSTEM_PROMPT contains forbidden scope-ruling language: "${phrase}"`,
    );
  }
});

test('happy path: LLM returns structured gaps, sorted by priority then severity', async () => {
  const llm = mockLlm({
    response: {
      content: JSON.stringify({
        gaps: [
          { description: 'g-low',      target_state: 'x', mission_ref: 'MSP §1', priority: 'low',      severity: 0.9, source_category: 'operational' },
          { description: 'g-critical', target_state: 'y', mission_ref: 'MSP §2', priority: 'critical', severity: 0.5, source_category: 'strategic'   },
          { description: 'g-high-a',   target_state: 'z', mission_ref: 'MSP §3', priority: 'high',     severity: 0.7, source_category: 'compliance'  },
          { description: 'g-high-b',   target_state: 'w', mission_ref: 'MSP §4', priority: 'high',     severity: 0.9, source_category: 'relational'  },
        ],
      }),
      model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50,
    },
  });
  const analyzer = createGapAnalyzer({
    llmConfig: { agentName: 'cortex-gap-analyzer', defaultModel: 'claude-sonnet-4-6', defaultProvider: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY', maxTokens: 1024 },
    injectedLlm: llm,
    goalHistory: createGoalHistory(),
  });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.equal(gaps.length, 4);
  assert.equal(gaps[0].description, 'g-critical', 'critical first regardless of severity');
  assert.equal(gaps[1].description, 'g-high-b',   'high with severity 0.9 before high with 0.7');
  assert.equal(gaps[2].description, 'g-high-a');
  assert.equal(gaps[3].description, 'g-low');
  // URNs minted
  for (const g of gaps) assert.match(g.gap_id, /^urn:llm-ops:cortex-gap:/);
  // Degraded reflects world.sources_degraded (minder/hippocampus)
  assert.ok(degraded.some(d => d.startsWith('world:')));
});

test('LLM unavailable → empty gaps, flagged llm-unavailable', async () => {
  const llm = mockLlm({ available: false, response: null });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('llm-unavailable'));
});

test('LLM throws → empty gaps, flagged llm-error', async () => {
  const llm = mockLlm({ throwErr: true, response: null });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('llm-error'));
});

test('LLM returns non-JSON → empty gaps, flagged llm-parse-error', async () => {
  const llm = mockLlm({ response: { content: 'not json at all', model: 'x', input_tokens: 0, output_tokens: 0 } });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.some(d => d.startsWith('llm-parse-error')));
});

test('LLM returns { gaps: [] } when organism is aligned', async () => {
  const llm = mockLlm({ response: { content: JSON.stringify({ gaps: [] }), model: 'x', input_tokens: 10, output_tokens: 10 } });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const { gaps, degraded } = await analyzer(sampleMission, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(!degraded.includes('llm-unavailable'));
  assert.ok(!degraded.some(d => d.startsWith('llm-')));
});

test('mission fully absent → empty gaps, flagged mission-fully-absent', async () => {
  const llm = mockLlm({ response: null });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const { gaps, degraded } = await analyzer({ msp: null, bor: null, degraded: [] }, sampleWorld);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('mission-fully-absent'));
});

test('spine_state absent → empty gaps, flagged spine-state-absent-at-analysis', async () => {
  const llm = mockLlm({ response: null });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  const worldWithoutSpine = { ...sampleWorld, spine_state: null };
  const { gaps, degraded } = await analyzer(sampleMission, worldWithoutSpine);
  assert.deepEqual(gaps, []);
  assert.ok(degraded.includes('spine-state-absent-at-analysis'));
});

test('system prompt is passed as options.system (bug #2)', async () => {
  const llm = mockLlm({ response: { content: JSON.stringify({ gaps: [] }), model: 'x', input_tokens: 0, output_tokens: 0 } });
  const analyzer = createGapAnalyzer({ llmConfig: { agentName: 'test' }, injectedLlm: llm, goalHistory: createGoalHistory() });
  await analyzer(sampleMission, sampleWorld);
  assert.equal(mockLlm.lastSystem, SYSTEM_PROMPT);
  // messages array contains a user turn only — no system turn
  assert.equal(mockLlm.lastMessages.length, 1);
  assert.equal(mockLlm.lastMessages[0].role, 'user');
});

test('buildPrompt includes MSP, BoR, world state, and recent goals sections', () => {
  const prompt = buildPrompt({ missionFrame: sampleMission, worldState: sampleWorld, recentGoals: [{ goal_id: 'g1', description: 'prior goal' }] });
  assert.ok(prompt.includes('# Mission Statement Protocol'));
  assert.ok(prompt.includes('# Bill of Rights (BoR)'));
  assert.ok(prompt.includes('# World State Snapshot'));
  assert.ok(prompt.includes('# Recent Goals'));
  assert.ok(prompt.includes('prior goal'));
  assert.ok(prompt.includes('constitutional identity'));
});

test('buildPrompt falls back to degraded placeholder when MSP missing', () => {
  const degradedFrame = { msp: null, bor: sampleMission.bor, loaded_at: 't', cache_expires_at: 't', degraded: ['msp-missing-from-graph'] };
  const prompt = buildPrompt({ missionFrame: degradedFrame, worldState: sampleWorld, recentGoals: [] });
  assert.ok(prompt.includes('MSP unavailable'));
  assert.ok(prompt.includes('# Bill of Rights'));
});

test('parseResponse normalizes malformed priority to medium', () => {
  const { gaps } = parseResponse(JSON.stringify({ gaps: [{ description: 'x', priority: 'mega-critical', severity: 2 }] }));
  assert.equal(gaps[0].priority, 'medium');
  assert.equal(gaps[0].severity, 1); // clamped to [0, 1]
});

test('parseResponse strips markdown code fences', () => {
  const body = '```json\n{"gaps":[{"description":"x","priority":"low","severity":0.1}]}\n```';
  const { gaps } = parseResponse(body);
  assert.equal(gaps.length, 1);
});
