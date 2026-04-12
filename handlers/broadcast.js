/**
 * Broadcast handler for Cortex.
 *
 * Subscribes to:
 *   - mailbox_pressure: backpressure signal. If data.organ_name === 'Thalamus',
 *     call assessmentLoop.onPressure('Thalamus') to double the next interval.
 *   - msp_updated: Senate-emitted. Invalidate mission cache so the next
 *     assessment re-reads the active MSP.
 *   - bor_updated: Arbiter-emitted (if implemented). Invalidate mission cache
 *     so the next assessment re-reads the active BoR.
 *   - state_transition: Spine-emitted. Observability only — the full snapshot
 *     is composed via GET /events in the assessment cycle.
 *   - governance_version_activated: Senate also emits this alongside msp_updated.
 *
 * Unknown broadcast event_types are logged and ignored.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createBroadcastHandler({ assessmentLoop, missionLoader }) {
  return async function handleBroadcast(envelope) {
    const eventType = envelope?.payload?.event_type;
    switch (eventType) {
      case 'mailbox_pressure': {
        const organName = envelope.payload?.data?.organ_name;
        if (organName === 'Thalamus') {
          log('cortex_thalamus_backpressure', {
            depth: envelope.payload.data.depth,
            threshold: envelope.payload.data.threshold,
          });
          assessmentLoop.onPressure('Thalamus');
        }
        return;
      }
      case 'msp_updated': {
        log('cortex_msp_updated_broadcast', { new_version: envelope.payload?.data?.version });
        missionLoader.invalidate('msp_updated');
        return;
      }
      case 'bor_updated': {
        log('cortex_bor_updated_broadcast', { new_version: envelope.payload?.data?.version });
        missionLoader.invalidate('bor_updated');
        return;
      }
      case 'state_transition': {
        // Intentionally passive (2026-04-11 architect review of x2p-6 O5).
        // The CM pull model re-reads spine-events inside each assessment cycle,
        // so state transitions are already observed on the normal loop cadence.
        // This subscription exists for three reasons:
        //   (1) keeps the Spine WebSocket connection warm with a heartbeat topic,
        //   (2) lets Vigil observe that Cortex is subscribed to the right topics,
        //   (3) preserves optionality for a future nudge-semantic (e.g., calling
        //       assessmentLoop.accelerate() on transition arrival) without
        //       requiring a re-subscription step.
        // If a future relay wants to react to transitions push-style, wire a
        // nudge call here. Until then: log and continue.
        log('cortex_state_transition_observed', {
          event_type: envelope.payload?.event_type,
          source: envelope?.source_organ,
        });
        return;
      }
      case 'governance_version_activated': {
        log('cortex_governance_version_activated', { version: envelope.payload?.data?.version });
        missionLoader.invalidate('governance_version_activated');
        return;
      }
      default: {
        // Silent ignore for unknown broadcast types
        return;
      }
    }
  };
}
