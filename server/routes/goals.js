import { Router } from 'express';

export function createGoalsRouter({ goalHistory }) {
  const router = Router();

  router.get('/goals/active', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const status = req.query.status || null;
    let goals = goalHistory.list();
    if (status) goals = goals.filter(g => g.status === status);
    res.json({
      goals: goals.slice(-limit).reverse(),  // most recent first
      count: goals.length,
    });
  });

  return router;
}
