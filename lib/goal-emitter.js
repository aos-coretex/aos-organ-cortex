/**
 * Goal emitter — builds the structured autonomous-goal envelope and dispatches
 * it as a directed OTM to Thalamus via the Spine client. Populated in relay
 * x2p-5.
 *
 * @param {object} gap
 * @param {object} missionFrame
 * @returns {Promise<{ goal_id: string, dispatched: boolean, error?: string }>}
 */
export function createGoalEmitter(/* config */) {
  return async function emitGoal(/* gap, missionFrame */) {
    return {
      goal_id: null,
      dispatched: false,
      error: 'goal-emitter-not-wired-relay-x2p-5',
    };
  };
}
