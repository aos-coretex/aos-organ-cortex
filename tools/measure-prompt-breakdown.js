#!/usr/bin/env node
/**
 * measure-prompt-breakdown — runs the same composition path as the live
 * gap-analyzer and reports per-section token counts.
 *
 * Used to quantify the pre/post-cleanup reclaim for C2A 2026-04-22
 * c2a-cortex-03-lossless-context-cleanup.
 *
 * Requires the following organ HTTP endpoints reachable on localhost:
 *   Radiant     :4006  /context /memory /stats
 *   Minder      :4007  /peers/recent /observations/recent  (may 404)
 *   Hippocampus :4008  /conversations?status=completed
 *   Graph       :4020  POST /query
 *   Arbiter     :4021  /bor/raw
 *   Spine       :4000  /events?source_organ=Spine
 *
 * Usage:
 *   node tools/measure-prompt-breakdown.js
 *   node tools/measure-prompt-breakdown.js --json    # machine-readable only
 */

import { createCmClient } from '../lib/cm-client.js';
import { createMissionLoader } from '../lib/mission-loader.js';
import { buildPrompt } from '../agents/gap-analyzer-agent.js';
import { measurePromptBreakdown } from '../lib/prompt-size-instrumentation.js';

const RADIANT_URL     = process.env.RADIANT_URL     || 'http://localhost:4006';
const MINDER_URL      = process.env.MINDER_URL      || 'http://localhost:4007';
const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://localhost:4008';
const GRAPH_URL       = process.env.GRAPH_URL       || 'http://localhost:4020';
const ARBITER_URL     = process.env.ARBITER_URL     || 'http://localhost:4021';
const SPINE_URL       = process.env.SPINE_URL       || 'http://localhost:4000';

const wantJsonOnly = process.argv.includes('--json');

// Minimal Graph adapter shim — cm-client and mission-loader both use
// graphAdapter.queryConcepts(sql, params).
function createGraphAdapterShim(graphUrl) {
  return {
    async queryConcepts(sql, params = []) {
      const res = await fetch(`${graphUrl}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      });
      if (!res.ok) throw new Error(`graph /query ${res.status}`);
      return res.json();
    },
  };
}

// Minimal Arbiter client shim — mission-loader calls arbiterClient.getBoRRaw().
function createArbiterClientShim(arbiterUrl) {
  return {
    async getBoRRaw() {
      try {
        const res = await fetch(`${arbiterUrl}/bor/raw`);
        if (!res.ok) return null;
        const body = await res.json();
        // Arbiter returns either { raw_text, ... } or plain text; handle both.
        if (typeof body === 'string') return { raw_text: body };
        if (body && typeof body.raw_text === 'string') return body;
        return null;
      } catch (err) {
        return null;
      }
    },
  };
}

async function main() {
  const graphAdapter = createGraphAdapterShim(GRAPH_URL);
  const arbiterClient = createArbiterClientShim(ARBITER_URL);

  const missionLoader = createMissionLoader({ graphAdapter, arbiterClient, cacheTtlMs: 1000 });
  const missionFrame = await missionLoader.loadMission();

  const cmClient = createCmClient({
    radiantUrl: RADIANT_URL,
    minderUrl: MINDER_URL,
    hippocampusUrl: HIPPOCAMPUS_URL,
    graphAdapter,
    spineUrl: SPINE_URL,
    timeoutMs: 10000,
  });
  const { snapshot } = await cmClient();

  // Recent goals — Cortex's in-memory ring buffer cannot be introspected
  // from outside the running organ. Use empty list for measurement; a
  // live Cortex would add 0-20 goal records of ~50-150 tokens each.
  const recentGoals = [];

  const fullPrompt = buildPrompt({
    missionFrame,
    worldState: snapshot,
    recentGoals,
  });

  const breakdown = measurePromptBreakdown({
    missionFrame,
    worldState: snapshot,
    recentGoals,
    fullPrompt,
    emit: false,  // we'll print a formatted report below
  });

  if (wantJsonOnly) {
    process.stdout.write(JSON.stringify(breakdown, null, 2) + '\n');
    return;
  }

  // Human-readable report
  console.log('\n=== Cortex prompt-size breakdown ===');
  console.log(`composed_at: ${breakdown.composed_at}`);
  console.log(`tokenizer:   gpt-tokenizer cl100k_base (proxy for Gemma-3)\n`);
  console.log('Per-section token counts:');
  const entries = Object.entries(breakdown.sections).sort((a, b) => b[1] - a[1]);
  for (const [name, tokens] of entries) {
    const pct = breakdown.aggregate ? Math.round(tokens * 1000 / breakdown.aggregate) / 10 : 0;
    console.log(`  ${name.padEnd(20)} ${String(tokens).padStart(8)}  (${pct}%)`);
  }
  console.log('');
  console.log(`  ${'section_sum'.padEnd(20)} ${String(breakdown.section_sum).padStart(8)}`);
  console.log(`  ${'overhead (scaffolding)'.padEnd(20)} ${String(breakdown.overhead).padStart(8)}`);
  console.log(`  ${'aggregate'.padEnd(20)} ${String(breakdown.aggregate).padStart(8)}`);
  console.log('');
  console.log(`sources_ok:       ${snapshot.sources_ok.join(', ')}`);
  console.log(`sources_degraded: ${snapshot.sources_degraded.join(' | ') || '(none)'}`);
}

main().catch(err => {
  console.error('measurement failed:', err.message);
  process.exit(1);
});
