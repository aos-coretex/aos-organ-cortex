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
 * @param {string} [parts.fullPrompt]   - composed user-content prompt from buildPrompt()
 *                                        If provided, used as the authoritative aggregate.
 *                                        If omitted, aggregate is the sum of sections.
 * @param {boolean} [parts.emit=true]   - emit structured stdout event
 * @returns {{sections: Record<string, number>, section_sum: number,
 *            aggregate: number, overhead: number, composed_at: string}}
 */
export function measurePromptBreakdown({ missionFrame, worldState, recentGoals, fullPrompt, emit = true }) {
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

  const sectionSum = Object.values(sections).reduce((a, b) => a + b, 0);
  const aggregate = fullPrompt ? countTokens(fullPrompt) : sectionSum;
  const overhead = aggregate - sectionSum;

  const breakdown = {
    sections,
    section_sum: sectionSum,
    aggregate,
    overhead,
    composed_at: new Date().toISOString(),
  };

  if (emit) {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'cortex_prompt_size_breakdown',
      ...breakdown,
    }) + '\n');
  }

  return breakdown;
}
