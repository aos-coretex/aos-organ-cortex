import { Router } from 'express';

export function createMissionRouter({ missionLoader }) {
  const router = Router();

  router.get('/mission/state', async (_req, res) => {
    const frame = await missionLoader.loadMission();
    res.json({
      msp: frame.msp
        ? {
            urn: frame.msp.urn,
            version: frame.msp.version,
            hash: frame.msp.hash,
            status: frame.msp.status,
            activated_at: frame.msp.activated_at,
            raw_text_present: !!frame.msp.raw_text,
          }
        : null,
      bor: frame.bor
        ? {
            version: frame.bor.version,
            hash: frame.bor.hash,
            effective_since: frame.bor.effective_since,
            raw_text_present: !!frame.bor.raw_text,
          }
        : null,
      last_read: frame.loaded_at,
      cache_expires_at: frame.cache_expires_at,
      degraded: frame.degraded,
    });
  });

  // The /mission/state endpoint deliberately does NOT return raw_text — only
  // metadata and a raw_text_present boolean. BoR and MSP text are constitutional
  // and sensitive; consumers that need the text should query Graph (for MSP)
  // or Arbiter (for BoR) directly.

  return router;
}
