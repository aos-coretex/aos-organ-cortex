#!/usr/bin/env node
/**
 * p4r-7 fixture-build script — Path III (live-state composition).
 *
 * Phase 1 (--phase=natural): captures live-state snapshots from the running
 *   Spine/Graph/Radiant/Minder/Hippocampus/Arbiter services into fixture
 *   quadruples (missionFrame, worldState, recentGoals=[], correlation_id).
 *   No LLM calls. Writes natural-<ISO>-<rand6>.json per snapshot.
 *
 * Phase 2 (--phase=augmented): re-emits Phase 1 worldStates with synthetic
 *   recentGoals patterns (empty / low-priority-steady / critical-burst /
 *   mixed). No LLM calls; no platform calls. Writes augmented-<pattern>-
 *   <ISO>-<rand6>.json sampling natural-* fixtures.
 *
 * Idempotent: counts existing fixtures in --out-dir; resumes from current count.
 *
 * No supremacy-gate breach: does NOT start the Cortex daemon; calls
 * mission-loader/cm-client/slice-fetchers as pure functions over HTTP.
 *
 * Anchor: RFI-2 reply (2026-05-03 10:30 EDT) — Path III + Phase 1+2 augmented
 * distribution strategy ratified by EA.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createGraphAdapter } from '../lib/graph-adapter.js';
import { createArbiterClient } from '../lib/arbiter-client.js';
import { createMissionLoader } from '../lib/mission-loader.js';
import { createCmClient } from '../lib/cm-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7');

const DEFAULTS = {
  phase: 'natural',
  count: 50,
  intervalMs: 300_000, // 5 min — EA RFI-2 reply spec
  outDir: DEFAULT_OUT_DIR,
  spineUrl:       'http://127.0.0.1:4000',
  graphUrl:       'http://127.0.0.1:4020',
  arbiterUrl:     'http://127.0.0.1:4021',
  radiantUrl:     'http://127.0.0.1:4006',
  minderUrl:      'http://127.0.0.1:4007',
  hippocampusUrl: 'http://127.0.0.1:4008',
  // Production cmTimeoutMs is 5s (gates the live assessment loop). Fixture-build
  // is offline and tolerant of slower slice fetches; bump to 15s so the Spine
  // /events?since=<10min>&limit=200 query (~5-6s on a busy event store) does
  // not time out and force spine_state-degraded fixtures.
  cmTimeoutMs: 15000,
  graphTimeoutMs: 5000,
  // Phase 2 distribution: 4 patterns × ~7-8 fixtures each = ~30 augmented fixtures
  augmentedPatterns: ['empty', 'low-priority-steady', 'critical-burst', 'mixed'],
  augmentedPerPattern: 8,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--phase':              args.phase = next; i++; break;
      case '--count':              args.count = parseInt(next, 10); i++; break;
      case '--interval-ms':        args.intervalMs = parseInt(next, 10); i++; break;
      case '--out-dir':            args.outDir = next; i++; break;
      case '--spine-url':          args.spineUrl = next; i++; break;
      case '--graph-url':          args.graphUrl = next; i++; break;
      case '--arbiter-url':        args.arbiterUrl = next; i++; break;
      case '--radiant-url':        args.radiantUrl = next; i++; break;
      case '--minder-url':         args.minderUrl = next; i++; break;
      case '--hippocampus-url':    args.hippocampusUrl = next; i++; break;
      case '--augmented-per-pattern': args.augmentedPerPattern = parseInt(next, 10); i++; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1);
    }
  }
  if (!['natural', 'augmented'].includes(args.phase)) {
    console.error(`--phase must be "natural" or "augmented" (got "${args.phase}")`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
p4r-7 fixture-build script — Path III live-state composition.

Usage: node tools/build-precision-verification-fixtures.js [options]

Phase 1 (live-state snapshots):
  --phase natural          Capture live-state fixtures
  --count 50               Target fixture count
  --interval-ms 300000     Snapshot interval (default 5 min)

Phase 2 (synthetic recentGoals augmentation):
  --phase augmented        Re-emit natural fixtures with synthetic recentGoals
  --augmented-per-pattern 8  Fixtures per pattern (4 patterns × 8 = 32 default)

Common:
  --out-dir <path>         Output directory (default: test/fixtures/p4r-7)
  --spine-url, --graph-url, --arbiter-url,
  --radiant-url, --minder-url, --hippocampus-url
                           Service endpoints (defaults to AOS ports 4000/4020/...)

Idempotent: counts existing fixtures in out-dir; resumes from current count.
No LLM calls. No Cortex daemon restart.
`);
}

function rand6() {
  return Math.random().toString(36).slice(2, 8);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listFixtures(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function logEvent(event, data = {}) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data }) + '\n');
}

// --- Phase 1: live-state snapshots ---

async function captureSnapshot({ missionLoader, cmClient }) {
  const captured_at = new Date().toISOString();
  let missionFrame, worldStateResult, captureError = null;
  try {
    missionFrame = await missionLoader.loadMission();
  } catch (err) {
    captureError = `mission-loader-failed: ${err.message}`;
    return { captured_at, captureError };
  }
  try {
    worldStateResult = await cmClient(missionFrame);
  } catch (err) {
    captureError = `cm-client-failed: ${err.message}`;
    return { captured_at, missionFrame, captureError };
  }
  return {
    captured_at,
    missionFrame,
    worldState: worldStateResult.snapshot,
    sources_ok: worldStateResult.sources_ok,
    sources_degraded: worldStateResult.sources_degraded,
    source_correlation_id: worldStateResult.correlation_id,
    captureError: null,
  };
}

async function runPhase1(args) {
  ensureDir(args.outDir);

  // Force-invalidate mission cache by setting cacheTtlMs short — we want
  // each snapshot to re-read from Graph + Arbiter so different snapshots
  // can capture mission-state changes if they occur. cm-client slice-clients
  // have their own per-slice TTLs (radiant=30s, minder=60s, hippo=30s,
  // graph_structural=300s, spine_state=cursor) — these provide diversity
  // independent of mission cache.
  const graphAdapter = createGraphAdapter({ graphUrl: args.graphUrl, timeoutMs: args.graphTimeoutMs });
  const arbiterClient = createArbiterClient({ arbiterUrl: args.arbiterUrl, timeoutMs: args.cmTimeoutMs });
  const missionLoader = createMissionLoader({
    graphAdapter,
    arbiterClient,
    cacheTtlMs: 1000, // 1s — effectively no cache; each snapshot re-fetches
  });
  const cmClient = createCmClient({
    radiantUrl: args.radiantUrl,
    minderUrl: args.minderUrl,
    hippocampusUrl: args.hippocampusUrl,
    graphAdapter,
    spineUrl: args.spineUrl,
    timeoutMs: args.cmTimeoutMs,
  });

  const existing = listFixtures(args.outDir, 'natural-');
  let captured = existing.length;
  logEvent('p4r7_fixture_build_phase1_start', {
    target_count: args.count,
    existing_count: captured,
    interval_ms: args.intervalMs,
    out_dir: args.outDir,
  });

  while (captured < args.count) {
    const start = Date.now();
    const snap = await captureSnapshot({ missionLoader, cmClient });
    if (snap.captureError) {
      logEvent('p4r7_fixture_build_capture_error', { error: snap.captureError, captured });
      // Wait the interval and retry; don't increment captured count
    } else {
      const fixture_id = `natural-${snap.captured_at}-${rand6()}`;
      const fixture = {
        fixture_id,
        phase: 'natural',
        recentGoals_pattern: null,
        parent_natural_fixture_id: null,
        captured_at: snap.captured_at,
        missionFrame: snap.missionFrame,
        worldState: snap.worldState,
        recentGoals: [],
        source_correlation_id: snap.source_correlation_id,
        sources_ok: snap.sources_ok,
        sources_degraded: snap.sources_degraded,
      };
      const filepath = path.join(args.outDir, `${fixture_id}.json`);
      fs.writeFileSync(filepath, JSON.stringify(fixture, null, 2));
      captured += 1;
      logEvent('p4r7_fixture_build_captured', {
        fixture_id,
        captured,
        target: args.count,
        sources_ok: snap.sources_ok,
        sources_degraded_count: snap.sources_degraded?.length || 0,
        spine_present: !!snap.worldState?.spine_state,
        transition_count: snap.worldState?.spine_state?.recent_transitions?.length || 0,
      });
    }
    if (captured >= args.count) break;
    const elapsed = Date.now() - start;
    const sleepMs = Math.max(0, args.intervalMs - elapsed);
    await new Promise(r => setTimeout(r, sleepMs));
  }

  logEvent('p4r7_fixture_build_phase1_complete', {
    captured,
    target: args.count,
    out_dir: args.outDir,
  });
}

// --- Phase 2: synthetic-recentGoals augmentation ---

const SYNTHETIC_RECENT_GOALS = {
  empty: () => [],
  'low-priority-steady': () => {
    const arr = [];
    for (let i = 0; i < 10; i++) {
      arr.push({
        goal_id: `urn:llm-ops:goal:phase2-low-${i}-${rand6()}`,
        description: `Routine maintenance goal #${i + 1}`,
        priority: i % 2 === 0 ? 'medium' : 'low',
        dispatched_at: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        gap_ref: `urn:llm-ops:cortex-gap:phase2-low-${i}-${rand6()}`,
        mission_ref: 'MSP §routine-operations',
      });
    }
    return arr;
  },
  'critical-burst': () => {
    const arr = [];
    for (let i = 0; i < 5; i++) {
      arr.push({
        goal_id: `urn:llm-ops:goal:phase2-crit-${i}-${rand6()}`,
        description: `Critical incident response goal #${i + 1}`,
        priority: 'critical',
        dispatched_at: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
        gap_ref: `urn:llm-ops:cortex-gap:phase2-crit-${i}-${rand6()}`,
        mission_ref: 'MSP §incident-response',
      });
    }
    return arr;
  },
  mixed: () => {
    const tiers = ['critical', 'high', 'medium', 'low'];
    const arr = [];
    for (let t = 0; t < tiers.length; t++) {
      for (let i = 0; i < 4; i++) {
        const idx = t * 4 + i;
        arr.push({
          goal_id: `urn:llm-ops:goal:phase2-mix-${tiers[t]}-${i}-${rand6()}`,
          description: `Mixed-priority goal ${tiers[t]} #${i + 1}`,
          priority: tiers[t],
          dispatched_at: new Date(Date.now() - (16 - idx) * 60_000).toISOString(),
          gap_ref: `urn:llm-ops:cortex-gap:phase2-mix-${tiers[t]}-${i}-${rand6()}`,
          mission_ref: `MSP §${tiers[t]}-priority`,
        });
      }
    }
    return arr;
  },
};

function pickRandom(arr, n) {
  // Sample with replacement bias toward worldState diversity (per EA spec)
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.floor(Math.random() * arr.length)]);
  }
  return out;
}

async function runPhase2(args) {
  ensureDir(args.outDir);
  const naturalFiles = listFixtures(args.outDir, 'natural-');
  if (naturalFiles.length === 0) {
    console.error(`Phase 2 requires Phase 1 fixtures in ${args.outDir}; found 0 natural-*.json`);
    process.exit(1);
  }

  const naturalFixtures = naturalFiles.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  logEvent('p4r7_fixture_build_phase2_start', {
    natural_count: naturalFixtures.length,
    patterns: args.augmentedPatterns,
    per_pattern: args.augmentedPerPattern,
    out_dir: args.outDir,
  });

  let augmentedCount = listFixtures(args.outDir, 'augmented-').length;

  for (const pattern of args.augmentedPatterns) {
    const samples = pickRandom(naturalFixtures, args.augmentedPerPattern);
    for (const sample of samples) {
      const captured_at = new Date().toISOString();
      const fixture_id = `augmented-${pattern}-${captured_at}-${rand6()}`;
      const fixture = {
        fixture_id,
        phase: 'augmented',
        recentGoals_pattern: pattern,
        parent_natural_fixture_id: sample.fixture_id,
        captured_at,
        missionFrame: sample.missionFrame,
        worldState: sample.worldState,
        recentGoals: SYNTHETIC_RECENT_GOALS[pattern](),
        source_correlation_id: sample.source_correlation_id, // inherits parent
        sources_ok: sample.sources_ok,
        sources_degraded: sample.sources_degraded,
      };
      const filepath = path.join(args.outDir, `${fixture_id}.json`);
      fs.writeFileSync(filepath, JSON.stringify(fixture, null, 2));
      augmentedCount += 1;
      logEvent('p4r7_fixture_build_phase2_emitted', {
        fixture_id,
        pattern,
        parent: sample.fixture_id,
        recentGoals_count: fixture.recentGoals.length,
        augmentedCount,
      });
    }
  }

  logEvent('p4r7_fixture_build_phase2_complete', {
    augmented_count: augmentedCount,
    out_dir: args.outDir,
  });
}

// --- entrypoint ---

(async () => {
  const args = parseArgs(process.argv);
  if (args.phase === 'natural') {
    await runPhase1(args);
  } else {
    await runPhase2(args);
  }
})().catch(err => {
  logEvent('p4r7_fixture_build_fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
