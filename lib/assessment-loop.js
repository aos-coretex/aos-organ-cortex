/**
 * Cortex assessment loop engine.
 *
 * Self-regulating cadence with floor/ceiling bounds. First iteration runs
 * immediately on start(). Subsequent iterations schedule based on gap
 * density and downstream backpressure.
 *
 * Cadence rules (from MP-12 RFI-1 Q5 — confirmed verbatim):
 *   - gap found:           next = max(floor, current / gapDivisor)
 *   - no gap found:        next = min(ceiling, current * idleFactor)
 *   - mailbox_pressure on  next = min(ceiling, current * pressureFactor)
 *     target organ (e.g. Thalamus)
 *
 * This engine is PURE — it holds no Spine client, no HTTP fetch, no LLM.
 * The 4 injected readers (missionLoader, cmClient, gapAnalyzer, goalEmitter)
 * are wired in relays x2p-2 through x2p-5. A noop variant (present at
 * scaffold) makes assess() return { gaps: [], goal: null, degraded: [] }
 * so scheduling behavior can be tested independently of CM/LLM wiring.
 *
 * p4r-5 (cadence-mode integration): the loop optionally accepts
 * `cadenceConfig` + `analyzerSet` + `backpressureSignal`. When all three are
 * supplied, an internal cadenceExecutor wraps the gap-analyzer call to
 * select WHICH per-domain analyzers run per cycle (priority-driven /
 * round-robin / backpressure-adapted). When absent, the loop falls through
 * to the legacy single-pass `gapAnalyzer(missionFrame, worldState)` call —
 * backward-compatible with all pre-p4r-5 tests and boot paths.
 *
 * The interval self-regulation (gapDivisor / idleFactor / pressureFactor)
 * and the consume-once `pressureFlag` are unchanged. The new
 * `backpressureSignal` is a SEPARATE mechanism driving cadence-mode
 * switching; the existing pressureFlag still drives interval doubling.
 */

import { createCadenceExecutor } from './cadence-executor.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} config
 * @param {object} config.cadence              - { floorMs, ceilingMs, startMs, gapDivisor, idleFactor, pressureFactor }
 * @param {function} config.missionLoader      - async () => { msp, bor, degraded: string[] }
 * @param {function} config.cmClient           - async (missionFrame) => { snapshot, degraded: string[] }
 * @param {function} config.gapAnalyzer        - async (missionFrame, worldState) => { gaps: [], degraded: string[] }
 * @param {function} config.goalEmitter        - async (gap) => { goal_id, dispatched: boolean }
 * @param {object}   [config.cadenceConfig]    - p4r-5: cadence-mode config; see lib/cadence-config.js
 * @param {object}   [config.analyzerSet]      - p4r-5: per-domain analyzer map from createPerDomainAnalyzerSet
 * @param {object}   [config.backpressureSignal] - p4r-5: { active: boolean } ref shared with handlers/broadcast.js
 * @returns {{ start, stop, trigger, getStats, onPressure }}
 */
export function createAssessmentLoop(config) {
  const {
    cadence,
    missionLoader,
    cmClient,
    gapAnalyzer,
    goalEmitter,
    cadenceConfig,
    analyzerSet,
    backpressureSignal,
  } = config;

  const { floorMs, ceilingMs, startMs, gapDivisor, idleFactor, pressureFactor } = cadence;

  // p4r-5: optional cadence-mode wrapping. Both cadenceConfig AND analyzerSet
  // must be present to enable per-domain mode selection. When absent, the
  // legacy single-pass `gapAnalyzer(missionFrame, worldState)` call site is
  // used unchanged — preserves all pre-p4r-5 behavior and tests.
  const cadenceExecutor = (cadenceConfig && analyzerSet)
    ? createCadenceExecutor({
        analyzerSet,
        gapAnalyzer,
        cadenceConfig,
        backpressureSignal,
      })
    : null;

  // State
  let currentIntervalMs = startMs;
  let scheduledTimer = null;
  let stopped = true;
  let inFlight = false;          // prevent overlapping assessments
  let loopIteration = 0;
  let lastAssessmentAt = null;
  let lastAssessmentDurationMs = null;
  let lastGapsFound = 0;
  let totalGoalsGenerated = 0;
  let pressureFlag = false;      // set by onPressure, cleared after next scheduled iteration

  // --- Cadence math ---

  function nextIntervalOnGaps() {
    return Math.max(floorMs, Math.floor(currentIntervalMs / gapDivisor));
  }

  function nextIntervalOnIdle() {
    return Math.min(ceilingMs, Math.floor(currentIntervalMs * idleFactor));
  }

  function nextIntervalOnPressure() {
    return Math.min(ceilingMs, Math.floor(currentIntervalMs * pressureFactor));
  }

  // --- Single assessment iteration ---

  async function runOneAssessment({ manualTrigger = false } = {}) {
    if (inFlight) {
      log('cortex_assessment_skipped_in_flight', { loop_iteration: loopIteration });
      return { skipped: true };
    }

    inFlight = true;
    const startedAt = Date.now();
    loopIteration += 1;
    const iteration = loopIteration;
    const degraded = [];

    try {
      log('cortex_assessment_started', { iteration, manual: manualTrigger, interval_ms: currentIntervalMs });

      // Step 1-2: mission + world state
      const missionFrame = await missionLoader();
      if (missionFrame.degraded?.length) degraded.push(...missionFrame.degraded);

      const worldState = await cmClient(missionFrame);
      if (worldState.degraded?.length) degraded.push(...worldState.degraded);

      // Step 3: gap analysis. p4r-5: route through cadenceExecutor when wired
      // so per-cycle mode selection applies; fall through to legacy single-pass
      // call when cadenceConfig+analyzerSet weren't provided at boot.
      const analysis = cadenceExecutor
        ? await cadenceExecutor.executeAssessmentCycle({ missionFrame, worldState })
        : await gapAnalyzer(missionFrame, worldState);
      if (analysis.degraded?.length) degraded.push(...analysis.degraded);

      const gaps = analysis.gaps || [];
      lastGapsFound = gaps.length;

      // Step 4-5: emit goal for top-priority gap (if any)
      let goal = null;
      if (gaps.length > 0) {
        const topGap = gaps[0]; // already prioritized by gapAnalyzer
        goal = await goalEmitter(topGap, missionFrame);
        if (goal?.dispatched) {
          totalGoalsGenerated += 1;
        }
      }

      lastAssessmentAt = new Date().toISOString();
      lastAssessmentDurationMs = Date.now() - startedAt;

      log('cortex_assessment_completed', {
        iteration,
        duration_ms: lastAssessmentDurationMs,
        gaps_found: gaps.length,
        goal_dispatched: !!goal?.dispatched,
        degraded,
      });

      return { iteration, gaps, goal, degraded };
    } catch (err) {
      log('cortex_assessment_error', { iteration, error: err.message });
      return { iteration, error: err.message, degraded };
    } finally {
      inFlight = false;
    }
  }

  // --- Interval computation from result ---

  function computeNextInterval(result) {
    // Pressure flag takes priority (doubling)
    if (pressureFlag) {
      pressureFlag = false; // clear after applying
      const next = nextIntervalOnPressure();
      log('cortex_cadence_adjusted', { reason: 'backpressure', from_ms: currentIntervalMs, to_ms: next });
      return next;
    }
    if (result.error || result.skipped) {
      // Errors: don't change cadence — retry at same interval
      return currentIntervalMs;
    }
    if (result.gaps && result.gaps.length > 0) {
      const next = nextIntervalOnGaps();
      log('cortex_cadence_adjusted', { reason: 'gaps_found', count: result.gaps.length, from_ms: currentIntervalMs, to_ms: next });
      return next;
    }
    const next = nextIntervalOnIdle();
    log('cortex_cadence_adjusted', { reason: 'idle', from_ms: currentIntervalMs, to_ms: next });
    return next;
  }

  // --- Scheduling ---

  function schedule(nextMs) {
    if (stopped) return;
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = setTimeout(async () => {
      const result = await runOneAssessment();
      currentIntervalMs = computeNextInterval(result);
      schedule(currentIntervalMs);
    }, nextMs);
    // Unref so the timer never holds the process open on its own
    if (scheduledTimer.unref) scheduledTimer.unref();
  }

  // --- Public API ---

  async function start() {
    if (!stopped) return;
    stopped = false;
    log('cortex_loop_starting', { initial_interval_ms: currentIntervalMs, floor_ms: floorMs, ceiling_ms: ceilingMs });

    // First iteration runs IMMEDIATELY (RFI-1 Q5 addition 1)
    const result = await runOneAssessment();
    currentIntervalMs = computeNextInterval(result);
    schedule(currentIntervalMs);

    log('cortex_loop_started', { next_interval_ms: currentIntervalMs });
  }

  function stop() {
    stopped = true;
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    log('cortex_loop_stopped', { loop_iteration: loopIteration });
  }

  async function trigger({ reason } = {}) {
    // Manual trigger runs ONE immediate assessment but does NOT disrupt the scheduled cadence
    log('cortex_manual_trigger', { reason: reason || 'unspecified' });
    return runOneAssessment({ manualTrigger: true });
  }

  function onPressure(organName) {
    if (organName === 'Thalamus') {
      pressureFlag = true;
      log('cortex_backpressure_flagged', { organ: organName });
    }
  }

  function getStats() {
    return {
      loop_iteration: loopIteration,
      current_interval_ms: currentIntervalMs,
      floor_ms: floorMs,
      ceiling_ms: ceilingMs,
      last_assessment_at: lastAssessmentAt,
      last_assessment_duration_ms: lastAssessmentDurationMs,
      last_gaps_found: lastGapsFound,
      total_goals_generated: totalGoalsGenerated,
      in_flight: inFlight,
      pressure_flag: pressureFlag,
      stopped,
      cadence_mode: cadenceExecutor ? cadenceExecutor.getCurrentMode() : null,
      cadence_round_robin_index: cadenceExecutor ? cadenceExecutor.getRoundRobinIndex() : null,
    };
  }

  return { start, stop, trigger, getStats, onPressure };
}
