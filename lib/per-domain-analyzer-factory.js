/**
 * Per-domain gap-analyzer factory (skeleton — p4r-4 forward-cache for p4r-6).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md
 *   §7.5 — per-domain analyzer factory contract for the 5 domains
 *   (operational / strategic / relational / compliance / constitutional).
 *
 * What this file establishes (p4r-4):
 *   - The constructor signature consumed by p4r-5 cadence integration.
 *   - The async analyzer call shape consumed by lib/gap-analyzer.js
 *     ::runPerDomainReassembly (Promise.allSettled fan-out).
 *   - The argument-validation contract (clear errors at module wiring time
 *     rather than at first invocation).
 *
 * What this file does NOT do (out of scope for p4r-4):
 *   - Domain-specific prompt building.
 *   - LLM invocation per domain.
 *   - Per-domain world-state slicing (sliceFetcher consumer side).
 *   - Per-domain gap finalization (gap_id + analyzed_at minting).
 *
 * The skeleton's analyzer function throws a deterministic error so that any
 * call before p4r-6 lands surfaces a clear "not yet implemented" message and
 * is captured by the reassembly path's per-domain try/catch as a
 * `per-domain-<domain>-failed:<msg>` degraded entry. This preserves the
 * fail-closed posture (parent MP §4.6) even during the scaffolding interval.
 */

import { GAP_DOMAINS, GAP_SCHEMAS, validateGapDomainSchema } from './gap-schemas.js';

/**
 * Construct a per-domain gap analyzer.
 *
 * @param {object}   args
 * @param {string}   args.domain         - one of GAP_DOMAINS
 * @param {object}   args.schema         - the AJV-compileable schema for this domain
 *                                         (typically GAP_SCHEMAS[domain])
 * @param {Function} args.sliceFetcher   - async function returning the world-state
 *                                         slice this domain consumes (signature
 *                                         finalized by p4r-6; today: any thenable)
 * @param {object}   [args.missionAnchor] - bias for which MSP / BoR sections this
 *                                          domain's prompt emphasizes (p4r-6)
 * @returns {Function} async analyzer({ missionFrame, worldState, recentGoals,
 *                                       correlationId }) → { gaps, degraded }
 *
 * @throws {Error} if any required argument is missing or domain is unknown
 *                 (raised at construction so wiring errors surface early).
 */
export function createDomainGapAnalyzer({ domain, schema, sliceFetcher, missionAnchor } = {}) {
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

  // Persist the contract surface so p4r-6 can introspect what was wired
  // (analyzer.domain, analyzer.schema) without re-passing constructor args.
  async function analyze({ missionFrame, worldState, recentGoals, correlationId } = {}) {
    // p4r-6 fills in: build per-domain prompt → invoke per-domain LLM →
    // parse → finalize (gap_id + analyzed_at) → validateGapDomainSchema(...)
    // → return { gaps, degraded }.
    //
    // The reassembly path (lib/gap-analyzer.js::runPerDomainReassembly)
    // wraps this call in try/catch; this throw becomes a
    // `per-domain-${domain}-failed:not-yet-implemented` degraded entry.
    throw new Error(
      `Per-domain analyzer for "${domain}" not yet implemented (p4r-6 territory). ` +
      `Skeleton wired at p4r-4; sliceFetcher and missionAnchor=${JSON.stringify(missionAnchor ?? null)} held for p4r-6.`,
    );
  }

  analyze.domain = domain;
  analyze.schema = schema;
  analyze.sliceFetcher = sliceFetcher;
  analyze.missionAnchor = missionAnchor ?? null;

  // Convenience: p4r-6 finalize step can call analyze.validate(gaps) instead
  // of importing validateGapDomainSchema separately.
  analyze.validate = (gaps) => validateGapDomainSchema(domain, gaps);

  return analyze;
}

/**
 * Construct a full {operational, strategic, relational, compliance, constitutional}
 * factory map from a `sliceFetchers` map. Convenience for p4r-5 cadence wiring;
 * p4r-6 may override individual entries.
 *
 * @param {object} args
 * @param {object} args.sliceFetchers     - { domain: fn } for each of GAP_DOMAINS
 * @param {object} [args.missionAnchors]  - optional { domain: anchor } map
 * @returns {object} { operational, strategic, relational, compliance, constitutional }
 */
export function createPerDomainAnalyzerSet({ sliceFetchers, missionAnchors = {} } = {}) {
  if (!sliceFetchers || typeof sliceFetchers !== 'object') {
    throw new Error('createPerDomainAnalyzerSet: sliceFetchers map is required');
  }
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
      missionAnchor: missionAnchors[domain],
    });
  }
  return set;
}
