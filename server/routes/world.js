import { Router } from 'express';

export function createWorldRouter({ cmClient, currentWorldState }) {
  const router = Router();

  router.get('/world/state', async (req, res) => {
    // Option to force a fresh read; default is to return the last-composed snapshot
    if (req.query.fresh === 'true') {
      const result = await cmClient({});
      const snap = result?.snapshot || {};
      res.json({
        summary: summarize(snap),
        sources_ok: snap.sources_ok || result?.sources_ok || [],
        sources_degraded: snap.sources_degraded || result?.sources_degraded || [],
        composed_at: snap.composed_at,
        degraded: snap.degraded || result?.degraded || [],
      });
      return;
    }
    const snapshot = currentWorldState.get();
    if (!snapshot) {
      return res.status(204).end();
    }
    res.json({
      summary: summarize(snapshot),
      sources_ok: snapshot.sources_ok,
      sources_degraded: snapshot.sources_degraded,
      composed_at: snapshot.composed_at,
      degraded: snapshot.degraded,
    });
  });

  return router;
}

function summarize(snap) {
  return {
    radiant_blocks: (snap?.radiant?.recent_context?.length || 0) + (snap?.radiant?.recent_memory?.length || 0),
    minder_observations: snap?.minder?.recent_observations?.length || 0,
    hippocampus_conversations: snap?.hippocampus?.recent_conversations?.length || 0,
    graph_entities: snap?.graph_structural?.recent_entities?.length || 0,
    recent_transitions: snap?.spine_state?.recent_transitions?.length || 0,
  };
}
