/**
 * Per-slice CM clients — independent slice-readers for the 5 world-state
 * sources (radiant / minder / hippocampus / graph_structural / spine_state).
 *
 * Authored as part of relay p4r-3 (MP-p4r). Decomposes the previously
 * monolithic readWorldState() into 5 independent slice-readers, each with
 * its own cache strategy:
 *
 *   - radiant:          30s TTL via shared world-state-cache
 *   - minder:           60s TTL via shared world-state-cache
 *   - hippocampus:      30s TTL via shared world-state-cache
 *   - graph_structural: 5min TTL via shared world-state-cache
 *   - spine_state:      NO TTL — incremental cursor + window-evict
 *                       (per RFI-1 ruling: timestamp-cursor + transition_id-dedup
 *                        + boundaryBackoffMs config; equivalent to id-cursor for
 *                        the architectural ≥80% per-cycle Spine fetch reduction;
 *                        adapted to actual /events?since=<ISO timestamp> shape)
 *
 * Each factory returns { read, invalidate, peekCache }. spine_state additionally
 * exposes checkAvailable() for the gate-vs-content separation (Step 4 of relay).
 *
 * read() return shape (uniform across slices, augments the prior x2p-3 shape
 * with a _cache metadata block for the orchestrator's breakdown event):
 *
 *   { source, ok, data, error?, _cache: { hit, age_ms, fetched_ms,
 *                                          new_transitions?, evicted? } }
 *
 * The orchestrator (cm-client.js) strips _cache before composing the snapshot
 * — the LLM never sees cache metadata.
 */

import { timedFetch } from './http-helpers.js';

/**
 * Strip a Radiant context/memory block to decision-relevant fields.
 * Drops embedding (vector index, ~65% of block weight, zero LLM signal),
 * lifecycle (redundant), and null-valued session_id / source_sessions /
 * promoted_at. Retains content + metadata + entity + timestamps.
 *
 * Per C2A 2026-04-22 c2a-cortex-03-lossless-context-cleanup §Source-1.
 */
function stripRadiantBlock(block) {
  if (!block || typeof block !== 'object') return block;
  const clean = {};
  for (const [key, value] of Object.entries(block)) {
    if (key === 'embedding' || key === 'lifecycle') continue;
    if ((key === 'session_id' || key === 'source_sessions' || key === 'promoted_at') && value == null) continue;
    clean[key] = value;
  }
  return clean;
}

// --- Radiant slice client ---

/**
 * @param {object} config
 * @param {string} config.radiantUrl
 * @param {number} [config.timeoutMs=5000]
 * @param {object} cache - shared world-state-cache instance
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=30000] - per-cycle change-detection cache TTL
 */
export function createRadiantSliceClient({ radiantUrl, timeoutMs = 5000 }, cache, { ttlMs = 30000 } = {}) {
  const sliceName = 'radiant';

  async function fetchFromOrgan() {
    const urlContext = `${radiantUrl}/context?entity=llm-ops&limit=20`;
    const urlMemory  = `${radiantUrl}/memory?entity=llm-ops&limit=20`;
    const urlStats   = `${radiantUrl}/stats`;
    const [ctxRes, memRes, statsRes] = await Promise.all([
      timedFetch(urlContext, { timeoutMs }),
      timedFetch(urlMemory,  { timeoutMs }),
      timedFetch(urlStats,   { timeoutMs }),
    ]);
    if (!ctxRes.ok && !memRes.ok && !statsRes.ok) {
      return { ok: false, error: ctxRes.error || memRes.error || statsRes.error, data: null };
    }
    return {
      ok: true,
      data: {
        recent_context: (ctxRes.data?.blocks || ctxRes.data?.context || []).map(stripRadiantBlock),
        recent_memory:  (memRes.data?.blocks || memRes.data?.memory  || []).map(stripRadiantBlock),
        stats: statsRes.data || { context_count: 0, memory_count: 0, last_dream_at: null },
      },
    };
  }

  async function read() {
    const cached = cache.get(sliceName);
    if (cached.hit) {
      return {
        source: 'Radiant',
        ok: true,
        data: cached.value,
        _cache: { hit: true, age_ms: cached.age_ms, fetched_ms: 0 },
      };
    }
    const t0 = Date.now();
    const result = await fetchFromOrgan();
    const fetched_ms = Date.now() - t0;
    if (result.ok) {
      cache.set(sliceName, result.data, ttlMs);
      return { source: 'Radiant', ok: true, data: result.data, _cache: { hit: false, age_ms: 0, fetched_ms } };
    }
    return { source: 'Radiant', ok: false, error: result.error, data: null, _cache: { hit: false, age_ms: 0, fetched_ms } };
  }

  function invalidate() { cache.invalidate(sliceName); }
  function peekCache() { return cache.peek()[sliceName] || { hit: false, age_ms: 0, expires_in_ms: 0 }; }

  return { read, invalidate, peekCache };
}

// --- Minder slice client ---

/**
 * @param {object} config
 * @param {string} config.minderUrl
 * @param {number} [config.timeoutMs=5000]
 * @param {object} cache
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=60000]
 */
export function createMinderSliceClient({ minderUrl, timeoutMs = 5000 }, cache, { ttlMs = 60000 } = {}) {
  const sliceName = 'minder';

  async function fetchFromOrgan() {
    // Minder /peers/recent + /observations/recent endpoints not yet implemented
    // on Minder (verified 2026-04-11). Runtime returns 404; flag degraded.
    const urlPeers = `${minderUrl}/peers/recent?limit=20`;
    const urlObs   = `${minderUrl}/observations/recent?limit=20`;
    const [peersRes, obsRes] = await Promise.all([
      timedFetch(urlPeers, { timeoutMs }),
      timedFetch(urlObs,   { timeoutMs }),
    ]);
    if (!peersRes.ok && !obsRes.ok) {
      return { ok: false, error: peersRes.error || obsRes.error, data: null };
    }
    return {
      ok: true,
      data: {
        active_peers: peersRes.data?.peers || [],
        recent_observations: obsRes.data?.observations || [],
      },
    };
  }

  async function read() {
    const cached = cache.get(sliceName);
    if (cached.hit) {
      return { source: 'Minder', ok: true, data: cached.value, _cache: { hit: true, age_ms: cached.age_ms, fetched_ms: 0 } };
    }
    const t0 = Date.now();
    const result = await fetchFromOrgan();
    const fetched_ms = Date.now() - t0;
    if (result.ok) {
      cache.set(sliceName, result.data, ttlMs);
      return { source: 'Minder', ok: true, data: result.data, _cache: { hit: false, age_ms: 0, fetched_ms } };
    }
    return { source: 'Minder', ok: false, error: result.error, data: null, _cache: { hit: false, age_ms: 0, fetched_ms } };
  }

  function invalidate() { cache.invalidate(sliceName); }
  function peekCache() { return cache.peek()[sliceName] || { hit: false, age_ms: 0, expires_in_ms: 0 }; }

  return { read, invalidate, peekCache };
}

// --- Hippocampus slice client ---

/**
 * @param {object} config
 * @param {string} config.hippocampusUrl
 * @param {number} [config.timeoutMs=5000]
 * @param {number} [config.eventsWindowMs=600000] - sliding-window for since= filter
 * @param {object} cache
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=30000]
 */
export function createHippocampusSliceClient(
  { hippocampusUrl, timeoutMs = 5000, eventsWindowMs = 600000 },
  cache,
  { ttlMs = 30000 } = {},
) {
  const sliceName = 'hippocampus';

  async function fetchFromOrgan() {
    const since = new Date(Date.now() - eventsWindowMs).toISOString();
    const url = `${hippocampusUrl}/conversations?status=completed&since=${encodeURIComponent(since)}&limit=10`;
    const res = await timedFetch(url, { timeoutMs });
    if (!res.ok) return { ok: false, error: res.error, data: null };
    return {
      ok: true,
      data: {
        // Repair #09 x2p-3 O3: nested participants shape — prefer user_urn,
        // fall back to persona_urn, then null. See cm-client.test.js for
        // the legacy / edge-case coverage.
        recent_conversations: (res.data?.conversations || []).map(c => ({
          urn: c.urn,
          summary: c.summary,
          participant_urn: c.participants?.user_urn || c.participants?.persona_urn || null,
          message_count: c.message_count,
          completed_at: c.updated_at || c.completed_at,
        })),
      },
    };
  }

  async function read() {
    const cached = cache.get(sliceName);
    if (cached.hit) {
      return { source: 'Hippocampus', ok: true, data: cached.value, _cache: { hit: true, age_ms: cached.age_ms, fetched_ms: 0 } };
    }
    const t0 = Date.now();
    const result = await fetchFromOrgan();
    const fetched_ms = Date.now() - t0;
    if (result.ok) {
      cache.set(sliceName, result.data, ttlMs);
      return { source: 'Hippocampus', ok: true, data: result.data, _cache: { hit: false, age_ms: 0, fetched_ms } };
    }
    return { source: 'Hippocampus', ok: false, error: result.error, data: null, _cache: { hit: false, age_ms: 0, fetched_ms } };
  }

  function invalidate() { cache.invalidate(sliceName); }
  function peekCache() { return cache.peek()[sliceName] || { hit: false, age_ms: 0, expires_in_ms: 0 }; }

  return { read, invalidate, peekCache };
}

// --- Graph (structural) slice client ---

/**
 * @param {object} config
 * @param {object} config.graphAdapter
 * @param {object} cache
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=300000] - 5-minute TTL (low-volatility slice)
 */
export function createGraphStructuralSliceClient({ graphAdapter }, cache, { ttlMs = 300000 } = {}) {
  const sliceName = 'graph_structural';

  async function fetchFromOrgan() {
    try {
      const [entitiesResult, countsResult] = await Promise.all([
        graphAdapter.queryConcepts(
          `SELECT urn, data FROM concepts
           WHERE data->>'type' = 'entity'
           ORDER BY created_at DESC
           LIMIT 20`,
          [],
        ),
        graphAdapter.queryConcepts(
          `SELECT data->>'type' AS type, COUNT(*) AS count
           FROM concepts
           GROUP BY data->>'type'`,
          [],
        ),
      ]);
      return {
        ok: true,
        data: {
          recent_entities: (entitiesResult.rows || []).map(r => {
            const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            return { urn: r.urn, type: d.type, status: d.status, tier: d.tier };
          }),
          recent_concept_counts_by_type: (countsResult.rows || []).reduce((acc, row) => {
            acc[row.type] = row.count;
            return acc;
          }, {}),
        },
      };
    } catch (err) {
      return { ok: false, error: err.message, data: null };
    }
  }

  async function read() {
    const cached = cache.get(sliceName);
    if (cached.hit) {
      return { source: 'Graph', ok: true, data: cached.value, _cache: { hit: true, age_ms: cached.age_ms, fetched_ms: 0 } };
    }
    const t0 = Date.now();
    const result = await fetchFromOrgan();
    const fetched_ms = Date.now() - t0;
    if (result.ok) {
      cache.set(sliceName, result.data, ttlMs);
      return { source: 'Graph', ok: true, data: result.data, _cache: { hit: false, age_ms: 0, fetched_ms } };
    }
    return { source: 'Graph', ok: false, error: result.error, data: null, _cache: { hit: false, age_ms: 0, fetched_ms } };
  }

  function invalidate() { cache.invalidate(sliceName); }
  function peekCache() { return cache.peek()[sliceName] || { hit: false, age_ms: 0, expires_in_ms: 0 }; }

  return { read, invalidate, peekCache };
}

// --- Spine_state slice client (incremental cursor + window-evict) ---

/**
 * Spine slice with incremental-cursor design (relay Step 3 + RFI-1 ruling).
 *
 * Cursor mechanism:
 *   - Spine /events?since=<ISO> filters server-side via WHERE created_at >= ?
 *     (timestamp-based, NOT id-based — RFI-1 Q1 Option A approved).
 *   - Track `lastSeenCreatedAt` client-side (ISO string).
 *   - On read(), compute `since = max(now - eventsWindowMs,
 *     lastSeenCreatedAt - boundaryBackoffMs)` — clamps to rolling window so we
 *     never fetch older than the bound; backoff (default 100ms) absorbs
 *     clock-skew / async-write-batch / retry-after-error edge cases.
 *   - Dedup new transitions against cachedTransitions by transition_id.
 *   - Window-evict cached transitions older than now - eventsWindowMs.
 *
 * checkAvailable() — cheap probe for gate-vs-content separation (Step 4):
 *   - GET /health (Spine exposes it via createHealthRouter); no transition fetch.
 *   - Result cached for probeTtlMs (default 5s) to avoid hammering Spine
 *     when per-section cycles probe repeatedly.
 *
 * Both boundaryBackoffMs and probeTtlMs are config-tunable per RFI-1 reply
 * for empirical R9 soak adjustment.
 */
export function createSpineStateSliceClient({
  spineUrl,
  timeoutMs = 5000,
  eventsWindowMs = 600000,
  eventsLimit = 200,
  boundaryBackoffMs = 100,
  probeTtlMs = 5000,
}) {
  let lastSeenCreatedAt = null;
  let cachedTransitions = [];
  let availabilityCache = null; // { value: boolean, expiresAt: number }

  function maxIso(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  async function fetchSlice() {
    const now = Date.now();
    const windowFloorIso = new Date(now - eventsWindowMs).toISOString();
    const cursorIso = lastSeenCreatedAt
      ? new Date(new Date(lastSeenCreatedAt).getTime() - boundaryBackoffMs).toISOString()
      : windowFloorIso;
    const since = cursorIso < windowFloorIso ? windowFloorIso : cursorIso;

    const url = `${spineUrl}/events?source_organ=Spine&since=${encodeURIComponent(since)}&limit=${eventsLimit}`;
    const res = await timedFetch(url, { timeoutMs });
    if (!res.ok) {
      return { ok: false, error: res.error, meta: { new_transitions: 0, evicted: 0 } };
    }

    const allEvents = res.data?.events || [];
    const incoming = allEvents
      .filter(e => e.envelope?.payload?.event_type === 'state_transition')
      .map(e => ({
        entity_urn:     e.envelope.payload.data?.entity_urn,
        previous_state: e.envelope.payload.data?.previous_state,
        current_state:  e.envelope.payload.data?.current_state,
        transition_id:  e.envelope.payload.data?.transition_id,
        actor:          e.envelope.payload.data?.actor,
        reason:         e.envelope.payload.data?.reason,
        timestamp:      e.created_at,
      }));

    // Dedup against cached set on transition_id (per RFI-1 ruling — required
    // by inclusive `created_at >= ?` filter when boundary backoff is applied).
    const seen = new Set(cachedTransitions.map(t => t.transition_id).filter(Boolean));
    const trulyNew = incoming.filter(t => !t.transition_id || !seen.has(t.transition_id));

    // Append + window-evict.
    cachedTransitions = cachedTransitions.concat(trulyNew);
    const evictBeforeIso = new Date(now - eventsWindowMs).toISOString();
    const beforeEvictCount = cachedTransitions.length;
    cachedTransitions = cachedTransitions.filter(t => !t.timestamp || t.timestamp >= evictBeforeIso);
    const evicted = beforeEvictCount - cachedTransitions.length;

    // Advance cursor to max timestamp among truly-new transitions.
    if (trulyNew.length > 0) {
      const maxNewTs = trulyNew.reduce((acc, t) => maxIso(acc, t.timestamp), null);
      lastSeenCreatedAt = maxIso(lastSeenCreatedAt, maxNewTs);
    }

    return {
      ok: true,
      data: { recent_transitions: cachedTransitions },
      meta: { new_transitions: trulyNew.length, evicted },
    };
  }

  async function read() {
    const t0 = Date.now();
    const result = await fetchSlice();
    const fetched_ms = Date.now() - t0;
    if (result.ok) {
      return {
        source: 'Spine',
        ok: true,
        data: result.data,
        _cache: { hit: false, age_ms: 0, fetched_ms, ...result.meta },
      };
    }
    return {
      source: 'Spine',
      ok: false,
      error: result.error,
      data: null,
      _cache: { hit: false, age_ms: 0, fetched_ms, ...result.meta },
    };
  }

  async function checkAvailable() {
    const now = Date.now();
    if (availabilityCache && now < availabilityCache.expiresAt) {
      return availabilityCache.value;
    }
    const url = `${spineUrl}/health`;
    const res = await timedFetch(url, { timeoutMs });
    const available = !!res.ok;
    availabilityCache = { value: available, expiresAt: now + probeTtlMs };
    return available;
  }

  function invalidate() {
    lastSeenCreatedAt = null;
    cachedTransitions = [];
    availabilityCache = null;
  }

  function peekCache() {
    return {
      lastSeenCreatedAt,
      cached_count: cachedTransitions.length,
      availability_probed: availabilityCache !== null,
      available: availabilityCache?.value ?? null,
      probe_expires_in_ms: availabilityCache ? Math.max(0, availabilityCache.expiresAt - Date.now()) : 0,
    };
  }

  return { read, checkAvailable, invalidate, peekCache };
}
