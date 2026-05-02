/**
 * Per-domain slice-extraction fetchers for the per-domain analyzer factory (p4r-6).
 *
 * Each fetcher takes the already-composed worldState (cm-client output) and
 * returns the subset relevant to one gap-domain. This is pure projection over
 * read-only data — Cortex never writes to Collective Memory (§4.3).
 *
 * The compliance fetcher currently extracts governance-class state-transitions
 * from spine_state. Downstream (post-Scope-1) may add a dedicated governance
 * organ slice; the fetcher signature absorbs that change without rippling.
 *
 * The constitutional fetcher returns an empty object: constitutional analysis
 * reasons from BoR (mission anchor) alone — no slice required.
 */

export const DOMAIN_SLICE_FETCHERS = Object.freeze({
  operational: async (worldState) => ({
    spine_state: worldState?.spine_state ?? null,
  }),

  strategic: async (worldState) => ({
    radiant: worldState?.radiant ?? null,
  }),

  relational: async (worldState) => ({
    minder: worldState?.minder ?? null,
    hippocampus: worldState?.hippocampus ?? null,
  }),

  compliance: async (worldState) => {
    const transitions = worldState?.spine_state?.recent_transitions;
    const governance = Array.isArray(transitions)
      ? transitions.filter((t) => t && t.type === 'governance')
      : [];
    return { governance_state: governance };
  },

  // Constitutional analyzer reasons from BoR alone (mission anchor). No slice
  // required; returning empty object keeps the analyzer factory contract uniform.
  constitutional: async (_worldState) => ({}),
});
