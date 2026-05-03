#!/usr/bin/env node
/**
 * p4r-7 replay orchestrator — runs legacy + modular replay on each fixture
 * and persists per-fixture replay envelopes for downstream measurement.
 *
 * Reads fixtures from --fixtures-dir; for each `natural-*.json` and `augmented-
 * *.json`, runs replayBoth(fixture, ctx) and persists `<fixture_id>-replay.json`
 * with `{ legacy: {...}, modular: {...}, replayed_at }`.
 *
 * Idempotent: skips fixtures whose replay file already exists.
 *
 * Cost guardrails:
 *   - Tracks running LLM call count + estimates cost at $0.07/call
 *   - Aborts if estimated cost exceeds --cost-cap (default $40 — Leon's authorized ceiling)
 *
 * Pre-flight gates:
 *   - LOCAL_LLM_API_KEY env var must be set
 *   - LLM endpoint (default 127.0.0.1:3810) must respond
 *
 * Anchor: RFI-2 reply (2026-05-03 10:30 EDT) — Path III + Phase 1+2 ratified.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLoader } from '@coretex/organ-boot/llm-settings-loader';
import { replayBoth } from '../lib/precision-verification-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7');
const DEFAULT_REPLAYS_DIR  = path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7', 'replays');

const DEFAULTS = {
  fixturesDir: DEFAULT_FIXTURES_DIR,
  replaysDir:  DEFAULT_REPLAYS_DIR,
  costCapUsd:  40,
  perCallUsd:  0.07, // EA RFI-2 cost-cap arithmetic (conservative; actual ~$0.02/call empirically)
  concurrency: 4,    // parallelize replay across fixtures (LiteLLM proxy handles concurrent reqs)
  // The settings root and organ for llmLoader.resolve(); matches server/index.js
  vaultRoot:    process.env.VAULT_ROOT || '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops',
  organNumber:  225,
  organName:    'cortex',
  agentName:    'gap-analyzer',
  // Pre-flight LLM endpoint check
  llmEndpointHealthUrl: null, // derived from settings deployment_target if not given
  abortOnFailure: true,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  args.settingsRoot = `${args.vaultRoot}/01-Organs`;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--fixtures-dir':       args.fixturesDir = next; i++; break;
      case '--replays-dir':        args.replaysDir = next; i++; break;
      case '--cost-cap':           args.costCapUsd = parseFloat(next); i++; break;
      case '--per-call-usd':       args.perCallUsd = parseFloat(next); i++; break;
      case '--settings-root':      args.settingsRoot = next; i++; break;
      case '--continue-on-error':  args.abortOnFailure = false; break;
      case '--concurrency':        args.concurrency = parseInt(next, 10); i++; break;
      case '--help':
      case '-h':
        printHelp(); process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
p4r-7 replay orchestrator — runs legacy + modular gap-analyzer on each fixture.

Usage: node tools/run-precision-verification-replay.js [options]

Options:
  --fixtures-dir <path>        Directory with natural-*.json + augmented-*.json (default: test/fixtures/p4r-7)
  --replays-dir <path>         Output directory for <fixture_id>-replay.json (default: <fixtures-dir>/replays)
  --cost-cap <usd>             Abort if cumulative est. cost exceeds this (default: 40)
  --per-call-usd <usd>         Cost per LLM call estimate (default: 0.07)
  --settings-root <path>       Override llmLoader settingsRoot
  --continue-on-error          Continue past per-fixture errors (default: abort)

Pre-flight: requires LOCAL_LLM_API_KEY env var; verifies LLM endpoint health
before starting; idempotent (skips existing replays).
`);
}

function logEvent(event, data = {}) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data }) + '\n');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  return entries
    .filter(f => (f.startsWith('natural-') || f.startsWith('augmented-')) && f.endsWith('.json'))
    .map(f => path.join(dir, f))
    .sort();
}

async function preflight(args) {
  const apiKey = process.env.LOCAL_LLM_API_KEY;
  if (!apiKey) {
    logEvent('p4r7_replay_preflight_fail', { reason: 'LOCAL_LLM_API_KEY env var not set' });
    return { ok: false, reason: 'LOCAL_LLM_API_KEY env var not set' };
  }

  const llmLoader = createLoader({
    organNumber: args.organNumber,
    organName: args.organName,
    settingsRoot: args.settingsRoot,
  });
  let resolved;
  try {
    resolved = llmLoader.resolve(args.agentName);
  } catch (err) {
    logEvent('p4r7_replay_preflight_fail', { reason: `llm-settings-resolve-failed: ${err.message}` });
    return { ok: false, reason: `llm-settings-resolve-failed: ${err.message}` };
  }

  // Probe the deployment_target (typically 127.0.0.1:3810)
  const target = resolved.deployment_target || '127.0.0.1:3810';
  const healthUrl = `http://${target}/v1/models`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(healthUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status >= 200 && res.status < 300) {
      logEvent('p4r7_replay_preflight_ok', {
        agent: resolved.agentName,
        model: resolved.defaultModel,
        provider: resolved.defaultProvider,
        deployment_target: target,
        max_tokens: resolved.maxTokens,
      });
      return { ok: true, llmConfig: resolved, llmLoader };
    }
    logEvent('p4r7_replay_preflight_fail', { reason: `endpoint-status: ${res.status} from ${healthUrl}` });
    return { ok: false, reason: `endpoint-status: ${res.status}` };
  } catch (err) {
    logEvent('p4r7_replay_preflight_fail', { reason: `endpoint-unreachable: ${err.message}` });
    return { ok: false, reason: `endpoint-unreachable: ${err.message}` };
  }
}

function buildLlmClient(args, llmLoader, agentName) {
  const { config: resolved, chat } = llmLoader.resolveWithCascade(agentName);
  const apiKeyEnv = resolved.apiKeyEnvVar || 'LOCAL_LLM_API_KEY';
  return {
    chat,
    isAvailable: () => Boolean(process.env[apiKeyEnv]),
    getUsage: () => ({ agent: resolved.agentName, model: resolved.defaultModel, provider: resolved.defaultProvider }),
  };
}

(async () => {
  const args = parseArgs(process.argv);
  ensureDir(args.replaysDir);

  // Pre-flight
  const pf = await preflight(args);
  if (!pf.ok) {
    console.error(`Pre-flight FAIL: ${pf.reason}. Aborting.`);
    process.exit(2);
  }

  const llmConfig = pf.llmConfig;
  const llm = buildLlmClient(args, pf.llmLoader, args.agentName);

  // Discover fixtures
  const fixtureFiles = listFixtures(args.fixturesDir);
  if (fixtureFiles.length === 0) {
    logEvent('p4r7_replay_no_fixtures', { fixtures_dir: args.fixturesDir });
    console.error(`No fixtures found in ${args.fixturesDir}. Run Phase 1+2 first.`);
    process.exit(3);
  }

  logEvent('p4r7_replay_start', {
    fixture_count: fixtureFiles.length,
    fixtures_dir: args.fixturesDir,
    replays_dir: args.replaysDir,
    cost_cap_usd: args.costCapUsd,
    per_call_usd: args.perCallUsd,
  });

  let totalLlmCalls = 0;
  let totalCostUsd = 0;
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let aborted = false;

  // Filter to fixtures that need replay (idempotent — skip if already done)
  const todo = [];
  for (const fixturePath of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const replayPath = path.join(args.replaysDir, `${fixture.fixture_id}-replay.json`);
    if (fs.existsSync(replayPath)) {
      skipped += 1;
    } else {
      todo.push({ fixture, replayPath });
    }
  }

  async function processOne({ fixture, replayPath }) {
    if (aborted) return;
    try {
      const result = await replayBoth(fixture, { llm, llmConfig, sliceFetchers: undefined });
      const callCount = (result.legacy.llm_calls?.length || 0) + (result.modular.llm_calls?.length || 0);
      totalLlmCalls += callCount;
      totalCostUsd += callCount * args.perCallUsd;

      const persisted = {
        fixture_id: result.fixture_id,
        phase: result.phase,
        recentGoals_pattern: result.recentGoals_pattern,
        legacy: {
          gaps: result.legacy.gaps,
          degraded: result.legacy.degraded,
          raw_response: result.legacy.raw_response,
          correlation_id: result.legacy.correlation_id,
          latency_ms: result.legacy.latency_ms,
          llm_call_count: result.legacy.llm_calls?.length || 0,
        },
        modular: {
          gaps: result.modular.gaps,
          degraded: result.modular.degraded,
          raw_responses: result.modular.raw_responses,
          per_domain_outputs: result.modular.per_domain_outputs,
          correlation_id: result.modular.correlation_id,
          latency_ms: result.modular.latency_ms,
          llm_call_count: result.modular.llm_calls?.length || 0,
        },
        replayed_at: result.replayed_at,
      };
      fs.writeFileSync(replayPath, JSON.stringify(persisted, null, 2));
      processed += 1;
      logEvent('p4r7_replay_fixture_complete', {
        fixture_id: fixture.fixture_id,
        legacy_gaps: result.legacy.gaps.length,
        modular_gaps: result.modular.gaps.length,
        legacy_degraded: result.legacy.degraded.length,
        modular_degraded: result.modular.degraded.length,
        legacy_latency_ms: result.legacy.latency_ms,
        modular_latency_ms: result.modular.latency_ms,
        cumulative_calls: totalLlmCalls,
        cumulative_cost_usd: Number(totalCostUsd.toFixed(4)),
        processed, skipped, todo: todo.length,
      });
      if (totalCostUsd > args.costCapUsd) {
        aborted = true;
        logEvent('p4r7_replay_cost_cap_exceeded', {
          total_cost_usd: totalCostUsd, cost_cap_usd: args.costCapUsd,
          processed, skipped, errors,
        });
      }
    } catch (err) {
      errors += 1;
      logEvent('p4r7_replay_fixture_error', {
        fixture_id: fixture.fixture_id, error: err.message, stack: err.stack,
      });
      if (args.abortOnFailure) {
        aborted = true;
      }
    }
  }

  // Concurrency-bounded queue
  const queue = [...todo];
  async function worker() {
    while (queue.length > 0 && !aborted) {
      const item = queue.shift();
      if (!item) break;
      await processOne(item);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));

  logEvent('p4r7_replay_complete', {
    processed, skipped, errors,
    total_calls: totalLlmCalls,
    total_cost_usd: Number(totalCostUsd.toFixed(4)),
  });
})().catch(err => {
  logEvent('p4r7_replay_fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
