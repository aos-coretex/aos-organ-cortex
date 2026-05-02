/**
 * Prompt-size instrumentation — per-section token breakdown for the
 * gap-analyzer's composed user-content prompt.
 *
 * Authored as part of C2A 2026-04-22 c2a-cortex-03-lossless-context-cleanup.
 *
 * Tokenizer note:
 *   This module uses gpt-tokenizer (cl100k_base — GPT-4 encoding) as a proxy
 *   for the target Gemma-3 SentencePiece tokenizer. Absolute token counts
 *   differ from Gemma by roughly ±5-10%; RELATIVE reclaim measurements
 *   (before vs after a cleanup pass) are preserved. The CV test threshold
 *   should be calibrated against this tokenizer, not the Gemma server's
 *   reported prefill count.
 *
 * Emitted event:
 *   { timestamp, event: 'cortex_prompt_size_breakdown', sections, section_sum,
 *     aggregate, overhead, composed_at } — structured stdout JSON, consumable
 *   by the CV test and any downstream monitoring.
 */

import { encode } from 'gpt-tokenizer';

/**
 * Count tokens in a string. Returns 0 for non-string input.
 *
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return encode(text).length;
}

/**
 * Measure prompt size per composed section.
 *
 * @param {object} parts
 * @param {object} parts.missionFrame   - { msp: { raw_text }, bor: raw_text | { raw_text } }
 * @param {object} parts.worldState     - snapshot from cm-client
 * @param {Array}  parts.recentGoals    - recent goal history
 * @param {string} [parts.fullPrompt]   - composed user-content prompt from buildPrompt().
 *                                        If provided, used as the authoritative user-content aggregate.
 *                                        If omitted, aggregate is the sum of user-content sections.
 * @param {string} [parts.systemPrompt] - SYSTEM_PROMPT string. If provided, a
 *                                        'system-prompt' section is added and its
 *                                        tokens are included in the aggregate (so
 *                                        aggregate reflects total LLM input).
 *                                        Added by p4r-2 per static-section spec §2.
 * @param {string} [parts.correlationId] - per-cycle correlation ID linking this
 *                                        breakdown to the post-call provider-tokens
 *                                        event and the raw-response event. Added by p4r-2.
 * @param {boolean} [parts.emit=true]   - emit structured stdout event
 * @returns {{sections: Record<string, number>, section_sum: number,
 *            aggregate: number, overhead: number, composed_at: string,
 *            correlation_id?: string}}
 */
export function measurePromptBreakdown({
  missionFrame,
  worldState,
  recentGoals,
  fullPrompt,
  systemPrompt,
  correlationId,
  emit = true,
}) {
  const ws = worldState || {};
  const mf = missionFrame || {};
  const borText = typeof mf.bor === 'string' ? mf.bor : (mf.bor?.raw_text || '');

  const sections = {
    'msp-raw':          countTokens(mf.msp?.raw_text || ''),
    'bor-raw':          countTokens(borText),
    'radiant-context':  countTokens(JSON.stringify(ws.radiant?.recent_context ?? null)),
    'radiant-memory':   countTokens(JSON.stringify(ws.radiant?.recent_memory ?? null)),
    'radiant-stats':    countTokens(JSON.stringify(ws.radiant?.stats ?? null)),
    'minder':           countTokens(JSON.stringify(ws.minder ?? null)),
    'hippocampus':      countTokens(JSON.stringify(ws.hippocampus ?? null)),
    'graph-structural': countTokens(JSON.stringify(ws.graph_structural ?? null)),
    'spine-state':      countTokens(JSON.stringify(ws.spine_state ?? null)),
    'recent-goals':     countTokens(JSON.stringify(recentGoals ?? [])),
  };

  // p4r-2: system-prompt is a static section per the decomposition spec; include
  // it when supplied so aggregate reflects total LLM input (system + user).
  if (typeof systemPrompt === 'string') {
    sections['system-prompt'] = countTokens(systemPrompt);
  }

  const sectionSum = Object.values(sections).reduce((a, b) => a + b, 0);
  const userAggregate = fullPrompt ? countTokens(fullPrompt) : sectionSum - (sections['system-prompt'] || 0);
  const aggregate = userAggregate + (sections['system-prompt'] || 0);
  const overhead = aggregate - sectionSum;

  const breakdown = {
    sections,
    section_sum: sectionSum,
    aggregate,
    overhead,
    composed_at: new Date().toISOString(),
  };
  if (correlationId) {
    breakdown.correlation_id = correlationId;
  }

  if (emit) {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'cortex_prompt_size_breakdown',
      ...breakdown,
    }) + '\n');
  }

  return breakdown;
}

/**
 * Emit per-slice cache breakdown for one readWorldState() cycle.
 *
 * Authored as part of relay p4r-3 (MP-p4r) Step 5. Pairs with
 * cortex_prompt_size_breakdown via shared correlation_id (per-cycle).
 *
 * Emitted event shape:
 *   {
 *     timestamp,
 *     event: 'cortex_world_state_cache_breakdown',
 *     correlation_id,
 *     slices: {
 *       radiant:          { hit, age_ms?, fetched_ms?, tokens_cl100k },
 *       minder:           { hit, age_ms?, fetched_ms?, tokens_cl100k },
 *       hippocampus:      { hit, age_ms?, fetched_ms?, tokens_cl100k },
 *       graph_structural: { hit, age_ms?, fetched_ms?, tokens_cl100k },
 *       spine_state:      { hit: false, fetched_ms, new_transitions, evicted, tokens_cl100k }
 *     }
 *   }
 *
 * Per-slice asymmetry (cl100k_base vs provider tokens) deferred to p4r-7
 * fixture-replay per relay scope.
 *
 * @param {object} args
 * @param {string} args.correlationId
 * @param {object} args.sliceCacheMetrics  - per-slice { hit, age_ms, fetched_ms, new_transitions?, evicted? }
 * @param {object} args.sliceData          - per-slice raw data (null if degraded)
 * @param {boolean} [args.emit=true]
 * @returns {object} the assembled breakdown (always)
 */
export function emitWorldStateCacheBreakdown({ correlationId, sliceCacheMetrics, sliceData, emit = true }) {
  const slices = {};
  for (const sliceName of Object.keys(sliceCacheMetrics || {})) {
    const metrics = sliceCacheMetrics[sliceName] || {};
    const data = sliceData ? sliceData[sliceName] : null;
    const tokens_cl100k = countTokens(JSON.stringify(data ?? null));
    const entry = {
      hit: !!metrics.hit,
      tokens_cl100k,
    };
    if (metrics.hit) {
      entry.age_ms = typeof metrics.age_ms === 'number' ? metrics.age_ms : 0;
    } else {
      entry.fetched_ms = typeof metrics.fetched_ms === 'number' ? metrics.fetched_ms : 0;
    }
    if (typeof metrics.new_transitions === 'number') {
      entry.new_transitions = metrics.new_transitions;
    }
    if (typeof metrics.evicted === 'number') {
      entry.evicted = metrics.evicted;
    }
    slices[sliceName] = entry;
  }

  const breakdown = {
    correlation_id: correlationId,
    slices,
  };

  if (emit) {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'cortex_world_state_cache_breakdown',
      ...breakdown,
    }) + '\n');
  }

  return breakdown;
}
