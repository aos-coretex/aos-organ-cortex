/**
 * cv-instrumentation-events — verifies that the p4r-2 instrumentation events
 * fire on every gap-analysis cycle with the correct shape:
 *
 *   1. cortex_prompt_size_breakdown — emitted after buildPrompt(), includes
 *      a 'system-prompt' section and a per-cycle correlation_id.
 *   2. cortex_prompt_provider_tokens — emitted after llm.chat() returns,
 *      pairs the cl100k_base breakdown with the provider-side input_tokens
 *      via the same correlation_id (Path A per relay §1b: authoritative
 *      provider count from response.usage rather than per-shape calibration).
 *   3. cortex_gap_analysis_response — emitted after llm.chat() returns and
 *      before parsing; carries raw response_text, model, provider, and
 *      correlation_id (the load-bearing event for p4r-7 empirical replay).
 *
 * Also enriched in this relay:
 *   - cortex_goal_dispatched — now includes source_category + description.
 *
 * The CV signal these tests guard is "instrumentation is wired and stays
 * wired." If a future change removes any of these events, the empirical
 * gates of p4r-7 (fixture replay) and p4r-9 (soak validation) lose their
 * anchors. Tests fail-loud rather than fail-silent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalEmitter } from '../lib/goal-emitter.js';
import { createGoalHistory } from '../lib/goal-history.js';
import { createCmClient } from '../lib/cm-client.js';

// Capture process.stdout for the duration of fn(); return parsed JSON event lines.
async function captureEvents(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : (chunk?.toString?.('utf8') ?? '');
    for (const line of text.split('\n')) {
      if (line.trim()) lines.push(line);
    }
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  const events = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.event) events.push(obj);
    } catch {
      // skip non-JSON lines (test runner output mixes in)
    }
  }
  return events;
}

const sampleMission = {
  msp: { version: '1.0.0-seed', raw_text: '# MSP\n\n## Purpose\nKeep services healthy.', hash: 'h1' },
  bor: { version: '1.0.0',      raw_text: '# BoR\n\n## Article 1\nNo destructive ops.', hash: 'h2' },
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
  sources_ok: ['Radiant', 'Graph', 'Spine'],
  sources_degraded: [],
  degraded: [],
};

const llmResponse = {
  content: JSON.stringify({
    gaps: [{
      description: 'Backups have not run in 8 days',
      target_state: 'Daily backup cycle resumed',
      mission_ref: 'MSP §Operational Continuity',
      evidence_refs: ['urn:test:radiant:1'],
      priority: 'high',
      severity: 0.9,
      source_category: 'operational',
    }],
  }),
  model: 'deepseek/deepseek-v4-pro',
  input_tokens: 1234,
  output_tokens: 56,
};

function makeAnalyzer({ throwOnChat = false } = {}) {
  const llm = {
    isAvailable: () => true,
    chat: async () => {
      if (throwOnChat) throw new Error('endpoint-down');
      return llmResponse;
    },
    getUsage: () => ({}),
  };
  return createGapAnalyzer({
    llmConfig: {
      agentName: 'gap-analyzer',
      defaultModel: 'deepseek/deepseek-v4-pro',
      defaultProvider: 'openai-compatible',
      apiKeyEnvVar: 'LOCAL_LLM_API_KEY',
      maxTokens: 16384,
    },
    injectedLlm: llm,
    goalHistory: createGoalHistory(),
  });
}

test('cortex_prompt_size_breakdown emits per cycle with system-prompt section + correlation_id', async () => {
  const analyzer = makeAnalyzer();
  const events = await captureEvents(() => analyzer(sampleMission, sampleWorld));

  const breakdown = events.find(e => e.event === 'cortex_prompt_size_breakdown');
  assert.ok(breakdown, 'cortex_prompt_size_breakdown must be emitted per cycle');
  assert.ok(breakdown.sections, 'breakdown must include sections');
  assert.equal(typeof breakdown.sections['system-prompt'], 'number', 'system-prompt section must be measured');
  assert.ok(breakdown.sections['system-prompt'] > 0, 'system-prompt token count must be positive');
  assert.equal(typeof breakdown.correlation_id, 'string', 'correlation_id must be present and string');
  assert.ok(breakdown.aggregate >= breakdown.sections['system-prompt'], 'aggregate must include system-prompt tokens');
});

test('cortex_prompt_provider_tokens emits after chat() returns with response usage', async () => {
  const analyzer = makeAnalyzer();
  const events = await captureEvents(() => analyzer(sampleMission, sampleWorld));

  const providerEvent = events.find(e => e.event === 'cortex_prompt_provider_tokens');
  assert.ok(providerEvent, 'cortex_prompt_provider_tokens must be emitted per cycle');
  assert.equal(providerEvent.provider_tokens, llmResponse.input_tokens, 'provider_tokens must reflect response.input_tokens');
  assert.equal(providerEvent.output_tokens, llmResponse.output_tokens);
  assert.equal(providerEvent.model, llmResponse.model);
  assert.equal(providerEvent.provider, 'openai-compatible');
  assert.equal(providerEvent.agent, 'gap-analyzer');
  assert.equal(typeof providerEvent.correlation_id, 'string');

  const breakdown = events.find(e => e.event === 'cortex_prompt_size_breakdown');
  assert.equal(providerEvent.correlation_id, breakdown.correlation_id, 'correlation_id must link breakdown to provider-tokens event');
});

test('cortex_gap_analysis_response carries raw response_text + correlation_id', async () => {
  const analyzer = makeAnalyzer();
  const events = await captureEvents(() => analyzer(sampleMission, sampleWorld));

  const respEvent = events.find(e => e.event === 'cortex_gap_analysis_response');
  assert.ok(respEvent, 'cortex_gap_analysis_response must be emitted per cycle');
  assert.equal(respEvent.response_text, llmResponse.content, 'response_text must be the raw LLM content');
  assert.equal(respEvent.agent, 'gap-analyzer');
  assert.equal(respEvent.model, llmResponse.model);
  assert.equal(respEvent.provider, 'openai-compatible');
  assert.equal(typeof respEvent.correlation_id, 'string');

  const breakdown = events.find(e => e.event === 'cortex_prompt_size_breakdown');
  assert.equal(respEvent.correlation_id, breakdown.correlation_id, 'response event must share correlation_id with breakdown');
});

test('cortex_gap_analysis_response is NOT emitted when chat throws (degraded path)', async () => {
  const analyzer = makeAnalyzer({ throwOnChat: true });
  const events = await captureEvents(() => analyzer(sampleMission, sampleWorld));

  // Breakdown still emits (computed at prompt-build time, before chat).
  assert.ok(events.find(e => e.event === 'cortex_prompt_size_breakdown'), 'breakdown must emit even on chat failure');
  // Provider/raw events are post-chat — must NOT emit when chat throws.
  assert.equal(events.find(e => e.event === 'cortex_prompt_provider_tokens'), undefined);
  assert.equal(events.find(e => e.event === 'cortex_gap_analysis_response'), undefined);
  // The error log must carry the correlation_id so observers can stitch it back.
  const errEvent = events.find(e => e.event === 'cortex_gap_analysis_llm_error');
  assert.ok(errEvent, 'error event must be emitted on chat failure');
  assert.equal(typeof errEvent.correlation_id, 'string');
});

test('cortex_world_state_cache_breakdown emits per readWorldState() with per-slice metrics + correlation_id (p4r-3 §Step 5)', async () => {
  // Route mock for all 5 slice fetches.
  globalThis.fetch = async (url) => {
    if (url.includes('/context')) return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/memory'))  return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/stats'))   return { ok: true, status: 200, json: async () => ({ context_count: 0 }) };
    if (url.includes('/peers/recent'))        return { ok: true, status: 200, json: async () => ({ peers: [] }) };
    if (url.includes('/observations/recent')) return { ok: true, status: 200, json: async () => ({ observations: [] }) };
    if (url.includes('/conversations')) return { ok: true, status: 200, json: async () => ({ conversations: [] }) };
    if (url.includes('/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    if (url.includes('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cmClient = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: { queryConcepts: async () => ({ rows: [] }) },
    spineUrl: 'http://s',
  });
  const events = await captureEvents(async () => { await cmClient({}); });
  const breakdown = events.find(e => e.event === 'cortex_world_state_cache_breakdown');
  assert.ok(breakdown, 'cortex_world_state_cache_breakdown must emit per readWorldState');
  assert.equal(typeof breakdown.correlation_id, 'string');
  assert.ok(breakdown.slices);
  // All 5 slices reported
  assert.ok(breakdown.slices.radiant);
  assert.ok(breakdown.slices.minder);
  assert.ok(breakdown.slices.hippocampus);
  assert.ok(breakdown.slices.graph_structural);
  assert.ok(breakdown.slices.spine_state);
  // First call: every cacheable slice is a miss with fetched_ms
  assert.equal(breakdown.slices.radiant.hit, false);
  assert.equal(typeof breakdown.slices.radiant.fetched_ms, 'number');
  assert.equal(typeof breakdown.slices.radiant.tokens_cl100k, 'number');
  // spine_state always reports new_transitions + evicted (cursor design, not TTL)
  assert.equal(typeof breakdown.slices.spine_state.new_transitions, 'number');
  assert.equal(typeof breakdown.slices.spine_state.evicted, 'number');
  // tokens_cl100k present on every slice
  for (const sliceName of ['radiant', 'minder', 'hippocampus', 'graph_structural', 'spine_state']) {
    assert.equal(typeof breakdown.slices[sliceName].tokens_cl100k, 'number');
  }
});

test('cortex_world_state_cache_breakdown reports hit:true on second readWorldState within TTL (p4r-3 cache leverage)', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('/context')) return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/memory'))  return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
    if (url.includes('/stats'))   return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/peers/recent'))        return { ok: true, status: 200, json: async () => ({ peers: [] }) };
    if (url.includes('/observations/recent')) return { ok: true, status: 200, json: async () => ({ observations: [] }) };
    if (url.includes('/conversations')) return { ok: true, status: 200, json: async () => ({ conversations: [] }) };
    if (url.includes('/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    if (url.includes('/health')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cmClient = createCmClient({
    radiantUrl: 'http://r', minderUrl: 'http://m', hippocampusUrl: 'http://h',
    graphAdapter: { queryConcepts: async () => ({ rows: [] }) },
    spineUrl: 'http://s',
  });
  const events = await captureEvents(async () => {
    await cmClient({});
    await cmClient({});
  });
  const breakdowns = events.filter(e => e.event === 'cortex_world_state_cache_breakdown');
  assert.equal(breakdowns.length, 2, 'one breakdown per readWorldState');
  // Second call: 4 cacheable slices report hit:true; spine_state always misses (cursor design)
  assert.equal(breakdowns[1].slices.radiant.hit, true);
  assert.equal(breakdowns[1].slices.minder.hit, true);
  assert.equal(breakdowns[1].slices.hippocampus.hit, true);
  assert.equal(breakdowns[1].slices.graph_structural.hit, true);
  assert.equal(breakdowns[1].slices.spine_state.hit, false);
  // Each cache hit reports age_ms; misses report fetched_ms
  assert.equal(typeof breakdowns[1].slices.radiant.age_ms, 'number');
});

test('cortex_goal_dispatched log event includes source_category + description (p4r-2 §1d)', async () => {
  const fakeSpine = {
    send: async () => ({ message_id: 'urn:llm-ops:otm:spine-minted-x', routing: 'directed' }),
  };
  const emitter = createGoalEmitter({
    spine: fakeSpine,
    goalHistory: createGoalHistory(),
    getIteration: () => 1,
  });

  const sampleGap = {
    gap_id: 'urn:llm-ops:cortex-gap:test-1',
    priority: 'high',
    description: 'Backups have not run in 8 days',
    target_state: 'Daily backup cycle resumed',
    mission_ref: 'MSP §Operational Continuity',
    evidence_refs: [],
    severity: 0.9,
    source_category: 'operational',
  };
  const events = await captureEvents(() => emitter(sampleGap, sampleMission));
  const dispatched = events.find(e => e.event === 'cortex_goal_dispatched');
  assert.ok(dispatched, 'cortex_goal_dispatched must be emitted on successful dispatch');
  assert.equal(dispatched.source_category, 'operational', 'source_category must be enriched into the log event');
  assert.equal(dispatched.description, 'Backups have not run in 8 days', 'description must be enriched into the log event');
});
