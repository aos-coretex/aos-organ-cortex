/**
 * Mission loader — composes a MissionFrame from:
 *   1. Active msp_version concept read via Graph adapter (POST /query)
 *      Extracts data.raw_text — Senate g1n-2 Fix 2 threading (required).
 *   2. Active BoR raw text fetched from Arbiter GET /bor/raw
 *      Added by the parallel repair brief `repair-agent-arbiter-bor-raw-endpoint`.
 *
 * Cache semantics:
 *   - Mission data is cached with TTL (default 10min, configurable).
 *   - Cache is invalidated by `msp_updated` / `bor_updated` broadcasts wired
 *     in relay x2p-6. This loader exposes invalidate() and the broadcast
 *     handler calls it.
 *   - Each assessment cycle calls loadMission(); the cache short-circuits
 *     repeated reads within the TTL window.
 *
 * Degradation flags:
 *   - `msp-missing-from-graph` — Graph returned no active msp_version
 *   - `msp-raw-text-absent`    — concept exists but data.raw_text is empty
 *                                (pre-Fix-2 legacy concept compat)
 *   - `graph-unreachable`      — Graph adapter error
 *   - `bor-unavailable`        — Arbiter returned null (endpoint down/missing)
 *   - `arbiter-unreachable`    — Arbiter endpoint missing or network error
 *
 * RFI-1 Q3 amendment: Cortex reads both MSP and BoR raw text as
 * constitutional conditioning. Cortex NEVER rules on scope. Scope rulings
 * belong to Arbiter at Nomos → Arbiter adjudication time.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createMissionLoader({ graphAdapter, arbiterClient, cacheTtlMs = 600000 }) {
  let cached = null;
  let cacheExpiresAt = 0;

  async function loadMSPFromGraph() {
    const degraded = [];
    try {
      // Senate g1n-2 writes: type='msp_version', data.status='active'
      const sql = `SELECT urn, data, created_at
                   FROM concepts
                   WHERE data->>'type' = 'msp_version'
                     AND data->>'status' = 'active'
                   ORDER BY created_at DESC
                   LIMIT 1`;
      const result = await graphAdapter.queryConcepts(sql, []);
      const rows = result?.rows || [];
      if (rows.length === 0) {
        log('cortex_msp_not_found');
        degraded.push('msp-missing-from-graph');
        return { msp: null, degraded };
      }
      const row = rows[0];
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (!data.raw_text) {
        log('cortex_msp_raw_text_absent', { urn: row.urn });
        degraded.push('msp-raw-text-absent');
        // Still return the concept metadata — LLM may work with version/hash only, flagged degraded
        return {
          msp: {
            urn: row.urn,
            version: data.version || 'unknown',
            hash: data.hash || '',
            raw_text: '',
            status: data.status,
            activated_at: data.activated_at || row.created_at,
          },
          degraded,
        };
      }
      return {
        msp: {
          urn: row.urn,
          version: data.version,
          hash: data.hash,
          raw_text: data.raw_text,
          status: data.status,
          activated_at: data.activated_at || row.created_at,
        },
        degraded: [],
      };
    } catch (err) {
      log('cortex_graph_unreachable_for_msp', { error: err.message });
      return { msp: null, degraded: ['graph-unreachable'] };
    }
  }

  async function loadBoRFromArbiter() {
    try {
      const bor = await arbiterClient.getBoRRaw();
      if (bor === null) {
        return { bor: null, degraded: ['bor-unavailable'] };
      }
      return { bor, degraded: [] };
    } catch (err) {
      log('cortex_arbiter_unreachable_for_bor', { error: err.message });
      return { bor: null, degraded: ['arbiter-unreachable'] };
    }
  }

  async function loadMission() {
    const now = Date.now();
    if (cached && now < cacheExpiresAt) {
      return cached;
    }

    const [mspResult, borResult] = await Promise.all([
      loadMSPFromGraph(),
      loadBoRFromArbiter(),
    ]);

    const frame = {
      msp: mspResult.msp,
      bor: borResult.bor,
      loaded_at: new Date(now).toISOString(),
      cache_expires_at: new Date(now + cacheTtlMs).toISOString(),
      degraded: [...mspResult.degraded, ...borResult.degraded],
    };

    log('cortex_mission_loaded', {
      msp_present: !!frame.msp,
      msp_version: frame.msp?.version || null,
      bor_present: !!frame.bor,
      bor_version: frame.bor?.version || null,
      degraded: frame.degraded,
    });

    cached = frame;
    cacheExpiresAt = now + cacheTtlMs;
    return frame;
  }

  function invalidate(reason) {
    log('cortex_mission_cache_invalidated', { reason });
    cached = null;
    cacheExpiresAt = 0;
  }

  function peekCache() {
    return cached;
  }

  // p4r-2 Step 2c: explicit static-string getters for the Layer 1 fallback
  // path (organ-side cache). Each routes through loadMission() so cache
  // semantics (TTL + msp_updated/bor_updated invalidation) are uniform.
  // The provider (openai-compatible endpoint serving Cortex) does not
  // honor Anthropic's `cache_control` directive, so these getters give
  // call sites a stable accessor without re-reading the graph or arbiter
  // per cycle.
  async function getMSPText() {
    const frame = await loadMission();
    return frame.msp?.raw_text ?? null;
  }

  async function getBoRText() {
    const frame = await loadMission();
    if (!frame.bor) return null;
    return typeof frame.bor === 'string' ? frame.bor : (frame.bor.raw_text ?? null);
  }

  return { loadMission, invalidate, peekCache, getMSPText, getBoRText };
}
