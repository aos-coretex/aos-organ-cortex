/**
 * Cortex configuration — environment-driven, AOS/SAAS aware.
 *
 * Follows the Senate/Cerberus precedent. LLM config uses shared-lib field
 * names per systemic bug #8 (createLLMClient takes { agentName, defaultModel,
 * defaultProvider, apiKeyEnvVar, maxTokens } directly).
 */

const env = process.env.NODE_ENV || 'development';
const isAOS = env !== 'production';

const vaultRoot = process.env.VAULT_ROOT
  || '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops';

export default {
  name: 'Cortex',
  port: parseInt(process.env.CORTEX_PORT || (isAOS ? '4040' : '3940'), 10),
  binding: '127.0.0.1',

  // Spine (hard dep)
  spineUrl: process.env.SPINE_URL || (isAOS ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:3900'),

  // Collective Memory HTTP endpoints (soft deps — degrade gracefully)
  graphUrl:       process.env.GRAPH_URL       || (isAOS ? 'http://127.0.0.1:4020' : 'http://127.0.0.1:3920'),
  arbiterUrl:     process.env.ARBITER_URL     || (isAOS ? 'http://127.0.0.1:4021' : 'http://127.0.0.1:3921'),
  radiantUrl:     process.env.RADIANT_URL     || (isAOS ? 'http://127.0.0.1:4006' : 'http://127.0.0.1:3906'),
  minderUrl:      process.env.MINDER_URL      || (isAOS ? 'http://127.0.0.1:4007' : 'http://127.0.0.1:3907'),
  hippocampusUrl: process.env.HIPPOCAMPUS_URL || (isAOS ? 'http://127.0.0.1:4008' : 'http://127.0.0.1:3908'),

  // CM query timeouts (per-organ, in ms)
  cmQueryTimeoutMs: parseInt(process.env.CORTEX_CM_TIMEOUT_MS || '5000', 10),

  // Graph adapter timeout — bounds queryConcepts()/getConcept() outbound HTTP.
  // Repair #09 x2p-2 O3: prior graph-adapter had no abort controller, so a
  // hung Graph query could stall the assessment loop. 3000ms is tighter than
  // cmQueryTimeoutMs because Graph is a soft dep with fast local SQLite.
  graphTimeoutMs: parseInt(process.env.CORTEX_GRAPH_TIMEOUT_MS || '3000', 10),

  // Dependency re-probe cycle — how often to refresh the boot-time soft-dep
  // reachability snapshot. x2p-6 O1: prior boot probed once and the result
  // never changed for the lifetime of the process, leaving /health stale
  // when CM organs recovered. x2p-7 §6.1: re-probe on a fixed interval so
  // /health reflects live reachability without operator restart.
  dependencyProbeIntervalMs: parseInt(process.env.CORTEX_DEPENDENCY_PROBE_INTERVAL_MS || '60000', 10),

  // Assessment loop cadence (RFI-1 Q5 — confirmed verbatim)
  loop: {
    floorMs:    parseInt(process.env.CORTEX_LOOP_FLOOR_MS   || '1260000', 10), // 21min (Track-C-coda Day-2; was 30s; pinned per CEO 1404 R Directive 2)
    ceilingMs:  parseInt(process.env.CORTEX_LOOP_CEILING_MS || '1260000', 10), // 21min (Track-C-coda Day-2; was 15min; pinned per CEO 1404 R Directive 2)
    startMs:    parseInt(process.env.CORTEX_LOOP_START_MS   || '1260000', 10), // 21min (Track-C-coda Day-2; was 5min; pinned per CEO 1404 R Directive 2)
    gapDivisor: 2,    // next = max(floor, current / 2)  on gaps found
    idleFactor: 1.5,  // next = min(ceiling, current * 1.5) on idle
    pressureFactor: 2, // next = min(ceiling, current * 2) on Thalamus mailbox_pressure
  },

  // Mission cache TTL (fallback when msp_updated / bor_updated broadcasts are missing)
  missionCacheTtlMs: parseInt(process.env.CORTEX_MISSION_TTL_MS || '600000', 10), // 10min

  // Dependencies passed to createOrgan — Spine only
  dependencies: ['Spine'],

  vaultRoot,
  settingsRoot: process.env.SETTINGS_ROOT || `${vaultRoot}/01-Organs`,

  env,
};
