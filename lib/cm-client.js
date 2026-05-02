/**
 * Collective Memory HTTP client — composes WorldStateSnapshot from 5 slice
 * clients via Promise.allSettled. Decomposed into per-organ slice clients
 * + dedicated cache layer in relay p4r-3 (MP-p4r); each slice client owns
 * its own cache strategy (TTL change-detection for radiant/minder/hippocampus/
 * graph; incremental cursor for spine_state).
 *
 * The 5 sources:
 *   1. Radiant     — GET /context, GET /memory, GET /stats
 *   2. Minder      — GET /peers/recent, GET /observations/recent
 *                    (404 today; flagged degraded — fallback path preserved
 *                    from x2p-3)
 *   3. Hippocampus — GET /conversations?status=completed&since=&limit=
 *   4. Graph       — POST /query for entities + concept-type counts
 *   5. Spine       — GET /events?source_organ=Spine&since=<ISO>&limit=N,
 *                    client-side filter for state_transition events
 *                    (incremental cursor + window-evict; RFI-1 ruling Option A)
 *
 * Returns a function `readWorldState` (preserved external contract from x2p-3),
 * with attached methods for per-slice access:
 *   - readWorldState(missionFrame) → { snapshot, sources_ok, sources_degraded, degraded, correlation_id }
 *   - readWorldState.readSlice(name) → single slice's read() result (for p4r-5 per-section cycles)
 *   - readWorldState.checkSpineAvailable() → boolean (cheap probe; gate-vs-content separation)
 *   - readWorldState.sliceClients → { radiant, minder, ... } for introspection / testing
 *
 * Graceful degradation rule: spine_state === null pauses the assessment loop
 * (enforced by loop-wrappers, not here). Partial Radiant/Minder/Hippocampus/
 * Graph degradation flags but proceeds. fail-closed posture preserved.
 */

import { randomUUID } from 'node:crypto';
import { createWorldStateCache } from './world-state-cache.js';
import {
  createRadiantSliceClient,
  createMinderSliceClient,
  createHippocampusSliceClient,
  createGraphStructuralSliceClient,
  createSpineStateSliceClient,
} from './slice-clients.js';
import { emitWorldStateCacheBreakdown } from './prompt-size-instrumentation.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const SLICE_FIELDS = ['radiant', 'minder', 'hippocampus', 'graph_structural', 'spine_state'];

const SLICE_TO_DEGRADED_FLAG = {
  radiant:          'radiant-degraded',
  minder:           'minder-degraded',
  hippocampus:      'hippocampus-degraded',
  graph_structural: 'graph-structural-degraded',
  spine_state:      'spine-state-degraded',
};

const SLICE_TO_REJECTED_FLAG = {
  radiant:          'radiant-rejected',
  minder:           'minder-rejected',
  hippocampus:      'hippocampus-rejected',
  graph_structural: 'graph-structural-rejected',
  spine_state:      'spine-state-rejected',
};

/**
 * @param {object} config
 * @param {string} config.radiantUrl
 * @param {string} config.minderUrl
 * @param {string} config.hippocampusUrl
 * @param {object} config.graphAdapter       - from lib/graph-adapter.js (x2p-2)
 * @param {string} config.spineUrl
 * @param {number} [config.timeoutMs=5000]
 * @param {number} [config.eventsWindowMs=600000]
 * @param {number} [config.eventsLimit=200]
 * @param {object} [config.sliceTtls]        - per-slice TTL override (ms)
 *   { radiant?, minder?, hippocampus?, graph_structural? } — spine_state is cursor-only
 * @param {number} [config.boundaryBackoffMs=100] - spine cursor backoff (RFI-1)
 * @param {number} [config.probeTtlMs=5000]       - spine /health probe cache TTL (RFI-1)
 */
export function createCmClient(config) {
  const {
    radiantUrl,
    minderUrl,
    hippocampusUrl,
    graphAdapter,
    spineUrl,
    timeoutMs = 5000,
    eventsWindowMs = 600000,
    eventsLimit = 200,
    sliceTtls = {},
    boundaryBackoffMs = 100,
    probeTtlMs = 5000,
  } = config;

  const cache = createWorldStateCache();

  const sliceClients = {
    radiant: createRadiantSliceClient(
      { radiantUrl, timeoutMs },
      cache,
      { ttlMs: sliceTtls.radiant ?? 30000 },
    ),
    minder: createMinderSliceClient(
      { minderUrl, timeoutMs },
      cache,
      { ttlMs: sliceTtls.minder ?? 60000 },
    ),
    hippocampus: createHippocampusSliceClient(
      { hippocampusUrl, timeoutMs, eventsWindowMs },
      cache,
      { ttlMs: sliceTtls.hippocampus ?? 30000 },
    ),
    graph_structural: createGraphStructuralSliceClient(
      { graphAdapter },
      cache,
      { ttlMs: sliceTtls.graph_structural ?? 300000 },
    ),
    spine_state: createSpineStateSliceClient({
      spineUrl,
      timeoutMs,
      eventsWindowMs,
      eventsLimit,
      boundaryBackoffMs,
      probeTtlMs,
    }),
  };

  /**
   * Compose WorldStateSnapshot from all 5 slices via Promise.allSettled.
   * Preserves the snapshot shape from x2p-3 verbatim — gap-analyzer + tests
   * + cv-cm-composed-snapshot continue to consume the same structure.
   *
   * The cache-breakdown event is emitted with a per-call correlation_id;
   * loop-wrappers thread this id forward to the gap-analyzer so the
   * cortex_prompt_size_breakdown + cortex_world_state_cache_breakdown
   * events stitch via shared correlation_id (p4r-2 pattern).
   */
  async function readWorldState(/* missionFrame */) {
    const correlationId = randomUUID();
    const composedAt = new Date();
    const windowSince = new Date(composedAt.getTime() - eventsWindowMs).toISOString();

    const settled = await Promise.allSettled([
      sliceClients.radiant.read(),
      sliceClients.minder.read(),
      sliceClients.hippocampus.read(),
      sliceClients.graph_structural.read(),
      sliceClients.spine_state.read(),
    ]);

    const snapshot = {
      radiant: null,
      minder: null,
      hippocampus: null,
      graph_structural: null,
      spine_state: null,
      composed_at: composedAt.toISOString(),
      window_since: windowSince,
      sources_ok: [],
      sources_degraded: [],
      degraded: [],
    };

    const sliceCacheMetrics = {};

    settled.forEach((result, idx) => {
      const field = SLICE_FIELDS[idx];
      if (result.status === 'fulfilled') {
        const r = result.value;
        sliceCacheMetrics[field] = r._cache || { hit: false, age_ms: 0, fetched_ms: 0 };
        if (r.ok) {
          snapshot[field] = r.data;
          snapshot.sources_ok.push(r.source);
        } else {
          snapshot.sources_degraded.push(`${r.source}: ${r.error}`);
          snapshot.degraded.push(SLICE_TO_DEGRADED_FLAG[field]);
        }
      } else {
        // Promise rejection — slice-client read() should never throw, but
        // defensive handling preserves the prior fail-closed posture.
        const fallbackSource = field.charAt(0).toUpperCase() + field.slice(1).replace('_', '_');
        snapshot.sources_degraded.push(`${fallbackSource}: ${result.reason?.message || 'unknown'}`);
        snapshot.degraded.push(SLICE_TO_REJECTED_FLAG[field]);
        sliceCacheMetrics[field] = { hit: false, age_ms: 0, fetched_ms: 0 };
      }
    });

    log('cortex_world_state_composed', {
      sources_ok: snapshot.sources_ok,
      sources_degraded_count: snapshot.sources_degraded.length,
      spine_state_present: !!snapshot.spine_state,
      transition_count: snapshot.spine_state?.recent_transitions?.length || 0,
      correlation_id: correlationId,
    });

    // p4r-3 §Step 5: per-slice cache breakdown event with cl100k_base token
    // counts per slice. Same correlation_id flows to gap-analyzer's prompt
    // breakdown via loop-wrappers.
    emitWorldStateCacheBreakdown({
      correlationId,
      sliceCacheMetrics,
      sliceData: {
        radiant: snapshot.radiant,
        minder: snapshot.minder,
        hippocampus: snapshot.hippocampus,
        graph_structural: snapshot.graph_structural,
        spine_state: snapshot.spine_state,
      },
    });

    return {
      snapshot,
      sources_ok: snapshot.sources_ok,
      sources_degraded: snapshot.sources_degraded,
      degraded: snapshot.degraded,
      correlation_id: correlationId,
    };
  }

  // p4r-3 §Step 1 addendum: per-slice on-demand fetch for p4r-5 per-section
  // assessment cycles. Returns the raw slice-client read() result (with _cache
  // metadata stripped — caller doesn't need it).
  async function readSlice(sliceName) {
    if (!sliceClients[sliceName]) {
      throw new Error(`Unknown slice: ${sliceName}`);
    }
    const result = await sliceClients[sliceName].read();
    const { _cache, ...rest } = result;
    return rest;
  }

  // p4r-3 §Step 4: cheap availability probe that decouples the spine gate
  // from the spine content fetch. Per-section cycles (p4r-5) can use this
  // to satisfy the gate without forcing a full transitions fetch.
  async function checkSpineAvailable() {
    return sliceClients.spine_state.checkAvailable();
  }

  // Function-with-properties: preserves the existing callable contract
  // (`await cmClient(missionFrame)` continues to work) while exposing
  // new per-slice access for p4r-3 / p4r-5 consumers.
  readWorldState.readSlice = readSlice;
  readWorldState.checkSpineAvailable = checkSpineAvailable;
  readWorldState.sliceClients = sliceClients;
  readWorldState.cache = cache;

  return readWorldState;
}
