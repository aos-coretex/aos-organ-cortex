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
 *
 * p4r-3 additions:
 *   - Pre-flight gate: when cmClient exposes checkSpineAvailable() (the
 *     post-p4r-3 cm-client does), wrappedCmClient probes Spine /health
 *     before invoking the other 4 slice fetches. If unavailable, a
 *     synthesized halt snapshot is returned and the 4 slice round-trips
 *     are saved. Legacy mocks without the method bypass the pre-flight
 *     and rely on the post-fetch null-spine_state halt path.
 *   - correlation_id threading: cmClient emits its own correlation_id per
 *     readWorldState (used for cortex_world_state_cache_breakdown).
 *     wrappedGapAnalyzer extracts it and forwards to the gap-analyzer so
 *     the cortex_prompt_size_breakdown / provider_tokens / response events
 *     stitch on a shared id.
 */

import { randomUUID } from 'node:crypto';

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
    // p4r-3 §Step 4: cheap pre-flight Spine availability gate. When the
    // cmClient exposes checkSpineAvailable() (post-p4r-3 cm-client), probe
    // /health before fetching all 5 slices. If Spine is down, halt the
    // iteration and skip the 4 unrelated slice round-trips. Legacy mocks
    // without the method continue through to the post-fetch halt below.
    if (typeof cmClient.checkSpineAvailable === 'function') {
      const spineUp = await cmClient.checkSpineAvailable();
      if (!spineUp) {
        const correlationId = randomUUID();
        const haltSnapshot = {
          radiant: null,
          minder: null,
          hippocampus: null,
          graph_structural: null,
          spine_state: null,
          composed_at: new Date().toISOString(),
          window_since: null,
          sources_ok: [],
          sources_degraded: ['Spine: pre-flight /health unreachable'],
          degraded: ['spine-state-degraded'],
          _cortex_halt: 'spine-state-unavailable',
        };
        currentWorldState.set(haltSnapshot);
        currentAssessmentMeta.set({
          lastAt: new Date().toISOString(),
          degraded: ['spine-state-unavailable-halt'],
        });
        return {
          snapshot: haltSnapshot,
          sources_ok: [],
          sources_degraded: haltSnapshot.sources_degraded,
          degraded: [...haltSnapshot.degraded, 'spine-state-unavailable-halt'],
          halt: true,
          correlation_id: correlationId,
        };
      }
    }

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

    // worldState here is the shaped `{ snapshot, sources_ok, sources_degraded, degraded, correlation_id }`
    // from cm-client; the analyzer expects the snapshot-like shape. Unwrap.
    // p4r-3: forward the cm-client's correlation_id so cortex_world_state_cache_breakdown
    // and cortex_prompt_size_breakdown stitch on the same id per cycle.
    const correlationId = worldState?.correlation_id;
    const analyzed = await gapAnalyzer(missionFrame, worldState?.snapshot || worldState, { correlationId });
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
 *
 * @param {object} [opts]
 * @param {{ push: (entry: { at: string, degraded: string[] }) => void }} [opts.assessmentRing]
 *   Optional ring buffer (C2A-04). When provided, every currentAssessmentMeta.set()
 *   also pushes to the ring so /introspect can expose rolling degraded-iteration ratios.
 *   The meta is set exactly once per assessment iteration (either from cmClientWrapper on
 *   halt, or from gapAnalyzerWrapper on normal analysis), so the ring gets one entry per
 *   iteration with no double-counting.
 */
export function createStateHolders({ assessmentRing } = {}) {
  let gaps = [];
  let meta = { lastAt: null, degraded: [] };
  let snapshot = null;
  return {
    currentGaps: {
      set: (g) => { gaps = g; },
      list: () => gaps,
    },
    currentAssessmentMeta: {
      set: (m) => {
        meta = m;
        if (assessmentRing) {
          assessmentRing.push({ at: m.lastAt, degraded: m.degraded || [] });
        }
      },
      get: () => meta,
    },
    currentWorldState: {
      set: (s) => { snapshot = s; },
      get: () => snapshot,
    },
  };
}
