/**
 * World-state cache — per-slice TTL cache for the 4 cacheable CM slices
 * (radiant / minder / hippocampus / graph_structural). The spine_state slice
 * does NOT use this cache; it has incremental cursor state internal to its
 * slice-client (see lib/slice-clients.js::createSpineStateSliceClient).
 *
 * Authored as part of relay p4r-3 (MP-p4r) — Layer 2 dedicated cache layer
 * separate from mission-loader. Per-organ caching with change-detection
 * invalidation is the architectural unlock for the radiant/minder/graph
 * slices (see decomposition spec §5.6: cache leverage HIGH/HIGH/HIGHEST).
 *
 * Contract:
 *   - get(name) returns { hit, value, age_ms, expires_in_ms }; on miss/expire
 *     returns { hit: false, ... zeros }.
 *   - set(name, value, ttlMs?) writes with computed expiresAt.
 *   - invalidate(name) removes one entry; invalidateAll() clears all.
 *   - peek() returns a per-slice introspection map without mutating state.
 *
 * No emit / no log: this module is pure storage. Instrumentation lives in
 * prompt-size-instrumentation.js (cortex_world_state_cache_breakdown event)
 * which reads cache metrics via the slice-clients' read() return shape.
 */

export function createWorldStateCache({ defaultTtlMs = 60000 } = {}) {
  const entries = new Map(); // sliceName -> { value, expiresAt, fetchedAt }

  function get(sliceName) {
    const entry = entries.get(sliceName);
    if (!entry) {
      return { hit: false, value: null, age_ms: 0, expires_in_ms: 0 };
    }
    const now = Date.now();
    if (now >= entry.expiresAt) {
      entries.delete(sliceName);
      return { hit: false, value: null, age_ms: 0, expires_in_ms: 0, expired: true };
    }
    return {
      hit: true,
      value: entry.value,
      age_ms: now - entry.fetchedAt,
      expires_in_ms: entry.expiresAt - now,
    };
  }

  function set(sliceName, value, ttlMs) {
    const ttl = typeof ttlMs === 'number' ? ttlMs : defaultTtlMs;
    const now = Date.now();
    entries.set(sliceName, { value, expiresAt: now + ttl, fetchedAt: now });
  }

  function invalidate(sliceName) {
    entries.delete(sliceName);
  }

  function invalidateAll() {
    entries.clear();
  }

  function peek() {
    const out = {};
    const now = Date.now();
    for (const [name, entry] of entries.entries()) {
      const live = now < entry.expiresAt;
      out[name] = {
        hit: live,
        age_ms: now - entry.fetchedAt,
        expires_in_ms: live ? entry.expiresAt - now : 0,
      };
    }
    return out;
  }

  return { get, set, invalidate, invalidateAll, peek };
}
