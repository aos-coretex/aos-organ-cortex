import { Router } from 'express';

export function createAssessmentRouter({ assessmentLoop, currentGaps, currentAssessmentMeta }) {
  const router = Router();

  // GET /assessment/current — last assessment cycle's gap list
  router.get('/assessment/current', (_req, res) => {
    const stats = assessmentLoop.getStats();
    res.json({
      gaps: currentGaps.list(),
      last_assessment: currentAssessmentMeta.get().lastAt,
      loop_iteration: stats.loop_iteration,
      assessment_duration_ms: stats.last_assessment_duration_ms,
      current_interval_ms: stats.current_interval_ms,
      degraded: currentAssessmentMeta.get().degraded,
    });
  });

  // POST /assessment/trigger — force immediate cycle (does NOT disrupt schedule)
  router.post('/assessment/trigger', async (req, res) => {
    const reason = req.body?.reason || 'operator-request';
    const result = await assessmentLoop.trigger({ reason });
    res.status(201).json({
      triggered: !result.skipped,
      skipped: !!result.skipped,
      assessment_id: `urn:llm-ops:assessment:${Date.now()}`,
      timestamp: new Date().toISOString(),
      reason,
      iteration: result.iteration || null,
    });
  });

  return router;
}
