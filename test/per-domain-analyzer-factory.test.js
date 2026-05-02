/**
 * Per-domain analyzer factory tests (p4r-6).
 *
 * Verifies the factory implementation fills in p4r-4's skeleton with:
 *   - Happy path per domain (LLM responds with well-formed JSON; schema-valid gaps)
 *   - LLM failure path per domain (llm.chat throws → degraded; gaps:[])
 *   - Schema-validation rejection path per domain (LLM returns wrong-domain
 *     gaps or invalid evidence_refs → degraded; gaps:[])
 *   - Construction-error guards (missing required config throws)
 *   - createPerDomainAnalyzerSet integration (all 5 wired; same llm reference shared)
 *
 * Spec anchors:
 *   - 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md §7.5
 *   - parent MP §4.5 (LLM client injection — same reference across all 5)
 *   - parent MP §4.6 (fail-closed posture — failures return degraded, not throw)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDomainGapAnalyzer,
  createPerDomainAnalyzerSet,
} from '../lib/per-domain-analyzer-factory.js';
import { GAP_DOMAINS, GAP_SCHEMAS } from '../lib/gap-schemas.js';
import { DOMAIN_SLICE_FETCHERS } from '../lib/domain-slice-fetchers.js';
import { MISSION_ANCHORS } from '../lib/domain-prompts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleMission = {
  msp: {
    version: '1.0.0',
    raw_text: '# MSP\n\n## Operational\nKeep organs available.\n\n## Strategic\nAdvance the mission.',
    hash: 'h1',
  },
  bor: {
    version: '1.0.0',
    raw_text: '# BoR\n\n## Article 1\nDo not harm.\n\n## Article 2\nBe transparent.',
    hash: 'h2',
  },
  loaded_at: '2026-05-02T12:00:00Z',
  cache_expires_at: '2026-05-02T12:10:00Z',
  degraded: [],
};

const sampleWorld = {
  radiant: { recent_context: [], recent_memory: [], stats: {} },
  minder: { active_peers: [] },
  hippocampus: { recent_conversations: [] },
  graph_structural: { recent_entities: [], recent_concept_counts_by_type: {} },
  spine_state: {
    recent_transitions: [
      { entity_urn: 'urn:llm-ops:entity:1', transition_id: 't1', timestamp: '2026-05-02T11:55:00Z', type: 'operational' },
      { entity_urn: 'urn:llm-ops:entity:2', transition_id: 't2', timestamp: '2026-05-02T11:56:00Z', type: 'governance' },
    ],
  },
  composed_at: '2026-05-02T12:00:00Z',
  sources_ok: ['Radiant', 'Graph', 'Spine', 'Minder', 'Hippocampus'],
  sources_degraded: [],
  degraded: [],
};

const EVIDENCE = {
  operational: 'urn:llm-ops:spine-transition:t-1',
  strategic: 'urn:llm-ops:radiant:r-1',
  relational: 'urn:llm-ops:minder-peer:leon',
  compliance: 'urn:llm-ops:governance-event:g-1',
  constitutional: 'BoR Article 1',
};

function makeValidGap(domain, evidenceRef = EVIDENCE[domain], priority = 'medium', severity = 0.5) {
  return {
    description: `${domain} gap`,
    target_state: `${domain} aligned`,
    mission_ref: `MSP §${domain}`,
    evidence_refs: [evidenceRef],
    priority,
    severity,
    source_category: domain,
  };
}

function makeMockLlm({ available = true, response = null, throwErr = null } = {}) {
  let chatCalls = 0;
  let lastMessages = null;
  let lastOptions = null;
  const llm = {
    isAvailable: () => available,
    chat: async (messages, options) => {
      chatCalls += 1;
      lastMessages = messages;
      lastOptions = options;
      if (throwErr) throw new Error(throwErr);
      return response;
    },
    getUsage: () => ({}),
  };
  Object.defineProperty(llm, 'chatCalls', { get: () => chatCalls });
  Object.defineProperty(llm, 'lastMessages', { get: () => lastMessages });
  Object.defineProperty(llm, 'lastOptions', { get: () => lastOptions });
  return llm;
}

function makeAnalyzer(domain, { llm, sliceFetcher } = {}) {
  return createDomainGapAnalyzer({
    domain,
    schema: GAP_SCHEMAS[domain],
    sliceFetcher: sliceFetcher || DOMAIN_SLICE_FETCHERS[domain],
    missionAnchor: MISSION_ANCHORS[domain],
    llm: llm || makeMockLlm(),
  });
}

function llmResponseFor(gaps) {
  return { content: JSON.stringify({ gaps }) };
}

// ---------------------------------------------------------------------------
// Happy-path tests (5)
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`createDomainGapAnalyzer(${domain}): happy path returns validated gaps`, async () => {
    const gap = makeValidGap(domain);
    const llm = makeMockLlm({ response: llmResponseFor([gap]) });
    const analyze = makeAnalyzer(domain, { llm });

    const out = await analyze({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
      correlationId: `corr-${domain}-1`,
    });

    assert.equal(out.degraded.length, 0, `expected no degraded entries; got ${JSON.stringify(out.degraded)}`);
    assert.equal(out.gaps.length, 1);
    assert.equal(out.gaps[0].source_category, domain);
    assert.equal(out.gaps[0].evidence_refs[0], EVIDENCE[domain]);
    assert.equal(llm.chatCalls, 1, 'llm.chat should be called exactly once');
  });
}

// ---------------------------------------------------------------------------
// LLM-failure tests (5)
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`createDomainGapAnalyzer(${domain}): llm.chat throw → degraded; gaps:[]`, async () => {
    const llm = makeMockLlm({ throwErr: 'simulated-network-error' });
    const analyze = makeAnalyzer(domain, { llm });

    const out = await analyze({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
      correlationId: `corr-${domain}-2`,
    });

    assert.deepEqual(out.gaps, []);
    assert.equal(out.degraded.length, 1);
    assert.match(out.degraded[0], new RegExp(`^per-domain-${domain}-llm-call-failed:`));
    assert.match(out.degraded[0], /simulated-network-error/);
  });

  test(`createDomainGapAnalyzer(${domain}): llm unavailable → degraded; gaps:[]; no chat`, async () => {
    const llm = makeMockLlm({ available: false });
    const analyze = makeAnalyzer(domain, { llm });

    const out = await analyze({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
    });

    assert.deepEqual(out.gaps, []);
    assert.deepEqual(out.degraded, [`per-domain-${domain}-llm-unavailable`]);
    assert.equal(llm.chatCalls, 0, 'llm.chat must not be called when isAvailable() returns false');
  });
}

// ---------------------------------------------------------------------------
// Schema-validation rejection tests (5)
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`createDomainGapAnalyzer(${domain}): wrong source_category → schema-validation degraded`, async () => {
    const otherDomain = GAP_DOMAINS.find((d) => d !== domain);
    const wrongDomainGap = {
      ...makeValidGap(domain),
      source_category: otherDomain,
    };
    const llm = makeMockLlm({ response: llmResponseFor([wrongDomainGap]) });
    const analyze = makeAnalyzer(domain, { llm });

    const out = await analyze({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
    });

    assert.deepEqual(out.gaps, []);
    assert.equal(out.degraded.length, 1);
    assert.match(out.degraded[0], new RegExp(`^per-domain-${domain}-schema-validation-failed:`));
  });

  test(`createDomainGapAnalyzer(${domain}): off-pattern evidence_refs → schema-validation degraded`, async () => {
    const offPatternGap = {
      ...makeValidGap(domain),
      evidence_refs: ['urn:llm-ops:not-a-valid-class:foo'],
    };
    const llm = makeMockLlm({ response: llmResponseFor([offPatternGap]) });
    const analyze = makeAnalyzer(domain, { llm });

    const out = await analyze({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
    });

    assert.deepEqual(out.gaps, []);
    assert.equal(out.degraded.length, 1);
    assert.match(out.degraded[0], new RegExp(`^per-domain-${domain}-schema-validation-failed:`));
  });
}

// ---------------------------------------------------------------------------
// Parse-failure path
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: invalid JSON in LLM response → parse-failed degraded', async () => {
  const llm = makeMockLlm({ response: { content: 'not valid json {{{' } });
  const analyze = makeAnalyzer('operational', { llm });

  const out = await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.deepEqual(out.gaps, []);
  assert.equal(out.degraded.length, 1);
  assert.match(out.degraded[0], /^per-domain-operational-parse-failed:/);
});

test('createDomainGapAnalyzer: empty LLM content → parse-failed degraded', async () => {
  const llm = makeMockLlm({ response: { content: '' } });
  const analyze = makeAnalyzer('operational', { llm });

  const out = await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.deepEqual(out.gaps, []);
  assert.match(out.degraded[0], /^per-domain-operational-parse-failed:empty-response$/);
});

test('createDomainGapAnalyzer: response missing gaps array → parse-failed degraded', async () => {
  const llm = makeMockLlm({ response: { content: JSON.stringify({ wrongKey: [] }) } });
  const analyze = makeAnalyzer('operational', { llm });

  const out = await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.deepEqual(out.gaps, []);
  assert.match(out.degraded[0], /^per-domain-operational-parse-failed:missing-gaps-array$/);
});

// ---------------------------------------------------------------------------
// Slice-fetch failure path
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: slice-fetcher throw → slice-fetch-failed degraded', async () => {
  const llm = makeMockLlm();
  const failingFetcher = async () => {
    throw new Error('boom');
  };
  const analyze = createDomainGapAnalyzer({
    domain: 'operational',
    schema: GAP_SCHEMAS.operational,
    sliceFetcher: failingFetcher,
    llm,
  });

  const out = await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.deepEqual(out.gaps, []);
  assert.match(out.degraded[0], /^per-domain-operational-slice-fetch-failed:boom$/);
  assert.equal(llm.chatCalls, 0, 'llm.chat must not be called when slice fetch fails');
});

// ---------------------------------------------------------------------------
// Markdown-fence stripping (LLM often wraps responses in ```json fences)
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: markdown-fenced JSON parses cleanly', async () => {
  const gap = makeValidGap('operational');
  const fenced = `\`\`\`json\n${JSON.stringify({ gaps: [gap] })}\n\`\`\``;
  const llm = makeMockLlm({ response: { content: fenced } });
  const analyze = makeAnalyzer('operational', { llm });

  const out = await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.equal(out.gaps.length, 1);
  assert.equal(out.degraded.length, 0);
});

// ---------------------------------------------------------------------------
// correlationId forwarding to llm.chat options
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: correlationId forwarded to llm.chat options', async () => {
  const llm = makeMockLlm({ response: llmResponseFor([makeValidGap('operational')]) });
  const analyze = makeAnalyzer('operational', { llm });

  await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
    correlationId: 'corr-fwd-test',
  });

  assert.ok(llm.lastOptions, 'llm.chat received options');
  assert.equal(llm.lastOptions.correlationId, 'corr-fwd-test');
  assert.equal(typeof llm.lastOptions.system, 'string');
  assert.ok(llm.lastOptions.system.includes('operational gap analyzer'));
});

test('createDomainGapAnalyzer: missing correlationId not added to options', async () => {
  const llm = makeMockLlm({ response: llmResponseFor([makeValidGap('strategic')]) });
  const analyze = makeAnalyzer('strategic', { llm });

  await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });

  assert.ok(llm.lastOptions);
  assert.equal(llm.lastOptions.correlationId, undefined);
});

// ---------------------------------------------------------------------------
// goalHistory fallback (when caller does not supply recentGoals)
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: falls back to goalHistory.list() when recentGoals omitted', async () => {
  const goalHistory = {
    list: () => [{ goal_id: 'g1', description: 'prior', priority: 'high' }],
  };
  const llm = makeMockLlm({ response: llmResponseFor([makeValidGap('operational')]) });
  const analyze = createDomainGapAnalyzer({
    domain: 'operational',
    schema: GAP_SCHEMAS.operational,
    sliceFetcher: DOMAIN_SLICE_FETCHERS.operational,
    llm,
    goalHistory,
  });

  await analyze({
    missionFrame: sampleMission,
    worldState: sampleWorld,
  });

  const userContent = llm.lastMessages[0].content;
  assert.ok(userContent.includes('"goal_id": "g1"'), 'recent goals from goalHistory.list() should appear in prompt');
});

// ---------------------------------------------------------------------------
// Construction-error guards
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: missing domain throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({}),
    /domain must be one of/,
  );
});

test('createDomainGapAnalyzer: unknown domain throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({ domain: 'made-up', schema: {}, sliceFetcher: () => ({}), llm: makeMockLlm() }),
    /domain must be one of/,
  );
});

test('createDomainGapAnalyzer: missing schema throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({ domain: 'operational', sliceFetcher: () => ({}), llm: makeMockLlm() }),
    /schema is required/,
  );
});

test('createDomainGapAnalyzer: missing sliceFetcher throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({ domain: 'operational', schema: GAP_SCHEMAS.operational, llm: makeMockLlm() }),
    /sliceFetcher is required/,
  );
});

test('createDomainGapAnalyzer: missing llm throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({
      domain: 'operational',
      schema: GAP_SCHEMAS.operational,
      sliceFetcher: () => ({}),
    }),
    /llm is required/,
  );
});

test('createDomainGapAnalyzer: malformed llm (no chat) throws', () => {
  assert.throws(
    () => createDomainGapAnalyzer({
      domain: 'operational',
      schema: GAP_SCHEMAS.operational,
      sliceFetcher: () => ({}),
      llm: { isAvailable: () => true },
    }),
    /llm is required/,
  );
});

// ---------------------------------------------------------------------------
// Introspection surface
// ---------------------------------------------------------------------------

test('createDomainGapAnalyzer: analyzer carries domain / schema / llm / systemPrompt / validate', () => {
  const llm = makeMockLlm();
  const analyze = makeAnalyzer('relational', { llm });
  assert.equal(analyze.domain, 'relational');
  assert.equal(analyze.schema, GAP_SCHEMAS.relational);
  assert.equal(analyze.llm, llm);
  assert.equal(typeof analyze.systemPrompt, 'string');
  assert.ok(analyze.systemPrompt.includes('relational gap analyzer'));
  assert.equal(typeof analyze.validate, 'function');
});

// ---------------------------------------------------------------------------
// createPerDomainAnalyzerSet integration
// ---------------------------------------------------------------------------

test('createPerDomainAnalyzerSet: wires all 5 domains with shared llm reference', () => {
  const llm = makeMockLlm();
  const set = createPerDomainAnalyzerSet({
    sliceFetchers: DOMAIN_SLICE_FETCHERS,
    llm,
  });

  assert.deepEqual(
    Object.keys(set).sort(),
    [...GAP_DOMAINS].sort(),
  );
  for (const domain of GAP_DOMAINS) {
    assert.equal(typeof set[domain], 'function', `${domain} analyzer must be a function`);
    assert.equal(set[domain].domain, domain);
    assert.equal(set[domain].llm, llm, `${domain} analyzer must share the same llm reference (§4.5 invariant)`);
    assert.equal(set[domain].schema, GAP_SCHEMAS[domain]);
  }
});

test('createPerDomainAnalyzerSet: missing sliceFetchers throws', () => {
  assert.throws(
    () => createPerDomainAnalyzerSet({ llm: makeMockLlm() }),
    /sliceFetchers map is required/,
  );
});

test('createPerDomainAnalyzerSet: missing llm throws', () => {
  assert.throws(
    () => createPerDomainAnalyzerSet({ sliceFetchers: DOMAIN_SLICE_FETCHERS }),
    /llm is required/,
  );
});

test('createPerDomainAnalyzerSet: missing per-domain sliceFetcher throws', () => {
  const incomplete = { ...DOMAIN_SLICE_FETCHERS };
  delete incomplete.compliance;
  assert.throws(
    () => createPerDomainAnalyzerSet({ sliceFetchers: incomplete, llm: makeMockLlm() }),
    /missing sliceFetcher for domain "compliance"/,
  );
});

test('createPerDomainAnalyzerSet: all 5 analyzers execute end-to-end with shared llm', async () => {
  const responses = {
    operational: llmResponseFor([makeValidGap('operational')]),
    strategic: llmResponseFor([makeValidGap('strategic')]),
    relational: llmResponseFor([makeValidGap('relational')]),
    compliance: llmResponseFor([makeValidGap('compliance')]),
    constitutional: llmResponseFor([makeValidGap('constitutional')]),
  };

  let nextResponseDomain = null;
  const llm = {
    isAvailable: () => true,
    chat: async (messages) => {
      const sys = messages; // unused — reuse via closure below
      // Determine which domain this call is for by sniffing the user content
      // (the closing-focus phrase in domain-prompts.js makes this trivial).
      const userContent = sys[0].content;
      for (const d of GAP_DOMAINS) {
        if (userContent.includes(`Identify the ${d} gaps.`)) {
          nextResponseDomain = d;
          return responses[d];
        }
      }
      throw new Error('test fixture could not detect domain from user content');
    },
    getUsage: () => ({}),
  };

  const set = createPerDomainAnalyzerSet({
    sliceFetchers: DOMAIN_SLICE_FETCHERS,
    llm,
  });

  for (const domain of GAP_DOMAINS) {
    const out = await set[domain]({
      missionFrame: sampleMission,
      worldState: sampleWorld,
      recentGoals: [],
      correlationId: `corr-set-${domain}`,
    });
    assert.equal(out.degraded.length, 0, `${domain}: expected clean run; got ${JSON.stringify(out.degraded)}`);
    assert.equal(out.gaps.length, 1, `${domain}: expected 1 gap`);
    assert.equal(out.gaps[0].source_category, domain);
  }
  assert.equal(nextResponseDomain, 'constitutional', 'last invocation should have been the last loop iteration');
});
