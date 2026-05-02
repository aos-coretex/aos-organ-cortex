/**
 * Per-domain prompt discipline — extends cv-scope-ruling-prompt-discipline.
 *
 * BINDING. Enforces parent MP §4.1 (constitutional-conditioning boundary)
 * across all 5 per-domain SYSTEM_PROMPTs and the buildDomainPrompt output.
 * Any future change that introduces scope-ruling language into per-domain
 * prompt assets will fail this test.
 *
 * Three-layer enforcement (parallel to cv-scope-ruling-prompt-discipline):
 *   1. Each per-domain SYSTEM_PROMPT (case-insensitive substring check)
 *   2. lib/domain-prompts.js file content (catches docstring drift)
 *   3. buildDomainPrompt() output for each domain with sample fixtures
 *
 * Forbidden-phrase list is imported from cv-scope-ruling-prompt-discipline.test.js
 * (single source of truth — extending the canonical list keeps both tests aligned).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOMAIN_SYSTEM_PROMPTS,
  MISSION_ANCHORS,
  buildDomainPrompt,
} from '../lib/domain-prompts.js';
import { GAP_DOMAINS } from '../lib/gap-schemas.js';
import { FORBIDDEN } from './cv-scope-ruling-prompt-discipline.test.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sampleMission = {
  msp: { version: '1.0.0', raw_text: '# MSP\n\n## Purpose\nA clean mission with no forbidden phrases.' },
  bor: { version: '1.0.0', raw_text: '# BoR\n\n## Article 1\nIdentity description without forbidden language.' },
};

const SAMPLE_SLICES = {
  operational: { spine_state: { recent_transitions: [] } },
  strategic: { radiant: { recent_context: [], recent_memory: [], stats: {} } },
  relational: { minder: { active_peers: [] }, hippocampus: { recent_conversations: [] } },
  compliance: { governance_state: [] },
  constitutional: {},
};

// ---------------------------------------------------------------------------
// Layer 1 — per-domain SYSTEM_PROMPT substring check
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`Layer 1 — DOMAIN_SYSTEM_PROMPTS.${domain} does not contain scope-ruling language`, () => {
    const sys = DOMAIN_SYSTEM_PROMPTS[domain];
    assert.equal(typeof sys, 'string', `${domain} SYSTEM_PROMPT must be a string`);
    const lowered = sys.toLowerCase();
    for (const phrase of FORBIDDEN) {
      assert.ok(
        !lowered.includes(phrase.toLowerCase()),
        `DOMAIN_SYSTEM_PROMPTS.${domain} contains forbidden phrase: "${phrase}"`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Layer 2 — domain-prompts.js file content substring check
// ---------------------------------------------------------------------------

test('Layer 2 — lib/domain-prompts.js file content does not contain scope-ruling language', async () => {
  const filePath = join(__dirname, '..', 'lib', 'domain-prompts.js');
  const content = await readFile(filePath, 'utf-8');
  const lowered = content.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `lib/domain-prompts.js contains forbidden phrase: "${phrase}". The file must reference test/cv-scope-ruling-prompt-discipline.test.js::FORBIDDEN by reference, not by inline enumeration.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Layer 3 — buildDomainPrompt output substring check (per domain)
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`Layer 3 — buildDomainPrompt(${domain}) output does not contain scope-ruling language`, () => {
    const { messages, options } = buildDomainPrompt({
      domain,
      missionFrame: sampleMission,
      slice: SAMPLE_SLICES[domain],
      recentGoals: [],
      missionAnchor: MISSION_ANCHORS[domain],
    });
    // Concatenate user-content + system-prompt — both ride along to the LLM.
    const combined = (messages.map((m) => m.content).join('\n') + '\n' + (options?.system ?? '')).toLowerCase();
    for (const phrase of FORBIDDEN) {
      assert.ok(
        !combined.includes(phrase.toLowerCase()),
        `buildDomainPrompt(${domain}) output contains forbidden phrase: "${phrase}"`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Sanity — every domain has a SYSTEM_PROMPT and a MISSION_ANCHOR
// ---------------------------------------------------------------------------

test('Every gap domain has a SYSTEM_PROMPT and a MISSION_ANCHOR', () => {
  for (const domain of GAP_DOMAINS) {
    assert.ok(DOMAIN_SYSTEM_PROMPTS[domain], `DOMAIN_SYSTEM_PROMPTS.${domain} missing`);
    assert.ok(MISSION_ANCHORS[domain], `MISSION_ANCHORS.${domain} missing`);
    assert.equal(typeof MISSION_ANCHORS[domain].msp_focus, 'string');
    assert.equal(typeof MISSION_ANCHORS[domain].bor_role, 'string');
    assert.equal(typeof MISSION_ANCHORS[domain].slice_label, 'string');
    assert.equal(typeof MISSION_ANCHORS[domain].closing_focus, 'string');
  }
});

// ---------------------------------------------------------------------------
// Per-domain SYSTEM_PROMPT pins source_category
// ---------------------------------------------------------------------------

for (const domain of GAP_DOMAINS) {
  test(`DOMAIN_SYSTEM_PROMPTS.${domain} pins source_category to "${domain}"`, () => {
    const sys = DOMAIN_SYSTEM_PROMPTS[domain];
    assert.ok(
      sys.includes(`"source_category": "${domain}"`),
      `DOMAIN_SYSTEM_PROMPTS.${domain} must explicitly pin source_category to "${domain}" in the output schema example`,
    );
  });
}
