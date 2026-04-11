/**
 * In-memory ring buffer for the last N dispatched goals. Used by the gap
 * analyzer to provide context about recent goals (so the LLM doesn't re-emit
 * the same gap on every assessment cycle).
 *
 * Zero persistence — Cortex holds no state on disk. Restart resets history.
 */

export function createGoalHistory({ limit = 20 } = {}) {
  const buf = [];

  function add(goal) {
    buf.push({
      goal_id: goal.goal_id,
      description: goal.description,
      priority: goal.priority,
      dispatched_at: new Date().toISOString(),
      gap_ref: goal.gap_ref || null,
      mission_ref: goal.mission_ref || null,
    });
    while (buf.length > limit) buf.shift();
  }

  function list() {
    return [...buf];
  }

  function size() {
    return buf.length;
  }

  function clear() {
    buf.length = 0;
  }

  return { add, list, size, clear };
}
