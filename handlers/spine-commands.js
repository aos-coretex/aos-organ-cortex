/**
 * Directed OTM handler for Cortex.
 *
 * Cortex is strictly OTM-only on every surface — inbound AND outbound. Per
 * x2p-5 landing observation O2, Cortex MUST reject any inbound directed
 * message whose envelope.type is not 'OTM'. Governance message types
 * (APM/PEM/ATM/HOM) are forbidden on Cortex's inbound surface; Cortex is
 * not a governance participant and must never consume them. The rejection
 * is a distinct log tag so Vigil can detect wrong-surface traffic without
 * silently absorbing it.
 *
 * Cortex consumes very few directed OTMs. The canonical ones:
 *   - ping: auto-handled by the live loop (not reached here)
 *   - assessment_request: operational trigger (externally-initiated, same as POST /assessment/trigger)
 *   - health_check: observability — returns current stats
 *   - job_record_created / job_dispatched / job_completed / job_failed:
 *     Thalamus acknowledgment lifecycle for a previously-dispatched goal.
 *     Per x2p-5 landing observation O2: the full set is handled
 *     (observability-only, does not affect the assessment loop) so replies
 *     do not rot in Cortex's mailbox when Thalamus eventually closes out a
 *     goal lifecycle. Goal history metadata is NOT updated here — the
 *     observation-only discipline stays simple; a later relay may wire
 *     richer lifecycle tracking into goalHistory if operator needs surface.
 *
 * Unknown OTM event_types are logged and ignored — Cortex never errors on
 * unexpected inbound messages because other organs may broadcast new
 * event_types Cortex is not yet aware of.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createDirectedHandler({ assessmentLoop, goalHistory }) {
  return async function handleDirected(envelope) {
    const envelopeType = envelope?.type;
    const eventType = envelope?.payload?.event_type;

    // OTM-only discipline (x2p-5 O2): reject non-OTM inbound directed messages.
    // Cortex is not a governance participant and must never consume APM/PEM/ATM/HOM.
    if (envelopeType && envelopeType !== 'OTM') {
      log('cortex_non_otm_directed_rejected', {
        envelope_type: envelopeType,
        source: envelope?.source_organ,
        message_id: envelope?.message_id,
      });
      return { error: 'non-otm-directed-rejected', envelope_type: envelopeType };
    }

    log('cortex_directed_received', {
      event_type: eventType,
      source: envelope?.source_organ,
      message_id: envelope?.message_id,
    });

    switch (eventType) {
      case 'assessment_request': {
        const reason = envelope.payload?.reason || `directed-${envelope.source_organ}`;
        const result = await assessmentLoop.trigger({ reason });
        return {
          event_type: 'assessment_triggered',
          triggered: !result.skipped,
          skipped: !!result.skipped,
          iteration: result.iteration || null,
        };
      }
      case 'health_check': {
        const stats = assessmentLoop.getStats();
        return {
          event_type: 'health_response',
          status: stats.stopped ? 'down' : 'ok',
          loop_iteration: stats.loop_iteration,
          current_interval_ms: stats.current_interval_ms,
        };
      }
      case 'job_record_created':
      case 'job_dispatched':
      case 'job_completed':
      case 'job_failed': {
        // Thalamus goal-lifecycle acknowledgment — observability only.
        // Per x2p-5 O2 recommendation: handle the full lifecycle set so replies
        // do not rot in Cortex's mailbox. goalHistory metadata is NOT updated
        // here (stays simple); a later relay may wire richer lifecycle tracking.
        log('cortex_thalamus_lifecycle_ack', {
          event_type: eventType,
          goal_id: envelope.payload?.goal_id,
        });
        return null;
      }
      default: {
        log('cortex_unknown_directed_event_type', { event_type: eventType });
        return null;
      }
    }
  };
}
