/**
 * Collective Memory HTTP client — composes WorldStateSnapshot from 5 sources
 * via direct HTTP reads. RFI-1 Q1 Path A: no Spine directed-message
 * correlation tracker, no spine.send for CM reads. Goals still emit as
 * directed OTMs to Thalamus (relay x2p-5) — that path is unchanged.
 *
 * The 5 sources:
 *   1. Radiant     — GET /context, GET /memory, GET /stats
 *   2. Minder      — GET /peers/recent, GET /observations/recent
 *                    (these endpoints do not yet exist on Minder — runtime will
 *                    receive 404, flag as minder-degraded, empty payload per
 *                    relay-x2p-3 fallback instruction)
 *   3. Hippocampus — GET /conversations?status=completed&since=&limit=
 *   4. Graph       — POST /query for entities + concept-type counts
 *   5. Spine       — GET /events?source_organ=Spine&since=<ISO>&limit=N,
 *                    client-side filter for payload.event_type === 'state_transition'
 *
 * All 5 reads run concurrently via Promise.allSettled. Per-source timeouts
 * apply. Failures flag the source as degraded in sources_degraded and leave
 * the snapshot field null. Returns always — never throws.
 *
 * Graceful degradation rule: spine_state === null pauses the assessment loop
 * (enforced by the loop engine, not here). Partial Radiant/Minder/Hippocampus/
 * Graph degradation is acceptable — cm-client flags and returns anyway.
 */

import { timedFetch } from './http-helpers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Strip a Radiant context/memory block to decision-relevant fields for LLM
 * consumption. Drops:
 *   - `embedding`      — vector index data, never decision-relevant to the LLM
 *   - `lifecycle`      — redundant (container field already implies scope)
 *   - null-valued session_id / source_sessions / promoted_at
 *
 * Retains: id, content, metadata, entity, created_at, expires_at, created_by,
 * and any of the nullable fields when they carry a value.
 *
 * Rationale: C2A 2026-04-22 c2a-cortex-03-lossless-context-cleanup §Source-1.
 * Embedding payloads (~4700 bytes per block, ~65% of a memory block) carry
 * zero signal for strategic assessment; they exist for `radiant.find_similar`
 * only. Stripping is lossless — the LLM sees the same semantic content.
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

/**
 * @param {object} config
 * @param {string} config.radiantUrl
 * @param {string} config.minderUrl
 * @param {string} config.hippocampusUrl
 * @param {object} config.graphAdapter       - from lib/graph-adapter.js (x2p-2)
 * @param {string} config.spineUrl
 * @param {number} config.timeoutMs          - per-source HTTP timeout (default 5000)
 * @param {number} config.eventsWindowMs     - how far back to pull state_transition events (default 600000 = 10 min)
 * @param {number} config.eventsLimit        - max OTMs to fetch from Spine events (default 200)
 * @returns {(missionFrame) => Promise<{ snapshot, sources_ok, sources_degraded, degraded }>}
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
  } = config;

  // --- Per-source readers ---

  async function readRadiant() {
    const urlContext = `${radiantUrl}/context?entity=llm-ops&limit=20`;
    const urlMemory  = `${radiantUrl}/memory?entity=llm-ops&limit=20`;
    const urlStats   = `${radiantUrl}/stats`;
    const [ctxRes, memRes, statsRes] = await Promise.all([
      timedFetch(urlContext, { timeoutMs }),
      timedFetch(urlMemory,  { timeoutMs }),
      timedFetch(urlStats,   { timeoutMs }),
    ]);
    if (!ctxRes.ok && !memRes.ok && !statsRes.ok) {
      return { source: 'Radiant', ok: false, error: ctxRes.error || memRes.error || statsRes.error, data: null };
    }
    return {
      source: 'Radiant',
      ok: true,
      data: {
        recent_context: (ctxRes.data?.blocks || ctxRes.data?.context || []).map(stripRadiantBlock),
        recent_memory:  (memRes.data?.blocks || memRes.data?.memory  || []).map(stripRadiantBlock),
        stats: statsRes.data || { context_count: 0, memory_count: 0, last_dream_at: null },
      },
    };
  }

  async function readMinder() {
    // Minder HTTP surface verified 2026-04-11: /peers/recent and /observations/recent
    // are NOT implemented on Minder. Runtime will 404. Per relay-x2p-3 fallback, we
    // still call them (future-proof) and flag degraded on 404. A follow-up repair
    // task should add these endpoints to Minder or provide equivalent routes.
    const urlPeers = `${minderUrl}/peers/recent?limit=20`;
    const urlObs   = `${minderUrl}/observations/recent?limit=20`;
    const [peersRes, obsRes] = await Promise.all([
      timedFetch(urlPeers, { timeoutMs }),
      timedFetch(urlObs,   { timeoutMs }),
    ]);
    if (!peersRes.ok && !obsRes.ok) {
      return { source: 'Minder', ok: false, error: peersRes.error || obsRes.error, data: null };
    }
    return {
      source: 'Minder',
      ok: true,
      data: {
        active_peers: peersRes.data?.peers || [],
        recent_observations: obsRes.data?.observations || [],
      },
    };
  }

  async function readHippocampus() {
    const since = new Date(Date.now() - eventsWindowMs).toISOString();
    const url = `${hippocampusUrl}/conversations?status=completed&since=${encodeURIComponent(since)}&limit=10`;
    const res = await timedFetch(url, { timeoutMs });
    if (!res.ok) {
      return { source: 'Hippocampus', ok: false, error: res.error, data: null };
    }
    return {
      source: 'Hippocampus',
      ok: true,
      data: {
        // Repair #09 x2p-3 O3: Hippocampus GET /conversations returns
        // participants.user_urn / participants.persona_urn nested, not a
        // flat participant_urn. Prefer user_urn (primary attribution);
        // fall back to persona_urn, then null (defensive parsing against
        // future Hippocampus response shape changes).
        // Verified against AOS-organ-hippocampus-src/server/routes/conversations.js:377-381.
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

  async function readGraphStructural() {
    try {
      // Two independent queries — dispatch in parallel for halved latency
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
        source: 'Graph',
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
      return { source: 'Graph', ok: false, error: err.message, data: null };
    }
  }

  async function readSpineState() {
    const since = new Date(Date.now() - eventsWindowMs).toISOString();
    const url = `${spineUrl}/events?source_organ=Spine&since=${encodeURIComponent(since)}&limit=${eventsLimit}`;
    const res = await timedFetch(url, { timeoutMs });
    if (!res.ok) {
      return { source: 'Spine', ok: false, error: res.error, data: null };
    }
    // Client-side filter for state_transition events
    const allEvents = res.data?.events || [];
    const transitions = allEvents
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
    return {
      source: 'Spine',
      ok: true,
      data: { recent_transitions: transitions },
    };
  }

  // --- Composition ---

  async function readWorldState(/* missionFrame */) {
    const composedAt = new Date();
    const windowSince = new Date(composedAt.getTime() - eventsWindowMs).toISOString();

    const settled = await Promise.allSettled([
      readRadiant(),
      readMinder(),
      readHippocampus(),
      readGraphStructural(),
      readSpineState(),
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

    const fields = ['radiant', 'minder', 'hippocampus', 'graph_structural', 'spine_state'];

    settled.forEach((result, idx) => {
      const field = fields[idx];
      if (result.status === 'fulfilled') {
        const r = result.value;
        if (r.ok) {
          snapshot[field] = r.data;
          snapshot.sources_ok.push(r.source);
        } else {
          snapshot.sources_degraded.push(`${r.source}: ${r.error}`);
          snapshot.degraded.push(`${field.replace('_', '-')}-degraded`);
        }
      } else {
        // Promise rejection — shouldn't happen because readers return {ok:false} instead of throwing,
        // but defensive handling is cheap.
        const fallbackSource = field.charAt(0).toUpperCase() + field.slice(1);
        snapshot.sources_degraded.push(`${fallbackSource}: ${result.reason?.message || 'unknown'}`);
        snapshot.degraded.push(`${field.replace('_', '-')}-rejected`);
      }
    });

    log('cortex_world_state_composed', {
      sources_ok: snapshot.sources_ok,
      sources_degraded_count: snapshot.sources_degraded.length,
      spine_state_present: !!snapshot.spine_state,
      transition_count: snapshot.spine_state?.recent_transitions?.length || 0,
    });

    return { snapshot, sources_ok: snapshot.sources_ok, sources_degraded: snapshot.sources_degraded, degraded: snapshot.degraded };
  }

  return readWorldState;
}
