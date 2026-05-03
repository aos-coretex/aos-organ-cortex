/**
 * Cortex cadence-mode configuration (p4r-5).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md
 *   §7.4 — cadence integration scope (per-section vs round-robin vs priority-driven).
 *   §6.4 — cadence-vs-precision tradeoff; recommended starting point round-robin
 *          + priority-override.
 *
 * Architectural lean ratified by CEO 1931 R: priority-driven default +
 * backpressure-aware adaptation (matches existing self-regulation pattern).
 *
 * Three modes:
 *   - 'priority-driven' (default) — every cycle runs all 5 per-domain analyzers
 *     via Promise.allSettled (dispatched through the existing gap-analyzer
 *     wrapper's runPerDomainReassembly path). Highest precision; matches
 *     pre-p4r-5 single-pass cadence shape; 5x per-cycle LLM calls offset by
 *     ~66% per-cycle cost reduction from per-domain prompt narrowing.
 *
 *   - 'round-robin' — each cycle runs ONE per-domain analyzer (rotating
 *     through `domainOrder`). Critical-priority-first ordering: operational
 *     → constitutional → strategic → relational → compliance. 1x LLM call
 *     per cycle; 5x cadence-distance to full-coverage. Cost-saver, used
 *     under backpressure or when budget-constrained.
 *
 *   - 'backpressure-adapted' (architectural target) — Mode A by default;
 *     switches to `backpressureFallbackMode` (default 'round-robin') when
 *     Cortex receives mailbox_pressure from Thalamus; returns to default
 *     after `backpressureRecoveryThreshold` consecutive clear cycles.
 *
 * Cadence INTERVAL self-regulation (floorMs/ceilingMs/startMs/gapDivisor/
 * idleFactor/pressureFactor) is NOT redefined here — it lives where it has
 * always lived, in the `cadence` config passed to createAssessmentLoop.
 * This module governs WHICH analyzers run per cycle, not WHEN.
 *
 * The 21-min canonical default (CEO 1404 R cadence pin SHA 64834ff) is
 * preserved at server/config.js loopStartMs; this file adds no new floors,
 * ceilings, or interval values.
 */

export const CADENCE_MODES = Object.freeze([
  'priority-driven',
  'round-robin',
  'backpressure-adapted',
]);

export const DEFAULT_DOMAIN_ORDER = Object.freeze([
  'operational',
  'constitutional',
  'strategic',
  'relational',
  'compliance',
]);

export const DEFAULT_CADENCE_CONFIG = Object.freeze({
  mode: 'priority-driven',
  domainOrder: DEFAULT_DOMAIN_ORDER,
  backpressureFallbackMode: 'round-robin',
  backpressureRecoveryThreshold: 5,
});

/**
 * Validate a cadence-mode config object. Throws on structural errors so
 * boot-time wiring failures surface early (mirrors per-domain factory's
 * eager-throw pattern).
 *
 * @param {object} config
 * @throws {Error} on missing/invalid fields
 */
export function validateCadenceConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('validateCadenceConfig: config object is required');
  }
  if (!CADENCE_MODES.includes(config.mode)) {
    throw new Error(
      `validateCadenceConfig: mode must be one of ${CADENCE_MODES.join(', ')}; got "${config.mode}"`,
    );
  }
  if (!Array.isArray(config.domainOrder) || config.domainOrder.length === 0) {
    throw new Error('validateCadenceConfig: domainOrder must be a non-empty array');
  }
  if (!CADENCE_MODES.includes(config.backpressureFallbackMode)
      || config.backpressureFallbackMode === 'backpressure-adapted') {
    throw new Error(
      'validateCadenceConfig: backpressureFallbackMode must be a non-adaptive mode '
      + `(priority-driven | round-robin); got "${config.backpressureFallbackMode}"`,
    );
  }
  if (!Number.isInteger(config.backpressureRecoveryThreshold)
      || config.backpressureRecoveryThreshold < 1) {
    throw new Error(
      'validateCadenceConfig: backpressureRecoveryThreshold must be a positive integer',
    );
  }
}
