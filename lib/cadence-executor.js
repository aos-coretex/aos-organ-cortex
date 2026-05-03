/**
 * Cortex cadence executor (p4r-5).
 *
 * Wraps each assessment cycle's gap-analysis call so the loop can adapt
 * WHICH per-domain analyzers run per cycle without changing WHEN cycles
 * run (interval self-regulation lives unchanged in assessment-loop.js).
 *
 * Three modes (see lib/cadence-config.js for full semantics):
 *
 *   - 'priority-driven' — Mode A. Delegate to the existing gap-analyzer
 *     wrapper, which (when constructed with a perDomainAnalyzers map) fans
 *     out to all 5 domains via runPerDomainReassembly. No per-cycle subset
 *     selection; pre-flight gates (mission absence, spine absence) and
 *     telemetry stitching live inside the wrapper.
 *
 *   - 'round-robin' — Mode B. Bypass the gap-analyzer wrapper and invoke
 *     ONE per-domain analyzer from `analyzerSet` directly, rotating through
 *     `cadenceConfig.domainOrder`. Bypass is required because the wrapper's
 *     perDomainAnalyzers map is locked at construction (relay scope forbids
 *     editing gap-analyzer.js to add a per-call subset override). §4.5
 *     (same llm reference) is preserved because the per-domain factory
 *     wired all 5 analyzers with the same llm. Schema purity (§7.3) is
 *     enforced inside each analyzer.
 *
 *   - 'backpressure-adapted' — Mode C. Default to priority-driven; on a
 *     mailbox_pressure signal from Thalamus, switch to
 *     `backpressureFallbackMode` (default round-robin); after
 *     `backpressureRecoveryThreshold` consecutive clear cycles, return to
 *     priority-driven.
 *
 * Backpressure signal — `backpressureSignal` is a tiny ref object
 * `{ active: boolean }`. handlers/broadcast.js sets `active = true` on
 * `mailbox_pressure` for Thalamus. The executor uses CONSUME-ONCE semantics
 * (mirrors the existing assessment-loop pressureFlag): on cycle start the
 * executor reads `active`, applies the mode transition, and clears the
 * signal. Spine emits no `mailbox_pressure_clear` today — when it does, the
 * consume-once can be tightened to set-on-event/clear-on-event without
 * changing the executor's external surface. Cross-feed candidate documented
 * in handlers/broadcast.js header.
 *
 * Independence from existing pressureFactor cadence growth — assessment-
 * loop.onPressure('Thalamus') still drives the existing pressureFactor
 * interval-doubling path. The executor's backpressureSignal is a SEPARATE
 * mechanism. Both respond to the same broadcast event but serve different
 * roles: cadence growth (when to assess) vs cadence-mode switching (which
 * analyzers).
 */

import { randomUUID } from 'node:crypto';
import { validateCadenceConfig } from './cadence-config.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * @param {object}   args
 * @param {object}   args.analyzerSet        - per-domain analyzer map from
 *                                              createPerDomainAnalyzerSet (p4r-6).
 *                                              Keys: operational, strategic,
 *                                              relational, compliance, constitutional.
 * @param {Function} args.gapAnalyzer        - the assessment-loop's existing
 *                                              gap-analyzer wrapper (constructed
 *                                              with the full perDomainAnalyzers map
 *                                              for Mode A delegation).
 * @param {object}   args.cadenceConfig      - shape per DEFAULT_CADENCE_CONFIG;
 *                                              validated at construction.
 * @param {object}   [args.backpressureSignal] - { active: boolean } ref object;
 *                                                shared with handlers/broadcast.js.
 *                                                Optional — when absent, treated as
 *                                                a permanently-clear signal (executor
 *                                                still functions in non-adaptive
 *                                                modes).
 * @returns {{ executeAssessmentCycle, getCurrentMode, getRoundRobinIndex }}
 */
export function createCadenceExecutor({
  analyzerSet,
  gapAnalyzer,
  cadenceConfig,
  backpressureSignal,
} = {}) {
  validateCadenceConfig(cadenceConfig);

  if (!analyzerSet || typeof analyzerSet !== 'object') {
    throw new Error('createCadenceExecutor: analyzerSet is required');
  }
  if (typeof gapAnalyzer !== 'function') {
    throw new Error('createCadenceExecutor: gapAnalyzer is required and must be a function');
  }

  for (const domain of cadenceConfig.domainOrder) {
    if (typeof analyzerSet[domain] !== 'function') {
      throw new Error(
        `createCadenceExecutor: cadenceConfig.domainOrder references "${domain}" `
        + 'but analyzerSet has no analyzer for that domain',
      );
    }
  }

  const signal = backpressureSignal || { active: false };

  // Mode C ('backpressure-adapted') starts in its default state — priority-
  // driven — and switches to backpressureFallbackMode only when the signal
  // fires. The configured mode (cadenceConfig.mode) is a STRATEGY, not the
  // initial dispatch mode for Mode C. Modes A and B initialize directly to
  // their literal configured value.
  let currentMode = cadenceConfig.mode === 'backpressure-adapted'
    ? 'priority-driven'
    : cadenceConfig.mode;
  let backpressureClearStreak = 0;
  let roundRobinIndex = 0;

  function resolveModeForCycle() {
    if (cadenceConfig.mode !== 'backpressure-adapted') {
      return { mode: currentMode, backpressureActiveAtCycleStart: false };
    }

    const wasActive = !!signal.active;
    if (wasActive) {
      currentMode = cadenceConfig.backpressureFallbackMode;
      backpressureClearStreak = 0;
      signal.active = false; // consume-once; see header
    } else {
      backpressureClearStreak += 1;
      if (backpressureClearStreak >= cadenceConfig.backpressureRecoveryThreshold) {
        currentMode = 'priority-driven';
        backpressureClearStreak = 0;
      }
    }
    return { mode: currentMode, backpressureActiveAtCycleStart: wasActive };
  }

  async function runRoundRobinCycle({ missionFrame, worldState }) {
    const domain = cadenceConfig.domainOrder[roundRobinIndex % cadenceConfig.domainOrder.length];
    const pickedIndex = roundRobinIndex;
    roundRobinIndex += 1;

    const correlationId = randomUUID();

    log('cortex_cadence_round_robin_pick', {
      domain,
      round_robin_index: pickedIndex,
      correlation_id: correlationId,
    });

    let outcome;
    try {
      outcome = await analyzerSet[domain]({
        missionFrame,
        worldState,
        recentGoals: undefined, // analyzer falls back to its goalHistory.list()
        correlationId,
      });
    } catch (err) {
      // Factory analyzers are fail-closed; a thrown error here is a programming
      // defect. Mirror reassembly's settled-rejected path so the loop never
      // halts on per-domain failures (§4.6).
      return {
        gaps: [],
        degraded: [`per-domain-rejected:${err?.message ?? 'unknown'}`],
      };
    }

    const gaps = Array.isArray(outcome?.gaps) ? outcome.gaps : [];
    const degraded = Array.isArray(outcome?.degraded) ? outcome.degraded : [];

    // Mirror runPerDomainReassembly's PRIORITY_ORDER asc + severity desc sort
    // so the assessment-loop's gaps[0] top-priority pick semantics are
    // identical between Mode A and Mode B.
    gaps.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return (b.severity ?? 0) - (a.severity ?? 0);
    });

    log('cortex_cadence_round_robin_complete', {
      correlation_id: correlationId,
      domain,
      gap_count: gaps.length,
      degraded_count: degraded.length,
      top_priority: gaps[0]?.priority ?? null,
    });

    return { gaps, degraded };
  }

  async function executeAssessmentCycle({ missionFrame, worldState }) {
    const { mode: cycleMode, backpressureActiveAtCycleStart } = resolveModeForCycle();

    log('cortex_cadence_mode', {
      cycle_mode: cycleMode,
      configured_mode: cadenceConfig.mode,
      backpressure_active_at_cycle_start: backpressureActiveAtCycleStart,
      round_robin_index: roundRobinIndex,
    });

    if (cycleMode === 'priority-driven') {
      // Mode A — delegate to existing wrapper (full-set reassembly inside).
      return gapAnalyzer(missionFrame, worldState);
    }

    // Mode B — direct per-domain call.
    return runRoundRobinCycle({ missionFrame, worldState });
  }

  function getCurrentMode() { return currentMode; }
  function getRoundRobinIndex() { return roundRobinIndex; }

  return { executeAssessmentCycle, getCurrentMode, getRoundRobinIndex };
}
