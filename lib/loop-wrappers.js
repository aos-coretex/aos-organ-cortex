/**
 * Loop wrappers — the thin shim between the pure assessment-loop engine
 * (x2p-1) and the real cmClient / gapAnalyzer injected at boot time (x2p-6).
 *
 * Extracted from server/index.js into this module so the halt-on-spine-null
 * semantics and the observability state holders can be unit-tested without
 * booting createOrgan.
 *
 * Halt semantics (x2p-3 O4 → x2p-5 O7 → x2p-6 §12):
 *   When cmClient returns a snapshot with spine_state === null, Cortex has
 *   no operational reality view and the assessment loop must not run gap
 *   analysis that iteration. Per cortex-organ-intervention-instruction.md §5
 *   the loop is blinded and the analyzer is short-circuited. This module
 *   implements that halt at the wrapper boundary: wrappedCmClient marks the
 *   result with halt: true, and wrappedGapAnalyzer inspects that flag and
 *   returns empty gaps without calling the real analyzer.
 */

/**
 * Wrap the cmClient with observability side-effects + halt-on-spine-null.
 *
 * @param {object} deps
 * @param {(missionFrame) => Promise<{ snapshot, sources_ok, sources_degraded, degraded }>} deps.cmClient
 * @param {{ set: (snap) => void, get: () => any }} deps.currentWorldState
 * @param {{ set: (meta) => void, get: () => { lastAt, degraded } }} deps.currentAssessmentMeta
 * @returns {(missionFrame) => Promise<object>} shaped result; may carry { halt: true }
 */
export function createCmClientWrapper({ cmClient, currentWorldState, currentAssessmentMeta }) {
  return async function wrappedCmClient(missionFrame) {
    const result = await cmClient(missionFrame);
    currentWorldState.set(result?.snapshot || null);

    // spine_state === null halt condition (x2p-3 O4, carry-forward to x2p-6).
    // Cortex has no operational reality view — blind organism. Mark the
    // iteration with a dedicated halt flag and short-circuit gap analysis.
    if (result?.snapshot?.spine_state == null) {
      currentAssessmentMeta.set({
        lastAt: new Date().toISOString(),
        degraded: ['spine-state-unavailable-halt'],
      });
      return {
        ...result,
        snapshot: { ...(result?.snapshot || {}), _cortex_halt: 'spine-state-unavailable' },
        degraded: [...(result?.degraded || []), 'spine-state-unavailable-halt'],
        halt: true,
      };
    }

    return result;
  };
}

/**
 * Wrap the gapAnalyzer with observability side-effects + halt short-circuit.
 *
 * @param {object} deps
 * @param {(missionFrame, worldState) => Promise<{ gaps, degraded }>} deps.gapAnalyzer
 * @param {{ set: (gaps) => void, list: () => any[] }} deps.currentGaps
 * @param {{ set: (meta) => void, get: () => any }} deps.currentAssessmentMeta
 * @returns {(missionFrame, worldState) => Promise<{ gaps, degraded }>}
 */
export function createGapAnalyzerWrapper({ gapAnalyzer, currentGaps, currentAssessmentMeta }) {
  return async function wrappedGapAnalyzer(missionFrame, worldState) {
    // Short-circuit if the cm-client wrapper flagged a halt (spine-state unavailable).
    // This keeps the gap analyzer out of the critical path when there is nothing to
    // analyze against.
    if (worldState?.halt === true) {
      currentGaps.set([]);
      return { gaps: [], degraded: [...(worldState.degraded || [])] };
    }

    // worldState here is the shaped `{ snapshot, sources_ok, sources_degraded, degraded }`
    // from cm-client; the analyzer expects the snapshot-like shape. Unwrap.
    const analyzed = await gapAnalyzer(missionFrame, worldState?.snapshot || worldState);
    currentGaps.set(analyzed.gaps);
    currentAssessmentMeta.set({
      lastAt: new Date().toISOString(),
      degraded: [...(analyzed.degraded || [])],
    });
    return analyzed;
  };
}

/**
 * Factory for the small observability state holders consumed by routes.
 * These are plain closures so the routes can read the most recent snapshot
 * without re-invoking the readers.
 */
export function createStateHolders() {
  let gaps = [];
  let meta = { lastAt: null, degraded: [] };
  let snapshot = null;
  return {
    currentGaps: {
      set: (g) => { gaps = g; },
      list: () => gaps,
    },
    currentAssessmentMeta: {
      set: (m) => { meta = m; },
      get: () => meta,
    },
    currentWorldState: {
      set: (s) => { snapshot = s; },
      get: () => snapshot,
    },
  };
}
