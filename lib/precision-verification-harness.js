/**
 * p4r-7 precision-verification harness — Path III + Phase 1+2.
 *
 * Loads a fixture (missionFrame + worldState + recentGoals + ids) and replays
 * it through both:
 *   - Legacy single-pass: createGapAnalyzer({ ..., perDomainAnalyzers: undefined })
 *   - Modular per-domain: createGapAnalyzer({ ..., perDomainAnalyzers: <set> })
 *
 * Same LLM client is shared across both paths (per p4r-6 §4.5 invariant — same
 * `llm` reference forwarded into all 5 per-domain analyzers + the legacy path).
 *
 * Captures per-call raw LLM response text via an LLM-tap wrapper, keyed by an
 * internal "call-id" minted on each chat() invocation. Caller picks up the raw
 * text by call-id after legacy/modular runs complete. Per-call ids decouple
 * legacy's single chat() invocation from modular's 5-fanout invocations.
 *
 * Per-domain output tracking: modular path wraps each per-domain analyzer to
 * record the (domain, gaps[], degraded[]) triple per replay — feeds Step 5
 * cross-pollination measurement (gaps emitted with mismatched source_category).
 *
 * Anchor: RFI-2 reply (2026-05-03 10:30 EDT) — Path III + Phase 1+2 ratified.
 */

import { randomUUID } from 'node:crypto';
import { createGapAnalyzer } from './gap-analyzer.js';
import { createGoalHistory } from './goal-history.js';
import { createPerDomainAnalyzerSet } from './per-domain-analyzer-factory.js';
import { DOMAIN_SLICE_FETCHERS } from './domain-slice-fetchers.js';

/**
 * Wrap an LLM client to capture every chat() call's raw response text.
 * The wrapper preserves chat()'s contract (returns the response object) and
 * additionally stores `{ call_id, agent, messages, response, captured_at }`
 * tuples in an internal log accessible via getCalls() / drainCalls().
 */
export function createLlmCaptureTap(innerLlm, { agent } = {}) {
  const calls = [];

  async function chat(messages, options) {
    const call_id = randomUUID();
    const captured_at = new Date().toISOString();
    let response, error;
    try {
      response = await innerLlm.chat(messages, options);
    } catch (err) {
      error = err;
    }
    calls.push({
      call_id,
      agent,
      messages,
      options,
      response: response ? {
        content: response.content,
        model: response.model ?? null,
        provider: response.provider ?? null,
        input_tokens: response.input_tokens ?? null,
        output_tokens: response.output_tokens ?? null,
      } : null,
      error: error ? error.message : null,
      captured_at,
    });
    if (error) throw error;
    return response;
  }

  return {
    isAvailable: () => innerLlm.isAvailable(),
    chat,
    getUsage: typeof innerLlm.getUsage === 'function' ? () => innerLlm.getUsage() : undefined,
    getCalls: () => [...calls],
    drainCalls: () => {
      const out = [...calls];
      calls.length = 0;
      return out;
    },
    callCount: () => calls.length,
  };
}

/**
 * Wrap a per-domain analyzer to record (domain, gaps[], degraded[]) on every
 * call. Enables Step 5 cross-pollination measurement.
 */
function wrapPerDomainAnalyzer(analyzer, recorder) {
  const domain = analyzer.domain;
  const wrapped = async (args) => {
    const out = await analyzer(args);
    recorder.push({
      domain,
      gaps: out.gaps,
      degraded: out.degraded,
    });
    return out;
  };
  // Preserve introspection surface
  wrapped.domain = analyzer.domain;
  wrapped.schema = analyzer.schema;
  wrapped.sliceFetcher = analyzer.sliceFetcher;
  wrapped.missionAnchor = analyzer.missionAnchor;
  wrapped.llm = analyzer.llm;
  wrapped.systemPrompt = analyzer.systemPrompt;
  wrapped.validate = analyzer.validate;
  return wrapped;
}

/**
 * Build a goalHistory pre-loaded with the fixture's recentGoals.
 */
function seedGoalHistory(recentGoals) {
  const gh = createGoalHistory({ limit: Math.max(20, recentGoals.length) });
  for (const goal of recentGoals) {
    gh.add(goal);
  }
  return gh;
}

/**
 * Replay one fixture through legacy single-pass.
 *
 * @param {object} fixture - { fixture_id, missionFrame, worldState, recentGoals }
 * @param {object} ctx     - { llm, llmConfig }
 * @returns {object} { gaps, degraded, raw_response, llm_calls, latency_ms }
 */
export async function replayLegacy(fixture, ctx) {
  const goalHistory = seedGoalHistory(fixture.recentGoals);
  const llmTap = createLlmCaptureTap(ctx.llm, { agent: 'legacy-gap-analyzer' });
  const gapAnalyzer = createGapAnalyzer({
    llmConfig: ctx.llmConfig,
    injectedLlm: llmTap,
    goalHistory,
    // perDomainAnalyzers: undefined → legacy single-pass
  });

  const correlationId = `replay-legacy-${fixture.fixture_id}`;
  const t0 = Date.now();
  const result = await gapAnalyzer(fixture.missionFrame, fixture.worldState, { correlationId });
  const latency_ms = Date.now() - t0;

  const calls = llmTap.drainCalls();
  // Legacy single-pass should make exactly 1 LLM call (or 0 if unavailable/skip)
  const raw_response = calls[0]?.response?.content ?? null;

  return {
    gaps: result.gaps,
    degraded: result.degraded,
    raw_response,
    llm_calls: calls,
    correlation_id: correlationId,
    latency_ms,
  };
}

/**
 * Replay one fixture through modular per-domain reassembly.
 *
 * @param {object} fixture - { fixture_id, missionFrame, worldState, recentGoals }
 * @param {object} ctx     - { llm, llmConfig, sliceFetchers? }
 * @returns {object} { gaps, degraded, raw_responses, per_domain_outputs, llm_calls, latency_ms }
 */
export async function replayModular(fixture, ctx) {
  const goalHistory = seedGoalHistory(fixture.recentGoals);
  const llmTap = createLlmCaptureTap(ctx.llm, { agent: 'modular-per-domain' });
  const perDomainSet = createPerDomainAnalyzerSet({
    sliceFetchers: ctx.sliceFetchers || DOMAIN_SLICE_FETCHERS,
    llm: llmTap,
    goalHistory,
  });

  const perDomainOutputs = [];
  const wrappedSet = {};
  for (const [domain, analyzer] of Object.entries(perDomainSet)) {
    wrappedSet[domain] = wrapPerDomainAnalyzer(analyzer, perDomainOutputs);
  }

  const gapAnalyzer = createGapAnalyzer({
    llmConfig: ctx.llmConfig,
    injectedLlm: llmTap,
    goalHistory,
    perDomainAnalyzers: wrappedSet,
  });

  const correlationId = `replay-modular-${fixture.fixture_id}`;
  const t0 = Date.now();
  const result = await gapAnalyzer(fixture.missionFrame, fixture.worldState, { correlationId });
  const latency_ms = Date.now() - t0;

  const calls = llmTap.drainCalls();
  // Modular path makes 5 LLM calls (one per domain); raw_responses keyed by index
  const raw_responses = calls.map(c => c.response?.content ?? null);

  return {
    gaps: result.gaps,
    degraded: result.degraded,
    raw_responses,
    per_domain_outputs: perDomainOutputs,
    llm_calls: calls,
    correlation_id: correlationId,
    latency_ms,
  };
}

/**
 * Top-level helper: replay one fixture through both modes sequentially.
 *
 * Sharing the same LLM reference across modes preserves the §4.5 invariant
 * AND ensures fairness (both modes hit the same provider, model, token-budget).
 */
export async function replayBoth(fixture, ctx) {
  const legacy = await replayLegacy(fixture, ctx);
  const modular = await replayModular(fixture, ctx);
  return {
    fixture_id: fixture.fixture_id,
    phase: fixture.phase,
    recentGoals_pattern: fixture.recentGoals_pattern,
    legacy,
    modular,
    replayed_at: new Date().toISOString(),
  };
}
