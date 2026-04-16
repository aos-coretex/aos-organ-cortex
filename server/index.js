/**
 * Cortex (#225) — Strategic Brain / Autonomous Assessment Loop
 *
 * Boot sequence (per RFI-1 Q1/Q2/Q3/Q5 + organ-shared-lib createOrgan lifecycle):
 *   1. Load config
 *   2. Probe soft dependencies (Graph, Arbiter, Radiant, Minder, Hippocampus) — non-blocking
 *   3. Instantiate Graph adapter + Arbiter client
 *   4. Instantiate mission loader + cm client
 *   5. Instantiate goal history + spineProxy
 *   6. Instantiate gap analyzer + goal emitter
 *   7. Instantiate loop wrappers (halt-on-spine-null semantics — lib/loop-wrappers.js)
 *   8. Instantiate assessment loop
 *   9. Build health/introspect checks (lib/health-probes.js)
 *  10. Boot organ via createOrgan
 *      - dependencies: ['Spine'] only
 *      - routes: assessment/goals/mission/world
 *      - onMessage: directed OTM handler
 *      - onBroadcast: broadcast handler
 *      - subscriptions: mailbox_pressure, msp_updated, bor_updated, state_transition, governance_version_activated
 *      - healthCheck / introspectCheck: FLAT objects (bug #9) via buildHealthCheck/buildIntrospectCheck
 *      - onStartup: bind spineProxy, run first assessment immediately (RFI-1 Q5)
 *      - onShutdown: stop the loop, clear goal history
 */

import config from './config.js';
import { createOrgan } from '@coretex/organ-boot';
import { createLoader } from '@coretex/organ-boot/llm-settings-loader';
import { initializeUsageAttribution } from '@coretex/organ-boot/usage-attribution';

import { createGraphAdapter } from '../lib/graph-adapter.js';
import { createArbiterClient } from '../lib/arbiter-client.js';
import { createMissionLoader } from '../lib/mission-loader.js';
import { createCmClient } from '../lib/cm-client.js';
import { createGapAnalyzer } from '../lib/gap-analyzer.js';
import { createGoalEmitter } from '../lib/goal-emitter.js';
import { createGoalHistory } from '../lib/goal-history.js';
import { createAssessmentLoop } from '../lib/assessment-loop.js';
import { createSpineProxy } from '../lib/spine-proxy.js';
import {
  createCmClientWrapper,
  createGapAnalyzerWrapper,
  createStateHolders,
} from '../lib/loop-wrappers.js';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';
import { createAssessmentRing } from '../lib/assessment-ring.js';
import { timedFetch } from '../lib/http-helpers.js';

import { createDirectedHandler } from '../handlers/spine-commands.js';
import { createBroadcastHandler } from '../handlers/broadcast.js';

import { createAssessmentRouter } from './routes/assessment.js';
import { createGoalsRouter } from './routes/goals.js';
import { createMissionRouter } from './routes/mission.js';
import { createWorldRouter } from './routes/world.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// --- Soft-dep probes (non-blocking) ---
//
// x2p-7 §6.4: probeHttp delegates to the shared timedFetch helper for uniform
// { ok, status, error } shape and the X-Organ-Name: Cortex header. The probe
// snapshot in `probes` is mutable so the §6.1 re-probe cycle can refresh it
// in place — observers reading via /health always see the latest reachability.

async function probeHttp(url, name) {
  const res = await timedFetch(`${url}/health`, { timeoutMs: 2000 });
  log('cortex_probe', { organ: name, reachable: res.ok, status: res.status, error: res.error });
  return res.ok;
}

const probes = {
  graph:       await probeHttp(config.graphUrl, 'Graph'),
  arbiter:     await probeHttp(config.arbiterUrl, 'Arbiter'),
  radiant:     await probeHttp(config.radiantUrl, 'Radiant'),
  minder:      await probeHttp(config.minderUrl, 'Minder'),
  hippocampus: await probeHttp(config.hippocampusUrl, 'Hippocampus'),
};

// x2p-7 §6.1: dependency re-probe cycle. Started in onStartup, cleared in
// onShutdown. Mutates `probes` in place so /health reflects live reachability.
async function reprobeAllDependencies() {
  const next = await Promise.all([
    probeHttp(config.graphUrl, 'Graph'),
    probeHttp(config.arbiterUrl, 'Arbiter'),
    probeHttp(config.radiantUrl, 'Radiant'),
    probeHttp(config.minderUrl, 'Minder'),
    probeHttp(config.hippocampusUrl, 'Hippocampus'),
  ]);
  probes.graph = next[0];
  probes.arbiter = next[1];
  probes.radiant = next[2];
  probes.minder = next[3];
  probes.hippocampus = next[4];
}

let probeTimer = null;

// --- Component instantiation ---

const graphAdapter = createGraphAdapter({
  graphUrl: config.graphUrl,
  timeoutMs: config.graphTimeoutMs,
});

const arbiterClient = createArbiterClient({
  arbiterUrl: config.arbiterUrl,
  timeoutMs: config.cmQueryTimeoutMs,
});

const missionLoader = createMissionLoader({
  graphAdapter,
  arbiterClient,
  cacheTtlMs: config.missionCacheTtlMs,
});

const cmClient = createCmClient({
  radiantUrl: config.radiantUrl,
  minderUrl: config.minderUrl,
  hippocampusUrl: config.hippocampusUrl,
  graphAdapter,
  spineUrl: config.spineUrl,
  timeoutMs: config.cmQueryTimeoutMs,
});

const goalHistory = createGoalHistory({ limit: 20 });
const spineProxy = createSpineProxy();

// --- LLM settings loader (MP-CONFIG-1 R7 migration — l9m-7) ---
// Cortex remains DORMANT per binding decision (session-8 cost discovery).
// Migration makes Cortex redirectable to Haiku via settings alone; R12's
// restart gate is where re-enablement is tested. This relay does NOT start
// Cortex as a LaunchAgent. Bug #8 field-name discipline is load-bearing —
// `toLLMClientConfig` from the loader emits `agentName`/`defaultModel`/
// `defaultProvider`/`apiKeyEnvVar`/`maxTokens` verbatim.

const llmLoader = createLoader({
  organNumber: 225,
  organName: 'cortex',
  settingsRoot: config.settingsRoot,
});

// MP-CONFIG-1 R9 — register the process-default usage writer. Cortex stays
// DORMANT by binding decision; this wiring arms the audit trail for R12's
// restart gate so the Haiku-downshift projection has real llm_usage_event
// records to aggregate.
initializeUsageAttribution({ organName: 'Cortex', graphUrl: config.graphUrl });

function buildLlmClient(agentName) {
  const { config: resolved, chat } = llmLoader.resolveWithCascade(agentName);
  const apiKeyEnv = resolved.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
  return {
    chat,
    isAvailable: () => Boolean(process.env[apiKeyEnv]),
    getUsage: () => ({ agent: resolved.agentName, model: resolved.defaultModel, provider: resolved.defaultProvider }),
  };
}

const gapAnalyzerLlmConfig = llmLoader.resolve('gap-analyzer');
const gapAnalyzerLlmClient = buildLlmClient('gap-analyzer');

const gapAnalyzer = createGapAnalyzer({
  // Preserve the `llmConfig` field (bug #8 shape) for internal `maxTokens` consumer.
  llmConfig: gapAnalyzerLlmConfig,
  injectedLlm: gapAnalyzerLlmClient,
  goalHistory,
});

const goalEmitter = createGoalEmitter({
  spine: spineProxy,
  goalHistory,
  getIteration: () => assessmentLoop.getStats().loop_iteration,
});

// --- Observability state holders + loop wrappers (extracted to lib/loop-wrappers.js) ---

// C2A-04: in-memory ring buffer for degraded-iteration ratio (Option 1).
// Pushed on every currentAssessmentMeta.set() — one entry per assessment iteration.
const assessmentRing = createAssessmentRing({ capacity: 1440 });

const { currentGaps, currentAssessmentMeta, currentWorldState } = createStateHolders({ assessmentRing });

const wrappedCmClient = createCmClientWrapper({
  cmClient,
  currentWorldState,
  currentAssessmentMeta,
});

const wrappedGapAnalyzer = createGapAnalyzerWrapper({
  gapAnalyzer,
  currentGaps,
  currentAssessmentMeta,
});

// --- Assessment loop wiring ---

const assessmentLoop = createAssessmentLoop({
  cadence: config.loop,
  missionLoader: missionLoader.loadMission,
  cmClient: wrappedCmClient,
  gapAnalyzer: wrappedGapAnalyzer,
  goalEmitter,
});

// --- Boot organ ---

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,
  dependencies: config.dependencies, // ['Spine']

  routes: (app) => {
    app.use(createAssessmentRouter({ assessmentLoop, currentGaps, currentAssessmentMeta }));
    app.use(createGoalsRouter({ goalHistory }));
    app.use(createMissionRouter({ missionLoader }));
    app.use(createWorldRouter({ cmClient: wrappedCmClient, currentWorldState }));
  },

  onMessage: createDirectedHandler({ assessmentLoop, goalHistory }),

  onBroadcast: createBroadcastHandler({ assessmentLoop, missionLoader }),

  subscriptions: [
    { event_type: 'mailbox_pressure' },
    { event_type: 'msp_updated' },
    { event_type: 'bor_updated' },
    { event_type: 'state_transition' },
    { event_type: 'governance_version_activated' },
  ],

  // Flat return (bug #9) — shared-lib wraps into `checks`. See lib/health-probes.js for
  // the aligned-silent vs blinded-silent surface (x2p-4 O4: last_assessment_degraded).
  // x2p-7 §6.2: real llm_available state via gapAnalyzer.llm (was hardcoded true).
  healthCheck: buildHealthCheck({
    probes,
    assessmentLoop,
    currentAssessmentMeta,
    llm: gapAnalyzer.llm,
  }),

  // Flat return (bug #9) — shared-lib wraps into `extra`.
  // C2A-04: assessmentRing feeds degraded_ratio into /introspect.
  introspectCheck: buildIntrospectCheck({
    cadence: config.loop,
    assessmentLoop,
    goalHistory,
    missionLoader,
    assessmentRing,
    llmLoader,
  }),

  onStartup: async ({ spine }) => {
    spineProxy.bind(spine);
    log('cortex_spine_bound', { spine_url: config.spineUrl });

    // x2p-7 §6.1: start the dependency re-probe cycle so /health reflects live
    // reachability. Started AFTER spineProxy.bind so it doesn't race the boot
    // snapshot. Unref'd so the timer never holds the process open on its own.
    probeTimer = setInterval(() => {
      reprobeAllDependencies().catch((err) =>
        log('cortex_dependency_probe_error', { error: err.message }),
      );
    }, config.dependencyProbeIntervalMs);
    if (probeTimer.unref) probeTimer.unref();

    // RFI-1 Q5: first assessment iteration runs immediately inside onStartup.
    // Do NOT use setTimeout(assess, startMs) — that would introduce a 5-minute delay.
    try {
      await assessmentLoop.start();
      log('cortex_assessment_loop_started', {
        initial_interval_ms: assessmentLoop.getStats().current_interval_ms,
      });
    } catch (err) {
      log('cortex_assessment_loop_start_failed', { error: err.message });
      // Do not throw — the organ should still boot even if the first assessment fails.
      // The loop will retry on its next scheduled iteration.
    }
  },

  onShutdown: async () => {
    log('cortex_shutting_down', {
      total_goals: assessmentLoop.getStats().total_goals_generated,
      total_iterations: assessmentLoop.getStats().loop_iteration,
    });
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    assessmentLoop.stop();
    goalHistory.clear();
  },
});

log('cortex_ready', { port: config.port, profile: 'probabilistic', artifact: 'logic' });

// The shared lib wires SIGTERM/SIGINT; `organ.shutdown()` is called automatically on signal.
