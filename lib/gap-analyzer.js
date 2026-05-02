/**
 * Gap analyzer — Sonnet-assisted strategic assessment.
 *
 * Fail-closed posture: any LLM failure (unavailable, error, parse failure)
 * produces { gaps: [], degraded: [...] }. Zero gaps is indistinguishable from
 * aligned organism — the loop grows its idle interval. This is safer than
 * emitting garbage goals.
 *
 * MP-CONFIG-1 R7 (l9m-7): LLM client is loader-derived and injected at boot
 * as `injectedLlm`. Tests inject mocks directly. Unavailable-stub default
 * preserves existing test fixtures that construct without an injected client.
 * The `llmConfig` field is preserved for backward-compatible access to
 * `maxTokens` (and any future per-call option derived from resolved settings);
 * shared-lib field names per bug #8 are untouched by migration.
 *
 * Bug #2: llm.chat(messages, { system }) — system prompt passed in options,
 * not as a message turn.
 */

import { randomUUID } from 'node:crypto';
import { buildPrompt, parseResponse, SYSTEM_PROMPT } from '../agents/gap-analyzer-agent.js';
import { measurePromptBreakdown } from './prompt-size-instrumentation.js';
import { validateGapDomainSchema } from './gap-schemas.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * @param {object} config
 * @param {object} config.llmConfig          - { agentName, defaultModel, defaultProvider, apiKeyEnvVar, maxTokens }
 * @param {object} [config.injectedLlm]      - optional LLM client stub for tests
 * @param {object} config.goalHistory        - goal-history store (list() returns recent goals)
 * @param {object} [config.perDomainAnalyzers] - p4r-4 reassembly mode. When provided,
 *   the analyzer fans out to { operational, strategic, relational, compliance,
 *   constitutional } per-domain analyzers (Promise.allSettled), validates each
 *   per-domain output via validateGapDomainSchema, concatenates gaps[], sorts by
 *   PRIORITY_ORDER+severity, and returns the unified Thalamus-shape envelope.
 *   When absent (default), the analyzer follows the p4r-3 single-pass path.
 *   p4r-6 lands the per-domain analyzer implementations; p4r-5 wires them into
 *   cadence; this scaffolding supports both.
 * @returns {(missionFrame, worldState, opts?) => Promise<{ gaps, degraded }>}
 *   opts may include { correlationId } — when provided (post-p4r-3, threaded
 *   from cm-client via loop-wrappers), the analyzer reuses the id so its
 *   cortex_prompt_size_breakdown / provider_tokens / response events stitch
 *   to cortex_world_state_cache_breakdown on the shared id. When omitted
 *   (legacy callers, tests without wrapper plumbing), a fresh id is minted
 *   per cycle as before. p4r-4 reassembly forwards the same correlation_id to
 *   each per-domain analyzer so their telemetry stitches to the parent cycle.
 */
export function createGapAnalyzer(config) {
  const { llmConfig, injectedLlm, goalHistory, perDomainAnalyzers } = config;
  // MP-CONFIG-1 R7: boot injects a loader-derived cascade-wrapped client.
  // Tests inject mocks. Fall through to an unavailable stub that satisfies
  // `.isAvailable() === false` (preserves the fail-closed `degraded.push('llm-unavailable')`
  // branch for any test that constructs without explicit injection).
  const llm = injectedLlm || {
    isAvailable: () => false,
    chat: async () => {
      const err = new Error('Cortex gap-analyzer: no LLM client wired; boot path must inject one (MP-CONFIG-1 R7)');
      err.code = 'LLM_UNAVAILABLE';
      throw err;
    },
    getUsage: () => ({}),
  };

  async function analyzeGaps(missionFrame, worldState, opts = {}) {
    const degraded = [];

    // Propagate upstream degraded flags — the LLM prompt acknowledges missing sources
    if (missionFrame?.degraded?.length) degraded.push(...missionFrame.degraded.map(d => `mission:${d}`));
    if (worldState?.degraded?.length)   degraded.push(...worldState.degraded.map(d => `world:${d}`));

    // Require at least some mission data (otherwise strategic assessment is meaningless)
    const missionAbsent = !missionFrame?.msp && !missionFrame?.bor;
    if (missionAbsent) {
      log('cortex_gap_analysis_skipped', { reason: 'both-mission-sources-absent' });
      degraded.push('mission-fully-absent');
      return { gaps: [], degraded };
    }

    // Require spine_state (operational reality) — if null, the loop engine should have halted before reaching here
    if (!worldState?.spine_state) {
      log('cortex_gap_analysis_skipped', { reason: 'spine-state-absent' });
      degraded.push('spine-state-absent-at-analysis');
      return { gaps: [], degraded };
    }

    const recentGoals = goalHistory?.list ? goalHistory.list() : [];

    // p4r-2 §1a + §1c: per-cycle correlation_id ties the prompt-size breakdown,
    // the post-call provider-tokens event, and the raw-response event together
    // so p4r-7 fixture replay can stitch them.
    // p4r-3: when cm-client's wrappedCmClient threads its correlation_id forward
    // (via loop-wrappers gap-analyzer-wrapper opts), reuse it so the
    // cortex_world_state_cache_breakdown and the prompt events stitch on a
    // shared id within one cycle. Fall through to a fresh id otherwise.
    // p4r-4: id is minted before the per-domain branch so reassembly fan-out
    // can forward the SAME id to each per-domain analyzer (telemetry stitches
    // to the parent cycle's cortex_world_state_cache_breakdown).
    const correlationId = opts.correlationId || randomUUID();

    // p4r-4 reassembly mode — config.perDomainAnalyzers gates the fan-out.
    // Pre-flight gates (mission + spine) run before this branch in both modes.
    // The per-domain path bypasses the single LLM availability check (each
    // analyzer brings its own LLM client via the factory at p4r-6); the
    // single-pass `llm.isAvailable()` check below is single-pass-only.
    if (perDomainAnalyzers) {
      return await runPerDomainReassembly({
        analyzers: perDomainAnalyzers,
        missionFrame,
        worldState,
        recentGoals,
        correlationId,
        degraded,
      });
    }

    if (!llm.isAvailable()) {
      log('cortex_gap_analysis_llm_unavailable');
      degraded.push('llm-unavailable');
      return { gaps: [], degraded };
    }

    const userContent = buildPrompt({ missionFrame, worldState, recentGoals });

    // p4r-2 §1a: emit cl100k_base section breakdown immediately after prompt
    // composition. Includes SYSTEM_PROMPT as the 5th static section (spec §2).
    measurePromptBreakdown({
      missionFrame,
      worldState,
      recentGoals,
      fullPrompt: userContent,
      systemPrompt: SYSTEM_PROMPT,
      correlationId,
    });

    let response;
    try {
      // Bug #2: system prompt is an OPTION, not a message turn.
      response = await llm.chat(
        [{ role: 'user', content: userContent }],
        { system: SYSTEM_PROMPT, maxTokens: llmConfig?.maxTokens },
      );
    } catch (err) {
      log('cortex_gap_analysis_llm_error', { error: err.message, correlation_id: correlationId });
      degraded.push('llm-error');
      return { gaps: [], degraded };
    }

    // p4r-2 §1b (Path A — provider-side authoritative count): emit the provider's
    // own input-token count from the response usage. Pairs with the cl100k_base
    // breakdown via correlation_id, enabling per-cycle 2.5× tokenizer-asymmetry
    // measurement against the openai-compatible endpoint serving Cortex.
    log('cortex_prompt_provider_tokens', {
      correlation_id: correlationId,
      provider_tokens: response?.input_tokens ?? null,
      output_tokens:   response?.output_tokens ?? null,
      model:           response?.model ?? llmConfig?.defaultModel ?? null,
      provider:        llmConfig?.defaultProvider ?? null,
      agent:           'gap-analyzer',
    });

    // p4r-2 §1c: emit raw response text for p4r-7 empirical replay fixtures.
    // Full-response logging chosen per relay's architectural recommendation;
    // disk-impact review deferred to p4r-9 soak.
    log('cortex_gap_analysis_response', {
      agent:          'gap-analyzer',
      correlation_id: correlationId,
      response_text:  response?.content ?? '',
      model:          response?.model ?? llmConfig?.defaultModel ?? null,
      provider:       llmConfig?.defaultProvider ?? null,
      input_tokens:   response?.input_tokens ?? null,
      output_tokens:  response?.output_tokens ?? null,
    });

    const { gaps: parsed, error: parseError } = parseResponse(response?.content);
    if (parseError || parsed === null) {
      log('cortex_gap_analysis_parse_error', { error: parseError });
      degraded.push(`llm-parse-error: ${parseError}`);
      return { gaps: [], degraded };
    }

    // Prioritize: priority (asc by PRIORITY_ORDER) then severity (desc) then original index
    const sorted = parsed.slice().sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      if (b.severity !== a.severity) return b.severity - a.severity;
      return a._originalIndex - b._originalIndex;
    });

    // Assign URNs
    const nowIso = new Date().toISOString();
    const finalized = sorted.map((g, idx) => ({
      gap_id: `urn:llm-ops:cortex-gap:${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
      priority:        g.priority,
      description:     g.description,
      target_state:    g.target_state,
      mission_ref:     g.mission_ref,
      evidence_refs:   g.evidence_refs,
      severity:        g.severity,
      source_category: g.source_category,
      analyzed_at:     nowIso,
    }));

    log('cortex_gap_analysis_complete', {
      gap_count: finalized.length,
      top_priority: finalized[0]?.priority || null,
      degraded_count: degraded.length,
    });

    return { gaps: finalized, degraded };
  }

  // x2p-7 §6.2: attach the llm reference to the returned function so
  // server/index.js can thread it into buildHealthCheck for real
  // llm_available reporting (instead of the hardcoded "true" approximation
  // documented as x2p-6 O3).
  analyzeGaps.llm = llm;

  // p4r-4: expose the per-domain analyzer map (when wired) for introspection
  // by p4r-5 cadence integration and for test/health reporting.
  analyzeGaps.perDomainAnalyzers = perDomainAnalyzers ?? null;

  return analyzeGaps;
}

/**
 * p4r-4 reassembly path — fan out to the per-domain analyzer map, validate each
 * per-domain output against its schema, concatenate gaps[], and sort by
 * PRIORITY_ORDER+severity. Returns the unified Thalamus consumer-shape envelope
 * { gaps, degraded } (parent MP §4.4 output schema continuity).
 *
 * Fail-closed semantics (parent MP §4.6) — any per-domain failure surfaces as
 * a `per-domain-<domain>-failed:<msg>` degraded entry. Promise.allSettled
 * orchestration prevents one failing analyzer from cascading into the others.
 *
 * Schema-purity invariant (spec §7.3 CV test) — validateGapDomainSchema rejects
 * any gap whose source_category does not match the domain or whose evidence_refs
 * lack the required URN/article-ref pattern. Schema-rejected outputs collapse to
 * `per-domain-<domain>-failed:<schema-message>` degraded.
 *
 * Telemetry — emits cortex_per_domain_reassembly_start (intent) and
 * cortex_per_domain_reassembly_complete (outcome) events stitched on the
 * parent cycle's correlation_id (p4r-2 / p4r-3 pattern extended).
 */
async function runPerDomainReassembly({
  analyzers,
  missionFrame,
  worldState,
  recentGoals,
  correlationId,
  degraded,
}) {
  const domainEntries = Object.entries(analyzers);

  log('cortex_per_domain_reassembly_start', {
    correlation_id: correlationId,
    domains: domainEntries.map(([d]) => d),
  });

  const settledResults = await Promise.allSettled(
    domainEntries.map(async ([domain, analyzer]) => {
      try {
        const out = await analyzer({ missionFrame, worldState, recentGoals, correlationId });
        const gaps = Array.isArray(out?.gaps) ? out.gaps : [];
        // Per-domain schema-purity assertion — schema violation surfaces as
        // a per-domain failure (degraded entry), gaps from this domain dropped.
        validateGapDomainSchema(domain, gaps);
        return {
          domain,
          gaps,
          degraded: Array.isArray(out?.degraded) ? out.degraded : [],
        };
      } catch (err) {
        return {
          domain,
          gaps: [],
          degraded: [`per-domain-${domain}-failed:${err.message}`],
        };
      }
    }),
  );

  const allGaps = [];
  const allDegraded = [...degraded];
  let domainsClean = 0;
  let domainsWithDegraded = 0;
  let domainsRejected = 0;

  for (const settled of settledResults) {
    if (settled.status === 'fulfilled') {
      const { gaps, degraded: domainDegraded } = settled.value;
      allGaps.push(...gaps);
      allDegraded.push(...domainDegraded);
      if (domainDegraded.length === 0) domainsClean += 1;
      else domainsWithDegraded += 1;
    } else {
      domainsRejected += 1;
      allDegraded.push(`per-domain-rejected:${settled.reason?.message || 'unknown'}`);
    }
  }

  // PRIORITY_ORDER asc, severity desc — mirrors single-pass sort (spec §Step 2
  // critical invariant; parent MP §Architectural invariants).
  allGaps.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.severity ?? 0) - (a.severity ?? 0);
  });

  log('cortex_per_domain_reassembly_complete', {
    correlation_id: correlationId,
    gap_count: allGaps.length,
    domains_clean: domainsClean,
    domains_with_degraded: domainsWithDegraded,
    domains_rejected: domainsRejected,
    degraded_count: allDegraded.length,
    top_priority: allGaps[0]?.priority ?? null,
  });

  return { gaps: allGaps, degraded: allDegraded };
}
