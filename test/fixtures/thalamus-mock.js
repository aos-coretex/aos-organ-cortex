/**
 * Thalamus mock for MP-12 CV tests.
 *
 * Two modes:
 *
 *   1. createThalamusRecorder() — plain in-process recorder. Returns
 *      { received, send, close }. The `send` method records every envelope
 *      passed to it. Use this when you need a Spine-replacement stub injected
 *      into Cortex's goalEmitter directly. No createOrgan, no Spine boot, no
 *      WebSocket — pure JS object suitable for unit-test contexts where the
 *      sandbox cannot run a real Spine.
 *
 *   2. startThalamusMock({ port, spineUrl }) — full createOrgan boot. Returns
 *      { mock, received, close }. Use this when an integration test stands up
 *      a real in-process Spine and needs a Thalamus identity to receive
 *      directed OTMs through the actual routing path. This is the rtime-style
 *      fixture per RFI-1 Q4 (~40 lines).
 *
 * MP-13's real Thalamus must consume envelopes matching the canonical
 * autonomous_goal contract. The recorder's `received` queue is the contract
 * lock — cv-goal-delivery.test.js asserts the envelope shape against this
 * captured envelope, and MP-13 will pin its own parser to the same shape.
 */

import { createOrgan } from '@coretex/organ-boot';

/**
 * Plain recorder — no Spine, no createOrgan. Pass as `spine` to createGoalEmitter
 * for unit tests. Records every envelope passed to send() and returns a fake
 * Spine-style { message_id, status, routing, target_organ } response.
 */
export function createThalamusRecorder() {
  const received = [];
  return {
    received,
    send: async (envelope) => {
      received.push(envelope);
      return {
        message_id: `urn:llm-ops:otm:thalamus-mock-${received.length}`,
        timestamp: new Date().toISOString(),
        status: 'accepted',
        routing: 'directed',
        target_organ: 'Thalamus',
      };
    },
    close: () => { /* no-op for the plain recorder */ },
  };
}

/**
 * Full createOrgan boot. Requires a live Spine at spineUrl. Use for rtime CV
 * smoke tests, NOT for sandbox unit tests.
 */
export async function startThalamusMock({ port = 4041, spineUrl = 'http://127.0.0.1:4000' } = {}) {
  const received = [];

  const organ = await createOrgan({
    name: 'Thalamus',
    port,
    binding: '127.0.0.1',
    spineUrl,
    dependencies: ['Spine'],
    routes: () => {},
    onMessage: async (envelope) => {
      received.push(envelope);
      return null; // no reply
    },
    healthCheck: async () => ({ mock: true }),
    introspectCheck: async () => ({ received_count: received.length }),
  });

  return {
    mock: organ,
    received,
    close: async () => organ.shutdown(),
  };
}
