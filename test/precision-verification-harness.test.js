/**
 * precision-verification-harness.test.js — p4r-7 Step 2 harness contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmCaptureTap,
  replayLegacy,
  replayModular,
  replayBoth,
} from '../lib/precision-verification-harness.js';

const SAMPLE_FIXTURE = {
  fixture_id: 'natural-2026-05-03T10:00:00.000Z-aaaaaa',
  phase: 'natural',
  recentGoals_pattern: null,
  missionFrame: {
    msp: { version: '1.0.0', raw_text: '# MSP\n## Test', hash: 'h1' },
    bor: { version: '1.0.0', raw_text: '# BoR\n## Article 1', hash: 'h2' },
    loaded_at: '2026-05-03T10:00:00.000Z',
    cache_expires_at: '2026-05-03T10:10:00.000Z',
    degraded: [],
  },
  worldState: {
    radiant: { recent_context: [], recent_memory: [], stats: {} },
    minder: null,
    hippocampus: null,
    graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
    spine_state: { recent_transitions: [{ entity_urn: 'urn:e:1', transition_id: 't1', timestamp: '2026-05-03T09:55:00Z' }] },
    composed_at: '2026-05-03T10:00:00Z',
    sources_ok: ['Radiant', 'Graph', 'Spine'],
    sources_degraded: [],
    degraded: [],
  },
  recentGoals: [],
  source_correlation_id: 'fix-1',
};

// Mock LLM that returns a canned gap-list response. Models the openai-compatible
// chat() shape: returns { content, model, provider, input_tokens, output_tokens }.
function mockLlm(responseShape = 'legacy') {
  const responses = {
    legacy: JSON.stringify({ gaps: [
      {
        description: 'System needs critical patch',
        target_state: 'Patched',
        mission_ref: 'MSP §safety',
        evidence_refs: ['urn:llm-ops:spine-transition:t1'],
        priority: 'critical',
        severity: 0.9,
        source_category: 'operational',
      },
    ]}),
    'per-domain': (domain) => JSON.stringify({ gaps: [
      {
        description: `${domain}-domain gap detected`,
        target_state: `${domain} aligned`,
        mission_ref: `MSP §${domain}`,
        evidence_refs: domain === 'operational' ? ['urn:llm-ops:spine-transition:t1']
                       : domain === 'strategic' ? ['urn:llm-ops:radiant:r-1']
                       : domain === 'relational' ? ['urn:llm-ops:minder-peer:leon']
                       : domain === 'compliance' ? ['urn:llm-ops:governance-event:g-1']
                       : ['BoR Article 1'],
        priority: 'high',
        severity: 0.7,
        source_category: domain,
      },
    ]}),
  };

  let callCount = 0;
  const PER_DOMAIN_ORDER = ['operational', 'strategic', 'relational', 'compliance', 'constitutional'];

  return {
    isAvailable: () => true,
    chat: async (messages, options) => {
      let content;
      if (responseShape === 'legacy') {
        content = responses.legacy;
      } else {
        // per-domain: cycle through 5 domains
        const domain = PER_DOMAIN_ORDER[callCount % 5];
        content = responses['per-domain'](domain);
        callCount += 1;
      }
      return {
        content,
        model: 'mock-model',
        provider: 'mock',
        input_tokens: 100,
        output_tokens: 50,
      };
    },
    getUsage: () => ({ agent: 'mock', model: 'mock-model', provider: 'mock' }),
  };
}

// --- createLlmCaptureTap ---

test('createLlmCaptureTap: records each chat() call with response content', async () => {
  const llm = mockLlm('legacy');
  const tap = createLlmCaptureTap(llm, { agent: 'test' });
  await tap.chat([{ role: 'user', content: 'hi' }], { system: 'sys' });
  await tap.chat([{ role: 'user', content: 'bye' }], { system: 'sys' });
  const calls = tap.getCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].response?.content);
  assert.equal(calls[0].agent, 'test');
});

test('createLlmCaptureTap: drainCalls clears internal log', async () => {
  const tap = createLlmCaptureTap(mockLlm('legacy'));
  await tap.chat([{ role: 'user', content: 'hi' }], {});
  assert.equal(tap.callCount(), 1);
  tap.drainCalls();
  assert.equal(tap.callCount(), 0);
});

test('createLlmCaptureTap: propagates errors from inner llm', async () => {
  const tap = createLlmCaptureTap({
    isAvailable: () => true,
    chat: async () => { throw new Error('upstream-error'); },
  });
  await assert.rejects(() => tap.chat([], {}), /upstream-error/);
  // Error case still records the call
  assert.equal(tap.callCount(), 1);
  assert.equal(tap.getCalls()[0].error, 'upstream-error');
});

// --- replayLegacy ---

test('replayLegacy: produces gaps, raw_response, llm_calls', async () => {
  const ctx = { llm: mockLlm('legacy'), llmConfig: { agentName: 'test', maxTokens: 4096 } };
  const result = await replayLegacy(SAMPLE_FIXTURE, ctx);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].priority, 'critical');
  assert.ok(result.raw_response, 'raw_response captured');
  assert.equal(result.llm_calls.length, 1);
  assert.ok(result.correlation_id.startsWith('replay-legacy-'));
});

// --- replayModular ---

test('replayModular: produces gaps + per_domain_outputs', async () => {
  const ctx = { llm: mockLlm('per-domain'), llmConfig: { agentName: 'test', maxTokens: 4096 } };
  const result = await replayModular(SAMPLE_FIXTURE, ctx);
  // 5 per-domain analyzers → 5 LLM calls (or per-domain failures producing degraded)
  assert.equal(result.llm_calls.length, 5);
  // per_domain_outputs should record each of the 5 domain analyzer calls
  assert.equal(result.per_domain_outputs.length, 5);
  const domains = result.per_domain_outputs.map(o => o.domain).sort();
  assert.deepEqual(domains, ['compliance', 'constitutional', 'operational', 'relational', 'strategic']);
});

test('replayModular: each per-domain analyzer emits same source_category as its domain (clean run)', async () => {
  const ctx = { llm: mockLlm('per-domain'), llmConfig: { agentName: 'test', maxTokens: 4096 } };
  const result = await replayModular(SAMPLE_FIXTURE, ctx);
  for (const out of result.per_domain_outputs) {
    for (const g of out.gaps) {
      assert.equal(g.source_category, out.domain, `domain ${out.domain} emitted gap with source_category=${g.source_category}`);
    }
  }
});

// --- replayBoth ---

test('replayBoth: returns both legacy + modular envelopes with fixture metadata', async () => {
  const ctx = { llm: mockLlm('legacy'), llmConfig: { agentName: 'test', maxTokens: 4096 } };
  const result = await replayBoth(SAMPLE_FIXTURE, ctx);
  assert.equal(result.fixture_id, SAMPLE_FIXTURE.fixture_id);
  assert.equal(result.phase, 'natural');
  assert.ok(result.legacy);
  assert.ok(result.modular);
  assert.ok(result.replayed_at);
});
