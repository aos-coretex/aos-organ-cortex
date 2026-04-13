/**
 * Assessment ring buffer — rolling window of assessment iteration outcomes.
 *
 * Tracks { at, degraded } per iteration so /introspect can expose the
 * degraded-iteration ratio over time-windowed slices (e.g. last 1h, last 24h).
 *
 * C2A-04: the gap analyzer fail-closes to { gaps: [], degraded: [flag] } on
 * any LLM or data-source failure. The same { gaps: [] } shape also represents
 * a healthy organism with nothing to do. The degraded ratio is the aggregate
 * signal that distinguishes aligned-silent from blinded-silent over time.
 *
 * Option 1 implementation — in-memory, resets on restart. Acceptable for the
 * operator question "is Cortex healthy right now." Graduate to Lobe events
 * (Option 2) if historical rollups are needed.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.capacity=1440] - max entries (1440 ~ 24h at 1-min cadence)
 * @returns {{ push, snapshot, size, entries }}
 */
export function createAssessmentRing({ capacity = 1440 } = {}) {
  const buffer = [];
  let head = 0;     // next write position
  let count = 0;    // entries currently stored

  /**
   * Record one assessment iteration outcome.
   * @param {{ at: string, degraded: string[] }} entry
   */
  function push({ at, degraded }) {
    const entry = {
      at: at || new Date().toISOString(),
      degraded: Array.isArray(degraded) ? degraded : [],
    };
    buffer[head] = entry;
    head = (head + 1) % capacity;
    if (count < capacity) count += 1;
  }

  /**
   * Compute degraded-iteration ratio for a time window.
   * @param {number} [windowMs=3600000] - window size in ms (default 1 hour)
   * @returns {{ window_ms, total_iterations, degraded_iterations, ratio, flag_breakdown, oldest_at, newest_at }}
   */
  function snapshot(windowMs = 3600000) {
    const cutoff = Date.now() - windowMs;
    let total = 0;
    let degraded = 0;
    const flagCounts = {};
    let oldest = null;
    let newest = null;

    for (let i = 0; i < count; i++) {
      const idx = (head - count + i + capacity) % capacity;
      const entry = buffer[idx];
      const ts = new Date(entry.at).getTime();
      if (ts < cutoff) continue;

      total += 1;

      if (!oldest || entry.at < oldest) oldest = entry.at;
      if (!newest || entry.at > newest) newest = entry.at;

      if (entry.degraded.length > 0) {
        degraded += 1;
        for (const flag of entry.degraded) {
          flagCounts[flag] = (flagCounts[flag] || 0) + 1;
        }
      }
    }

    return {
      window_ms: windowMs,
      total_iterations: total,
      degraded_iterations: degraded,
      ratio: total > 0 ? degraded / total : 0,
      flag_breakdown: flagCounts,
      oldest_at: oldest,
      newest_at: newest,
    };
  }

  /**
   * @returns {number} entries currently stored
   */
  function size() {
    return count;
  }

  /**
   * Return all entries in chronological order (oldest first).
   * Used by tests — not exposed via /introspect.
   * @returns {Array<{ at: string, degraded: string[] }>}
   */
  function entries() {
    const result = [];
    for (let i = 0; i < count; i++) {
      const idx = (head - count + i + capacity) % capacity;
      result.push(buffer[idx]);
    }
    return result;
  }

  return { push, snapshot, size, entries };
}
