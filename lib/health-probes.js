/**
 * Health and introspect check builders.
 *
 * Extracted from server/index.js into this module so their flat-return shape
 * (bug #9) and the aligned-vs-blinded observability surface (x2p-4 O4) can be
 * unit-tested without booting createOrgan.
 *
 * The shared-lib `createOrgan` wraps these return objects into the `checks`
 * (health) and `extra` (introspect) fields of the standard `/health` and
 * `/introspect` responses respectively. Therefore the builders MUST return a
 * FLAT object — never wrap a nested `{ checks: ... }` or `{ extra: ... }`
 * field. Double-wrapping creates the `checks: { extra: {...} }` pollution
 * documented as systemic bug #9.
 *
 * Aligned-vs-blinded surface (x2p-4 O4): `/health` MUST surface
 * `last_assessment_degraded` (array) and `last_assessment_at` (ISO8601 or
 * null) so Vigil / operators can distinguish "Cortex has nothing to do"
 * (aligned organism, empty gaps, no degraded flags) from "Cortex can't see"
 * (LLM unavailable / CM organs unreachable, empty gaps with degraded flags).
 * Without these fields both paths look identical to downstream health
 * observers.
 */

/**
 * @param {object} deps
 * @param {object} deps.probes                - plain object: { graph, arbiter, radiant, minder, hippocampus } boolean reachability
 * @param {{ getStats: () => object }} deps.assessmentLoop
 * @param {{ get: () => { lastAt, degraded } }} deps.currentAssessmentMeta
 * @param {{ isAvailable?: () => boolean }} [deps.llm] - optional reference for llm_available check
 * @returns {() => Promise<object>} flat healthCheck function
 */
export function buildHealthCheck({ probes, assessmentLoop, currentAssessmentMeta, llm }) {
  return async function healthCheck() {
    const stats = assessmentLoop.getStats();
    const meta = currentAssessmentMeta.get();
    return {
      graph_reachable: probes.graph,
      arbiter_reachable: probes.arbiter,
      radiant_reachable: probes.radiant,
      minder_reachable: probes.minder,
      hippocampus_reachable: probes.hippocampus,
      assessment_active: !stats.stopped,
      llm_available: llm?.isAvailable ? llm.isAvailable() : true,
      current_interval_ms: stats.current_interval_ms,
      loop_iteration: stats.loop_iteration,
      // x2p-4 O4: aligned-silent vs blinded-silent distinction.
      last_assessment_degraded: meta.degraded || [],
      last_assessment_at: meta.lastAt,
    };
  };
}

/**
 * @param {object} deps
 * @param {object} deps.cadence                              - loop cadence config snapshot
 * @param {{ getStats: () => object }} deps.assessmentLoop
 * @param {{ size: () => number }} deps.goalHistory
 * @param {{ peekCache: () => any }} deps.missionLoader
 * @returns {() => Promise<object>} flat introspectCheck function
 */
export function buildIntrospectCheck({ cadence, assessmentLoop, goalHistory, missionLoader }) {
  return async function introspectCheck() {
    const stats = assessmentLoop.getStats();
    return {
      cadence,
      last_assessment_at: stats.last_assessment_at,
      last_assessment_duration_ms: stats.last_assessment_duration_ms,
      total_goals_generated: stats.total_goals_generated,
      goal_history_size: goalHistory.size(),
      mission_cache_loaded: missionLoader.peekCache() !== null,
    };
  };
}
