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

import { buildPrompt, parseResponse, SYSTEM_PROMPT } from '../agents/gap-analyzer-agent.js';

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
 * @returns {(missionFrame, worldState) => Promise<{ gaps, degraded }>}
 */
export function createGapAnalyzer(config) {
  const { llmConfig, injectedLlm, goalHistory } = config;
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

  async function analyzeGaps(missionFrame, worldState) {
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

    if (!llm.isAvailable()) {
      log('cortex_gap_analysis_llm_unavailable');
      degraded.push('llm-unavailable');
      return { gaps: [], degraded };
    }

    const recentGoals = goalHistory?.list ? goalHistory.list() : [];
    const userContent = buildPrompt({ missionFrame, worldState, recentGoals });

    let response;
    try {
      // Bug #2: system prompt is an OPTION, not a message turn.
      response = await llm.chat(
        [{ role: 'user', content: userContent }],
        { system: SYSTEM_PROMPT, maxTokens: llmConfig?.maxTokens },
      );
    } catch (err) {
      log('cortex_gap_analysis_llm_error', { error: err.message });
      degraded.push('llm-error');
      return { gaps: [], degraded };
    }

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

  return analyzeGaps;
}
