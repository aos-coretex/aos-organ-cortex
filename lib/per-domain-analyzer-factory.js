/**
 * Per-domain gap-analyzer factory (p4r-6 implementation; supersedes p4r-4 skeleton).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md
 *   §7.5 — per-domain analyzer factory contract for the 5 domains
 *   (operational / strategic / relational / compliance / constitutional).
 *
 * Each per-domain analyzer fetches its slice from the already-composed
 * worldState (read-only — §4.3), checks LLM availability (§4.6 fail-closed),
 * builds a per-domain prompt (§4.1 constitutional-conditioning boundary
 * preserved by domain-prompts.js + cv-domain-prompt-discipline test),
 * invokes the same injectedLlm reference shared across all 5 instantiations
 * (§4.5), parses the LLM response, and validates against the per-domain
 * gap schema (§4.4 output schema continuity).
 *
 * Per-domain failures (slice-fetch, llm-unavailable, llm-call, parse,
 * schema-validation) return `{gaps:[], degraded:[<flag>]}` rather than
 * throwing. The reassembly path (lib/gap-analyzer.js::runPerDomainReassembly)
 * aggregates per-domain envelopes into the unified Thalamus contract.
 */

import { GAP_DOMAINS, GAP_SCHEMAS, validateGapDomainSchema } from './gap-schemas.js';
import {
  DOMAIN_SYSTEM_PROMPTS,
  MISSION_ANCHORS,
  buildDomainPrompt,
  parseDomainResponse,
} from './domain-prompts.js';

function isLlmShaped(llm) {
  return llm && typeof llm.isAvailable === 'function' && typeof llm.chat === 'function';
}

/**
 * Construct a per-domain gap analyzer.
 *
 * @param {object}   args
 * @param {string}   args.domain         - one of GAP_DOMAINS
 * @param {object}   args.schema         - the AJV-compileable schema for this domain
 *                                         (typically GAP_SCHEMAS[domain])
 * @param {Function} args.sliceFetcher   - async function (worldState) => slice
 * @param {object}   [args.missionAnchor] - MISSION_ANCHORS[domain] (defaults to that)
 * @param {object}   args.llm            - injected LLM client; must implement
 *                                         isAvailable() and chat(messages, options)
 *                                         (§4.5 — same reference across all 5
 *                                         per-domain instantiations)
 * @param {object}   [args.goalHistory]  - optional goal history; analyzer falls
 *                                         back to goalHistory.list() when the
 *                                         caller does not supply recentGoals
 * @returns {Function} async analyzer({ missionFrame, worldState, recentGoals,
 *                                       correlationId }) => { gaps, degraded }
 *
 * @throws {Error} if any required argument is missing or domain is unknown
 *                 (raised at construction so wiring errors surface early).
 */
export function createDomainGapAnalyzer({
  domain,
  schema,
  sliceFetcher,
  missionAnchor,
  llm,
  goalHistory,
} = {}) {
  if (!domain || !GAP_DOMAINS.includes(domain)) {
    throw new Error(
      `createDomainGapAnalyzer: domain must be one of ${GAP_DOMAINS.join(', ')}; got "${domain}"`,
    );
  }
  if (!schema || typeof schema !== 'object') {
    throw new Error(
      `createDomainGapAnalyzer(${domain}): schema is required and must be an AJV-compileable object`,
    );
  }
  if (typeof sliceFetcher !== 'function') {
    throw new Error(
      `createDomainGapAnalyzer(${domain}): sliceFetcher is required and must be a function`,
    );
  }
  if (!isLlmShaped(llm)) {
    throw new Error(
      `createDomainGapAnalyzer(${domain}): llm is required and must implement isAvailable() and chat(messages, options)`,
    );
  }

  const anchor = missionAnchor || MISSION_ANCHORS[domain];

  async function analyze({ missionFrame, worldState, recentGoals, correlationId } = {}) {
    let slice;
    try {
      slice = await sliceFetcher(worldState);
    } catch (err) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-slice-fetch-failed:${err?.message ?? 'unknown'}`],
      };
    }

    if (!llm.isAvailable()) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-llm-unavailable`],
      };
    }

    const goalsArg = Array.isArray(recentGoals)
      ? recentGoals
      : (typeof goalHistory?.list === 'function' ? goalHistory.list() : []);

    let messages;
    let options;
    try {
      ({ messages, options } = buildDomainPrompt({
        domain,
        missionFrame,
        slice,
        recentGoals: goalsArg,
        missionAnchor: anchor,
      }));
    } catch (err) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-prompt-build-failed:${err?.message ?? 'unknown'}`],
      };
    }

    const llmOptions = correlationId
      ? { ...options, correlationId }
      : { ...options };

    let response;
    try {
      response = await llm.chat(messages, llmOptions);
    } catch (err) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-llm-call-failed:${err?.message ?? 'unknown'}`],
      };
    }

    let gaps;
    try {
      gaps = parseDomainResponse(response, domain);
    } catch (err) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-parse-failed:${err?.message ?? 'unknown'}`],
      };
    }

    try {
      validateGapDomainSchema(domain, gaps);
    } catch (err) {
      return {
        gaps: [],
        degraded: [`per-domain-${domain}-schema-validation-failed:${err?.message ?? 'unknown'}`],
      };
    }

    return { gaps, degraded: [] };
  }

  // Introspection surface (carried over from p4r-4 skeleton — useful for
  // wiring tests and for the reassembly path's optional metadata logging).
  analyze.domain = domain;
  analyze.schema = schema;
  analyze.sliceFetcher = sliceFetcher;
  analyze.missionAnchor = anchor;
  analyze.llm = llm;
  analyze.systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain];
  analyze.validate = (gapList) => validateGapDomainSchema(domain, gapList);

  return analyze;
}

/**
 * Construct a full {operational, strategic, relational, compliance, constitutional}
 * factory map. p4r-5 cadence wiring consumes this directly.
 *
 * The same `llm` reference is forwarded into all 5 per-domain analyzers,
 * preserving the §4.5 invariant. `goalHistory` is also shared.
 *
 * @param {object}   args
 * @param {object}   args.sliceFetchers - { domain: fn(worldState) } for each of GAP_DOMAINS
 * @param {object}   args.llm           - injected LLM client (single reference, shared across all 5)
 * @param {object}   [args.goalHistory] - shared goal history (optional; per-domain analyzers
 *                                        fall back to this when caller does not pass recentGoals)
 * @param {object}   [args.missionAnchors] - optional override map; defaults to MISSION_ANCHORS
 * @returns {object} { operational, strategic, relational, compliance, constitutional }
 */
export function createPerDomainAnalyzerSet({
  sliceFetchers,
  llm,
  goalHistory,
  missionAnchors,
} = {}) {
  if (!sliceFetchers || typeof sliceFetchers !== 'object') {
    throw new Error('createPerDomainAnalyzerSet: sliceFetchers map is required');
  }
  if (!isLlmShaped(llm)) {
    throw new Error(
      'createPerDomainAnalyzerSet: llm is required and must implement isAvailable() and chat(messages, options)',
    );
  }

  const anchors = missionAnchors || MISSION_ANCHORS;
  const set = {};
  for (const domain of GAP_DOMAINS) {
    if (typeof sliceFetchers[domain] !== 'function') {
      throw new Error(
        `createPerDomainAnalyzerSet: missing sliceFetcher for domain "${domain}"`,
      );
    }
    set[domain] = createDomainGapAnalyzer({
      domain,
      schema: GAP_SCHEMAS[domain],
      sliceFetcher: sliceFetchers[domain],
      missionAnchor: anchors[domain],
      llm,
      goalHistory,
    });
  }
  return set;
}
